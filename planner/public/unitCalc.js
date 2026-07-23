// unitCalc.js — ядро Юнит-калькулятора WB (браузерный ESM, без зависимостей).
// ПОЛНЫЙ каскадный P&L «на 1 выкуп». Модель согласована с пользователем:
//
//  ЦЕНА (каскад):
//    Базовая ─(−скидка продавца)→ Цена после скидки S   [база комиссии, выплаты, знаменатель маржи]
//    S ─(−СПП)→ после СПП ─(−Кошелёк)→ Конечная цена покупателя Pб  [база эквайринга, налога]
//    СПП и Кошелёк выплату продавцу НЕ уменьшают (выплата считается от S).
//
//  УСЛУГИ ВБ (на 1 выкуп):
//    комиссия=ком%·S; эквайринг=экв%·Pб; реклама=ДРР%·Pб;
//    логистика=(логистика_ПВЗ + обратная·(1−выкуп))/выкуп; хранение=₽/ед;
//    приёмка=коэф·тариф(₽/ед).  ИТОГО услуги ВБ = сумма.
//
//  ИТОГ:
//    Перечисления на р/с = S − услуги ВБ
//    Полная себестоимость = себестоимость + логистика до склада ВБ
//    Налог = налог%·Pб (оборот по конечной цене);  Доп.расходы = доп%·S
//    ВАЛОВАЯ = Перечисления − Полная себестоимость − Налог − Доп.расходы
//    Опер.расходы = opexShare·ВАЛОВАЯ;  ЧИСТАЯ = (1−opexShare)·ВАЛОВАЯ
//    Маржинальность = ЧИСТАЯ / S;  Рентабельность = ЧИСТАЯ / Полная себестоимость
//
// Замкнутая форма: ВАЛОВАЯ = A·S − B, где
//   wf = (1−СПП)(1−кошелёк)
//   A  = 1 − ком − (экв + ДРР + налог)·wf − доп
//   B  = логистика + хранение + приёмка + полная_себестоимость

// Ставки — ДОЛИ (не проценты). ₽-поля — рубли на единицу/заказ.
export const UNIT_DEFAULTS = {
  commission: 0.357, // комиссия ВБ, от S
  spp: 0.04,         // СПП (скидка постоянного покупателя)
  wallet: 0.02,      // скидка WB Кошелёк
  acquiring: 0.047,  // эквайринг, от Pб
  tax: 0.02,         // налог, от Pб (оборот)
  drr_launch: 0.30,  // ДРР запуск, от Pб
  drr_steady: 0.08,  // ДРР выход, от Pб
  extra: 0,          // доп.расходы, от S
  opexShare: 0.5,    // доля валовой прибыли на операционные расходы (остаток — чистая)
  logisticsPvz: 0,   // логистика до ПВЗ, ₽/заказ
  returnLogistics: 0, // обратная логистика, ₽/заказ
  storage: 0,        // хранение, ₽/ед
  acceptanceTariff: 0, // базовый тариф платной приёмки, ₽/ед (× коэффициент)
  m_min: 0.25,       // целевой коридор ВАЛОВОЙ маржи (валовая/S), низ
  m_max: 0.30,       // целевой коридор ВАЛОВОЙ маржи, верх
};

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Слить дефолты с переопределениями (null/undefined игнорируются). */
export function unitParams(over = {}) {
  const p = { ...UNIT_DEFAULTS };
  for (const [k, v] of Object.entries(over)) if (v != null) p[k] = num(v);
  return p;
}

/** Коэффициенты замкнутой формы ВАЛОВАЯ = A·S − B. */
function coeffs(pr, inp) {
  const drr = inp.drr != null ? num(inp.drr) : pr.drr_steady;
  const buyout = Math.max(0.01, num(inp.buyout) || 0.4);
  const wf = (1 - pr.spp) * (1 - pr.wallet);
  const logistics = (pr.logisticsPvz + pr.returnLogistics * (1 - buyout)) / buyout;
  const acceptance = num(inp.acceptanceCoef != null ? inp.acceptanceCoef : 1) * pr.acceptanceTariff;
  const fullCost = num(inp.cost) + num(inp.logisticsToWb);
  const A = 1 - pr.commission - (pr.acquiring + drr + pr.tax) * wf - pr.extra;
  const B = logistics + pr.storage + acceptance + fullCost;
  return { drr, buyout, wf, logistics, acceptance, fullCost, A, B };
}

/** Полная раскладка P&L при цене после скидки S (руб). */
export function unitBreakdown(S_after_discount, pr, inp) {
  const S = num(S_after_discount);
  const c = coeffs(pr, inp);
  const priceAfterSpp = S * (1 - pr.spp);
  const buyerPrice = priceAfterSpp * (1 - pr.wallet); // Pб
  const commission = pr.commission * S;
  const acquiring = pr.acquiring * buyerPrice;
  const ad = c.drr * buyerPrice;
  const wbServices = commission + acquiring + ad + c.logistics + pr.storage + c.acceptance;
  const payout = S - wbServices;
  const tax = pr.tax * buyerPrice;
  const extra = pr.extra * S;
  const gross = payout - c.fullCost - tax - extra; // A·S − B
  const opex = pr.opexShare * gross;
  const net = gross - opex;
  return {
    S, priceAfterSpp, buyerPrice,
    commission, acquiring, ad,
    logistics: c.logistics, storage: pr.storage, acceptance: c.acceptance,
    wbServices, payout,
    cost: num(inp.cost), logisticsToWb: num(inp.logisticsToWb), fullCost: c.fullCost,
    tax, extra, gross, opex, net,
    drr: c.drr, buyout: c.buyout,
    marginGross: S ? gross / S : 0,    // маржинальность = ВАЛОВАЯ / S (от цены до СПП) — основная
    marginNet: S ? net / S : 0,        // чистая маржа = чистая / S (для справки)
    roi: c.fullCost ? net / c.fullCost : 0, // рентабельность = чистая / полная себестоимость
  };
}

/** Цена после скидки S под целевую ВАЛОВУЮ маржу m (валовая/S = m). null — недостижимо. */
export function sForMargin(pr, inp, m) {
  const { A, B } = coeffs(pr, inp);
  const denom = A - m; // gross/S = A − B/S = m ⇒ S = B/(A−m)
  if (denom <= 0) return null;
  return B / denom;
}
/** Цена после скидки S под целевую ЧИСТУЮ прибыль x (₽). null — недостижимо. */
export function sForProfit(pr, inp, x) {
  const { A, B } = coeffs(pr, inp);
  const keep = 1 - pr.opexShare;
  if (A <= 0 || keep <= 0) return null;
  return (num(x) / keep + B) / A;
}
/** Точка безубыточности (S, при которой чистая=0). */
export function sBreakeven(pr, inp) {
  const { A, B } = coeffs(pr, inp);
  return A > 0 ? B / A : null;
}

const basePriceOf = (S, sellerDiscount) => (S == null ? null : S / (1 - num(sellerDiscount)));

/**
 * Полный расчёт. inp:
 *   basePrice, sellerDiscount(доля), cost, logisticsToWb, buyout(доля), acceptanceCoef,
 *   pr(unitParams()), drr(доля, опц.), targetMargin(доля), targetProfit(₽).
 */
export function analyze(inp) {
  const pr = inp.pr || unitParams();
  const sd = num(inp.sellerDiscount);
  // основная цена: из базовой (−скидка) → S. Если базовой нет — считаем только коридор/безубыток.
  const S = inp.basePrice != null ? num(inp.basePrice) * (1 - sd) : null;
  const unit = S != null ? unitBreakdown(S, pr, inp) : null;

  const cor = { loS: sForMargin(pr, inp, pr.m_min), hiS: sForMargin(pr, inp, pr.m_max) };
  const corridor = {
    lo: basePriceOf(cor.loS, sd), hi: basePriceOf(cor.hiS, sd),
    loS: cor.loS, hiS: cor.hiS,
  };
  const beS = sBreakeven(pr, inp);
  const breakeven = { S: beS, base: basePriceOf(beS, sd) };

  let reverse = null;
  if (inp.targetMargin != null || inp.targetProfit != null) {
    reverse = {};
    if (inp.targetMargin != null) {
      const s = sForMargin(pr, inp, num(inp.targetMargin));
      reverse.margin = { target: num(inp.targetMargin), S: s, base: basePriceOf(s, sd), unit: s != null ? unitBreakdown(s, pr, inp) : null };
    }
    if (inp.targetProfit != null) {
      const s = sForProfit(pr, inp, num(inp.targetProfit));
      reverse.profit = { target: num(inp.targetProfit), S: s, base: basePriceOf(s, sd), unit: s != null ? unitBreakdown(s, pr, inp) : null };
    }
  }

  // Чувствительность — ГРАДАЦИЯ ПО МАРЖИНАЛЬНОСТИ шагом 1%: от mMin до mMax.
  // Для каждой целевой валовой маржинальности m считаем S (базовая фиксирована),
  // цену покупателя и чистую прибыль. Строка текущей маржинальности подсвечивается.
  const curMpct = unit ? Math.round(unit.marginGross * 100) : null;
  const mLo = Math.round(pr.m_min * 100), mHi = Math.round(pr.m_max * 100);
  const sensitivity = [];
  for (let m = mLo; m <= mHi && sensitivity.length < 60; m++) {
    const sv = sForMargin(pr, inp, m / 100);
    if (sv == null || sv <= 0) continue;
    const u = unitBreakdown(sv, pr, inp);
    sensitivity.push({ marginTarget: m, S: sv, buyerPrice: u.buyerPrice, net: u.net, margin: u.marginGross, current: curMpct === m });
  }

  return { input: { basePrice: inp.basePrice != null ? num(inp.basePrice) : null, sellerDiscount: sd }, pr, unit, corridor, breakeven, reverse, sensitivity };
}
