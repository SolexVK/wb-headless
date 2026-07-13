// lib/salesPlan.js — ядро «плана продаж на сезон» (метод Овчинникова).
//
// Здесь только ЧИСТАЯ математика над дневными рядами группы-эталона:
// агрегация → сглаживание → снятие тренда → коэффициенты (продажи/остатки/цена)
// → ранг сезонности → фазы сезона (вход/разгон/пик/распродажа) → ценовые
// ориентиры по фазам → плановое число заказов по дням.
//
// Сбор данных из MPStats и любой I/O живут отдельно (lib/seasonPlanReport.js) —
// этот модуль детерминирован и тестируется без сети.
//
// Методология: docs/sales-plan-method.md.

const round = (n, d = 4) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

// ── Пороги по умолчанию (умеренной грануляции, калибруются по данным) ────────
export const DEFAULTS = {
  smoothWindow: 7, // окно скользящего среднего (гасит недельную «пилу»)
  hotCoeff: 1.3, // kSales ≥ этого — «горячий сезон»
  baseCoeff: 1.0, // пересечение 1.0 — граница разгона/распродажи
  rankStrong: 2.0, // амплитуда ≥ — ярко выраженный сезон
  rankModerate: 1.3, // амплитуда ≥ — умеренный, иначе слабый
  ratingLeadDays: 28, // лаг на набор рейтинга/SEO до старта разгона
  logisticsLeadDays: 21, // лаг на завоз на склад до старта продаж
};

// ── Базовые численные помощники ──────────────────────────────────────────────

/** Центрированное скользящее среднее с усадкой окна на краях. */
export function movingAverage(values, window = 7) {
  const n = values.length;
  if (n === 0) return [];
  const half = Math.floor(window / 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    let sum = 0;
    for (let j = a; j <= b; j++) sum += values[j];
    out[i] = sum / (b - a + 1);
  }
  return out;
}

/** Линейная регрессия y по индексу x=0..n-1. Возвращает {a, b}: y ≈ a + b·x. */
export function linearFit(values) {
  const n = values.length;
  if (n === 0) return { a: 0, b: 0 };
  if (n === 1) return { a: values[0], b: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
    sxx += i * i;
    sxy += i * values[i];
  }
  const denom = n * sxx - sx * sx;
  const b = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

/** Перцентиль (линейная интерполяция) по копии массива. p в [0,1]. */
export function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (arr.length === 0) return 0;
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/** Сдвиг даты 'YYYY-MM-DD' на N лет (для проекции прошлого сезона на будущий). */
export function shiftYears(ymd, years) {
  if (!ymd) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y + years, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

// ── Шаг 2: агрегация дневных рядов группы ────────────────────────────────────

/**
 * Сводит поштучные дневные ряды в ОДИН дневной ряд группы.
 * @param perItem — массив рядов вида [{date, sales, balance, price, revenue}]
 *                  (нормализованный вывод lib/mpstats.js по каждому SKU группы).
 * @returns [{date, sales, stock, price, revenue, skusInStock, skusActive}]
 *          price — средневзвешенная по продажам цена «реального спроса».
 */
export function buildGroupDailySeries(perItem) {
  const byDate = new Map();
  for (const series of perItem) {
    for (const row of series || []) {
      if (!row.date) continue;
      let acc = byDate.get(row.date);
      if (!acc) {
        acc = { date: row.date, sales: 0, stock: 0, revenue: 0, priceNum: 0, priceDen: 0, priceFallbackSum: 0, priceFallbackCnt: 0, skusInStock: 0, skusActive: 0 };
        byDate.set(row.date, acc);
      }
      const sales = Number(row.sales) || 0;
      const price = Number(row.price) || 0;
      acc.sales += sales;
      acc.stock += Number(row.balance) || 0;
      acc.revenue += Number(row.revenue) || 0;
      if (price > 0) {
        // Взвешиваем по продажам (цена спроса); если в день продаж нет —
        // копим простое среднее по активным карточкам как запасной вариант.
        acc.priceNum += price * sales;
        acc.priceDen += sales;
        acc.priceFallbackSum += price;
        acc.priceFallbackCnt += 1;
      }
      if ((Number(row.balance) || 0) > 0) acc.skusInStock += 1;
      acc.skusActive += 1;
    }
  }

  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((a) => ({
      date: a.date,
      sales: round(a.sales, 2),
      stock: round(a.stock, 2),
      revenue: round(a.revenue, 2),
      price: round(
        a.priceDen > 0
          ? a.priceNum / a.priceDen
          : a.priceFallbackCnt > 0
            ? a.priceFallbackSum / a.priceFallbackCnt
            : 0,
        2
      ),
      skusInStock: a.skusInStock,
      skusActive: a.skusActive,
    }));
}

// ── Шаг 3: коэффициенты (продажи/остатки/цена) ───────────────────────────────

/**
 * Строит дневные коэффициенты. kSales — относительно ТРЕНДА (как «% к тренду» в
 * MPStats): сначала сглаживаем, затем делим на линейный тренд сглаженного ряда.
 * kStock и kPrice — относительно своего среднего.
 * @returns { dates, kSales, kStock, kPrice, smoothedSales, trendSales,
 *            meanStock, meanPrice, baseDailySales }
 */
export function computeCoefficients(groupDaily, opts = {}) {
  const window = opts.smoothWindow ?? DEFAULTS.smoothWindow;
  const dates = groupDaily.map((r) => r.date);
  const sales = groupDaily.map((r) => r.sales);
  const stock = groupDaily.map((r) => r.stock);
  const price = groupDaily.map((r) => r.price);

  const smoothedSales = movingAverage(sales, window);
  const { a, b } = linearFit(smoothedSales);
  const meanSmoothed = mean(smoothedSales) || 1;
  // База по дню = значение тренда, но не ниже небольшого порога (защита от
  // ухода тренда в ноль/минус при крутом падении рынка).
  const floor = meanSmoothed * 0.1;
  const trendSales = smoothedSales.map((_, i) => Math.max(a + b * i, floor));
  const kSales = smoothedSales.map((v, i) => round(v / trendSales[i], 4));

  const smoothedStock = movingAverage(stock, window);
  const meanStock = mean(smoothedStock) || 1;
  const kStock = smoothedStock.map((v) => round(v / meanStock, 4));

  const smoothedPrice = movingAverage(price, window);
  const meanPrice = mean(smoothedPrice.filter((v) => v > 0)) || 1;
  const kPrice = smoothedPrice.map((v) => round(v / meanPrice, 4));

  return {
    dates,
    kSales,
    kStock,
    kPrice,
    smoothedSales: smoothedSales.map((v) => round(v, 2)),
    trendSales: trendSales.map((v) => round(v, 2)),
    meanStock: round(meanStock, 2),
    meanPrice: round(meanPrice, 2),
    baseDailySales: round(meanSmoothed, 2),
  };
}

// ── Шаг 4: ранг сезонности ───────────────────────────────────────────────────

/** Амплитуда по устойчивым перцентилям kSales → ранг (сила сезонности). */
export function computeRank(kSales, opts = {}) {
  const strong = opts.rankStrong ?? DEFAULTS.rankStrong;
  const moderate = opts.rankModerate ?? DEFAULTS.rankModerate;
  const p90 = percentile(kSales, 0.9);
  const p10 = percentile(kSales, 0.1);
  const amplitude = p10 > 0 ? round(p90 / p10, 3) : Infinity;

  let rank, code;
  if (amplitude >= strong) { rank = 'ярко выраженный'; code = 'strong'; }
  else if (amplitude >= moderate) { rank = 'умеренный'; code = 'moderate'; }
  else { rank = 'слабый'; code = 'weak'; }

  return { rank, code, amplitude, p90: round(p90, 3), p10: round(p10, 3) };
}

// ── Шаг 5: фазы сезона ───────────────────────────────────────────────────────

/**
 * Находит фазы по сглаженной кривой kSales:
 *   пик → горячий сезон (окно вокруг пика с kSales≥hot) → разгон (от пересечения
 *   1.0 вверх до горячего) → вход в рынок (разгон − лаги) → распродажа (после
 *   пика, пересечение 1.0 вниз).
 * Даты — исторические (из окна данных); *Next — проекция на +1 год.
 */
export function detectPhases(dates, kSales, opts = {}) {
  const hot = opts.hotCoeff ?? DEFAULTS.hotCoeff;
  const base = opts.baseCoeff ?? DEFAULTS.baseCoeff;
  const leadRating = opts.ratingLeadDays ?? DEFAULTS.ratingLeadDays;
  const leadLogi = opts.logisticsLeadDays ?? DEFAULTS.logisticsLeadDays;
  const n = kSales.length;
  if (n === 0) return null;

  // Пик — максимум kSales.
  let peakIdx = 0;
  for (let i = 1; i < n; i++) if (kSales[i] > kSales[peakIdx]) peakIdx = i;

  // Горячий сезон — непрерывное окно kSales≥hot вокруг пика.
  let hotStart = peakIdx, hotEnd = peakIdx;
  while (hotStart > 0 && kSales[hotStart - 1] >= hot) hotStart--;
  while (hotEnd < n - 1 && kSales[hotEnd + 1] >= hot) hotEnd++;

  // Разгон — назад от начала горячего до последнего дня ниже базовой 1.0.
  let rampStart = hotStart;
  while (rampStart > 0 && kSales[rampStart - 1] >= base) rampStart--;

  // Распродажа — вперёд от пика до пересечения 1.0 вниз.
  let saleStart = hotEnd;
  while (saleStart < n - 1 && kSales[saleStart + 1] >= base) saleStart++;
  saleStart = Math.min(saleStart + 1, n - 1);

  // Вход в рынок — с упреждением на подготовку (может уйти за левый край окна).
  const entryOffset = rampStart - (leadRating + leadLogi);
  const entryDate = offsetDate(dates[rampStart], -(leadRating + leadLogi));

  const at = (i) => (i >= 0 && i < n ? dates[i] : null);
  const phase = (label, i) => ({
    label,
    date: at(i),
    dateNext: at(i) ? shiftYears(at(i), 1) : null,
    kSales: at(i) ? kSales[i] : null,
  });

  return {
    peakIdx,
    entry: {
      label: 'вход в рынок',
      date: entryDate,
      dateNext: entryDate ? shiftYears(entryDate, 1) : null,
      beforeWindow: entryOffset < 0, // вход раньше начала имеющихся данных
      leadDays: leadRating + leadLogi,
    },
    ramp: phase('старт разгона', rampStart),
    hotStart: phase('старт горячего сезона', hotStart),
    peak: phase('пик', peakIdx),
    hotEnd: phase('конец горячего сезона', hotEnd),
    sale: phase('старт распродажи', saleStart),
  };
}

/** Сдвиг 'YYYY-MM-DD' на N дней. */
function offsetDate(ymd, days) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// ── Шаг 6: ценовые ориентиры по фазам ────────────────────────────────────────

/**
 * Рекомендованная цена по фазам = средняя цена группы × kPrice фазы.
 * Ниже unit-экономики не опускаемся (minPrice), если задана.
 */
export function recommendPricing(dates, kPrice, meanPrice, phases, opts = {}) {
  const minPrice = opts.minPrice ?? 0;
  const idxOf = (date) => dates.indexOf(date);
  const priceAt = (date) => {
    const i = idxOf(date);
    if (i < 0) return null;
    const rec = meanPrice * kPrice[i];
    return round(Math.max(rec, minPrice), 0);
  };
  return {
    entry: priceAt(phases.ramp.date), // на входе/разгоне — уровень старта сезона
    peak: priceAt(phases.peak.date), // пик — максимум (с наценкой «под скидку»)
    sale: priceAt(phases.sale.date), // распродажа — минимум
    meanPrice: round(meanPrice, 0),
  };
}

// ── Шаг 7: плановое число заказов по дням ─────────────────────────────────────

/**
 * planOrders[d] = baseDaily × kSales[d].
 * baseDaily задаётся целью (объём периода/дни × коэффициент амбиции); если не
 * задан — берём среднедневную базу исторического ряда.
 */
export function planDailyOrders(dates, kSales, baseDaily) {
  return dates.map((date, i) => ({
    date,
    dateNext: shiftYears(date, 1),
    kSales: kSales[i],
    plannedOrders: round(baseDaily * kSales[i], 1),
  }));
}

// ── Оркестратор: полный план по группе ───────────────────────────────────────

/**
 * Собирает план сезона из дневного ряда группы.
 * @param groupDaily — вывод buildGroupDailySeries.
 * @param opts — { ...DEFAULTS, targetPeriodUnits?, ambition?, minPrice? }.
 */
export function buildSeasonPlan(groupDaily, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const coeffs = computeCoefficients(groupDaily, cfg);
  const rank = computeRank(coeffs.kSales, cfg);
  const phases = detectPhases(coeffs.dates, coeffs.kSales, cfg);

  // База под план: из цели на период (если задана) либо историческая.
  const days = coeffs.dates.length || 1;
  const ambition = cfg.ambition ?? 1;
  const baseDaily = cfg.targetPeriodUnits
    ? (cfg.targetPeriodUnits / days) * ambition
    : coeffs.baseDailySales * ambition;

  const pricing = phases
    ? recommendPricing(coeffs.dates, coeffs.kPrice, coeffs.meanPrice, phases, cfg)
    : null;
  const daily = planDailyOrders(coeffs.dates, coeffs.kSales, baseDaily).map((d, i) => ({
    ...d,
    kStock: coeffs.kStock[i],
    kPrice: coeffs.kPrice[i],
  }));

  return {
    period: { d1: coeffs.dates[0] ?? null, d2: coeffs.dates[coeffs.dates.length - 1] ?? null },
    rank,
    phases,
    pricing,
    baseDaily: round(baseDaily, 2),
    meanPrice: coeffs.meanPrice,
    meanStock: coeffs.meanStock,
    coeffs: {
      dates: coeffs.dates,
      kSales: coeffs.kSales,
      kStock: coeffs.kStock,
      kPrice: coeffs.kPrice,
    },
    daily,
  };
}
