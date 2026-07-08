// lib/wbUnitCalc.js — ядро Юнит-калькулятора для товаров на Wildberries.
//
// Модель подтверждена пользователем (см. .claude/skills/wb-competitor-analysis/
// references/analysis-workflow.md, раздел «Юнит-экономика»). Здесь она вынесена
// в самостоятельный, переиспользуемый модуль — то же ядро, что в блоке C движка [3].
//
// Две цены на карточку:
//   S — цена ПРОДАВЦА без СПП (наша база маржи и комиссии).
//   P — цена ПОКУПАТЕЛЯ с СПП (витрина, как в MPStats).  P = S·(1−СПП) ⇔ S = P/(1−СПП).
//
// Статьи на единицу:
//   Комиссия ВБ (до СПП)         35,7%  от S
//   Эквайринг                     4,7%  от P (с СПП)
//   Налог                         2%    от P (с СПП)
//   ДРР (запуск / выход)          30% / 8%  от P (с СПП)
//   Брак                          2,5%  от себестоимости C
//   Логистика + хранение          0     (индивидуальные условия; можно переопределить, ₽/ед)
//   Себестоимость                 C     (спрашиваем каждый раз)
//
//   Прибыль = S − ком·S − (эквайр+налог+ДРР)·P − брак·C − C − (логистика+хранение)
//           = S·k − C·(1+брак) − fixed,   k = 1 − ком − (эквайр+налог+ДРР)·(1−СПП)
//   Маржа % = Прибыль / S
//   Цена под целевую маржу m:  S = [C·(1+брак)+fixed] / (k − m),  P = S·(1−СПП)
//
// Выкуп 36% — НЕ статья затрат (логистика 0). Служит только для оценки объёма
// (MPStats-«продажи» ≈ заказы, реально выкуплено ≈ заказы × выкуп%).

export const ECON_DEFAULTS = {
  commission: 0.357, // комиссия ВБ, от S (до СПП)
  spp: 0.04,         // средняя СПП
  acquiring: 0.047,  // эквайринг, от P (с СПП)
  tax: 0.02,         // налог, от P (с СПП)
  drr_launch: 0.30,  // ДРР в фазе запуска
  drr_steady: 0.08,  // ДРР на выходе (рабочий режим)
  defect: 0.025,     // брак, от себестоимости
  redemption: 0.36,  // выкуп (только для оценки объёма, не затрата)
  logistics: 0,      // ₽/ед (общий вид; у нас 0 — индивидуальные условия)
  storage: 0,        // ₽/ед
  m_min: 0.25,       // целевой коридор маржи, низ
  m_max: 0.30,       // целевой коридор маржи, верх
};

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Слить дефолты с переопределениями (null/undefined игнорируются). */
export function econParams(over = {}) {
  const p = { ...ECON_DEFAULTS };
  for (const [k, v] of Object.entries(over)) if (v != null) p[k] = num(v);
  return p;
}

/** Коэффициент k = 1 − ком − (эквайр+налог+ДРР)·(1−СПП). */
function kOf(pr, drr) {
  return 1 - pr.commission - (pr.acquiring + pr.tax + drr) * (1 - pr.spp);
}

/**
 * Полная раскладка экономики на единицу при цене покупателя P (с СПП) и данном ДРР.
 * Возвращает все статьи в ₽ + операционную прибыль и маржу.
 */
export function unitCalc(P_buyer, cost, pr, drr) {
  const P = num(P_buyer);
  const C = num(cost);
  const S = 1 - pr.spp ? P / (1 - pr.spp) : P; // цена продавца без СПП
  const spp = S - P; // «скидка постоянного покупателя» в ₽ (недополученное с витрины)
  const commission = pr.commission * S;
  const acquiring = pr.acquiring * P;
  const tax = pr.tax * P;
  const ad = drr * P;
  const defect = pr.defect * C;
  const fixed = pr.logistics + pr.storage;
  const profit = S - commission - acquiring - tax - ad - defect - C - fixed;
  return {
    P, S, spp, drr,
    commission, acquiring, tax, ad, defect, cost: C, fixed,
    profit,
    margin: S ? profit / S : 0,
    // «наценка» к себестоимости и рентабельность вложений в товар — популярные метрики
    markup: C ? profit / C : 0,
  };
}

/** Маржа при заданной витринной цене P и ДРР (удобная обёртка). */
export function marginForBuyerPrice(P_buyer, cost, pr, drr) {
  return unitCalc(P_buyer, cost, pr, drr).margin;
}

/**
 * Витринная цена P (с СПП), при которой маржа = m при данном ДРР.
 * null — недостижимо (знаменатель ≤ 0: расходы съедают всю маржу).
 */
export function priceBuyerForMargin(cost, pr, m, drr) {
  const k = kOf(pr, drr);
  const fixedC = num(cost) * (1 + pr.defect) + pr.logistics + pr.storage;
  const denom = k - m;
  if (denom <= 0) return null;
  const S = fixedC / denom;
  return S * (1 - pr.spp);
}

/**
 * Витринная цена P (с СПП) под заданную операционную прибыль на единицу (₽).
 * null — недостижимо (k ≤ 0).
 */
export function priceBuyerForProfit(cost, pr, profit, drr) {
  const k = kOf(pr, drr);
  if (k <= 0) return null;
  const fixedC = num(cost) * (1 + pr.defect) + pr.logistics + pr.storage;
  const S = (num(profit) + fixedC) / k;
  return S * (1 - pr.spp);
}

/**
 * Таблица чувствительности по цене: набор витринных цен вокруг базовой →
 * прибыль/маржа при текущем ДРР. Если базовой цены нет — строим от безубыточности.
 */
export function priceSensitivity(basePrice, cost, pr, drr, steps = [-0.2, -0.1, 0, 0.1, 0.2]) {
  const base = num(basePrice) || priceBuyerForMargin(cost, pr, pr.m_min, drr) || 0;
  return steps.map((s) => {
    const P = base * (1 + s);
    const u = unitCalc(P, cost, pr, drr);
    return { delta: s, P, S: u.S, profit: u.profit, margin: u.margin };
  });
}

/** Таблица чувствительности по ДРР при фиксированной витринной цене. */
export function drrSensitivity(price, cost, pr, drrList = [0, 0.05, 0.08, 0.15, 0.2, 0.3]) {
  return drrList.map((d) => {
    const u = unitCalc(price, cost, pr, d);
    return { drr: d, profit: u.profit, margin: u.margin };
  });
}

/**
 * Полный расчёт для калькулятора.
 * @param {object} a
 *   price        витринная цена P (с СПП). Необязательна, если задан sellerPrice.
 *   sellerPrice  цена продавца S (без СПП) — альтернатива price.
 *   cost         себестоимость C (₽), обязательна.
 *   pr           параметры (econParams()).
 *   drr          «текущий» ДРР для основной раскладки (дефолт pr.drr_steady).
 *   targetMargin целевая маржа (доля) для обратного расчёта — опционально.
 *   targetProfit целевая опер. прибыль на единицу (₽) — опционально.
 *   units        кол-во проданных единиц за период — для прогноза заработка (опц.).
 */
export function analyze(a) {
  const pr = a.pr || econParams();
  const cost = num(a.cost);
  const drr = a.drr != null ? num(a.drr) : pr.drr_steady;

  // Витринная цена: из price (P) или из sellerPrice (S → P).
  let price = a.price != null ? num(a.price) : null;
  if (price == null && a.sellerPrice != null) price = num(a.sellerPrice) * (1 - pr.spp);

  const unit = price != null ? unitCalc(price, cost, pr, drr) : null;
  const launch = price != null ? unitCalc(price, cost, pr, pr.drr_launch) : null;

  const corridor = {
    lo: priceBuyerForMargin(cost, pr, pr.m_min, drr),
    hi: priceBuyerForMargin(cost, pr, pr.m_max, drr),
  };
  // Маржа в фазе запуска при ценах целевого коридора (инвест-период).
  const launchAtCorridor = {
    lo: corridor.lo != null ? unitCalc(corridor.lo, cost, pr, pr.drr_launch).margin : null,
    hi: corridor.hi != null ? unitCalc(corridor.hi, cost, pr, pr.drr_launch).margin : null,
  };
  const breakeven = priceBuyerForMargin(cost, pr, 0, drr);
  const breakevenLaunch = priceBuyerForMargin(cost, pr, 0, pr.drr_launch);

  // Обратный расчёт (если заданы цели).
  let reverse = null;
  if (a.targetMargin != null || a.targetProfit != null) {
    reverse = {};
    if (a.targetMargin != null) {
      const m = num(a.targetMargin);
      const P = priceBuyerForMargin(cost, pr, m, drr);
      reverse.margin = { target: m, price: P, unit: P != null ? unitCalc(P, cost, pr, drr) : null };
    }
    if (a.targetProfit != null) {
      const x = num(a.targetProfit);
      const P = priceBuyerForProfit(cost, pr, x, drr);
      reverse.profit = { target: x, price: P, unit: P != null ? unitCalc(P, cost, pr, drr) : null };
    }
  }

  // Прогноз за период (если известно кол-во проданных единиц).
  let period = null;
  if (a.units != null && unit) {
    const units = num(a.units);
    period = {
      units,
      profit: unit.profit * units,
      revenue: unit.S * units,          // выручка продавца (без СПП)
      revenueBuyer: unit.P * units,     // оборот по витрине (с СПП)
    };
  }

  return {
    input: { price, cost, drr },
    pr,
    unit, launch,
    corridor, launchAtCorridor, breakeven, breakevenLaunch,
    reverse, period,
    sensitivity: {
      price: priceSensitivity(price, cost, pr, drr),
      drr: price != null ? drrSensitivity(price, cost, pr) : null,
    },
  };
}

// ───────────────────────── форматирование ─────────────────────────

const RU = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export const fmtRub = (v) => (v == null || !Number.isFinite(v) ? '—' : `${RU.format(Math.round(v))} ₽`);
export const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`);
const fmtPct1 = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);

/** Текстовый отчёт для stdout. */
export function formatText(res, meta = {}) {
  const { pr, unit } = res;
  const L = [];
  const title = meta.title || 'ЮНИТ-КАЛЬКУЛЯТОР WB';
  L.push('='.repeat(58));
  L.push(`  ${title}`);
  if (meta.subtitle) L.push(`  ${meta.subtitle}`);
  L.push('='.repeat(58));
  L.push('');
  L.push(`Параметры: комиссия ${fmtPct1(pr.commission)} (от S) · СПП ${fmtPct(pr.spp)} · `
    + `эквайринг ${fmtPct1(pr.acquiring)} · налог ${fmtPct(pr.tax)} · брак ${fmtPct1(pr.defect)}`);
  const fixed = pr.logistics + pr.storage;
  if (fixed) L.push(`Логистика+хранение: ${fmtRub(fixed)}/ед`);
  L.push(`ДРР: запуск ${fmtPct(pr.drr_launch)} · выход ${fmtPct(pr.drr_steady)}` +
    (res.input.drr !== pr.drr_steady ? ` · текущий ${fmtPct(res.input.drr)}` : ''));
  L.push(`Себестоимость C: ${fmtRub(res.input.cost)}`);
  L.push('');

  // 1. Раскладка на единицу.
  if (unit) {
    L.push(`── 1. РАСКЛАДКА НА ЕДИНИЦУ (ДРР ${fmtPct(unit.drr)}) ──`);
    L.push(`Цена на витрине (с СПП)  P = ${fmtRub(unit.P)}`);
    L.push(`Цена продавца (без СПП)  S = ${fmtRub(unit.S)}`);
    L.push('');
    const row = (name, val, extra = '') => L.push(`  ${name.padEnd(26)} −${fmtRub(val).padStart(9)}  ${extra}`);
    row('Комиссия ВБ', unit.commission, `${fmtPct1(pr.commission)} от S`);
    row('Эквайринг', unit.acquiring, `${fmtPct1(pr.acquiring)} от P`);
    row('Налог', unit.tax, `${fmtPct(pr.tax)} от P`);
    row('Реклама (ДРР)', unit.ad, `${fmtPct(unit.drr)} от P`);
    row('Брак', unit.defect, `${fmtPct1(pr.defect)} от C`);
    if (unit.fixed) row('Логистика+хранение', unit.fixed, '₽/ед');
    row('Себестоимость', unit.cost, '');
    L.push('  ' + '-'.repeat(48));
    const sign = unit.profit >= 0 ? '' : '−';
    L.push(`  ${'ОПЕР. ПРИБЫЛЬ'.padEnd(26)} ${(sign + fmtRub(Math.abs(unit.profit))).padStart(10)}`);
    L.push(`  ${'МАРЖА (прибыль / S)'.padEnd(26)} ${fmtPct1(unit.margin).padStart(10)}`);
    L.push(`  ${'Рентабельность к C'.padEnd(26)} ${fmtPct(unit.markup).padStart(10)}`);
    L.push('');
  }

  // 2. Коридор и безубыточность.
  L.push('── 2. ЦЕНОВОЙ КОРИДОР И БЕЗУБЫТОЧНОСТЬ ──');
  const cor = res.corridor;
  if (cor.lo != null && cor.hi != null) {
    L.push(`Целевая маржа ${fmtPct(pr.m_min)}–${fmtPct(pr.m_max)} → витрина ${fmtRub(cor.lo)}–${fmtRub(cor.hi)}`);
    const la = res.launchAtCorridor;
    if (la.lo != null) L.push(`  в фазе запуска (ДРР ${fmtPct(pr.drr_launch)}) маржа в коридоре: ${fmtPct(la.lo)}…${fmtPct(la.hi)} (инвест-период)`);
  } else {
    L.push(`Целевая маржа ${fmtPct(pr.m_min)}–${fmtPct(pr.m_max)} недостижима при этих параметрах.`);
  }
  L.push(`Точка безубыточности (ДРР ${fmtPct(res.input.drr)}): ${fmtRub(res.breakeven)} — ниже этой витринной цены торговля в минус.`);
  L.push(`  в фазе запуска (ДРР ${fmtPct(pr.drr_launch)}): ${fmtRub(res.breakevenLaunch)}`);
  L.push('');

  // 3. Обратный расчёт.
  if (res.reverse) {
    L.push('── 3. ОБРАТНЫЙ РАСЧЁТ ──');
    if (res.reverse.margin) {
      const r = res.reverse.margin;
      L.push(`Под маржу ${fmtPct(r.target)} → витрина ${fmtRub(r.price)}` +
        (r.unit ? ` (S ${fmtRub(r.unit.S)}, прибыль ${fmtRub(r.unit.profit)}/ед)` : ' — недостижимо'));
    }
    if (res.reverse.profit) {
      const r = res.reverse.profit;
      L.push(`Под прибыль ${fmtRub(r.target)}/ед → витрина ${fmtRub(r.price)}` +
        (r.unit ? ` (S ${fmtRub(r.unit.S)}, маржа ${fmtPct1(r.unit.margin)})` : ' — недостижимо'));
    }
    L.push('');
  }

  // 4. Чувствительность.
  if (unit) {
    L.push('── 4. ЧУВСТВИТЕЛЬНОСТЬ ──');
    L.push('  По цене (текущий ДРР):');
    L.push(`    ${'витрина'.padStart(10)} ${'S'.padStart(9)} ${'прибыль'.padStart(9)} ${'маржа'.padStart(7)}`);
    for (const r of res.sensitivity.price) {
      const tag = r.delta === 0 ? ' ←' : '';
      L.push(`    ${fmtRub(r.P).padStart(10)} ${fmtRub(r.S).padStart(9)} ${fmtRub(r.profit).padStart(9)} ${fmtPct(r.margin).padStart(7)}${tag}`);
    }
    if (res.sensitivity.drr) {
      L.push('  По ДРР (текущая витринная цена):');
      L.push(`    ${'ДРР'.padStart(6)} ${'прибыль'.padStart(9)} ${'маржа'.padStart(7)}`);
      for (const r of res.sensitivity.drr) {
        L.push(`    ${fmtPct(r.drr).padStart(6)} ${fmtRub(r.profit).padStart(9)} ${fmtPct(r.margin).padStart(7)}`);
      }
    }
    L.push('');
  }

  // Прогноз за период.
  if (res.period) {
    L.push('── ПРОГНОЗ ЗА ПЕРИОД ──');
    L.push(`${RU.format(res.period.units)} ед → опер. прибыль ${fmtRub(res.period.profit)}, `
      + `выручка продавца ${fmtRub(res.period.revenue)} (оборот по витрине ${fmtRub(res.period.revenueBuyer)})`);
    L.push('');
  }
  return L.join('\n');
}

/** Самодостаточный HTML-отчёт. */
export function formatHtml(res, meta = {}) {
  const { pr, unit } = res;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const title = esc(meta.title || 'Юнит-калькулятор WB');
  const sub = meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : '';

  const artRows = unit ? [
    ['Комиссия ВБ', unit.commission, `${fmtPct1(pr.commission)} от S`],
    ['Эквайринг', unit.acquiring, `${fmtPct1(pr.acquiring)} от P`],
    ['Налог', unit.tax, `${fmtPct(pr.tax)} от P`],
    ['Реклама (ДРР)', unit.ad, `${fmtPct(unit.drr)} от P`],
    ['Брак', unit.defect, `${fmtPct1(pr.defect)} от C`],
    ...(unit.fixed ? [['Логистика+хранение', unit.fixed, '₽/ед']] : []),
    ['Себестоимость', unit.cost, ''],
  ].map(([n, v, x]) => `<tr><td>${n}</td><td class="r neg">−${fmtRub(v)}</td><td class="s">${x}</td></tr>`).join('') : '';

  const cor = res.corridor;
  const corTxt = cor.lo != null && cor.hi != null
    ? `<b class="g">${fmtRub(cor.lo)} – ${fmtRub(cor.hi)}</b>`
    : '<span class="s">недостижимо</span>';
  const la = res.launchAtCorridor;
  const laTxt = la.lo != null ? `в запуске (ДРР ${fmtPct(pr.drr_launch)}): маржа ${fmtPct(la.lo)}…${fmtPct(la.hi)}` : '';

  const priceSens = res.sensitivity.price.map((r) =>
    `<tr class="${r.delta === 0 ? 'hl' : ''}"><td class="r">${fmtRub(r.P)}</td><td class="r">${fmtRub(r.S)}</td>`
    + `<td class="r ${r.profit < 0 ? 'neg' : 'pos'}">${fmtRub(r.profit)}</td><td class="r">${fmtPct(r.margin)}</td></tr>`).join('');
  const drrSens = res.sensitivity.drr ? res.sensitivity.drr.map((r) =>
    `<tr><td class="r">${fmtPct(r.drr)}</td><td class="r ${r.profit < 0 ? 'neg' : 'pos'}">${fmtRub(r.profit)}</td>`
    + `<td class="r">${fmtPct(r.margin)}</td></tr>`).join('') : '';

  let revHtml = '';
  if (res.reverse) {
    const parts = [];
    if (res.reverse.margin) {
      const r = res.reverse.margin;
      parts.push(`<li>Под маржу <b>${fmtPct(r.target)}</b> → витрина <b class="g">${fmtRub(r.price)}</b>`
        + (r.unit ? ` <span class="s">(S ${fmtRub(r.unit.S)}, прибыль ${fmtRub(r.unit.profit)}/ед)</span>` : ' — недостижимо') + '</li>');
    }
    if (res.reverse.profit) {
      const r = res.reverse.profit;
      parts.push(`<li>Под прибыль <b>${fmtRub(r.target)}</b>/ед → витрина <b class="g">${fmtRub(r.price)}</b>`
        + (r.unit ? ` <span class="s">(S ${fmtRub(r.unit.S)}, маржа ${fmtPct1(r.unit.margin)})</span>` : ' — недостижимо') + '</li>');
    }
    revHtml = `<section><h2>3. Обратный расчёт</h2><ul>${parts.join('')}</ul></section>`;
  }

  const periodHtml = res.period ? `<section><h2>Прогноз за период</h2>
    <p><b>${RU.format(res.period.units)} ед</b> → опер. прибыль <b class="${res.period.profit < 0 ? 'neg' : 'g'}">${fmtRub(res.period.profit)}</b>,
    выручка продавца ${fmtRub(res.period.revenue)} <span class="s">(оборот по витрине ${fmtRub(res.period.revenueBuyer)})</span></p></section>` : '';

  const unitHtml = unit ? `<section><h2>1. Раскладка на единицу <span class="s">(ДРР ${fmtPct(unit.drr)})</span></h2>
    <div class="prices"><div><span class="s">Витрина (с СПП) P</span><b>${fmtRub(unit.P)}</b></div>
      <div><span class="s">Продавец (без СПП) S</span><b>${fmtRub(unit.S)}</b></div></div>
    <table class="art"><tbody>${artRows}
      <tr class="tot"><td>Опер. прибыль</td><td class="r ${unit.profit < 0 ? 'neg' : 'g'}">${fmtRub(unit.profit)}</td><td class="s"></td></tr>
      <tr class="tot"><td>Маржа (прибыль / S)</td><td class="r">${fmtPct1(unit.margin)}</td><td class="s"></td></tr>
      <tr><td>Рентабельность к C</td><td class="r">${fmtPct(unit.markup)}</td><td class="s"></td></tr>
    </tbody></table></section>` : '';

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--g:#0a7d3c;--r:#c0392b;--bg:#fff}
  *{box-sizing:border-box}
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px;max-width:820px;margin:0 auto}
  h1{font-size:22px;margin:0 0 2px}
  h2{font-size:16px;margin:0 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}
  .sub{color:var(--mut);margin-bottom:4px}
  .params{color:var(--mut);font-size:13px;margin:8px 0 20px}
  section{margin:0 0 22px}
  table{border-collapse:collapse;width:100%}
  td,th{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left}
  .r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .s{color:var(--mut);font-size:13px}
  .neg{color:var(--r)} .pos{color:var(--fg)} .g{color:var(--g);font-weight:700}
  .art .tot td{font-weight:700;border-top:2px solid var(--fg);border-bottom:none}
  .prices{display:flex;gap:32px;margin:0 0 14px}
  .prices b{display:block;font-size:20px}
  tr.hl{background:#f0f9f2;font-weight:700}
  .grid2{display:flex;gap:24px;flex-wrap:wrap}
  .grid2>div{flex:1;min-width:260px}
  .callout{background:#f7f8fa;border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0}
  .callout b{font-size:17px}
  footer{color:var(--mut);font-size:12px;margin-top:24px;border-top:1px solid var(--line);padding-top:10px}
</style></head><body>
<h1>${title}</h1>${sub}
<div class="params">Комиссия ${fmtPct1(pr.commission)} (от S) · СПП ${fmtPct(pr.spp)} · эквайринг ${fmtPct1(pr.acquiring)} · налог ${fmtPct(pr.tax)} · брак ${fmtPct1(pr.defect)} · ДРР запуск/выход ${fmtPct(pr.drr_launch)}/${fmtPct(pr.drr_steady)} · себестоимость ${fmtRub(res.input.cost)}${pr.logistics + pr.storage ? ` · логистика+хранение ${fmtRub(pr.logistics + pr.storage)}/ед` : ''}</div>
${unitHtml}
<section><h2>2. Ценовой коридор и безубыточность</h2>
  <div class="callout">Целевая маржа ${fmtPct(pr.m_min)}–${fmtPct(pr.m_max)} → витрина ${corTxt}${laTxt ? `<div class="s">${laTxt} — инвест-период</div>` : ''}</div>
  <div class="grid2">
    <div class="callout">Точка безубыточности <span class="s">(ДРР ${fmtPct(res.input.drr)})</span><br><b>${fmtRub(res.breakeven)}</b><div class="s">ниже — торговля в минус</div></div>
    <div class="callout">Безубыточность в запуске <span class="s">(ДРР ${fmtPct(pr.drr_launch)})</span><br><b>${fmtRub(res.breakevenLaunch)}</b></div>
  </div>
</section>
${revHtml}
${unit ? `<section><h2>4. Чувствительность</h2><div class="grid2">
  <div><div class="s" style="margin-bottom:4px">По цене (текущий ДРР ${fmtPct(res.input.drr)})</div>
    <table><thead><tr><th class="r">Витрина</th><th class="r">S</th><th class="r">Прибыль</th><th class="r">Маржа</th></tr></thead><tbody>${priceSens}</tbody></table></div>
  <div><div class="s" style="margin-bottom:4px">По ДРР (витрина ${fmtRub(unit.P)})</div>
    <table><thead><tr><th class="r">ДРР</th><th class="r">Прибыль</th><th class="r">Маржа</th></tr></thead><tbody>${drrSens}</tbody></table></div>
</div></section>` : ''}
${periodHtml}
<footer>Модель: S — цена продавца без СПП, P — витрина с СПП (P = S·(1−СПП)). Комиссия от S; эквайринг/налог/ДРР от P; брак от себестоимости; логистика+хранение — индивидуальны. Маржа = опер. прибыль / S. Выкуп — оценка объёма, не затрата.</footer>
</body></html>`;
}
