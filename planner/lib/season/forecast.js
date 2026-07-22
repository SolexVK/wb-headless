// lib/forecast.js — прогноз плана продаж на ЗАДАННЫЙ будущий период (Правила 3–5).
//
// Идея: по 2 годам истории строим свёрнутый (recency-взвешенный) сезонный профиль
// продаж/цены, проецируем его на запрошенные будущие даты и корректируем «дрейфом
// текущего года» — сравнением аналогов за последние 60 дней с тем же окном год
// назад (Правило 4). Дополнительно отмечаем БЛАГОПРИЯТНЫЕ периоды: спрос выше
// среднего при остатках ниже среднего = спрос превышает предложение (Правило 1).

import {
  computeFoldedMonthlyProfile,
  computeFoldedWeeklyProfile,
  weekOfYearOf,
  detectPhases,
  computeWeeklyProfile,
  trimToActive,
  computeCoefficients,
  computeRank,
} from './salesPlan.js';

const round = (n, d = 2) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Ось дат [from..to] включительно. */
export function dateRange(from, to) {
  const out = [];
  let t = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(to + 'T00:00:00Z');
  while (t <= end) { out.push(new Date(t).toISOString().slice(0, 10)); t += 86400000; }
  return out;
}

/** Циклическая интерполяция месячных значений (в середине месяца) на дату. */
function monthlyValueAt(map, date) {
  const [y, m, d] = date.split('-').map(Number);
  const frac = (d - 15) / daysInMonth(y, m); // −0.5..+0.5 вокруг середины месяца
  let m0, m1, t;
  if (frac >= 0) { m0 = m; m1 = m === 12 ? 1 : m + 1; t = frac; }
  else { m0 = m === 1 ? 12 : m - 1; m1 = m; t = 1 + frac; }
  const v0 = map[m0] ?? map[m] ?? 1;
  const v1 = map[m1] ?? map[m] ?? 1;
  return v0 * (1 - t) + v1 * t;
}

/** Агрегат окна: средние дневные продажи и цена спроса (выручка/штуки). */
function aggWindow(groupDaily) {
  const a = groupDaily || [];
  if (!a.length) return { avgDaily: 0, avgPrice: 0, days: 0 };
  const sales = a.reduce((s, r) => s + (Number(r.sales) || 0), 0);
  const rev = a.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const priceDays = a.filter((r) => r.price > 0);
  const avgPrice = rev > 0 && sales > 0 ? rev / sales
    : priceDays.length ? mean(priceDays.map((r) => r.price)) : 0;
  return { avgDaily: sales / a.length, avgPrice, days: a.length };
}

/**
 * Строит прогноз на [forecastFrom..forecastTo].
 * @param {object} p
 *   history      — groupDaily аналогов за 2 года (форма сезона);
 *   recent60/prior60 — groupDaily аналогов за последние 60 дней и то же окно год
 *                  назад (корректировка текущего года);
 *   baseDaily    — уровень базы (штук/день), посчитан оркестратором (бленд 90/10);
 *   opts         — recencyWeight, weekly, hotCoeff, лаги, competitorWeight…
 * @returns { forecastDaily, historyDaily, phases, rank, adjustments, weeklyProfile,
 *            meanPrice, favorable:{months, share} }
 */
export function buildForecast({ history, recent60, prior60, baseDaily, forecastFrom, forecastTo, opts = {} }) {
  const active = trimToActive(history);
  const folded = computeFoldedMonthlyProfile(active, opts);
  const weekProfile = computeFoldedWeeklyProfile(active, opts); // недельный профиль — сохраняет пики
  const phases = detectPhases(active, opts);
  const rank = computeRank(computeCoefficients(active, opts).kSales, opts);
  const weekdayFactors = opts.weekly ? computeWeeklyProfile(active, opts.smoothWindow ?? 7) : null;
  // Ценовой якорь: «выше медианы» (средний/высокий сегмент) если задан, иначе
  // средневзвешенная цена спроса.
  const meanPrice = opts.priceAnchor > 0 ? opts.priceAnchor : folded.meanPrice;

  // Месячные карты.
  const indexMap = {}, priceIdxMap = {}, stockMap = {};
  for (const m of folded.months) { indexMap[m.month] = m.index; priceIdxMap[m.month] = m.priceIndex; stockMap[m.month] = m.avgStock; }
  const meanStock = mean(folded.months.map((m) => m.avgStock).filter((v) => v > 0)) || 1;

  // Благоприятные месяцы (Правило 1): спрос выше среднего И остаток ниже среднего.
  const favorableMonth = {};
  const deficitScoreMap = {};
  for (const m of folded.months) {
    const stockIdx = (m.avgStock || meanStock) / meanStock;
    deficitScoreMap[m.month] = round(m.index / Math.max(stockIdx, 0.15), 2);
    favorableMonth[m.month] = m.index > 1.0 && stockIdx < 1.0;
  }

  // Дрейф текущего года по конкурентам (Правило 4): последние 60 дней vs год назад.
  // Мягкий клэмп [clampLo..clampHi] — 60-дневное окно шумное, не даём годовому
  // плану скакнуть в разы от одного окна (границы настраиваются).
  const clampLo = opts.adjClampLo ?? 0.5, clampHi = opts.adjClampHi ?? 2.0;
  const clamp = (v) => Math.max(clampLo, Math.min(clampHi, v));
  const rec = aggWindow(recent60), pri = aggWindow(prior60);
  const priceRaw = pri.avgPrice > 0 && rec.avgPrice > 0 ? rec.avgPrice / pri.avgPrice : 1;
  const volumeRaw = pri.avgDaily > 0 && rec.avgDaily > 0 ? rec.avgDaily / pri.avgDaily : 1;
  const priceAdj = clamp(priceRaw), volumeAdj = clamp(volumeRaw);
  const adjustments = {
    priceAdj: round(priceAdj, 3), volumeAdj: round(volumeAdj, 3),
    priceAdjRaw: round(priceRaw, 3), volumeAdjRaw: round(volumeRaw, 3),
    recentPrice: round(rec.avgPrice, 0), priorPrice: round(pri.avgPrice, 0),
    recentAvgDaily: round(rec.avgDaily, 1), priorAvgDaily: round(pri.avgDaily, 1),
    windowDays: rec.days,
  };

  const stageOf = phases?.stageOfMonth || {};
  // Прогнозный ряд по дням запрошенного периода.
  const forecastDaily = dateRange(forecastFrom, forecastTo).map((date) => {
    const m = Number(date.slice(5, 7));
    const wk = weekOfYearOf(date);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const wf = weekdayFactors ? weekdayFactors[dow] : 1;
    // сезонный индекс спроса/цены — по НЕДЕЛЯМ ГОДА (сохраняет внутримесячные пики),
    // с откатом на месячный, если по неделе нет данных.
    const salesIdx = weekProfile.present[wk] ? weekProfile.index[wk] : monthlyValueAt(indexMap, date);
    const priceIdx = weekProfile.present[wk] ? weekProfile.priceIndex[wk] : monthlyValueAt(priceIdxMap, date);
    const stockVal = weekProfile.present[wk] && weekProfile.avgStock[wk] > 0 ? weekProfile.avgStock[wk] : monthlyValueAt(stockMap, date);
    return {
      date,
      stage: stageOf[m] || null,
      favorable: !!favorableMonth[m],
      deficitScore: deficitScoreMap[m] ?? null,
      kSales: round(salesIdx, 4),
      weekdayFactor: round(wf, 3),
      plannedOrders: round(baseDaily * volumeAdj * salesIdx * wf, 1),
      price: round(meanPrice * priceIdx * priceAdj, 0),
      stock: round(stockVal, 0), // прогноз уровня остатков рынка (по неделям года)
    };
  });

  // Историческая кривая (2 года) для диаграммы — по фактическим дням активного окна.
  const historyDaily = active.map((r) => {
    const m = Number(r.date.slice(5, 7));
    return {
      date: r.date,
      stage: stageOf[m] || null,
      favorable: !!favorableMonth[m],
      kSales: round(monthlyValueAt(indexMap, r.date), 4),
      price: round((Number(r.price) || 0), 0),
      sales: round(Number(r.sales) || 0, 1),
      stock: round(Number(r.stock ?? r.balance) || 0, 0),
    };
  });

  const favMonths = Object.keys(favorableMonth).filter((m) => favorableMonth[m]).map(Number).sort((a, b) => a - b);
  const favShare = forecastDaily.length ? forecastDaily.filter((d) => d.favorable).length / forecastDaily.length : 0;

  return {
    forecastPeriod: { from: forecastFrom, to: forecastTo },
    rank,
    baseSource: opts.baseSource,
    phases,
    adjustments,
    weeklyProfile: weekdayFactors,
    meanPrice,
    baseDaily: round(baseDaily, 2),
    favorable: { months: favMonths, share: round(favShare, 3), deficitScore: deficitScoreMap },
    monthlyProfile: folded.months.map((m) => ({ month: m.month, index: m.index, priceIndex: m.priceIndex, favorable: !!favorableMonth[m.month] })),
    forecastDaily,
    historyDaily,
  };
}
