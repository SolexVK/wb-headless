// scheduler.js — авторасчёт производственного плана.
//
// Идея:
//  - для каждого ЭТАПА берём объёмы всех артикулов (шт) на этот этап;
//  - распределяем артикулы по цехам так, чтобы каждый успел за календарный
//    месяц отшива; если один цех не тянет объём — делим партию между цехами
//    пропорционально мощности пошива (узкое горлышко);
//  - внутри цеха циклы идут без простоя: новый КРОЙ стартует, когда закончен
//    ПОШИВ предыдущего цикла (у операций разные рабочие);
//  - внутри цикла операции идут потоком с перекрытием
//    (крой → пошив → утюжка → ОТК), даты считаются в рабочих днях;
//  - под каждый цикл считаем заказ ткани (лид-тайм 3 недели + буфер) и
//    логистику до WB (недельный карго + 10–15 дней), сверяем с дедлайном.

import { makeCalendar, addDays, diffDays, parseISO, toISO, dayOfWeek } from './calendar.js';
import { partiasOf, partiaPlanUnits, partiaFactUnits, partiaEffectiveUnits, PARTIA_STATUS_RU, sumMatrixStage } from './model.js';
import { validateMatrix } from './nesting.js';
import { computeSupplyNetting } from './supply.js';

const OPS = ['cut', 'sew', 'iron', 'otk'];
const OP_RU = { cut: 'Крой', sew: 'Пошив', iron: 'Утюжка', otk: 'ОТК' };

function monthStartISO(ym) {
  return `${ym}-01`;
}
function monthEndISO(ym) {
  const [y, m] = ym.split('-').map(Number);
  return toISO(new Date(Date.UTC(y, m, 0)));
}

// длительность операции для партии units при производительности rate (шт/день),
// в рабочих днях (не меньше 1, если есть объём)
function opDurationWD(units, rate) {
  if (units <= 0) return 0;
  return Math.max(1, Math.ceil(units / rate));
}

// Разрешить смещения операций внутри цикла для цеха (в рабочих днях).
// Приоритет — явные per-цех значения w.flowOffsets {sew,iron,otk};
// иначе — вычисляем из глобальных порогов (шт) и мощности цеха.
export function resolveFlowOffsets(w, flow) {
  const fo = (w && w.flowOffsets) || {};
  const caps = w.capacities;
  const pick = (v, fallback) => (Number.isFinite(+v) && v !== '' && v != null ? Math.max(0, Math.round(+v)) : fallback);
  return {
    sew: pick(fo.sew, Math.max(1, Math.ceil((flow.sewAfterCut || 250) / caps.cut))),
    iron: pick(fo.iron, Math.max(1, Math.ceil((flow.ironAfterSew || 300) / caps.sew))),
    otk: pick(fo.otk, Math.max(1, Math.ceil((flow.otkAfterIron || 1000) / caps.iron))),
  };
}

// Рассчитать поток одного цикла в рабочих днях. offsets {sew,iron,otk} —
// смещения старта операции относительно предыдущей (раб. дней).
function computeFlowWD(units, caps, offsets, cutStartWD) {
  const offCut = offsets.sew;   // сдвиг пошива относительно кроя
  const offSew = offsets.iron;  // сдвиг утюжки относительно пошива
  const offIron = offsets.otk;  // сдвиг ОТК относительно утюжки

  const cut = { start: cutStartWD, dur: opDurationWD(units, caps.cut) };
  cut.end = cut.start + cut.dur;

  const sew = { start: cut.start + offCut, dur: opDurationWD(units, caps.sew) };
  sew.end = Math.max(sew.start + sew.dur, cut.end); // пошив завершается после кроя

  const iron = { start: sew.start + offSew, dur: opDurationWD(units, caps.iron) };
  iron.end = Math.max(iron.start + iron.dur, sew.end);

  const otk = { start: iron.start + offIron, dur: opDurationWD(units, caps.otk) };
  otk.end = Math.max(otk.start + otk.dur, iron.end);

  return { cut, sew, iron, otk, readyWD: otk.end };
}

// следующий день недели weekday (0..6), начиная с iso включительно
function nextWeekday(iso, weekday) {
  let cur = iso;
  let guard = 0;
  while (dayOfWeek(cur) !== weekday && guard++ < 14) cur = addDays(cur, 1);
  return cur;
}

// Выбрать «свой» цех (приоритетный). Явный флаг w.own; иначе — цех с ролью 'own';
// иначе первый 'main'; иначе первый в списке.
function pickOwnWorkshop(workshops) {
  return (workshops.find((w) => w.own) || workshops.find((w) => w.role === 'own')
    || workshops.find((w) => w.role === 'main') || workshops[0] || null);
}

// Основная функция — НЕПРЕРЫВНЫЙ КОНВЕЙЕР (Производство 2.0, Фаза 1).
//
// Уходим от жёсткой привязки к месяцам. Все партии сезона — единый пул заданий.
// От старта сезона гоним событийную очередь: цех, который освободится раньше,
// берёт следующую партию. Приоритет — своему цеху; порядок — по близости дедлайна
// (EDF) с чередованием артикулов (при равном дедлайне берём тот артикул, что
// меньше в работе, — чтобы товар шёл параллельно, а не «сначала весь А»).
// Партия, которой вручную задан цех, — закреплена (только на нём). Месяц отшива
// (productionMonth) больше не ограничивает — задаёт лишь старт сезона и дедлайны.
// Дробление партии между цехами тут не делаем: каждая партия идёт целиком в один
// цех (дробление под дедлайн — Фаза 3). Возвращает { cycles, warnings, fabricOrders }.
export function buildSchedule(state) {
  const cal = makeCalendar(state.settings.calendar);
  const flow = state.settings.flow;
  const fabricCfg = state.settings.fabric;
  const logi = state.settings.logistics;
  const riskBuf = state.settings.riskBufferDays || 0;
  // контроль отставания (3a): «сегодня» и порог
  const todayISO = /^\d{4}-\d{2}-\d{2}$/.test(state.settings.planningDate || '')
    ? state.settings.planningDate : toISO(new Date());
  const delayThreshold = state.settings.delayThresholdDays ?? 6;

  const wsById = Object.fromEntries(state.workshops.map((w) => [w.id, w]));
  const stageById = Object.fromEntries(state.stages.map((s) => [s.id, s]));
  const stageOrder = {}; state.stages.forEach((s, i) => { stageOrder[s.id] = i; });
  const articleById = Object.fromEntries(state.articles.map((a) => [a.id, a]));
  const warnings = [];
  const cycles = [];

  // Раньше требовались этапы. Теперь партия-поставка живёт по своему deadline — этапы необязательны.
  // Достаточно наличия цехов; если нет партий, конвейер просто вернёт пустой результат.
  if (!state.workshops.length) {
    return { cycles, warnings, fabricOrders: aggregateFabric(cycles, state), generatedFor: [] };
  }

  // старт конвейера (точка отсчёта). Приоритет — явная настройка productionStartDate; иначе
  // самый ранний рабочий день среди месяцев отшива этапов; иначе сегодня.
  let seasonStart = null;
  const psd = state.settings && state.settings.productionStartDate;
  if (psd && /^\d{4}-\d{2}-\d{2}$/.test(String(psd).slice(0, 10))) {
    seasonStart = cal.nextWorkingDay(String(psd).slice(0, 10)); // явная точка отсчёта производства
  } else {
    for (const s of state.stages) {
      if (!s.productionMonth) continue;
      const d = cal.nextWorkingDay(monthStartISO(s.productionMonth));
      if (seasonStart === null || d < seasonStart) seasonStart = d;
    }
    if (!seasonStart) seasonStart = cal.nextWorkingDay(toISO(new Date()));
  }

  const ownWs = pickOwnWorkshop(state.workshops);
  const ownId = ownWs ? ownWs.id : null;
  const roleRank = (w) => (w.id === ownId ? 0 : w.role === 'main' ? 1 : 2);

  // НЕТТИНГ: к производству = план − уже существующее предложение (остатки/в пути/производство).
  // Живой слой — planMatrix не трогаем, считаем «к производству» на каждом расчёте.
  const netting = computeSupplyNetting(state, todayISO);

  // задания = партии (не прошлые, объём К ПРОИЗВОДСТВУ > 0 после неттинга)
  const jobs = [];
  for (const p of state.partias) {
    if (p.historical) continue;
    const article = articleById[p.articleId];
    if (!article) continue;
    if (article.archived) continue; // архивный артикул не планируется
    // net-матрица (план минус покрытое предложением) для план-партий; иначе — как есть
    const prodMatrix = netting.net[p.id] || p.planMatrix;
    const units = sumMatrixStage(prodMatrix);
    if (units <= 0) continue; // полностью покрыто предложением — производить нечего
    const stage = stageById[p.stageId];
    jobs.push({
      partia: p, article, units, stage, prodMatrix,
      // дедлайн партии-поставки — собственный (дата прихода на WB); иначе дедлайн этапа (legacy).
      deadline: p.deadline || (stage ? stage.deadline : null),
      stageOrd: stageOrder[p.stageId] ?? 99,
      lockedWs: (p.workshopId && wsById[p.workshopId]) ? p.workshopId : null,
      done: false,
    });
  }

  // дата, когда цех свободен для след. кроя (изначально — старт сезона)
  const freeDate = {}; for (const w of state.workshops) freeDate[w.id] = seasonStart;
  const idxByWs = {}; for (const w of state.workshops) idxByWs[w.id] = 0;
  const startedUnits = {}; // по артикулу — для чередования

  const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  const dl = (j) => j.deadline || '9999-12-31';
  // «Не начинать раньше» (пер-партия) — производственная пауза/окно из «Ритма производства».
  // Пустое/невалидное = нет ограничения (старт с seasonStart). Клампим к рабочему дню.
  const esOf = (j) => {
    const s = j.partia && j.partia.earliestStart;
    if (s && /^\d{4}-\d{2}-\d{2}$/.test(String(s).slice(0, 10))) {
      const d = cal.nextWorkingDay(String(s).slice(0, 10));
      return d > seasonStart ? d : seasonStart; // раньше старта сезона всё равно нельзя
    }
    return seasonStart;
  };
  // фактический старт цикла в цехе w для задания j = позже из {цех свободен, «не раньше»}
  const effStartOf = (w, j) => { const es = esOf(j); const fd = freeDate[w.id]; return fd > es ? fd : es; };

  // лучший job для цеха w: сперва по РАННОСТИ реального старта (готов к работе), затем срочность.
  // Так простой цеха возникает ТОЛЬКО когда нет готового задания (это и есть пауза), а не когда
  // есть что шить прямо сейчас.
  const bestJobFor = (w) => {
    let best = null, bestEff = null;
    for (const j of jobs) {
      if (j.done) continue;
      if (j.lockedWs && j.lockedWs !== w.id) continue; // закреплён за другим цехом
      const allow = j.article.allowedWorkshops; // ручное закрепление «цех умеет шить эту модель»
      if (Array.isArray(allow) && allow.length && !allow.includes(w.id)) continue; // цех не шьёт этот артикул
      const eff = effStartOf(w, j);
      if (best === null) { best = j; bestEff = eff; continue; }
      const c = cmp(eff, bestEff)
        || cmp(dl(j), dl(best))
        || ((startedUnits[j.article.id] || 0) - (startedUnits[best.article.id] || 0))
        || (best.units - j.units);
      if (c < 0) { best = j; bestEff = eff; }
    }
    return best ? { job: best, eff: bestEff } : null;
  };

  // событийная очередь: пока есть нераспределённые — назначаем по одному
  let remaining = jobs.length;
  let guard = 0;
  while (remaining > 0 && guard++ < jobs.length + 5) {
    let bw = null, bj = null, bEff = null;
    for (const w of state.workshops) {
      const r = bestJobFor(w);
      if (!r) continue;
      if (bw === null
        || cmp(r.eff, bEff) < 0
        || (r.eff === bEff && roleRank(w) < roleRank(bw))) {
        bw = w; bj = r.job; bEff = r.eff;
      }
    }
    if (!bw || !bj) break; // не осталось доступных пар (напр., все закреплены на несуществующие)

    const w = bw, job = bj;
    const i = idxByWs[w.id]++;
    const cid = cycleId(job.partia.id, w.id, i);
    const ovr = (state.overrides || {})[cid];

    let anchorFirstWork = bEff; // старт с учётом «не раньше» (паузы) — уже ≥ freeDate[w.id]
    if (ovr && ovr.cutStart) anchorFirstWork = cal.nextWorkingDay(ovr.cutStart); // ручной сдвиг

    const wsOffsets = resolveFlowOffsets(w, flow);
    const f = computeFlowWD(job.units, w.capacities, wsOffsets, 0);
    const toDate = (wd) => cal.addWorkingDays(anchorFirstWork, wd);
    const dates = {};
    for (const op of OPS) dates[op] = { start: toDate(f[op].start), end: toDate(f[op].end) };
    const cutStart = dates.cut.start;
    const sewStart = dates.sew.start;
    const readyDate = dates.otk.end;

    // следующий крой этого цеха — по концу пошива текущего цикла
    freeDate[w.id] = dates.sew.end;

    // ткань
    const fabricMeters = Math.ceil(job.units * job.article.fabricPerUnit * (1 + (fabricCfg.wastagePct || 0) / 100));
    const fabricAtWorkshop = addDays(cutStart, -(fabricCfg.bufferDays || 0));
    const fabricOrderDate = addDays(fabricAtWorkshop, -(fabricCfg.leadTimeDays || 21));

    // логистика: ближайший вывоз карго после готовности + срок доставки
    const shipment = nextWeekday(readyDate, logi.cargoPickupWeekday ?? 1);
    const wbArrival = addDays(shipment, Math.round(((logi.minDays || 10) + (logi.maxDays || 15)) / 2));
    const pFact = partiaFactUnits(job.partia);
    const hasFact = pFact > 0;
    const wbUnits = hasFact ? pFact : job.units;

    // диагностика битой мощности: одна партия физически не шьётся дольше ~90 раб.
    // дней. Если дольше — почти всегда у цеха не задана (=1) мощность пошива.
    if (f.otk.end > 90) {
      warnings.push({
        level: 'error', stage: job.stageId, article: job.article.id, workshop: w.id,
        message: `Подозрительно низкая мощность: цех ${w.name} шьёт ${w.capacities.sew} шт/день — партия ${job.article.id} (${job.units} шт) шьётся ${f.otk.end} раб. дней (готовность ${readyDate}). Проверьте мощность пошива цеха в «Данные → Цеха».`,
      });
    }

    const deadline = job.deadline;
    const lateDays = deadline ? diffDays(deadline, wbArrival) : null;
    if (lateDays != null && lateDays > 0) {
      warnings.push({
        level: 'error', stage: job.stageId, article: job.article.id, workshop: w.id,
        message: `Срыв срока: артикул ${job.article.id} (${job.units} шт, ${w.name}) приходит на WB ${wbArrival}, дедлайн ${deadline} (опоздание ${lateDays} дн).`,
      });
    } else if (deadline != null && riskBuf > 0) {
      // буфер под форс-мажор: ранний сигнал «впритык» (см. Вариант А)
      const cushionEnd = cal.addWorkingDays(wbArrival, riskBuf);
      if (diffDays(deadline, cushionEnd) > 0) {
        warnings.push({
          level: 'warn', stage: job.stageId, article: job.article.id, workshop: w.id,
          message: `Впритык к дедлайну: артикул ${job.article.id} (${job.units} шт, ${w.name}) приходит на WB ${wbArrival}, дедлайн ${deadline} (запас ${-lateDays} дн < буфер ${riskBuf} раб. дн). Любой сбой — риск срыва.`,
        });
      }
    }

    // Контроль сроков (Фаза 3, «тихий контроль»). Главный сигнал — СТАТУС партии +
    // авто-дата смены статуса (готовность) + ручная «ожидаемая дата» при задержке.
    // Тишина = всё по плану; в «Требует внимания» попадают только исключения.
    // Пооперационные даты (progress) — опциональный разбор, тут не обязательны.
    let delayInfo = null;
    {
      const st = job.partia.status;
      const sd = job.partia.statusDates || {};
      const expReady = job.partia.expectedReady || '';
      const plannedReady = readyDate;
      const finished = st === 'done' || st === 'shipped';
      const started = st !== 'plan' || expReady || Object.keys(sd).length > 0;
      if (!job.partia.historical && started) {
        if (finished) {
          const actualReady = sd[st] || sd.done || sd.shipped || '';
          const days = actualReady ? diffDays(plannedReady, actualReady) : 0;
          delayInfo = { days, state: 'done', attention: false, projWb: null, willMiss: false, expectedReady: '', overdueDays: 0 };
        } else {
          const expected = expReady || plannedReady;
          const overdueDays = Math.max(0, diffDays(plannedReady, todayISO)); // на сколько сегодня позже плановой готовности
          // прогнозная готовность — не раньше сегодня, если уже просрочено
          const projReady = diffDays(expected, todayISO) > 0 ? todayISO : expected;
          const days = Math.max(0, diffDays(plannedReady, projReady));
          const projWb = addDays(wbArrival, days);
          const willMiss = !!(deadline && diffDays(deadline, projWb) > 0);
          // состояние: с ручной датой — 'delayed' (или 'overdue', если и её прошли);
          // без даты — 'overdue' после льготного порога; иначе 'ok'.
          // «идёт по плану»: пока snoozeUntil не прошёл — не тревожим по просрочке
          const snoozed = !expReady && job.partia.snoozeUntil && diffDays(todayISO, job.partia.snoozeUntil) >= 0;
          let state = 'ok';
          if (expReady) state = diffDays(expReady, todayISO) > 0 ? 'overdue' : 'delayed';
          else if (overdueDays > delayThreshold && !snoozed) state = 'overdue';
          const attention = state === 'overdue' || (willMiss && days > 0);
          delayInfo = { days, state, attention, projWb, willMiss, expectedReady: expReady, overdueDays };
          if (attention) {
            const stRu = PARTIA_STATUS_RU[st] || st;
            let message;
            if (state === 'overdue') {
              message = `Требует внимания: цех ${w.name}, партия ${job.article.id} — по плану готова ${plannedReady}, статус ещё «${stRu}» (${overdueDays} дн без подтверждения). Подтверди готовность или укажи новую дату.`;
            } else if (expReady) {
              message = `Задержка: цех ${w.name}, партия ${job.article.id} — ожидаемая готовность ${expReady}, приход на WB ~${projWb}${willMiss ? `, риск срыва дедлайна ${deadline}` : ''}.`;
            } else {
              message = `Риск срыва: цех ${w.name}, партия ${job.article.id} (${stRu}) — прогноз прихода на WB ~${projWb} позже дедлайна ${deadline}.`;
            }
            warnings.push({ level: willMiss ? 'error' : 'warn', kind: 'delay', stage: job.stageId, article: job.article.id, workshop: w.id, message });
          }
        }
      }
    }

    cycles.push({
      id: cid,
      partiaId: job.partia.id,
      partiaNo: job.partia.no,
      status: job.partia.status,
      statusRu: PARTIA_STATUS_RU[job.partia.status] || job.partia.status,
      historical: !!job.partia.historical,
      stageId: job.partia.stageId,
      stageName: job.stage ? job.stage.name : '',
      deliveryTag: job.partia.deliveryTag || '', // метка поставки (П1/П2/П3/подсорт) — если из прогноза
      articleId: job.article.id,
      articleName: job.article.name,
      workshopId: w.id,
      workshopName: w.name,
      workshopRole: w.role,
      own: w.id === ownId,
      units: job.units,
      wbUnits, hasFact,
      primary: true,
      split: false,
      overflow: false,
      manual: !!(ovr && ovr.cutStart),
      locked: !!job.lockedWs,
      ops: dates,
      cutStart, sewStart, readyDate,
      progress: { ...(job.partia.progress || {}) },
      delay: delayInfo,
      fabric: { meters: fabricMeters, orderDate: fabricOrderDate, atWorkshop: fabricAtWorkshop },
      logistics: { shipment, wbArrival, deadline, lateDays },
      milestones: buildMilestones({ fabricOrderDate, fabricAtWorkshop, cutStart, sewStart, readyDate, shipment, wbArrival }),
    });

    startedUnits[job.article.id] = (startedUnits[job.article.id] || 0) + job.units;
    job.done = true;
    remaining--;
  }

  cycles.sort((a, b) => (a.cutStart < b.cutStart ? -1 : a.cutStart > b.cutStart ? 1 : 0));

  // Валидация настила (Фаза 2): мягкие предупреждения по партиям (ориентиры кроя).
  const nestingRules = state.settings.nesting || { minSizeQty: 20, minColorQty: 400 };
  for (const p of state.partias || []) {
    if (p.historical || partiaPlanUnits(p) <= 0) continue;
    const viol = validateMatrix(p.planMatrix, nestingRules);
    for (const v of viol) {
      warnings.push({
        level: 'warn', kind: 'nesting', article: p.articleId, stage: p.stageId,
        message: v.kind === 'color'
          ? `Настил: артикул ${p.articleId}, цвет «${v.color}» — ${v.qty} шт (ориентир ≥ ${v.min}). Мелкий цвет лучше объединить.`
          : `Настил: артикул ${p.articleId}, цвет «${v.color}», размер ${v.size} — ${v.qty} шт (ориентир ≥ ${v.min}).`,
      });
    }
  }

  const fabricOrders = aggregateFabric(cycles, state, netting.net);

  // netByPartia — матрица «к производству» (план − остатки) по каждой план-партии.
  // Нужна фронту, чтобы выгрузка «План по размерам → Excel для цеха» шла на нетто, а не на спрос.
  return { cycles, warnings, fabricOrders, generatedFor: state.stages.map((s) => s.id), supply: { arrivals: netting.arrivals, unmatched: netting.unmatched, netByPartia: netting.net } };
}

function cycleId(partiaId, wsId, idx) {
  return `${partiaId}::${wsId}::${idx}`;
}

function buildMilestones(m) {
  return [
    { key: 'fabricOrder', label: 'Заказ ткани', date: m.fabricOrderDate },
    { key: 'fabricReady', label: 'Ткань на складе цеха', date: m.fabricAtWorkshop },
    { key: 'cutStart', label: 'Старт кроя', date: m.cutStart },
    { key: 'sewStart', label: 'Старт пошива', date: m.sewStart },
    { key: 'ready', label: 'Готовность партии', date: m.readyDate },
    { key: 'shipment', label: 'Отгрузка (карго)', date: m.shipment },
    { key: 'wbArrival', label: 'Приход на склад WB', date: m.wbArrival },
  ];
}

// Консолидированный план заказа ткани.
//
// Логика (см. пункт #34):
//  1. Снимаем потребность в ткани в разрезе (партия × цвет): метраж = штук цвета ×
//     расход/шт × (1 + раскрой%). Ключ ткани = «№ планшета + № цвета» (у одного
//     поставщика). Даты берём с циклов партии: «заказать не позже» и «нужно на
//     складе» = самые ранние среди циклов (ткань успевает ко всем цехам партии).
//  2. Группируем метраж по ключу ткани — консолидация ЧЕРЕЗ разные артикулы/партии.
//  3. Режимом поставщика режем на окна закупки: 'season' — одно окно на весь сезон;
//     'draw' — окно = drawStages этапов подряд.
//  4. Дата заказа окна = самая ранняя «заказать не позже» в окне.
//  5. Объём заказа = метраж окна × (1 + страховой%). ИСКЛЮЧЕНИЕ — последний заказ по
//     ткани: берём ровно недостающий остаток (весь план − уже заказано), чтобы
//     накопленные страховые излишки не осели мёртвым остатком (true-up).
//  6. Заказы группируем по поставщику (для оформления одной заявкой).
//
// Прошлые (historical) партии в закупку не берём — ткань под них уже куплена.

function sumRow(row) {
  if (!row || typeof row !== 'object') return 0;
  let s = 0;
  for (const k of Object.keys(row)) s += +row[k] || 0;
  return Math.round(s);
}

function resolveSupplier(article, supById) {
  const sup = article && article.supplierId && supById[article.supplierId];
  if (sup) return { id: sup.id, name: sup.name, orderMode: sup.orderMode, drawStages: Math.max(1, sup.drawStages || 1) };
  return { id: '__none__', name: 'Поставщик не указан', orderMode: 'draw', drawStages: 1 };
}

function aggregateFabric(cycles, state, netByPartia = {}) {
  const safetyMul = 1 + (state.settings.fabric.safetyPct || 0) / 100;
  const artById = Object.fromEntries(state.articles.map((a) => [a.id, a]));
  const supById = Object.fromEntries((state.suppliers || []).map((s) => [s.id, s]));
  const stageIdx = {}; state.stages.forEach((st, i) => { stageIdx[st.id] = i; });

  // 1a) самые ранние даты заказа/прихода по каждой партии (из её циклов, без прошлых)
  const partiaDates = {};
  for (const c of cycles) {
    if (c.historical) continue;
    const d = partiaDates[c.partiaId];
    if (!d) {
      partiaDates[c.partiaId] = { orderBy: c.fabric.orderDate, needBy: c.fabric.atWorkshop };
    } else {
      if (c.fabric.orderDate < d.orderBy) d.orderBy = c.fabric.orderDate;
      if (c.fabric.atWorkshop < d.needBy) d.needBy = c.fabric.atWorkshop;
    }
  }

  // 1b) потребности в разрезе (партия × цвет)
  const demands = [];
  for (const p of state.partias || []) {
    if (p.historical) continue;
    const dts = partiaDates[p.id];
    if (!dts) continue; // партия без циклов (0 шт)
    const a = artById[p.articleId];
    if (!a) continue;
    const sup = resolveSupplier(a, supById);
    const wastageMul = 1 + (state.settings.fabric.wastagePct || 0) / 100;
    const M = netByPartia[p.id] || p.planMatrix || {}; // ткань — на нетто-объём (не покупаем на уже готовое)
    for (const color of Object.keys(M)) {
      const units = sumRow(M[color]);
      if (units <= 0) continue;
      const meters = units * (a.fabricPerUnit || 0) * wastageMul; // с раскроем, дробное — округлим в конце
      const fi = (a.fabricInfo && a.fabricInfo[color]) || {};
      const plansheet = (fi.plansheet || '').trim();
      const colorNo = (fi.colorNo || '').trim();
      const hasSku = plansheet || colorNo;
      const fabricKey = hasSku
        ? `${sup.id}|ps:${plansheet || '—'}|cn:${colorNo || '—'}`
        : `${sup.id}|art:${a.id}|col:${color}`;
      const label = hasSku ? `планшет ${plansheet || '—'} / цвет ${colorNo || '—'}` : `${a.id} · ${color}`;
      demands.push({
        fabricKey, label, supplier: sup,
        articleId: a.id, color, stageId: p.stageId, stageIdx: stageIdx[p.stageId] ?? 99,
        meters, price: +a.fabricPricePerMeter || 0,
        image: fi.image || '', orderBy: dts.orderBy, needBy: dts.needBy,
      });
    }
  }

  // 2) группировка по ключу ткани
  const byFabric = {};
  for (const d of demands) (byFabric[d.fabricKey] ||= []).push(d);

  const fabrics = [];
  for (const [key, list] of Object.entries(byFabric)) {
    const sup = list[0].supplier;
    const totalNeed = list.reduce((s, d) => s + d.meters, 0); // план (с раскроем, без страхового)
    const avgPrice = totalNeed > 0 ? list.reduce((s, d) => s + d.meters * d.price, 0) / totalNeed : 0;
    const articleIds = [...new Set(list.map((d) => d.articleId))];
    const image = (list.find((d) => d.image) || {}).image || '';

    // 3) окна закупки по режиму поставщика
    const bucketOf = (d) => (sup.orderMode === 'season' ? 0 : Math.floor(d.stageIdx / Math.max(1, sup.drawStages)));
    const buckets = {};
    for (const d of list) (buckets[bucketOf(d)] ||= []).push(d);
    const bucketKeys = Object.keys(buckets).map(Number).sort((x, y) => x - y);

    const orders = [];
    let orderedSoFar = 0;
    bucketKeys.forEach((bk, i) => {
      const items = buckets[bk];
      const windowMeters = items.reduce((s, d) => s + d.meters, 0);
      const orderDate = items.reduce((m, d) => (d.orderBy < m ? d.orderBy : m), items[0].orderBy);
      const needBy = items.reduce((m, d) => (d.needBy < m ? d.needBy : m), items[0].needBy);
      const stages = [...new Set(items.map((d) => d.stageId))];
      const isLast = i === bucketKeys.length - 1;
      // 5) объём: промежуточный = окно + страховой; последний = остаток плана (true-up)
      const qty = isLast ? Math.max(0, totalNeed - orderedSoFar) : windowMeters * safetyMul;
      orderedSoFar += qty;
      orders.push({
        seq: i + 1, orderDate, needBy,
        meters: Math.ceil(qty), planMeters: Math.ceil(windowMeters),
        cost: Math.round(qty * avgPrice), coversStages: stages, isLast,
      });
    });

    fabrics.push({
      fabricKey: key, label: list[0].label, image,
      supplierId: sup.id, supplierName: sup.name, orderMode: sup.orderMode, drawStages: sup.drawStages,
      articleIds, totalNeed: Math.ceil(totalNeed),
      totalOrdered: orders.reduce((s, o) => s + o.meters, 0),
      totalCost: orders.reduce((s, o) => s + o.cost, 0),
      orders,
    });
  }

  // 6) группировка по поставщику
  const bySup = {};
  for (const f of fabrics) {
    const g = (bySup[f.supplierId] ||= {
      supplierId: f.supplierId, supplierName: f.supplierName,
      orderMode: f.orderMode, drawStages: f.drawStages, fabrics: [],
    });
    g.fabrics.push(f);
  }
  const suppliers = Object.values(bySup).map((g) => {
    const allOrders = g.fabrics.flatMap((f) => f.orders);
    g.earliestOrderDate = allOrders.reduce((m, o) => (!m || o.orderDate < m ? o.orderDate : m), null);
    g.totalMeters = g.fabrics.reduce((s, f) => s + f.totalOrdered, 0);
    g.totalCost = g.fabrics.reduce((s, f) => s + f.totalCost, 0);
    g.fabrics.sort((a, b) => String(a.label).localeCompare(String(b.label), 'ru'));
    return g;
  }).sort((a, b) => (String(a.earliestOrderDate || '') < String(b.earliestOrderDate || '') ? -1 : 1));

  const totals = {
    meters: suppliers.reduce((s, g) => s + g.totalMeters, 0),
    cost: suppliers.reduce((s, g) => s + g.totalCost, 0),
  };
  return { suppliers, totals };
}

export { OPS, OP_RU };
