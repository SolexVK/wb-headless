// lib/diagonalScan.js — «диагональное сканирование» карточки (конкурентный анализ
// по методике гл.04): по ключевому запросу берём выдачу WB, находим позицию своей
// карточки и реальных конкурентов над ней, считаем гэпы по цене/рейтингу/отзывам/
// размерному ряду и формируем план доработки.

// Цена товара из выдачи search v9 (структура sizes[].price.{total|product} в копейках).
function priceOf(pr) {
  const s = (pr.sizes || []).find((x) => x.price) || {};
  const p = s.price || {};
  const kop = p.total ?? p.product ?? p.basic ?? 0;
  return kop ? Math.round(kop / 100) : 0;
}
const sizeCountOf = (pr) => (pr.sizes || []).filter((s) => s.name || s.origName).length;

async function fetchJsonRetry(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (_) { /* retry */ }
    await new Promise((res) => setTimeout(res, 350 * (i + 1)));
  }
  return null;
}

// Выдача WB по запросу (до pages страниц) → нормализованные карточки.
export async function searchProducts(query, pages = 2) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://search.wb.ru/exactmatch/ru/common/v9/search?appType=1&curr=rub&dest=-1257786&query=${encodeURIComponent(query)}&resultset=catalog&sort=popular&spp=30&page=${p}`;
    const j = await fetchJsonRetry(url);
    const prods = j?.data?.products || j?.products || [];
    if (!prods.length) break;
    for (const pr of prods) {
      out.push({
        sku: pr.id, brand: pr.brand || '', name: pr.name || '',
        rating: Number(pr.reviewRating || pr.rating || 0) || 0,
        reviews: Number(pr.feedbacks || 0) || 0,
        price: priceOf(pr), sizeCount: sizeCountOf(pr),
        supplierId: pr.supplierId || null,
        url: `https://www.wildberries.ru/catalog/${pr.id}/detail.aspx`,
      });
    }
  }
  return out;
}

/**
 * Диагональное сканирование одной карточки.
 * @param {object} o
 * @param {number} o.sku — свой артикул
 * @param {string} o.query — ключевой запрос (из имени карточки)
 * @param {object} o.own — свои метрики {brand, price, rating, reviews, sizeCount}
 */
export async function scanArticle({ sku, query, own = {} }) {
  const results = await searchProducts(query, 2);
  const ownRank = results.findIndex((r) => Number(r.sku) === Number(sku));
  // Свои метрики: из выдачи (если нашли) либо из переданных own.
  const self = ownRank >= 0 ? { ...results[ownRank], ...own } : { sku, ...own };

  // Реальные конкуренты: карточки выдачи (кроме своей и однобрендовых дублей),
  // ранжированные по силе (число отзывов) — топ выдачи забит новыми пустышками.
  const ownBrand = (own.brand || '').toLowerCase();
  const seenBrand = new Set();
  const competitors = results
    .filter((r) => Number(r.sku) !== Number(sku) && r.reviews >= 50 && (r.brand || '').toLowerCase() !== ownBrand)
    .sort((a, b) => b.reviews - a.reviews)
    .filter((r) => { const k = (r.brand || '').toLowerCase(); if (seenBrand.has(k)) return false; seenBrand.add(k); return true; })
    .slice(0, 6);

  // Медианы конкурентов для гэпов.
  const med = (arr) => { const a = arr.filter((x) => x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const cMedPrice = med(competitors.map((c) => c.price));
  const cMedRating = med(competitors.map((c) => c.rating));
  const cMedReviews = med(competitors.map((c) => c.reviews));
  const cMedSizes = med(competitors.map((c) => c.sizeCount));

  const gaps = [];
  if (self.reviews && cMedReviews && self.reviews < cMedReviews * 0.7)
    gaps.push({ kind: 'reviews', text: `Мало отзывов: ${self.reviews} против медианы конкурентов ${cMedReviews} — наращивать отзывы (склейка/купон-гарантия).` });
  if (self.rating && cMedRating && self.rating < cMedRating - 0.05)
    gaps.push({ kind: 'rating', text: `Рейтинг ${self.rating} ниже конкурентов (${cMedRating}) — разобрать негатив, поднять качество/контроль.` });
  if (self.price && cMedPrice) {
    const diff = Math.round(((self.price - cMedPrice) / cMedPrice) * 100);
    if (Math.abs(diff) >= 12) gaps.push({ kind: 'price', text: `Цена ${self.price} ₽ ${diff > 0 ? 'выше' : 'ниже'} медианы конкурентов (${cMedPrice} ₽) на ${Math.abs(diff)}% — проверить ценовое позиционирование.` });
  }
  if (self.sizeCount && cMedSizes && self.sizeCount < cMedSizes)
    gaps.push({ kind: 'sizes', text: `Размерный ряд уже: ${self.sizeCount} против ${cMedSizes} у конкурентов — расширить сетку.` });
  if (ownRank < 0)
    gaps.push({ kind: 'visibility', text: `Карточка не входит в топ выдачи по запросу «${query}» — слабая принадлежность/SEO: усилить смыслы запроса в листинге и первом фото.` });

  return {
    query,
    ownRank: ownRank >= 0 ? ownRank + 1 : null,
    self: { price: self.price || own.price || 0, rating: self.rating || own.rating || 0, reviews: self.reviews || own.reviews || 0, sizeCount: self.sizeCount || own.sizeCount || 0 },
    competitors,
    competitorMedians: { price: cMedPrice, rating: cMedRating, reviews: cMedReviews, sizeCount: cMedSizes },
    gaps,
  };
}
