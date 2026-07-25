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
import { partiasOf, partiaPlanUnits, partiaFactUnits, partiaEffectiveUnits, PARTIA_STATUS_RU } from './model.js';

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

    // 1) собрать работы этапа — по ПАРТИЯМ (каждая партия = задание)
    const articleById = Object.fromEntries(state.articles.map((a) => [a.id, a]));
    const jobs = [];
    for (const p of state.partias) {
      if (p.stageId !== stage.id) continue;
      const article = articleById[p.articleId];
      if (!article) continue;
      const units = partiaPlanUnits(p);
      if (units > 0) jobs.push({ partia: p, article, units });
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
    const pushBatch = (job, units, w, primary, overflow) => {
      subBatches.push({ article: job.article, partia: job.partia, units: Math.round(units), workshopId: w.id, primary, overflow });
      loadWD[w.id] += sewDaysNeeded(units, w);
    };

    for (const job of jobs) {
      const preferredId = (job.partia && job.partia.workshopId) || null;
      const preferred = preferredId ? wsById[preferredId] : null;

      // 2a) цельная партия в один цех.
      // Приоритет: если у партии задан цех и он тянет объём — ставим туда.
      if (preferred && fitsWhole(preferred, job.units)) {
        pushBatch(job, job.units, preferred, true); continue;
      }
      if (!preferred) {
        // авто: цех, который освободится раньше (догружаем простаивающие)
        const whole = state.workshops.filter((w) => fitsWhole(w, job.units))
          .sort((a, b) => (loadWD[a.id] + sewDaysNeeded(job.units, a)) - (loadWD[b.id] + sewDaysNeeded(job.units, b))
            || roleRank(a) - roleRank(b))[0];
        if (whole) { pushBatch(job, job.units, whole, true); continue; }
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
        pushBatch(job, p.units, p.w, p === primaryPiece, overflow);
      }
      if (overflow) {
        warnings.push({
          level: 'error', stage: stage.id, article: job.article.id,
          message: `Этап «${stage.name}»: суммарной мощности цехов не хватает на артикул ${job.article.id} (${job.units} шт) — план не помещается в месяц.`,
        });
      }
    }

    // на сколько цехов дроблена каждая партия (для метки «дроблёно»)
    const wsCountByPartia = {};
    for (const sb of subBatches) {
      (wsCountByPartia[sb.partia.id] ||= new Set()).add(sb.workshopId);
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
        const cid = cycleId(sb.partia.id, wsId, i);
        const ovr = (state.overrides || {})[cid];

        let cutStartWD = Math.max(cursorWD, 0);
        let anchorFirstWork = monthFirstWork;
        // ручной сдвиг блока на Ганте (перетаскивание): фиксируем дату старта кроя
        if (ovr && ovr.cutStart) {
          anchorFirstWork = cal.nextWorkingDay(ovr.cutStart);
          cutStartWD = 0; // якорь — сама дата
        }

        const wsOffsets = resolveFlowOffsets(w, flow);
        const f = computeFlowWD(sb.units, w.capacities, wsOffsets, cutStartWD);

        const toDate = (wd) => cal.addWorkingDays(anchorFirstWork, wd);
        const dates = {};
        for (const op of OPS) {
          dates[op] = { start: toDate(f[op].start), end: toDate(f[op].end) };
        }
        const cutStart = dates.cut.start;
        const sewStart = dates.sew.start;
        const readyDate = dates.otk.end;

        // сдвигаем курсор цеха: следующий крой — по концу пошива этого цикла
        cursorWD = f.sew.end;

        // ткань
        const fabricMeters = Math.ceil(sb.units * sb.article.fabricPerUnit * (1 + (fabricCfg.wastagePct || 0) / 100));
        const fabricAtWorkshop = addDays(cutStart, -(fabricCfg.bufferDays || 0));
        const fabricOrderDate = addDays(fabricAtWorkshop, -(fabricCfg.leadTimeDays || 21));

        // логистика: ближайший вывоз карго после готовности + срок доставки
        const shipment = nextWeekday(readyDate, logi.cargoPickupWeekday ?? 1);
        const wbArrival = addDays(shipment, Math.round(((logi.minDays || 10) + (logi.maxDays || 15)) / 2));
        // количество, уезжающее на WB: факт (если введён по партии), иначе план
        const pPlan = partiaPlanUnits(sb.partia);
        const pFact = partiaFactUnits(sb.partia);
        const hasFact = pFact > 0;
        const wbUnits = hasFact && pPlan > 0 ? Math.round(pFact * sb.units / pPlan) : sb.units;

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
        } else if (deadline != null && riskBuf > 0) {
          // Буфер под форс-мажор (Вариант А): подушка перед дедлайном. Если партия
          // формально успевает, но приходит менее чем за riskBuf раб. дней до
          // дедлайна — ранний сигнал «впритык» (любой сбой = срыв). Даты не сдвигаем.
          const cushionEnd = cal.addWorkingDays(wbArrival, riskBuf);
          if (diffDays(deadline, cushionEnd) > 0) {
            warnings.push({
              level: 'warn', stage: stage.id, article: sb.article.id, workshop: wsId,
              message: `Впритык к дедлайну: артикул ${sb.article.id} приходит на WB ${wbArrival}, дедлайн ${deadline} (запас ${-lateDays} дн < буфер ${riskBuf} раб. дн). Любой сбой на производстве — риск срыва.`,
            });
          }
        }

        cycles.push({
          id: cid,
          partiaId: sb.partia.id,
          partiaNo: sb.partia.no,
          status: sb.partia.status,
          statusRu: PARTIA_STATUS_RU[sb.partia.status] || sb.partia.status,
          historical: !!sb.partia.historical,
          stageId: stage.id,
          stageName: stage.name,
          articleId: sb.article.id,
          articleName: sb.article.name,
          workshopId: wsId,
          workshopName: w.name,
          workshopRole: w.role,
          units: sb.units,
          wbUnits, hasFact,
          primary: sb.primary,
          split: (wsCountByPartia[sb.partia.id]?.size || 1) > 1,
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

function aggregateFabric(cycles, state) {
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
    const M = p.planMatrix || {};
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
