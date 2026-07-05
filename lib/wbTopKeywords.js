// lib/wbTopKeywords.js — инструмент [1] каскада: «ТОП по ключевой фразе».
//
// Идея: по ключевой фразе берём ВСЮ поисковую выдачу WB из MPSTATS за период,
// нормализуем к общему контракту и прогоняем через двухуровневую фильтрацию:
//   1) первичный отсев: выручка за период < 100 000 ₽ → мусор, выкидываем;
//   2) фильтры по словам в НАЗВАНИИ: общий exclude — ЖЁСТКИЙ ГЕЙТ (любое слово из
//        него → выкидываем); группы-признаки (крой/воротник/…) соединяются ИЛИ —
//        внутри группы ИЛИ, между группами тоже ИЛИ (матч хотя бы по одной группе);
//      + ИСКЛЮЧЕНИЕ: «безхвостый» сильный артикул (в названии нет ни одного ключа
//        групп) остаётся, если его выручка сопоставима с ТОП-20 пула (порог считаем
//        по пулу БЕЗ exclude-хитов) и средняя цена продажи в ценовом интервале;
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

  // Порог «сопоставимо с ТОП-N» по выручке — по пулу БЕЗ exclude-хитов: исключённые
  // товары (не наша категория) не должны задавать планку выручки для остальных.
  const poolForThreshold = exclude.length ? pool.filter((r) => !hasAny(lc(r.name), exclude)) : pool;
  const byRev = poolForThreshold.map((r) => r.revenue).sort((a, b) => b - a);
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

  // 2) Фильтр по названию: exclude — жёсткий гейт; группы соединяются ИЛИ (матч хоть
  //    по одной группе). «Безхвостый» генерик (ни одного ключа групп) добирается
  //    исключением, если его выручка сопоставима с ТОП-N пула (без exclude-хитов).
  const items = [];
  for (const r of pool) {
    if (!passMetrics(r)) continue;
    const name = lc(r.name);

    // Слово из общего exclude в названии — выкидываем всегда.
    if (exclude.length && hasAny(name, exclude)) continue;

    // Совпадение хотя бы по одной группе (ИЛИ). Групп нет — проходят все.
    const groupMatch = groups.length === 0 || groups.some((g) => hasAny(name, g.any || []));
    if (groupMatch) {
      items.push({ ...r, matchType: groups.length ? 'group' : 'all' });
      continue;
    }

    // Иначе — «безхвостый» (ключей групп в названии нет): оставляем, если он сильный.
    if (r.revenue >= exceptionRevenueThreshold) {
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

// ── HTML-отчёт по результату [1] ──────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rub = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('ru-RU'));
const MATCH_BADGE = {
  group: ['совпадение', '#1f6f3f', '#e6f4ea'],
  exception: ['безхвостый', '#8a5a00', '#fff3d6'],
  all: ['без групп', '#555', '#eee'],
};

/**
 * Собирает самодостаточный HTML-отчёт из результата topByKeywords.
 * @param {object} res  контракт top-rivals
 * @returns {string} HTML-документ
 */
export function formatHtml(res) {
  const f = res.filters || {};
  const groups = (f.deep?.groups || []).map((g) => `${esc(g.key)}=[${(g.any || []).map(esc).join(', ')}]`).join(' &nbsp;·&nbsp; ') || '—';
  const excl = (f.deep?.exclude || []).map(esc).join(', ') || '—';
  const priceStr = [f.priceMin != null ? `от ${rub(f.priceMin)}` : null, f.priceMax != null ? `до ${rub(f.priceMax)}` : null].filter(Boolean).join(' ') || 'любая';

  const rows = res.rivals.map((r, i) => {
    const [label, fg, bg] = MATCH_BADGE[r.matchType] || MATCH_BADGE.all;
    const url = `https://www.wildberries.ru/catalog/${r.nmId}/detail.aspx`;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><a href="${url}" target="_blank" rel="noopener">${esc(r.nmId)}</a></td>
      <td>${esc(r.brand || '—')}</td>
      <td class="name">${esc(r.name || '—')}</td>
      <td><span class="badge" style="color:${fg};background:${bg}">${label}</span></td>
      <td class="num money">${rub(r.revenue)}</td>
      <td class="num">${rub(r.avgSalePrice)}</td>
      <td class="num">${rub(r.reviews)}</td>
      <td class="num">${rub(r.sales)}</td>
      <td class="num lost">${rub(r.lostProfit)}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ТОП по фразе: ${esc(res.query)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; background:#fafafa; color:#1a1a1a; }
  @media (prefers-color-scheme: dark){ body{ background:#161616; color:#e8e8e8 } .card{ background:#1f1f1f!important } th{ background:#262626!important } tr:hover td{ background:#232323!important } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color:#777; margin-bottom:16px; }
  .card { background:#fff; border-radius:10px; padding:14px 16px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .card b { color:inherit; }
  .grid { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; }
  .grid div:nth-child(odd){ color:#888; }
  table { border-collapse: collapse; width:100%; background:inherit; }
  th, td { padding:7px 9px; border-bottom:1px solid rgba(128,128,128,.2); text-align:left; vertical-align:top; }
  th { position:sticky; top:0; background:#f0f0f0; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }
  td.money { font-weight:600; }
  td.lost { color:#b26b00; }
  td.name { max-width:340px; }
  a { color:#2563eb; text-decoration:none; } a:hover{ text-decoration:underline; }
  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px; font-weight:600; white-space:nowrap; }
  tr:hover td { background:#f6f8ff; }
</style></head><body>
<h1>ТОП по фразе: «${esc(res.query)}»</h1>
<div class="sub">Источник: MPStats · период ${esc(res.period?.d1)} … ${esc(res.period?.d2)}</div>
<div class="card"><div class="grid">
  <div>Выдача (всего / разобрано)</div><div><b>${res.total}</b> / ${res.fetched}${res.capped ? ' <span style="color:#c00">(упёрлись в предохранитель)</span>' : ''}</div>
  <div>После отсева выручки &lt; ${rub(f.revenueFloor)}₽</div><div><b>${res.pool}</b></div>
  <div>Порог «безхвостых» (ТОП-${f.exceptionRank ?? 20}, без exclude)</div><div><b>${rub(res.exceptionRevenueThreshold)}</b>₽</div>
  <div>Группы (ИЛИ)</div><div>${groups}</div>
  <div>Exclude (гейт)</div><div>${excl}</div>
  <div>Ценовой коридор (ср. цена)</div><div>${priceStr}</div>
  <div>Итог</div><div><b>${res.rivals.length}</b> карточек</div>
</div></div>
<table>
  <thead><tr>
    <th>#</th><th>Артикул</th><th>Бренд</th><th>Название</th><th>Тип</th>
    <th>Выручка ₽</th><th>Ср. цена</th><th>Отзывы</th><th>Продажи</th><th>Упущ. выручка ₽</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body></html>`;
}
