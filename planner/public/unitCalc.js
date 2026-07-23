// unitCalc.js — ядро Юнит-калькулятора WB (браузерный ESM, без зависимостей).
// Портировано из скилла wb-unit-calc (lib/wbUnitCalc.js). МОДЕЛЬ ПОДТВЕРЖДЕНА
// пользователем — не менять без запроса. Здесь оставлена только математика ядра;
// презентацию (таблицы/раскладку) строит app.js средствами вкладки.
//
// Две цены на карточку:
//   S — цена ПРОДАВЦА без СПП (база маржи и комиссии).
//   P — цена ПОКУПАТЕЛЯ с СПП (витрина, как в MPStats).  P = S·(1−СПП).
//
//   Прибыль = S − ком·S − (эквайр+налог+ДРР)·P − брак·C − C − (логистика+хранение)
//           = S·k − C·(1+брак) − fixed,   k = 1 − ком − (эквайр+налог+ДРР)·(1−СПП)
//   Маржа % = Прибыль / S
//   Цена под маржу m:  S = [C·(1+брак)+fixed] / (k − m),  P = S·(1−СПП)
//
// Выкуп 36% — НЕ статья затрат (логистика 0), только для оценки объёма.

export const ECON_DEFAULTS = {
  commission: 0.357, // комиссия ВБ, от S (до СПП)
  spp: 0.04,         // средняя СПП
  acquiring: 0.047,  // эквайринг, от P (с СПП)
  tax: 0.02,         // налог, от P (с СПП)
  drr_launch: 0.30,  // ДРР в фазе запуска
  drr_steady: 0.08,  // ДРР на выходе (рабочий режим)
  defect: 0.025,     // брак, от себестоимости
  redemption: 0.36,  // выкуп (только для оценки объёма, не затрата)
  logistics: 0,      // ₽/ед (индивидуальные условия)
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

/** Полная раскладка экономики на единицу при цене покупателя P (с СПП) и данном ДРР. */
export function unitCalc(P_buyer, cost, pr, drr) {
  const P = num(P_buyer);
  const C = num(cost);
  const S = 1 - pr.spp ? P / (1 - pr.spp) : P; // цена продавца без СПП
  const spp = S - P; // недополученное с витрины (СПП, ₽)
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
    markup: C ? profit / C : 0,
  };
}

/** Маржа при заданной витринной цене P и ДРР. */
export function marginForBuyerPrice(P_buyer, cost, pr, drr) {
  return unitCalc(P_buyer, cost, pr, drr).margin;
}

/** Витринная цена P (с СПП), при которой маржа = m. null — недостижимо. */
export function priceBuyerForMargin(cost, pr, m, drr) {
  const k = kOf(pr, drr);
  const fixedC = num(cost) * (1 + pr.defect) + pr.logistics + pr.storage;
  const denom = k - m;
  if (denom <= 0) return null;
  return (fixedC / denom) * (1 - pr.spp);
}

/** Витринная цена P (с СПП) под заданную опер. прибыль на единицу (₽). null — недостижимо. */
export function priceBuyerForProfit(cost, pr, profit, drr) {
  const k = kOf(pr, drr);
  if (k <= 0) return null;
  const fixedC = num(cost) * (1 + pr.defect) + pr.logistics + pr.storage;
  return ((num(profit) + fixedC) / k) * (1 - pr.spp);
}

/** Чувствительность по цене: набор витринных цен вокруг базовой → прибыль/маржа. */
export function priceSensitivity(basePrice, cost, pr, drr, steps = [-0.2, -0.1, 0, 0.1, 0.2]) {
  const base = num(basePrice) || priceBuyerForMargin(cost, pr, pr.m_min, drr) || 0;
  return steps.map((s) => {
    const P = base * (1 + s);
    const u = unitCalc(P, cost, pr, drr);
    return { delta: s, P, S: u.S, profit: u.profit, margin: u.margin };
  });
}

/** Чувствительность по ДРР при фиксированной витринной цене. */
export function drrSensitivity(price, cost, pr, drrList = [0, 0.05, 0.08, 0.15, 0.2, 0.3]) {
  return drrList.map((d) => {
    const u = unitCalc(price, cost, pr, d);
    return { drr: d, profit: u.profit, margin: u.margin };
  });
}

/**
 * Полный расчёт для калькулятора.
 * @param {object} a  price(P,с СПП)|sellerPrice(S), cost(C), pr(econParams()), drr,
 *                    targetMargin(доля), targetProfit(₽), units(для прогноза).
 */
export function analyze(a) {
  const pr = a.pr || econParams();
  const cost = num(a.cost);
  const drr = a.drr != null ? num(a.drr) : pr.drr_steady;

  let price = a.price != null ? num(a.price) : null;
  if (price == null && a.sellerPrice != null) price = num(a.sellerPrice) * (1 - pr.spp);

  const unit = price != null ? unitCalc(price, cost, pr, drr) : null;
  const launch = price != null ? unitCalc(price, cost, pr, pr.drr_launch) : null;

  const corridor = {
    lo: priceBuyerForMargin(cost, pr, pr.m_min, drr),
    hi: priceBuyerForMargin(cost, pr, pr.m_max, drr),
  };
  const launchAtCorridor = {
    lo: corridor.lo != null ? unitCalc(corridor.lo, cost, pr, pr.drr_launch).margin : null,
    hi: corridor.hi != null ? unitCalc(corridor.hi, cost, pr, pr.drr_launch).margin : null,
  };
  const breakeven = priceBuyerForMargin(cost, pr, 0, drr);
  const breakevenLaunch = priceBuyerForMargin(cost, pr, 0, pr.drr_launch);

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

  let period = null;
  if (a.units != null && unit) {
    const units = num(a.units);
    period = {
      units,
      profit: unit.profit * units,
      revenue: unit.S * units,
      revenueBuyer: unit.P * units,
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
