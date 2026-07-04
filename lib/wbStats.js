// lib/wbStats.js — источник данных «продажи + остатки по дням» из WB API,
// как замена MPSTATS для отчёта об упущенной выручке.
//
// Методика отчёта (lib/stockReport.js) требует по каждому SKU дневной ряд:
//   { date, balance (остаток), sales (спрос, шт), price, revenue }.
//
// Откуда берём (всё — первичные данные WB, без подписки «Джем»):
//   • СПРОС по дням  ← Statistics: GET /api/v1/supplier/orders (заказы).
//       Заказы отражают спрос независимо от логистики/остатка — это правильная
//       база для «сколько бы продали». 1 строка = 1 заказ = 1 единица.
//       Лимит: 1 запрос/мин (burst 10). Пагинация по lastChangeDate.
//   • ОСТАТКИ по дням ← Analytics CSV: POST /api/v2/nm-report/downloads
//       reportType=STOCK_HISTORY_DAILY_CSV (создать → опросить → скачать → CSV).
//       Доступно БЕЗ «Джема», период до 3 мес. Лимит создания: 3 запроса/мин.
//
// ВАЖНО про лимиты: WB банит за каскад 429, поэтому данные тянем ОДНИМ пакетом
// на весь список товаров (а не по одному SKU), а темп держит lib/wbClient.js.
//
// ⚠ Требует живой проверки токеном: точная схема params и колонок CSV-отчёта
//   STOCK_HISTORY_DAILY_CSV в публичном рендере доки видна не полностью —
//   поэтому парсинг колонок сделан терпимым к именам (как в mpstats.js), а тело
//   запроса вынесено в одну функцию buildStockReportBody() с ссылкой на доку.
//   Первый прогон с реальным токеном покажет, нужно ли поправить имена.

import { randomUUID } from 'crypto';

const RFC = (d) => `${d}T00:00:00`; // WB ждёт время в МСК (UTC+3); дата достаточно
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOf = (s) => String(s || '').slice(0, 10); // 'YYYY-MM-DD' из date-time
const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

// ─────────────────────────────────────────────────────────────────────────────
// СПРОС: заказы по дням из Statistics /supplier/orders
// ─────────────────────────────────────────────────────────────────────────────

// Лимит метода (из docs/wb-api/reports-statistics.md): 1 запрос/мин, всплеск 10.
const ORDERS_LIMIT = { limit: 1, periodSec: 60, burst: 10 };

/**
 * Тянет все заказы с dateFrom=d1 (пагинация по lastChangeDate) и агрегирует
 * в Map: nmId → Map(day → { units, revenue }).
 * revenue считаем по priceWithDisc (цена со скидкой продавца).
 * Отменённые заказы (isCancel) в спрос НЕ включаем.
 */
export async function fetchOrdersDailyByNm(client, d1, d2) {
  const byNm = new Map();
  let cursor = RFC(d1);
  let guard = 0; // страховка от бесконечного цикла

  for (;;) {
    if (++guard > 200) break; // разумный потолок числа страниц
    const { data } = await client.get('statistics', '/api/v1/supplier/orders', {
      query: { dateFrom: cursor, flag: 0 },
      methodLimit: ORDERS_LIMIT,
    });
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const day = dayOf(r.date);
      if (day < d1 || day > d2) continue; // держим окно [d1, d2]
      if (r.isCancel) continue; // отмену не считаем спросом
      const nm = String(r.nmId);
      if (!byNm.has(nm)) byNm.set(nm, new Map());
      const dm = byNm.get(nm);
      const cur = dm.get(day) || { units: 0, revenue: 0 };
      cur.units += 1; // 1 строка = 1 единица
      cur.revenue += num(r.priceWithDisc);
      dm.set(day, cur);
    }

    // Следующая страница — от последнего lastChangeDate. Если он не растёт
    // (все влезло в одну выдачу), выходим.
    const last = rows[rows.length - 1]?.lastChangeDate;
    if (!last || last === cursor || rows.length < 1000) break;
    cursor = last;
  }
  return byNm;
}

// ─────────────────────────────────────────────────────────────────────────────
// ОСТАТКИ: история по дням через Analytics CSV (STOCK_HISTORY_DAILY_CSV)
// ─────────────────────────────────────────────────────────────────────────────

// Лимит создания отчёта (docs/wb-api/analytics.md): 3 запроса/мин.
const NMREPORT_CREATE_LIMIT = { limit: 3, periodSec: 60, burst: 3 };
const NMREPORT_POLL_LIMIT = { limit: 3, periodSec: 60, burst: 3 };

/**
 * Тело запроса на создание CSV-отчёта истории остатков.
 * Схема params видна в доке не полностью — держим в одном месте.
 * См. docs/wb-api/analytics.md (POST /api/v2/nm-report/downloads,
 * reportType STOCK_HISTORY_DAILY_CSV, пример InventoryHistoryReportReq).
 */
function buildStockReportBody(nmIDs, d1, d2) {
  return {
    id: randomUUID(),
    reportType: 'STOCK_HISTORY_DAILY_CSV',
    userReportName: 'stock-history-daily',
    params: {
      nmIDs: nmIDs.map(Number),
      startDate: d1,
      endDate: d2,
      // Тип остатков: 'mp' — склады WB (как в примерах доки). При необходимости
      // вынести в параметр.
      stockType: 'mp',
      timezone: 'Europe/Moscow',
    },
  };
}

/** Возможные имена колонок CSV — читаем терпимо (WB может менять регистр/язык). */
function pickCol(row, names) {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n];
  }
  return undefined;
}

/** Простейший парсер CSV (разделитель ';' или ','); первая строка — заголовки. */
function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const headers = lines[0].split(sep).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(sep);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (cells[i] ?? '').trim()));
    return obj;
  });
}

/**
 * Создаёт CSV-отчёт истории остатков, ждёт готовности, скачивает и парсит.
 * Возвращает Map: nmId → Map(day → balance).
 */
export async function fetchStockHistoryDaily(client, nmIDs, d1, d2, { maxWaitMs = 180000 } = {}) {
  // 1. Создать задание.
  const body = buildStockReportBody(nmIDs, d1, d2);
  await client.request('analytics', '/api/v2/nm-report/downloads', {
    method: 'POST',
    body,
    methodLimit: NMREPORT_CREATE_LIMIT,
  });
  const reportId = body.id;

  // 2. Дождаться готовности (опрашиваем список отчётов).
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < maxWaitMs) {
    await sleep(5000);
    const { data } = await client.get('analytics', '/api/v2/nm-report/downloads', {
      query: { 'filter[downloadIds]': reportId },
      methodLimit: NMREPORT_POLL_LIMIT,
    });
    // Ответ: { data: [{ id, status, ... }] }. Статус готовности — 'SUCCESS'/'DONE'.
    const list = Array.isArray(data) ? data : data?.data || [];
    const me = list.find((x) => x.id === reportId) || list[0];
    const status = String(me?.status || '').toUpperCase();
    if (/SUCCESS|DONE|READY|COMPLETED/.test(status)) {
      ready = true;
      break;
    }
    if (/ERROR|FAIL|CANCELL/.test(status)) {
      throw new Error(`WB stock-history: отчёт завершился со статусом ${status}`);
    }
  }
  if (!ready) throw new Error('WB stock-history: отчёт не готов за отведённое время');

  // 3. Скачать файл.
  const { data: file } = await client.get(
    'analytics',
    `/api/v2/nm-report/downloads/file/${reportId}`,
    { methodLimit: NMREPORT_POLL_LIMIT }
  );
  const text = typeof file === 'string' ? file : JSON.stringify(file);
  const rows = parseCsv(text);

  // 4. Разложить в Map: nmId → day → balance.
  const byNm = new Map();
  for (const r of rows) {
    const nm = String(pickCol(r, ['nmID', 'nmId', 'Артикул WB', 'nm_id']) ?? '');
    const day = dayOf(pickCol(r, ['date', 'dt', 'Дата', 'day']) ?? '');
    const bal = num(pickCol(r, ['stockCount', 'quantity', 'balance', 'Остаток', 'qty', 'stock']));
    if (!nm || !day) continue;
    if (!byNm.has(nm)) byNm.set(nm, new Map());
    byNm.get(nm).set(day, bal);
  }
  return byNm;
}

// ─────────────────────────────────────────────────────────────────────────────
// СБОРКА: bulk-источник для lib/stockReport.js
// ─────────────────────────────────────────────────────────────────────────────

/** Перечень дат [d1..d2] включительно. */
function eachDay(d1, d2) {
  const out = [];
  const cur = new Date(d1 + 'T00:00:00Z');
  const end = new Date(d2 + 'T00:00:00Z');
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Возвращает bulk-функцию источника данных для buildStockAvailabilityReport:
 *   (items, d1, d2) → Map<sku, dailyArray>
 * где dailyArray = [{ date, balance, sales, price, revenue }] по каждому дню.
 *
 * Тянет заказы и историю остатков ОДНИМ пакетом на весь список товаров.
 */
export function makeWbSource(client) {
  return async function wbSource(items, d1, d2) {
    const nmIDs = items.map((it) => String(it.wb ?? it));
    const days = eachDay(d1, d2);

    // Пакетно: заказы (спрос) и остатки (история) — параллельно.
    const [ordersByNm, stockByNm] = await Promise.all([
      fetchOrdersDailyByNm(client, d1, d2),
      fetchStockHistoryDaily(client, nmIDs, d1, d2),
    ]);

    const result = new Map();
    for (const nm of nmIDs) {
      const om = ordersByNm.get(nm) || new Map();
      const sm = stockByNm.get(nm) || new Map();
      // Ряд строим по всем дням периода; если по дню нет данных остатка —
      // считаем 0 (не в наличии), нет заказов — 0 продаж.
      const daily = days.map((day) => {
        const o = om.get(day) || { units: 0, revenue: 0 };
        const balance = sm.has(day) ? num(sm.get(day)) : 0;
        const price = o.units > 0 ? o.revenue / o.units : 0;
        return { date: day, balance, sales: o.units, price, revenue: o.revenue };
      });
      // Если по товару вообще нет ни одной точки данных — отдаём пусто (hasData=false).
      const hasAny = daily.some((r) => r.balance > 0 || r.sales > 0);
      result.set(nm, hasAny ? daily : []);
    }
    return result;
  };
}
