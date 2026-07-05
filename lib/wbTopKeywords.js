// lib/wbTopKeywords.js — инструмент [1] каскада: «ТОП по ключевой фразе».
//
// Идея: по ключевой фразе берём ВСЮ поисковую выдачу WB из MPSTATS за период,
// нормализуем к общему контракту и прогоняем через двухуровневую фильтрацию:
//   1) первичный отсев: выручка за период < 100 000 ₽ → мусор, выкидываем;
//   2) «глубокие» фильтры по словам в НАЗВАНИИ — группы-признаки (крой/воротник/…):
//        внутри группы ИЛИ, между группами И; плюс общий список исключений;
//      + ИСКЛЮЧЕНИЕ: «безхвостый» сильный артикул (в названии нет ни одного ключа
//        групп и ни одного слова-исключения) остаётся, если его выручка сопоставима
//        с ТОП-20 пула и средняя цена продажи в заданном ценовом интервале;
//   3) метрические фильтры (ценовой интервал по средней цене продажи, рейтинг…);
//   4) сортировка по выручке (убыв.);
//   5) отсечка топ-N (10/100/500) — ПОСЛЕДНИМ шагом, чтобы не потерять артикулы рано.
//
// Выход — контракт top-rivals (см. docs/pipeline/README.md). Массив rivals пригоден
// для пайпа nmId в «Сравнение карточек» ([1]→[2]).
//
// Транспорт (HTTP + пагинация) — в lib/mpstats.js (fetchSearchResults). Здесь только
// чистая логика (normalizeSearchRow / selectTop) — тестируется без сети/токена.

import { fetchSearchResults } from './mpstats.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const REVENUE_FLOOR_DEFAULT = 100000; // ₽ за период — ниже неинтересно
const EXCEPTION_RANK_DEFAULT = 20; // «сопоставимо с ТОП-N» по выручке

/**
 * Приводит одну строку поисковой выдачи MPSTATS к контракту top-rivals.
 * Ключевые поля залочены живым эндпоинтом /analytics/v1/wb/search/items:
 *   id=nmId, final_price=текущая цена, final_price_average=СРЕДНЯЯ ЦЕНА ПРОДАЖИ
 *   (= revenue/sales, проверено), comments=отзывы, lost_profit=упущенная выручка.
 * @param {object} row  сырая строка ответа MPSTATS
 * @param {number} idx  порядковый индекс в выдаче (fallback для позиции)
 */
export function normalizeSearchRow(row = {}, idx = 0) {
  const nmRaw = row.id ?? row.nmId ?? row.nm_id ?? row.sku ?? row.nm ?? null;
  // Порядок полей: сначала артикул → бренд → название, затем метрики.
  return {
    nmId: nmRaw == null ? null : String(nmRaw),
    brand: row.brand ?? row.brand_name ?? null,
    name: row.name ?? row.title ?? null,
    price: num(row.final_price ?? row.price ?? row.client_price ?? row.priceFull), // текущая
    avgSalePrice: num(row.final_price_average ?? row.final_price_median ?? row.final_price), // средняя цена продажи
    rating: num(row.rating ?? row.stars ?? row.valuation ?? row.reviewRating),
    reviews: num(row.comments ?? row.reviews ?? row.feedbacks ?? row.review_count),
    sales: num(row.sales ?? row.sold ?? row.orders ?? row.sale),
    revenue: num(row.revenue ?? row.turnover ?? row.sales_sum),
    lostProfit: num(row.lost_profit ?? row.lostProfit ?? row.lost_profit_rub), // доп. показатель, не фильтруем
    // позиция в выдаче: явное поле или 1-based индекс строки
    position: Number(row.position ?? row.pos ?? row.place ?? idx + 1) || idx + 1,
  };
}

// ── помощники для «глубоких» фильтров по названию ─────────────────────────────
const lc = (s) => String(s || '').toLowerCase();
// Название содержит хоть одно слово из списка (подстрока, нижний регистр —
// морфология «даром»: «притален» ловит приталенная/приталенное/приталенный).
const hasAny = (name, words = []) => words.some((w) => w && name.includes(lc(w)));

/**
 * Двухуровневая фильтрация + ранжирование + топ-N. Чистая функция (без сети).
 *
 * @param {Array} rows  нормализованные строки (normalizeSearchRow)
 * @param {object} opts
 *   revenueFloor   нижний порог выручки за период (₽), по умолчанию 100000
 *   deep           { groups:[{key,any:[...]}], exclude:[...] } — фильтр по названию
 *   exceptionRank  «сопоставимо с ТОП-N» по выручке для «безхвостых» (по умолч. 20)
 *   priceMin/priceMax  ценовой коридор по СРЕДНЕЙ ЦЕНЕ ПРОДАЖИ (avgSalePrice)
 *   minRating/minReviews/minSales  доп. метрические пороги
 *   excludeNmIds   исключить артикулы (обычно наш)
 *   topN           отсечка топ-N (последним шагом); null/0 — не резать
 * @returns {{ pool:number, exceptionRevenueThreshold:number, items:Array }}
 */
export function selectTop(rows = [], opts = {}) {
  const {
    revenueFloor = REVENUE_FLOOR_DEFAULT,
    deep = {},
    exceptionRank = EXCEPTION_RANK_DEFAULT,
    priceMin,
    priceMax,
    minRating,
    minReviews,
    minSales,
    excludeNmIds = [],
    topN,
  } = opts;

  const exNm = new Set(excludeNmIds.map((v) => String(v)));
  const groups = Array.isArray(deep.groups) ? deep.groups.filter((g) => g && (g.any || []).length) : [];
  const exclude = Array.isArray(deep.exclude) ? deep.exclude.filter(Boolean) : [];
  const groupWords = groups.flatMap((g) => g.any || []);

  // 1) Первичный отсев: выручка >= порога и не наш артикул.
  const pool = rows.filter((r) => r && r.nmId != null && !exNm.has(r.nmId) && r.revenue >= revenueFloor);

  // Порог «сопоставимо с ТОП-N» по выручке внутри пула (после отсева <floor).
  const byRev = pool.map((r) => r.revenue).sort((a, b) => b - a);
  const exceptionRevenueThreshold = byRev.length
    ? byRev[Math.min(exceptionRank, byRev.length) - 1]
    : 0;

  // Метрические фильтры — применяются ко ВСЕМ кандидатам (в т.ч. к «безхвостым»).
  const passMetrics = (r) => {
    if (priceMin != null && !(r.avgSalePrice >= priceMin)) return false;
    if (priceMax != null && !(r.avgSalePrice <= priceMax)) return false;
    if (minRating != null && r.rating < minRating) return false;
    if (minReviews != null && r.reviews < minReviews) return false;
    if (minSales != null && r.sales < minSales) return false;
    return true;
  };

  // 2) Глубокая фильтрация по названию + исключение для «безхвостых».
  const items = [];
  for (const r of pool) {
    if (!passMetrics(r)) continue;
    const name = lc(r.name);

    // Слово из общего exclude в названии — выкидываем всегда (и это же отсекает
    // «ложных безхвостых»: противоположные значения кладём в exclude).
    if (exclude.length && hasAny(name, exclude)) continue;

    // Полное совпадение по всем группам-признакам (или групп нет — тогда все проходят).
    const deepMatch = groups.length === 0 || groups.every((g) => hasAny(name, g.any || []));
    if (deepMatch) {
      items.push({ ...r, matchType: groups.length ? 'deep' : 'all' });
      continue;
    }

    // Исключение: у названия «нет хвостов» (ни одного ключа групп) и оно сильное.
    const generic = groups.length > 0 && !hasAny(name, groupWords);
    if (generic && r.revenue >= exceptionRevenueThreshold) {
      items.push({ ...r, matchType: 'exception' });
    }
  }

  // 4) Сортировка по выручке (убыв.).
  items.sort((a, b) => b.revenue - a.revenue);

  // 5) Топ-N — последним шагом.
  const cut = topN == null || topN <= 0 ? items : items.slice(0, topN);
  return { pool: pool.length, exceptionRevenueThreshold, items: cut };
}

/**
 * Полный этап [1]: фраза → вся выдача MPSTATS (пагинация) → нормализация →
 * двухуровневый фильтр → сортировка → топ-N. Требует MPSTATS_TOKEN в окружении.
 *
 * @param {object} p
 *   query    ключевая фраза (обязательна)
 *   d1,d2    период метрик выдачи (YYYY-MM-DD); по умолч. последние 30 дней
 *   filters  { revenueFloor, deep:{groups,exclude}, exceptionRank, priceMin, priceMax,
 *              minRating, minReviews, minSales, excludeNmIds }
 *   our      наш артикул — исключаем из выдачи
 *   topN     отсечка топ-N (10/100/500…), последним шагом; null — не резать
 *   maxRows  предохранитель на размер выборки (транспорт)
 * @returns {Promise<object>} контракт top-rivals
 */
export async function topByKeywords(p = {}) {
  const { query, d1, d2, filters = {}, our, topN, maxRows } = p;
  if (!query || !String(query).trim()) {
    throw new Error('topByKeywords: не задана ключевая фраза (query)');
  }

  const { rows: raw, total, period, capped } = await fetchSearchResults(String(query).trim(), { d1, d2, maxRows });
  const normalized = raw.map((row, i) => normalizeSearchRow(row, i)).filter((r) => r.nmId);

  const excludeNmIds = [...(filters.excludeNmIds || [])];
  if (our) excludeNmIds.push(String(our));

  const { pool, exceptionRevenueThreshold, items } = selectTop(normalized, { ...filters, excludeNmIds, topN });

  return {
    query: String(query).trim(),
    source: 'mpstats',
    period,
    filters: { ...filters, excludeNmIds, topN, revenueFloor: filters.revenueFloor ?? REVENUE_FLOOR_DEFAULT },
    fetched: normalized.length, // сколько строк выдачи разобрали
    total, // сколько всего в выдаче по фразе (по данным MPSTATS)
    capped, // упёрлись ли в предохранитель maxRows
    pool, // сколько осталось после отсева <revenueFloor
    exceptionRevenueThreshold, // порог выручки ТОП-N для «безхвостых»
    rivals: items,
  };
}
