// lib/newProductsAnalysis.js — анализ товаров-новинок по поисковому запросу WB.
//
// Идея: по ключевому запросу берём топ-выдачу MPStats (эндпоинт
// /analytics/v1/wb/search/items, до 100 карточек — это и есть «ниша по запросу»),
// вычленяем НОВИНКИ (карточки, вышедшие на WB за окно `newWithinDays`) и считаем
// по ним четыре среза, которые попросил пользователь:
//   1. Продажи (sales/revenue/выкуп, динамика выхода)
//   2. Листинг (контент карточки: фото/видео/3D/описание/SEO-ядро) + бенчмарк ниши
//   3. Визуальная воронка (видимость → позиция/клик → заказ → выкуп по модели WB)
//   4. Конкурентный анализ (доли, концентрация, ценовые сегменты, планка входа)
//
// Все метрики оценочные (MPStats восстанавливает продажи по остаткам/выкупам).

import { fetchSearchResults, fetchItemDailySales } from './mpstats.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const str = (v) => (v == null ? '' : String(v).trim());

// ---- утилиты статистики ----
export function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function sum(arr) {
  return arr.reduce((s, x) => s + (Number(x) || 0), 0);
}
const round = (v, d = 0) => {
  const k = 10 ** d;
  return Math.round((Number(v) || 0) * k) / k;
};

// Приводит сырую строку выдачи MPStats к рабочему виду.
export function normalizeCard(row) {
  return {
    sku: row.id ?? row.nmId ?? row.itemid ?? null,
    name: str(row.name),
    brand: str(row.brand),
    seller: str(row.seller),
    supplierId: row.supplier_id ?? null,
    subject: str(row.subject),
    category: str(row.category),
    gender: str(row.gender),
    color: str(row.color),
    url: str(row.url),
    // возраст карточки
    firstDate: str(row.sku_first_date),
    daysInSite: num(row.days_in_site),
    daysInStock: num(row.days_in_stock),
    // цена
    price: num(row.final_price),
    priceAvg: num(row.final_price_average),
    basicPrice: num(row.basic_price),
    startPrice: num(row.start_price),
    // продажи / выручка
    sales: num(row.sales),
    salesPerDay: num(row.sales_per_day_average),
    salesEstimated: num(row.sales_estimated),
    revenue: num(row.revenue),
    revenuePotential: num(row.revenue_potential),
    lostProfit: num(row.lost_profit),
    lostProfitPct: num(row.lost_profit_percent),
    // выкуп (ключ воронки)
    buyout: num(row.purchase),
    buyoutAfterReturn: num(row.purchase_after_return),
    // остатки / ассортимент
    balance: num(row.balance),
    turnoverDays: num(row.turnover_days),
    warehouses: num(row.warehouses_count),
    sizeCount: num(row.size_count),
    sizeInStock: num(row.size_count_in_stock),
    // отзывы / рейтинг
    rating: num(row.rating),
    comments: num(row.comments),
    commentsForPeriod: num(row.comments_for_period),
    negativePct: num(row.latest_negative_comments_percent),
    salesPerComment: num(row.sales_per_comments),
    // ЛИСТИНГ / визуал
    pics: num(row.picscount),
    hasVideo: num(row.hasvideo) > 0 ? 1 : 0,
    has3d: num(row.has3d) > 0 ? 1 : 0,
    descriptionLength: num(row.description_length),
    nameLength: num(row.name_length),
    // SEO / видимость (верх воронки)
    searchWords: num(row.search_words_count),
    searchVisibility: num(row.search_visibility),
    categoryVisibility: num(row.category_visibility),
    searchPosAvg: num(row.search_position_avg),
    searchOrganicPosAvg: num(row.search_organic_position_avg),
    searchAdPosAvg: num(row.search_ad_position_avg),
    searchCpm: num(row.search_cpm_avg),
    hasAd: num(row.ext_advertising) > 0 ? 1 : 0,
    // дневные ряды — для траектории выхода новинки
    salesGraph: Array.isArray(row.sales_graph) ? row.sales_graph.map(num) : null,
    revenueGraph: Array.isArray(row.revenue_graph) ? row.revenue_graph.map(num) : null,
  };
}

// Индекс Херфиндаля–Хиршмана (0..1) по долям — концентрация рынка.
function hhi(shares) {
  return round(sum(shares.map((s) => s * s)), 4);
}

// Группировка по ключу с суммой выручки/продаж и числом карточек.
function groupBy(cards, keyFn) {
  const m = new Map();
  for (const c of cards) {
    const k = keyFn(c) || '(не указан)';
    const g = m.get(k) || { key: k, cards: 0, revenue: 0, sales: 0, skus: [] };
    g.cards += 1;
    g.revenue += c.revenue;
    g.sales += c.sales;
    g.skus.push(c.sku);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.revenue - a.revenue);
}

// Ценовые сегменты по квартилям цен ниши.
function priceSegments(cards) {
  const prices = cards.map((c) => c.price).filter((p) => p > 0);
  if (!prices.length) return [];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const step = (max - min) / 4 || 1;
  const bins = [0, 1, 2, 3].map((i) => ({
    from: round(min + i * step),
    to: round(min + (i + 1) * step),
    cards: 0,
    revenue: 0,
    sales: 0,
  }));
  for (const c of cards) {
    if (c.price <= 0) continue;
    let idx = Math.floor((c.price - min) / step);
    if (idx > 3) idx = 3;
    if (idx < 0) idx = 0;
    bins[idx].cards += 1;
    bins[idx].revenue += c.revenue;
    bins[idx].sales += c.sales;
  }
  return bins;
}

// Контентный бенчмарк ниши: медианы по топ-N карточкам (планка входа).
function listingBenchmark(cards) {
  return {
    pics: round(median(cards.map((c) => c.pics)), 1),
    hasVideoShare: round((sum(cards.map((c) => c.hasVideo)) / cards.length) * 100),
    has3dShare: round((sum(cards.map((c) => c.has3d)) / cards.length) * 100),
    descriptionLength: round(median(cards.map((c) => c.descriptionLength))),
    searchWords: round(median(cards.map((c) => c.searchWords))),
    rating: round(median(cards.map((c) => c.rating)), 2),
    comments: round(median(cards.map((c) => c.comments))),
    price: round(median(cards.map((c) => c.price))),
    buyout: round(median(cards.map((c) => c.buyout).filter((x) => x > 0))),
  };
}

// Модель воронки WB (KB 01): клик +25%, корзина 0%, заказ +25%, выкуп +50%.
// «Визуальная воронка» новинки: видимость → позиция(клик) → заказ → выкуп.
function funnelForCard(c) {
  return {
    sku: c.sku,
    name: c.name,
    // ВЕРХ: показы/видимость по запросу и в категории
    searchVisibility: c.searchVisibility,
    categoryVisibility: c.categoryVisibility,
    // КЛИК: позиция в выдаче (чем ниже число — тем выше и вероятнее клик)
    searchPosAvg: c.searchPosAvg,
    organicPos: c.searchOrganicPosAvg,
    adPos: c.searchAdPosAvg,
    onAd: c.hasAd,
    // визуал, влияющий на CTR
    pics: c.pics,
    hasVideo: c.hasVideo,
    rating: c.rating,
    // ЗАКАЗ: продажи за период и в день
    sales: c.sales,
    salesPerDay: c.salesPerDay,
    // ВЫКУП: главный фактор фиксации позиции
    buyout: c.buyout,
    // экономика
    revenue: c.revenue,
    lostProfitPct: c.lostProfitPct,
  };
}

/**
 * Полный анализ одного запроса.
 * @param {string} query поисковый запрос
 * @param {{d1?:string,d2?:string,newWithinDays?:number,topN?:number}} opts
 */
export async function analyzeQuery(query, opts = {}) {
  const { newWithinDays = 60, topN = 100, dailyForTop = 8 } = opts;
  const res = await fetchSearchResults(query, {
    d1: opts.d1,
    d2: opts.d2,
    maxRows: topN,
    pageSize: Math.min(topN, 100),
  });
  const period = res.period;
  // Порог новинки: d2 минус newWithinDays.
  const d2ms = new Date(`${period.d2}T00:00:00Z`).getTime();
  const cutoff = new Date(d2ms - newWithinDays * 86400000).toISOString().slice(0, 10);

  const all = res.rows.map(normalizeCard).filter((c) => c.sku);
  const withSales = all.filter((c) => c.sales > 0);
  const news = all
    .filter((c) => c.firstDate && c.firstDate >= cutoff)
    .sort((a, b) => b.revenue - a.revenue);
  const established = all.filter((c) => !(c.firstDate && c.firstDate >= cutoff));

  const nicheRevenue = sum(all.map((c) => c.revenue));
  const nicheSales = sum(all.map((c) => c.sales));

  // Доли новинок в нише.
  const newsRevenue = sum(news.map((c) => c.revenue));
  const newsSales = sum(news.map((c) => c.sales));

  // Конкуренция: продавцы, бренды, концентрация, ценовые сегменты.
  const sellers = groupBy(all, (c) => c.seller);
  const brands = groupBy(all, (c) => c.brand);
  const sellerShares = sellers.map((s) => (nicheRevenue ? s.revenue / nicheRevenue : 0));
  const segments = priceSegments(all);

  // Контентная планка: медианы по топ-20 по выручке.
  const top20 = [...all].sort((a, b) => b.revenue - a.revenue).slice(0, 20);
  const benchmark = listingBenchmark(top20);
  const newsBenchmark = news.length ? listingBenchmark(news) : null;

  // Дозагрузка дневной траектории для топ-новинок (кривая выхода).
  const trajTargets = news.slice(0, dailyForTop);
  const trajectories = [];
  for (const c of trajTargets) {
    try {
      const daily = await fetchItemDailySales(c.sku, period.d1, period.d2);
      trajectories.push({ sku: c.sku, name: c.name, firstDate: c.firstDate, daily });
    } catch (e) {
      trajectories.push({ sku: c.sku, name: c.name, firstDate: c.firstDate, daily: [], error: String(e.message || e) });
    }
  }

  return {
    query,
    period,
    cutoff,
    newWithinDays,
    counts: {
      total: res.total,
      fetched: all.length,
      withSales: withSales.length,
      news: news.length,
      newsWithSales: news.filter((c) => c.sales > 0).length,
      established: established.length,
    },
    niche: {
      revenue: round(nicheRevenue),
      sales: nicheSales,
      medianPrice: round(median(all.map((c) => c.price).filter((p) => p > 0))),
      avgRating: round(median(all.map((c) => c.rating).filter((r) => r > 0)), 2),
      sellers: sellers.length,
      brands: brands.length,
      hhiSellers: hhi(sellerShares),
      medianBuyout: round(median(all.map((c) => c.buyout).filter((x) => x > 0))),
    },
    newsShare: {
      revenue: round(newsRevenue),
      revenuePct: round(nicheRevenue ? (newsRevenue / nicheRevenue) * 100 : 0, 1),
      sales: newsSales,
      salesPct: round(nicheSales ? (newsSales / nicheSales) * 100 : 0, 1),
      countPct: round(all.length ? (news.length / all.length) * 100 : 0, 1),
    },
    news, // полный список новинок (нормализованные карточки)
    funnel: news.map(funnelForCard),
    benchmark,
    newsBenchmark,
    competition: {
      topSellers: sellers.slice(0, 10),
      topBrands: brands.slice(0, 10),
      segments,
      topByRevenue: [...all].sort((a, b) => b.revenue - a.revenue).slice(0, 12),
    },
    trajectories,
  };
}

export async function analyzeQueries(queries, opts = {}) {
  const out = [];
  for (const q of queries) {
    out.push(await analyzeQuery(q, opts));
  }
  return out;
}
