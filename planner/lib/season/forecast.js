// lib/forecast.js — ИНЖЕНЕРНЫЙ прогноз плана продаж под жизненный цикл товара.
//
// Модель = РИТМ РЫНКА (аналоговая посуточная форма из истории, сохраняет рельеф)
//   × ЖИЗНЕННЫЙ ЦИКЛ НАШЕГО ТОВАРА (вход с нуля S-рампой → тело сезона →
//     ликвидация хвоста в ноль) × УРОВЕНЬ (ТОП-3 конкурентов, не средний аналог).
// Движок сам анализирует ПОЛНЫЙ ГОД, находит самый сильный сезон, ставит границы
// фаз на РЕАЛЬНЫЕ даты спроса (а не на 1-е число), проецирует на целевой год и
// проверяет результат самопроверкой (правило разгона, 80/20, обнуление склада).

import {
  computeFoldedMonthlyProfile,
  computeAnalogDailyShape,
  detectPhases,
  computeWeeklyProfile,
  trimToActive,
  computeCoefficients,
  computeRank,
} from './salesPlan.js';

const round = (n, d = 2) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const DAYMS = 86400000;
const NL_MCUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const pad2 = (n) => String(n).padStart(2, '0');

/** Ось дат [from..to] включительно. */
export function dateRange(from, to) {
  const out = [];
  let t = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(to + 'T00:00:00Z');
  while (t <= end) { out.push(new Date(t).toISOString().slice(0, 10)); t += DAYMS; }
  return out;
}

/** «Нормализованный день года» 1..365 → {месяц, день}. */
function calDayToMd(k) {
  k = Math.max(1, Math.min(365, Math.round(k)));
  for (let m = 1; m <= 12; m++) { const end = m < 12 ? NL_MCUM[m] : 365; if (k <= end) return { m, d: k - NL_MCUM[m - 1] }; }
  return { m: 12, d: 31 };
}

/** Циклическая интерполяция месячных значений (в середине месяца) на дату. */
function monthlyValueAt(map, date) {
  const [y, m, d] = date.split('-').map(Number);
  const frac = (d - 15) / daysInMonth(y, m);
  let m0, m1, t;
  if (frac >= 0) { m0 = m; m1 = m === 12 ? 1 : m + 1; t = frac; }
  else { m0 = m === 1 ? 12 : m - 1; m1 = m; t = 1 + frac; }
  const v0 = map[m0] ?? map[m] ?? 1;
  const v1 = map[m1] ?? map[m] ?? 1;
  return v0 * (1 - t) + v1 * t;
}

/** Кольцевое сглаживание массива [1..365]. */
function smoothCirc(arr, win) {
  const N = 365, h = Math.floor(win / 2), out = arr.slice();
  for (let i = 1; i <= N; i++) { let s = 0, c = 0; for (let j = i - h; j <= i + h; j++) { const idx = ((j - 1 + N) % N) + 1; s += arr[idx]; c++; } out[i] = s / c; }
  return out;
}

/** S-кривая разгона 0..1 за rampDays (логистическая; ровно 0 в начале, 1 в конце). */
function rampCurve(i, rampDays) {
  if (i <= 0) return 0; if (i >= rampDays) return 1;
  const L = (t) => 1 / (1 + Math.exp(-11 * (t - 0.5)));
  const t = i / rampDays; return (L(t) - L(0)) / (L(1) - L(0));
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
 * Инженерная кривая сезона (см. шапку файла). Возвращает готовый forecastDaily,
 * выбранные движком даты фаз, период и блок самопроверки.
 */
function buildEngineeredSeason(shape, cfg) {
  const A = shape.index; const N = 365;
  // 1) ГОДОВОЙ анализ. Трендовую (спайк-устойчивую) кривую строим ТЯЖЁЛЫМ сглаживанием —
  // разовые лончевые всплески не должны определять границы сезона.
  const trend = smoothCirc(A, 31);
  let kPeak = 1; for (let k = 2; k <= N; k++) if (trend[k] > trend[kPeak]) kPeak = k;
  const thr = Math.max(1.0, (cfg.seasonFrac ?? 0.6) * trend[kPeak]); // порог «активного» спроса
  let s0 = kPeak; for (let g = 0; g < N; g++) { const p = ((s0 - 2 + N) % N) + 1; if (trend[p] >= thr) s0 = p; else break; } // старт горячего
  let s1 = kPeak; for (let g = 0; g < N; g++) { const nx = (s1 % N) + 1; if (trend[nx] >= thr) s1 = nx; else break; }         // спад
  const rampDays = cfg.rampDays ?? 28; // до 4 недель на выход в ТОП
  let entryCal = ((s0 - rampDays - 1 + N) % N) + 1; // вход = за rampDays до старта горячего
  let seasonLen = ((s1 - entryCal + N) % N) + 1;
  // минимальная длина сезона (не даём выродиться в узкий пик от артефакта)
  const minLen = cfg.minSeasonDays ?? 140;
  if (seasonLen < minLen) { entryCal = ((entryCal - Math.ceil((minLen - seasonLen) / 2) - 1 + N) % N) + 1; seasonLen = minLen; }
  seasonLen = Math.min(seasonLen, 330);

  // 2) проекция на ЦЕЛЕВОЙ ГОД: реальные последовательные даты (перешагивают НГ сами)
  const emd = calDayToMd(entryCal);
  const startT = Date.parse(`${cfg.targetYear}-${pad2(emd.m)}-${pad2(emd.d)}T00:00:00Z`);
  const days = [];
  for (let i = 0; i < seasonLen; i++) {
    const date = new Date(startT + i * DAYMS).toISOString().slice(0, 10);
    const k = shape.calDayOf(date);
    days.push({ date, k, relief: A[k] || 1, i });
  }
  let peakI = 0; for (let i = 1; i < days.length; i++) if (days[i].relief > days[peakI].relief) peakI = i;

  // 3) ВХОД с нуля: S-рампа 0→1 за rampDays поверх рельефа рынка.
  for (const d of days) { d.ramp = rampCurve(d.i, rampDays); d.base = d.relief * d.ramp; }

  // 4) начало распродажи = точка 80% кумулятива тела (правило 80/20), но не раньше пика.
  const total0 = days.reduce((s, d) => s + d.base, 0) || 1;
  let acc = 0, iSale = days.length - 1;
  for (let i = 0; i < days.length; i++) { acc += days[i].base; if (acc >= 0.80 * total0) { iSale = Math.max(i, peakI + 1); break; } }
  iSale = Math.max(1, Math.min(iSale, days.length - 2));
  // 5) ЛИКВИДАЦИЯ хвоста в ноль: ПЛАВНЫЙ СПАД от уровня старта распродажи к нулю.
  //    Хвост НИКОГДА не выше уровня старта распродажи (⇒ и не выше пика) — распродажа
  //    не может продавать больше, чем в сезон. Объём хвоста получается ~20% (pre≥80%).
  for (let i = 0; i < iSale; i++) days[i].shapeVal = days[i].base;
  const v0 = iSale > 0 ? days[iSale - 1].base : days[0].base;
  const tail = days.slice(iSale); const Lt = tail.length;
  tail.forEach((d, j) => { const p = Lt > 1 ? j / (Lt - 1) : 1; d.shapeVal = v0 * Math.pow(1 - p, cfg.saleDecay ?? 1.4); });

  // 6) МАСШТАБ под ТОП-3: p90 тела (устойчиво к текстурным спайкам) = уровень ТОП-3 на пике.
  const bodyShape = days.slice(0, iSale).map((d) => d.shapeVal).filter((v) => v > 0).sort((a, b) => a - b);
  const p90body = bodyShape.length ? bodyShape[Math.floor(0.9 * (bodyShape.length - 1))] : 1;
  const targetPeak = (cfg.top3Daily || 1) * (cfg.volumeAdj || 1) * trend[kPeak];
  const scale = p90body > 0 ? targetPeak / p90body : 1;
  for (const d of days) d.final = round(d.shapeVal * scale, 1);

  // фазы по РЫНОЧНЫМ датам. «Пик сезона» — ОКНО вокруг пика (не один день).
  const peakLo = Math.max(rampDays, peakI - 10);
  const stageAt = (i) => {
    if (i < Math.round(rampDays * 0.5)) return 'вход';
    if (i < rampDays) return 'разгон';
    if (i < peakLo) return 'старт сезона';
    if (i < iSale) return 'пик сезона';
    const sl = days.length - 1 - iSale;
    return (i - iSale) < sl * 0.4 ? 'начало распродажи' : 'конец распродажи';
  };
  // НАШ склад на WB: производство (=итог плана) − накопленные продажи → к концу ≈ 0.
  const grand = days.reduce((s, d) => s + d.final, 0);
  let cum = 0;
  for (const d of days) { cum += d.final; d.ourStock = Math.max(0, round(grand - cum, 0)); }
  const favM = cfg.favorableMonth || {};
  const forecastDaily = days.map((d, i) => ({
    date: d.date,
    stage: stageAt(i),
    favorable: !!favM[Number(d.date.slice(5, 7))],
    kSales: round(d.relief, 4),
    plannedOrders: d.final,
    price: round(cfg.meanPrice * (shape.priceIndex[d.k] || 1) * (cfg.priceAdj || 1), 0),
    stock: d.ourStock, // НАШ плановый остаток на WB (убывает к нулю), не остаток конкурентов
  }));

  const phaseDates = {
    entry: days[0].date,
    ramp: days[Math.min(Math.round(rampDays * 0.5), days.length - 1)].date,
    hotStart: days[Math.min(rampDays, days.length - 1)].date,
    peak: days[peakI].date,
    saleStart: days[iSale].date,
    end: days[days.length - 1].date,
  };

  // 7) САМОПРОВЕРКА расчёта.
  const vals = days.map((d) => d.final);
  const bodyFinal = days.slice(0, iSale).map((d) => d.final).filter((v) => v > 0).sort((a, b) => a - b);
  const planPeak = bodyFinal.length ? bodyFinal[Math.floor(0.9 * (bodyFinal.length - 1))] : Math.max(...vals, 1);
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const preShare = vals.slice(0, iSale).reduce((a, b) => a + b, 0) / total;
  const hotVal = vals[Math.min(rampDays, vals.length - 1)];
  const earlyVal = Math.max(vals[Math.min(3, vals.length - 1)] || 0, 0.01);
  const target3 = round(targetPeak, 0);
  const validation = {
    entryFromZero: { ok: vals[0] <= 0.06 * planPeak, label: 'Вход с нуля', value: `${round(vals[0], 1)} шт/день`, ref: `≤ ${round(0.06 * planPeak, 1)}` },
    rampToTop: { ok: hotVal >= 6 * earlyVal, label: 'Разгон с нуля к старту сезона', value: `×${round(hotVal / earlyVal, 1)} за ${rampDays} дн`, ref: 'выход с нуля' },
    peakVsTop3: { ok: Math.abs(planPeak / target3 - 1) <= 0.15, label: 'Пик ≈ уровень ТОП-3', value: `${Math.round(planPeak)} шт/день`, ref: `≈ ${target3}` },
    preSale80: { ok: preShare >= 0.795, label: '≥80% до распродажи', value: `${round(preShare * 100, 1)}%`, ref: '≥ 80%' },
    endToZero: { ok: vals[vals.length - 1] <= 0.06 * planPeak, label: 'Обнуление склада', value: `${round(vals[vals.length - 1], 1)} шт/день`, ref: `≤ ${round(0.06 * planPeak, 1)}` },
    marketDates: { ok: new Date(phaseDates.entry).getUTCDate() !== 1 || new Date(phaseDates.saleStart).getUTCDate() !== 1, label: 'Даты по рынку', value: `вход ${phaseDates.entry}`, ref: 'не 1-е число' },
  };

  return { forecastDaily, forecastPeriod: { from: days[0].date, to: days[days.length - 1].date }, phaseDates, validation, top3PeakDaily: target3, totalUnits: Math.round(total) };
}

/**
 * Строит инженерный прогноз (движок сам выбирает окно сезона из годового анализа).
 * @param {object} p
 *   history            — groupDaily аналогов за 2 года (форма/ритм рынка);
 *   recent60/prior60   — окна для дрейфа текущего года (Правило 4);
 *   baseDaily          — уровень базы (штук/день, средний конкурент/бленд);
 *   top3Daily          — средняя дневных продаж ТОП-3 аналогов (целевой уровень);
 *   targetYear         — год старта сезона (движок ставит вход в этом году);
 *   opts               — recencyWeight, rampDays, seasonFrac, priceAnchor…
 */
export function buildForecast({ history, recent60, prior60, baseDaily, top3Daily, targetYear, opts = {} }) {
  const active = trimToActive(history);
  const asOfYear = Number(active[active.length - 1].date.slice(0, 4));
  const year = Number(targetYear) || asOfYear;
  const folded = computeFoldedMonthlyProfile(active, opts);
  const shape = computeAnalogDailyShape(active, opts); // аналоговая посуточная форма (рельеф)
  const phases = detectPhases(active, opts);
  const rank = computeRank(computeCoefficients(active, opts).kSales, opts);
  const meanPrice = opts.priceAnchor > 0 ? opts.priceAnchor : folded.meanPrice;

  const indexMap = {}, priceIdxMap = {}, stockMap = {};
  for (const m of folded.months) { indexMap[m.month] = m.index; priceIdxMap[m.month] = m.priceIndex; stockMap[m.month] = m.avgStock; }
  const meanStock = mean(folded.months.map((m) => m.avgStock).filter((v) => v > 0)) || 1;

  const favorableMonth = {}, deficitScoreMap = {};
  for (const m of folded.months) {
    const stockIdx = (m.avgStock || meanStock) / meanStock;
    deficitScoreMap[m.month] = round(m.index / Math.max(stockIdx, 0.15), 2);
    favorableMonth[m.month] = m.index > 1.0 && stockIdx < 1.0;
  }

  // Дрейф текущего года по конкурентам (Правило 4): 60 дней vs год назад, мягкий клэмп.
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

  // Уровень ТОП-3 (целевой пик): если не передан — берём базовый (средний конкурент).
  const top3 = top3Daily > 0 ? top3Daily : baseDaily;

  const eng = buildEngineeredSeason(shape, {
    targetYear: year, top3Daily: top3, volumeAdj, priceAdj, meanPrice,
    rampDays: opts.rampDays, seasonFrac: opts.seasonFrac, favorableMonth,
  });

  // Историческая кривая (2 года) — по фактическим дням (для второй диаграммы).
  const stageOf = phases?.stageOfMonth || {};
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
  const favShare = eng.forecastDaily.length ? eng.forecastDaily.filter((d) => d.favorable).length / eng.forecastDaily.length : 0;

  return {
    forecastPeriod: eng.forecastPeriod,
    targetYear: year,
    phaseDates: eng.phaseDates,
    validation: eng.validation,
    top3PeakDaily: eng.top3PeakDaily,
    top3Daily: round(top3, 2),
    totalUnits: eng.totalUnits,
    rank,
    baseSource: opts.baseSource,
    phases,
    adjustments,
    meanPrice,
    baseDaily: round(baseDaily, 2),
    favorable: { months: favMonths, share: round(favShare, 3), deficitScore: deficitScoreMap },
    monthlyProfile: folded.months.map((m) => ({ month: m.month, index: m.index, priceIndex: m.priceIndex, favorable: !!favorableMonth[m.month] })),
    forecastDaily: eng.forecastDaily,
    historyDaily,
  };
}
