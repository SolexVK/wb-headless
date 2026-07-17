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
import { stageUnits } from './model.js';

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

// Рассчитать поток одного цикла в рабочих днях, где cutStartWD — смещение
// начала кроя (в раб.днях) от «нуля» цеха. Возвращает WD-смещения операций.
function computeFlowWD(units, caps, flow, cutStartWD) {
  const offCut = Math.max(1, Math.ceil((flow.sewAfterCut || 250) / caps.cut));
  const offSew = Math.max(1, Math.ceil((flow.ironAfterSew || 300) / caps.sew));
  const offIron = Math.max(1, Math.ceil((flow.otkAfterIron || 1000) / caps.iron));

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

// Основная функция. Возвращает { cycles, workshops, stages, warnings, fabricOrders }.
export function buildSchedule(state) {
  const cal = makeCalendar(state.settings.calendar);
  const flow = state.settings.flow;
  const fabricCfg = state.settings.fabric;
  const logi = state.settings.logistics;
  const riskBuf = state.settings.riskBufferDays || 0;

  const wsById = Object.fromEntries(state.workshops.map((w) => [w.id, w]));
  const warnings = [];
  const cycles = [];

  // курсор занятости цеха в рамках текущего этапа: WD-смещение, с которого
  // может стартовать крой следующего цикла (= конец пошива предыдущего)
  // сбрасывается на каждом этапе (месяц отшива фиксирован календарно).

  for (const stage of state.stages) {
    const ym = stage.productionMonth;
    const [y, mIdx] = ym.split('-').map(Number);
    const monthFirstWork = cal.nextWorkingDay(monthStartISO(ym));
    const wdInMonth = cal.workingDaysInMonth(y, mIdx - 1);

    // 1) собрать работы этапа
    const jobs = [];
    for (const a of state.articles) {
      const units = stageUnits(a, stage.id);
      if (units > 0) jobs.push({ article: a, units });
    }
    // крупные — первыми (лучше распределяются)
    jobs.sort((x, y2) => y2.units - x.units);

    // 2) распределение по цехам.
    // Цель: держать все цеха загруженными И выдерживать месяц. Балансируем по
    // проектному времени завершения пошива: цех, который освободится раньше,
    // берёт следующую работу. loadWD — уже назначенные цеху раб.дни пошива.
    const loadWD = {};
    for (const w of state.workshops) loadWD[w.id] = 0;

    const sewDaysNeeded = (units, w) => opDurationWD(units, w.capacities.sew);
    // резерв рабочих дней под «хвост» потока (разгон кроя + утюжка/ОТК после
    // конца пошива), чтобы готовность партии не вылезала за календарный месяц
    const tailReserve = Math.ceil((flow.ironAfterSew || 300) / 250)
      + Math.ceil((flow.otkAfterIron || 1000) / 500) + 2;
    const capacityWD = Math.max(1, wdInMonth - tailReserve); // полезных раб. дней пошива в месяце

    // список под-партий: { article, units, workshopId, primary }
    const subBatches = [];
    const roleRank = (w) => (w.role === 'main' ? 0 : 1);
    const freeUnits = (w) => Math.max(0, (capacityWD - loadWD[w.id]) * w.capacities.sew);
    const fitsWhole = (w, units) => loadWD[w.id] + sewDaysNeeded(units, w) <= capacityWD;
    const pushBatch = (article, units, w, primary, overflow) => {
      subBatches.push({ article, units: Math.round(units), workshopId: w.id, primary, overflow });
      loadWD[w.id] += sewDaysNeeded(units, w);
    };

    for (const job of jobs) {
      const preferredId = (state.assignments || {})[`${stage.id}:${job.article.id}`] || null;
      const preferred = preferredId ? wsById[preferredId] : null;

      // 2a) цельная партия в один цех.
      // Приоритет: если задан цех вручную и он тянет партию — ставим туда.
      if (preferred && fitsWhole(preferred, job.units)) {
        pushBatch(job.article, job.units, preferred, true); continue;
      }
      if (!preferred) {
        // авто: цех, который освободится раньше (догружаем простаивающие)
        const whole = state.workshops.filter((w) => fitsWhole(w, job.units))
          .sort((a, b) => (loadWD[a.id] + sewDaysNeeded(job.units, a)) - (loadWD[b.id] + sewDaysNeeded(job.units, b))
            || roleRank(a) - roleRank(b))[0];
        if (whole) { pushBatch(job.article, job.units, whole, true); continue; }
      }

      // 2b) не влезает целиком — делим между МИНИМАЛЬНЫМ числом цехов
      // (обычно 2: основной + вспомогательный; 3-й только если двух не хватает),
      // пропорционально свободной мощности — без мелких хвостов.
      let pool = state.workshops.filter((w) => !preferred || w.id !== preferred.id)
        .sort((a, b) => roleRank(a) - roleRank(b) || freeUnits(b) - freeUnits(a));
      if (preferred) pool = [preferred, ...pool];

      const chosen = [];
      let cum = 0;
      for (const w of pool) {
        if (freeUnits(w) <= 0) continue;
        chosen.push(w); cum += freeUnits(w);
        if (cum >= job.units) break;
      }
      const totalFree = chosen.reduce((s, w) => s + freeUnits(w), 0) || 1;
      const overflow = totalFree < job.units;

      // распределяем пропорционально свободной мощности выбранных цехов
      const pieces = chosen.map((w) => ({ w, units: Math.round(job.units * freeUnits(w) / totalFree) }));
      const assigned = pieces.reduce((s, p) => s + p.units, 0);
      if (pieces.length) {
        const big = pieces.reduce((m, p) => (p.units > m.units ? p : m), pieces[0]);
        big.units += Math.round(job.units) - assigned; // остаток округления — в самый крупный кусок
      }
      const primaryPiece = preferred
        ? (pieces.find((p) => p.w.id === preferred.id) || pieces.reduce((m, p) => (p.units > m.units ? p : m), pieces[0]))
        : pieces.reduce((m, p) => (p.units > m.units ? p : m), pieces[0]);
      for (const p of pieces) {
        if (p.units <= 0) continue;
        pushBatch(job.article, p.units, p.w, p === primaryPiece, overflow);
      }
      if (overflow) {
        warnings.push({
          level: 'error', stage: stage.id, article: job.article.id,
          message: `Этап «${stage.name}»: суммарной мощности цехов не хватает на артикул ${job.article.id} (${job.units} шт) — план не помещается в месяц.`,
        });
      }
    }

    // сколько цехов получил каждый артикул на этом этапе (для метки «дроблёно»)
    const wsCountByArticle = {};
    for (const sb of subBatches) {
      (wsCountByArticle[sb.article.id] ||= new Set()).add(sb.workshopId);
    }

    // 3) даты по каждому цеху (без простоя): сортируем под-партии цеха и гоним поток
    const byWs = {};
    for (const sb of subBatches) (byWs[sb.workshopId] ||= []).push(sb);

    for (const [wsId, batches] of Object.entries(byWs)) {
      const w = wsById[wsId];
      // порядок внутри цеха: крупные раньше (стабильно и плотно)
      batches.sort((a, b) => b.units - a.units);
      let cursorWD = 0; // конец пошива предыдущего цикла

      for (let i = 0; i < batches.length; i++) {
        const sb = batches[i];
        const ovr = (state.overrides || {})[cycleId(stage.id, sb.article.id, wsId, i)];

        let cutStartWD = Math.max(cursorWD, 0);
        let anchorFirstWork = monthFirstWork;
        // ручной сдвиг блока на Ганте (перетаскивание): фиксируем дату старта кроя
        if (ovr && ovr.cutStart) {
          anchorFirstWork = cal.nextWorkingDay(ovr.cutStart);
          cutStartWD = 0; // якорь — сама дата
        }

        const f = computeFlowWD(sb.units, w.capacities, flow, cutStartWD);

        const toDate = (wd) => cal.addWorkingDays(anchorFirstWork, wd);
        const dates = {};
        for (const op of OPS) {
          dates[op] = { start: toDate(f[op].start), end: toDate(f[op].end) };
        }
        const cutStart = dates.cut.start;
        const sewStart = dates.sew.start;
        const readyDate = dates.otk.end;

        // сдвигаем курсор цеха: следующий крой — по концу пошива этого цикла
        // плюс настраиваемое per-цех смещение цикла (раб. дней; <0 = больше перекрытие)
        const cycleOffset = Number(w.cycleOffsetDays) || 0;
        cursorWD = Math.max(0, f.sew.end + cycleOffset);

        // ткань
        const fabricMeters = Math.ceil(sb.units * sb.article.fabricPerUnit * (1 + (fabricCfg.wastagePct || 0) / 100));
        const fabricAtWorkshop = cal.addWorkingDays(cutStart, -(fabricCfg.bufferDays || 0)) < cutStart
          ? addDays(cutStart, -(fabricCfg.bufferDays || 0))
          : cutStart;
        const fabricOrderDate = addDays(fabricAtWorkshop, -(fabricCfg.leadTimeDays || 21));

        // логистика: ближайший вывоз карго после готовности + срок доставки
        const shipment = nextWeekday(readyDate, logi.cargoPickupWeekday ?? 1);
        const wbArrival = addDays(shipment, Math.round(((logi.minDays || 10) + (logi.maxDays || 15)) / 2));

        // проверки
        const monthEnd = monthEndISO(ym);
        if (diffDays(readyDate, monthEnd) < 0) {
          warnings.push({
            level: 'warn', stage: stage.id, article: sb.article.id, workshop: wsId,
            message: `Цех ${w.name}: цикл ${sb.article.id} (${sb.units} шт) выходит за календарный месяц отшива (готовность ${readyDate}, конец месяца ${monthEnd}).`,
          });
        }
        const deadline = stage.deadline;
        const lateDays = deadline ? diffDays(deadline, wbArrival) : null;
        if (lateDays != null && lateDays > 0) {
          warnings.push({
            level: 'error', stage: stage.id, article: sb.article.id, workshop: wsId,
            message: `Срыв срока: артикул ${sb.article.id} приходит на WB ${wbArrival}, дедлайн ${deadline} (опоздание ${lateDays} дн).`,
          });
        }

        cycles.push({
          id: cycleId(stage.id, sb.article.id, wsId, i),
          stageId: stage.id,
          stageName: stage.name,
          articleId: sb.article.id,
          articleName: sb.article.name,
          workshopId: wsId,
          workshopName: w.name,
          workshopRole: w.role,
          units: sb.units,
          primary: sb.primary,
          split: (wsCountByArticle[sb.article.id]?.size || 1) > 1,
          overflow: !!sb.overflow,
          manual: !!(ovr && ovr.cutStart),
          ops: dates,
          cutStart, sewStart, readyDate,
          fabric: { meters: fabricMeters, orderDate: fabricOrderDate, atWorkshop: fabricAtWorkshop },
          logistics: { shipment, wbArrival, deadline: stage.deadline, lateDays },
          milestones: buildMilestones({ fabricOrderDate, fabricAtWorkshop, cutStart, sewStart, readyDate, shipment, wbArrival }),
        });
      }
    }
  }

  cycles.sort((a, b) => (a.cutStart < b.cutStart ? -1 : a.cutStart > b.cutStart ? 1 : 0));

  const fabricOrders = aggregateFabric(cycles, state);

  return { cycles, warnings, fabricOrders, generatedFor: state.stages.map((s) => s.id) };
}

function cycleId(stageId, articleId, wsId, idx) {
  return `${stageId}::${articleId}::${wsId}::${idx}`;
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

// Заказы ткани с учётом запаса на N этапов и всех параллельно работающих цехов.
// Группируем по (артикул) и суммируем метраж, показываем дату заказа = самый
// ранний заказ среди циклов группы, объём = сумма метража ближайших safetyStages этапов.
function aggregateFabric(cycles, state) {
  const orders = [];
  const byArticle = {};
  for (const c of cycles) {
    (byArticle[c.articleId] ||= []).push(c);
  }
  for (const [articleId, list] of Object.entries(byArticle)) {
    list.sort((a, b) => (a.fabric.orderDate < b.fabric.orderDate ? -1 : 1));
    // разбиваем по этапам, чтобы формировать заказ «на 2 этапа вперёд»
    orders.push({
      articleId,
      totalMeters: list.reduce((s, c) => s + c.fabric.meters, 0),
      firstOrderDate: list[0]?.fabric.orderDate,
      byStage: list.map((c) => ({
        stageId: c.stageId, workshopId: c.workshopId, units: c.units,
        meters: c.fabric.meters, orderDate: c.fabric.orderDate, atWorkshop: c.fabric.atWorkshop,
      })),
    });
  }
  return orders;
}

export { OPS, OP_RU };
