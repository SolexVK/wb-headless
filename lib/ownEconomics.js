/**
 * Юнит-экономика собственных товаров.
 *
 * Единственная реализация расчёта маржи по своим SKU. Не путать с `unitEconomics`
 * из lib/nicheAnalysis.js — там оценка чужой ниши по медианной цене рынка, здесь
 * точный расчёт по нашей себестоимости и нашим тарифам.
 *
 * Ключевая особенность: расходы фулфилмента платятся за КАЖДЫЙ ЗАКАЗ, а выручка
 * приходит только с ВЫКУПЛЕННЫХ. При выкупе 35 % на одну проданную единицу
 * приходится 1,86 возврата, и стоимость фулфилмента на проданную единицу
 * оказывается втрое выше номинала. Считать иначе — занижать себестоимость.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Читает config/economics.json. Путь можно переопределить через ECONOMICS_CONFIG. */
export function loadEconomics(file = process.env.ECONOMICS_CONFIG) {
  const p = file || path.join(ROOT, 'config', 'economics.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const key of ['commissionPct', 'taxPct', 'cargoRubPerUnit', 'defectPct']) {
    if (typeof raw[key] !== 'number') throw new Error(`economics.json: нет числового поля ${key}`);
  }
  if (!raw.fulfilment || typeof raw.fulfilment.outboundRub !== 'number') {
    throw new Error('economics.json: нет fulfilment.outboundRub');
  }
  return raw;
}

/**
 * Стоимость фулфилмента в пересчёте на ОДНУ ПРОДАННУЮ единицу.
 *
 *   на 100 заказов:  100 × outbound  +  (100 − 100R) × returnCycle
 *   продано:         100R
 *   на единицу:      (outbound + (1 − R) × returnCycle) / R
 *
 * @param {number} redemptionPct процент выкупа, 0-100
 */
export function fulfilmentPerSoldUnit(redemptionPct, e) {
  const R = redemptionPct / 100;
  if (!(R > 0)) throw new Error('процент выкупа должен быть больше нуля');
  return (e.fulfilment.outboundRub + (1 - R) * e.fulfilment.returnCycleRub) / R;
}

/** Себестоимость с учётом заложенного брака: та же партия даёт меньше годных единиц. */
export function costWithDefect(cost, e) {
  return cost / (1 - e.defectPct / 100);
}

/**
 * Полная раскладка экономики единицы.
 * @param {number} price цена со скидкой продавца, БЕЗ СПП — все расчёты ведутся от неё (D9)
 * @param {number} cost себестоимость производства, руб/шт
 * @param {number} redemptionPct процент выкупа
 * @returns {{price:number, commission:number, tax:number, fulfilment:number, cargo:number,
 *            cost:number, totalCost:number, margin:number, marginPct:number}}
 */
export function unitMargin({ price, cost, redemptionPct }, e = loadEconomics()) {
  const commission = (price * e.commissionPct) / 100;
  const tax = (price * e.taxPct) / 100;
  const fulfilment = fulfilmentPerSoldUnit(redemptionPct, e);
  const cargo = e.cargoRubPerUnit;
  const costEff = costWithDefect(cost, e);
  const totalCost = commission + tax + fulfilment + cargo + costEff;
  const margin = price - totalCost;
  return {
    price,
    commission: round(commission),
    tax: round(tax),
    fulfilment: round(fulfilment),
    cargo: round(cargo),
    cost: round(costEff),
    totalCost: round(totalCost),
    margin: round(margin),
    marginPct: round((margin / price) * 100, 1),
  };
}

/**
 * Цена, при которой достигается заданная маржинальность.
 *
 *   Ц × (1 − комиссия% − налог% − маржа%) = ФФ + карго + себестоимость
 *
 * @param {number} targetMarginPct целевая маржа, % (0 — цена безубыточности)
 */
export function breakEvenPrice({ cost, redemptionPct, targetMarginPct = 0 }, e = loadEconomics()) {
  const share = 1 - e.commissionPct / 100 - e.taxPct / 100 - targetMarginPct / 100;
  if (share <= 0) {
    throw new Error(
      `недостижимо: комиссия ${e.commissionPct}% + налог ${e.taxPct}% + маржа ${targetMarginPct}% ≥ 100%`,
    );
  }
  const fixed = fulfilmentPerSoldUnit(redemptionPct, e) + e.cargoRubPerUnit + costWithDefect(cost, e);
  return round(fixed / share);
}

/**
 * Предельный ДРР — доля рекламных расходов, при которой маржа обнуляется.
 * Считается от ВЫКУПЛЕННОЙ выручки, а не от суммы заказов.
 */
export function maxDrrPct({ price, cost, redemptionPct }, e = loadEconomics()) {
  const m = unitMargin({ price, cost, redemptionPct }, e);
  return round((m.margin / price) * 100, 1);
}

/**
 * Пересчёт ДРР рекламного кабинета WB (считается от суммы ЗАКАЗОВ)
 * в фактический ДРР от выкупленной выручки.
 */
export function cabinetDrrToActual(cabinetDrrPct, redemptionPct) {
  const R = redemptionPct / 100;
  if (!(R > 0)) throw new Error('процент выкупа должен быть больше нуля');
  return round(cabinetDrrPct / R, 1);
}

function round(n, digits = 0) {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
