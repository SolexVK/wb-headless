// jitLayout.js — «Экономная раскладка» v3: ДВУХКЛАССОВЫЙ НЕПРЕРЫВНЫЙ ПОТОК.
//
// Ключевая идея (уточнение собственника): летние сезонные модели ВСЁ РАВНО шьются заранее и лежат
// (продажи с конца марта/апреля). Значит летние — гибкий «НАПОЛНИТЕЛЬ»: ими затыкаем простои, чтобы
// поток был непрерывным, лишь бы всё летнее было готово к 15.04. А несезонные (демисезон) — шьём строго
// JIT (как можно позже, но в срок) ради экономии денег. Тогда:
//   • несезон задаёт «скелет» по дедлайнам (максимальная экономия, минимум заморозки);
//   • летнее заполняет промежутки (до/между/после несезонных волн) → производство не встаёт;
//   • всё летнее — к 15.04; несезон — к своим дедлайнам ВБ (с буфером).
//
// Механика — БЕЗ пинов дат (v1 так ломал непрерывность). Задаём аддитивный пол `partia.jitStart`
// (отдельно от ручного earliestStart) + распределение по цехам. Планировщик сам сериализует поток
// (freeDate ⇒ непрерывность, одна модель за раз, сдвижки этапов). Всё обратимо «Сбросить раскладку».

import { buildSchedule } from './scheduler.js';
import { makeCalendar, addDays, diffDays, toISO } from './calendar.js';

export const SUMMER_ARTICLE_IDS = ['005', '006', '007', '014', '022', '032', '033', '034'];

export function layoutMetrics(schedule, summerSet = null) {
  const cy = (schedule.cycles || []).filter((c) => !c.historical);
  const wsUsed = new Set(cy.map((c) => c.workshopId));
  const byWs = {};
  for (const c of cy) (byWs[c.workshopId] = byWs[c.workshopId] || []).push(c);
  let changeovers = 0, overlaps = 0, idleGaps = 0, idleGapDays = 0;
  for (const w in byWs) {
    const arr = byWs[w].sort((a, b) => (a.ops.cut.start < b.ops.cut.start ? -1 : a.ops.cut.start > b.ops.cut.start ? 1 : 0));
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].articleId !== arr[i - 1].articleId) changeovers++;
      const gap = diffDays(arr[i - 1].ops.sew.end, arr[i].ops.cut.start);
      if (gap < 0) overlaps++;
      else if (gap > 1) { idleGaps++; idleGapDays += gap; }
    }
  }
  let late = 0, lateUnits = 0, freezeUnitDays = 0, freezeNs = 0, freezeSu = 0;
  for (const c of cy) {
    const dl = c.logistics && c.logistics.deadline;
    if (dl && c.logistics.wbArrival) {
      const slack = diffDays(c.logistics.wbArrival, dl);
      if (slack > 0) { const f = c.units * slack; freezeUnitDays += f; if (summerSet && summerSet.has(String(c.articleId).trim())) freezeSu += f; else freezeNs += f; }
      if (c.logistics.lateDays > 0) { late++; lateUnits += c.units; }
    }
  }
  const ml = (x) => Math.round(x / 1e5) / 10;
  return {
    workshops: wsUsed.size, changeovers, overlaps, idleGaps, idleGapDays,
    lateBatches: late, lateUnits,
    freezeUnitDays: Math.round(freezeUnitDays),
    freezeMlnUnitDays: ml(freezeUnitDays),
    freezeNsMln: ml(freezeNs),   // несезон — экономим
    freezeSuMln: ml(freezeSu),   // лето — неизбежная заморозка (к 15.04)
  };
}

export function computeJitLayout(state, opts = {}) {
  const deliveryBufferDays = num(opts.deliveryBufferDays, 30);
  const nonSummerCushionDays = num(opts.nonSummerCushionDays, 60);
  const summerMMDD = /^\d{2}-\d{2}$/.test(opts.summerFinishMMDD || '') ? opts.summerFinishMMDD : '04-15';
  const groupByArticle = opts.groupByArticle !== false;
  const summerIds = new Set((opts.summerIds && opts.summerIds.length ? opts.summerIds : SUMMER_ARTICLE_IDS).map((x) => String(x).trim()));

  const cal = makeCalendar(state.settings.calendar);
  const wdBetween = (a, b) => { let n = 0, cur = a, g = 0; while (diffDays(cur, b) >= 0 && g++ < 100000) { if (cal.isWorkingDay(cur)) n++; cur = addDays(cur, 1); } return n; };
  const subWD = (iso, n) => { let cur = cal.nextWorkingDay(iso), left = Math.max(0, Math.ceil(n)), g = 0; while (left > 0 && g++ < 100000) { cur = addDays(cur, -1); while (!cal.isWorkingDay(cur)) cur = addDays(cur, -1); left--; } return cur; };
  const addWD = (iso, n) => cal.addWorkingDays(iso, Math.max(0, Math.ceil(n)));
  const laterOf = (a, b) => (diffDays(a, b) > 0 ? b : a);

  let seasonStart = null;
  const psd = state.settings && state.settings.productionStartDate;
  if (psd && /^\d{4}-\d{2}-\d{2}$/.test(String(psd).slice(0, 10))) seasonStart = cal.nextWorkingDay(String(psd).slice(0, 10));
  else { for (const s of state.stages || []) { if (!s.productionMonth) continue; const d = cal.nextWorkingDay(`${s.productionMonth}-01`); if (seasonStart === null || d < seasonStart) seasonStart = d; } if (!seasonStart) seasonStart = cal.nextWorkingDay(toISO(new Date())); }

  const base = buildSchedule(state);
  const before = layoutMetrics(base, summerIds);

  // КОНЦЕНТРАЦИЯ «одна модель — один цех» (с защитой от опозданий) — сохраняет смешение лето/несезон в цехе.
  let wsByBatch = Object.fromEntries(base.cycles.filter((c) => !c.historical).map((c) => [c.batchKey, c.workshopId]));
  if (groupByArticle) {
    const ownId = (state.workshops.find((w) => w.own) || {}).id;
    const volByArtWs = {};
    for (const c of base.cycles) { if (c.historical) continue; ((volByArtWs[c.articleId] = volByArtWs[c.articleId] || {}))[c.workshopId] = (volByArtWs[c.articleId][c.workshopId] || 0) + c.units; }
    const baseLate = before.lateUnits;
    for (const art of Object.keys(volByArtWs)) {
      const cur = volByArtWs[art];
      if (Object.keys(cur).length <= 1) continue;
      const dest = Object.keys(cur).sort((a, b) => (cur[b] - cur[a]) || (a === ownId ? -1 : b === ownId ? 1 : 0))[0];
      const trial = { ...wsByBatch };
      for (const c of base.cycles) if (!c.historical && c.articleId === art) trial[c.batchKey] = dest;
      if (layoutMetrics(buildSchedule(withWsPins(state, trial))).lateUnits <= baseLate) wsByBatch = trial;
    }
  }
  const s1 = buildSchedule(withWsPins(state, wsByBatch));

  // агрегируем БАТЧИ → ПАРТИИ (планировщик шьёт батчи партии подряд): занятость и «крой→готовность» партии
  const byPartia = {};
  for (const c of s1.cycles) {
    if (c.historical) continue;
    const k = c.partiaId;
    const it = byPartia[k] || (byPartia[k] = { partiaId: k, articleId: c.articleId, ws: c.workshopId, isSummer: summerIds.has(String(c.articleId).trim()), dl: (c.logistics && c.logistics.deadline) || '', cut: c.ops.cut.start, sewEnd: c.ops.sew.end, otkEnd: c.ops.otk.end });
    if (c.ops.cut.start < it.cut) it.cut = c.ops.cut.start;
    if (c.ops.sew.end > it.sewEnd) it.sewEnd = c.ops.sew.end;
    if (c.ops.otk.end > it.otkEnd) it.otkEnd = c.ops.otk.end;
  }
  const partias = Object.values(byPartia).map((it) => {
    const sewSpanWD = Math.max(1, wdBetween(it.cut, it.sewEnd) - 1);   // занятость цеха партией
    const otkSpanWD = Math.max(1, wdBetween(it.cut, it.otkEnd) - 1);   // крой→готовность
    // «готов к» (otk): несезон = дедлайн − подушка; лето = min(дедлайн, 15.04 года) − буфер доставки
    let readyBy;
    if (it.dl) {
      if (it.isSummer) { const cap = `${it.dl.slice(0, 4)}-${summerMMDD}`; const base2 = diffDays(cap, it.dl) < 0 ? cap : it.dl; readyBy = addDays(base2, -deliveryBufferDays); }
      else readyBy = addDays(it.dl, -Math.max(deliveryBufferDays, nonSummerCushionDays));
    } else readyBy = '2099-01-01';
    let latestCut = subWD(cal.nextWorkingDay(readyBy), otkSpanWD);
    if (diffDays(latestCut, seasonStart) > 0) latestCut = seasonStart; // пол: не раньше старта сезона
    return { ...it, sewSpanWD, otkSpanWD, readyBy, latestCut };
  });

  // ── двухклассовый планировщик по каждому цеху → jitStart на партию ──
  const jitStarts = {};
  const wsGroups = {};
  for (const p of partias) (wsGroups[p.ws] = wsGroups[p.ws] || []).push(p);
  for (const ws in wsGroups) {
    const grp = wsGroups[ws];
    const ns = grp.filter((p) => !p.isSummer);
    const su = grp.filter((p) => p.isSummer);
    // ALAP несезона (обратный ход): самый поздний старт, не срывая срок и не налезая на следующий
    ns.sort((a, b) => (a.latestCut < b.latestCut ? -1 : a.latestCut > b.latestCut ? 1 : 0));
    let nextStart = null;
    for (let i = ns.length - 1; i >= 0; i--) {
      const p = ns[i];
      let latest = p.latestCut;
      if (nextStart) { const byNext = subWD(nextStart, p.sewSpanWD); if (diffDays(byNext, latest) > 0) latest = byNext; }
      if (diffDays(latest, seasonStart) > 0) latest = seasonStart;
      p.startAt = latest; nextStart = latest;
    }
    // ЛЕТО — наполнитель. Форвард-симуляция: несезон стартует не раньше своего startAt (JIT),
    // промежутки затыкаем летом (к 15.04). Порядок лета — по «tightest» latestCut.
    const nsQ = ns.slice().sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
    const suQ = su.slice().sort((a, b) => (a.latestCut < b.latestCut ? -1 : a.latestCut > b.latestCut ? 1 : 0));
    const nsDone = new Set(), suDone = new Set();
    let T = seasonStart, guard = 0;
    const place = (p) => { jitStarts[p.partiaId] = laterOf(seasonStart, T); T = addWD(T, p.sewSpanWD); };
    while ((nsDone.size < nsQ.length || suDone.size < suQ.length) && guard++ < grp.length + 5) {
      // 1) есть ли «созревший» несезон (T достиг его позднего старта startAt)? берём самый срочный
      const dueNs = nsQ.filter((p) => !nsDone.has(p.partiaId) && diffDays(p.startAt, T) >= 0); // T ≥ startAt
      if (dueNs.length) { const p = dueNs[0]; place(p); nsDone.add(p.partiaId); continue; }
      const nextNs = nsQ.find((p) => !nsDone.has(p.partiaId));
      const nextNsStart = nextNs ? nextNs.startAt : null;
      const suLeft = suQ.filter((p) => !suDone.has(p.partiaId));
      if (suLeft.length) {
        if (nextNsStart === null) { const p = suLeft[0]; place(p); suDone.add(p.partiaId); continue; } // несезона нет — просто шьём лето
        // подобрать лето, которое ВЛЕЗАЕТ до старта следующего несезона (не задержит его) — берём максимально длинное
        const fits = suLeft.filter((p) => diffDays(addWD(T, p.sewSpanWD), nextNsStart) <= 0).sort((a, b) => b.sewSpanWD - a.sewSpanWD);
        if (fits.length) { const p = fits[0]; place(p); suDone.add(p.partiaId); continue; }
        // ничего не влезло — прыжок к следующему несезону (пауза), если она есть; иначе шьём лето подряд
        if (diffDays(T, nextNsStart) > 0) { T = nextNsStart; continue; }
        const p = suLeft[0]; place(p); suDone.add(p.partiaId); continue;
      }
      // только несезон, не созрел — прыжок к нему (пауза)
      if (nextNsStart && diffDays(T, nextNsStart) > 0) { T = nextNsStart; continue; }
      break;
    }
    // подстраховка: если кто-то не размещён (guard) — без пола (ранний старт)
    for (const p of grp) if (jitStarts[p.partiaId] === undefined) jitStarts[p.partiaId] = '';
  }

  // ЗАЩИТА ОТ ОПОЗДАНИЙ (приоритет #1): снимаем пол у партий, у которых он породил новое опоздание.
  const baseLatePart = new Set(s1.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0).map((c) => c.partiaId));
  const items = s1.cycles.filter((c) => !c.historical).map((c) => ({ batchKey: c.batchKey, ws: c.workshopId }));
  let afterSch, guard = 0;
  while (guard++ < 60) {
    afterSch = buildSchedule(withJit(state, jitStarts, items));
    const nowLate = afterSch.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0 && !baseLatePart.has(c.partiaId));
    const offenders = [...new Set(nowLate.map((c) => c.partiaId))].filter((pid) => jitStarts[pid]);
    if (!offenders.length) break;
    for (const pid of offenders) jitStarts[pid] = '';
  }
  const after = layoutMetrics(afterSch, summerIds);

  const wsPins = {};
  for (const it of items) wsPins[it.batchKey] = { ws: it.ws };
  // чистим пустые полы
  for (const k of Object.keys(jitStarts)) if (!jitStarts[k]) delete jitStarts[k];

  return { jitStarts, wsPins, before, after };
}

function withWsPins(state, wsByBatch) {
  const bp = { ...(state.batchPins || {}) };
  for (const k in wsByBatch) bp[k] = { ...(bp[k] || {}), ws: wsByBatch[k] };
  return { ...state, batchPins: bp };
}
function withJit(state, jitStarts, items) {
  const partias = (state.partias || []).map((p) => (jitStarts[p.id] ? { ...p, jitStart: jitStarts[p.id] } : { ...p, jitStart: '' }));
  const bp = { ...(state.batchPins || {}) };
  for (const it of items) bp[it.batchKey] = { ...(bp[it.batchKey] || {}), ws: it.ws };
  return { ...state, partias, batchPins: bp };
}
function num(v, d) { const n = +v; return Number.isFinite(n) && n >= 0 ? n : d; }
