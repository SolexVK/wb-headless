// jitLayout.js — «Экономная раскладка (JIT)» v2: НЕПРЕРЫВНЫЕ СЕЗОННЫЕ ВОЛНЫ.
//
// Урок v1: закрепление дат кроя (пины) перебивало «цех занят» → простои и параллельные модели.
// v2 работает ВМЕСТЕ с планировщиком: он сам сериализует поток (freeDate ⇒ непрерывность и одна
// модель за раз, сдвижки этапов соблюдаются). Мы лишь задаём АДДИТИВНЫЙ пол `partia.jitStart`
// (отдельно от ручного earliestStart) и распределение по цехам (ws-пины). Планировщик пакует вперёд.
//
// Идея экономии при непрерывном производстве:
//   • группируем по модели (цех шьёт модель целиком — меньше перестроек);
//   • порядок по дедлайну (EDD), летние с потолком 15.04 года продаж;
//   • обратный ход (ALAP) находит, насколько поздно может стартовать каждая партия, не срывая срок;
//   • там, где между дедлайнами большой зазор — образуется ВОЛНА (сезонная пауза), а ВНУТРИ волны
//     партии идут встык (непрерывно). Так капитал не мёрзнет, а простоев внутри блока нет.

import { buildSchedule } from './scheduler.js';
import { makeCalendar, addDays, diffDays, toISO } from './calendar.js';

export const SUMMER_ARTICLE_IDS = ['005', '006', '007', '014', '022', '032', '033', '034'];

// ── метрики раскладки (для превью «до/после») ──
export function layoutMetrics(schedule) {
  const cy = (schedule.cycles || []).filter((c) => !c.historical);
  const wsUsed = new Set(cy.map((c) => c.workshopId));
  const byWs = {};
  for (const c of cy) (byWs[c.workshopId] = byWs[c.workshopId] || []).push(c);
  let changeovers = 0, overlaps = 0, idleGapDays = 0, idleGaps = 0;
  for (const w in byWs) {
    const arr = byWs[w].sort((a, b) => (a.ops.cut.start < b.ops.cut.start ? -1 : a.ops.cut.start > b.ops.cut.start ? 1 : 0));
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].articleId !== arr[i - 1].articleId) changeovers++;
      const gap = diffDays(arr[i - 1].ops.sew.end, arr[i].ops.cut.start); // «цех занят» = крой→конец пошива
      if (gap < 0) overlaps++;            // наложение (параллель) — не должно быть
      else if (gap > 1) { idleGaps++; idleGapDays += gap; } // простой (между волнами — норм; внутри — плохо)
    }
  }
  let late = 0, lateUnits = 0, freezeUnitDays = 0;
  for (const c of cy) {
    const dl = c.logistics && c.logistics.deadline;
    if (dl && c.logistics.wbArrival) {
      const slack = diffDays(c.logistics.wbArrival, dl);
      if (slack > 0) freezeUnitDays += c.units * slack;
      if (c.logistics.lateDays > 0) { late++; lateUnits += c.units; }
    }
  }
  return {
    workshops: wsUsed.size, changeovers, overlaps, idleGaps, idleGapDays,
    lateBatches: late, lateUnits,
    freezeUnitDays: Math.round(freezeUnitDays),
    freezeMlnUnitDays: Math.round(freezeUnitDays / 1e5) / 10,
  };
}

// эффективный «крайний срок пошива» (готовность): для летних — не позже 15.04 года продаж.
function effDeadline(dl, isSummer, summerMMDD) {
  if (!dl) return '';
  if (!isSummer) return dl;
  const cap = `${dl.slice(0, 4)}-${summerMMDD}`;
  return diffDays(cap, dl) < 0 ? cap : dl; // если реальный дедлайн позже потолка — берём потолок
}

export function computeJitLayout(state, opts = {}) {
  const deliveryBufferDays = num(opts.deliveryBufferDays, 30);
  const nonSummerCushionDays = num(opts.nonSummerCushionDays, 60);
  const summerMMDD = /^\d{2}-\d{2}$/.test(opts.summerFinishMMDD || '') ? opts.summerFinishMMDD : '04-15';
  const waveGapDays = num(opts.waveGapDays, 45); // зазор (дн), с которого допускаем ПАУЗУ; меньше — «склеиваем» в непрерывный блок (континуитет ↔ экономия)
  const summerIds = new Set((opts.summerIds && opts.summerIds.length ? opts.summerIds : SUMMER_ARTICLE_IDS).map((x) => String(x).trim()));

  const cal = makeCalendar(state.settings.calendar);
  const wdBetween = (a, b) => { let n = 0, cur = a, g = 0; while (diffDays(cur, b) >= 0 && g++ < 100000) { if (cal.isWorkingDay(cur)) n++; cur = addDays(cur, 1); } return n; };
  const subWD = (iso, n) => { let cur = cal.nextWorkingDay(iso), left = Math.max(0, Math.ceil(n)), g = 0; while (left > 0 && g++ < 100000) { cur = addDays(cur, -1); while (!cal.isWorkingDay(cur)) cur = addDays(cur, -1); left--; } return cur; };
  const addWD = (iso, n) => cal.addWorkingDays(iso, n);

  // сезонный старт (как в планировщике) — общий пол
  let seasonStart = null;
  const psd = state.settings && state.settings.productionStartDate;
  if (psd && /^\d{4}-\d{2}-\d{2}$/.test(String(psd).slice(0, 10))) seasonStart = cal.nextWorkingDay(String(psd).slice(0, 10));
  else { for (const s of state.stages || []) { if (!s.productionMonth) continue; const d = cal.nextWorkingDay(`${s.productionMonth}-01`); if (seasonStart === null || d < seasonStart) seasonStart = d; } if (!seasonStart) seasonStart = cal.nextWorkingDay(toISO(new Date())); }

  const base = buildSchedule(state);
  const before = layoutMetrics(base);
  const groupByArticle = opts.groupByArticle !== false;

  // КОНЦЕНТРАЦИЯ «одна модель — один цех»: собираем каждый артикул в ОДИН цех (где у него больше объёма
  // в базе; при равенстве — свой). Это убирает перестройки и даёт группировку. С защитой: если сборка в
  // один цех рождает опоздания (цех не успевает к сроку) — оставляем базовое распределение этого артикула.
  let wsByBatch = Object.fromEntries(base.cycles.filter((c) => !c.historical).map((c) => [c.batchKey, c.workshopId]));
  if (groupByArticle) {
    const ownId = (state.workshops.find((w) => w.own) || {}).id;
    const volByArtWs = {};
    for (const c of base.cycles) { if (c.historical) continue; ((volByArtWs[c.articleId] = volByArtWs[c.articleId] || {}))[c.workshopId] = (volByArtWs[c.articleId][c.workshopId] || 0) + c.units; }
    const baseLate = before.lateUnits;
    for (const art of Object.keys(volByArtWs)) {
      const cur = volByArtWs[art];
      if (Object.keys(cur).length <= 1) continue; // уже в одном цехе
      const dest = Object.keys(cur).sort((a, b) => (cur[b] - cur[a]) || (a === ownId ? -1 : b === ownId ? 1 : 0))[0];
      const trial = { ...wsByBatch };
      for (const c of base.cycles) if (!c.historical && c.articleId === art) trial[c.batchKey] = dest;
      const late = layoutMetrics(buildSchedule(withWsPins(state, trial))).lateUnits;
      if (late <= baseLate) wsByBatch = trial; // приняли концентрацию, если не хуже по опозданиям
    }
  }
  // пересчёт в назначенных цехах — берём длительности/даты именно оттуда
  const s1 = buildSchedule(withWsPins(state, wsByBatch));
  const cyc = s1.cycles.filter((c) => !c.historical);

  // батчи с длительностями (из расписания в назначенном цехе)
  const items = cyc.map((c) => {
    const isSummer = summerIds.has(String(c.articleId).trim());
    const dl = (c.logistics && c.logistics.deadline) || '';
    return {
      partiaId: c.partiaId, batchKey: c.batchKey, articleId: c.articleId, ws: c.workshopId, isSummer, dl,
      effDl: effDeadline(dl, isSummer, summerMMDD),
      buffer: isSummer ? deliveryBufferDays : Math.max(deliveryBufferDays, nonSummerCushionDays),
      sewSpanWD: Math.max(1, wdBetween(c.ops.cut.start, c.ops.sew.end) - 1), // занятость цеха
      otkSpanWD: Math.max(1, wdBetween(c.ops.cut.start, c.ops.otk.end) - 1), // крой→готовность
      baseCut: c.ops.cut.start,
    };
  });

  // порядок в цехе: группируем по модели (все партии артикула подряд), артикулы — по раннему effDl.
  const byWs = {};
  for (const it of items) (byWs[it.ws] = byWs[it.ws] || []).push(it);
  const jitStarts = {}; // partiaId -> дата (пол волны)
  for (const ws in byWs) {
    const arr = byWs[ws];
    // ранний effDl каждого артикула
    const artFirst = {};
    for (const it of arr) { const k = it.articleId; if (!artFirst[k] || (it.effDl && it.effDl < artFirst[k])) artFirst[k] = it.effDl || '9999-12-31'; }
    arr.sort((a, b) => {
      if (artFirst[a.articleId] !== artFirst[b.articleId]) return artFirst[a.articleId] < artFirst[b.articleId] ? -1 : 1; // модель по раннему сроку
      if (a.articleId !== b.articleId) return a.articleId < b.articleId ? -1 : 1;                                        // держим модель вместе
      const ad = a.effDl || '9999', bd = b.effDl || '9999';
      if (ad !== bd) return ad < bd ? -1 : 1;                                                                            // внутри модели — по сроку
      return 0;
    });
    // обратный ход (ALAP): самый поздний крой каждого батча, не срывая срок и не налезая на следующий
    let nextStart = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      let latest = it.effDl ? subWD(it.effDl, it.buffer + it.otkSpanWD) : (nextStart ? subWD(nextStart, it.sewSpanWD) : it.baseCut);
      if (nextStart) { const byNext = subWD(nextStart, it.sewSpanWD); if (diffDays(byNext, latest) > 0) latest = byNext; } // не позже, чем освободит цех под следующий
      if (diffDays(latest, seasonStart) > 0) latest = seasonStart; // пол: не РАНЬШЕ старта сезона (seasonStart позже latest ⇒ поднять)
      it.alapCut = latest;
      nextStart = latest;
    }
    // вперёд по волнам: внутри волны — встык (непрерывно), новая волна — где ALAP оставляет зазор (пауза)
    let runningFree = null; // конец пошива предыдущего батча в текущей волне
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      let start;
      if (runningFree === null || diffDays(runningFree, it.alapCut) > waveGapDays) start = it.alapCut; // новая волна
      else start = runningFree; // продолжаем волну встык
      if (diffDays(start, seasonStart) > 0) start = seasonStart; // пол: не раньше старта сезона
      // пол волны пишем на партию (первый её батч в порядке); батчи одной партии планировщик упакует сам
      if (jitStarts[it.partiaId] === undefined || start < jitStarts[it.partiaId]) jitStarts[it.partiaId] = start;
      runningFree = addWD(start, it.sewSpanWD);
    }
  }

  // ЗАЩИТА ОТ ОПОЗДАНИЙ (приоритет #1): jitStart-пол сдвигает старт позже; если для какой-то партии
  // это привело к опозданию (волна перегружена по мощности) — снимаем её пол (пусть шьётся раньше, как
  // в базе). Итерируем, пока новых опозданий не останется. В худшем случае партия вернётся к базовому старту.
  const baseLatePart = new Set(s1.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0).map((c) => c.partiaId));
  let afterSch, guard = 0;
  while (guard++ < 40) {
    afterSch = buildSchedule(withJit(state, jitStarts, items));
    const nowLate = afterSch.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0 && !baseLatePart.has(c.partiaId));
    const offenders = [...new Set(nowLate.map((c) => c.partiaId))].filter((pid) => jitStarts[pid] !== undefined);
    if (!offenders.length) break;
    for (const pid of offenders) delete jitStarts[pid]; // снять пол → партия стартует рано (без нового опоздания)
  }
  const after = layoutMetrics(afterSch);

  const wsPins = {};
  for (const it of items) wsPins[it.batchKey] = { ws: it.ws }; // фиксируем цех (без даты)

  return { jitStarts, wsPins, before, after };
}

// копия state с ws-пинами (по батчам), без дат
function withWsPins(state, wsByBatch) {
  const bp = { ...(state.batchPins || {}) };
  for (const k in wsByBatch) bp[k] = { ...(bp[k] || {}), ws: wsByBatch[k] };
  return { ...state, batchPins: bp };
}

// копия state с наложенными jitStart (по партиям) и ws-пинами (по батчам)
function withJit(state, jitStarts, items) {
  const partias = (state.partias || []).map((p) => (jitStarts[p.id] !== undefined ? { ...p, jitStart: jitStarts[p.id] } : p));
  const bp = { ...(state.batchPins || {}) };
  for (const it of items) bp[it.batchKey] = { ...(bp[it.batchKey] || {}), ws: it.ws };
  return { ...state, partias, batchPins: bp };
}

function num(v, d) { const n = +v; return Number.isFinite(n) && n >= 0 ? n : d; }
