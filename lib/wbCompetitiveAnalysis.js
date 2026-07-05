// lib/wbCompetitiveAnalysis.js — инструмент [3] каскада: «Конкурентный анализ».
//
// Вход — нормализованный контракт «cards-compare» из [2] (lib/wbCardsCompareParse.js):
//   { source, our, periods, articles:[{nmId,isOur,...,current,previous}], funnel:[...] }
//
// Что делаем (чистая логика, без сети): сравниваем НАШУ карточку с конкурентами по
//   — воронке: CTR → конверсия в корзину → в заказ → % выкупа (где проседаем);
//   — ценовому позиционированию (премиум / средний / бюджет);
//   — качеству (рейтинг карточки, рейтинг по отзывам, число отзывов);
//   — средней позиции в поиске;
//   — тренду период-к-периоду по нашей воронке (растём/падаем).
// Находим «бутылочное горлышко» воронки (самый слабый этап относительно конкурентов),
// формируем выводы (findings) и конкретные рекомендации.
//
// Выход — контракт competitive-analysis (см. docs/pipeline/README.md) + человекочитаемый
// markdown-отчёт (formatReport). Пригоден как финал каскада [1]→[2]→[3].

// ── числовые помощники ────────────────────────────────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (arr) => arr.filter(isNum);

function median(arr) {
  const a = nums(arr).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const maxOf = (arr) => (nums(arr).length ? Math.max(...nums(arr)) : null);
const minOf = (arr) => (nums(arr).length ? Math.min(...nums(arr)) : null);

// Разрыв нашего значения к опорному в процентах: (our-ref)/|ref|*100. + = мы выше.
function gapPct(our, ref) {
  if (!isNum(our) || !isNum(ref) || ref === 0) return null;
  return round(((our - ref) / Math.abs(ref)) * 100, 1);
}
// Доля конкурентов, которых мы обходим по метрике (0..1). higherBetter — куда «лучше».
function percentileAmong(our, rivals, higherBetter = true) {
  const r = nums(rivals);
  if (!isNum(our) || !r.length) return null;
  const beaten = r.filter((v) => (higherBetter ? our > v : our < v)).length;
  return round(beaten / r.length, 2);
}
const round = (v, d = 2) => {
  if (!isNum(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// ── описание этапов воронки и прочих метрик ───────────────────────────────────
// higherBetter: true — больше=лучше; false — меньше=лучше (позиция в поиске).
const FUNNEL_STAGES = [
  { key: 'ctrPct', label: 'CTR (показы→переходы)', unit: '%' },
  { key: 'cartConvPct', label: 'Конверсия в корзину', unit: '%' },
  { key: 'orderConvPct', label: 'Конверсия в заказ', unit: '%' },
  { key: 'buyoutPct', label: 'Процент выкупа', unit: '%' },
];

/**
 * Считает срез по одной метрике: наше значение против конкурентов.
 * @param {number|null} our  наше значение
 * @param {number[]} rivals  значения конкурентов
 * @param {boolean} higherBetter  больше=лучше?
 */
function compareMetric(our, rivals, higherBetter = true) {
  const med = median(rivals);
  const best = higherBetter ? maxOf(rivals) : minOf(rivals);
  const worst = higherBetter ? minOf(rivals) : maxOf(rivals);
  const pct = percentileAmong(our, rivals, higherBetter);
  // Разрыв к медиане с учётом направления «лучше» (+ = мы лучше конкурентов).
  let gapMed = gapPct(our, med);
  if (gapMed != null && !higherBetter) gapMed = -gapMed;
  let status = 'unknown';
  if (pct != null) status = pct >= 0.66 ? 'strong' : pct <= 0.34 ? 'weak' : 'ok';
  return {
    our: round(our, 2),
    rivalsMedian: round(med, 2),
    rivalsBest: round(best, 2),
    rivalsWorst: round(worst, 2),
    gapToMedianPct: gapMed,
    percentile: pct, // доля конкурентов, которых обходим
    status, // strong | ok | weak | unknown
  };
}

// ── основной анализ ───────────────────────────────────────────────────────────
/**
 * Строит конкурентный анализ из контракта cards-compare.
 * @param {object} p
 *   cardsCompare  объект контракта [2] (обязателен) — { our, articles, funnel, periods }
 * @returns {object} контракт competitive-analysis
 */
export function competitiveAnalysis({ cardsCompare } = {}) {
  const cc = cardsCompare;
  if (!cc || !Array.isArray(cc.articles) || !cc.articles.length) {
    throw new Error('competitiveAnalysis: нужен контракт cards-compare с непустым articles[]');
  }

  const our = cc.articles.find((a) => a.isOur) || cc.articles[0];
  const rivals = cc.articles.filter((a) => a !== our);
  if (!rivals.length) {
    throw new Error('competitiveAnalysis: в cards-compare нет конкурентов (только наша карточка)');
  }

  const curOf = (a) => a.current || {};
  const rivalVals = (key) => rivals.map((a) => curOf(a)[key]);

  // 1) Воронка: наш этап против конкурентов.
  const stages = FUNNEL_STAGES.map((s) => ({
    key: s.key,
    label: s.label,
    unit: s.unit,
    ...compareMetric(curOf(our)[s.key], rivalVals(s.key), true),
  }));

  // «Бутылочное горлышко» — этап, где мы сильнее всего отстаём (мин. gapToMedianPct
  // среди этапов, где мы ниже медианы). Если нигде не отстаём — null.
  const behind = stages.filter((s) => isNum(s.gapToMedianPct) && s.gapToMedianPct < 0);
  const bottleneck = behind.length
    ? behind.reduce((a, b) => (a.gapToMedianPct <= b.gapToMedianPct ? a : b)).key
    : null;

  // 2) Цена: медианная цена нашей карточки против конкурентов.
  const priceMed = compareMetric(curOf(our).medianPrice, rivalVals('medianPrice'), true);
  // Тир: доля конкурентов дешевле нас. >0.66 — премиум, <0.34 — бюджет, иначе средний.
  let priceTier = 'mid';
  const cheaperShare = percentileAmong(curOf(our).medianPrice, rivalVals('medianPrice'), true);
  if (cheaperShare != null) priceTier = cheaperShare >= 0.66 ? 'premium' : cheaperShare <= 0.34 ? 'budget' : 'mid';

  // 3) Качество: рейтинг карточки, рейтинг по отзывам, число отзывов.
  const quality = {
    cardRating: compareMetric(curOf(our).cardRating, rivalVals('cardRating'), true),
    reviewRating: compareMetric(curOf(our).reviewRating, rivalVals('reviewRating'), true),
    reviewCount: compareMetric(curOf(our).reviewCount, rivalVals('reviewCount'), true),
  };

  // 4) Позиция в поиске: меньше = лучше.
  const searchPosition = compareMetric(curOf(our).avgSearchPosition, rivalVals('avgSearchPosition'), false);

  // 5) Тренд период-к-периоду по нашей воронке (если есть previous).
  const prev = our.previous || null;
  const trend = prev
    ? FUNNEL_STAGES.map((s) => ({
        key: s.key,
        label: s.label,
        current: round(curOf(our)[s.key], 2),
        previous: round(prev[s.key], 2),
        deltaPct: gapPct(curOf(our)[s.key], prev[s.key]),
      }))
    : null;

  // 6) Выводы и рекомендации.
  const { findings, recommendations } = deriveInsights({ stages, bottleneck, priceMed, priceTier, quality, searchPosition, trend });

  return {
    source: 'wb-competitive-analysis',
    our: our.nmId,
    ourName: our.name || null,
    periods: cc.periods || null,
    rivalsCount: rivals.length,
    rivals: rivals.map((a) => ({ nmId: a.nmId, name: a.name || null, brand: a.brand || null })),
    funnel: { stages, bottleneck },
    price: { ...priceMed, tier: priceTier },
    quality,
    searchPosition,
    trend,
    findings,
    recommendations,
  };
}

// Рекомендации, привязанные к слабому этапу воронки.
const STAGE_ADVICE = {
  ctrPct: 'Низкий CTR — работать над главным фото, заголовком и первой ценой в выдаче (кликабельность карточки).',
  cartConvPct: 'Проседает конверсия в корзину — усилить контент карточки (фото/инфографика/описание) и цену относительно конкурентов.',
  orderConvPct: 'Проседает конверсия в заказ — проверить цену, отзывы, сроки доставки и наличие размеров/остатков.',
  buyoutPct: 'Низкий процент выкупа — качество товара/соответствие карточке, размерная сетка, упаковка (снижают возвраты).',
};

function deriveInsights({ stages, bottleneck, priceMed, priceTier, quality, searchPosition, trend }) {
  const findings = [];
  const recommendations = [];
  const push = (severity, area, message) => findings.push({ severity, area, message });

  // Воронка: сильные и слабые этапы.
  for (const s of stages) {
    if (s.status === 'weak' && isNum(s.gapToMedianPct)) {
      push('warn', 'funnel', `${s.label}: ${fmtNum(s.our)}${s.unit} — ниже медианы конкурентов на ${Math.abs(s.gapToMedianPct)}%.`);
    } else if (s.status === 'strong' && isNum(s.gapToMedianPct)) {
      push('good', 'funnel', `${s.label}: ${fmtNum(s.our)}${s.unit} — выше медианы конкурентов на ${Math.abs(s.gapToMedianPct)}%.`);
    }
  }
  if (bottleneck) {
    const b = stages.find((s) => s.key === bottleneck);
    push('critical', 'bottleneck', `Главное узкое место воронки — «${b.label}» (наибольшее отставание).`);
    if (STAGE_ADVICE[bottleneck]) recommendations.push(STAGE_ADVICE[bottleneck]);
  } else {
    push('good', 'funnel', 'По воронке мы не ниже медианы конкурентов ни на одном этапе.');
  }

  // Цена.
  const tierText = { premium: 'премиальном', mid: 'среднем', budget: 'бюджетном' }[priceTier];
  if (priceMed.our != null) {
    push('info', 'price', `Цена ${fmtNum(priceMed.our)} — в ${tierText} сегменте (медиана конкурентов ${fmtNum(priceMed.rivalsMedian)}).`);
    if (priceTier === 'premium') {
      recommendations.push('Мы дороже большинства конкурентов — премиум-позиция оправдана только сильной карточкой/отзывами; иначе рассмотреть цену.');
    } else if (priceTier === 'budget') {
      recommendations.push('Мы дешевле большинства конкурентов — есть запас поднять цену/маржу, если воронка не страдает.');
    }
  }

  // Качество.
  if (quality.reviewCount.status === 'weak') {
    push('warn', 'quality', `Мало отзывов (${fmtNum(quality.reviewCount.our)}) относительно конкурентов — доверие к карточке ниже.`);
    recommendations.push('Наращивать отзывы: работа с первыми покупателями, акции на отзыв, отработка негатива.');
  }
  if (quality.reviewRating.status === 'weak') {
    push('warn', 'quality', `Рейтинг по отзывам (${fmtNum(quality.reviewRating.our)}) ниже конкурентов — риск для конверсии.`);
  }

  // Позиция в поиске.
  if (searchPosition.our != null && searchPosition.status === 'weak') {
    push('warn', 'search', `Средняя позиция в поиске (${fmtNum(searchPosition.our)}) хуже конкурентов — ниже видимость.`);
    recommendations.push('Поднимать видимость в поиске: SEO карточки (ключевые слова в заголовке/характеристиках), реклама, буст продаж.');
  }

  // Тренд.
  if (trend) {
    const dropping = trend.filter((t) => isNum(t.deltaPct) && t.deltaPct < -5);
    const growing = trend.filter((t) => isNum(t.deltaPct) && t.deltaPct > 5);
    for (const t of dropping) push('warn', 'trend', `${t.label} падает: ${fmtNum(t.previous)} → ${fmtNum(t.current)} (${t.deltaPct}%).`);
    for (const t of growing) push('good', 'trend', `${t.label} растёт: ${fmtNum(t.previous)} → ${fmtNum(t.current)} (+${t.deltaPct}%).`);
  }

  return { findings, recommendations };
}

const fmtNum = (v) => (isNum(v) ? String(v) : '—');

// ── человекочитаемый отчёт (markdown) ─────────────────────────────────────────
const STATUS_ICON = { strong: '🟢', ok: '🟡', weak: '🔴', unknown: '⚪' };
const SEV_ICON = { critical: '⛔', warn: '⚠️', good: '✅', info: 'ℹ️' };

/**
 * Форматирует анализ в markdown-отчёт (для stdout/файла/чата).
 * @param {object} a  результат competitiveAnalysis
 */
export function formatReport(a) {
  const L = [];
  L.push(`# Конкурентный анализ — наш артикул ${a.our}${a.ourName ? ` (${a.ourName})` : ''}`);
  if (a.periods?.current) {
    const p = a.periods;
    L.push(`Период: ${p.current.from}…${p.current.to}${p.previous ? ` (пред.: ${p.previous.from}…${p.previous.to})` : ''}`);
  }
  L.push(`Конкурентов в сравнении: ${a.rivalsCount}`);
  L.push('');

  // Воронка.
  L.push('## Воронка (наш vs конкуренты)');
  L.push('| Этап | Наш | Медиана рив. | Лучший рив. | Разрыв к медиане | Статус |');
  L.push('|---|---:|---:|---:|---:|:--:|');
  for (const s of a.funnel.stages) {
    const gap = isNum(s.gapToMedianPct) ? `${s.gapToMedianPct > 0 ? '+' : ''}${s.gapToMedianPct}%` : '—';
    L.push(`| ${s.label} | ${fmtNum(s.our)}${s.unit} | ${fmtNum(s.rivalsMedian)}${s.unit} | ${fmtNum(s.rivalsBest)}${s.unit} | ${gap} | ${STATUS_ICON[s.status]} |`);
  }
  if (a.funnel.bottleneck) {
    const b = a.funnel.stages.find((s) => s.key === a.funnel.bottleneck);
    L.push('');
    L.push(`**Узкое место:** ${b.label}.`);
  }
  L.push('');

  // Цена и качество.
  L.push('## Позиционирование');
  const tierText = { premium: 'премиум', mid: 'средний', budget: 'бюджет' }[a.price.tier] || a.price.tier;
  L.push(`- **Цена:** ${fmtNum(a.price.our)} — сегмент «${tierText}» (медиана конкурентов ${fmtNum(a.price.rivalsMedian)}).`);
  L.push(`- **Рейтинг карточки:** ${fmtNum(a.quality.cardRating.our)} ${STATUS_ICON[a.quality.cardRating.status]} (медиана ${fmtNum(a.quality.cardRating.rivalsMedian)}).`);
  L.push(`- **Рейтинг по отзывам:** ${fmtNum(a.quality.reviewRating.our)} ${STATUS_ICON[a.quality.reviewRating.status]} (медиана ${fmtNum(a.quality.reviewRating.rivalsMedian)}).`);
  L.push(`- **Отзывов:** ${fmtNum(a.quality.reviewCount.our)} ${STATUS_ICON[a.quality.reviewCount.status]} (медиана ${fmtNum(a.quality.reviewCount.rivalsMedian)}).`);
  L.push(`- **Позиция в поиске:** ${fmtNum(a.searchPosition.our)} ${STATUS_ICON[a.searchPosition.status]} (медиана ${fmtNum(a.searchPosition.rivalsMedian)}, меньше — лучше).`);
  L.push('');

  // Тренд.
  if (a.trend) {
    L.push('## Тренд период-к-периоду (наша воронка)');
    L.push('| Этап | Было | Стало | Δ |');
    L.push('|---|---:|---:|---:|');
    for (const t of a.trend) {
      const d = isNum(t.deltaPct) ? `${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}%` : '—';
      L.push(`| ${t.label} | ${fmtNum(t.previous)} | ${fmtNum(t.current)} | ${d} |`);
    }
    L.push('');
  }

  // Выводы.
  if (a.findings.length) {
    L.push('## Выводы');
    for (const f of a.findings) L.push(`- ${SEV_ICON[f.severity] || '•'} ${f.message}`);
    L.push('');
  }
  // Рекомендации.
  if (a.recommendations.length) {
    L.push('## Рекомендации');
    a.recommendations.forEach((r, i) => L.push(`${i + 1}. ${r}`));
    L.push('');
  }

  return L.join('\n');
}

// Экспортируем помощники для тестов/оркестратора.
export { median, compareMetric };
