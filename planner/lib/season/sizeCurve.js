// sizeCurve.js — размерный спрос из БЕСПЛАТНЫХ снимков остатков WB (без MPStats).
//
// Три сигнала, от грубого к точному:
//   1) ПОКРЫТИЕ (из 1 снимка): взвешенная по продажам доля конкурентов, кто держит размер.
//      Высокое → ядро сетки; низкое → крайние размеры (кандидаты «под настил/мин.партию»).
//   2) СТОК-МИКС (из 1 снимка): доля размера в остатке, усреднённая по конкурентам. Грубая
//      оценка спроса (распроданные размеры занижены) — стартовое приближение до накопления.
//   3) УБЫЛЬ (из ≥2 снимков): Σ max(0, вчера−сегодня) по размеру ≈ фактические продажи по
//      размеру. Копится в фоне бесплатно, за 1-2 недели даёт настоящую кривую спроса.

// Натуральный порядок размеров: буквенные по шкале, числовые по значению, ONE — в конец.
const ALPHA = { XXXS: -1, XXS: 0, XS: 1, S: 2, M: 3, L: 4, XL: 5, XXL: 6, XXXL: 7 };
function sizeOrder(size) {
  const s = String(size || '').toUpperCase().trim();
  if (s === 'ONE') return 999;
  if (s in ALPHA) return ALPHA[s];
  const mx = s.match(/^(\d+)\s*XL$/); if (mx) return 5 + Number(mx[1]);      // 3XL,4XL…
  const mn = s.match(/(\d{2,3})/); if (mn) return Number(mn[1]);            // 40,42,«42-44»→42
  return 500;
}

/**
 * Размерный спрос по выборке конкурентов.
 * @param {Map<number,{sizes:{size,qty}[]}>} stockByNm — снимок остатков «сейчас».
 * @param {Map<number,number>} salesByNm — годовые продажи конкурента (вес). Нет → 1.
 * @param {Array<{nm,day,size,qty}>} snapshots — исторические снимки (для убыли). Может быть пуст.
 * @param {{coreThreshold?:number, minTrustUnits?:number}} opts
 * @returns {{sizes:Array, grid:{core:string[],extreme:string[]}, method:string, carriers:number, intervals:number}}
 */
export function computeSizeCurve(stockByNm, salesByNm, snapshots = [], { coreThreshold = 0.6, minTrustUnits = 50 } = {}) {
  const sales = salesByNm || new Map();
  const cov = new Map();   // size → Σ веса конкурентов, кто держит размер
  const cnt = new Map();   // size → число конкурентов (штучно), кто держит размер
  const prov = new Map();  // size → Σ веса·(доля размера в остатке конкурента)
  let totalW = 0, carriers = 0;

  for (const [nm, v] of (stockByNm || new Map())) {
    const sizes = (v && v.sizes) || [];
    const tot = sizes.reduce((a, s) => a + (s.qty || 0), 0);
    if (tot <= 0) continue;                 // без остатка сетку не прочитать
    const w = Math.max(1, Number(sales.get(Number(nm))) || 1);
    totalW += w; carriers += 1;
    for (const s of sizes) {
      if (s.qty <= 0) continue;
      cov.set(s.size, (cov.get(s.size) || 0) + w);
      cnt.set(s.size, (cnt.get(s.size) || 0) + 1);
      prov.set(s.size, (prov.get(s.size) || 0) + w * (s.qty / tot));
    }
  }

  // Убыль по размеру из последовательных снимков одного nmID (пропуск дозаказов).
  const deplBySize = new Map();
  let intervals = 0, deplTotal = 0;
  const byNm = new Map();
  for (const r of (snapshots || [])) {
    if (!byNm.has(r.nm)) byNm.set(r.nm, new Map());
    const days = byNm.get(r.nm);
    if (!days.has(r.day)) days.set(r.day, new Map());
    days.get(r.day).set(r.size, Number(r.qty) || 0);
  }
  for (const [, days] of byNm) {
    const seq = [...days.keys()].sort();
    for (let i = 1; i < seq.length; i++) {
      const prev = days.get(seq[i - 1]);
      const cur = days.get(seq[i]);
      let any = false;
      for (const [size, qPrev] of prev) {
        const qCur = cur.get(size) ?? 0;
        const sold = qPrev - qCur;             // >0 продано; <0 дозаказ → игнор
        if (sold > 0) { deplBySize.set(size, (deplBySize.get(size) || 0) + sold); deplTotal += sold; any = true; }
      }
      if (any) intervals += 1;
    }
  }

  const useDepl = deplTotal >= minTrustUnits;
  const deplSum = deplTotal || 1;
  const provSum = [...prov.values()].reduce((a, x) => a + x, 0) || 1;
  const allSizes = new Set([...cov.keys(), ...deplBySize.keys()]);

  const sizes = [...allSizes].map((size) => {
    const coverage = totalW ? Math.round((cov.get(size) || 0) / totalW * 1000) / 10 : 0;
    const provShare = Math.round((prov.get(size) || 0) / provSum * 1000) / 10;
    const deplShare = useDepl ? Math.round((deplBySize.get(size) || 0) / deplSum * 1000) / 10 : null;
    return {
      size,
      coverage,                                        // % конкурентов (взвеш.), кто держит размер
      carriers: cnt.get(size) || 0,                    // штучно конкурентов с этим размером
      provShare,                                       // % стартовая оценка спроса по остатку
      deplShare,                                       // % спрос по убыли (null пока мало данных)
      share: useDepl ? deplShare : provShare,          // рабочая доля для плана
      core: coverage >= coreThreshold * 100,
      order: sizeOrder(size),
    };
  }).sort((a, b) => a.order - b.order || b.share - a.share);

  return {
    sizes,
    grid: { core: sizes.filter((s) => s.core).map((s) => s.size), extreme: sizes.filter((s) => !s.core).map((s) => s.size) },
    method: useDepl ? 'depletion' : 'stock-mix',
    carriers, intervals, deplTotal: Math.round(deplTotal), coreThreshold,
  };
}
