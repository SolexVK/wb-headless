// lib/abcReport.js — ABC(-XYZ) анализ товарной матрицы
//
// Что это. Классический инструмент управления ассортиментом:
//
//   ABC — вклад товара в результат (выручку или штуки). Товары ранжируются
//         по убыванию вклада, считается накопленная доля:
//           • A — «локомотивы»: верхние товары, дающие ~80 % результата;
//           • B — «середняки»: следующие ~15 %;
//           • C — «хвост»: оставшиеся ~5 %.
//
//   XYZ — стабильность спроса. По дневному ряду продаж считаем коэффициент
//         вариации (CV = σ / среднее):
//           • X — ровный спрос            (CV ≤ 10 %);
//           • Y — колеблющийся спрос      (10 % < CV ≤ 25 %);
//           • Z — рваный/разовый спрос    (CV > 25 %).
//
// Пересечение даёт матрицу 3×3 (AX, AY, …, CZ) — товар одновременно
// «сколько денег приносит» и «насколько прогнозируем». AX — товар-опора
// (держать всегда), CZ — кандидат на вывод из матрицы.
//
// Данные берутся из MPSTATS (тот же дневной ряд, что и отчёт по наличию).

import { fetchItemDailySales } from './mpstats.js';

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

// Пороги ABC/XYZ. Настраиваются через окружение — методология остаётся
// прозрачной и воспроизводимой, но «под себя» её можно подкрутить.
export function defaultThresholds() {
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    aPct: num(process.env.ABC_A_PCT, 80), // граница класса A, % накопленной доли
    bPct: num(process.env.ABC_B_PCT, 95), // граница класса B (A+B)
    xCv: num(process.env.ABC_X_CV, 10), // граница X, % коэффициента вариации
    yCv: num(process.env.ABC_Y_CV, 25), // граница Y (X+Y)
  };
}

/**
 * Сводит дневной ряд одного SKU в метрики для ABC/XYZ.
 *   revenue  — выручка за период (если API не отдал — реконструируем из шт×цена);
 *   units    — продано штук;
 *   cv       — коэффициент вариации дневных продаж (для XYZ), в долях.
 */
export function computeSkuAggregate(sku, daily) {
  const daysTotal = daily.length;
  const units = daily.reduce((s, r) => s + r.sales, 0);
  let revenue = daily.reduce((s, r) => s + r.revenue, 0);

  const saleDays = daily.filter((r) => r.sales > 0 && r.price > 0);
  const avgPriceFromDays = saleDays.length
    ? saleDays.reduce((s, r) => s + r.price, 0) / saleDays.length
    : 0;
  if (revenue === 0 && units > 0 && avgPriceFromDays > 0) {
    revenue = units * avgPriceFromDays;
  }
  const avgPrice = units > 0 ? revenue / units : avgPriceFromDays;

  // Коэффициент вариации дневных продаж по всему периоду (включая нули —
  // провалы спроса тоже характеризуют его нестабильность).
  const series = daily.map((r) => r.sales);
  const mean = daysTotal > 0 ? units / daysTotal : 0;
  let cv = 0;
  if (mean > 0) {
    const variance =
      series.reduce((s, x) => s + (x - mean) * (x - mean), 0) / daysTotal;
    cv = Math.sqrt(variance) / mean;
  }

  return {
    sku,
    hasData: daysTotal > 0,
    daysTotal,
    daysWithSales: saleDays.length,
    units: round(units, 0),
    revenue: round(revenue, 0),
    avgPrice: round(avgPrice, 0),
    cv: round(cv, 3),
    cvPct: round(cv * 100, 1),
  };
}

/** Присваивает XYZ-класс по коэффициенту вариации (в долях). */
function xyzClass(cv, { xCv, yCv }) {
  const pct = cv * 100;
  if (pct <= xCv) return 'X';
  if (pct <= yCv) return 'Y';
  return 'Z';
}

/**
 * Простой пул параллельных задач с ограничением concurrency
 * (та же схема, что в stockReport.js).
 */
async function mapPool(items, concurrency, worker, shouldStop) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      if (shouldStop && shouldStop()) break;
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Строит ABC(-XYZ) отчёт по списку товаров за период [d1, d2].
 * @param {object} opts
 * @param {'revenue'|'units'} [opts.metric='revenue'] — по какому показателю ранжируем ABC.
 * @returns {Promise<{period, metric, thresholds, rows, matrix, classTotals, totals, errors, dailyLimit}>}
 */
export async function buildAbcReport({
  items,
  skus,
  d1,
  d2,
  metric = 'revenue',
  concurrency = 5,
  thresholds,
  onProgress,
} = {}) {
  const th = thresholds || defaultThresholds();
  const byMetric = metric === 'units' ? 'units' : 'revenue';

  const rawItems = items ? items : (skus || []).map((s) => ({ wb: s, seller: '' }));
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
  let dailyLimit = null;

  const rawRows = await mapPool(
    unique,
    concurrency,
    async (item) => {
      const sku = item.wb;
      try {
        const daily = await fetchItemDailySales(sku, d1, d2);
        const agg = computeSkuAggregate(sku, daily);
        if (onProgress) onProgress(++done, unique.length, sku);
        return { seller: item.seller, ...agg };
      } catch (err) {
        if (err?.dailyLimit && !dailyLimit) dailyLimit = String(err?.message || err);
        errors.push({ sku, seller: item.seller, error: String(err?.message || err) });
        if (onProgress) onProgress(++done, unique.length, sku);
        return { sku, seller: item.seller, hasData: false, error: String(err?.message || err) };
      }
    },
    () => dailyLimit !== null
  );

  const processed = rawRows.filter(Boolean);
  const withData = processed.filter((r) => r.hasData);
  const noData = processed.filter((r) => !r.hasData);

  // Ранжируем по выбранному показателю (по убыванию) и раскладываем ABC
  // по накопленной доле. Товары без продаж (метрика = 0) уходят в хвост → C.
  withData.sort((a, b) => b[byMetric] - a[byMetric]);
  const grandTotal = withData.reduce((s, r) => s + r[byMetric], 0);

  let cum = 0;
  for (const r of withData) {
    const share = grandTotal > 0 ? r[byMetric] / grandTotal : 0;
    cum += r[byMetric];
    const cumShare = grandTotal > 0 ? cum / grandTotal : 1;
    const cumPct = cumShare * 100;

    // ABC по накопленной доле (включая сам товар).
    let abc;
    if (cumPct <= th.aPct) abc = 'A';
    else if (cumPct <= th.bPct) abc = 'B';
    else abc = 'C';

    const xyz = xyzClass(r.cv, th);

    r.metricValue = r[byMetric];
    r.sharePct = round(share * 100, 2);
    r.cumSharePct = round(cumPct, 2);
    r.abc = abc;
    r.xyz = xyz;
    r.class = abc + xyz; // AX, BY, CZ, …
  }

  // Матрица 3×3: по каждой ячейке — число SKU, выручка, штуки, доля выручки.
  const ABC = ['A', 'B', 'C'];
  const XYZ = ['X', 'Y', 'Z'];
  const cell = () => ({ skuCount: 0, revenue: 0, units: 0 });
  const matrix = {};
  for (const a of ABC) {
    matrix[a] = {};
    for (const x of XYZ) matrix[a][x] = cell();
  }
  const totalRevenue = withData.reduce((s, r) => s + r.revenue, 0);
  for (const r of withData) {
    const c = matrix[r.abc][r.xyz];
    c.skuCount += 1;
    c.revenue += r.revenue;
    c.units += r.units;
  }
  for (const a of ABC) {
    for (const x of XYZ) {
      const c = matrix[a][x];
      c.revenue = round(c.revenue, 0);
      c.units = round(c.units, 0);
      c.revenueSharePct = round(totalRevenue > 0 ? (c.revenue / totalRevenue) * 100 : 0, 1);
    }
  }

  // Итоги по классам ABC и по классам XYZ (одномерные срезы матрицы).
  const classTotals = { abc: {}, xyz: {} };
  for (const a of ABC) classTotals.abc[a] = { skuCount: 0, revenue: 0, units: 0 };
  for (const x of XYZ) classTotals.xyz[x] = { skuCount: 0, revenue: 0, units: 0 };
  for (const r of withData) {
    for (const acc of [classTotals.abc[r.abc], classTotals.xyz[r.xyz]]) {
      acc.skuCount += 1;
      acc.revenue += r.revenue;
      acc.units += r.units;
    }
  }
  for (const group of [classTotals.abc, classTotals.xyz]) {
    for (const key of Object.keys(group)) {
      const g = group[key];
      g.revenue = round(g.revenue, 0);
      g.units = round(g.units, 0);
      g.revenueSharePct = round(totalRevenue > 0 ? (g.revenue / totalRevenue) * 100 : 0, 1);
    }
  }

  const totals = {
    skusRequested: unique.length,
    skuCount: withData.length,
    skusNoData: noData.length,
    skusSkipped: unique.length - processed.length,
    revenue: round(totalRevenue, 0),
    units: round(withData.reduce((s, r) => s + r.units, 0), 0),
    metric: byMetric,
  };

  return {
    period: { d1, d2 },
    metric: byMetric,
    thresholds: th,
    rows: [...withData, ...noData],
    matrix,
    classTotals,
    totals,
    errors,
    dailyLimit,
  };
}

const CSV_COLUMNS = [
  ['class', 'Класс'],
  ['abc', 'ABC'],
  ['xyz', 'XYZ'],
  ['seller', 'Артикул продавца'],
  ['sku', 'SKU'],
  ['units', 'Продано, шт'],
  ['revenue', 'Выручка, ₽'],
  ['avgPrice', 'Средняя цена, ₽'],
  ['sharePct', 'Доля, %'],
  ['cumSharePct', 'Накопл. доля, %'],
  ['cvPct', 'Вариация спроса, %'],
  ['daysWithSales', 'Дней с продажами'],
];

/**
 * Экспорт ABC-отчёта в CSV (разделитель ';' + BOM — дружелюбно к RU Excel).
 */
export function abcReportToCSV(report) {
  const sep = ';';
  const cell = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    return String(v);
  };
  const header = CSV_COLUMNS.map(([, title]) => title).join(sep);
  const lines = report.rows
    .filter((r) => r.hasData)
    .map((r) => CSV_COLUMNS.map(([key]) => cell(r[key])).join(sep));
  return '﻿' + [header, ...lines].join('\r\n') + '\r\n';
}
