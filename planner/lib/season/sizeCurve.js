// sizeCurve.js — размерная кривая спроса из MPStats sales/sizes (продажи по размерам).
//
// Источник: analytics/v1/wb/items/{sku}/sales/sizes (см. mpstatsSizes.js). Каждая
// строка — продажи ОДНОГО размера конкретной карточки за период. Продажи абсолютные,
// поэтому вес крупных продавцов учитывается сам собой (их sales больше).
//
// Три числа на размер:
//   • ДОЛЯ СПРОСА  = Σ продаж размера ÷ Σ всех продаж (по всем карточкам ТОПа) — это
//     рабочая кривая для пошива.
//   • ПОКРЫТИЕ     = доля карточек ТОПа, кто вообще держит/продаёт размер (высокое →
//     ядро сетки; низкое → крайние размеры под мин.партию/настил).
//   • ПРОДАЖИ      = абсолют (штук за период) — справочно.
//
// Товары «ONE SIZE» (единый размер) в кривую размеров не идут (нечего распределять),
// но считаются отдельно (oneSizeCount) — если их много, размерный сплит ненадёжен.

// Натуральный порядок: буквенные по шкале, диапазоны/числа по первому числу, ONE — в конец.
const ALPHA = { XXXS: -1, XXS: 0, XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, XXXL: 7 };
function sizeOrder(size) {
  const s = String(size || '').toUpperCase().trim();
  if (s === 'ONE' || /one\s*size/i.test(s)) return 999;
  if (s in ALPHA) return ALPHA[s];
  const mx = s.match(/^(\d+)\s*XL$/); if (mx) return 5 + Number(mx[1]);   // 3XL,4XL…
  const mn = s.match(/(\d{2,3})/); if (mn) return Number(mn[1]);          // 44, «44-48»→44
  return 500;
}

const isOneSize = (origin, name) =>
  /one\s*size|без\s*размер|б\/р/i.test(String(origin || '')) ||
  /one\s*size/i.test(String(name || ''));

// Единая метка размера. Диапазоны нормализуем к «lo-hi», одиночные — к числу-строке.
function normLabel(name) {
  const s = String(name || '').trim();
  const r = s.match(/(\d{2,3})\s*[-–—]\s*(\d{2,3})/);
  if (r) { let a = +r[1], b = +r[2]; if (a > b) [a, b] = [b, a]; return `${a}-${b}`; }
  const m = s.match(/(\d{2,3})/);
  return m ? m[1] : s.toUpperCase();
}
// Числовой интервал размера: диапазон → [lo,hi,range=true], одиночный → [n,n,false], иначе null.
function parseInterval(name) {
  const s = String(name || '');
  const r = s.match(/(\d{2,3})\s*[-–—]\s*(\d{2,3})/);
  if (r) { let a = +r[1], b = +r[2]; if (a > b) [a, b] = [b, a]; return { lo: a, hi: b, range: true }; }
  const m = s.match(/(\d{2,3})/);
  if (m) { const n = +m[1]; return { lo: n, hi: n, range: false }; }
  return null;
}

/**
 * Кривая размерного спроса по ТОП-конкурентам. Диапазоны — канон ниши; продажи одиночных
 * размеров сводятся в накрывающий диапазон, чтобы не двоить шкалу и получить доли = 100%.
 * @param {Array<{sku:number, rows:{size_name:string,size_origin:string,sales:number}[]}>} perCompetitor
 * @param {{coreThreshold?:number}} opts — порог покрытия для «ядра» (по умолч. 0.6).
 */
export function computeSizeCurveFromSales(perCompetitor, { coreThreshold = 0.6 } = {}) {
  // ── Шаг 1: собрать канонические диапазоны (это рыночная норма — их держит большинство).
  const ranges = new Map();       // label «lo-hi» → {lo,hi,mid,origin}
  const singleOrigin = new Map(); // label одиночного → origin (на случай отсутствия диапазонов)
  const competitors = [];         // нормализованные записи по карточке
  let oneSizeCount = 0;
  for (const c of (perCompetitor || [])) {
    const real = ((c && c.rows) || []).filter((r) => r.size_name && !isOneSize(r.size_origin, r.size_name));
    if (!real.length) { if (c && c.rows && c.rows.length) oneSizeCount += 1; continue; }
    const entries = real.map((r) => ({ iv: parseInterval(r.size_name), label: normLabel(r.size_name), origin: r.size_origin || '', sales: r.sales || 0 }));
    for (const e of entries) {
      if (e.iv && e.iv.range) { if (!ranges.has(e.label)) ranges.set(e.label, { lo: e.iv.lo, hi: e.iv.hi, mid: (e.iv.lo + e.iv.hi) / 2, origin: e.origin }); }
      else if (e.iv && !singleOrigin.has(e.label)) singleOrigin.set(e.label, e.origin);
    }
    competitors.push(entries);
  }
  const rangeList = [...ranges.entries()].map(([label, v]) => ({ label, ...v }));

  // Куда отнести запись: диапазон → он сам; одиночный → накрывающий диапазон (или ближайший
  // в пределах ±3); если диапазонов нет вовсе — одиночный остаётся сам собой.
  function bucketOf(entry) {
    if (!entry.iv) return entry.label;                       // буквенный без числа — как есть
    if (entry.iv.range) return entry.label;                  // диапазон — канон
    if (!rangeList.length) return entry.label;               // диапазонов нет — шкала на одиночных
    const x = entry.iv.lo;
    const contains = rangeList.filter((r) => x >= r.lo && x <= r.hi);
    const pick = (arr) => arr.slice().sort((a, b) =>
      Math.abs(a.mid - x) - Math.abs(b.mid - x) || (a.hi - a.lo) - (b.hi - b.lo) || a.lo - b.lo)[0];
    if (contains.length) return pick(contains).label;
    const near = rangeList.filter((r) => Math.abs(r.mid - x) <= 3);
    return near.length ? pick(near).label : entry.label;
  }

  // ── Шаг 2: агрегировать спрос/покрытие по корзинам.
  const demand = new Map(); const carriers = new Map(); const origin = new Map();
  let totalSales = 0; const sizedCompetitors = competitors.length;
  for (const entries of competitors) {
    const seen = new Set();
    for (const e of entries) {
      const key = bucketOf(e);
      demand.set(key, (demand.get(key) || 0) + e.sales);
      totalSales += e.sales;
      if (!seen.has(key)) { carriers.set(key, (carriers.get(key) || 0) + 1); seen.add(key); }
      const org = ranges.get(key)?.origin || e.origin || singleOrigin.get(key) || '';
      if (!origin.has(key) && org) origin.set(key, org);
    }
  }

  const denom = totalSales || 1;
  const sizes = [...demand.keys()].map((size) => {
    const coverage = sizedCompetitors ? Math.round((carriers.get(size) || 0) / sizedCompetitors * 1000) / 10 : 0;
    return {
      size,
      origin: origin.get(size) || '',
      share: Math.round((demand.get(size) || 0) / denom * 1000) / 10, // % доля спроса (рабочая)
      coverage,                                                        // % карточек ТОПа с размером
      carriers: carriers.get(size) || 0,
      sales: Math.round(demand.get(size) || 0),
      core: coverage >= coreThreshold * 100,
      order: sizeOrder(size),
    };
  }).sort((a, b) => a.order - b.order || b.share - a.share);

  // «Крайние» (низкое покрытие) сворачиваем в сводку для сноски — в основную сетку не шумят.
  const extremes = sizes.filter((s) => !s.core);
  const extremeSummary = extremes.length ? {
    count: extremes.length,
    share: Math.round(extremes.reduce((a, s) => a + s.share, 0) * 10) / 10,
    sales: extremes.reduce((a, s) => a + s.sales, 0),
    sizes: extremes.map((s) => s.size),
  } : null;

  return {
    sizes,
    grid: { core: sizes.filter((s) => s.core).map((s) => s.size), extreme: extremes.map((s) => s.size) },
    extremeSummary,
    method: 'mpstats-sales',
    competitors: (perCompetitor || []).length,
    sizedCompetitors,
    oneSizeCount,
    totalSales: Math.round(totalSales),
    coreThreshold,
  };
}
