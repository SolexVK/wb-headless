// lib/sellerNewProducts.js — топ-10 продавцов и артикулов по запросу +
// новинки этих продавцов за последние N дней (через каталог + фильтр supplier_id).
//
// Логика:
//  1. Топ-выдача MPStats по запросу (search/items) → топ-10 продавцов и топ-10 SKU.
//  2. Для каждого топ-продавца тянем его карточки из базовой категории рубашек
//     (POST /wb/get/category с filterModel по supplier_id, сортировка по дате
//     появления) → карточки с sku_first_date за последние N дней = его новинки.
//     Это ловит новинки, даже если они ещё НЕ попали в топ-выдачу по запросу.

import { fetchSearchResults, fetchCategory } from './mpstats.js';
import {
  normalizeCard, classifyShirt, wbCardUrl, wbSellerUrl, wbBrandSearchUrl, sum, median,
} from './newProductsAnalysis.js';

const round = (v, d = 0) => { const k = 10 ** d; return Math.round((Number(v) || 0) * k) / k; };
const isPlaid = (name) => /клет|shirt.*check|в\s*клетк/i.test(String(name || ''));

// Топ-продавцы и топ-артикулы из выдачи по запросу.
function topsFromSearch(cards, topN = 10) {
  const nicheRevenue = sum(cards.map((c) => c.revenue)) || 1;
  const bySeller = new Map();
  for (const c of cards) {
    const k = c.seller || '(не указан)';
    const g = bySeller.get(k) || { seller: k, supplierId: c.supplierId, brand: c.brand, cards: 0, revenue: 0, sales: 0, _max: -1 };
    g.cards += 1; g.revenue += c.revenue; g.sales += c.sales;
    if (c.revenue > g._max) { g._max = c.revenue; g.supplierId = c.supplierId; g.brand = c.brand; }
    bySeller.set(k, g);
  }
  const topSellers = [...bySeller.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topN)
    .map((g) => ({
      seller: g.seller,
      supplierId: g.supplierId,
      brand: g.brand,
      cardsInTop: g.cards,
      revenue: round(g.revenue),
      sales: g.sales,
      sharePct: round((g.revenue / nicheRevenue) * 100, 1),
      url: wbSellerUrl(g.supplierId),
    }));

  const topArticles = [...cards]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topN)
    .map((c, i) => ({
      rank: i + 1,
      sku: c.sku,
      name: c.name,
      brand: c.brand,
      seller: c.seller,
      supplierId: c.supplierId,
      price: c.price,
      sales: c.sales,
      revenue: c.revenue,
      rating: c.rating,
      comments: c.comments,
      firstDate: c.firstDate,
      cls: c.cls,
      cardUrl: c.cardUrl,
      sellerUrl: wbSellerUrl(c.supplierId),
    }));

  return { topSellers, topArticles, nicheRevenue: round(nicheRevenue) };
}

// Новинки одного продавца в категории рубашек за период [cutoff, d2].
async function sellerNewCards(supplierId, categoryPath, d1, d2, cutoff, { maxRows = 200 } = {}) {
  if (!supplierId) return { total: 0, cards: [] };
  const { items, total } = await fetchCategory(categoryPath, d1, d2, {
    maxRows,
    pageSize: 100,
    filterModel: { supplier_id: { filterType: 'number', type: 'equals', filter: Number(supplierId) } },
    sortColId: 'sku_first_date',
  });
  const news = items
    .filter((c) => c.firstDate && c.firstDate >= cutoff)
    .sort((a, b) => (b.firstDate || '').localeCompare(a.firstDate || '') || b.revenue - a.revenue)
    .map((c) => ({
      sku: c.sku,
      name: c.name,
      firstDate: c.firstDate,
      price: c.price,
      sales: c.units,
      revenue: c.revenue,
      rating: c.rating,
      comments: c.comments,
      pics: c.picsCount,
      hasVideo: c.hasVideo,
      balance: c.balance,
      cls: classifyShirt(c.name),
      isPlaid: isPlaid(c.name),
      cardUrl: wbCardUrl(c.sku),
    }));
  return { totalInCategory: total, news };
}

/**
 * Полный анализ по запросу: топ-10 продавцов, топ-10 артикулов и новинки
 * топ-продавцов за последние newWithinDays дней.
 */
export async function analyzeSellers(query, categoryPath, opts = {}) {
  const { newWithinDays = 60, topN = 10 } = opts;
  const res = await fetchSearchResults(query, { d1: opts.d1, d2: opts.d2, maxRows: 100, pageSize: 100 });
  const period = res.period;
  const d2ms = new Date(`${period.d2}T00:00:00Z`).getTime();
  const cutoff = new Date(d2ms - newWithinDays * 86400000).toISOString().slice(0, 10);

  const cards = res.rows.map(normalizeCard).filter((c) => c.sku);
  const { topSellers, topArticles, nicheRevenue } = topsFromSearch(cards, topN);

  // Новинки каждого топ-продавца (последовательно — щадим лимит MPStats).
  const sellerNews = [];
  for (const s of topSellers) {
    const r = await sellerNewCards(s.supplierId, categoryPath, period.d1, period.d2, cutoff, {});
    sellerNews.push({
      seller: s.seller,
      brand: s.brand,
      supplierId: s.supplierId,
      url: s.url,
      revenue: s.revenue,
      sharePct: s.sharePct,
      cardsInTop: s.cardsInTop,
      totalShirtsInCategory: r.totalInCategory ?? null,
      newCount: r.news.length,
      newPlaidCount: r.news.filter((c) => c.isPlaid).length,
      newRevenue: round(sum(r.news.map((c) => c.revenue))),
      news: r.news,
    });
  }

  return {
    query,
    categoryPath,
    period,
    cutoff,
    newWithinDays,
    nicheRevenue,
    topSellers,
    topArticles,
    sellerNews,
    totals: {
      newProducts: sum(sellerNews.map((s) => s.newCount)),
      newPlaid: sum(sellerNews.map((s) => s.newPlaidCount)),
      newRevenue: round(sum(sellerNews.map((s) => s.newRevenue))),
    },
  };
}

export async function analyzeAll(specs, opts = {}) {
  const out = [];
  for (const s of specs) out.push(await analyzeSellers(s.query, s.category, opts));
  return out;
}
