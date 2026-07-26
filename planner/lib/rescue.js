// rescue.js — «спасатель сроков» (Фаза 3, 3b/3c v1).
//
// Для не начатых партий (статус «план»), у которых план не укладывается в дедлайн
// WB, ищем наименее разрушительный способ спасти срок:
//   1) переназначить партию ЦЕЛИКОМ в другой цех, ЗАМОРОЗИВ остальной план
//      (минимальное возмущение) — если цех успевает и никто новый не срывается;
//   2) если целиком никто не берёт при заморозке — «перетасовка»: даём движку
//      переоптимизировать (EDF сам двигает менее срочные партии помощника), но
//      принимаем только если никто новый не срывается, и показываем, кого затронули;
//   3) если безопасного варианта нет — эскалация «нужен ещё цех».
//
// Проверочный прогон встроен: каждый вариант — это полный buildSchedule, и мы
// сверяем множество срывов до/после (жадные «пожары» отсекаются).

import { buildSchedule } from './scheduler.js';

const MS = 86400000;
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / MS); // >0 если b позже a
const clone = (o) => JSON.parse(JSON.stringify(o));

// Партии, срывающие дедлайн в данном расписании (по id).
function lateSet(schedule) {
  return new Set((schedule.cycles || []).filter((c) => c.logistics.lateDays > 0).map((c) => c.partiaId));
}

/**
 * Найти предложения спасения. Возвращает массив предложений по проблемным
 * не начатым партиям. Каждое: { partiaId, articleId, workshopName, deadline,
 * plannedWb, lateDays, units, options:[{type,toWorkshopId,toWorkshopName,newWb,
 * transferDays,affected:[]}], escalate }.
 */
export function findRescues(state) {
  const base = buildSchedule(state);
  const transferDays = state.settings.transferDays ?? 2;
  const pById = Object.fromEntries((state.partias || []).map((p) => [p.id, p]));
  const wsById = Object.fromEntries((state.workshops || []).map((w) => [w.id, w]));

  // текущее (замороженное) назначение цехов из базового расписания
  const frozenWs = {};
  for (const c of base.cycles) frozenWs[c.partiaId] = c.workshopId;
  const baseLate = lateSet(base);

  // цель спасения: не начатые (план) партии, срывающие дедлайн
  const atRisk = base.cycles.filter((c) => {
    const p = pById[c.partiaId];
    return p && p.status === 'plan' && !p.historical && c.logistics.lateDays > 0;
  });

  // прогон с назначением партии targetWs; freeze=true — заморозить остальные на текущих цехах
  const trial = (partiaId, targetWs, freeze) => {
    const ts = clone(state);
    for (const q of ts.partias) {
      if (q.id === partiaId) { q.workshopId = targetWs; continue; }
      if (freeze && frozenWs[q.id]) q.workshopId = frozenWs[q.id];
    }
    return buildSchedule(ts);
  };

  const makesDeadline = (cyc, deadline) => deadline && daysBetween(cyc.logistics.wbArrival, deadline) >= transferDays;
  const newMisses = (sch, selfId) => sch.cycles.filter((c) => c.logistics.lateDays > 0 && c.partiaId !== selfId && !baseLate.has(c.partiaId));

  const proposals = [];
  for (const rc of atRisk) {
    const deadline = rc.logistics.deadline;
    const options = [];

    // базовые даты прихода на WB (для оценки, кого «подвинули» по времени)
    const baseWb = {};
    for (const c of base.cycles) baseWb[c.partiaId] = c.logistics.wbArrival;

    // Переназначить партию ЦЕЛИКОМ в другой цех, заморозив остальных: никто не
    // меняет цех — двигаются только ДАТЫ у цеха-помощника (умная вставка по EDF).
    // Берём вариант с наибольшим запасом до дедлайна.
    let best = null;
    for (const w of state.workshops) {
      if (w.id === rc.workshopId) continue;
      const sch = trial(rc.partiaId, w.id, true);
      const nc = sch.cycles.find((c) => c.partiaId === rc.partiaId);
      if (!nc || !makesDeadline(nc, deadline)) continue;
      if (newMisses(sch, rc.partiaId).length) continue;
      const slack = daysBetween(nc.logistics.wbArrival, deadline);
      // кого подвинули по времени (партии помощника, чей приход на WB стал позже)
      const shifted = sch.cycles.filter((c) => c.workshopId === w.id && c.partiaId !== rc.partiaId
        && baseWb[c.partiaId] && daysBetween(baseWb[c.partiaId], c.logistics.wbArrival) > 0)
        .map((c) => ({ articleId: c.articleId, partiaNo: c.partiaNo, shiftDays: daysBetween(baseWb[c.partiaId], c.logistics.wbArrival) }));
      if (!best || slack > best.slack) best = { w, wb: nc.logistics.wbArrival, slack, shifted };
    }
    if (best) {
      options.push({ type: 'reassign', toWorkshopId: best.w.id, toWorkshopName: best.w.name, newWb: best.wb, slack: best.slack, transferDays, affected: best.shifted });
    }

    proposals.push({
      partiaId: rc.partiaId, articleId: rc.articleId, articleName: rc.articleName,
      workshopId: rc.workshopId, workshopName: rc.workshopName, units: rc.units,
      deadline, plannedWb: rc.logistics.wbArrival, lateDays: rc.logistics.lateDays,
      options, escalate: options.length === 0,
    });
  }
  return proposals;
}
