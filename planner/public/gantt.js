// gantt.js — интерактивная диаграмма Ганта на SVG.
// Строки = цеха, блоки = производственные циклы (крой/пошив/утюжка/ОТК),
// блок можно тянуть мышью (сдвиг старта кроя), двойной клик — сброс сдвига.

const SVGNS = 'http://www.w3.org/2000/svg';
const MS = 86400000;
const OPS = ['cut', 'sew', 'iron', 'otk'];
const OP_COLOR = { cut: 'var(--cut)', sew: 'var(--sew)', iron: 'var(--iron)', otk: 'var(--otk)' };
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
const days = (a, b) => Math.round((parse(b) - parse(a)) / MS);
const fmt = (s) => { const d = new Date(parse(s)); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function renderGantt(container, schedule, state, opts = {}) {
  const pxPerDay = opts.pxPerDay || 14;
  const onOverride = opts.onOverride || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const onPin = opts.onPin || (() => {}); // пер-батчевый пин: onPin(batchKey, { ws, cut })
  container.innerHTML = '';

  const cycles = schedule.cycles || [];
  const tip = ensureTip();

  if (!cycles.length) {
    container.innerHTML = '<div style="padding:24px;color:var(--muted)">Нет циклов. Заполни план продаж во вкладке «Данные».</div>';
    return;
  }

  // диапазон дат: от старта кроя до позднего из (готовность/приход WB/дедлайн).
  // Заказ ткани в общий вид больше не выносим — он виден в детальном окне.
  let minD = null, maxD = null;
  for (const c of cycles) {
    const lo = c.ops.cut.start;
    const hi = [c.ops.otk.end, c.logistics.wbArrival, c.logistics.deadline].filter(Boolean)
      .reduce((m, d) => (parse(d) > parse(m) ? d : m), c.ops.otk.end);
    if (minD === null || parse(lo) < parse(minD)) minD = lo;
    if (maxD === null || parse(hi) > parse(maxD)) maxD = hi;
  }
  // защита от «монстров»: если из-за битой мощности цеха партия уходит на годы,
  // не растягиваем всю шкалу — ограничиваем правый край горизонтом плана
  // (последний дедлайн + 60 дней). Такие блоки просто обрежутся по краю.
  // горизонт учитывает и дедлайны этапов (legacy), и собственные дедлайны партий-поставок,
  // иначе циклы поставок с датами за пределами этапов обрезались бы у правого края.
  const deadlines = (state.stages || []).map((s) => s.deadline).filter(Boolean)
    .concat((state.partias || []).map((p) => p.deadline).filter(Boolean));
  if (deadlines.length) {
    const latest = deadlines.reduce((m, d) => (parse(d) > parse(m) ? d : m), deadlines[0]);
    const cap = parse(latest) + 60 * MS;
    if (parse(maxD) > cap) maxD = iso(cap);
  }
  minD = iso(parse(minD) - 3 * MS);
  maxD = iso(parse(maxD) + 3 * MS);
  const totalDays = days(minD, maxD) + 1;

  const LABEL_W = 200; // шире — чтобы под цехом поместился список артикулов с объёмами (номер крупно + объём)
  const HEADER_H = 46;
  const ROW_PAD = 6;
  const LANE_H = 40;
  const HEAD_H_ROW = 24; // полоска сверху каждого ряда-цеха под название цеха
  const ROW_PAD_B = 8;   // нижний отступ ряда

  const xOf = (d) => LABEL_W + days(minD, d) * pxPerDay;

  // строки-цеха в порядке state.workshops; лейн-паковка внутри цеха
  const wsList = state.workshops.filter((w) => cycles.some((c) => c.workshopId === w.id));
  const rows = [];
  for (const w of wsList) {
    const items = cycles.filter((c) => c.workshopId === w.id)
      .sort((a, b) => parse(a.ops.cut.start) - parse(b.ops.cut.start));
    // артикулы этого цеха с суммарным объёмом (по убыванию) — что и сколько цех шьёт
    const byArt = {};
    for (const c of items) byArt[c.articleId] = (byArt[c.articleId] || 0) + (c.units || 0);
    const arts = Object.entries(byArt).sort((a, b) => b[1] - a[1]);
    // КАЖДЫЙ артикул — на СВОЕЙ горизонтальной полосе (банде). Внутри банда партии одного артикула
    // упаковываются встык; если довозы одного артикула пересекаются во времени — добавляем под-полосу.
    let laneBase = 0;
    const artBands = [];
    for (const [art, vol] of arts) {
      const artItems = items.filter((c) => c.articleId === art); // уже отсортированы по крою
      const sub = []; // конец занятости под-полос этого артикула
      for (const c of artItems) {
        const start = parse(c.ops.cut.start), end = parse(c.ops.otk.end);
        let ln = sub.findIndex((e2) => e2 <= start);
        if (ln === -1) { ln = sub.length; sub.push(0); }
        sub[ln] = end + 2 * MS;
        c._lane = laneBase + ln;
      }
      const count = Math.max(1, sub.length);
      artBands.push({ art, vol, base: laneBase, count });
      laneBase += count;
    }
    rows.push({ ws: w, items, laneCount: Math.max(1, laneBase), arts, artBands });
  }

  const rowY = [];
  let y = HEADER_H;
  for (const r of rows) {
    rowY.push(y); r._y = y;
    r._h = HEAD_H_ROW + r.laneCount * LANE_H + ROW_PAD_B; // шапка цеха + полосы-артикулы + низ
    y += r._h;
  }
  const totalH = y + 10;
  const totalW = LABEL_W + totalDays * pxPerDay;

  const svg = el('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}` }, container);

  // фон строк
  rows.forEach((r, i) => {
    el('rect', { class: 'g-row-bg', x: 0, y: r._y, width: totalW, height: r._h, fill: i % 2 ? 'var(--g-row-alt)' : 'transparent' }, svg);
  });

  // сетка по месяцам + подписи дат (частота зависит от масштаба)
  // шаг подписей: минимум ~24px между числами, но не реже раза в неделю
  const labelStep = Math.min(7, Math.max(1, Math.ceil(24 / pxPerDay)));
  let cur = parse(minD);
  const endT = parse(maxD);
  let dayOffset = 0;
  while (cur <= endT) {
    const d = new Date(cur);
    const x = xOf(iso(cur));
    const isMonthStart = d.getUTCDate() === 1;
    const isLabelDay = isMonthStart || (dayOffset % labelStep === 0);
    if (isMonthStart || isLabelDay) {
      el('line', { x1: x, y1: HEADER_H, x2: x, y2: totalH, stroke: isMonthStart ? 'var(--line)' : 'var(--g-grid)', 'stroke-width': isMonthStart ? 1.4 : 1 }, svg);
    }
    if (isMonthStart) {
      el('rect', { x, y: 0, width: 1, height: HEADER_H, fill: 'var(--line)' }, svg);
      const t = el('text', { x: x + 6, y: 16, fill: 'var(--text)', 'font-size': 12, 'font-weight': 600 }, svg);
      t.textContent = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    if (isLabelDay) {
      // выходной (вс) — красноватый, чтобы легче ориентироваться
      const t = el('text', { x: x + 2, y: 38, fill: d.getUTCDay() === 0 ? 'var(--danger)' : 'var(--muted)', 'font-size': 10 }, svg);
      t.textContent = d.getUTCDate();
    }
    cur += MS; dayOffset++;
  }

  // дедлайны этапов (вертикальные красные линии)
  const seenDeadline = new Set();
  for (const st of state.stages) {
    if (!st.deadline || seenDeadline.has(st.deadline)) continue;
    seenDeadline.add(st.deadline);
    const x = xOf(st.deadline);
    el('line', { x1: x, y1: HEADER_H, x2: x, y2: totalH, stroke: 'var(--danger)', 'stroke-width': 1.2, 'stroke-dasharray': '5 4', opacity: 0.7 }, svg);
    el('path', { d: `M${x - 5} ${HEADER_H} L${x + 5} ${HEADER_H} L${x} ${HEADER_H + 9} Z`, fill: 'var(--danger)' }, svg);
  }

  // приход товара ВНЕ плана (остатки на WB / в пути / готово / в производстве) — маркеры на шкале.
  // Производство уже уменьшено на этот объём (неттинг); здесь показываем, КОГДА он приходит на WB.
  const SUP_COL = { wb: '#22c55e', transit: '#3b82f6', prod_stock: '#f59e0b', in_production: '#8b5cf6' };
  const SUP_RU = { wb: 'на складе WB', transit: 'в пути', prod_stock: 'готово на складе', in_production: 'в производстве' };
  const arrivals = (schedule.supply && schedule.supply.arrivals) || [];
  for (const a of arrivals) {
    if (!a.availableOn) continue;
    const t = parse(a.availableOn);
    if (t > parse(maxD)) continue;                       // приход за правым краем — не рисуем
    const past = t < parse(minD);                        // уже на складе до начала горизонта → прижать к левому краю
    const x = past ? LABEL_W + 3 : xOf(a.availableOn);
    const col = SUP_COL[a.source] || 'var(--muted)';
    el('line', { x1: x, y1: HEADER_H, x2: x, y2: totalH, stroke: col, 'stroke-width': 1.2, 'stroke-dasharray': '2 5', opacity: 0.35 }, svg);
    const tri = el('path', { d: `M${x - 6} ${HEADER_H - 2} L${x + 6} ${HEADER_H - 2} L${x} ${HEADER_H + 9} Z`, fill: col }, svg);
    el('title', {}, tri).textContent = `${a.articleId}: ${a.units} шт — ${SUP_RU[a.source] || a.source}, на WB ${a.availableOn}${past ? ' (уже на складе)' : ''}`;
    const lab = el('text', { x: x + (past ? 8 : 0), y: HEADER_H - 5, fill: col, 'font-size': 10, 'font-weight': 700, 'text-anchor': past ? 'start' : 'middle' }, svg);
    lab.textContent = '+' + a.units + (past ? ' ' + (SUP_RU[a.source] || '') : '');
  }

  // заголовки строк (цеха)
  el('rect', { x: 0, y: 0, width: LABEL_W, height: totalH, fill: 'var(--panel)' }, svg);
  el('line', { x1: LABEL_W, y1: 0, x2: LABEL_W, y2: totalH, stroke: 'var(--line)' }, svg);
  const fmtVol = (v) => String(Math.round(v || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // «44 000» — пробел между тысячами
  rows.forEach((r) => {
    // название цеха + роль — в шапке ряда
    const t = el('text', { x: 10, y: r._y + 16, fill: 'var(--text)', 'font-size': 13, 'font-weight': 600 }, svg);
    t.textContent = r.ws.name;
    const role = el('tspan', { fill: 'var(--muted)', 'font-size': 10 }, t);
    role.textContent = '  ' + (r.ws.role === 'main' ? 'основной' : 'вспомог.');
    // подпись артикула — НАПРОТИВ его горизонтальной полосы (по центру банда): номер крупно + объём
    for (const band of r.artBands) {
      const cy = r._y + HEAD_H_ROW + (band.base + band.count / 2) * LANE_H + 5;
      const line = el('text', { x: 12, y: cy }, svg);
      const a = el('tspan', { fill: '#c99a00', 'font-weight': 700, 'font-size': 15 }, line); a.textContent = band.art;
      const v = el('tspan', { fill: 'var(--muted)', 'font-size': 11 }, line); v.textContent = `  ${fmtVol(band.vol)} шт`;
    }
  });

  // горизонтальные разделители между цехами (на всю ширину, включая колонку названий) —
  // чтобы сразу видеть, какой ряд-артикул к какому цеху относится.
  const rowBottom = rows.length ? rows[rows.length - 1]._y + rows[rows.length - 1]._h : totalH;
  rows.forEach((r) => {
    el('line', { x1: 0, y1: r._y, x2: totalW, y2: r._y, stroke: 'var(--line)', 'stroke-width': 1.2, class: 'g-ws-sep' }, svg);
    // тонкие разделители между полосами-артикулами внутри цеха — видно, где кончается один артикул и начинается другой
    for (const band of r.artBands) {
      if (band.base === 0) continue;
      const by = r._y + HEAD_H_ROW + band.base * LANE_H;
      el('line', { x1: 0, y1: by, x2: totalW, y2: by, stroke: 'var(--g-grid)', 'stroke-width': 1, opacity: 0.55 }, svg);
    }
  });
  el('line', { x1: 0, y1: rowBottom, x2: totalW, y2: rowBottom, stroke: 'var(--line)', 'stroke-width': 1.2, class: 'g-ws-sep' }, svg);

  // блоки-циклы
  for (const r of rows) {
    for (const c of r.items) {
      drawCycle(svg, c, r, { xOf, pxPerDay, LANE_H, HEAD_H_ROW, minD, tip, onOverride, onProgress, onPin, rows, svg });
    }
  }
}

// какой цех (строка) под точкой svgY; null — вне рядов
function wsAtY(rows, svgY) {
  for (const r of rows) { if (svgY >= r._y && svgY < r._y + r._h) return r.ws; }
  return null;
}

function drawCycle(svg, c, row, ctx) {
  const { xOf, pxPerDay, LANE_H, HEAD_H_ROW, tip, onOverride, onProgress, onPin, rows } = ctx;
  const laneY = row._y + HEAD_H_ROW + c._lane * LANE_H + 4;
  const barH = LANE_H - 8;
  const isDone = c.status === 'done' || c.status === 'shipped';
  const isLate = c.logistics.lateDays > 0;
  const g = el('g', { class: 'g-cycle' + (isLate ? ' g-late' : '') + (c.manual ? ' g-manual' : '') + (isDone ? ' g-done' : '') }, svg);

  const x0 = xOf(c.ops.cut.start);
  const x1 = xOf(c.ops.otk.end);
  const w = Math.max(6, x1 - x0);

  // ЕДИНЫЙ блок этапа (крой → ОТК), без внутренних операций и пунктиров —
  // подробности по двойному клику. Цвет: готово — зелёный, срыв — красный,
  // иначе — «пошив».
  const fill = isDone ? 'var(--accent-2)' : isLate ? 'var(--danger)' : 'var(--sew)';
  const fillOp = isDone ? 0.22 : isLate ? 0.28 : 0.9;
  el('rect', {
    class: 'g-frame', x: x0, y: laneY, width: w, height: barH, rx: 5,
    fill, 'fill-opacity': fillOp,
    stroke: isDone ? 'var(--accent-2)' : isLate ? 'var(--danger)' : 'var(--line)',
    'stroke-width': isDone || isLate ? 2 : 1,
  }, g);

  if (isDone) {
    const chk = el('text', { x: x1 - 14, y: laneY + barH / 2 + 4, 'font-size': 13, fill: 'var(--accent-2)', 'font-weight': 700 }, g);
    chk.textContent = c.status === 'shipped' ? '📦' : '✓';
  }

  // подпись: НОМЕР АРТИКУЛА — первым, крупно и жёлтым; затем номер партии (prodNo) и объём.
  const t = el('text', {
    x: x0 + 8, y: laneY + barH / 2 + 4, 'font-weight': 700,
    stroke: 'rgba(0,0,0,0.8)', 'stroke-width': 2.8, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
  }, g);
  const art = el('tspan', { fill: '#ffd23f', 'font-size': 16 }, t); // артикул — крупный, жёлтый
  art.textContent = c.articleId;
  const rest = el('tspan', { fill: '#fff', 'font-size': 11 }, t);
  rest.textContent = ` · п${c.prodNo || c.partiaNo} · ${c.units} шт`;

  // значок отставания (⏱ +Nд) на правом краю блока — видно без двойного клика
  if (c.delay && c.delay.days > 0) {
    const col = c.delay.willMiss ? '#fca5a5' : '#fcd34d';
    const bt = el('text', {
      x: x1 - 6, y: laneY + barH / 2 + 4, fill: col, 'font-size': 10, 'font-weight': 700,
      'text-anchor': 'end', stroke: 'rgba(0,0,0,0.8)', 'stroke-width': 2.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
    }, g);
    bt.textContent = `⏱+${c.delay.days}д`;
  }
  // маркер ручного закрепления (пин): цех/дата зафиксированы вручную или уплотнением
  if (c.pinned) {
    const pn = el('text', { x: x0 + 3, y: laneY + 11, 'font-size': 10 }, g);
    pn.textContent = '📌';
    el('title', {}, pn).textContent = 'Закреплено вручную (цех/дата). «Сбросить раскладку» — вернуть авто.';
  }
  g.style.cursor = 'grab';

  // тултип
  g.addEventListener('mousemove', (e) => showTip(tip, e, c));
  g.addEventListener('mouseleave', () => hideTip(tip));

  // перетаскивание: по ГОРИЗОНТАЛИ — сдвиг даты кроя, по ВЕРТИКАЛИ — перенос батча в другой цех.
  // Одним движением можно сменить и то, и другое. Пишем пер-батчевый пин onPin(batchKey,{ws,cut}).
  // Кликом (без смещения) — ничего не меняем (двойной клик = детальное окно).
  let drag = null;
  const svgPt = (clientX, clientY) => { // экранные координаты → пользовательские координаты SVG
    const m = svg.getScreenCTM(); if (!m) return { x: clientX, y: clientY };
    const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY;
    return p.matrixTransform(m.inverse());
  };
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    g.setPointerCapture(e.pointerId);
    g.classList.add('dragging');
    drag = { startX: e.clientX, origCut: c.ops.cut.start, dx: 0, dy: 0, clientY: e.clientY };
    hideTip(tip);
  });
  g.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.startX;
    drag.dy = e.clientY - drag.clientY;
    g.setAttribute('transform', `translate(${drag.dx},${drag.dy})`);
  });
  const finish = (e) => {
    if (!drag) return;
    g.classList.remove('dragging');
    g.removeAttribute('transform');
    const d0 = drag; drag = null;
    const shiftDays = Math.round(d0.dx / pxPerDay);
    // целевой цех — по вертикальной позиции курсора в момент отпускания
    const loc = svgPt(d0.startX + d0.dx, (e && e.clientY) || d0.clientY + d0.dy);
    const targetWs = wsAtY(rows, loc.y) || row.ws;
    const newCut = shiftDays !== 0 ? shiftISO(d0.origCut, shiftDays) : d0.origCut;
    const wsChanged = targetWs.id !== c.workshopId;
    if (!wsChanged && shiftDays === 0) return; // ни цех, ни дата не изменились — это клик
    onPin(c.batchKey, { ws: targetWs.id, cut: newCut });
  };
  g.addEventListener('pointerup', finish);
  g.addEventListener('pointercancel', finish);

  // двойной клик — детальный зум по этапу (внутренние операции + пунктиры)
  g.addEventListener('dblclick', (e) => {
    e.preventDefault();
    hideTip(tip);
    openCycleDetail(c, onOverride, onProgress);
  });
}

// ── Детальное окно этапа: мини-шкала с внутренними операциями и пунктирами ──
function openCycleDetail(c, onOverride, onProgress = () => {}) {
  document.querySelector('.g-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'g-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;max-width:min(900px,96vw);width:100%;max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.4)';
  overlay.appendChild(modal);

  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  // диапазон мини-шкалы: от заказа ткани до прихода на WB (+поля)
  const lo = Math.min(parse(c.fabric.orderDate), parse(c.ops.cut.start)) - 2 * MS;
  const hi = Math.max(parse(c.logistics.wbArrival), parse(c.ops.otk.end), parse(c.logistics.deadline || c.logistics.wbArrival)) + 2 * MS;
  const totalDays = Math.max(1, Math.round((hi - lo) / MS));
  const PADL = 92, PADR = 20, innerW = Math.min(760, Math.max(520, totalDays * 12));
  const ppd = innerW / totalDays;
  const xOf = (isoS) => PADL + ((parse(isoS) - lo) / MS) * ppd;
  const svgW = PADL + innerW + PADR;

  const ROWS = [
    { key: 'cut', label: 'Крой', s: c.ops.cut.start, e: c.ops.cut.end },
    { key: 'sew', label: 'Пошив', s: c.ops.sew.start, e: c.ops.sew.end },
    { key: 'iron', label: 'Утюжка', s: c.ops.iron.start, e: c.ops.iron.end },
    { key: 'otk', label: 'ОТК', s: c.ops.otk.start, e: c.ops.otk.end },
  ];
  const AXIS_H = 34, ROW_H = 30, FAB_H = 30, WB_H = 30;
  const bodyY = AXIS_H;
  const svgH = AXIS_H + FAB_H + ROWS.length * ROW_H + WB_H + 14;

  const svg = el('svg', { width: svgW, height: svgH, viewBox: `0 0 ${svgW} ${svgH}` });
  svg.style.cssText = 'display:block;margin:8px auto';

  // ось: подписи дат по дням/неделям + линии
  const step = totalDays > 40 ? 7 : totalDays > 20 ? 3 : 1;
  for (let t = 0; t <= totalDays; t++) {
    const day = lo + t * MS;
    const d = new Date(day);
    const x = PADL + t * ppd;
    if (d.getUTCDate() === 1 || t % step === 0) {
      el('line', { x1: x, y1: AXIS_H - 6, x2: x, y2: svgH - 6, stroke: 'var(--g-grid)', 'stroke-width': d.getUTCDate() === 1 ? 1.3 : 1, opacity: d.getUTCDate() === 1 ? 0.9 : 0.5 }, svg);
      const tx = el('text', { x: x + 2, y: 14, 'font-size': 9, fill: d.getUTCDay() === 0 ? 'var(--danger)' : 'var(--muted)' }, svg);
      tx.textContent = d.getUTCDate();
      if (d.getUTCDate() === 1) { const mt = el('text', { x: x + 2, y: 26, 'font-size': 9, fill: 'var(--muted)', 'font-weight': 600 }, svg); mt.textContent = MONTHS[d.getUTCMonth()]; }
    }
  }

  // дедлайн — вертикальная красная пунктирная
  if (c.logistics.deadline) {
    const dx = xOf(c.logistics.deadline);
    el('line', { x1: dx, y1: AXIS_H - 6, x2: dx, y2: svgH - 6, stroke: 'var(--danger)', 'stroke-width': 1.3, 'stroke-dasharray': '5 4', opacity: 0.8 }, svg);
    const dt = el('text', { x: dx + 3, y: svgH - 2, 'font-size': 9, fill: 'var(--danger)', 'font-weight': 600 }, svg);
    dt.textContent = 'дедлайн';
  }

  const rowLabel = (y, text, color) => {
    const t2 = el('text', { x: 10, y: y + 15, 'font-size': 11, fill: color || 'var(--text)' }, svg);
    t2.textContent = text;
  };

  // ткань: пунктир заказ → склад цеха
  let yy = bodyY;
  rowLabel(yy, 'Ткань', 'var(--fabric)');
  const foX = xOf(c.fabric.orderDate), faX = xOf(c.fabric.atWorkshop), fcy = yy + 15;
  el('line', { x1: foX, y1: fcy, x2: faX, y2: fcy, stroke: 'var(--fabric)', 'stroke-width': 2, 'stroke-dasharray': '5 3' }, svg);
  el('circle', { cx: foX, cy: fcy, r: 3.5, fill: 'var(--fabric)' }, svg);
  el('path', { d: diamond(faX, fcy, 4), fill: 'var(--fabric)' }, svg);
  yy += FAB_H;

  // операции — отдельными полосами
  ROWS.forEach((r) => {
    rowLabel(yy, r.label);
    const sx = xOf(r.s), ex = xOf(r.e);
    el('rect', { x: sx, y: yy + 4, width: Math.max(3, ex - sx), height: ROW_H - 10, rx: 3, fill: OP_COLOR[r.key] }, svg);
    yy += ROW_H;
  });

  // логистика: пунктир готовность → WB
  rowLabel(yy, 'Отгрузка', 'var(--muted)');
  const otkX = xOf(c.ops.otk.end), wbX = xOf(c.logistics.wbArrival), lcy = yy + 15;
  el('line', { x1: otkX, y1: lcy, x2: wbX, y2: lcy, stroke: 'var(--muted)', 'stroke-width': 2, 'stroke-dasharray': '4 3' }, svg);
  el('rect', { x: wbX - 4, y: lcy - 4, width: 8, height: 8, fill: c.logistics.lateDays > 0 ? 'var(--danger)' : 'var(--accent-2)' }, svg);

  // шапка + детали + кнопки
  const head = document.createElement('div');
  head.style.cssText = 'padding:14px 16px 4px';
  const lateTxt = c.logistics.lateDays > 0 ? ` · <span style="color:var(--danger)">опоздание ${c.logistics.lateDays} дн</span>` : '';
  head.innerHTML = `<div style="font-size:15px;font-weight:700"><span style="color:#d97706">Артикул ${c.articleId}</span> — ${c.articleName} · партия ${c.prodNo || c.partiaNo}</div>
    <div style="color:var(--muted);font-size:12px;margin-top:2px">${c.deliveryTag ? c.deliveryTag + (c.batchCount > 1 ? ` · часть ${c.batchIndex + 1}/${c.batchCount}` : '') + ' · ' : ''}${c.stageName} · ${c.units} шт · цех ${c.workshopName}${c.own ? ' (свой)' : ''} · статус ${c.statusRu || '—'}${lateTxt}</div>`;
  modal.appendChild(head);
  modal.appendChild(svg);

  const info = document.createElement('div');
  info.style.cssText = 'padding:4px 16px 12px;color:var(--text);font-size:12.5px;line-height:1.7';
  info.innerHTML = `
    <div>Ткань: заказ <b>${fmt(c.fabric.orderDate)}</b> → на складе цеха <b>${fmt(c.fabric.atWorkshop)}</b> · ${c.fabric.meters.toLocaleString('ru')} м</div>
    <div>Крой ${fmt(c.ops.cut.start)} · Пошив ${fmt(c.ops.sew.start)} · Утюжка ${fmt(c.ops.iron.start)} · ОТК до <b>${fmt(c.ops.otk.end)}</b> (готовность)</div>
    <div>Отгрузка ${fmt(c.logistics.shipment)} → приход на WB <b>${fmt(c.logistics.wbArrival)}</b> · дедлайн ${fmt(c.logistics.deadline)}</div>
    <div>На WB: <b>${(c.hasFact ? c.wbUnits : c.units).toLocaleString('ru')} шт</b> ${c.hasFact ? '(факт)' : '(план)'}${c.locked ? ' · <span style="color:var(--accent-2)">цех закреплён вручную</span>' : ''}${c.manual ? ' · сдвинут вручную' : ''}</div>`;
  modal.appendChild(info);

  // Факт по операциям (ввод дат завершения) — считает отставание по каждому этапу
  const OP_LABELS = { cut: 'Крой', sew: 'Пошив', iron: 'Утюжка', otk: 'ОТК' };
  const prog = document.createElement('div');
  prog.style.cssText = 'padding:6px 16px 12px;border-top:1px solid var(--line)';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px';
  ['cut', 'sew', 'iron', 'otk'].forEach((op) => {
    const d = c.delay && c.delay.perOp ? c.delay.perOp[op] : null;
    const dl = d == null ? '' : (d <= 0 ? ' · <span style="color:var(--accent-2)">в срок</span>' : ` · <span style="color:var(--danger)">+${d} дн</span>`);
    const field = document.createElement('div');
    field.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    field.innerHTML = `<label style="font-size:11px;color:var(--muted)">${OP_LABELS[op]} · план ${fmt(c.ops[op].end)}${dl}</label>`;
    const inp = document.createElement('input');
    inp.type = 'date';
    inp.value = (c.progress && c.progress[op]) || '';
    inp.style.cssText = 'padding:4px 6px;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px';
    inp.addEventListener('change', () => { close(); onProgress(c.partiaId, op, inp.value || ''); });
    field.appendChild(inp);
    grid.appendChild(field);
  });
  prog.innerHTML = '<div style="font-weight:600;margin-bottom:6px;font-size:13px">Факт завершения операций</div>';
  prog.appendChild(grid);
  modal.appendChild(prog);

  const foot = document.createElement('div');
  foot.style.cssText = 'padding:10px 16px 16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--line)';
  if (c.manual) {
    const reset = document.createElement('button');
    reset.className = 'btn'; reset.textContent = '↺ Сбросить ручной сдвиг';
    reset.addEventListener('click', () => { close(); onOverride(c.id, null); });
    foot.appendChild(reset);
  }
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn'; closeBtn.textContent = 'Закрыть';
  closeBtn.addEventListener('click', close);
  foot.appendChild(closeBtn);
  modal.appendChild(foot);

  document.body.appendChild(overlay);
}

function diamond(cx, cy, r) { return `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`; }
function shiftISO(s, d) { return iso(parse(s) + d * MS); }

function ensureTip() {
  let tip = document.querySelector('.g-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'g-tip'; document.body.appendChild(tip); }
  return tip;
}
function showTip(tip, e, c) {
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 340) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
  const late = c.logistics.lateDays > 0 ? `<div class="row" style="color:var(--danger)">⚠ Опоздание на WB: ${c.logistics.lateDays} дн</div>` : '';
  const tag = c.own ? ' · <span style="color:var(--accent-2)">свой</span>' : (c.locked ? ' · <span style="color:var(--accent-2)">закреплён</span>' : '');
  tip.innerHTML = `
    <div><b style="color:#d97706">Артикул ${c.articleId}</b> ${c.articleName} · партия ${c.prodNo || c.partiaNo}</div>
    <div class="row">${c.deliveryTag ? c.deliveryTag + (c.batchCount > 1 ? ` · часть ${c.batchIndex + 1}/${c.batchCount}` : '') + ' · ' : ''}${c.stageName} · ${c.units.toLocaleString('ru')} шт · цех ${c.workshopName}${tag} · <b>${c.statusRu || '—'}</b></div>
    <div class="row">Производство: <b>${fmt(c.ops.cut.start)}</b> (крой) → <b>${fmt(c.readyDate)}</b> (готовность)</div>
    <div class="row">Приход на WB: <b>${fmt(c.logistics.wbArrival)}</b> · дедлайн ${fmt(c.logistics.deadline)}</div>
    <div class="row">На WB: <b>${(c.hasFact ? c.wbUnits : c.units).toLocaleString('ru')} шт</b>${c.hasFact ? ` <span style="color:var(--accent-2)">(факт)</span>` : ' (план)'}</div>
    ${late}
    <div class="row" style="color:var(--muted);margin-top:4px">Двойной клик — детали этапа (крой/пошив/утюжка/ОТК, ткань, отгрузка)</div>`;
}
function hideTip(tip) { tip.style.display = 'none'; }
