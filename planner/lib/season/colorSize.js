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
 * Кол-во к пошиву по цветам. БАЗА — СУММАРНЫЙ ОБЪЁМ продаж цвета (units), т.е. реальный
 * рыночный спрос (белого продаётся больше всего → он лидер, как и в жизни). НЕ по Ср/арт:
 * средняя на карточку задирается у цветов с малым числом карточек (1-2 хита) и даёт
 * контр-интуитивного «лидера». Ср/арт остаётся справочным сигналом «эффективности».
 *
 * Лучший цвет (макс. объём) = forecast (100%), остальные — пропорционально СВОЕМУ объёму
 * относительно лучшего: qty_i = forecast × units_i / units_best. Общий тираж = сумма (больше
 * forecast). Слабые/лишние — в сноску. Ассортимент добирается до minColors (сперва надёжные
 * ≥minCount карточек, затем малоданные) — по тому же объёму.
 *
 * @param {Array} colors — из computeColorShares (нужны name, units, avgPerSku, skus, normShare, rawShare).
 * @param {number} forecast — «Выкупы (прогноз)», объём лучшего цвета.
 * @param {{minRel?:number, minCount?:number, minColors?:number}} opts — minRel: порог объёма
 *        относительно лучшего (0.4 = ≥40%); minCount: минимум карточек для «надёжного»;
 *        minColors: минимум расцветок в ассортименте (по умолч. 5).
 * @returns {{best:{name,units,avgPerSku}|null, core:Array, weak:Array, grandTotal:number,
 *            weakSummary:{count,qty,names}|null, minRel:number, minColors:number}}
 */
export function colorQuantities(colors, forecast, { minRel = 0.4, minCount = 3, minColors = 5 } = {}) {
  const F = Math.max(0, Number(forecast) || 0);
  const named = (colors || []).filter((c) => c && Number(c.units) > 0 && c.name !== 'не указан');
  if (!named.length || !F) return { best: null, core: [], weak: [], grandTotal: 0, weakSummary: null, minRel, minColors };
  const trusted = named.filter((c) => (c.skus || 0) >= minCount);
  const lowData = named.filter((c) => (c.skus || 0) < minCount);
  // Лидер и масштаб — по надёжным цветам (если надёжных нет вовсе, берём по всем).
  const scalePool = trusted.length ? trusted : named;
  const bestUnits = Math.max(...scalePool.map((c) => c.units));
  const mkRow = (c, low) => {
    const rel = Math.min(c.units / bestUnits, 1); // база — СУММАРНЫЙ объём (лидер = потолок)
    return {
      name: c.name, units: c.units, avgPerSku: c.avgPerSku, skus: c.skus, normShare: c.normShare,
      rel: Math.round(rel * 1000) / 10, qty: Math.round(F * rel), lowData: !!low, efficient: false,
    };
  };
  const trustedRows = trusted.map((c) => mkRow(c, false)).sort((a, b) => b.units - a.units);
  const lowRows = lowData.map((c) => mkRow(c, true)).sort((a, b) => (b.skus - a.skus) || (b.units - a.units));
  // «Эффективный» = Ср/арт выше, чем у ЛИДЕРА по объёму: продаётся лучше на карточку при
  // меньшем объёме → возможная недооценённая ниша (низкая конкуренция внутри цвета).
  const leaderAvg = (trustedRows[0] || lowRows[0] || {}).avgPerSku || 0;
  for (const r of [...trustedRows, ...lowRows]) r.efficient = leaderAvg > 0 && (r.avgPerSku || 0) > leaderAvg * 1.15;

  // Ядро: надёжные по порогу объёма/минимуму, затем добор из малоданных до minColors.
  const passCount = trustedRows.filter((r) => r.rel >= minRel * 100).length;
  const ordered = [...trustedRows, ...lowRows];
  const keep = Math.min(ordered.length, Math.max(passCount, Math.max(1, minColors || 1)));
  const core = ordered.slice(0, keep);
  const weak = ordered.slice(keep);
  const grandTotal = core.reduce((s, r) => s + r.qty, 0);
  const weakSummary = weak.length
    ? { count: weak.length, qty: weak.reduce((s, r) => s + r.qty, 0), names: weak.map((r) => r.name) }
    : null;
  const lead = trustedRows[0] || core[0];
  return { best: lead ? { name: lead.name, units: lead.units, avgPerSku: lead.avgPerSku } : null, core, weak, grandTotal, weakSummary, minRel, minColors };
}
