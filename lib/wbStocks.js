// lib/wbStocks.js — остатки Wildberries: текущий снимок + история по дням.
//
// Зачем для ABC. Товар может попасть в класс C не потому, что «плохой», а
// потому что его НЕ БЫЛО на складе WB — продавать было нечего. Чтобы не выводить
// хорошие товары по ошибке, нужна история остатков: сколько дней в периоде товар
// реально был в наличии (остаток > 0). Тогда заниженные из-за out-of-stock
// позиции не уходят в C.
//
// Пути и форматы ПРОВЕРЕНЫ на живом API (июль 2026):
//   • Текущий снимок — Statistics /api/v1/supplier/stocks (истории нет), ~1/мин.
//   • История по дням — Analytics, асинхронный отчёт /api/v2/nm-report/downloads,
//     reportType STOCK_HISTORY_DAILY_CSV (остаток на 23:59 каждого дня, до 3 мес,
//     без Jam). Отдаётся ZIP с CSV в «широком» формате: колонки-даты DD.MM.YYYY,
//     строка = (nmID × размер × склад). Для истории до года — DETAIL_HISTORY_REPORT
//     на том же эндпоинте (требует подписку Jam).

import zlib from 'zlib';
import { randomUUID } from 'crypto';
import { statsRequest, analyticsRequest, sleep } from './wbApi.js';

const DOWNLOADS_PATH = process.env.WB_DOWNLOADS_PATH || '/api/v2/nm-report/downloads';
const REPORT_TYPE = process.env.WB_STOCK_REPORT_TYPE || 'STOCK_HISTORY_DAILY_CSV';
const STOCK_TYPE = process.env.WB_STOCK_TYPE ?? ''; // '' — склады WB; 'mp' — маркетплейс/FBS

const num = (v) => (v == null || v === '' ? 0 : Number(String(v).replace(',', '.'))) || 0;

/**
 * Текущий снимок остатков по всему кабинету (истории у метода нет).
 * @returns {Promise<Array<{nmId:number, supplierArticle:string, quantity:number, warehouse:string}>>}
 */
export async function fetchCurrentStocks(dateFrom = '2020-01-01') {
  const raw = await statsRequest(`/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(dateFrom)}`);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => ({
    nmId: Number(r.nmId ?? r.nmID ?? 0),
    supplierArticle: r.supplierArticle ?? '',
    quantity: num(r.quantity ?? r.quantityFull),
    warehouse: r.warehouseName ?? '',
  }));
}

// ── Минимальная распаковка ZIP (первый файл) через центральный каталог + zlib.
// Без внешних зависимостей: WB отдаёт одиночный CSV в deflate-архиве.
function unzipFirst(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; } // EOCD
  }
  if (e < 0) throw new Error('WB: ответ не ZIP (EOCD не найден)');
  const cdOffset = buf.readUInt32LE(e + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('WB: central directory не найден');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOff = buf.readUInt32LE(cdOffset + 42);
  const lfn = buf.readUInt16LE(localOff + 26);
  const lex = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + lfn + lex;
  const comp = buf.subarray(start, start + compSize);
  return (method === 8 ? zlib.inflateRawSync(comp) : comp).toString('utf8');
}

/**
 * Парсит «широкий» CSV STOCK_HISTORY_DAILY_CSV в длинные строки остатков.
 * Строка исходника = (nmID × размер × склад); суммируем по складам/размерам, так
 * что на выходе — по одной записи (nmID, дата) с суммарным остатком.
 * @returns {{rows:Array<{nmId:number,date:string,quantity:number}>, dates:string[], vendorByNm:Map<number,string>}}
 */
export function parseStockCsv(text) {
  const clean = String(text).replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return { rows: [], dates: [], vendorByNm: new Map() };
  const head = lines[0].split(',');
  const iNm = head.findIndex((h) => /nmid/i.test(h));
  const iVc = head.findIndex((h) => /vendorcode|артикул/i.test(h));
  const dateCols = [];
  head.forEach((h, idx) => {
    const t = h.trim();
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(t)) dateCols.push([idx, t]);
  });
  if (iNm < 0 || !dateCols.length) {
    throw new Error(`WB: не распознан CSV (nmID=${iNm}, дат=${dateCols.length}); заголовок: ${head.slice(0, 10).join('|')}`);
  }

  const agg = new Map(); // nmId -> Map(date -> сумма)
  const vendorByNm = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const nmId = Number(c[iNm]);
    if (!nmId) continue;
    if (iVc >= 0 && !vendorByNm.has(nmId)) vendorByNm.set(nmId, c[iVc]);
    let byDate = agg.get(nmId);
    if (!byDate) { byDate = new Map(); agg.set(nmId, byDate); }
    for (const [idx, d] of dateCols) byDate.set(d, (byDate.get(d) || 0) + (Number(c[idx]) || 0));
  }

  const rows = [];
  for (const [nmId, byDate] of agg) {
    for (const [date, quantity] of byDate) rows.push({ nmId, date, quantity });
  }
  return { rows, dates: dateCols.map(([, d]) => d), vendorByNm };
}

/**
 * Заказывает и скачивает дневную историю остатков за период [d1, d2].
 * Асинхронный отчёт: создать → опросить статус → скачать ZIP → распаковать → парсить.
 * Один отчёт покрывает весь кабинет — запросов немного (безопасно по лимитам).
 * @returns {Promise<{rows:Array<{nmId:number,date:string,quantity:number}>, dates:string[], vendorByNm:Map<number,string>}>}
 */
export async function fetchDailyStockHistory({ d1, d2, nmIDs = [], maxPolls = 30, pollMs = 12000 } = {}) {
  const id = randomUUID();
  await analyticsRequest(DOWNLOADS_PATH, {
    method: 'POST',
    body: {
      id,
      reportType: REPORT_TYPE,
      userReportName: 'abc-availability',
      params: {
        nmIDs,
        currentPeriod: { start: d1, end: d2 },
        stockType: STOCK_TYPE,
        skipDeletedNm: false,
      },
    },
  });
  process.stderr.write(`  WB: отчёт ${REPORT_TYPE} создан (id=${id.slice(0, 8)}…), жду готовности…\n`);

  const statusPath = `${DOWNLOADS_PATH}?filter%5BdownloadIds%5D=${id}`;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    await sleep(pollMs);
    const st = await analyticsRequest(statusPath);
    const rec = Array.isArray(st?.data) ? st.data[0] : st?.data;
    const status = String(rec?.status ?? '').toUpperCase();
    if (status === 'SUCCESS' || status === 'DONE') break;
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`WB отчёт завершился с ошибкой (status=${status})`);
    }
    if (attempt === maxPolls - 1) throw new Error('WB отчёт не готов за отведённое время — повторите позже');
  }

  const zip = await analyticsRequest(`${DOWNLOADS_PATH}/file/${id}`, { binary: true });
  return parseStockCsv(unzipFirst(zip));
}

/**
 * Сворачивает историю остатков в метрики наличия по каждому nmId.
 * daysTotal берём из фактического набора дней отчёта (сколько дней WB прислал).
 * @returns {Map<number, {daysTotal:number, daysInStock:number, daysOutOfStock:number, inStockRatePct:number}>}
 */
export function computeStockAvailability(parsed) {
  const { rows, dates } = parsed;
  const daysTotal = dates?.length || new Set(rows.map((r) => r.date)).size || 1;

  const perNm = new Map(); // nmId -> Set дат с остатком > 0
  for (const r of rows) {
    if (r.quantity <= 0) continue;
    if (!perNm.has(r.nmId)) perNm.set(r.nmId, new Set());
    perNm.get(r.nmId).add(r.date);
  }

  const out = new Map();
  const allNm = new Set(rows.map((r) => r.nmId));
  for (const nmId of allNm) {
    const daysInStock = perNm.get(nmId)?.size || 0;
    out.set(nmId, {
      daysTotal,
      daysInStock,
      daysOutOfStock: Math.max(0, daysTotal - daysInStock),
      inStockRatePct: Math.round((daysInStock / daysTotal) * 1000) / 10,
    });
  }
  return out;
}

export { REPORT_TYPE, unzipFirst };
