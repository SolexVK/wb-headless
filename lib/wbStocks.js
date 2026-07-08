// lib/wbStocks.js — остатки Wildberries: текущий снимок + история по дням.
//
// Зачем это для ABC. Товар может попасть в класс C не потому, что «плохой», а
// потому что его просто НЕ БЫЛО на складе WB — продавать было нечего. Чтобы не
// сливать хорошие товары по ошибке, нужна история остатков: сколько дней в
// периоде товар реально был в наличии (balance > 0). На этой базе продажи
// пересчитываются «на доступный день», и заниженные из-за out-of-stock позиции
// не уходят в C.
//
// Два источника (см. lib/wbApi.js):
//   1) Текущий снимок — Statistics /api/v1/supplier/stocks (истории НЕТ).
//   2) История по дням — Analytics, асинхронный CSV-отчёт STOCK_HISTORY_DAILY_CSV
//      (остаток на 23:59 каждого дня, до 3 месяцев назад, без подписки Jam).

import { statsRequest, analyticsRequest, sleep } from './wbApi.js';

// ── Пути асинхронного отчёта вынесены в env, т.к. WB иногда меняет схему URL.
// ⚠ ПРОВЕРЬ значения по своей документации кабинета перед боевым запуском —
// дефолты отражают задокументированную механику «создать → статус → скачать».
const REPORT_CREATE_PATH = process.env.WB_REPORT_CREATE_PATH || '/api/v1/analytics/report/generate';
const REPORT_STATUS_PATH = process.env.WB_REPORT_STATUS_PATH || '/api/v1/analytics/report/status/{id}';
const REPORT_DOWNLOAD_PATH = process.env.WB_REPORT_DOWNLOAD_PATH || '/api/v1/analytics/report/download/{id}';
const REPORT_TYPE = process.env.WB_STOCK_REPORT_TYPE || 'STOCK_HISTORY_DAILY_CSV';

const num = (v) => (v == null || v === '' ? 0 : Number(String(v).replace(',', '.'))) || 0;

/**
 * Текущий снимок остатков по всему кабинету (истории у метода нет).
 * dateFrom — вернёт строки, изменившиеся с этой даты (для дельт), но количество
 * всегда актуальное «на сейчас». Лимит ~1 запрос/мин соблюдается автоматически.
 * @returns {Promise<Array<{nmId:number, quantity:number, warehouse:string, date:string}>>}
 */
export async function fetchCurrentStocks(dateFrom = '2020-01-01') {
  const raw = await statsRequest(`/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(dateFrom)}`);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => ({
    nmId: Number(r.nmId ?? r.nmID ?? 0),
    quantity: num(r.quantity ?? r.quantityFull),
    warehouse: r.warehouseName ?? '',
    date: r.lastChangeDate ?? '',
  }));
}

// ── Парсер CSV отчёта STOCK_HISTORY_DAILY_CSV. Имена колонок у WB со временем
// меняются, поэтому колонки ищем по «похожести» заголовка, а не по позиции.
function parseStockCsv(text) {
  const clean = String(text).replace(/^﻿/, '').trim();
  if (!clean) return [];
  const sep = clean.includes(';') && !clean.split('\n')[0].includes(',') ? ';' : (clean.split('\n')[0].includes(';') ? ';' : ',');
  const lines = clean.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const find = (...keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const iNm = find('nmid', 'nm_id', 'номенклатур', 'артикул wb', 'артикул вб');
  const iDate = find('date', 'дата', 'день');
  const iQty = find('qty', 'quantity', 'balance', 'stock', 'остат', 'количеств');
  if (iNm < 0 || iDate < 0 || iQty < 0) {
    throw new Error(`Не распознаны колонки CSV (nmId=${iNm}, date=${iDate}, qty=${iQty}); заголовок: ${header.join('|')}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(sep);
    const nmId = Number(String(c[iNm] ?? '').replace(/\D+/g, ''));
    const date = String(c[iDate] ?? '').slice(0, 10);
    if (!nmId || !date) continue;
    rows.push({ nmId, date, quantity: num(c[iQty]) });
  }
  return rows;
}

/**
 * Заказывает и скачивает дневную историю остатков за период [d1, d2].
 * Асинхронный отчёт: создаём задачу → ждём готовности (с паузами через лимит-
 * ведро) → скачиваем CSV → парсим. Один отчёт покрывает ВЕСЬ кабинет, поэтому
 * запросов немного — безопасно по лимитам.
 * @returns {Promise<Array<{nmId:number, date:string, quantity:number}>>}
 */
export async function fetchDailyStockHistory({ d1, d2, maxPolls = 40, pollBaseMs = 5000 } = {}) {
  // 1) Создать отчёт.
  const created = await analyticsRequest(REPORT_CREATE_PATH, {
    method: 'POST',
    body: { reportType: REPORT_TYPE, params: { startDate: d1, endDate: d2 } },
  });
  const reportId =
    created?.data?.id ?? created?.id ?? created?.reportId ?? created?.data?.reportId;
  if (!reportId) {
    throw new Error(`WB не вернул id отчёта. Ответ: ${JSON.stringify(created).slice(0, 300)}`);
  }
  process.stderr.write(`  WB: отчёт ${REPORT_TYPE} создан (id=${reportId}), жду готовности…\n`);

  // 2) Опрашивать статус, пока не «готов». Паузы разнесены лимит-ведром аналитики.
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    await sleep(pollBaseMs);
    const st = await analyticsRequest(REPORT_STATUS_PATH.replace('{id}', encodeURIComponent(reportId)));
    const status = String(st?.data?.status ?? st?.status ?? '').toLowerCase();
    if (['done', 'ready', 'success', 'completed', 'готов'].some((s) => status.includes(s))) break;
    if (['error', 'failed', 'ошибк'].some((s) => status.includes(s))) {
      throw new Error(`WB отчёт завершился с ошибкой: ${JSON.stringify(st).slice(0, 200)}`);
    }
    if (attempt === maxPolls - 1) {
      throw new Error('WB отчёт не готов за отведённое время — повторите позже');
    }
  }

  // 3) Скачать и распарсить CSV.
  const body = await analyticsRequest(REPORT_DOWNLOAD_PATH.replace('{id}', encodeURIComponent(reportId)));
  const text = typeof body === 'string' ? body : (body?.data ?? body?.file ?? JSON.stringify(body));
  return parseStockCsv(text);
}

/**
 * Сворачивает историю остатков в метрики наличия по каждому nmId за [d1, d2].
 * Дни агрегируем по всем складам: товар «в наличии» в день, если суммарный
 * остаток по складам > 0.
 * @returns {Map<number, {daysTotal:number, daysInStock:number, daysOutOfStock:number, inStockRatePct:number}>}
 */
export function computeStockAvailability(historyRows, d1, d2) {
  // (nmId → date → суммарный остаток по складам)
  const perNm = new Map();
  for (const r of historyRows) {
    if (!perNm.has(r.nmId)) perNm.set(r.nmId, new Map());
    const byDate = perNm.get(r.nmId);
    byDate.set(r.date, (byDate.get(r.date) || 0) + r.quantity);
  }

  const start = new Date(d1);
  const end = new Date(d2);
  const daysTotal = Math.max(1, Math.round((end - start) / 86400000) + 1);

  const out = new Map();
  for (const [nmId, byDate] of perNm) {
    let daysInStock = 0;
    for (const q of byDate.values()) if (q > 0) daysInStock += 1;
    const daysOutOfStock = Math.max(0, daysTotal - daysInStock);
    out.set(nmId, {
      daysTotal,
      daysInStock,
      daysOutOfStock,
      inStockRatePct: Math.round((daysInStock / daysTotal) * 1000) / 10,
    });
  }
  return out;
}

export { parseStockCsv, REPORT_TYPE };
