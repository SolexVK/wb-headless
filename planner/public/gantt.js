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
  container.innerHTML = '';

  const cycles = schedule.cycles || [];
  const tip = ensureTip();

  if (!cycles.length) {
    container.innerHTML = '<div style="padding:24px;color:var(--muted)">Нет циклов. Заполни план продаж во вкладке «Данные».</div>';
    return;
  }

  // диапазон дат: от самого раннего заказа ткани до самого позднего прихода на WB
  let minD = null, maxD = null;
  for (const c of cycles) {
    const lo = c.fabric.orderDate, hi = c.logistics.wbArrival;
    if (minD === null || parse(lo) < parse(minD)) minD = lo;
    if (maxD === null || parse(hi) > parse(maxD)) maxD = hi;
  }
  minD = iso(parse(minD) - 3 * MS);
  maxD = iso(parse(maxD) + 3 * MS);
  const totalDays = days(minD, maxD) + 1;

  const LABEL_W = 130;
  const HEADER_H = 46;
  const ROW_PAD = 6;
  const LANE_H = 40;

  const xOf = (d) => LABEL_W + days(minD, d) * pxPerDay;

  // строки-цеха в порядке state.workshops; лейн-паковка внутри цеха
  const wsList = state.workshops.filter((w) => cycles.some((c) => c.workshopId === w.id));
  const rows = [];
  for (const w of wsList) {
    const items = cycles.filter((c) => c.workshopId === w.id)
      .sort((a, b) => parse(a.ops.cut.start) - parse(b.ops.cut.start));
    const lanes = []; // конец занятости каждой полосы
    for (const c of items) {
      const start = parse(c.ops.cut.start), end = parse(c.ops.otk.end);
      let lane = lanes.findIndex((e2) => e2 <= start);
      if (lane === -1) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = end + 2 * MS;
      c._lane = lane;
    }
    rows.push({ ws: w, items, laneCount: Math.max(1, lanes.length) });
  }

  const rowY = [];
  let y = HEADER_H;
  for (const r of rows) { rowY.push(y); r._y = y; r._h = r.laneCount * LANE_H + ROW_PAD * 2; y += r._h; }
  const totalH = y + 10;
  const totalW = LABEL_W + totalDays * pxPerDay;

  const svg = el('svg', { width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}` }, container);

  // фон строк
  rows.forEach((r, i) => {
    el('rect', { class: 'g-row-bg', x: 0, y: r._y, width: totalW, height: r._h, fill: i % 2 ? 'var(--g-row-alt)' : 'transparent' }, svg);
  });

  // сетка по месяцам + недельные линии
  let cur = parse(minD);
  const endT = parse(maxD);
  while (cur <= endT) {
    const d = new Date(cur);
    const x = xOf(iso(cur));
    const isMonthStart = d.getUTCDate() === 1;
    const isWeek = d.getUTCDay() === 1; // понедельник
    if (isMonthStart || isWeek) {
      el('line', { x1: x, y1: HEADER_H, x2: x, y2: totalH, stroke: isMonthStart ? 'var(--line)' : 'var(--g-grid)', 'stroke-width': isMonthStart ? 1.4 : 1 }, svg);
    }
    if (isMonthStart) {
      el('rect', { x, y: 0, width: 1, height: HEADER_H, fill: 'var(--line)' }, svg);
      const t = el('text', { x: x + 6, y: 18, fill: 'var(--text)', 'font-size': 12, 'font-weight': 600 }, svg);
      t.textContent = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    if (d.getUTCDay() === 1) {
      const t = el('text', { x: x + 2, y: 38, fill: 'var(--muted)', 'font-size': 10 }, svg);
      t.textContent = d.getUTCDate();
    }
    cur += MS;
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

  // заголовки строк (цеха)
  el('rect', { x: 0, y: 0, width: LABEL_W, height: totalH, fill: 'var(--panel)' }, svg);
  el('line', { x1: LABEL_W, y1: 0, x2: LABEL_W, y2: totalH, stroke: 'var(--line)' }, svg);
  rows.forEach((r) => {
    const t = el('text', { x: 10, y: r._y + 20, fill: 'var(--text)', 'font-size': 13, 'font-weight': 600 }, svg);
    t.textContent = r.ws.name;
    const b = el('text', { x: 10, y: r._y + 36, fill: 'var(--muted)', 'font-size': 10 }, svg);
    b.textContent = r.ws.role === 'main' ? 'основной' : 'вспомог.';
  });

  // блоки-циклы
  for (const r of rows) {
    for (const c of r.items) {
      drawCycle(svg, c, r, { xOf, pxPerDay, LANE_H, ROW_PAD, minD, tip, onOverride });
    }
  }
}

function drawCycle(svg, c, row, ctx) {
  const { xOf, pxPerDay, LANE_H, ROW_PAD, tip, onOverride } = ctx;
  const laneY = row._y + ROW_PAD + c._lane * LANE_H;
  const barH = LANE_H - 8;
  const isDone = c.status === 'done' || c.status === 'shipped';
  const g = el('g', { class: 'g-cycle' + (c.logistics.lateDays > 0 ? ' g-late' : '') + (c.manual ? ' g-manual' : '') + (isDone ? ' g-done' : '') }, svg);

  const x0 = xOf(c.ops.cut.start);
  const x1 = xOf(c.ops.otk.end);
  const w = Math.max(6, x1 - x0);

  // рамка блока (выполненные — зелёная рамка + галочка)
  el('rect', { class: 'g-frame', x: x0, y: laneY, width: w, height: barH, rx: 5, fill: isDone ? 'rgba(52,211,153,.14)' : 'var(--g-frame)', stroke: isDone ? 'var(--accent-2)' : 'var(--line)', 'stroke-width': isDone ? 2 : 1 }, g);

  // операции — отдельными дорожками (видно перекрытие потока «лесенкой»)
  const trackH = Math.max(3, (barH - 6) / OPS.length);
  OPS.forEach((op, i) => {
    const sx = xOf(c.ops[op].start);
    const ex = xOf(c.ops[op].end);
    const sw = Math.max(3, ex - sx);
    el('rect', { x: sx, y: laneY + 3 + i * trackH, width: sw, height: Math.max(2, trackH - 1), rx: 2, fill: OP_COLOR[op], opacity: isDone ? 0.55 : 1 }, g);
  });
  if (isDone) {
    const chk = el('text', { x: x1 - 12, y: laneY + 13, 'font-size': 13, fill: 'var(--accent-2)', 'font-weight': 700 }, g);
    chk.textContent = c.status === 'shipped' ? '📦' : '✓';
  }

  // период закупа ткани: пунктирная линия от даты заказа до прихода на склад цеха
  const cy = laneY + barH / 2;
  const fabOrderX = xOf(c.fabric.orderDate);
  const fabX = xOf(c.fabric.atWorkshop);
  el('line', { x1: fabOrderX, y1: cy, x2: fabX, y2: cy, stroke: 'var(--fabric)', 'stroke-width': 2, 'stroke-dasharray': '5 3', opacity: 0.9 }, g);
  el('circle', { cx: fabOrderX, cy, r: 3.5, fill: 'var(--fabric)' }, g); // заказ ткани
  el('path', { d: diamond(fabX, cy, 4), fill: 'var(--fabric)' }, g);      // ткань на складе цеха
  const wbX = xOf(c.logistics.wbArrival);
  el('rect', { x: wbX - 3, y: laneY + barH / 2 - 3, width: 6, height: 6, fill: c.logistics.lateDays > 0 ? 'var(--danger)' : 'var(--accent-2)' }, g);
  el('line', { x1: x1, y1: laneY + barH / 2, x2: wbX, y2: laneY + barH / 2, stroke: 'var(--muted)', 'stroke-dasharray': '2 2', opacity: 0.5 }, g);

  // подпись (с тёмной обводкой для читаемости поверх дорожек)
  const label = `П${c.partiaNo} · ${c.articleId} · ${c.units}${c.split ? ' ⚡' : ''}`;
  const t = el('text', {
    x: x0 + 6, y: laneY + barH / 2 + 4, fill: '#fff', 'font-size': 11, 'font-weight': 700,
    stroke: 'rgba(0,0,0,0.75)', 'stroke-width': 2.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
  }, g);
  t.textContent = label;

  // тултип
  g.addEventListener('mousemove', (e) => showTip(tip, e, c));
  g.addEventListener('mouseleave', () => hideTip(tip));

  // перетаскивание (сдвиг старта кроя)
  let drag = null;
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    g.setPointerCapture(e.pointerId);
    g.classList.add('dragging');
    drag = { startX: e.clientX, origCut: c.ops.cut.start, dx: 0 };
    hideTip(tip);
  });
  g.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.startX;
    g.setAttribute('transform', `translate(${drag.dx},0)`);
  });
  const finish = (e) => {
    if (!drag) return;
    g.classList.remove('dragging');
    g.removeAttribute('transform');
    const shiftDays = Math.round(drag.dx / pxPerDay);
    const d0 = drag; drag = null;
    if (shiftDays !== 0) {
      const newCut = shiftISO(d0.origCut, shiftDays);
      onOverride(c.id, newCut);
    }
  };
  g.addEventListener('pointerup', finish);
  g.addEventListener('pointercancel', finish);

  // двойной клик — сброс ручного сдвига
  g.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (c.manual) onOverride(c.id, null);
  });
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
  tip.innerHTML = `
    <div><b>Партия ${c.partiaNo}</b> · ${c.articleName} — ${c.workshopName} ${c.split ? '⚡ дробление' : ''}</div>
    <div class="row">${c.stageName} · ${c.units} шт · ${c.workshopRole === 'main' ? 'основной' : 'вспом.'} цех · статус: <b>${c.statusRu || '—'}</b></div>
    <div class="row">Крой: ${fmt(c.ops.cut.start)} — Пошив: ${fmt(c.ops.sew.start)}</div>
    <div class="row">Готовность: <b>${fmt(c.readyDate)}</b></div>
    <div class="row">Ткань: заказ ${fmt(c.fabric.orderDate)} → склад ${fmt(c.fabric.atWorkshop)} (${c.fabric.meters} м)</div>
    <div class="row">Отгрузка ${fmt(c.logistics.shipment)} → WB ${fmt(c.logistics.wbArrival)} (дедлайн ${fmt(c.logistics.deadline)})</div>
    ${late}`;
}
function hideTip(tip) { tip.style.display = 'none'; }
