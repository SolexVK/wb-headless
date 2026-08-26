// jitLayout.js — «Экономная раскладка» v4: НЕПРЕРЫВНО + МИНИМУМ ЦЕХОВ.
//
// Жёсткие требования собственника: (1) производство БЕЗ РАЗРЫВОВ (непрерывный поток), (2) свой цех +
// максимум 2–3 дополнительных. Экономия — вторична (сначала непрерывность и мало цехов).
//
// Как гарантируем НЕПРЕРЫВНОСТЬ: НЕ распыляем партии по срокам (это давало разрывы). Собираем работу в
// немного цехов и даём планировщику паковать поток ВПЕРЁД встык (freeDate ⇒ 0 разрывов, одна модель за
// раз, сдвижки этапов). Экономия — лишь ЕДИНЫМ сдвигом всего блока цеха вправо (ALAP), насколько
// позволяет самый срочный дедлайн, БЕЗ появления разрывов. Всё аддитивно (partia.jitStart + ws-пины),
// ручной earliestStart не трогаем, обратимо «Сбросить раскладку».

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
  let totalUnits = 0, prodDays = 0; // КОНТРОЛЬ: суммарные изделия (должны сохраняться) и дни производства (Σ длин полос)
  for (const c of cy) {
    totalUnits += c.units;
    prodDays += Math.max(0, diffDays(c.ops.cut.start, c.ops.otk.end)); // длина полосы (крой→готовность) в календ. днях
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
    lateBatches: late, lateUnits, totalUnits, prodDays, cycles: cy.length,
    freezeMlnUnitDays: ml(freezeUnitDays), freezeNsMln: ml(freezeNs), freezeSuMln: ml(freezeSu),
  };
}

export function computeJitLayout(state, opts = {}) {
  const deliveryBufferDays = num(opts.deliveryBufferDays, 30);
  const nonSummerCushionDays = num(opts.nonSummerCushionDays, 60);
  const summerMMDD = /^\d{2}-\d{2}$/.test(opts.summerFinishMMDD || '') ? opts.summerFinishMMDD : '04-30'; // летние — к концу апреля
  const maxExtra = Math.max(0, Math.round(num(opts.maxExtraWorkshops, 3)));
  const ignoreAllowedMatrix = !!opts.ignoreAllowedMatrix; // фикс. сокращение: свой + N цехов вопреки матрице
  const balance = !!opts.balanceMinWorkshops;             // авто-баланс: МИНИМУМ цехов БЕЗ новых опозданий
  const summerIds = new Set((opts.summerIds && opts.summerIds.length ? opts.summerIds : SUMMER_ARTICLE_IDS).map((x) => String(x).trim()));

  const cal = makeCalendar(state.settings.calendar);
  const subWD = (iso, n) => { let cur = cal.nextWorkingDay(iso), left = Math.max(0, Math.ceil(n)), g = 0; while (left > 0 && g++ < 100000) { cur = addDays(cur, -1); while (!cal.isWorkingDay(cur)) cur = addDays(cur, -1); left--; } return cur; };
  const effDl = (dl, isSummer) => { if (!dl) return '2099-01-01'; if (!isSummer) return dl; const cap = `${dl.slice(0, 4)}-${summerMMDD}`; return diffDays(cap, dl) < 0 ? cap : dl; };

  const base = buildSchedule(state);
  const before = layoutMetrics(base, summerIds);

  const wsAll = (state.workshops || []).slice();
  const ownId = (wsAll.find((w) => w.own) || wsAll.find((w) => w.role === 'main') || wsAll[0] || {}).id;
  const sewCap = (w) => (w.capacities && +w.capacities.sew) || 0;
  const ranked = wsAll.filter((w) => w.id !== ownId).sort((a, b) => sewCap(b) - sewCap(a));
  const capById = Object.fromEntries(wsAll.map((w) => [w.id, sewCap(w) || 1]));
  const artVol = {};
  for (const c of base.cycles) { if (c.historical) continue; artVol[c.articleId] = (artVol[c.articleId] || 0) + c.units; }

  // назначение батчей по цехам: reduce ⇒ ужать в свой+N (жадная балансировка, вопреки матрице); иначе база
  const assignWs = (maxE, reduce) => {
    const map = {};
    for (const c of base.cycles) { if (c.historical) continue; map[c.batchKey] = c.workshopId; }
    if (!reduce) return { map, allowedN: new Set(base.cycles.filter((c) => !c.historical).map((c) => c.workshopId)).size };
    const allowedWs = [ownId, ...ranked.slice(0, maxE).map((w) => w.id)].filter(Boolean);
    const loadWd = Object.fromEntries(allowedWs.map((w) => [w, 0]));
    const artWs = {};
    for (const art of Object.keys(artVol).sort((a, b) => artVol[b] - artVol[a])) {
      const dest = allowedWs.slice().sort((a, b) => (loadWd[a] || 0) - (loadWd[b] || 0))[0];
      artWs[art] = dest; loadWd[dest] = (loadWd[dest] || 0) + artVol[art] / (capById[dest] || 1);
    }
    for (const c of base.cycles) if (!c.historical) map[c.batchKey] = artWs[c.articleId] || c.workshopId;
    return { map, allowedN: allowedWs.length };
  };

  // ЛЁГКАЯ оценка опозданий при данном распределении (только непрерывная упаковка, без сдвига) — для свипа
  const latenessOf = (maxE) => layoutMetrics(buildSchedule(withPins(state, assignWs(maxE, true).map, {})), summerIds).lateUnits;

  // ЯДРО: полная раскладка для (maxE, reduce) — распределение + непрерывная упаковка + сдвиг блоков + защита
  const runOnce = (maxE, reduce) => {
    const { map: wsByBatch, allowedN } = assignWs(maxE, reduce);
    const s1 = buildSchedule(withPins(state, wsByBatch, {}));
    const wsFirstCut = {}, wsMinSlack = {};
    for (const c of s1.cycles) {
      if (c.historical) continue;
      const w = c.workshopId;
      if (!wsFirstCut[w] || c.ops.cut.start < wsFirstCut[w]) wsFirstCut[w] = c.ops.cut.start;
      const isS = summerIds.has(String(c.articleId).trim());
      const dl = (c.logistics && c.logistics.deadline) || '';
      const buf = isS ? deliveryBufferDays : Math.max(deliveryBufferDays, nonSummerCushionDays);
      const slack = diffDays(c.logistics.wbArrival, subWD(effDl(dl, isS), 0)) - buf;
      if (wsMinSlack[w] === undefined || slack < wsMinSlack[w]) wsMinSlack[w] = slack;
    }
    const jitStarts = {};
    for (const w of Object.keys(wsFirstCut)) {
      const shift = Math.max(0, Math.floor(wsMinSlack[w] || 0));
      if (shift <= 0) continue;
      const start = cal.addWorkingDays(wsFirstCut[w], shift);
      for (const c of s1.cycles) if (!c.historical && c.workshopId === w) jitStarts[c.partiaId] = start;
    }
    const items = s1.cycles.filter((c) => !c.historical).map((c) => ({ batchKey: c.batchKey, ws: c.workshopId, partiaId: c.partiaId }));
    const baseLate = new Set(s1.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0).map((c) => c.partiaId));
    let afterSch, guard = 0;
    while (guard++ < 20) {
      afterSch = buildSchedule(withJit(state, jitStarts, items));
      const bad = new Set(), byWs = {};
      for (const c of afterSch.cycles) { if (c.historical) continue; (byWs[c.workshopId] = byWs[c.workshopId] || []).push(c); }
      for (const w in byWs) { const arr = byWs[w].sort((a, b) => (a.ops.cut.start < b.ops.cut.start ? -1 : 1)); for (let i = 1; i < arr.length; i++) if (diffDays(arr[i - 1].ops.sew.end, arr[i].ops.cut.start) > 1) bad.add(w); }
      for (const c of afterSch.cycles) if (!c.historical && c.logistics.lateDays > 0 && !baseLate.has(c.partiaId)) bad.add(c.workshopId);
      if (!bad.size) break;
      for (const c of s1.cycles) if (!c.historical && bad.has(c.workshopId)) delete jitStarts[c.partiaId];
    }
    let after = layoutMetrics(afterSch, summerIds);
    // страховка (не-reduce): не хуже базы по опозданиям/разрывам — иначе откат сдвига
    if (!reduce && (after.lateUnits > before.lateUnits || after.idleGaps > before.idleGaps)) {
      for (const k of Object.keys(jitStarts)) delete jitStarts[k];
      afterSch = buildSchedule(withJit(state, jitStarts, items));
      after = layoutMetrics(afterSch, summerIds);
    }
    const wsPins = {};
    for (const it of items) wsPins[it.batchKey] = { ws: it.ws };
    for (const k of Object.keys(jitStarts)) if (!jitStarts[k]) delete jitStarts[k];
    return { jitStarts, wsPins, after, allowedWorkshops: allowedN };
  };

  let r, chosenExtra = maxExtra, note = '';
  if (balance) {
    // СВИП: наименьшее число доп.цехов, при котором опоздания НЕ выше базы (нет НОВЫХ срывов).
    // Быстрая оценка latenessOf (без сдвига), затем полный runOnce для найденного N.
    chosenExtra = null;
    for (let e = 0; e < wsAll.length; e++) { if (latenessOf(e) <= before.lateUnits) { chosenExtra = e; break; } }
    if (chosenExtra === null) { chosenExtra = wsAll.length - 1; note = 'даже всеми цехами опоздания не убрать (упор в сроки/мощность)'; }
    r = runOnce(chosenExtra, true);
    note = note || `минимум цехов без новых опозданий: ${r.allowedWorkshops}`;
  } else {
    r = runOnce(maxExtra, ignoreAllowedMatrix);
  }

  return { jitStarts: r.jitStarts, wsPins: r.wsPins, before, after: r.after, allowedWorkshops: r.allowedWorkshops, reduceMode: ignoreAllowedMatrix || balance, balance, note };
}

function withPins(state, wsByBatch, jitStarts) {
  const partias = (state.partias || []).map((p) => (jitStarts[p.id] ? { ...p, jitStart: jitStarts[p.id] } : { ...p, jitStart: '' }));
  const bp = { ...(state.batchPins || {}) };
  for (const k in wsByBatch) bp[k] = { ...(bp[k] || {}), ws: wsByBatch[k] };
  return { ...state, partias, batchPins: bp };
}
function withJit(state, jitStarts, items) {
  const partias = (state.partias || []).map((p) => (jitStarts[p.id] ? { ...p, jitStart: jitStarts[p.id] } : { ...p, jitStart: '' }));
  const bp = { ...(state.batchPins || {}) };
  for (const it of items) bp[it.batchKey] = { ...(bp[it.batchKey] || {}), ws: it.ws };
  return { ...state, partias, batchPins: bp };
}
function num(v, d) { const n = +v; return Number.isFinite(n) && n >= 0 ? n : d; }
