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
  // Ранг считаем по амплитуде = p90/p50 (пик-к-медиане) — устойчиво к near-zero
  // низкому сезону (в отличие от p90/p10, которое зашкаливает). Калибровано на
  // реальных линейках: умеренные ~1.4–1.7, ярко выраженные ~2.5–3.8.
  rankStrong: 2.0, // амплитуда ≥ — ярко выраженный сезон
  rankModerate: 1.3, // амплитуда ≥ — умеренный, иначе слабый
  ratingLeadDays: 28, // лаг на набор рейтинга/SEO до старта разгона
  logisticsLeadDays: 21, // лаг на завоз на склад до старта продаж
  minActiveDays: 300, // < этого активных дней — годовой профиль недостоверен
  recencyWeight: 2, // вес недавнего года против позапрошлого (Правило 2)
  competitorWeight: 0.9, // доля конкурентов в базе (Правило 3)
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

/**
 * OOS-поправка (по одному товару, ДО агрегации в группу): в дни простоя
 * (остаток ≤ 0 и продажи 0) восстанавливаем ожидаемый спрос — средние продажи
 * в дни, когда товар был в наличии. Иначе дефицит выглядит как «низкий спрос» и
 * занижает сезонный профиль там, где на самом деле не хватило товара.
 * Методология та же, что в lib/stockReport.js (avgDailyUnitsInStock).
 */
export function applyOOSCorrection(daily) {
  const inStock = daily.filter((r) => (r.balance || 0) > 0);
  const inStockDays = inStock.length;
  if (inStockDays === 0) return daily.map((r) => ({ ...r }));
  const avgDaily = inStock.reduce((s, r) => s + (r.sales || 0), 0) / inStockDays;
  const saleDays = inStock.filter((r) => r.sales > 0 && r.price > 0);
  const avgPrice = saleDays.length
    ? saleDays.reduce((s, r) => s + r.price, 0) / saleDays.length
    : 0;
  return daily.map((r) => {
    if ((r.balance || 0) <= 0 && (r.sales || 0) <= 0) {
      const price = r.price > 0 ? r.price : avgPrice;
      return { ...r, sales: avgDaily, price, revenue: avgDaily * price, oosRestored: true };
    }
    return { ...r };
  });
}

/**
 * Недельный профиль: коэффициенты по дням недели (0=Вс … 6=Сб), нормированные к
 * среднему 1. Считаем как среднее отношение дневных продаж к их 7-дневному
 * скользящему среднему (сезон/тренд убраны — остаётся внутринедельная «пила»).
 */
export function computeWeeklyProfile(active, window = 7) {
  const sales = active.map((r) => r.sales);
  const smoothed = movingAverage(sales, window);
  const sums = Array(7).fill(0);
  const cnts = Array(7).fill(0);
  for (let i = 0; i < active.length; i++) {
    if (smoothed[i] > 0) {
      const dow = new Date(active[i].date + 'T00:00:00Z').getUTCDay();
      sums[dow] += sales[i] / smoothed[i];
      cnts[dow] += 1;
    }
  }
  const rawf = sums.map((s, i) => (cnts[i] ? s / cnts[i] : 1));
  const m = rawf.reduce((a, b) => a + b, 0) / 7 || 1;
  return rawf.map((x) => round(x / m, 3)); // index 0=Вс … 6=Сб, среднее = 1
}

/**
 * Обрезает ведущие/хвостовые дни без продаж — активный период линейки.
 * Линейка, запущенная в середине окна, не должна тянуть «нулевой низкий сезон»
 * из пред-запускных дней (иначе тренд и коэффициенты искажаются).
 */
export function trimToActive(groupDaily) {
  let i = 0;
  let j = groupDaily.length - 1;
  while (i < groupDaily.length && (groupDaily[i].sales || 0) <= 0) i++;
  while (j > i && (groupDaily[j].sales || 0) <= 0) j--;
  return i <= j && i < groupDaily.length ? groupDaily.slice(i, j + 1) : groupDaily.slice();
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

/**
 * Ранг сезонности по амплитуде = p90/p50 (пик-к-медиане). Устойчиво к near-zero
 * низкому сезону. `spread` (p90/p10) отдаём справочно — он показывает глубину
 * провала, но как порог нестабилен.
 */
export function computeRank(kSales, opts = {}) {
  const strong = opts.rankStrong ?? DEFAULTS.rankStrong;
  const moderate = opts.rankModerate ?? DEFAULTS.rankModerate;
  const p90 = percentile(kSales, 0.9);
  const p50 = percentile(kSales, 0.5);
  const p10 = percentile(kSales, 0.1);
  const amplitude = p50 > 0 ? round(p90 / p50, 3) : Infinity;

  let rank, code;
  if (amplitude >= strong) { rank = 'ярко выраженный'; code = 'strong'; }
  else if (amplitude >= moderate) { rank = 'умеренный'; code = 'moderate'; }
  else { rank = 'слабый'; code = 'weak'; }

  return {
    rank,
    code,
    amplitude, // p90/p50 — основная метрика
    p90: round(p90, 3),
    p50: round(p50, 3),
    p10: round(p10, 3),
    spread: p10 > 0 ? round(p90 / p10, 2) : null, // p90/p10, справочно
  };
}

// ── Шаг 5: фазы сезона ───────────────────────────────────────────────────────

/**
 * Свёрнутый (folded) сезонный профиль по ОДНОИМЁННЫМ месяцам с ВЗВЕШИВАНИЕМ ПО
 * СВЕЖЕСТИ (Правило 2). За окно в 2 года каждый календарный месяц встречается
 * дважды; недавний год весит больше (recencyWeight), т.к. ближе к реальности.
 *   index[m] = взвеш.средние_дневные_продажи[m] / среднее по месяцам.
 * Устойчив к дневным всплескам и к «краю окна» (нет привязки к конкретному году).
 * @returns { months:[{month,index,avgDaily,samples,repDate,bestDay}], asOf }
 */
export function computeFoldedMonthlyProfile(active, opts = {}) {
  const recencyWeight = opts.recencyWeight ?? DEFAULTS.recencyWeight;
  const recentDays = opts.recentDays ?? 365;
  const asOf = active[active.length - 1].date;
  const asOfT = Date.parse(asOf + 'T00:00:00Z');

  // Ячейки по (год-месяц): продажи/цена(взвеш.)/остатки/лучший день.
  const cells = new Map();
  for (const r of active) {
    const ym = r.date.slice(0, 7);
    let c = cells.get(ym);
    if (!c) { c = { ym, month: Number(ym.slice(5)), year: Number(ym.slice(0, 4)), sales: 0, days: 0, priceNum: 0, priceDen: 0, stock: 0, bestDay: r.date, bestSales: -1 }; cells.set(ym, c); }
    const s = Number(r.sales) || 0;
    const price = Number(r.price) || 0;
    c.sales += s; c.days += 1; c.stock += Number(r.stock ?? r.balance) || 0;
    if (price > 0) { c.priceNum += price * (s || 1); c.priceDen += s || 1; }
    if (s > c.bestSales) { c.bestSales = s; c.bestDay = r.date; }
  }

  // Свёртка по календарному месяцу с весом по свежести.
  const byMonth = new Map();
  for (const c of cells.values()) {
    const avgDaily = c.days > 0 ? c.sales / c.days : 0;
    const avgPrice = c.priceDen > 0 ? c.priceNum / c.priceDen : 0;
    const avgStock = c.days > 0 ? c.stock / c.days : 0;
    const ageDays = (asOfT - Date.parse(c.ym + '-15T00:00:00Z')) / 86400000;
    const w = ageDays <= recentDays ? recencyWeight : 1;
    let m = byMonth.get(c.month);
    if (!m) { m = { month: c.month, num: 0, den: 0, pNum: 0, pDen: 0, sNum: 0, samples: 0, bestYear: -1, bestDay: c.bestDay, repDate: c.bestDay }; byMonth.set(c.month, m); }
    m.num += avgDaily * w; m.den += w; m.samples += 1;
    if (avgPrice > 0) { m.pNum += avgPrice * w; m.pDen += w; }
    m.sNum += avgStock * w;
    if (c.year >= m.bestYear) { m.bestYear = c.year; m.bestDay = c.bestDay; m.repDate = c.bestDay; }
  }

  const months = [...byMonth.values()]
    .map((m) => ({ month: m.month, avgDaily: m.den ? m.num / m.den : 0, avgPrice: m.pDen ? m.pNum / m.pDen : 0, avgStock: m.den ? m.sNum / m.den : 0, samples: m.samples, repDate: m.repDate, bestDay: m.bestDay }))
    .sort((a, b) => a.month - b.month);
  const meanAvg = mean(months.map((m) => m.avgDaily)) || 1;
  const meanPrice = mean(months.map((m) => m.avgPrice).filter((v) => v > 0)) || 1;
  for (const m of months) { m.index = round(m.avgDaily / meanAvg, 3); m.priceIndex = round((m.avgPrice || meanPrice) / meanPrice, 3); }
  return { months, asOf, meanPrice: round(meanPrice, 2) };
}

const nextM = (m) => (m === 12 ? 1 : m + 1);
const prevM = (m) => (m === 1 ? 12 : m - 1);
/** Месяцы кольца [fromM..toM) вперёд (fromM включительно, toM нет). */
function ringRange(fromM, toM) {
  const out = [];
  let m = fromM, guard = 0;
  while (m !== toM && guard++ < 13) { out.push(m); m = nextM(m); }
  return out;
}
/** Сдвиг 'YYYY-MM-DD' на N календарных месяцев. */
function shiftMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, d));
  return dt.toISOString().slice(0, 10);
}
/** Ближайшая дата с месяцем `month` строго ПОСЛЕ asOf (проекция на будущее). */
function projectMonthAfter(month, day, asOf) {
  const y = Number(asOf.slice(0, 4));
  for (let yy = y; yy <= y + 1; yy++) {
    const cand = `${yy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (cand > asOf) return cand;
  }
  return `${y + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Фазы сезона по СВЁРНУТОМУ (recency-взвешенному) месячному профилю, кольцевая
 * логика (сезон может переходить через новый год). Возвращает:
 *  - представительные исторические даты фаз (для ценовых ориентиров);
 *  - проекцию на предстоящий сезон (dateNext — ближайшая будущая дата фазы);
 *  - классификацию всех 12 месяцев по этапам (для посуточной разбивки/раскраски):
 *    вход · разгон · старт сезона · пик сезона · начало распродажи · конец распродажи.
 */
export function detectPhases(active, opts = {}) {
  const hot = opts.hotCoeff ?? DEFAULTS.hotCoeff;
  const base = opts.baseCoeff ?? DEFAULTS.baseCoeff;
  const leadRating = opts.ratingLeadDays ?? DEFAULTS.ratingLeadDays;
  const leadLogi = opts.logisticsLeadDays ?? DEFAULTS.logisticsLeadDays;
  if (!active || active.length === 0) return null;

  const { months, asOf } = computeFoldedMonthlyProfile(active, opts);
  if (months.length === 0) return null;
  const idx = {}, repDay = {}, present = new Set();
  for (const m of months) { idx[m.month] = m.index; repDay[m.month] = m.repDate; present.add(m.month); }
  const has = (m) => present.has(m);

  // Пик — месяц с максимальным индексом.
  let peakM = months[0].month;
  for (const m of months) if (m.index > idx[peakM]) peakM = m.month;

  // Горячий сезон — кольцом вокруг пика, пока index ≥ hot.
  let hotStartM = peakM, hotEndM = peakM, g = 0;
  while (has(prevM(hotStartM)) && idx[prevM(hotStartM)] >= hot && prevM(hotStartM) !== peakM && g++ < 11) hotStartM = prevM(hotStartM);
  g = 0;
  while (has(nextM(hotEndM)) && idx[nextM(hotEndM)] >= hot && nextM(hotEndM) !== peakM && g++ < 11) hotEndM = nextM(hotEndM);
  // Разгон — назад от горячего, пока index ≥ base.
  let rampM = hotStartM; g = 0;
  while (has(prevM(rampM)) && idx[prevM(rampM)] >= base && prevM(rampM) !== peakM && g++ < 11) rampM = prevM(rampM);
  // Распродажа — сразу после горячего.
  const saleM = nextM(hotEndM);

  // Представительные исторические даты (для ценовых ориентиров — они реально
  // есть в active) и проекция на будущее.
  const histRamp = repDay[rampM] || active[0].date;
  const entryDate = offsetDate(histRamp, -(leadRating + leadLogi));
  const entryM = Number(entryDate.slice(5, 7));
  const peakDay = Number((repDay[peakM] || histRamp).slice(8, 10));
  const peakNext = projectMonthAfter(peakM, peakDay, asOf);
  const signedOff = (m) => { let o = (m - peakM + 12) % 12; if (o > 6) o -= 12; return o; };
  const proj = (m) => shiftMonths(`${peakNext.slice(0, 7)}-01`, signedOff(m));

  const phase = (label, m, histDate) => ({
    label,
    date: histDate ?? repDay[m] ?? null, // историческая (для цен)
    dateNext: m === peakM ? peakNext : proj(m), // проекция на предстоящий сезон
    month: m,
    index: idx[m] ?? null,
  });

  // Классификация всех месяцев по этапам (посуточная разбивка/раскраска).
  const stageOfMonth = {};
  const put = (list, stage) => list.forEach((m) => { if (!(m in stageOfMonth)) stageOfMonth[m] = stage; });
  put(ringRange(peakM, nextM(hotEndM)), 'пик сезона');
  put(ringRange(hotStartM, peakM), 'старт сезона');
  put(ringRange(rampM, hotStartM), 'разгон');
  put(ringRange(entryM, rampM), 'вход');
  put([saleM], 'начало распродажи');
  put(ringRange(nextM(saleM), entryM), 'конец распродажи');
  for (let m = 1; m <= 12; m++) if (!(m in stageOfMonth)) stageOfMonth[m] = 'межсезонье';

  const monthsPresent = present.size;
  return {
    peakM,
    peakAtEdge: monthsPresent < 6,
    saleTruncated: !has(saleM),
    recencyWeight: opts.recencyWeight ?? DEFAULTS.recencyWeight,
    monthlyProfile: months.map((m) => ({ month: m.month, index: m.index, avgDaily: round(m.avgDaily, 2), samples: m.samples })),
    stageOfMonth,
    entry: {
      label: 'вход в рынок',
      date: entryDate,
      dateNext: projectMonthAfter(entryM, Number(entryDate.slice(8, 10)), asOf),
      month: entryM,
      beforeWindow: entryDate < active[0].date,
      leadDays: leadRating + leadLogi,
    },
    ramp: phase('старт разгона', rampM, histRamp),
    hotStart: phase('старт горячего сезона', hotStartM),
    peak: phase('пик', peakM, repDay[peakM]),
    hotEnd: phase('конец горячего сезона', hotEndM),
    sale: phase('старт распродажи', saleM),
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
 * planOrders[d] = baseDaily × kSales[d] × [коэффициент дня недели].
 * baseDaily задаётся целью/своей базой; если не задан — среднедневная база ряда.
 * weekdayFactors (опц.) — 7 коэффициентов (0=Вс…6=Сб), нормированы к 1.
 */
export function planDailyOrders(dates, kSales, baseDaily, weekdayFactors = null) {
  return dates.map((date, i) => {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const wf = weekdayFactors ? weekdayFactors[dow] : 1;
    return {
      date,
      dateNext: shiftYears(date, 1),
      kSales: kSales[i],
      weekday: dow,
      weekdayFactor: round(wf, 3),
      plannedOrders: round(baseDaily * kSales[i] * wf, 1),
    };
  });
}

// ── Оркестратор: полный план по группе ───────────────────────────────────────

/**
 * Собирает план сезона из дневного ряда группы.
 * @param groupDaily — вывод buildGroupDailySeries.
 * @param opts — { ...DEFAULTS, targetPeriodUnits?, ambition?, minPrice? }.
 */
export function buildSeasonPlan(groupDaily, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  // Обрезаем пред-запускные/пост-снятые нули — считаем по активному периоду.
  const active = cfg.trim === false ? groupDaily : trimToActive(groupDaily);
  const coeffs = computeCoefficients(active, cfg);
  const rank = computeRank(coeffs.kSales, cfg);
  const phases = detectPhases(active, cfg);

  // Достаточность данных для годового профиля.
  const activeDays = active.length;
  const dataSufficiency = {
    activeDays,
    approxMonths: round(activeDays / 30.4, 1),
    lowConfidence: activeDays < (cfg.minActiveDays ?? DEFAULTS.minActiveDays),
    activeFrom: active[0]?.date ?? null,
    activeTo: active[active.length - 1]?.date ?? null,
    trimmedDays: groupDaily.length - activeDays,
  };

  // База под план (УРОВЕНЬ). Приоритет: явная база (своя линейка) → цель на
  // период → историческое среднее ряда. Форма (kSales) — всегда от этой группы.
  const days = coeffs.dates.length || 1;
  const ambition = cfg.ambition ?? 1;
  const baseDaily = cfg.baseDailyOverride != null
    ? cfg.baseDailyOverride * ambition
    : cfg.targetPeriodUnits
      ? (cfg.targetPeriodUnits / days) * ambition
      : coeffs.baseDailySales * ambition;

  // Недельный профиль (опц.) — коэффициенты по дням недели поверх плана.
  const weekdayFactors = cfg.weekly ? computeWeeklyProfile(active, cfg.smoothWindow) : null;

  const pricing = phases
    ? recommendPricing(coeffs.dates, coeffs.kPrice, coeffs.meanPrice, phases, cfg)
    : null;
  const stageOf = phases?.stageOfMonth || {};
  const daily = planDailyOrders(coeffs.dates, coeffs.kSales, baseDaily, weekdayFactors).map((d, i) => ({
    ...d,
    kStock: coeffs.kStock[i],
    kPrice: coeffs.kPrice[i],
    price: round(coeffs.meanPrice * coeffs.kPrice[i], 0), // цена спроса по дню
    stage: stageOf[Number(d.date.slice(5, 7))] || null, // этап сезона (Правило 4)
  }));

  return {
    period: { d1: coeffs.dates[0] ?? null, d2: coeffs.dates[coeffs.dates.length - 1] ?? null },
    rank,
    dataSufficiency,
    phases,
    pricing,
    baseDaily: round(baseDaily, 2),
    baseSource: cfg.baseSource || (cfg.baseDailyOverride != null ? 'override' : cfg.targetPeriodUnits ? 'target' : 'group'),
    weeklyProfile: weekdayFactors, // [Вс..Сб] или null
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
