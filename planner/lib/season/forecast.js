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

/** Принадлежность дня года k полукольцу [a, b) вперёд по кругу (1..365). */
function ringHas(a, b, k) {
  a = ((a - 1 + 365) % 365) + 1; b = ((b - 1 + 365) % 365) + 1; k = ((k - 1 + 365) % 365) + 1;
  return a <= b ? (k >= a && k < b) : (k >= a || k < b);
}
/** Период (Разгон/Сезон/Распродажа/Межсезонье) для дня года k по границам сезона. */
function periodOfCal(k, cal) {
  if (!cal) return null;
  if (ringHas(cal.entryCal, cal.hotStartCal, k)) return 'Разгон';
  if (ringHas(cal.hotStartCal, cal.saleStartCal, k)) return 'Сезон';
  if (ringHas(cal.saleStartCal, (cal.endCal % 365) + 1, k)) return 'Распродажа';
  return 'Межсезонье';
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

  // 2) проекция на ЦЕЛЕВОЙ ГОД: реальные последовательные даты (перешагивают НГ сами).
  // Прогноз строим ВПЕРЁД от сегодня: если вход сезона в targetYear уже прошёл (≤ сегодня),
  // сдвигаем на следующий год — план всегда на будущий сезон. Если вход ещё впереди в этом
  // году — оставляем текущий год.
  const emd = calDayToMd(entryCal);
  const asOf = cfg.asOf || `${cfg.targetYear}-01-01`;
  let chosenYear = Number(cfg.targetYear);
  for (let g = 0; g < 4; g++) {
    const entryISO = `${chosenYear}-${pad2(emd.m)}-${pad2(emd.d)}`;
    if (entryISO > asOf) break; // ISO-даты сравнимы как строки
    chosenYear += 1;
  }
  const startT = Date.parse(`${chosenYear}-${pad2(emd.m)}-${pad2(emd.d)}T00:00:00Z`);
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

  // ПЕРИОДЫ (заливка на графике): Разгон [вход..старт сезона), Сезон [старт..начало распродажи),
  // Распродажа [начало распродажи..конец]. Внутри Сезона — веха Пик. ВЕХИ (1 день) —
  // Вход, Старт сезона, Пик, Начало распродажи, Конец — отдельно в phaseDates.
  const stageAt = (i) => (i < rampDays ? 'Разгон' : i < iSale ? 'Сезон' : 'Распродажа');

  // ── ПОСТАВКИ на склад WB ЧАСТЯМИ (не весь объём сразу) ──
  //  П1 к дате Входа          = объём периода Разгон + 10% буфер;
  //  П2 за 2–3 дня до Старта   = 50% объёма Сезона + 10% буфер;
  //  П3 к середине Сезона      = весь остаток ⇒ суммарно = план ⇒ склад → 0 к концу;
  //  Подсорт (контингент)      = крайний срок поставки ≤ 7 дней до Пика (если факт > плана).
  const grand = days.reduce((s, d) => s + d.final, 0);
  const rampVol = days.slice(0, rampDays).reduce((s, d) => s + d.final, 0);
  const seasonVol = days.slice(rampDays, iSale).reduce((s, d) => s + d.final, 0);
  const BUF = cfg.deliveryBuffer ?? 1.10; // +10% на непредвиденные ускоренные продажи
  const iD2 = Math.max(0, Math.min(rampDays - 3, days.length - 1)); // за 2–3 дня до старта сезона
  const iD3 = Math.max(rampDays, Math.min(rampDays + Math.floor((iSale - rampDays) / 2), days.length - 1)); // середина сезона
  const d1qty = Math.round(Math.min(grand, rampVol * BUF));
  const d2qty = Math.round(Math.min(Math.max(0, grand - d1qty), seasonVol * 0.5 * BUF));
  const d3qty = Math.max(0, Math.round(grand - d1qty - d2qty)); // остаток ⇒ итог поставок = план
  const deliveryByIdx = {};
  deliveryByIdx[0] = (deliveryByIdx[0] || 0) + d1qty;
  deliveryByIdx[iD2] = (deliveryByIdx[iD2] || 0) + d2qty;
  deliveryByIdx[iD3] = (deliveryByIdx[iD3] || 0) + d3qty;
  let lvl = 0;
  for (let i = 0; i < days.length; i++) { lvl += (deliveryByIdx[i] || 0); lvl -= days[i].final; days[i].ourStock = Math.max(0, round(lvl, 0)); }
  const deliveries = [
    { date: days[0].date, qty: d1qty, tag: 'П1', title: 'Поставка 1 — под период Разгон (+10% буфер)' },
    { date: days[iD2].date, qty: d2qty, tag: 'П2', title: 'Поставка 2 — 50% объёма Сезона (+10%), за 2–3 дня до старта' },
    { date: days[iD3].date, qty: d3qty, tag: 'П3', title: 'Поставка 3 — остаток объёма к середине Сезона' },
  ].filter((d) => d.qty > 0);
  const restockDeadline = { date: days[Math.max(0, peakI - 7)].date, note: 'Крайний срок подсорта (если факт > плана): ≤ 7 дней до Пика' };

  // календарные границы сезона (день года) — чтобы разметить те же периоды на истории
  const seasonCal = {
    entryCal: days[0].k,
    hotStartCal: days[Math.min(rampDays, days.length - 1)].k,
    peakCal: days[peakI].k,
    saleStartCal: days[iSale].k,
    endCal: days[days.length - 1].k,
  };

  // БЛАГОПРИЯТНЫЙ период — только в высоком спросе (Сезон), не в распродаже/межсезонье.
  const peakF = Math.max(...days.map((d) => d.final), 1);
  const forecastDaily = days.map((d, i) => ({
    date: d.date,
    stage: stageAt(i),
    favorable: i >= rampDays && i < iSale && d.final >= 0.5 * peakF,
    kSales: round(d.relief, 4),
    plannedOrders: d.final,
    price: round(cfg.meanPrice * (shape.priceIndex[d.k] || 1) * (cfg.priceAdj || 1), 0),
    stock: d.ourStock, // НАШ плановый остаток на WB (пила поставок → к концу ≈ 0)
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

  return { forecastDaily, forecastPeriod: { from: days[0].date, to: days[days.length - 1].date }, phaseDates, validation, top3PeakDaily: target3, totalUnits: Math.round(total), seasonCal, deliveries, restockDeadline, chosenYear };
}

// Календарные мини-сезоны РФ: всплеск спроса приходит ЗА несколько дней до даты (подарки
// покупают заранее). ramp — дней разгона до пика, tail — дней возврата к базе после.
const RU_SPIKES = [
  { name: 'Новый год', mmdd: '12-20', ramp: 20, tail: 12 },
  { name: '14 февраля', mmdd: '02-11', ramp: 8, tail: 3 },
  { name: '23 февраля', mmdd: '02-20', ramp: 8, tail: 3 },
  { name: '8 марта', mmdd: '03-05', ramp: 8, tail: 3 },
];

/**
 * КРУГЛОГОДИЧНАЯ кривая (режим 'allseason'): товар с яркими сезонами, но продажами весь год.
 * Форма = полный годовой рельеф рынка (тот же shape.index) БЕЗ разгона-с-нуля и БЕЗ обнуления
 * хвоста: после сезона продажи мягко снижаются до межсезонного «пола» и держатся. Вторичные
 * всплески (мини-сезоны: НГ, 14/23 фев, 8 мар + пики из данных) размечаются и учитываются в
 * поставках. Итоговый ОБЪЁМ (годовой) перепривязывается выше по стеку к продажам лидеров за год.
 */
function buildAllSeasonYear(shape, cfg) {
  const A = shape.index, N = 365;
  const trend = smoothCirc(A, 31);
  let kPeak = 1; for (let k = 2; k <= N; k++) if (trend[k] > trend[kPeak]) kPeak = k;
  // межсезонный «пол» — нижний перцентиль сглаженного рельефа (устойчив к всплескам)
  const ts = trend.slice(1).filter((v) => v > 0).sort((a, b) => a - b);
  const floorRel = ts.length ? ts[Math.floor(0.20 * (ts.length - 1))] : 0;
  // границы ГЛАВНОГО сезона (для разметки Сезон/Межсезонье)
  const thr = Math.max(floorRel * 1.6, (cfg.seasonFrac ?? 0.6) * trend[kPeak]);
  let s0 = kPeak; for (let g = 0; g < N; g++) { const p = ((s0 - 2 + N) % N) + 1; if (trend[p] >= thr) s0 = p; else break; }
  let s1 = kPeak; for (let g = 0; g < N; g++) { const nx = (s1 % N) + 1; if (trend[nx] >= thr) s1 = nx; else break; }
  const inSeason = (k) => ringHas(s0, (s1 % N) + 1, k);

  // окно = 365 дней ВПЕРЁД от сегодня (asOf)
  const asOf = cfg.asOf || `${cfg.targetYear}-01-01`;
  const startT = Date.parse(asOf + 'T00:00:00Z');
  const days = [];
  for (let i = 0; i < N; i++) {
    const date = new Date(startT + i * DAYMS).toISOString().slice(0, 10);
    const k = shape.calDayOf(date);
    days.push({ date, k, relief: A[k] || 0, i });
  }
  // масштаб: пиковый день ≈ уровень ТОП-3 конкурента (итог года перепривяжется к лидерам)
  const peakRelief = Math.max(...days.map((d) => d.relief), 1e-9);
  const scale = (cfg.top3Daily || 1) * (cfg.volumeAdj || 1) / peakRelief;
  const floorAbs = round(floorRel * scale, 1);

  // ── МИНИ-СЕЗОНЫ ── календарные (страховка) + подтверждённые данными (relief выше пола)
  const findByMmdd = (mmdd) => days.find((d) => d.date.slice(5) === mmdd);
  const miniSeasons = [];
  for (const sp of RU_SPIKES) {
    const pk = findByMmdd(sp.mmdd); if (!pk) continue;
    if (inSeason(pk.k)) continue; // если попал в главный сезон — не мини, а часть сезона
    const reliefAt = A[pk.k] || 0;
    const strength = floorRel > 0 ? reliefAt / floorRel : 1;   // во сколько раз выше межсезонного пола
    const rampStart = days[Math.max(0, pk.i - sp.ramp)];
    const endD = days[Math.min(N - 1, pk.i + sp.tail)];
    miniSeasons.push({
      name: sp.name, peakDate: pk.date, rampStart: rampStart.date, endDate: endD.date,
      peakDaily: round(reliefAt * scale, 0), strength: round(strength, 2),
      confirmed: strength >= 1.15, // рынок реально показывает всплеск в эти дни
    });
  }
  miniSeasons.sort((a, b) => a.peakDate.localeCompare(b.peakDate));

  // ── ДНЕВНОЙ ПЛАН ── чистый рельеф × масштаб (без разгона/обнуления)
  for (const d of days) { d.final = round(d.relief * scale, 1); }
  const vals = days.map((d) => d.final);
  const peakF = Math.max(...vals, 1);

  // ── ПОСТАВКИ = ДЕДЛАЙНЫ НАЛИЧИЯ на складе WB (не старт производства!) ──
  // Ровный помесячный подсорт: к дате «нужно на складе» лежит объём под спрос месяца × буфер.
  // Дата — когда товар ДОЛЖЕН УЖЕ БЫТЬ на WB (за ~4 дня до месяца, покрывает и внутримесячные
  // мини-всплески — объём месяца включает их из рельефа). Обратный расчёт «когда запускать
  // крой/пошив/закуп ткани» с учётом мощности и логистики — задача плана производства
  // (конвейер «Производство 2.0»), а не прогноза продаж.
  const BUF = cfg.deliveryBuffer ?? 1.15;
  const monthKey = (dt) => dt.slice(0, 7);
  const months = [...new Set(days.map((d) => monthKey(d.date)))];
  const deliveryByIdx = {}; const deliveries = [];
  for (const mk of months) {
    const md = days.filter((d) => monthKey(d.date) === mk);
    const demand = md.reduce((s, d) => s + d.final, 0);
    if (demand <= 0) continue;
    const qty = Math.round(demand * BUF);
    const arriveIdx = Math.max(0, md[0].i - 4);
    deliveryByIdx[arriveIdx] = (deliveryByIdx[arriveIdx] || 0) + qty;
    const hasSpike = miniSeasons.some((m) => monthKey(m.peakDate) === mk && m.confirmed);
    deliveries.push({ date: days[arriveIdx].date, qty, tag: 'подсорт', month: mk, needBy: days[arriveIdx].date,
      title: `Нужно на складе WB к ${days[arriveIdx].date}: подсорт под ${mk} (спрос ${Math.round(demand)} шт + буфер${hasSpike ? ', включает мини-сезон' : ''})` });
  }
  // склад-пила: держим положительным весь год (не обнуляем)
  let lvl = 0;
  for (let i = 0; i < days.length; i++) { lvl += (deliveryByIdx[i] || 0); lvl -= days[i].final; days[i].ourStock = Math.max(0, round(lvl, 0)); }

  const forecastDaily = days.map((d) => ({
    date: d.date,
    stage: inSeason(d.k) ? 'Сезон' : 'Межсезонье',
    favorable: !!cfg.favorableMonth[Number(d.date.slice(5, 7))] && d.final >= 0.6 * peakF,
    kSales: round(d.relief, 4),
    plannedOrders: d.final,
    price: round(cfg.meanPrice * (shape.priceIndex[d.k] || 1) * (cfg.priceAdj || 1), 0),
    stock: d.ourStock,
    floor: floorAbs,
  }));

  // календарные границы (для разметки истории теми же периодами)
  let peakI = 0; for (let i = 1; i < days.length; i++) if (days[i].relief > days[peakI].relief) peakI = i;
  const seasonCal = { entryCal: s0, hotStartCal: s0, peakCal: days[peakI].k, saleStartCal: (s1 % N) + 1, endCal: (s1 % N) + 1 };
  const phaseDates = { entry: days[0].date, hotStart: days[0].date, peak: days[peakI].date, saleStart: days[days.length - 1].date, end: days[days.length - 1].date };

  const total = vals.reduce((a, b) => a + b, 0);
  const minDaily = Math.min(...vals);
  const validation = {
    yearRound: { ok: floorAbs >= 0.04 * peakF, label: 'Продажи круглый год', value: `пол ${Math.round(floorAbs)} шт/день`, ref: `≥ ${round(0.04 * peakF, 1)}` },
    noZeroing: { ok: minDaily > 0, label: 'Склад не обнуляется', value: `мин ${round(minDaily, 1)} шт/день`, ref: '> 0' },
    peakVsTop3: { ok: Math.abs(peakF / ((cfg.top3Daily || 1) * (cfg.volumeAdj || 1)) - 1) <= 0.2, label: 'Пик ≈ ТОП-3', value: `${Math.round(peakF)} шт/день`, ref: `≈ ${Math.round((cfg.top3Daily || 1) * (cfg.volumeAdj || 1))}` },
    miniSeasons: { ok: true, label: 'Мини-сезоны учтены', value: `${miniSeasons.filter((m) => m.confirmed).length} подтв. из ${miniSeasons.length}`, ref: miniSeasons.map((m) => m.name).join(', ') || '—' },
  };

  return {
    forecastDaily, forecastPeriod: { from: days[0].date, to: days[days.length - 1].date },
    phaseDates, validation, top3PeakDaily: round(peakF, 0), totalUnits: Math.round(total),
    seasonCal, deliveries, restockDeadline: null, chosenYear: Number(asOf.slice(0, 4)), miniSeasons,
  };
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

  const isAllSeason = opts.articleType === 'allseason';
  const eng = isAllSeason
    ? buildAllSeasonYear(shape, {
        targetYear: year, asOf: opts.asOf, top3Daily: top3, volumeAdj, priceAdj, meanPrice,
        seasonFrac: opts.seasonFrac, favorableMonth, deliveryBuffer: opts.deliveryBuffer,
      })
    : buildEngineeredSeason(shape, {
        targetYear: year, asOf: opts.asOf, top3Daily: top3, volumeAdj, priceAdj, meanPrice,
        rampDays: opts.rampDays, seasonFrac: opts.seasonFrac, favorableMonth,
      });
  const effectiveYear = eng.chosenYear || year; // движок мог сдвинуть год вперёд (сезон уже прошёл)

  // Историческая кривая (2 года) — по фактическим дням (для второй диаграммы).
  // Размечаем ТЕМИ ЖЕ периодами (Разгон/Сезон/Распродажа/Межсезонье), что и прогноз:
  // по календарным границам сезона (день года), так периоды повторяются каждый год.
  const cal = eng.seasonCal;
  const historyDaily = active.map((r) => {
    const m = Number(r.date.slice(5, 7));
    const k = shape.calDayOf(r.date);
    const stage = periodOfCal(k, cal);
    return {
      date: r.date,
      stage,
      favorable: stage === 'Сезон' && !!favorableMonth[m], // благоприятный — только в Сезоне
      kSales: round(monthlyValueAt(indexMap, r.date), 4),
      price: round((Number(r.price) || 0), 0),
      sales: round(Number(r.sales) || 0, 1),
      stock: round(Number(r.stock ?? r.balance) || 0, 0),
    };
  });
  // ВЕХИ на истории — дни, чей день года совпал с вехой сезона (в каждом из 2 лет).
  const msCal = [['Вход', cal.entryCal], ['Старт сезона', cal.hotStartCal], ['Пик', cal.peakCal], ['Начало распродажи', cal.saleStartCal], ['Конец', cal.endCal]];
  const historyMilestones = [];
  for (const r of active) { const k = shape.calDayOf(r.date); for (const [name, cd] of msCal) if (k === cd) historyMilestones.push({ date: r.date, name }); }

  const favMonths = [...new Set(eng.forecastDaily.filter((d) => d.favorable).map((d) => Number(d.date.slice(5, 7))))].sort((a, b) => a - b);
  const favShare = eng.forecastDaily.length ? eng.forecastDaily.filter((d) => d.favorable).length / eng.forecastDaily.length : 0;

  // Авто-подсказка типа артикула по рыночному рельефу: амплитуда пик/медиана и «пол» (нижний
  // уровень к пику). Ровный весь год → круглогодичный; резкий с провалом в межсезон → сезонный.
  // Считаем по СГЛАЖЕННОМУ рельефу (31-дн тренд), иначе разовые лончевые спайки в сырых днях
  // дают неустойчивую амплитуду (прыгает от сдвига окна на пару дней).
  const trendH = smoothCirc(shape.index, 31);
  const relV = trendH.slice(1).filter((v) => v > 0).sort((a, b) => a - b);
  const rp = (q) => relV.length ? relV[Math.max(0, Math.floor(q * (relV.length - 1)))] : 0;
  const rP50 = rp(0.5), rP90 = rp(0.9), rP10 = rp(0.1);
  const amplitude = rP50 > 0 ? round(rP90 / rP50, 2) : 99;
  const floorSharePct = rP90 > 0 ? Math.round(rP10 / rP90 * 100) : 0;
  const suggest = (amplitude <= 2.2 && floorSharePct >= 25) ? 'allseason'
    : (amplitude >= 4 || floorSharePct < 12) ? 'seasonal' : 'mixed';
  const seasonalityHint = { amplitude, floorSharePct, suggest };

  return {
    mode: isAllSeason ? 'allseason' : 'seasonal',
    seasonalityHint,
    miniSeasons: eng.miniSeasons || null,
    forecastPeriod: eng.forecastPeriod,
    targetYear: effectiveYear,
    requestedYear: year,
    phaseDates: eng.phaseDates,
    seasonCal: eng.seasonCal,
    deliveries: eng.deliveries,
    restockDeadline: eng.restockDeadline,
    historyMilestones,
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
