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

/**
 * Кривая размерного спроса по ТОП-конкурентам.
 * @param {Array<{sku:number, rows:{size_name:string,size_origin:string,sales:number}[]}>} perCompetitor
 * @param {{coreThreshold?:number}} opts — порог покрытия для «ядра» (по умолч. 0.6).
 * @returns {{sizes:Array, grid:{core:string[],extreme:string[]}, method:string,
 *            competitors:number, sizedCompetitors:number, oneSizeCount:number, totalSales:number}}
 */
export function computeSizeCurveFromSales(perCompetitor, { coreThreshold = 0.6 } = {}) {
  const demand = new Map();   // size → Σ продаж
  const carriers = new Map(); // size → число карточек, кто держит размер
  const origin = new Map();   // size → «человеческая» метка (size_origin), первая встреченная
  let totalSales = 0, sizedCompetitors = 0, oneSizeCount = 0;

  for (const c of (perCompetitor || [])) {
    const rows = (c && c.rows) || [];
    // Реальные размеры этой карточки (без ONE SIZE).
    const real = rows.filter((r) => r.size_name && !isOneSize(r.size_origin, r.size_name));
    if (!real.length) { if (rows.length) oneSizeCount += 1; continue; }
    sizedCompetitors += 1;
    const seen = new Set(); // покрытие считаем по карточке один раз на размер
    for (const r of real) {
      const key = r.size_name;
      demand.set(key, (demand.get(key) || 0) + (r.sales || 0));
      totalSales += r.sales || 0;
      if (!seen.has(key)) { carriers.set(key, (carriers.get(key) || 0) + 1); seen.add(key); }
      if (!origin.has(key) && r.size_origin) origin.set(key, r.size_origin);
    }
  }

  const denom = totalSales || 1;
  const sizes = [...demand.keys()].map((size) => {
    const coverage = sizedCompetitors ? Math.round((carriers.get(size) || 0) / sizedCompetitors * 1000) / 10 : 0;
    const share = Math.round((demand.get(size) || 0) / denom * 1000) / 10;
    return {
      size,
      origin: origin.get(size) || '',
      share,                               // % доля спроса (рабочая для плана)
      coverage,                            // % карточек ТОПа, кто держит размер
      carriers: carriers.get(size) || 0,   // штучно карточек
      sales: Math.round(demand.get(size) || 0),
      core: coverage >= coreThreshold * 100,
      order: sizeOrder(size),
    };
  }).sort((a, b) => a.order - b.order || b.share - a.share);

  return {
    sizes,
    grid: { core: sizes.filter((s) => s.core).map((s) => s.size), extreme: sizes.filter((s) => !s.core).map((s) => s.size) },
    method: 'mpstats-sales',
    competitors: (perCompetitor || []).length,
    sizedCompetitors,
    oneSizeCount,
    totalSales: Math.round(totalSales),
    coreThreshold,
  };
}
