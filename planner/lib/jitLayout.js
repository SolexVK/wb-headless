// jitLayout.js — «Экономная раскладка (JIT)».
// Пересобирает даты старта пошива под оборачиваемость денег: шить не «пораньше», а ТОЧНО ВОВРЕМЯ —
// чтобы товар был готов к дедлайну ВБ с буфером на доставку/форс-мажор, а не лежал готовым месяцами.
//
// Приоритеты (сверху — важнее, снизу — «по возможности»):
//   1. НЕ опаздывать (дедлайн ВБ соблюдён).
//   2. JIT: финиш к «готов на складе» = дедлайн − буфер доставки; минимум заморозки денег.
//   3. Летние модели: весь объём дошит к 15.04 (года продаж), первые партии — раньше (под старт продаж).
//   4. Не-летние: подушка ≥ N дней; производство ВНЕ летнего спринта (сток до / доотшив после).
//   5. Минимум задействованных цехов (кроме своего).
//   6. Минимум перестроек (один артикул — один цех).
//
// Движок НЕ переписывает планировщик: он берёт БАЗОВОЕ расписание (buildSchedule) — оттуда длительности
// пошива и транзит каждого батча — и лишь ПЕРЕ-ТАЙМИТ старты (обратным ходом от дедлайнов), после чего
// раскладывает результат пинами (state.batchPins). Всё обратимо («Сбросить раскладку»).

import { buildSchedule } from './scheduler.js';
import { makeCalendar, addDays, diffDays } from './calendar.js';

export const SUMMER_ARTICLE_IDS = ['005', '006', '007', '014', '022', '032', '033', '034'];

// ── метрики раскладки (для превью «до/после») ──
export function layoutMetrics(schedule) {
  const cy = (schedule.cycles || []).filter((c) => !c.historical);
  const wsUsed = new Set(cy.map((c) => c.workshopId));
  // перестройки: в каждом цехе по порядку кроя считаем смены артикула
  const byWs = {};
  for (const c of cy) (byWs[c.workshopId] = byWs[c.workshopId] || []).push(c);
  let changeovers = 0;
  for (const w in byWs) {
    const arr = byWs[w].sort((a, b) => (a.cutStart < b.cutStart ? -1 : a.cutStart > b.cutStart ? 1 : 0));
    for (let i = 1; i < arr.length; i++) if (arr[i].articleId !== arr[i - 1].articleId) changeovers++;
  }
  // опоздания (приход ВБ позже дедлайна)
  let late = 0, lateUnits = 0;
  // заморозка: Σ шт × дней «готово раньше дедлайна ВБ» (сколько товар лежит до момента, когда нужен)
  let freezeUnitDays = 0;
  for (const c of cy) {
    const dl = c.logistics && c.logistics.deadline;
    if (dl && c.logistics.wbArrival) {
      const slack = diffDays(c.logistics.wbArrival, dl); // >0 = с запасом; это и есть «залёживание»
      if (slack > 0) freezeUnitDays += c.units * slack;
      if (c.logistics.lateDays > 0) { late++; lateUnits += c.units; }
    }
  }
  return {
    workshops: wsUsed.size,
    changeovers,
    lateBatches: late,
    lateUnits,
    freezeUnitDays: Math.round(freezeUnitDays),
    freezeMlnUnitDays: Math.round(freezeUnitDays / 1e5) / 10, // млн шт·дней, 1 знак
  };
}

// ── основной расчёт: вернуть пины JIT-раскладки + метрики до/после ──
export function computeJitLayout(state, opts = {}) {
  const deliveryBufferDays = num(opts.deliveryBufferDays, 30);      // «готов на складе за N дней до дедлайна»
  const nonSummerCushionDays = num(opts.nonSummerCushionDays, 60);  // подушка ≥ N дней для не-летних
  const summerMMDD = /^\d{2}-\d{2}$/.test(opts.summerFinishMMDD || '') ? opts.summerFinishMMDD : '04-15';
  const minimizeWorkshops = opts.minimizeWorkshops !== false;
  const groupByArticle = opts.groupByArticle !== false;
  const summerIds = new Set((opts.summerIds && opts.summerIds.length ? opts.summerIds : SUMMER_ARTICLE_IDS).map((x) => String(x).trim()));

  const cal = makeCalendar(state.settings.calendar);

  // рабочих дней в [a,b] включительно
  const wdBetween = (a, b) => { let n = 0, cur = a, g = 0; while (diffDays(cur, b) >= 0 && g++ < 100000) { if (cal.isWorkingDay(cur)) n++; cur = addDays(cur, 1); } return n; };
  // вычесть n рабочих дней (найти дату, отстоящую на n раб. дней назад)
  const subWD = (iso, n) => { let cur = cal.nextWorkingDay(iso), left = Math.max(0, Math.ceil(n)), g = 0; while (left > 0 && g++ < 100000) { cur = addDays(cur, -1); while (!cal.isWorkingDay(cur)) cur = addDays(cur, -1); left--; } return cur; };

  const base = buildSchedule(state);
  const cycles = base.cycles.filter((c) => !c.historical);
  const before = layoutMetrics(base);

  // 1) обогащаем каждый батч JIT-целями (без учёта конфликтов в цехе — это шаг 3)
  const items = cycles.map((c) => {
    const isSummer = summerIds.has(String(c.articleId).trim());
    const dl = (c.logistics && c.logistics.deadline) || '';
    const sewSpanWD = Math.max(1, wdBetween(c.ops.cut.start, c.ops.sew.end) - 1); // занятость цеха: крой→конец пошива
    const readySpanWD = Math.max(1, wdBetween(c.ops.cut.start, c.ops.otk.end) - 1); // крой→готовность (ОТК)
    let targetReady; // желаемая дата готовности (ОТК)
    if (dl) {
      const buf = isSummer ? deliveryBufferDays : Math.max(deliveryBufferDays, nonSummerCushionDays);
      targetReady = addDays(dl, -buf);
      if (isSummer) { // потолок: дошить к 15.04 года продаж (даже если продаётся позже — шьём заранее в зиму)
        const cap = `${dl.slice(0, 4)}-${summerMMDD}`;
        if (diffDays(cap, targetReady) > 0) targetReady = cap; // targetReady позже потолка → подтянуть к потолку
      }
    } else {
      targetReady = c.ops.otk.end; // без дедлайна — оставляем как есть
    }
    // Пол — базовый крой этого батча: планировщик уже поставил его не раньше возможного (seasonStart,
    // earliestStart, sewNotBefore, мощность). JIT двигает старт ПОЗЖЕ (к дедлайну), поэтому пол = базовый
    // крой гарантирует, что мы никогда не стартуем раньше исполнимого и не рождаем опозданий из-за пола.
    const floorBatch = c.ops.cut.start;
    // JIT-крой = отнять «крой→готовность» от целевой готовности; не раньше базового кроя
    let jitCut = subWD(cal.nextWorkingDay(targetReady), readySpanWD);
    if (diffDays(floorBatch, jitCut) < 0) jitCut = floorBatch; // JIT хочет раньше базового — оставляем базовый
    return { batchKey: c.batchKey, ws: c.workshopId, articleId: c.articleId, units: c.units, isSummer, dl, sewSpanWD, jitCut, targetReady, floorBatch };
  });

  // 2) минимизация цехов (по возможности): пытаемся освободить самые лёгкие вспом. цеха, перенося их
  //    батчи целиком по артикулу в другой цех, если это НЕ рождает новых опозданий.
  let assignWs = Object.fromEntries(items.map((it) => [it.batchKey, it.ws]));
  if (minimizeWorkshops) assignWs = minimizeWorkshopCount(state, items, assignWs, { cal, subWD, groupByArticle, buildPins: (aw) => serializeAndPin(items, aw, { cal, subWD }) });

  // 3) сериализация по цехам (обратный ход, без наложений) → пины
  const pins = serializeAndPin(items, assignWs, { cal, subWD });

  // 4) метрики «после» — прогоняем настоящий планировщик с этими пинами
  const trial = withPins(state, pins);
  const afterSch = buildSchedule(trial);
  const after = layoutMetrics(afterSch);

  return { pins, before, after };
}

// разложить items по цехам (assignWs) с обратной сериализацией внутри каждого цеха → { batchKey: {ws,cut} }
function serializeAndPin(items, assignWs, ctx) {
  const { cal, subWD } = ctx;
  const byWs = {};
  for (const it of items) { const ws = assignWs[it.batchKey] || it.ws; (byWs[ws] = byWs[ws] || []).push(it); }
  const pins = {};
  for (const ws in byWs) {
    // сортируем по JIT-крою убыванием (позднейшие — первыми получают свой слот)
    const arr = byWs[ws].slice().sort((a, b) => (a.jitCut < b.jitCut ? 1 : a.jitCut > b.jitCut ? -1 : 0));
    let ceil = null; // конец пошива текущего (позднего) батча — раньше него должен закончиться предыдущий
    for (const it of arr) {
      let cut = it.jitCut;
      if (ceil) {
        // конец пошива при старте cut = +sewSpan раб.дней; он не должен налезать на ceil
        const sewEnd = cal.addWorkingDays(cut, it.sewSpanWD);
        if (diffDays(sewEnd, ceil) < 0) cut = subWD(ceil, it.sewSpanWD); // не влезает под ceil → сдвигаем раньше
      }
      if (diffDays(it.floorBatch, cut) < 0) cut = it.floorBatch; // не раньше базового кроя этого батча
      pins[it.batchKey] = { ws, cut };
      ceil = cut; // следующий (более ранний) батч должен закончить пошив к этому крою
    }
  }
  return pins;
}

// вернуть копию state с наложенными пинами (для прогонки планировщика)
function withPins(state, pins) {
  const bp = { ...(state.batchPins || {}) };
  for (const k in pins) bp[k] = { ...(bp[k] || {}), ws: pins[k].ws, cut: pins[k].cut };
  return { ...state, batchPins: bp };
}

// минимизация числа цехов: жадно освобождаем самые лёгкие цеха (кроме своего), перенося их артикулы
// в другой цех. Освобождаем ТОЛЬКО если это не рождает опозданий (приоритет #1) и НЕ ухудшает заморозку
// заметно (приоритет #2 — JIT — выше числа цехов #5). Так уходят реально лишние лёгкие цеха, а не «всё в один».
function minimizeWorkshopCount(state, items, assignWs, ctx) {
  const { buildPins, groupByArticle } = ctx;
  const freezeTolerance = 0.05; // допускаем рост заморозки не более чем на 5% ради экономии цеха
  const wsById = Object.fromEntries((state.workshops || []).map((w) => [w.id, w]));
  const ownId = (state.workshops.find((w) => w.own) || {}).id;
  const evalOf = (aw) => { const m = layoutMetrics(buildSchedule(withPins(state, buildPins(aw)))); return { late: m.lateUnits, freeze: m.freezeUnitDays }; };

  let cur = { ...assignWs };
  let baseE = evalOf(cur);
  let improved = true, guard = 0;
  while (improved && guard++ < (state.workshops.length + 2)) {
    improved = false;
    // цеха по возрастанию загрузки (объём), кроме своего — их пытаемся освободить первыми
    const load = {};
    for (const it of items) { const ws = cur[it.batchKey]; load[ws] = (load[ws] || 0) + it.units; }
    const candidates = Object.keys(load).filter((w) => w !== ownId).sort((a, b) => load[a] - load[b]);
    for (const victim of candidates) {
      // артикулы, живущие в victim
      const arts = [...new Set(items.filter((it) => cur[it.batchKey] === victim).map((it) => it.articleId))];
      // куда переносить: цех, уже шьющий этот артикул (меньше перестроек), иначе свой, иначе самый загруженный
      const trial = { ...cur };
      for (const art of arts) {
        const artBatches = items.filter((it) => it.articleId === art && cur[it.batchKey] === victim);
        const targets = Object.keys(load).filter((w) => w !== victim && wsById[w]);
        const alreadyHas = groupByArticle ? targets.find((w) => items.some((it) => it.articleId === art && cur[it.batchKey] === w)) : null;
        const dest = alreadyHas || (targets.includes(ownId) ? ownId : targets.sort((a, b) => load[b] - load[a])[0]);
        if (!dest) continue;
        for (const it of artBatches) trial[it.batchKey] = dest;
      }
      // остались ли ещё батчи в victim? если да — не полностью освободили, пропускаем
      if (items.some((it) => trial[it.batchKey] === victim)) continue;
      const e = evalOf(trial);
      const ok = e.late <= baseE.late && e.freeze <= baseE.freeze * (1 + freezeTolerance) + 1;
      if (ok) { cur = trial; baseE = e; improved = true; break; } // цех освобождён без опозданий и без заметного роста заморозки
    }
  }
  return cur;
}

function num(v, d) { const n = +v; return Number.isFinite(n) && n >= 0 ? n : d; }
