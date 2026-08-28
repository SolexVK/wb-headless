// report-forensics.mjs — два PDF-расследования: логистика и штрафы.
//
//   node report-forensics.mjs --collect 2026-08-22 2026-08-28   # выгрузить из API и собрать
//   node report-forensics.mjs 2026-08-22 2026-08-28             # собрать из кэша
//
// Кэш (reports-output/forensics-cache.json) отделён от рендера намеренно: у
// финансовых методов WB лимит 1 запрос в минуту, и переверстывать отчёт, каждый
// раз заново дёргая API, нельзя.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './lib/wbClient.js';
import { analyzeLogistics, analyzeFines, analyzePrevious } from './lib/forensics.js';
import { logisticsHtml, finesHtml } from './lib/forensicsHtml.js';
import { htmlToPdf } from './lib/renderPdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'reports-output');
const CACHE = path.join(OUT_DIR, 'forensics-cache.json');
const M1 = { limit: 1, periodSec: 60, burst: 1 }; // лимит финансовых/статистических методов

const shiftDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** Постраничная выгрузка детализации (дневные отчёты — они приходят без лага). */
async function fetchDetailed(client, dateFrom, dateTo) {
  const rows = [];
  let rrdId = 0;
  for (let page = 1; page <= 10; page++) {
    const { status, data } = await client.request('finance', '/api/finance/v1/sales-reports/detailed', {
      method: 'POST', body: { dateFrom, dateTo, limit: 100000, rrdId, period: 'daily' }, methodLimit: M1,
    });
    const batch = status === 204 || !Array.isArray(data) ? [] : data;
    rows.push(...batch);
    process.stderr.write(`  детализация ${dateFrom}…${dateTo}: страница ${page}, +${batch.length}\n`);
    if (!batch.length || batch.length < 100000) break;
    const next = Number(batch[batch.length - 1].rrdId);
    if (!next || next === rrdId) break;
    rrdId = next;
  }
  return rows;
}

export async function collect({ d1, d2 }) {
  const client = new WbClient({ timeoutMs: 180000 });
  const prevFrom = shiftDays(d1, -8);
  const cache = { period: { d1, d2 }, collectedAt: new Date().toISOString() };

  cache.finance = await fetchDetailed(client, d1, d2);
  cache.prevFinance = await fetchDetailed(client, prevFrom, shiftDays(d1, -1));

  const safe = async (name, fn) => {
    try { return await fn(); } catch (e) { process.stderr.write(`  ✗ ${name}: ${e.message}\n`); return []; }
  };
  // Возвраты: даёт ПВЗ выдачи, даты готовности и фактического забора.
  cache.returns = await safe('возвраты', async () => {
    const { data } = await client.get('analytics', '/api/v1/analytics/goods-return', {
      query: { dateFrom: shiftDays(d1, -30), dateTo: d2 }, methodLimit: M1,
    });
    return data?.report || data || [];
  });
  // Заказы: дата отмены и признак isCancel — доказательная база по срывам.
  cache.orders = await safe('заказы', async () =>
    (await client.get('statistics', '/api/v1/supplier/orders', { query: { dateFrom: `${shiftDays(d1, -8)}T00:00:00`, flag: 0 }, methodLimit: M1 })).data || []);
  cache.sales = await safe('продажи', async () =>
    (await client.get('statistics', '/api/v1/supplier/sales', { query: { dateFrom: `${shiftDays(d1, -8)}T00:00:00`, flag: 0 }, methodLimit: M1 })).data || []);
  // Склады продавца и сборочные задания: связывают штраф с конкретным ФФ.
  cache.warehouses = await safe('склады', async () => (await client.get('marketplace', '/api/v3/warehouses')).data || []);
  cache.fbsOrders = await safe('сборочные задания', async () => {
    const out = []; let next = 0;
    for (let i = 0; i < 20; i++) {
      const { data } = await client.get('marketplace', '/api/v3/orders', {
        query: { limit: 1000, next, dateFrom: Math.floor(new Date(`${shiftDays(d1, -8)}T00:00:00Z`).getTime() / 1000) },
      });
      const batch = data?.orders || [];
      out.push(...batch);
      if (!batch.length || data.next == null || data.next === next) break;
      next = data.next;
    }
    return out;
  });
  cache.weekly = await safe('история отчётов', async () =>
    (await client.request('finance', '/api/finance/v1/sales-reports/list', {
      method: 'POST', body: { dateFrom: shiftDays(d1, -240), dateTo: d2, period: 'weekly', limit: 1000 }, methodLimit: M1,
    })).data || []);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return cache;
}

/** Построчные CSV-приложения к отчётам (UTF-8 с BOM, «;», десятичная запятая). */
function writeCsv(file, header, rows) {
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v).replace(/[;\r\n]+/g, ' '));
  fs.writeFileSync(file, '﻿' + [header.join(';'), ...rows.map((r) => r.map(cell).join(';'))].join('\r\n') + '\r\n');
}

export function render(cache) {
  const period = cache.period;
  const log = analyzeLogistics({ finance: cache.finance, returns: cache.returns, orders: cache.orders, sales: cache.sales, warehouses: cache.warehouses, fbsOrders: cache.fbsOrders });
  const fines = analyzeFines({ finance: cache.finance, returns: cache.returns, orders: cache.orders, sales: cache.sales, warehouses: cache.warehouses, fbsOrders: cache.fbsOrders });
  const prev = { ...analyzePrevious(cache.prevFinance), label: `${cache.prevPeriodLabel || 'предыдущие 8 дней'}` };
  const meta = {
    // Имя продавца есть только в списке отчётов (/sales-reports/list), в строках детализации его нет.
    seller: cache.weekly?.[0]?.sellerFinanceName || cache.finance[0]?.sellerFinanceName || 'продавец',
    financeRows: cache.finance.length,
    currency: cache.finance[0]?.currency || 'KGS',
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = (name) => path.join(OUT_DIR, `${name}-${period.d1}_${period.d2}`);

  const logHtml = logisticsHtml({ log, prev, period, meta, weekly: cache.weekly });
  const finHtml = finesHtml({ fines, prev, period, meta });
  fs.writeFileSync(`${base('logistics-forensics')}.html`, logHtml);
  fs.writeFileSync(`${base('fines-forensics')}.html`, finHtml);
  const pdf1 = htmlToPdf(logHtml, `${base('logistics-forensics')}.pdf`);
  const pdf2 = htmlToPdf(finHtml, `${base('fines-forensics')}.pdf`);

  writeCsv(`${base('logistics-rows')}.csv`,
    ['Дата удержания', 'Причина', 'Сумма, сом', 'Коэф. склада', 'Способ', 'Артикул', 'Артикул WB', 'Размер', 'ПВЗ', 'Тип возврата', 'Готов к выдаче', 'Выдан', 'Дата заказа', 'Поставка', 'srid'],
    log.rows.map((r) => [r.date, r.reason, r.amount, r.coef, r.method, r.article, r.nmId, r.size, r.pvz, r.returnType || '', r.readyDt || '', r.completedDt || '', r.orderDt, r.supply, r.srid]));
  writeCsv(`${base('fines-cancels')}.csv`,
    ['Дата удержания', '№ заказа', 'Артикул', 'Размер', 'Склад ФФ', 'Офис сдачи', 'Задание создано', 'Аннулирован', 'Простой, ч', 'Цена, сом', 'Штраф, сом', '% цены', 'srid'],
    fines.cancels.rows.map((r) => [r.date, r.orderId, r.article, r.size, r.ff, r.office, r.createdAt, r.cancelDate, r.hours, r.price, r.amount, r.priceShare, r.srid]));
  writeCsv(`${base('fines-pvz-storage')}.csv`,
    ['Дата удержания', 'Артикул', 'Размер', '№ заказа', 'ПВЗ', 'Тип возврата', 'Готов к выдаче', 'Забран', 'Суток', 'Штраф, сом', 'srid'],
    fines.storage.rows.map((r) => [r.date, r.article, r.size, r.orderId, r.pvz, r.returnType, r.readyDt, r.takenDt, r.days, r.amount, r.srid]));

  return { pdf1, pdf2, log, fines, prev };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const doCollect = args.includes('--collect');
  const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const d1 = dates[0], d2 = dates[1];
  if (!d1 || !d2) { console.error('Укажите период: node report-forensics.mjs [--collect] YYYY-MM-DD YYYY-MM-DD'); process.exit(1); }

  const cache = doCollect
    ? await collect({ d1, d2 })
    : JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  cache.period = { d1, d2 };

  const { pdf1, pdf2, log, fines } = render(cache);
  console.log(`Логистика: ${log.total} (${log.rowCount} начислений), штрафы: ${fines.total}`);
  console.log(`PDF:\n  ${pdf1}\n  ${pdf2}`);
}
