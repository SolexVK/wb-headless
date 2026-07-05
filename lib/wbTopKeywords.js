// lib/wbTopKeywords.js — инструмент [1] каскада: «ТОП-N по ключевому запросу».
//
// Идея: по ключевому слову берём поисковую выдачу Wildberries из MPSTATS,
// нормализуем к общему контракту, фильтруем по правилам («уточнения») и
// отдаём топ-N конкурентов для следующего этапа («Сравнение карточек»).
//
// Выход — контракт top-rivals (см. docs/pipeline/README.md):
//   { query, source:'mpstats', filters, rivals: [{ nmId, name, brand, price,
//     rating, reviews, sales, revenue, position }] }
//
// Массив rivals пригоден для пайпа в scripts/wb-cards-compare.mjs (он принимает
// JSON-массив nmId из stdin) — т.е. каскад [1] → [2] сцепляется напрямую.
//
// Транспорт (сам HTTP к MPSTATS) — в lib/mpstats.js (fetchSearchResults).
// Здесь только чистая логика: нормализация строки, фильтр, сортировка, выбор
// топ-N. Её можно тестировать без сети/токена (см. normalizeSearchRow /
// selectTopRivals — экспортируются отдельно именно для этого).

import { fetchSearchResults } from './mpstats.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

/**
 * Приводит одну строку поисковой выдачи MPSTATS к контракту top-rivals.
 * MPSTATS в разных отчётах/версиях зовёт поля по-разному — читаем через
 * несколько возможных ключей (как и normalizeDailyRow в mpstats.js).
 * @param {object} row  сырая строка ответа MPSTATS
 * @param {number} idx  порядковый индекс в выдаче (fallback для позиции)
 */
export function normalizeSearchRow(row = {}, idx = 0) {
  const nmRaw = row.id ?? row.nmId ?? row.nm_id ?? row.sku ?? row.nm ?? null;
  return {
    nmId: nmRaw == null ? null : String(nmRaw),
    name: row.name ?? row.title ?? null,
    brand: row.brand ?? row.brand_name ?? null,
    price: num(row.final_price ?? row.price ?? row.client_price ?? row.priceFull),
    rating: num(row.rating ?? row.stars ?? row.valuation ?? row.reviewRating),
    reviews: num(row.comments ?? row.reviews ?? row.feedbacks ?? row.review_count),
    sales: num(row.sales ?? row.sold ?? row.orders ?? row.sale),
    revenue: num(row.revenue ?? row.turnover ?? row.sales_sum),
    // позиция в выдаче: явное поле или 1-based индекс строки
    position: Number(row.position ?? row.pos ?? row.place ?? idx + 1) || idx + 1,
  };
}

/**
 * Фильтрует и ранжирует нормализованные строки, отдаёт топ-N.
 * Чистая функция — без сети. Именно сюда ложатся «уточнения и фильтрация».
 *
 * @param {Array} rows  нормализованные строки (см. normalizeSearchRow)
 * @param {object} opts
 *   topN         сколько отдать (по умолчанию 10)
 *   excludeNmIds исключить артикулы (обычно наш — чтобы не сравнивать с собой)
 *   excludeBrands исключить бренды (регистронезависимо)
 *   minRevenue/minRating/minReviews/minSales  нижние пороги
 *   priceMin/priceMax  ценовой коридор
 *   sortBy       'position'|'revenue'|'sales'|'rating' (как ранжируем топ)
 */
export function selectTopRivals(rows = [], opts = {}) {
  const {
    topN = 10,
    excludeNmIds = [],
    excludeBrands = [],
    minRevenue,
    minRating,
    minReviews,
    minSales,
    priceMin,
    priceMax,
    sortBy = 'position',
  } = opts;

  const exNm = new Set(excludeNmIds.map((v) => String(v)));
  const exBrand = new Set(excludeBrands.map((b) => String(b).toLowerCase()));

  const passed = rows.filter((r) => {
    if (r == null || r.nmId == null) return false;
    if (exNm.has(String(r.nmId))) return false;
    if (exBrand.size && r.brand && exBrand.has(String(r.brand).toLowerCase())) return false;
    if (minRevenue != null && r.revenue < minRevenue) return false;
    if (minRating != null && r.rating < minRating) return false;
    if (minReviews != null && r.reviews < minReviews) return false;
    if (minSales != null && r.sales < minSales) return false;
    if (priceMin != null && r.price < priceMin) return false;
    if (priceMax != null && r.price > priceMax) return false;
    return true;
  });

  // position: меньше = лучше (выше в выдаче). Остальные метрики: больше = лучше.
  const dir = sortBy === 'position' ? 1 : -1;
  const rankKey = (r) => {
    switch (sortBy) {
      case 'revenue': return r.revenue;
      case 'sales': return r.sales;
      case 'rating': return r.rating;
      case 'position':
      default: return r.position ?? Number.MAX_SAFE_INTEGER;
    }
  };
  passed.sort((a, b) => (rankKey(a) - rankKey(b)) * dir);

  return passed.slice(0, Math.max(0, topN));
}

/**
 * Полный этап [1]: запрос → выдача MPSTATS → нормализация → фильтр → топ-N.
 * Требует MPSTATS_TOKEN в окружении (транспорт в lib/mpstats.js).
 *
 * @param {object} p
 *   query    ключевой запрос (обязателен)
 *   topN     сколько конкурентов вернуть (по умолчанию 10)
 *   filters  объект уточнений (см. selectTopRivals)
 *   our      наш артикул — исключаем из выдачи (добавляется к excludeNmIds)
 *   d1,d2    период для метрик выдачи (YYYY-MM-DD), опц.
 *   limit    сколько строк выдачи запросить у MPSTATS (по умолчанию 100)
 * @returns {Promise<{query,source,filters,fetched,rivals}>}
 */
export async function topByKeywords(p = {}) {
  const { query, topN = 10, filters = {}, our, d1, d2, limit = 100 } = p;
  if (!query || !String(query).trim()) {
    throw new Error('topByKeywords: не задан query (ключевой запрос)');
  }

  const raw = await fetchSearchResults(String(query).trim(), { d1, d2, endRow: limit });
  const normalized = raw.map((row, i) => normalizeSearchRow(row, i)).filter((r) => r.nmId);

  const excludeNmIds = [...(filters.excludeNmIds || [])];
  if (our) excludeNmIds.push(String(our));

  const rivals = selectTopRivals(normalized, { ...filters, excludeNmIds, topN });

  return {
    query: String(query).trim(),
    source: 'mpstats',
    filters: { ...filters, excludeNmIds, topN },
    fetched: normalized.length,
    rivals,
  };
}
