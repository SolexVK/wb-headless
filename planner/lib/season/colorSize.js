// colorSize.js — доли спроса по ЦВЕТАМ (и далее размерам) из выборки конкурентов.
//
// ЦВЕТА (Этап 1): serp отдаёт по каждому конкуренту строку `color` + продажи. Сырая сумма
// продаж по цвету перекошена ПРЕДЛОЖЕНИЕМ (белый продаёт 86 продавцов → он «доминирует»
// не потому, что спрос выше, а потому, что его больше выкладывают). Поэтому основа —
// НОРМАЛИЗОВАННАЯ доля: среднее на 1 артикул = продажи_цвета / количество_артикулов_цвета,
// затем доля = среднее_цвета / Σсредних. Сырую долю показываем рядом (объём рынка/насыщение).

// Кластеризация синонимов цвета → канонический цвет. Порядок важен (первое совпадение).
// Расширяемо: добавляй пары [канон, регэксп] по мере встреч новых оттенков.
const COLOR_GROUPS = [
  ['белый/молочный', /бел|молоч|кремов|айвор|слонов|сливоч|ванил|экрю|кокос|пудрово.?бел|off.?white/i],
  ['бежевый', /беж|песоч|карамель|капучино|кофе|латте|верблюж|табак|бисквит|мокко/i],
  ['чёрный', /чёрн|черн|графит|антрацит/i],
  ['серый', /сер\b|серый|серо|стальн|асфальт|мышин|дым/i],
  ['голубой', /голуб|небес|бирюз|мятн|лазур|аквамарин|циан|тиффани/i],
  ['синий', /син[ий|ие|яя|его]|индиго|денид|деним|джинс|василёк|василек|кобальт|ультрамарин|тёмно.?син|темно.?син/i],
  ['зелёный', /зелен|зелён|олив|хаки|фисташ|изумруд|салат|лайм|травян|бутыл/i],
  ['розовый', /розов|пудр|фрез|фукси|коралл|лосос|пыльн.?роз|барби/i],
  ['красный', /красн|бордов|вишн|бургунд|винн|марсал|терракот|рубин|алый/i],
  ['жёлтый', /жёлт|желт|горчич|лимон|янтар|шафран|золот/i],
  ['оранжевый', /оранж|апельсин|морков|тыкв|персик|абрикос|манго/i],
  ['фиолетовый', /фиолет|сирен|лаванд|сливов|баклажан|лилов|пурпур/i],
  ['коричневый', /коричн|шоколад|каштан|бронз|медн/i],
];

/** Первый (основной) цвет строки → канонический. Пустой → «не указан». */
export function normColor(str) {
  const raw = String(str || '').toLowerCase().replace(/ё/g, 'ё').split(/[,;/]+/)[0].trim();
  if (!raw) return 'не указан';
  for (const [canon, re] of COLOR_GROUPS) if (re.test(raw)) return canon;
  // не попал в словарь — вернём как есть (первое слово), чтобы не терять цвет
  return raw.split(/\s+/)[0];
}

/**
 * Доли спроса по цветам из выборки конкурентов.
 * @param {Array} items — perItemMeta (или serp items): { color, unitsSoldLY|sales }
 * @param {{minCount?:number}} opts — минимум артикулов цвета для доверия нормализ. доле.
 * @returns {{colors:Array, total:{units,skus}, minCount}}
 *   colors[i] = { name, skus, units, rawShare, avgPerSku, normShare, lowConfidence }
 */
export function computeColorShares(items, { minCount = 3 } = {}) {
  const acc = new Map();
  let totalUnits = 0, totalSkus = 0;
  for (const it of (items || [])) {
    const u = Number(it.unitsSoldLY != null ? it.unitsSoldLY : it.sales) || 0;
    if (u <= 0) continue; // только живые (есть продажи)
    const c = normColor(it.color);
    const a = acc.get(c) || { name: c, skus: 0, units: 0 };
    a.skus += 1; a.units += u;
    acc.set(c, a);
    totalUnits += u; totalSkus += 1;
  }
  const rows = [...acc.values()].map((a) => ({ ...a, avgPerSku: a.skus ? Math.round(a.units / a.skus) : 0 }));
  // нормализованная доля — по средним на артикул, только среди цветов с достаточным охватом
  const trusted = rows.filter((r) => r.skus >= minCount && r.name !== 'не указан');
  const sumAvg = trusted.reduce((s, r) => s + r.avgPerSku, 0) || 1;
  const colors = rows.map((r) => ({
    name: r.name,
    skus: r.skus,
    units: Math.round(r.units),
    rawShare: totalUnits ? Math.round(r.units / totalUnits * 1000) / 10 : 0,          // % объёма рынка
    avgPerSku: r.avgPerSku,
    normShare: (r.skus >= minCount && r.name !== 'не указан') ? Math.round(r.avgPerSku / sumAvg * 1000) / 10 : null, // % на 1 карточку
    lowConfidence: r.skus < minCount || r.name === 'не указан',
  })).sort((a, b) => (b.normShare ?? -1) - (a.normShare ?? -1) || b.units - a.units);
  return { colors, total: { units: Math.round(totalUnits), skus: totalSkus }, minCount };
}

/**
 * Кол-во к пошиву по цветам. ВАЖНО: forecast — это объём ОДНОГО лучшего цвета (потолок
 * карточки-чемпиона), а НЕ итог на все цвета. Поэтому лучший цвет = forecast (100%), а
 * остальные масштабируются ОТНОСИТЕЛЬНО лучшего по силе продаж на 1 карточку (avgPerSku):
 *   qty_i = forecast × avgPerSku_i / avgPerSku_best.
 * Общий тираж = сумма по цветам (больше forecast). Слабые цвета (сила ниже порога от
 * лучшего) уходят в сноску — не плодим микро-партии.
 *
 * @param {Array} colors — из computeColorShares (нужны name, avgPerSku, skus, normShare).
 * @param {number} forecast — «Выкупы (прогноз)», объём лучшего цвета.
 * @param {{minRel?:number, minCount?:number}} opts — minRel: порог силы относительно лучшего
 *        (0.4 = ≥40% от лучшего); minCount: минимум карточек для доверия (совпадает с долями).
 * @returns {{best:{name,avgPerSku}|null, core:Array, weak:Array, grandTotal:number,
 *            weakSummary:{count,qty,names}|null, minRel:number}}
 */
export function colorQuantities(colors, forecast, { minRel = 0.4, minCount = 3 } = {}) {
  const F = Math.max(0, Number(forecast) || 0);
  // Доверенные цвета: достаточно карточек и распознанный цвет (как для нормализ. доли).
  const trusted = (colors || []).filter((c) => c && c.avgPerSku > 0 && (c.skus || 0) >= minCount && c.name !== 'не указан');
  if (!trusted.length || !F) return { best: null, core: [], weak: [], grandTotal: 0, weakSummary: null, minRel };
  const bestAvg = Math.max(...trusted.map((c) => c.avgPerSku));
  const best = trusted.find((c) => c.avgPerSku === bestAvg);
  const rows = trusted.map((c) => {
    const rel = c.avgPerSku / bestAvg;                 // сила относительно лучшего (0..1)
    return {
      name: c.name,
      avgPerSku: c.avgPerSku,
      rel: Math.round(rel * 1000) / 10,                // % от лучшего
      qty: Math.round(F * rel),                        // штук к пошиву
      skus: c.skus,
      normShare: c.normShare,
    };
  }).sort((a, b) => b.qty - a.qty);
  const core = rows.filter((r) => r.rel >= minRel * 100);
  const weak = rows.filter((r) => r.rel < minRel * 100);
  const grandTotal = core.reduce((s, r) => s + r.qty, 0);
  const weakSummary = weak.length
    ? { count: weak.length, qty: weak.reduce((s, r) => s + r.qty, 0), names: weak.map((r) => r.name) }
    : null;
  return { best: { name: best.name, avgPerSku: best.avgPerSku }, core, weak, grandTotal, weakSummary, minRel };
}
