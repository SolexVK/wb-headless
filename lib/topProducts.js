// lib/topProducts.js — сборка данных «Топ-N товаров» по категории WB за период.
// Отбирает лидеров по выручке среди карточек, чьё название проходит фильтр
// (plus — все корни присутствуют, minus — ни одного), обогащает фото (data-URI),
// ссылкой, брендом, остатками (FBO/FBS/склады/заморозка) и рядами динамики.
import { fetchCategory } from './mpstats.js';

// Совпадение слова-стема: любое слово названия начинается со стема.
function nameMatches(name, stems) {
  const words = String(name).toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(Boolean);
  return stems.every((st) => words.some((w) => w.startsWith(st)));
}
function nameMatchesAny(name, stems) {
  if (!stems.length) return false;
  const words = String(name).toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(Boolean);
  return stems.some((st) => words.some((w) => w.startsWith(st)));
}

const stems = (s) =>
  String(s || '')
    .toLowerCase()
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// Скачивает картинку WB (пробует несколько URL-кандидатов) → data-URI или ''.
async function fetchOne(url) {
  if (!url) return '';
  const abs = url.startsWith('//') ? 'https:' + url : url;
  try {
    const r = await fetch(abs);
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || 'image/webp';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return '';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  }
}
async function toDataUri(candidates) {
  for (const u of candidates.filter(Boolean)) {
    const d = await fetchOne(u);
    if (d) return d;
  }
  return '';
}

/**
 * @param {object} o
 * @param {string} o.categoryPath — путь категории WB
 * @param {string} o.d1,o.d2 — период
 * @param {string} o.plus — корни, ВСЕ обязаны быть в названии (через запятую)
 * @param {string} o.minus — корни, ни одного не должно быть
 * @param {number} o.topN — сколько товаров вернуть
 * @param {number} o.maxRows — сколько строк категории выгружать
 * @param {boolean} o.withImages — качать ли фото в data-URI (по умолч. да)
 */
export async function buildTopProducts({
  categoryPath,
  d1,
  d2,
  plus = '',
  minus = '',
  topN = 10,
  maxRows = 5000,
  withImages = true,
  onProgress,
} = {}) {
  const P = stems(plus);
  const M = stems(minus);
  const { items, total } = await fetchCategory(categoryPath, d1, d2, { maxRows, pageSize: 500 });

  const matched = items.filter(
    (it) => (!P.length || nameMatches(it.name, P)) && !(M.length && nameMatchesAny(it.name, M))
  );
  const ranked = matched.sort((a, b) => b.revenue - a.revenue).slice(0, topN);

  // Обогащаем фото (последовательно, чтобы не давить на CDN).
  const products = [];
  for (let i = 0; i < ranked.length; i++) {
    const it = ranked[i];
    const img = withImages ? await toDataUri([it.thumbMiddle, it.thumb]) : '';
    products.push({
      rank: i + 1,
      sku: it.sku,
      name: it.name,
      brand: it.brand,
      seller: it.seller,
      supplierId: it.supplierId,
      url: it.url,
      color: it.color,
      img,
      revenue: it.revenue,
      units: it.units,
      price: it.price,
      rating: it.rating,
      comments: it.comments,
      balance: it.balance,
      avgStock: it.avgStock,
      balanceFbs: it.balanceFbs,
      balanceFbo: Math.max(0, (it.balance || 0) - (it.balanceFbs || 0)),
      warehousesCount: it.warehousesCount,
      frozenPct: it.frozenPct,
      turnoverDays: it.turnoverDays,
      salesPerDay: it.salesPerDay,
      revenueGraph: it.revenueGraph || [],
      stocksGraph: it.stocksGraph || [],
      priceGraph: it.priceGraph || [],
      salesGraph: it.salesGraph || [],
    });
    if (onProgress) onProgress(i + 1, ranked.length);
  }

  // Сводка по выборке.
  const sum = (f) => products.reduce((s, p) => s + (f(p) || 0), 0);
  const summary = {
    categoryPath,
    d1,
    d2,
    days: daysBetween(d1, d2),
    totalInCategory: total,
    matchedCount: matched.length,
    shown: products.length,
    revenueSum: sum((p) => p.revenue),
    unitsSum: sum((p) => p.units),
    stockSum: sum((p) => p.balance),
    avgPrice: products.length ? Math.round(sum((p) => p.price) / products.length) : 0,
    plus: P,
    minus: M,
    // сколько уникальных брендов в топе и лидер по выручке
    brands: [...new Set(products.map((p) => p.brand).filter(Boolean))],
  };

  return { products, summary };
}

function daysBetween(d1, d2) {
  const a = new Date(d1 + 'T00:00:00Z');
  const b = new Date(d2 + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
