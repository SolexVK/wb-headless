// lib/nicheAnalysis.js — движок «Анализ ниши» (категории Wildberries).
//
// Пять измерений (см. docs/niche-analysis-methodology.md):
//   1. Ёмкость рынка   — сколько денег/штук генерит ниша, ср. на «живой» товар, упущенная выручка.
//   2. Сезонность      — зависимость от времени года, пик/спад, окно входа (из истории trends ~6 лет).
//   3. Тренды          — куда движется ниша: год к году (12 мес vs 12 мес, без сезонности).
//   4. Конкуренция     — число продавцов/брендов, монополизация (доля выручки топ-10), барьер по отзывам.
//   5. Насыщенность    — доля товаров с продажами (мёртвые карточки = скрытая насыщенность).
//
// Каждое измерение получает 0–20 баллов → сводный скоринг 0–100, вердикт и узкое место.
// Данные MPSTATS оценочные — итог для сравнения/ранжирования, не как бухгалтерия.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildNicheReport } from './nicheReport.js';
import {
  fetchCategoryTrends,
  fetchCategorySellers,
  fetchCategoryBrands,
  fetchPriceSegmentation,
  fetchSearchResults,
} from './mpstats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Слияние на 2 уровня: секция из файла перекрывает соответствующую секцию
// дефолтов по ключам; отсутствующие ключи берутся из дефолтов, лишние — игнор.
function mergeThresholds(base, over) {
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] =
      base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? { ...base[k], ...(over && typeof over[k] === 'object' ? over[k] : {}) }
        : over && k in over
          ? over[k]
          : base[k];
  }
  return out;
}

/**
 * Загружает пороги скоринга из config/niche-thresholds.json (или из пути в
 * env NICHE_THRESHOLDS), накладывая их на встроенные дефолты. При ошибке
 * чтения/разбора — тихо возвращает дефолты (движок остаётся рабочим).
 */
export function loadThresholds() {
  const file =
    process.env.NICHE_THRESHOLDS || path.join(__dirname, '..', 'config', 'niche-thresholds.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return mergeThresholds(DEFAULT_THRESHOLDS, parsed);
  } catch (_) {
    return DEFAULT_THRESHOLDS;
  }
}

// Активные пороги: файл-конфиг поверх дефолтов (загружаются один раз при импорте).
const THRESHOLDS = loadThresholds();

// ---- ценовые сегменты: покрывают ВСЮ нишу (не усечены), поэтому дают
//      честную ёмкость/насыщенность даже когда товары выгружены не полностью.
//      Поля (живой токен): range, items, items_with_sells, sellers, brands,
//      revenue, sales, lost_profit, min_range_price, max_range_price.
function normalizeSegments(rows) {
  return (rows || [])
    .map((s) => ({
      range: s.range ?? null,
      minPrice: num(s.min_range_price ?? s.from ?? s.minPrice),
      maxPrice: num(s.max_range_price ?? s.to ?? s.maxPrice),
      items: num(s.items ?? s.count),
      itemsWithSells: num(s.items_with_sells ?? s.items_with_sales),
      sellers: num(s.sellers),
      brands: num(s.brands),
      revenue: num(s.revenue),
      sales: num(s.sales),
      lostProfit: num(s.lost_profit),
    }))
    .filter((s) => s.items > 0 || s.revenue > 0);
}

// Свод по сегментам = агрегат всей ниши (без смещения от усечения выгрузки).
function aggregateSegments(seg) {
  const sum = (f) => seg.reduce((a, s) => a + s[f], 0);
  const products = sum('items');
  const withSales = sum('itemsWithSells');
  return {
    products,
    withSales,
    withSalesPct: products ? round((withSales / products) * 100, 1) : 0,
    revenue: round(sum('revenue'), 0),
    sales: round(sum('sales'), 0),
    lostProfit: round(sum('lostProfit'), 0),
  };
}

// ---- нормализация дневного ряда trends ----
// Реальные поля MPSTATS (проверено живым токеном): date, revenue, sales,
// items, items_with_sells (двойная L!), sellers, brands, product_revenue.
function normalizeTrendRow(r) {
  return {
    date: r.date ?? r.data ?? r.day ?? null,
    revenue: num(r.revenue ?? r.product_revenue ?? r.sum ?? r.turnover ?? r.sales_sum),
    sales: num(r.sales ?? r.orders ?? r.sales_count),
    // «товары с продажами» — items_with_sells; НЕ путать с items (всего товаров).
    withSales: num(r.items_with_sells ?? r.items_with_sales ?? r.sales_items ?? r.goods_with_sales),
  };
}

// Свод ряда trends по календарным месяцам (endpoint отдаёт помесячную историю
// за ~6 лет и ИГНОРИРУЕТ d1/d2 — проверено живым токеном). Возвращает
// хронологически упорядоченные {ym, revenue, withSales}.
function monthlySeries(trendRows) {
  const byMonth = new Map();
  for (const r of (trendRows || []).map(normalizeTrendRow)) {
    if (!r.date) continue;
    const ym = String(r.date).slice(0, 7);
    const cur = byMonth.get(ym) || { ym, revenue: 0, withSales: 0 };
    cur.revenue += r.revenue;
    cur.withSales += r.withSales;
    byMonth.set(ym, cur);
  }
  return [...byMonth.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

/**
 * Тренд ниши по помесячной истории. Так как trends отдаёт ~6 лет вне
 * зависимости от периода запроса, «половина vs половина» была бы 6-летним
 * ростом. Правильно — **year-over-year** (последние 12 мес vs предыдущие 12):
 * убирает сезонность и даёт настоящий тренд. Плюс recency: последние 3 мес vs
 * те же 3 мес год назад.
 */
export function computeTrend(trendRows, th = DEFAULT_THRESHOLDS.trend) {
  const ser = monthlySeries(trendRows);
  const n = ser.length;
  if (n < 6) return null;
  const rev = ser.map((m) => m.revenue);
  const ws = ser.map((m) => m.withSales);
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  const pct = (a, b) => (b > 0 ? round(((a - b) / b) * 100) : null);

  let yoyPct = null;
  let withSalesYoyPct = null;
  if (n >= 24) {
    yoyPct = pct(sum(rev.slice(n - 12)), sum(rev.slice(n - 24, n - 12)));
    withSalesYoyPct = pct(sum(ws.slice(n - 12)), sum(ws.slice(n - 24, n - 12)));
  }
  // recency: последние 3 мес vs те же 3 мес год назад (сезонно-сопоставимо).
  let recentYoyPct = null;
  if (n >= 15) recentYoyPct = pct(sum(rev.slice(n - 3)), sum(rev.slice(n - 15, n - 12)));

  // fallback при короткой истории (<24 мес) — половина vs половина.
  let basis = 'yoy';
  let growthPct = yoyPct;
  if (growthPct == null) {
    basis = 'half';
    const h = Math.floor(n / 2);
    growthPct = pct(sum(rev.slice(h)), sum(rev.slice(0, h))) ?? 0;
  }
  const direction = growthPct >= th.upPct ? 'up' : growthPct <= th.downPct ? 'down' : 'flat';
  return { months: n, growthPct, yoyPct, recentYoyPct, withSalesYoyPct, direction, basis };
}

/**
 * Сезонность по помесячной истории trends (endpoint отдаёт ~6 лет вне
 * зависимости от периода запроса — поэтому сезонность доступна ВСЕГДА, а не
 * только при длинном d1/d2). Помесячный индекс = средняя выручка календарного
 * месяца ÷ средняя по месяцам (усреднение по годам).
 */
export function computeSeasonality(trendRows, th = DEFAULT_THRESHOLDS.seasonality) {
  const ser = monthlySeries(trendRows);
  // Нужен минимум год истории, чтобы индексы календарных месяцев были осмысленны.
  if (ser.length < 12) {
    return {
      sufficient: false,
      note: 'Недостаточно истории trends для сезонности (нужно ≥12 месяцев).',
    };
  }
  // Средний индекс по КАЛЕНДАРНОМУ месяцу (01..12), усредняя годы.
  const calAgg = new Map(); // MM → [значения]
  for (const m of ser) {
    const mm = m.ym.slice(5, 7);
    (calAgg.get(mm) || calAgg.set(mm, []).get(mm)).push(m.revenue);
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
  const trough = months.reduce((a, b) => (b.index < a.index ? b : a), months[0]);
  // окно входа — за 1–1,5 мес до пика (успеть накопить отзывы/органику).
  const entryMonth = String(((Number(peak.month) + 10) % 12) + 1).padStart(2, '0');

  return {
    sufficient: true,
    strength: round(strength, 2),
    level,
    peakMonth: peak.month,
    troughMonth: trough.month,
    entryMonth,
    monthsCovered: ser.length,
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
  let score = scale(trend.growthPct, th.downPct, th.upPct, 20);
  // ниша забивается: товаров с продажами прибавляется быстрее выручки (г/г)
  if (trend.withSalesYoyPct != null && trend.withSalesYoyPct - trend.growthPct > 30) {
    score = Math.max(0, score - 3);
  }
  const label = trend.direction === 'up' ? 'восходящий' : trend.direction === 'down' ? 'нисходящий' : 'ровный';
  const basisTxt = trend.basis === 'yoy' ? 'год к году, без сезонности' : '2-я половина vs 1-я';
  return {
    score: round(score, 0),
    max: 20,
    label,
    detail: `рост выручки ${trend.growthPct}% (${basisTxt})` +
      (trend.recentYoyPct != null ? `; последние 3 мес ${trend.recentYoyPct}% г/г` : ''),
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
    detail:
      `размах помесячного индекса ${seas.strength}, пик — мес ${seas.peakMonth}, ` +
      `спад — мес ${seas.troughMonth}` +
      (seas.level !== 'low' ? `; окно входа ≈ мес ${seas.entryMonth}` : ''),
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
  const basis = sat.dataBasis === 'niche' ? 'по всей нише' : 'по выгруженным top-N';
  return {
    score: round(score, 0),
    max: 20,
    label,
    detail: `${sat.withSalesPct}% товаров с продажами (${sat.productsWithSales} из ${sat.productsBasis}, ${basis})`,
  };
}

const BLOCK_TITLES = {
  capacity: 'Ёмкость',
  seasonality: 'Сезонность',
  trend: 'Тренд',
  competition: 'Конкуренция',
  saturation: 'Насыщенность',
};

/**
 * Разбирает спецификацию уточняющих фраз в список [{phrase,frequency,supplyCards}].
 * Формат строки: фразы через «;», у каждой опционально «=частотность:карточки».
 *   "рубашка в клетку тёплая=4569:4471; рубашка в клетку фланелевая=2086:2966"
 * Также принимает готовый массив объектов/строк.
 */
export function parseQueries(spec) {
  if (!spec) return [];
  const arr = Array.isArray(spec) ? spec : String(spec).split(';');
  return arr
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const phrase = String(entry.phrase ?? entry.query ?? '').trim();
        return phrase ? { phrase, frequency: entry.frequency ?? null, supplyCards: entry.supplyCards ?? null } : null;
      }
      const s = String(entry).trim();
      if (!s) return null;
      const eq = s.indexOf('=');
      if (eq === -1) return { phrase: s, frequency: null, supplyCards: null };
      const phrase = s.slice(0, eq).trim();
      const [f, sup] = s.slice(eq + 1).split(':').map((x) => x.trim());
      return { phrase, frequency: f ? Number(f) : null, supplyCards: sup ? Number(sup) : null };
    })
    .filter((q) => q && q.phrase);
}

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
    // остаток (снимок) и средний остаток за период (из графика)
    balance: num(row.balance ?? row.stock ?? row.rest ?? row.quantity),
    avgStock: (() => {
      const g = row.stocks_graph;
      if (Array.isArray(g) && g.length) return Math.round(g.reduce((s, v) => s + (Number(v) || 0), 0) / g.length);
      return num(row.balance ?? row.stock);
    })(),
    turnoverDays: num(row.turnover_days ?? row.turnoverDays),
    buyoutPct: num(row.purchase ?? row.buyout),
  };
}

/**
 * Коэффициент реализации остатка (метод Овчинникова): в периоде соотносим объём
 * продаж со СРЕДНИМ остатком за период (не снимком на сегодня — иначе смещение).
 *   коэф = Σ продано(шт) / Σ средний остаток(шт).  >1 — распродают быстрее, чем лежит.
 *   оборачиваемость (медиана turnover_days) — за сколько дней распродаётся остаток.
 */
export function sellThrough(rows) {
  const units = rows.reduce((s, r) => s + num(r.units ?? r.sales), 0);
  const stock = rows.reduce((s, r) => s + num(r.avgStock ?? r.balance), 0);
  const tds = rows.map((r) => num(r.turnoverDays)).filter((v) => v > 0).sort((a, b) => a - b);
  const medTd = tds.length ? tds[Math.floor(tds.length / 2)] : null;
  return {
    ratio: stock > 0 ? round(units / stock, 2) : null,
    medianTurnoverDays: medTd != null ? round(medTd, 0) : null,
    totalUnits: round(units, 0),
    totalStock: round(stock, 0),
  };
}

/**
 * Насыщенность по ПОИСКОВОМУ ЗАПРОСУ (фаза 2, метод «от спроса»).
 *
 * ВАЖНО (проверено живым токеном): POST /analytics/v1/wb/search/items отдаёт
 * максимум ~100 карточек (топ выдачи), `total` тоже упирается в 100 — это НЕ
 * полное «предложение» ниши по запросу, а верхушка. Поэтому блок считает
 * плотность/живость ТОП-выдачи (выручка, % с продажами, монополизация топ-10,
 * упущенная выручка), а классический «спрос:предложение» = частотность ÷ кол-во
 * карточек считается ТОЛЬКО когда пользователь передал ОБА числа вручную из
 * Wildbox (`frequency` и `supplyCards`) — в API их нет.
 */
export async function buildQueryDemand(
  query,
  {
    d1,
    d2,
    frequency = null,
    supplyCards = null,
    maxRows = 2000,
    pageSize = 500,
    thresholds = THRESHOLDS.queryDemand,
  } = {}
) {
  const { rows, total, period } = await fetchSearchResults(query, { d1, d2, maxRows, pageSize });
  const items = rows.map(normalizeSearchRow).filter((r) => r.sku != null).sort((a, b) => b.revenue - a.revenue);

  const topCount = items.length;
  const topCapped = total >= 100; // эндпоинт отдаёт максимум ~100 (топ выдачи)
  const withSales = items.filter((r) => r.revenue > 0 || r.sales > 0);
  const revenue = items.reduce((s, r) => s + r.revenue, 0);
  const units = items.reduce((s, r) => s + r.sales, 0);
  const lost = items.reduce((s, r) => s + r.lostProfit, 0);
  const top10 = items.slice(0, 10).reduce((s, r) => s + r.revenue, 0);
  const prices = items.map((r) => r.avgSalePrice).filter((p) => p > 0);

  const freq = frequency != null && frequency !== '' ? Number(frequency) : null;
  const cards = supplyCards != null && supplyCards !== '' ? Number(supplyCards) : null;
  const ratio = freq && cards ? freq / cards : null;
  const ratioVerdict =
    ratio == null
      ? null
      : ratio >= thresholds.ratioHigh
        ? 'спрос превышает предложение'
        : ratio >= thresholds.ratioMid
          ? 'умеренный спрос'
          : 'предложение насыщено';

  const notes = [];
  if (topCapped) {
    notes.push('Выдача ограничена ~100 карточками (топ) — метрики ниже относятся к ТОП-выдаче, не ко всей нише.');
  }
  if (ratio == null) {
    notes.push(
      '«Спрос:предложение» не рассчитан: нужны частотность и кол-во карточек по запросу ' +
        '(оба — из Оракула/подсказок Wildbox, в API MPStats их нет). ' +
        'Передайте frequency и supplyCards (NICHE_FREQ / NICHE_SUPPLY / &freq= &supply=).'
    );
  }

  return {
    query,
    period,
    topCount,
    topCapped,
    revenue: round(revenue, 0),
    units: round(units, 0),
    productsWithSales: withSales.length,
    withSalesPct: topCount ? round((withSales.length / topCount) * 100, 1) : 0,
    avgRevenuePerCard: topCount ? round(revenue / topCount, 0) : 0,
    avgRevenuePerActiveCard: withSales.length ? round(revenue / withSales.length, 0) : 0,
    monopolyTop10Pct: revenue ? round((top10 / revenue) * 100, 1) : 0,
    lostRevenue: round(lost, 0),
    medianAvgSalePrice: round(median(prices), 0),
    frequency: freq,
    supplyCards: cards,
    demandSupplyRatio: ratio != null ? round(ratio, 1) : null,
    ratioVerdict,
    // sell-through по ТОП-выдаче запроса (метод Овчинникова) — из реальных продаж/остатков
    sellThrough: sellThrough(items),
    notes,
  };
}

// ============ дополнительные аналитические блоки ============

// Экономика единицы (маржа). Модель подтверждена: комиссия 35,7% от цены без СПП,
// СПП 4%, эквайринг 4,7% + налог 2% + ДРР от цены с СПП, брак 2,5% от себестоимости.
const ECON = { spp: 0.04, commission: 0.357, acquiring: 0.047, tax: 0.02, drrSteady: 0.08, defect: 0.025 };
export function unitEconomics(cost, medianPrice, e = ECON) {
  if (!cost || cost <= 0) return null;
  const A = (1 - e.commission) / (1 - e.spp) - (e.acquiring + e.tax + e.drrSteady); // прибыль на 1 ₽ цены до себестоимости
  const cUnit = cost * (1 + e.defect);
  const profitAt = (P) => A * P - cUnit; // операц. прибыль при цене покупателя P
  const marginAt = (P) => (P > 0 ? (profitAt(P) * (1 - e.spp)) / P : 0); // маржа от цены без СПП
  const priceForMargin = (m) => cUnit / (A - m / (1 - e.spp));
  const breakEven = cUnit / A;
  const marginMed = marginAt(medianPrice);
  return {
    cost,
    medianPrice: round(medianPrice, 0),
    breakEvenPrice: round(breakEven, 0),
    corridorLo: round(priceForMargin(0.25), 0),
    corridorHi: round(priceForMargin(0.30), 0),
    marginAtMedianPct: round(marginMed * 100, 1),
    verdict: marginMed >= 0.25 ? 'маржа проходит' : marginMed > 0 ? 'низкая маржа' : 'убыточно при медианной цене',
  };
}

// Процент выкупа ниши (медиана) — риск возвратов (для одежды критично).
function nicheBuyout(items) {
  const vals = items.map((r) => num(r.buyoutPct)).filter((v) => v > 0);
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return round(vals[Math.floor(vals.length / 2)], 0);
}

// Возраст карточек в топе: доля топ-N (по выручке) моложе 90 и 180 дней.
function topAge(items, today, topN = 100) {
  const top = items.slice(0, topN).filter((r) => r.firstDate);
  if (!top.length) return null;
  const ageDays = (d) => {
    const t = Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(t) ? null : Math.round((today - t) / 86400000);
  };
  const ages = top.map((r) => ageDays(r.firstDate)).filter((v) => v != null);
  if (!ages.length) return null;
  const y90 = ages.filter((a) => a <= 90).length;
  const y180 = ages.filter((a) => a <= 180).length;
  ages.sort((a, b) => a - b);
  return {
    analyzed: ages.length,
    youngPct90: round((y90 / ages.length) * 100, 0),
    youngPct180: round((y180 / ages.length) * 100, 0),
    medianAgeDays: ages[Math.floor(ages.length / 2)],
  };
}

// Недооценённый ценовой сегмент: выручка на карточку по сегментам (не только сумма).
function segmentOpportunity(segments) {
  const segs = segments.filter((s) => s.items > 0 && s.revenue > 0)
    .map((s) => ({
      from: s.minPrice, to: s.maxPrice, items: s.items,
      revenue: round(s.revenue, 0),
      revenuePerCard: round(s.revenue / s.items, 0),
      withSalesPct: s.items ? round((s.itemsWithSells / s.items) * 100, 0) : 0,
    }));
  if (!segs.length) return null;
  const byRevenue = segs.slice().sort((a, b) => b.revenue - a.revenue)[0];
  // «возможность» — высокая выручка на карточку при умеренной конкуренции (мало карточек)
  const medItems = [...segs].map((s) => s.items).sort((a, b) => a - b)[Math.floor(segs.length / 2)];
  const opp = segs.filter((s) => s.items <= medItems)
    .sort((a, b) => b.revenuePerCard - a.revenuePerCard)[0] || byRevenue;
  return { topByRevenue: byRevenue, opportunity: opp, segments: segs };
}

// Реклама и планка контента среди топ-N по выручке.
function adContentBar(items, topN = 50) {
  const top = items.slice(0, topN);
  if (!top.length) return null;
  const med = (arr) => { const s = arr.filter((v) => v > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const withAd = top.filter((r) => r.hasAd).length;
  const cpms = top.filter((r) => r.hasAd && r.searchCpm > 0).map((r) => r.searchCpm);
  return {
    analyzed: top.length,
    adSharePct: round((withAd / top.length) * 100, 0),
    medianCpm: round(med(cpms), 0),
    medianPics: round(med(top.map((r) => r.picsCount)), 0),
    videoSharePct: round((top.filter((r) => r.hasVideo).length / top.length) * 100, 0),
    medianRating: round(med(top.map((r) => r.rating)), 1),
    medianComments: round(med(top.map((r) => r.comments)), 0),
    medianNegativePct: round(med(top.map((r) => r.negativePct)), 0),
  };
}

// Жёсткие риск-флаги — блокеры, которые скоринг сам по себе может «замазать».
function riskFlags({ competition, saturation, trend, buyout, econ }) {
  const f = [];
  if (competition.monopolyPct >= 40) f.push({ level: 'stop', text: `Высокая монополизация ${round(competition.monopolyPct)}% — вход требует большого бюджета` });
  if (saturation.sellThroughRatio != null && saturation.sellThroughRatio < 0.8) f.push({ level: 'stop', text: `Затоварка: реализация ${saturation.sellThroughRatio}× (склады переполнены)` });
  if (competition.medianTopComments > 5000) f.push({ level: 'warn', text: `Высокий барьер по отзывам: медиана у топ-20 = ${competition.medianTopComments}` });
  if (buyout != null && buyout < 30) f.push({ level: 'warn', text: `Низкий выкуп ${buyout}% — высокие возвраты` });
  if (trend && trend.direction === 'down') f.push({ level: 'warn', text: `Нисходящий тренд ${trend.growthPct}% г/г` });
  if (econ && econ.marginAtMedianPct < 0) f.push({ level: 'stop', text: `Убыточно при медианной цене ниши (маржа ${econ.marginAtMedianPct}%)` });
  return f;
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
  thresholds = THRESHOLDS,
  secondary = true,
  query = null,
  frequency = null,
  supplyCards = null,
  queries = null, // список уточняющих фраз: [{phrase,frequency,supplyCards}]
  cost = null, // себестоимость единицы (для экономики/маржи)
  today = Date.now(),
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

  // Ценовые сегменты покрывают всю нишу → берём ёмкость/насыщенность из них
  // (иначе при усечении выгрузки top-N даёт смещение: % с продажами → 100%,
  //  выручка занижена на «хвост»). Fallback — агрегаты по выгруженным товарам.
  const segments = normalizeSegments(priceSegments);
  const nicheWide = segments.length ? aggregateSegments(segments) : null;
  const dataBasis = nicheWide ? 'niche' : 'analyzed'; // источник ёмкости/насыщенности

  const analyzedRevenue = t.totalRevenue; // сумма по выгруженным top-N (для сверки)
  const totalRevenue = nicheWide ? nicheWide.revenue : t.totalRevenue;
  const totalUnits = nicheWide ? nicheWide.sales : t.totalUnits;
  const lostRevenue = nicheWide
    ? nicheWide.lostProfit
    : round(base.items.reduce((s, r) => s + num(r.lostProfit), 0), 0);
  const productsWithSales = nicheWide ? nicheWide.withSales : t.productsWithSales;
  const withSalesPct = nicheWide ? nicheWide.withSalesPct : t.withSalesPct;
  const productsBasis = nicheWide ? nicheWide.products : t.productsAnalyzed;

  if (t.truncated && !nicheWide) {
    notes.push(
      'Ниша выгружена не полностью, а ценовые сегменты недоступны — ёмкость и ' +
        'насыщенность посчитаны по top-N (возможно смещение: % с продажами завышен).'
    );
  }

  const capacity = {
    productsInNiche: t.productsInNiche,
    productsAnalyzed: t.productsAnalyzed,
    truncated: t.truncated,
    dataBasis, // 'niche' (по ценовым сегментам) | 'analyzed' (по выгруженным top-N)
    totalRevenue,
    totalUnits,
    analyzedRevenue,
    avgRevenuePerProduct: productsBasis ? round(totalRevenue / productsBasis, 0) : 0,
    avgRevenuePerActiveProduct: productsWithSales ? round(totalRevenue / productsWithSales, 0) : 0,
    medianPrice: t.medianPrice,
    avgPrice: t.avgPrice,
    lostRevenue,
  };

  // Тренд и сезонность из помесячной истории trends (endpoint отдаёт ~6 лет
  // вне зависимости от периода запроса, поэтому доступны на любом прогоне).
  const trend = computeTrend(trendRows, thresholds.trend);
  const seasonality = computeSeasonality(trendRows, thresholds.seasonality);

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

  // Sell-through ниши (метод Овчинникова): продажи ÷ остатки за период.
  const nicheSellThrough = sellThrough(base.items);

  // Насыщенность (по всей нише, если есть ценовые сегменты)
  const saturation = {
    dataBasis,
    withSalesPct,
    productsWithSales,
    productsNoSales: productsBasis - productsWithSales,
    productsBasis,
    sellThroughRatio: nicheSellThrough.ratio, // продажи/остаток (>1 — распродают быстрее склада)
    medianTurnoverDays: nicheSellThrough.medianTurnoverDays,
  };
  // Фаза 2: насыщенность по поисковым (уточняющим) фразам.
  // Источник фраз: список queries либо одиночные query/frequency/supplyCards.
  const qList = (queries && queries.length ? parseQueries(queries) : []).concat(
    query && String(query).trim() ? [{ phrase: String(query).trim(), frequency, supplyCards }] : []
  );
  const queryDemands = [];
  for (const q of qList) {
    try {
      queryDemands.push(
        await buildQueryDemand(q.phrase, {
          d1,
          d2,
          frequency: q.frequency,
          supplyCards: q.supplyCards,
          thresholds: thresholds.queryDemand,
        })
      );
    } catch (err) {
      notes.push(`queryDemand[${q.phrase.slice(0, 30)}]: ${String(err?.message || err).split(':')[0]}`);
    }
  }
  if (!qList.length) {
    notes.push(
      'Для блока насыщенности «по запросу» передайте уточняющие фразы ' +
        '(query/queries; NICHE_QUERY, напр. «тёплая=4569:4471; фланелевая=2086:2966»).'
    );
  }
  // queryDemand (одиночный) — для обратной совместимости = первая фраза.
  const queryDemand = queryDemands[0] || null;

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

  // Дополнительные блоки для точного решения.
  const economics = unitEconomics(cost != null ? Number(cost) : null, t.medianPrice);
  const buyout = nicheBuyout(base.items);
  const topAges = topAge(base.items, today);
  const priceOpportunity = segmentOpportunity(segments);
  const adContent = adContentBar(base.items);
  const flags = riskFlags({ competition, saturation, trend, buyout, econ: economics });

  const conclusion = buildConclusion({
    verdict, total, bottleneck: BLOCK_TITLES[bottleneckKey], days,
    capacity, competition, saturation, trend, seasonality, nicheSellThrough, queryDemands,
    economics, buyout, topAges, priceOpportunity, flags,
  });

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
    sellThrough: nicheSellThrough,
    economics,
    buyout,
    topAges,
    priceOpportunity,
    adContent,
    riskFlags: flags,
    queryDemand,
    queryDemands,
    priceSegments: segments,
    sellers: base.sellers,
    brands: base.brands,
    items: base.items,
    conclusion,
    notes,
  };
}

// Строит заключение о целесообразности входа — на конкретных цифрах, без повторов.
function buildConclusion(x) {
  const k = 30 / (x.days || 30);
  const revMonth = x.capacity.totalRevenue * k;
  const money = (v) => (Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + ' млрд' : Math.round(v / 1e6) + ' млн');
  const pts = [];
  // Ёмкость
  pts.push({
    tone: revMonth >= 10e6 ? 'good' : revMonth >= 3e6 ? 'mid' : 'bad',
    text: `Ёмкость ${money(revMonth)} ₽/мес; на «живой» товар ${Math.round((x.capacity.avgRevenuePerActiveProduct * k) / 1000)} тыс ₽/мес.`,
  });
  // Реализация остатка (Овчинников)
  if (x.nicheSellThrough.ratio != null) {
    const r = x.nicheSellThrough.ratio;
    pts.push({
      tone: r >= 1.5 ? 'good' : r >= 0.8 ? 'mid' : 'bad',
      text: `Реализация ${r}× (оборот ${x.nicheSellThrough.medianTurnoverDays} дн.): ${r >= 1.5 ? 'спрос обгоняет остатки — дефицитный, выгодный период' : r >= 0.8 ? 'спрос ≈ предложению' : 'склады переполнены'}.`,
    });
  }
  // Конкуренция
  pts.push({
    tone: x.competition.monopolyPct <= 15 ? 'good' : x.competition.monopolyPct < 40 ? 'mid' : 'bad',
    text: `Монополизация топ-10 = ${round(x.competition.monopolyPct)}% (${x.competition.monopolyPct <= 15 ? 'вход открыт' : x.competition.monopolyPct < 40 ? 'умеренная' : 'высокая'}).`,
  });
  // Экономика (маржа)
  if (x.economics) pts.push({
    tone: x.economics.marginAtMedianPct >= 25 ? 'good' : x.economics.marginAtMedianPct > 0 ? 'mid' : 'bad',
    text: `Маржа при медианной цене ${x.economics.medianPrice} ₽ = ${x.economics.marginAtMedianPct}% (${x.economics.verdict}); выгодный коридор ${x.economics.corridorLo}–${x.economics.corridorHi} ₽.`,
  });
  // Тренд
  if (x.trend) pts.push({
    tone: x.trend.direction === 'up' ? 'good' : x.trend.direction === 'down' ? 'bad' : 'mid',
    text: `Тренд ${x.trend.growthPct > 0 ? '+' : ''}${x.trend.growthPct}% г/г${x.trend.recentYoyPct != null ? ` (3 мес ${x.trend.recentYoyPct > 0 ? '+' : ''}${x.trend.recentYoyPct}%)` : ''}.`,
  });
  // Выкуп и возраст топа (риск и проходимость новичка)
  if (x.buyout != null) pts.push({
    tone: x.buyout >= 40 ? 'good' : x.buyout >= 30 ? 'mid' : 'bad',
    text: `Выкуп ${x.buyout}%${x.topAges ? `; новых карточек в топе ${x.topAges.youngPct90}% (моложе 90 дн.)` : ''}.`,
  });
  // Сезонность
  if (x.seasonality?.sufficient) pts.push({
    tone: 'mid',
    text: `Сезонность ${x.seasonality.level}: пик — мес ${x.seasonality.peakMonth}, окно входа ≈ мес ${x.seasonality.entryMonth}.`,
  });
  // Недооценённый ценовой сегмент
  if (x.priceOpportunity?.opportunity) {
    const o = x.priceOpportunity.opportunity;
    pts.push({ tone: 'good', text: `Перспективный сегмент цены ${o.from}–${o.to} ₽: ${Math.round(o.revenuePerCard / 1000)} тыс ₽ на карточку при ${o.items} конкурентах.` });
  }
  // Лучшая под-фраза по реализации
  const withSt = (x.queryDemands || []).filter((q) => q.sellThrough?.ratio != null);
  if (withSt.length) {
    const best = withSt.slice().sort((a, b) => b.sellThrough.ratio - a.sellThrough.ratio)[0];
    pts.push({ tone: best.sellThrough.ratio >= 1.5 ? 'good' : 'mid', text: `Точка входа: «${best.query}» — реализация ${best.sellThrough.ratio}× (оборот ${best.sellThrough.medianTurnoverDays} дн.).` });
  }

  // Жёсткие стопы понижают вердикт.
  const stops = (x.flags || []).filter((f) => f.level === 'stop');
  let verdict = x.verdict;
  if (stops.length && verdict === 'Заходить') verdict = 'Заходить осторожно';
  const recommendation = stops.length
    ? `Есть блокеры (${stops.length}): ${stops.map((f) => f.text).join('; ')}. Взвесить перед входом.`
    : verdict === 'Заходить'
      ? 'Ниша пригодна для входа; отстройка — по контенту/цене и выбранной под-фразе.'
      : verdict === 'Заходить осторожно'
        ? 'Вход возможен при чётком преимуществе; следить за узким местом.'
        : 'Вход нецелесообразен по совокупности метрик.';

  return { verdict, total: x.total, bottleneck: x.bottleneck, points: pts, recommendation, flags: x.flags || [] };
}
