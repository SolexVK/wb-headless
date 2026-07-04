// lib/stockReport.js — отчёт «Наличие товара и упущенная выручка»
//
// Методология упущенной выручки (прозрачная и воспроизводимая):
//   1. По дневному ряду считаем дни, когда остаток > 0 (дни в наличии)
//      и дни с остатком = 0 (дни out-of-stock).
//   2. Средние продажи в день считаем ТОЛЬКО по дням, когда товар был
//      в наличии (иначе нули искусственно занизят спрос):
//         avgDailyUnits = проданные штуки / дни_в_наличии
//   3. Средняя цена продажи = выручка / проданные штуки
//      (если выручки в ответе нет — берём среднюю цену по дням с продажами).
//   4. Упущенные продажи = avgDailyUnits * дни_out_of_stock
//      Упущенная выручка = упущенные продажи * средняя цена
//
// То есть «сколько бы мы продали в дни простоя, если бы товар был на складе».

import { fetchItemDailySales } from './mpstats.js';

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

/**
 * Считает метрики наличия/упущенной выручки по одному дневному ряду.
 */
export function computeSkuMetrics(sku, daily) {
  const daysTotal = daily.length;
  const daysInStock = daily.filter((r) => r.balance > 0).length;
  const daysOutOfStock = daysTotal - daysInStock;

  const unitsSold = daily.reduce((s, r) => s + r.sales, 0);
  let revenue = daily.reduce((s, r) => s + r.revenue, 0);

  // Дни, когда реально были продажи — для оценки средней цены.
  const saleDays = daily.filter((r) => r.sales > 0 && r.price > 0);
  const avgPriceFromDays = saleDays.length
    ? saleDays.reduce((s, r) => s + r.price, 0) / saleDays.length
    : 0;

  // Если API не вернул выручку по дням — реконструируем из штук и цены.
  if (revenue === 0 && unitsSold > 0 && avgPriceFromDays > 0) {
    revenue = unitsSold * avgPriceFromDays;
  }

  const avgPrice = unitsSold > 0 ? revenue / unitsSold : avgPriceFromDays;
  const avgDailyUnitsInStock = daysInStock > 0 ? unitsSold / daysInStock : 0;

  const lostUnits = avgDailyUnitsInStock * daysOutOfStock;
  const lostRevenue = lostUnits * avgPrice;

  const inStockRate = daysTotal > 0 ? daysInStock / daysTotal : 0;

  return {
    sku,
    hasData: daysTotal > 0,
    daysTotal,
    daysInStock,
    daysOutOfStock,
    inStockRatePct: round(inStockRate * 100, 1),
    unitsSold: round(unitsSold, 0),
    revenue: round(revenue, 0),
    avgPrice: round(avgPrice, 0),
    avgDailyUnitsInStock: round(avgDailyUnitsInStock, 2),
    lostUnits: round(lostUnits, 0),
    lostRevenue: round(lostRevenue, 0),
  };
}

/**
 * Простой пул параллельных задач с ограничением concurrency.
 */
async function mapPool(items, concurrency, worker, shouldStop) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      if (shouldStop && shouldStop()) break; // ранняя остановка (напр. дневной лимит)
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Строит отчёт по списку SKU за период [d1, d2].
 * @returns {Promise<{period, generatedAt, rows, totals, errors}>}
 */
export async function buildStockAvailabilityReport({
  items,
  skus,
  d1,
  d2,
  concurrency = 5,
  onProgress,
} = {}) {
  // Принимаем либо items [{wb, seller}], либо старый формат skus [число/строка].
  const rawItems = items
    ? items
    : (skus || []).map((s) => ({ wb: s, seller: '' }));

  // Уникализируем по WB, сохраняя артикул продавца.
  const seen = new Set();
  const unique = [];
  for (const it of rawItems) {
    const wb = String(it.wb ?? it).trim();
    if (!wb || seen.has(wb)) continue;
    seen.add(wb);
    unique.push({ wb, seller: it.seller || '' });
  }

  const errors = [];
  let done = 0;
  let dailyLimit = null; // текст ошибки дневного лимита MPSTATS, если словили

  const rows = await mapPool(
    unique,
    concurrency,
    async (item) => {
      const sku = item.wb;
      try {
        const daily = await fetchItemDailySales(sku, d1, d2);
        const m = computeSkuMetrics(sku, daily);
        if (onProgress) onProgress(++done, unique.length, sku);
        return { seller: item.seller, ...m };
      } catch (err) {
        // Дневной лимит MPSTATS — дальше опрашивать бессмысленно, останавливаемся.
        if (err?.dailyLimit && !dailyLimit) dailyLimit = String(err?.message || err);
        errors.push({ sku, seller: item.seller, error: String(err?.message || err) });
        if (onProgress) onProgress(++done, unique.length, sku);
        return { sku, seller: item.seller, hasData: false, error: String(err?.message || err) };
      }
    },
    () => dailyLimit !== null
  );

  // Отбрасываем необработанные (пропущенные из-за ранней остановки) ячейки.
  const processed = rows.filter(Boolean);
  // Сортируем по упущенной выручке — сверху самые «болезненные» простои.
  const withData = processed.filter((r) => r.hasData);
  withData.sort((a, b) => b.lostRevenue - a.lostRevenue);
  const noData = processed.filter((r) => !r.hasData);

  const totals = withData.reduce(
    (acc, r) => {
      acc.skuCount += 1;
      acc.unitsSold += r.unitsSold;
      acc.revenue += r.revenue;
      acc.lostUnits += r.lostUnits;
      acc.lostRevenue += r.lostRevenue;
      acc.daysOutOfStock += r.daysOutOfStock;
      return acc;
    },
    { skuCount: 0, unitsSold: 0, revenue: 0, lostUnits: 0, lostRevenue: 0, daysOutOfStock: 0 }
  );
  totals.unitsSold = round(totals.unitsSold, 0);
  totals.revenue = round(totals.revenue, 0);
  totals.lostUnits = round(totals.lostUnits, 0);
  totals.lostRevenue = round(totals.lostRevenue, 0);
  totals.skusRequested = unique.length;
  totals.skusNoData = noData.length;
  totals.skusSkipped = unique.length - processed.length; // пропущены из-за остановки

  return {
    period: { d1, d2 },
    rows: [...withData, ...noData],
    totals,
    errors,
    dailyLimit, // не null → отчёт остановлен на дневном лимите MPSTATS
  };
}

const CSV_COLUMNS = [
  ['seller', 'Артикул продавца'],
  ['sku', 'SKU'],
  ['daysTotal', 'Дней в периоде'],
  ['daysInStock', 'Дней в наличии'],
  ['daysOutOfStock', 'Дней без остатка'],
  ['inStockRatePct', 'Наличие, %'],
  ['unitsSold', 'Продано, шт'],
  ['revenue', 'Выручка, ₽'],
  ['avgPrice', 'Средняя цена, ₽'],
  ['avgDailyUnitsInStock', 'Продажи/день (в наличии)'],
  ['lostUnits', 'Упущено, шт'],
  ['lostRevenue', 'Упущенная выручка, ₽'],
];

/**
 * Экспорт отчёта в CSV (разделитель ';' и BOM — дружелюбно к RU Excel).
 */
export function reportToCSV(report) {
  const sep = ';';
  // Русская локаль: десятичный разделитель — запятая. Числа → с запятой,
  // текст (SKU, «ИТОГО») оставляем как есть.
  const cell = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    return String(v);
  };

  const header = CSV_COLUMNS.map(([, title]) => title).join(sep);
  const lines = report.rows.map((r) =>
    CSV_COLUMNS.map(([key]) => cell(r[key])).join(sep)
  );

  // Итоговая строка — собираем по ключам колонок, чтобы не зависеть от их порядка.
  const t = report.totals;
  const totalByKey = {
    seller: 'ИТОГО',
    daysOutOfStock: t.daysOutOfStock,
    unitsSold: t.unitsSold,
    revenue: t.revenue,
    lostUnits: t.lostUnits,
    lostRevenue: t.lostRevenue,
  };
  const totalLine = CSV_COLUMNS.map(([key]) => cell(totalByKey[key] ?? '')).join(sep);

  return '﻿' + [header, ...lines, totalLine].join('\r\n') + '\r\n';
}
