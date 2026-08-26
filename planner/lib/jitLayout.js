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
// мужские модели (требуют своего оборудования — только в мужских-способные цеха)
export const MENS_ARTICLE_IDS = ['002', '003', '005', '006', '007'];

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
  const deepShift = !!opts.deepShift;                     // глубокий пер-довозный сдвиг (больше экономии, возможны паузы)
  const summerIds = new Set((opts.summerIds && opts.summerIds.length ? opts.summerIds : SUMMER_ARTICLE_IDS).map((x) => String(x).trim()));

  const cal = makeCalendar(state.settings.calendar);
  const subWD = (iso, n) => { let cur = cal.nextWorkingDay(iso), left = Math.max(0, Math.ceil(n)), g = 0; while (left > 0 && g++ < 100000) { cur = addDays(cur, -1); while (!cal.isWorkingDay(cur)) cur = addDays(cur, -1); left--; } return cur; };
  const wdBetween = (a, b) => { let n = 0, cur = a, g = 0; while (diffDays(cur, b) >= 0 && g++ < 100000) { if (cal.isWorkingDay(cur)) n++; cur = addDays(cur, 1); } return n; };
  const effDl = (dl, isSummer) => { if (!dl) return '2099-01-01'; if (!isSummer) return dl; const cap = `${dl.slice(0, 4)}-${summerMMDD}`; return diffDays(cap, dl) < 0 ? cap : dl; };

  const base = buildSchedule(state);
  const before = layoutMetrics(base, summerIds);

  const wsAll = (state.workshops || []).slice();
  const ownId = (wsAll.find((w) => w.own) || wsAll.find((w) => w.role === 'main') || wsAll[0] || {}).id;
  const sewCap = (w) => (w.capacities && +w.capacities.sew) || 0;
  const ranked = wsAll.filter((w) => w.id !== ownId).sort((a, b) => sewCap(b) - sewCap(a));
  const capById = Object.fromEntries(wsAll.map((w) => [w.id, sewCap(w) || 1]));
  const artVol = {}, artAllow = {};
  for (const c of base.cycles) { if (c.historical) continue; artVol[c.articleId] = (artVol[c.articleId] || 0) + c.units; }
  for (const a of state.articles || []) artAllow[a.id] = (Array.isArray(a.allowedWorkshops) && a.allowedWorkshops.length) ? a.allowedWorkshops : null;
  // СТРОГИЕ ПРИВЯЗКИ из матрицы «кто шьёт» (страница «План по размерам»): если у артикула задан список
  // разрешённых цехов — он ОБЯЗАН шиться ТОЛЬКО в них. Экономная раскладка НЕ перебрасывает такие артикулы
  // за пределы их набора (ни при сокращении, ни при группировке). Свободно распределяются лишь артикулы БЕЗ
  // привязки (в матрице «любой цех»). boundOf → массив разрешённых цехов или null (свободный).
  const boundOf = (art) => artAllow[art];

  // ГЕНДЕРНОЕ (технологическое) ограничение: мужские модели требуют своего оборудования. Цех, который шьёт
  // мужские (по факту базы), «мужской-способный» — в нём можно и мужские, и женские. Цех, где шьют ТОЛЬКО
  // женские, мужские шить НЕ может. Значит: мужские артикулы — только в мужских-способные цеха; женские — в любые.
  const MENS = new Set((opts.mensArticleIds && opts.mensArticleIds.length ? opts.mensArticleIds : MENS_ARTICLE_IDS).map((x) => String(x).trim()));
  const isMens = (art) => MENS.has(String(art).trim());
  const mensCapable = new Set();
  for (const c of base.cycles) if (!c.historical && isMens(c.articleId)) mensCapable.add(c.workshopId);

  // ── СОКРАЩЕНИЕ ЦЕХОВ через ОГРАНИЧЕНИЕ набора цехов (не жёсткая привязка артикула в один цех!).
  // Планировщик сам распределяет — в т.ч. ДРОБИТ крупный довоз параллельно по разрешённым цехам (так база
  // укладывалась в сроки). ПРИВЯЗАННЫЕ артикулы — СТРОГО по матрице (не выходим за их набор); мужские без
  // привязки — только мужские-способные; свободные — любые из набора. На ВРЕМЕННОЙ копии state (матрицу не портим).
  const targetSetFor = (maxE) => [ownId, ...ranked.slice(0, maxE).map((w) => w.id)].filter(Boolean);
  const isSummer = (id) => summerIds.has(String(id).trim());

  // ── ВАРИАНТ «РАСПЫЛЕНИЕ»: свободному артикулу разрешён ВЕСЬ набор цехов (планировщик сам дробит параллельно),
  // ПРИВЯЗАННЫЙ — оставляем строго его набор из матрицы.
  const stateReducedFull = (maxE) => {
    const target = targetSetFor(maxE);
    const articles = (state.articles || []).map((a) => {
      if (boundOf(a.id)) return a; // строгая привязка из матрицы — НЕ трогаем (a.allowedWorkshops уже = разрешённые цеха)
      if (isMens(a.id)) { const cap = target.filter((w) => mensCapable.has(w)); return { ...a, allowedWorkshops: cap.length ? cap : [...mensCapable] }; } // мужские без привязки — только мужские-способные
      return { ...a, allowedWorkshops: target.slice() }; // свободные — любые из набора
    });
    return { ...state, articles };
  };

  // ── ВАРИАНТ «ГРУППИРОВКА»: СВОБОДНЫЙ артикул закрепляем за ОДНИМ цехом (минимум разных артикулов на цех ⇒
  // меньше перестроек), балансируя по мощности (load/cap). ПРИВЯЗАННЫЕ артикулы оставляем строго по матрице
  // (их набор разрешённых цехов не сужаем). Летние без привязки отдаём в ДОП. цеха (2/3/4) как «начинку» с
  // ноября (пол sewNotBefore ставит владелец) — свой цех оставляем на демисезоне.
  const groupedAssign = (maxE) => {
    const target = targetSetFor(maxE);
    const load = {}; for (const w of target) load[w] = 0;
    const assign = {};
    const free = [];
    for (const a of state.articles || []) {
      const bound = boundOf(a.id);
      if (bound) { assign[a.id] = bound.slice(); for (const w of bound) load[w] = (load[w] || 0) + (artVol[a.id] || 0) / bound.length; } // привязанный — весь его набор, объём делим по цехам
      else free.push(a);
    }
    free.sort((x, y) => (artVol[y.id] || 0) - (artVol[x.id] || 0)); // крупные — первыми (лучше балансируется)
    for (const a of free) {
      let elig = target.slice();
      if (isMens(a.id)) { const cap = elig.filter((w) => mensCapable.has(w)); elig = cap.length ? cap : [...mensCapable]; }
      if (isSummer(a.id)) { const noOwn = elig.filter((w) => w !== ownId); if (noOwn.length) elig = noOwn; } // летние — в доп. цеха
      let best = null, bestScore = Infinity;
      for (const w of elig) { const s = ((load[w] || 0) + (artVol[a.id] || 0)) / (capById[w] || 1); if (s < bestScore) { bestScore = s; best = w; } }
      if (!best) best = elig[0] || ownId;
      assign[a.id] = [best]; load[best] = (load[best] || 0) + (artVol[a.id] || 0);
    }
    return assign;
  };
  const stateReducedGrouped = (maxE) => {
    const assign = groupedAssign(maxE);
    const articles = (state.articles || []).map((a) => (assign[a.id] ? { ...a, allowedWorkshops: assign[a.id].slice() } : a));
    return { ...state, articles };
  };

  // ВЫБОР между группировкой и распылением: группировка (меньше перестроек) — только если НЕ добавляет
  // опозданий против распыления. Кэшируем расписание по maxE (свип вызывает многократно).
  const _redCache = {};
  const reducedFor = (maxE) => {
    if (_redCache[maxE]) return _redCache[maxE];
    const full = stateReducedFull(maxE), schFull = buildSchedule(full);
    const grp = stateReducedGrouped(maxE), schGrp = buildSchedule(grp);
    const lFull = layoutMetrics(schFull, summerIds).lateUnits;
    const lGrp = layoutMetrics(schGrp, summerIds).lateUnits;
    const useGrp = lGrp <= lFull; // группировка предпочтительна при равных/меньших опозданиях
    return (_redCache[maxE] = { state: useGrp ? grp : full, sch: useGrp ? schGrp : schFull, grouped: useGrp });
  };
  const stateReduced = (maxE) => reducedFor(maxE).state;
  const scheduleReduced = (maxE) => reducedFor(maxE).sch;

  // назначение батчей по цехам: reduce ⇒ распределение планировщика в ограниченном наборе; иначе — база.
  const assignWs = (maxE, reduce) => {
    const sch = reduce ? scheduleReduced(maxE) : base;
    const map = {};
    for (const c of sch.cycles) { if (c.historical) continue; map[c.batchKey] = c.workshopId; }
    return { map, sch, allowedN: new Set(Object.values(map)).size, grouped: reduce ? reducedFor(maxE).grouped : false };
  };

  // ЛЁГКАЯ оценка опозданий при данном наборе цехов (распределение планировщика, без сдвига) — для свипа
  const latenessOf = (maxE) => layoutMetrics(scheduleReduced(maxE), summerIds).lateUnits;

  // ЯДРО: полная раскладка для (maxE, reduce) — распределение + непрерывная упаковка + сдвиг блоков + защита
  const runOnce = (maxE, reduce) => {
    const { sch: s1, allowedN, grouped } = assignWs(maxE, reduce); // s1 = распределение в наборе (планировщик уже дробит параллельно)
    const items = s1.cycles.filter((c) => !c.historical).map((c) => ({ batchKey: c.batchKey, ws: c.workshopId, partiaId: c.partiaId }));
    const baseLate = new Set(s1.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0).map((c) => c.partiaId));
    const jitStarts = {};

    if (deepShift) {
      // ГЛУБОКИЙ ПЕР-ДОВОЗНЫЙ сдвиг: каждый довоз стартует как можно позже под СВОЙ дедлайн (а не по самому
      // срочному в цехе). Даёт бОльшую экономию, но между довозами с разными сроками возможны ПАУЗЫ (это плата).
      const byP = {};
      for (const c of s1.cycles) {
        if (c.historical) continue; const k = c.partiaId;
        const it = byP[k] || (byP[k] = { cut: c.ops.cut.start, otk: c.ops.otk.end, art: c.articleId, dl: (c.logistics && c.logistics.deadline) || '' });
        if (c.ops.cut.start < it.cut) it.cut = c.ops.cut.start; if (c.ops.otk.end > it.otk) it.otk = c.ops.otk.end;
      }
      for (const k of Object.keys(byP)) {
        const it = byP[k]; if (!it.dl) continue;
        const isS = summerIds.has(String(it.art).trim());
        const buf = isS ? deliveryBufferDays : Math.max(deliveryBufferDays, nonSummerCushionDays);
        const otkSpan = Math.max(1, wdBetween(it.cut, it.otk) - 1);
        let cut = subWD(cal.nextWorkingDay(addDays(effDl(it.dl, isS), -buf)), otkSpan);
        if (diffDays(cut, it.cut) > 0) cut = it.cut; // пол: не РАНЬШЕ базового кроя довоза (ALAP раньше базы ⇒ база)
        jitStarts[k] = cut;
      }
      // защита: снимаем пол у ДОВОЗОВ, ставших опоздавшими (пер-довозно, паузы допускаем)
      let afterSch2, g2 = 0;
      while (g2++ < 25) {
        afterSch2 = buildSchedule(withJit(state, jitStarts, items));
        const late = [...new Set(afterSch2.cycles.filter((c) => !c.historical && c.logistics.lateDays > 0 && !baseLate.has(c.partiaId)).map((c) => c.partiaId))].filter((pid) => jitStarts[pid]);
        if (!late.length) break;
        for (const pid of late) delete jitStarts[pid];
      }
      let after = layoutMetrics(afterSch2, summerIds);
      const ref = reduce ? layoutMetrics(s1, summerIds) : before;
      if (after.lateUnits > ref.lateUnits) { for (const k of Object.keys(jitStarts)) delete jitStarts[k]; afterSch2 = buildSchedule(withJit(state, jitStarts, items)); after = layoutMetrics(afterSch2, summerIds); }
      const wsPins = {}; for (const it of items) wsPins[it.batchKey] = { ws: it.ws };
      for (const k of Object.keys(jitStarts)) if (!jitStarts[k]) delete jitStarts[k];
      return { jitStarts, wsPins, after, allowedWorkshops: allowedN, grouped };
    }

    // ОБЫЧНЫЙ пер-цеховой сдвиг: весь блок цеха — на min запас (без разрывов).
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
    for (const w of Object.keys(wsFirstCut)) {
      const shift = Math.max(0, Math.floor(wsMinSlack[w] || 0));
      if (shift <= 0) continue;
      const start = cal.addWorkingDays(wsFirstCut[w], shift);
      for (const c of s1.cycles) if (!c.historical && c.workshopId === w) jitStarts[c.partiaId] = start;
    }
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
    const ref = reduce ? layoutMetrics(s1, summerIds) : before;
    if (after.lateUnits > ref.lateUnits || after.idleGaps > ref.idleGaps) {
      for (const k of Object.keys(jitStarts)) delete jitStarts[k];
      afterSch = buildSchedule(withJit(state, jitStarts, items));
      after = layoutMetrics(afterSch, summerIds);
    }
    const wsPins = {};
    for (const it of items) wsPins[it.batchKey] = { ws: it.ws };
    for (const k of Object.keys(jitStarts)) if (!jitStarts[k]) delete jitStarts[k];
    return { jitStarts, wsPins, after, allowedWorkshops: allowedN, grouped };
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
    if (r.grouped) note += '; артикулы сгруппированы по цехам (меньше перестроек)';
  } else {
    r = runOnce(maxExtra, ignoreAllowedMatrix);
    if (r.grouped) note = 'артикулы сгруппированы по цехам (меньше перестроек)';
  }

  return { jitStarts: r.jitStarts, wsPins: r.wsPins, before, after: r.after, allowedWorkshops: r.allowedWorkshops, reduceMode: ignoreAllowedMatrix || balance, balance, grouped: !!r.grouped, note };
}

function withJit(state, jitStarts, items) {
  const partias = (state.partias || []).map((p) => (jitStarts[p.id] ? { ...p, jitStart: jitStarts[p.id] } : { ...p, jitStart: '' }));
  const bp = { ...(state.batchPins || {}) };
  for (const it of items) bp[it.batchKey] = { ...(bp[it.batchKey] || {}), ws: it.ws };
  return { ...state, partias, batchPins: bp };
}
function num(v, d) { const n = +v; return Number.isFinite(n) && n >= 0 ? n : d; }
