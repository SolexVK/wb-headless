// lib/nicheAnalysis.js — движок «Анализ ниши» (категории Wildberries).
//
// Пять измерений (см. docs/niche-analysis-methodology.md):
//   1. Ёмкость рынка   — сколько денег/штук генерит ниша, ср. на «живой» товар, упущенная выручка.
//   2. Сезонность      — насколько продажи зависят от времени года; окно входа (нужен длинный период).
//   3. Тренды          — куда движется ниша (2-я половина периода vs 1-я + наклон регрессии).
//   4. Конкуренция     — число продавцов/брендов, монополизация (доля выручки топ-10), барьер по отзывам.
//   5. Насыщенность    — доля товаров с продажами (мёртвые карточки = скрытая насыщенность).
//
// Каждое измерение получает 0–20 баллов → сводный скоринг 0–100, вердикт и узкое место.
// Данные MPSTATS оценочные — итог для сравнения/ранжирования, не как бухгалтерия.

import { buildNicheReport } from './nicheReport.js';
import {
  fetchCategoryTrends,
  fetchCategorySellers,
  fetchCategoryBrands,
  fetchPriceSegmentation,
  fetchSearchResults,
} from './mpstats.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const round = (n, d = 1) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/** Линейная шкала x∈[lo,hi] → [0,outMax] с обрезкой по краям. */
const scale = (x, lo, hi, outMax = 20) =>
  hi === lo ? 0 : clamp((x - lo) / (hi - lo), 0, 1) * outMax;

function median(nums) {
  const s = nums.filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Число дней в периоде [d1,d2] включительно. */
function periodDays(d1, d2) {
  const a = Date.parse(`${d1}T00:00:00Z`);
  const b = Date.parse(`${d2}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 30;
  return Math.round((b - a) / 86400000) + 1;
}

// Пороги вынесены в конфиг — калибруются под свои ниши.
// Денежные пороги — на 30 дней (нормируем период к месяцу).
export const DEFAULT_THRESHOLDS = {
  capacity: {
    revLowMonth: 3_000_000, // ₽/мес: ниже — ниша «мелкая»
    revHighMonth: 30_000_000, // ₽/мес: выше — крупная
    perActiveLowMonth: 30_000, // ₽/мес на «живой» товар: ниже — тесно
    perActiveHighMonth: 150_000,
  },
  trend: { downPct: -10, upPct: 10 }, // Δ% выручки 2-я половина vs 1-я
  seasonality: { lowStrength: 0.15, highStrength: 0.4 }, // размах помесячного индекса
  competition: {
    monopolyHealthy: 15, // % выручки топ-10 товаров: ≤ — здоровая
    monopolyHigh: 40, // ≥ — высокая монополизация
    reviewsBarrier: 3000, // медиана отзывов у топ-20 выше — высокий барьер
    thinSellers: 10, // продавцов меньше — «тонкая»/монопольная ниша
  },
  saturation: { withSalesBad: 30, withSalesGood: 60 }, // % товаров с продажами
  queryDemand: { ratioHigh: 10, ratioMid: 3 }, // спрос:предложение (частотность ÷ карточки)
};

// ---- нормализация дневного ряда trends ----
function normalizeTrendRow(r) {
  return {
    date: r.date ?? r.data ?? r.day ?? null,
    revenue: num(r.revenue ?? r.sum ?? r.turnover ?? r.sales_sum),
    sales: num(r.sales ?? r.orders ?? r.sales_count),
    withSales: num(r.items_with_sales ?? r.sales_items ?? r.goods_with_sales ?? r.items),
  };
}

/** Тренд ниши: Δ% (2-я половина vs 1-я) + наклон регрессии по выручке. */
export function computeTrend(trendRows, th = DEFAULT_THRESHOLDS.trend) {
  const pts = (trendRows || []).map(normalizeTrendRow).filter((r) => r.date);
  const rev = pts.map((p) => p.revenue).filter((v) => v >= 0);
  if (rev.length < 4) return null;

  const h = Math.floor(rev.length / 2);
  const first = rev.slice(0, h).reduce((s, v) => s + v, 0);
  const second = rev.slice(h).reduce((s, v) => s + v, 0);
  const deltaPct = first > 0 ? ((second - first) / first) * 100 : 0;

  // наклон линейной регрессии, нормированный к среднему (%/день).
  const n = rev.length;
  const mean = rev.reduce((s, v) => s + v, 0) / n;
  const xm = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  rev.forEach((y, i) => {
    sxy += (i - xm) * (y - mean);
    sxx += (i - xm) ** 2;
  });
  const slope = sxx ? sxy / sxx : 0;
  const slopePctPerDay = mean ? (slope / mean) * 100 : 0;

  // тренд числа товаров с продажами (растёт быстрее выручки = ниша забивается)
  const ws = pts.map((p) => p.withSales).filter((v) => v > 0);
  let withSalesDeltaPct = null;
  if (ws.length >= 4) {
    const hh = Math.floor(ws.length / 2);
    const f = ws.slice(0, hh).reduce((s, v) => s + v, 0);
    const s2 = ws.slice(hh).reduce((s, v) => s + v, 0);
    withSalesDeltaPct = f > 0 ? round(((s2 - f) / f) * 100) : null;
  }

  const direction = deltaPct >= th.upPct ? 'up' : deltaPct <= th.downPct ? 'down' : 'flat';
  return {
    points: pts.length,
    deltaPct: round(deltaPct),
    slopePctPerDay: round(slopePctPerDay, 2),
    withSalesDeltaPct,
    direction,
  };
}

/** Сезонность из длинного ряда trends: помесячный индекс, пик, окно входа. */
export function computeSeasonality(trendRows, days, th = DEFAULT_THRESHOLDS.seasonality) {
  const pts = (trendRows || []).map(normalizeTrendRow).filter((r) => r.date);
  const byMonth = new Map(); // YYYY-MM → сумма выручки
  for (const p of pts) {
    const key = String(p.date).slice(0, 7);
    byMonth.set(key, (byMonth.get(key) || 0) + p.revenue);
  }
  // Нужен длинный горизонт: минимум ~8 календарных месяцев данных.
  if (days < 240 || byMonth.size < 8) {
    return {
      sufficient: false,
      note:
        'Период короткий — сезонность не оценивается. Задайте d1/d2 на 12+ месяцев ' +
        '(полная сезонность за 3 года — только в UI MPStats/Wildbox).',
    };
  }
  // Средний индекс по КАЛЕНДАРНОМУ месяцу (01..12), усредняя годы.
  const calAgg = new Map(); // MM → [значения]
  for (const [ym, rev] of byMonth) {
    const mm = ym.slice(5, 7);
    (calAgg.get(mm) || calAgg.set(mm, []).get(mm)).push(rev);
  }
  const monthly = [...calAgg.entries()]
    .map(([mm, arr]) => ({ month: mm, avg: arr.reduce((s, v) => s + v, 0) / arr.length }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const overall = monthly.reduce((s, m) => s + m.avg, 0) / monthly.length || 1;
  const months = monthly.map((m) => ({ month: m.month, index: round(m.avg / overall, 2) }));
  const idx = months.map((m) => m.index);
  const strength = (Math.max(...idx) - Math.min(...idx)) / (idx.reduce((s, v) => s + v, 0) / idx.length || 1);
  const level = strength <= th.lowStrength ? 'low' : strength >= th.highStrength ? 'high' : 'moderate';
  const peak = months.reduce((a, b) => (b.index > a.index ? b : a), months[0]);

  return {
    sufficient: true,
    strength: round(strength, 2),
    level,
    peakMonth: peak.month,
    months,
  };
}

// ---- скоринг по блокам (каждый 0–20) ----
function scoreCapacity(cap, days, th) {
  const k = 30 / days; // нормировка к 30 дням
  const revMonth = cap.totalRevenue * k;
  const perActiveMonth = cap.avgRevenuePerActiveProduct * k;
  const s1 = scale(revMonth, th.revLowMonth, th.revHighMonth, 10);
  const s2 = scale(perActiveMonth, th.perActiveLowMonth, th.perActiveHighMonth, 10);
  const score = round(s1 + s2, 0);
  const label = score >= 14 ? 'высокая' : score >= 7 ? 'средняя' : 'низкая';
  return {
    score,
    max: 20,
    label,
    detail: `выручка ≈ ${Math.round(revMonth).toLocaleString('ru-RU')} ₽/мес, ` +
      `на «живой» товар ≈ ${Math.round(perActiveMonth).toLocaleString('ru-RU')} ₽/мес`,
  };
}

function scoreTrend(trend, th) {
  if (!trend) {
    return { score: 10, max: 20, label: 'нет данных', detail: 'trends недоступен — нейтрально' };
  }
  let score = scale(trend.deltaPct, th.downPct, th.upPct, 20);
  // ниша забивается: товаров с продажами прибавляется быстрее выручки
  if (trend.withSalesDeltaPct != null && trend.withSalesDeltaPct - trend.deltaPct > 20) {
    score = Math.max(0, score - 3);
  }
  const label = trend.direction === 'up' ? 'восходящий' : trend.direction === 'down' ? 'нисходящий' : 'ровный';
  return {
    score: round(score, 0),
    max: 20,
    label,
    detail: `Δ выручки ${trend.deltaPct}% (2-я половина vs 1-я)` +
      (trend.withSalesDeltaPct != null ? `, товаров с продажами ${trend.withSalesDeltaPct}%` : ''),
  };
}

function scoreSeasonality(seas) {
  if (!seas || !seas.sufficient) {
    return { score: 10, max: 20, label: 'не оценено', detail: seas?.note || 'нет данных' };
  }
  const map = { low: 16, moderate: 12, high: 8 };
  const label = { low: 'стабильная', moderate: 'умеренная', high: 'сильная' }[seas.level];
  return {
    score: map[seas.level],
    max: 20,
    label,
    detail: `размах помесячного индекса ${seas.strength}, пик — месяц ${seas.peakMonth}` +
      (seas.level === 'high' ? ' (вход за 1–1,5 мес до пика)' : ''),
  };
}

function scoreCompetition(comp, th) {
  // монополизация: ≤healthy → 20, ≥high → 0
  let score = 20 * (1 - clamp((comp.monopolyPct - th.monopolyHealthy) / (th.monopolyHigh - th.monopolyHealthy), 0, 1));
  if (comp.sellersCount > 0 && comp.sellersCount < th.thinSellers) score = Math.max(0, score - 3);
  if (comp.medianTopComments > th.reviewsBarrier) score = Math.max(0, score - 4);
  const label = comp.monopolyPct <= th.monopolyHealthy ? 'здоровая'
    : comp.monopolyPct < th.monopolyHigh ? 'умеренная монополизация' : 'высокая монополизация';
  return {
    score: round(score, 0),
    max: 20,
    label,
    detail: `монополизация (топ-10 товаров) ${round(comp.monopolyPct)}%, ` +
      `продавцов ${comp.sellersCount}, медиана отзывов у топ-20 ${comp.medianTopComments}`,
  };
}

function scoreSaturation(sat, th) {
  const score = scale(sat.withSalesPct, th.withSalesBad, th.withSalesGood, 20);
  const label = sat.withSalesPct >= th.withSalesGood ? 'живой спрос'
    : sat.withSalesPct >= th.withSalesBad ? 'умеренная' : 'много мёртвых карточек';
  return {
    score: round(score, 0),
    max: 20,
    label,
    detail: `${sat.withSalesPct}% товаров с продажами (${sat.productsWithSales} из ${sat.productsAnalyzed})`,
  };
}

const BLOCK_TITLES = {
  capacity: 'Ёмкость',
  seasonality: 'Сезонность',
  trend: 'Тренд',
  competition: 'Конкуренция',
  saturation: 'Насыщенность',
};

// Нормализация строки поисковой выдачи (те же поля, что у категории, + средняя цена продажи).
function normalizeSearchRow(row) {
  const revenue = num(row.revenue ?? row.turnover ?? row.sales_sum);
  const sales = num(row.sales ?? row.sold ?? row.orders);
  return {
    sku: row.id ?? row.nmId ?? row.nm_id ?? row.sku ?? null,
    revenue,
    sales,
    price: num(row.final_price ?? row.price ?? row.client_price),
    // средняя цена продажи (= выручка/штуки, проверено на живом токене)
    avgSalePrice: num(row.final_price_average ?? row.final_price_median) || (sales > 0 ? revenue / sales : 0),
    lostProfit: num(row.lost_profit ?? row.lostProfit ?? row.lost_profit_rub),
    comments: num(row.comments ?? row.reviews ?? row.feedbacks),
  };
}

/**
 * Насыщенность по ПОИСКОВОМУ ЗАПРОСУ (фаза 2, метод «от спроса»).
 * Из POST /analytics/v1/wb/search/items: предложение (кол-во карточек), выручка
 * выдачи, доля карточек с продажами, монополизация, упущенная выручка.
 * «Спрос:предложение» = частотность ÷ карточки — считается ТОЛЬКО если частотность
 * передана (частотность в API не подтверждена; источник — Оракул/подсказки Wildbox).
 */
export async function buildQueryDemand(
  query,
  { d1, d2, frequency = null, maxRows = 2000, pageSize = 500, thresholds = DEFAULT_THRESHOLDS.queryDemand } = {}
) {
  const { rows, total, period, capped } = await fetchSearchResults(query, { d1, d2, maxRows, pageSize });
  const items = rows.map(normalizeSearchRow).filter((r) => r.sku != null).sort((a, b) => b.revenue - a.revenue);

  const analyzed = items.length;
  const withSales = items.filter((r) => r.revenue > 0 || r.sales > 0);
  const revenue = items.reduce((s, r) => s + r.revenue, 0);
  const units = items.reduce((s, r) => s + r.sales, 0);
  const lost = items.reduce((s, r) => s + r.lostProfit, 0);
  const top10 = items.slice(0, 10).reduce((s, r) => s + r.revenue, 0);
  const prices = items.map((r) => r.avgSalePrice).filter((p) => p > 0);

  const supply = total; // кол-во карточек по запросу = предложение
  const freq = frequency != null && frequency !== '' ? Number(frequency) : null;
  const ratio = freq && supply > 0 ? freq / supply : null;
  const ratioVerdict =
    ratio == null
      ? null
      : ratio >= thresholds.ratioHigh
        ? 'спрос превышает предложение'
        : ratio >= thresholds.ratioMid
          ? 'умеренный спрос'
          : 'предложение насыщено';

  return {
    query,
    period,
    supply,
    analyzed,
    capped,
    revenue: round(revenue, 0),
    units: round(units, 0),
    productsWithSales: withSales.length,
    withSalesPct: analyzed ? round((withSales.length / analyzed) * 100, 1) : 0,
    avgRevenuePerCard: analyzed ? round(revenue / analyzed, 0) : 0,
    avgRevenuePerActiveCard: withSales.length ? round(revenue / withSales.length, 0) : 0,
    monopolyTop10Pct: revenue ? round((top10 / revenue) * 100, 1) : 0,
    lostRevenue: round(lost, 0),
    medianAvgSalePrice: round(median(prices), 0),
    frequency: freq,
    demandSupplyRatio: ratio != null ? round(ratio, 1) : null,
    ratioVerdict,
    note:
      freq == null
        ? 'Частотность запроса не задана — «спрос:предложение» не рассчитан. ' +
          'Источник частотности (Оракул/подсказки Wildbox) в API не подтверждён; ' +
          'передайте её вручную (NICHE_FREQ / &freq=).'
        : null,
  };
}

/**
 * Полный анализ ниши: тянет категорию + срезы, считает 5 блоков и скоринг.
 * Если задан `query` — добавляет блок насыщенности по поисковому запросу (фаза 2).
 * @returns {Promise<object>} структура с capacity/trend/seasonality/competition/saturation/score
 */
export async function buildNicheAnalysis({
  categoryPath,
  d1,
  d2,
  maxRows = 5000,
  pageSize = 500,
  thresholds = DEFAULT_THRESHOLDS,
  secondary = true,
  query = null,
  frequency = null,
  onPage,
} = {}) {
  const days = periodDays(d1, d2);
  const notes = [];

  // База: товары ниши + агрегаты (ёмкость, продавцы, монополизация, насыщенность).
  const base = await buildNicheReport({ categoryPath, d1, d2, maxRows, pageSize, onPage });
  const t = base.totals;

  // Мягкие срезы: тренды/продавцы/бренды/сегменты (форматы могут отличаться).
  let trendRows = [];
  let sellersRows = [];
  let brandsRows = [];
  let priceSegments = [];
  if (secondary) {
    const soft = async (fn, label) => {
      try {
        return await fn();
      } catch (err) {
        notes.push(`${label}: ${String(err?.message || err).split(':')[0]}`);
        return [];
      }
    };
    [trendRows, sellersRows, brandsRows, priceSegments] = await Promise.all([
      soft(() => fetchCategoryTrends(categoryPath, d1, d2), 'trends'),
      soft(() => fetchCategorySellers(categoryPath, d1, d2), 'sellers'),
      soft(() => fetchCategoryBrands(categoryPath, d1, d2), 'brands'),
      soft(() => fetchPriceSegmentation(categoryPath, d1, d2), 'price_segmentation'),
    ]);
  }

  // Ёмкость
  const lostRevenue = base.items.reduce((s, r) => s + num(r.lostProfit), 0);
  const capacity = {
    productsInNiche: t.productsInNiche,
    productsAnalyzed: t.productsAnalyzed,
    truncated: t.truncated,
    totalRevenue: t.totalRevenue,
    totalUnits: t.totalUnits,
    avgRevenuePerProduct: t.avgRevenuePerProduct,
    avgRevenuePerActiveProduct: t.avgRevenuePerActiveProduct,
    medianPrice: t.medianPrice,
    avgPrice: t.avgPrice,
    lostRevenue: round(lostRevenue, 0),
  };

  // Тренд и сезонность из ряда trends
  const trend = computeTrend(trendRows, thresholds.trend);
  const seasonality = computeSeasonality(trendRows, days, thresholds.seasonality);

  // Конкуренция: авторитетные счётчики из спец-эндпоинтов (если пришли),
  // иначе — из выборки товаров (может недосчитать при усечении maxRows).
  const sellersCount = sellersRows.length || t.sellersCount;
  const brandsCount = brandsRows.length || t.brandsCount;
  const medianTopComments = round(
    median(
      [...base.items].sort((a, b) => b.revenue - a.revenue).slice(0, 20).map((r) => r.comments)
    ),
    0
  );
  const competition = {
    sellersCount,
    brandsCount,
    monopolyPct: t.top10RevenueSharePct, // доля выручки топ-10 товаров
    topSeller: t.topSeller,
    topSellerSharePct: t.topSellerSharePct,
    medianTopComments,
    sellersFromEndpoint: sellersRows.length > 0,
  };

  // Насыщенность
  const saturation = {
    withSalesPct: t.withSalesPct,
    productsWithSales: t.productsWithSales,
    productsNoSales: t.productsNoSales,
    productsAnalyzed: t.productsAnalyzed,
  };
  // Фаза 2: насыщенность по поисковому запросу (если передан query).
  let queryDemand = null;
  if (query && String(query).trim()) {
    try {
      queryDemand = await buildQueryDemand(query, {
        d1,
        d2,
        frequency,
        thresholds: thresholds.queryDemand,
      });
    } catch (err) {
      notes.push(`queryDemand: ${String(err?.message || err).split(':')[0]}`);
    }
  } else {
    notes.push(
      'Для блока насыщенности «по запросу» (спрос:предложение) передайте поисковую ' +
        'фразу query (NICHE_QUERY / &query=).'
    );
  }

  // Скоринг
  const blocks = {
    capacity: scoreCapacity(capacity, days, thresholds.capacity),
    seasonality: scoreSeasonality(seasonality),
    trend: scoreTrend(trend, thresholds.trend),
    competition: scoreCompetition(competition, thresholds.competition),
    saturation: scoreSaturation(saturation, thresholds.saturation),
  };
  const total = Object.values(blocks).reduce((s, b) => s + b.score, 0);
  const verdict = total >= 70 ? 'Заходить' : total >= 45 ? 'Заходить осторожно' : 'Не заходить';
  // Узкое место — блок с минимальным баллом.
  const bottleneckKey = Object.entries(blocks).sort((a, b) => a[1].score - b[1].score)[0][0];

  return {
    categoryPath,
    period: { d1, d2, days },
    generatedAt: new Date().toISOString(),
    score: {
      total: round(total, 0),
      max: 100,
      verdict,
      bottleneck: BLOCK_TITLES[bottleneckKey],
      blocks,
    },
    capacity,
    trend,
    seasonality,
    competition,
    saturation,
    queryDemand,
    priceSegments,
    sellers: base.sellers,
    brands: base.brands,
    items: base.items,
    notes,
  };
}
