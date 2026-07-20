// app.js — оболочка SPA: загрузка данных, вкладки, дашборд, формы, Гант.
import { renderGantt } from './gantt.js';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// сортировка артикулов по номеру, от меньшего к большему (числовая: 004 < 026)
const cmpArticleId = (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });
const articlesSorted = () => [...state.articles].sort(cmpArticleId);
const fmt = (s) => { if (!s) return '—'; const [y, m, d] = s.slice(0, 10).split('-'); return `${+d} ${MONTHS[+m - 1]}`; };
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

let state = null;
let schedule = null;
let pxPerDay = 14;
let dirty = false;

// ---------- API ----------
async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
async function loadAll() {
  state = await api('/api/state');
  const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify({}) });
  schedule = r.schedule;
}
async function recalc(persist = false) {
  if (persist) {
    const r = await api('/api/state', { method: 'PUT', body: JSON.stringify(state) });
    state = r.state; dirty = false;
  }
  const r = await api('/api/schedule', { method: 'POST', body: JSON.stringify(state) });
  schedule = r.schedule;
  renderCurrent();
  setStatus();
}

// ---------- статус / тосты ----------
function setStatus() {
  const errs = (schedule?.warnings || []).filter((w) => w.level === 'error').length;
  const warns = (schedule?.warnings || []).filter((w) => w.level === 'warn').length;
  const s = document.getElementById('status');
  s.innerHTML = `${schedule?.cycles.length || 0} циклов · `
    + (errs ? `<span style="color:var(--danger)">${errs} срывов</span>` : '<span style="color:var(--accent-2)">без срывов</span>')
    + (warns ? ` · ${warns} предупр.` : '')
    + (dirty ? ' · <span style="color:var(--warn)">есть несохранённые правки</span>' : '');
}
let toastT;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = 'toast'), 2200);
}

// ---------- вкладки ----------
let activeTab = 'gantt';
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  renderCurrent();
}
// ---------- сезоны (мультисезон) ----------
let activeSeasonId = '';
function seasonStages() { return activeSeasonId ? state.stages.filter((s) => s.seasonId === activeSeasonId) : state.stages.slice(); }
function stageInSeason(stageId) { if (!activeSeasonId) return true; const st = state.stages.find((s) => s.id === stageId); return !!st && st.seasonId === activeSeasonId; }
function refreshSeasonFilter() {
  const sel = document.getElementById('season-filter');
  if (!sel) return;
  const seasons = state.seasons || [];
  if (activeSeasonId && !seasons.find((se) => se.id === activeSeasonId)) activeSeasonId = '';
  sel.innerHTML = `<option value="">Все сезоны</option>` + seasons.map((se) => `<option value="${se.id}"${se.id === activeSeasonId ? ' selected' : ''}>${se.name}</option>`).join('');
}
const addMonthYM = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return `${y}-${String(m).padStart(2, '0')}`; };
function addSeason() {
  state.seasons = state.seasons || [];
  const n = state.seasons.length + 1;
  const id = 'season_' + Math.random().toString(36).slice(2, 8);
  state.seasons.push({ id, name: 'Сезон ' + n });
  // продолжаем календарь: 4 этапа сразу после последнего месяца отшива (бесшовно)
  let lastYM = null;
  for (const s of state.stages) { if (s.productionMonth && (!lastYM || s.productionMonth > lastYM)) lastYM = s.productionMonth; }
  const base = lastYM || '2026-06';
  for (let i = 0; i < 4; i++) {
    const pm = addMonthYM(base, i + 1);
    state.stages.push({ id: uid('stage'), name: `Этап ${i + 1}`, seasonId: id, salesMonths: '', productionMonth: pm, deadline: addMonthYM(pm, 1) + '-01' });
  }
  activeSeasonId = id;
}

function renderCurrent() {
  recomputePartiaNumbers(); // держим номера партий (по цехам) актуальными для отображения
  refreshSeasonFilter();
  if (activeTab === 'gantt') {
    const sch = { ...schedule, cycles: (schedule?.cycles || []).filter((c) => stageInSeason(c.stageId)) };
    renderGantt(document.getElementById('gantt'), sch, state, { pxPerDay, onOverride });
  }
  else if (activeTab === 'matrix') renderMatrix();
  else if (activeTab === 'salesplan') renderSalesPlan();
  else if (activeTab === 'fact') renderFact();
  else if (activeTab === 'fabric') renderFabricOrder();
  else if (activeTab === 'dashboard') renderDashboard();
  else if (activeTab === 'data') renderData();
  applyCollapsibles();
}

// ---------- ФАКТ (фактические количества по партиям) ----------
let factPartiaId = null;
let factFilterStage = '', factFilterArticle = '', factFilterWs = '';
function renderFact() {
  const root = document.getElementById('fact');
  const all = state.partias || [];
  if (!all.length) { root.innerHTML = '<div class="panel"><div class="mini">Нет партий. Создай план на «План по размерам».</div></div>'; return; }
  // фильтры: этап / артикул / цех (+ активный сезон)
  const matchP = (x) => stageInSeason(x.stageId)
    && (!factFilterStage || x.stageId === factFilterStage)
    && (!factFilterArticle || x.articleId === factFilterArticle)
    && (!factFilterWs || (factFilterWs === '__auto__' ? !x.workshopId : x.workshopId === factFilterWs));
  const stageOrder = {}; state.stages.forEach((s, i) => { stageOrder[s.id] = i; });
  const parts = all.filter(matchP).sort((x, y) => (stageOrder[x.stageId] - stageOrder[y.stageId]) || (x.workshopId || '').localeCompare(y.workshopId || '') || x.no - y.no);
  const gIdx = (id) => state.stages.findIndex((z) => z.id === id) + 1;

  const filtersHtml = `
    <div class="matrix-controls">
      <label>Этап: <select id="ff-stage"><option value="">все</option>${seasonStages().map((s) => `<option value="${s.id}"${s.id === factFilterStage ? ' selected' : ''}>Этап ${gIdx(s.id)}${s.salesMonths ? ' · ' + s.salesMonths : ''}</option>`).join('')}</select></label>
      <label>Артикул: <select id="ff-article"><option value="">все</option>${articlesSorted().map((x) => `<option value="${x.id}"${x.id === factFilterArticle ? ' selected' : ''}>${x.id}</option>`).join('')}</select></label>
      <label>Цех: <select id="ff-ws"><option value="">все</option><option value="__auto__"${factFilterWs === '__auto__' ? ' selected' : ''}>авто (не назначен)</option>${state.workshops.map((w) => `<option value="${w.id}"${w.id === factFilterWs ? ' selected' : ''}>${w.name}</option>`).join('')}</select></label>
      <label>Партия: <select id="fact-partia">${parts.map((x) => { const wn = state.workshops.find((w) => w.id === x.workshopId)?.name || 'авто'; const si = state.stages.findIndex((z) => z.id === x.stageId) + 1; return `<option value="${x.id}"${x.id === factPartiaId ? ' selected' : ''}>${wn} · Партия ${x.no} · ${x.articleId} · Этап ${si}</option>`; }).join('') || '<option>нет партий</option>'}</select></label>
    </div>`;

  const bindFilters = () => {
    document.getElementById('ff-stage').addEventListener('change', (e) => { factFilterStage = e.target.value; factPartiaId = null; renderFact(); });
    document.getElementById('ff-article').addEventListener('change', (e) => { factFilterArticle = e.target.value; factPartiaId = null; renderFact(); });
    document.getElementById('ff-ws').addEventListener('change', (e) => { factFilterWs = e.target.value; factPartiaId = null; renderFact(); });
  };

  if (!parts.length) {
    root.innerHTML = `<div class="panel">${filtersHtml}<div class="mini">Нет партий по выбранным фильтрам.</div></div>`;
    bindFilters(); applyCollapsibles(); return;
  }
  let p = parts.find((x) => x.id === factPartiaId) || parts[0];
  factPartiaId = p.id;
  const a = state.articles.find((x) => x.id === p.articleId);
  const stage = state.stages.find((s) => s.id === p.stageId);
  if (!a || !stage) { root.innerHTML = '<div class="panel"><div class="mini">Партия ссылается на удалённый артикул/этап.</div></div>'; return; }
  const stIdx = state.stages.findIndex((s) => s.id === stage.id) + 1;
  const ws = state.workshops.find((w) => w.id === p.workshopId);
  p.factMatrix = p.factMatrix || {};
  const F = p.factMatrix, PM = p.planMatrix || {};
  for (const c of a.colors) { F[c] = F[c] || {}; for (const s of a.sizes) if (F[c][s] == null) F[c][s] = 0; }
  const planTotal = sumMatrix(PM), factTotal = sumMatrix(F);
  const diff = factTotal - planTotal;

  const rows = a.sizes.map((s) => `<tr><th class="mx-size">${s}</th>${a.colors.map((c) => {
    const pv = cell(PM, c, s);
    return `<td><input data-fact data-c="${encodeURIComponent(c)}" data-s="${encodeURIComponent(s)}" type="number" min="0" value="${cell(F, c, s)}" placeholder="${pv || 0}" title="план: ${pv}"></td>`;
  }).join('')}<td class="num mx-rowtot" data-frowtot="${encodeURIComponent(s)}">${a.colors.reduce((n, c) => n + cell(F, c, s), 0)}</td></tr>`).join('');

  root.innerHTML = `
    <div class="panel">
      ${filtersHtml}
      <div class="partia-bar">
        <span class="partia-badge">Партия ${p.no}</span>
        <label>Статус:
          <select id="fact-status">${PARTIA_STATUS_LIST.map((s) => `<option value="${s}"${s === p.status ? ' selected' : ''}>${PARTIA_STATUS_RU[s]}</option>`).join('')}</select>
        </label>
        <label class="mini"><input type="checkbox" id="fact-hist"${p.historical ? ' checked' : ''}> прошлый период</label>
        <button id="fact-copy" class="btn">Скопировать план → факт</button>
        <button id="fact-save" class="btn btn-primary">Сохранить факт</button>
      </div>
      <div class="mini" style="margin-bottom:10px">Партия ${p.no} · <b>${a.id}</b> ${a.name} · Этап ${stIdx} ${stage.salesMonths ? '(' + stage.salesMonths + ')' : ''} · цех ${ws ? ws.name : 'авто'} · статус ${statusBadge(p.status)}. Введи фактически произведённое — оно уедет на склад WB (план остаётся для производства).</div>
      <div class="fab-summary">
        <div><div class="k">План</div><div class="v">${planTotal.toLocaleString('ru')} шт</div></div>
        <div><div class="k">Факт</div><div class="v ${factTotal > 0 ? 'good' : ''}">${factTotal.toLocaleString('ru')} шт</div></div>
        <div><div class="k">Разница</div><div class="v ${diff < 0 ? 'bad' : ''}" id="fact-diff">${diff > 0 ? '+' : ''}${diff.toLocaleString('ru')} шт</div></div>
      </div>
      ${a.colors.length && a.sizes.length ? `<div class="matrix-scroll" style="margin-top:12px"><table class="matrix-table">
        <thead><tr><th class="mx-corner">Размер \\ Цвет</th>${a.colors.map((c) => `<th class="mx-color">${swatchTag(a, c, 60, 30)}<div>${c}</div></th>`).join('')}<th class="mx-rowtot-h">Факт Σ</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th class="mx-size mx-vsego">ВСЕГО</th>${a.colors.map((c) => `<td class="num mx-coltot" data-fcoltot="${encodeURIComponent(c)}">${a.sizes.reduce((n, s) => n + cell(F, c, s), 0)}</td>`).join('')}<td class="num mx-grand" data-fgrand>${factTotal.toLocaleString('ru')}</td></tr></tfoot>
      </table></div>` : '<div class="mini">У артикула нет цветов/размеров.</div>'}
    </div>`;

  bindFilters();
  document.getElementById('fact-partia').addEventListener('change', (e) => { factPartiaId = e.target.value; renderFact(); });
  document.getElementById('fact-status').addEventListener('change', (e) => { p.status = e.target.value; dirty = true; renderFact(); });
  document.getElementById('fact-hist').addEventListener('change', (e) => { p.historical = e.target.checked; dirty = true; setStatus(); });
  document.getElementById('fact-copy').addEventListener('click', () => {
    p.factMatrix = JSON.parse(JSON.stringify(p.planMatrix || {}));
    dirty = true; renderFact(); toast('План скопирован в факт');
  });
  document.getElementById('fact-save').addEventListener('click', () => {
    recalc(true).then(() => { renderFact(); toast('Факт сохранён, логистика пересчитана'); }).catch((err) => toast('Ошибка: ' + err.message, true));
  });
  root.querySelectorAll('input[data-fact]').forEach((inp) => inp.addEventListener('input', (e) => {
    const c = decodeURIComponent(e.target.dataset.c), s = decodeURIComponent(e.target.dataset.s);
    const v = Math.max(0, Math.round(+e.target.value || 0));
    p.factMatrix[c] = p.factMatrix[c] || {}; p.factMatrix[c][s] = v;
    dirty = true; setStatus();
    root.querySelectorAll('[data-fcoltot]').forEach((el) => { const col = decodeURIComponent(el.dataset.fcoltot); el.textContent = a.sizes.reduce((n, sz) => n + cell(p.factMatrix, col, sz), 0); });
    root.querySelectorAll('[data-frowtot]').forEach((el) => { const sz = decodeURIComponent(el.dataset.frowtot); el.textContent = a.colors.reduce((n, col) => n + cell(p.factMatrix, col, sz), 0); });
    const ft = sumMatrix(p.factMatrix);
    const g = root.querySelector('[data-fgrand]'); if (g) g.textContent = ft.toLocaleString('ru');
    const d = root.querySelector('#fact-diff'); if (d) { const df = ft - sumMatrix(p.planMatrix); d.textContent = (df > 0 ? '+' : '') + df.toLocaleString('ru') + ' шт'; d.className = 'v ' + (df < 0 ? 'bad' : ''); }
  }));
  applyCollapsibles();
}

// ---------- сворачиваемые блоки (панели) ----------
const collapsed = new Set(); // ключи свёрнутых блоков (в рамках сессии)
function panelHead(panel) {
  return panel.querySelector(':scope > h3, :scope > .subhead');
}
function applyCollapsibles() {
  const view = document.querySelector('.view.active');
  if (!view) return;
  view.querySelectorAll('.panel').forEach((panel, idx) => {
    const head = panelHead(panel);
    if (!head) return; // блоки без заголовка не сворачиваем
    panel.classList.add('collapsible');
    const title = (head.querySelector('h3')?.textContent || head.textContent || '').trim().slice(0, 80);
    const key = `${activeTab}|${idx}|${title}`;
    panel.dataset.collapseKey = key;
    panel.classList.toggle('collapsed', collapsed.has(key));
  });
}
function initCollapsibles() {
  document.querySelector('main').addEventListener('click', (e) => {
    // не сворачивать при клике по интерактивным элементам
    if (e.target.closest('button, input, select, textarea, a, label')) return;
    const head = e.target.closest('.panel.collapsible > h3, .panel.collapsible > .subhead');
    if (!head) return;
    const panel = head.closest('.panel');
    const key = panel.dataset.collapseKey;
    const nowCollapsed = !panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed', nowCollapsed);
    if (key) { nowCollapsed ? collapsed.add(key) : collapsed.delete(key); }
  });
}

// ---------- образцы ткани (общий помощник) ----------
function fabricImgSrc(a, color) {
  return (a && a.fabricInfo && a.fabricInfo[color] && a.fabricInfo[color].image) || '';
}
function swatchTag(a, color, w = 80, h = 40) {
  const s = fabricImgSrc(a, color);
  return s ? `<img class="swatch" src="${s}" alt="" style="width:${w}px;height:${h}px">` : '';
}
// перенести данные цвета (количества во всех партиях + метаданные ткани) на новое имя
function renameColorKeys(a, oldName, newName) {
  if (oldName === newName) return;
  for (const p of (state.partias || []).filter((x) => x.articleId === a.id)) {
    for (const mx of [p.planMatrix, p.factMatrix]) {
      if (mx && Object.prototype.hasOwnProperty.call(mx, oldName)) { mx[newName] = mx[oldName]; delete mx[oldName]; }
    }
  }
  if (a.fabricInfo && Object.prototype.hasOwnProperty.call(a.fabricInfo, oldName)) {
    a.fabricInfo[newName] = a.fabricInfo[oldName]; delete a.fabricInfo[oldName];
  }
}

// ---------- ЗАКАЗ ТКАНИ (консолидированный по этапу) ----------
let fabricStageId = null;
function colorUnits(a, stageId, color) {
  const M = articleStageMatrix(a, stageId);
  const row = M[color] || {};
  let s = 0; for (const k in row) s += +row[k] || 0;
  return Math.round(s);
}
function renderFabricOrder() {
  const root = document.getElementById('fabric');
  if (!state.stages.length || !state.articles.length) {
    root.innerHTML = '<div class="panel"><div class="mini">Нет этапов или артикулов.</div></div>';
    return;
  }
  const sStages = seasonStages();
  if (!fabricStageId || !sStages.find((s) => s.id === fabricStageId)) fabricStageId = sStages[0]?.id;
  const stage = state.stages.find((s) => s.id === fabricStageId);
  if (!stage) { document.getElementById('fabric').innerHTML = '<div class="panel"><div class="mini">В выбранном сезоне нет этапов.</div></div>'; return; }
  const stageIdx = state.stages.findIndex((s) => s.id === stage.id) + 1;
  const wastage = +(state.settings.fabric.wastagePct) || 0;
  const meters = (units, perUnit) => Math.ceil(units * perUnit * (1 + wastage / 100));

  const cyc = (schedule?.cycles || []).filter((c) => c.stageId === stage.id);
  const earliest = cyc.map((c) => c.fabric.orderDate).sort()[0];

  const money = (v) => '$' + Math.round(v || 0).toLocaleString('ru');
  const arts = articlesSorted().filter((a) => articleStageTotal(a, stage.id) > 0);
  let grand = 0, grandCost = 0;
  const consolidated = {}; // планшет/№цвета -> { meters, image, cost }

  const sections = arts.map((a) => {
    a.fabricInfo = a.fabricInfo || {};
    const price = +a.fabricPricePerMeter || 0;
    let sub = 0, subCost = 0;
    const rows = a.colors.map((c) => {
      const u = colorUnits(a, stage.id, c);
      if (u <= 0) return '';
      const info = (a.fabricInfo[c] = a.fabricInfo[c] || {});
      const m = meters(u, a.fabricPerUnit); sub += m; grand += m;
      const cost = m * price; subCost += cost; grandCost += cost;
      const key = (info.plansheet || info.colorNo) ? `${info.plansheet || '—'} / цвет ${info.colorNo || '—'}` : `${a.id} · ${c}`;
      if (!consolidated[key]) consolidated[key] = { meters: 0, image: info.image || '', cost: 0 };
      consolidated[key].meters += m; consolidated[key].cost += cost;
      if (!consolidated[key].image && info.image) consolidated[key].image = info.image;
      return `<tr>
        <td>${c}</td>
        <td>${info.plansheet ? info.plansheet : '<span class="mini">—</span>'}</td>
        <td>${info.image ? `<img class="fab-thumb" src="${info.image}" alt="">` : '<span class="mini">—</span>'}</td>
        <td>${info.colorNo ? info.colorNo : '<span class="mini">—</span>'}</td>
        <td class="num">${u.toLocaleString('ru')}</td>
        <td class="num">${m.toLocaleString('ru')}</td>
        <td class="num">${price ? money(cost) : '<span class="mini">—</span>'}</td>
      </tr>`;
    }).join('');
    return `<div class="panel">
      <div class="subhead"><h3>${a.id} — ${a.name}</h3>
        <span class="mini">расход ${a.fabricPerUnit} м/шт · цена ${price ? '$' + price + '/м' : '— (задай в «Данные»)'}</span></div>
      <table><thead><tr><th>Цвет</th><th>Планшет поставщика</th><th>Образец</th><th>№ цвета</th><th class="num">Штук</th><th class="num">Метраж</th><th class="num">Стоимость</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th colspan="5">Итого по артикулу</th><th class="num">${sub.toLocaleString('ru')} м</th><th class="num">${price ? money(subCost) : '—'}</th></tr></tfoot></table>
    </div>`;
  }).join('');

  const consRows = Object.entries(consolidated).sort((a, b) => b[1].meters - a[1].meters)
    .map(([k, v]) => `<tr><td>${v.image ? `<img class="fab-thumb" src="${v.image}" alt="">` : ''}</td><td>${k}</td><td class="num">${v.meters.toLocaleString('ru')} м</td><td class="num">${v.cost ? money(v.cost) : '<span class="mini">—</span>'}</td></tr>`).join('');

  root.innerHTML = `
    <div class="panel">
      <div class="matrix-controls">
        <label>Партия:
          <select id="fab-stage">${seasonStages().map((s) => `<option value="${s.id}"${s.id === stage.id ? ' selected' : ''}>Этап ${state.stages.findIndex((x) => x.id === s.id) + 1}${s.salesMonths ? ' · ' + s.salesMonths : ''}</option>`).join('')}</select>
        </label>
        <span class="mini">Консолидированный заказ на партию, запас +${wastage}%. Образец, № планшета, № цвета и цена ткани берутся из «Данных».</span>
      </div>
      <div class="fab-summary">
        <div><div class="k">Разместить заказ</div><div class="v">${earliest ? fmt(earliest) : '—'}</div><div class="mini">самая ранняя дата из артикулов этапа${earliest ? '' : ' (нажми «Пересчитать»)'}</div></div>
        <div><div class="k">Итого ткани на партию</div><div class="v good">${grand.toLocaleString('ru')} м</div></div>
        <div><div class="k">Стоимость ткани на партию</div><div class="v good">${money(grandCost)}</div></div>
      </div>
    </div>
    ${sections || '<div class="panel"><div class="mini">На эту партию нет плана.</div></div>'}
    ${consRows ? `<div class="panel"><h3>Консолидировано к заказу (по планшету/цвету)</h3>
      <table><thead><tr><th>Образец</th><th>Планшет / цвет</th><th class="num">Метраж</th><th class="num">Стоимость</th></tr></thead>
      <tbody>${consRows}</tbody>
      <tfoot><tr><th colspan="2">ВСЕГО</th><th class="num">${grand.toLocaleString('ru')} м</th><th class="num">${money(grandCost)}</th></tr></tfoot></table>
      <div class="mini" style="margin-top:8px">Строки с общим планшетом и номером цвета суммируются в одну позицию заказа. Форму заказа доработаем позже.</div></div>` : ''}
  `;

  document.getElementById('fab-stage').addEventListener('change', (e) => { fabricStageId = e.target.value; renderFabricOrder(); });
  applyCollapsibles();
}

// ---------- ПЛАН ПРОДАЖ (сводка с выбором артикулов/этапов/цехов) ----------
let spStages = null, spArticles = null, spWorkshops = null; // выбранные (Set id); null = все

function renderSalesPlan() {
  const root = document.getElementById('salesplan');
  if (!state.articles.length || !state.stages.length) {
    root.innerHTML = '<div class="panel"><div class="mini">Нет артикулов или этапов. Заполни во вкладке «Данные».</div></div>';
    return;
  }
  if (!spStages) spStages = new Set(state.stages.map((s) => s.id));
  if (!spArticles) spArticles = new Set(state.articles.map((a) => a.id));
  if (!spWorkshops) spWorkshops = new Set(state.workshops.map((w) => w.id));
  // подчистить от удалённых
  spStages = new Set([...spStages].filter((id) => state.stages.some((s) => s.id === id)));
  spArticles = new Set([...spArticles].filter((id) => state.articles.some((a) => a.id === id)));
  spWorkshops = new Set([...spWorkshops].filter((id) => state.workshops.some((w) => w.id === id)));

  const stageIndex = Object.fromEntries(state.stages.map((s, i) => [s.id, i + 1]));
  const stages = seasonStages().filter((s) => spStages.has(s.id));
  const arts = state.articles.filter((a) => spArticles.has(a.id));

  // какие цеха отшивают каждый артикул на каждом этапе — из расписания
  const cycleMap = {};
  for (const c of (schedule?.cycles || [])) (cycleMap[c.articleId + '|' + c.stageId] ||= []).push(c);

  const filtersHtml = `
    <div class="panel">
      <div class="subhead"><h3>План продаж — детально по партиям и артикулам</h3><span class="mini">выбери партии, артикулы и цеха для просмотра</span></div>
      <div class="sp-filters">
        <div class="sp-group">
          <div class="sp-title">Этапы <button class="sp-all" data-all="stages">все</button> <button class="sp-all" data-none="stages">снять</button></div>
          <div class="sp-chips">${seasonStages().map((s) => `<label class="sp-chip${spStages.has(s.id) ? ' on' : ''}"><input type="checkbox" data-sp-stage="${s.id}"${spStages.has(s.id) ? ' checked' : ''}> Этап ${stageIndex[s.id]}${s.salesMonths ? ' · ' + s.salesMonths : ''}</label>`).join('')}</div>
        </div>
        <div class="sp-group">
          <div class="sp-title">Артикулы <button class="sp-all" data-all="articles">все</button> <button class="sp-all" data-none="articles">снять</button></div>
          <div class="sp-chips">${state.articles.map((a) => `<label class="sp-chip${spArticles.has(a.id) ? ' on' : ''}"><input type="checkbox" data-sp-article="${a.id}"${spArticles.has(a.id) ? ' checked' : ''}> ${a.id}</label>`).join('')}</div>
        </div>
        <div class="sp-group">
          <div class="sp-title">Цеха <button class="sp-all" data-all="ws">все</button> <button class="sp-all" data-none="ws">снять</button></div>
          <div class="sp-chips">${state.workshops.map((w) => `<label class="sp-chip${spWorkshops.has(w.id) ? ' on' : ''}"><input type="checkbox" data-sp-ws="${w.id}"${spWorkshops.has(w.id) ? ' checked' : ''}> ${w.name}${w.role === 'aux' ? ' (вспом.)' : ''}</label>`).join('')}</div>
        </div>
      </div>
    </div>`;

  // циклы по партии
  const cycByPartia = {};
  for (const c of (schedule?.cycles || [])) (cycByPartia[c.partiaId] ||= []).push(c);

  let body = '';
  if (!stages.length || !arts.length) {
    body = '<div class="panel"><div class="mini">Выбери хотя бы одну партию и один артикул.</div></div>';
  } else {
    for (const s of stages) {
      const cards = [];
      for (const a of arts) {
        for (const p of partiasOf(a.id, s.id)) {
          const cyc = cycByPartia[p.id] || [];
          // фильтр по цехам: если у партии есть назначенные цеха, но ни один не выбран — скрыть
          if (cyc.length && !cyc.some((c) => spWorkshops.has(c.workshopId))) continue;
          const card = spMiniTable(p, a, cyc);
          if (card) cards.push(card);
        }
      }
      body += `<div class="panel">
        <h3 class="sp-partia">Этап ${stageIndex[s.id]} · ${s.name}${s.salesMonths ? ' · ' + s.salesMonths : ''}</h3>
        ${cards.length ? `<div class="mini-grid">${cards.join('')}</div>` : '<div class="mini">По выбранным артикулам и цехам нет плана на этот этап.</div>'}
      </div>`;
    }
  }
  root.innerHTML = filtersHtml + body;

  root.querySelectorAll('input[data-sp-stage]').forEach((inp) => inp.addEventListener('change', (e) => {
    const id = e.target.dataset.spStage; e.target.checked ? spStages.add(id) : spStages.delete(id); renderSalesPlan();
  }));
  root.querySelectorAll('input[data-sp-article]').forEach((inp) => inp.addEventListener('change', (e) => {
    const id = e.target.dataset.spArticle; e.target.checked ? spArticles.add(id) : spArticles.delete(id); renderSalesPlan();
  }));
  root.querySelectorAll('input[data-sp-ws]').forEach((inp) => inp.addEventListener('change', (e) => {
    const id = e.target.dataset.spWs; e.target.checked ? spWorkshops.add(id) : spWorkshops.delete(id); renderSalesPlan();
  }));
  root.querySelectorAll('.sp-all').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.all === 'stages') spStages = new Set(state.stages.map((s) => s.id));
    else if (b.dataset.none === 'stages') spStages = new Set();
    else if (b.dataset.all === 'articles') spArticles = new Set(state.articles.map((a) => a.id));
    else if (b.dataset.none === 'articles') spArticles = new Set();
    else if (b.dataset.all === 'ws') spWorkshops = new Set(state.workshops.map((w) => w.id));
    else if (b.dataset.none === 'ws') spWorkshops = new Set();
    renderSalesPlan();
  }));
  applyCollapsibles();
}

// ---------- матрица размер×цвет ----------
function sumMatrix(M) { let s = 0; for (const c in M) { const r = M[c] || {}; for (const k in r) s += +r[k] || 0; } return Math.round(s); }
function cell(M, c, s) { return +((M[c] || {})[s]) || 0; }

// ---- партии (клиент) ----
const PARTIA_STATUS_RU = { plan: 'план', cutting: 'крой', sewing: 'пошив', done: 'готово', shipped: 'отгружено' };
const PARTIA_STATUS_LIST = ['plan', 'cutting', 'sewing', 'done', 'shipped'];
function partiasOf(articleId, stageId) {
  return (state.partias || []).filter((p) => p.articleId === articleId && p.stageId === stageId).sort((a, b) => a.no - b.no);
}
function partiaPlanUnits(p) { return sumMatrix(p.planMatrix); }
function partiaFactUnits(p) { return sumMatrix(p.factMatrix); }
function partiaEffMatrix(p) { return partiaFactUnits(p) > 0 ? p.factMatrix : (p.planMatrix || {}); }
// суммарный план артикула на этапе (по всем его партиям)
function articleStageTotal(a, stageId) {
  return partiasOf(a.id, stageId).reduce((s, p) => s + partiaPlanUnits(p), 0);
}
// агрегированная план-матрица артикул+этап (сумма по партиям) — для листов, где нужен свод
function articleStageMatrix(a, stageId) {
  const out = {};
  for (const p of partiasOf(a.id, stageId)) {
    const M = p.planMatrix || {};
    for (const c in M) { out[c] = out[c] || {}; for (const s in M[c]) out[c][s] = (out[c][s] || 0) + (+M[c][s] || 0); }
  }
  return out;
}
function genPartiaIdClient() { return 'p_' + Math.random().toString(36).slice(2, 9); }
function newPartia(articleId, stageId, workshopId = '') {
  return { id: genPartiaIdClient(), no: 0, articleId, stageId, workshopId, planMatrix: {}, factMatrix: {}, status: 'plan', historical: false };
}
// нумерация партий: у каждого цеха своя (1,2,3…); авто-партии — отдельная группа
function recomputePartiaNumbers() {
  const parts = state.partias || [];
  const stageOrder = {}; state.stages.forEach((st, i) => { stageOrder[st.id] = i; });
  const indexed = parts.map((p, idx) => ({ p, idx }));
  indexed.sort((A, B) => (stageOrder[A.p.stageId] ?? 99) - (stageOrder[B.p.stageId] ?? 99) || A.idx - B.idx);
  const counters = {};
  for (const { p } of indexed) { const k = p.workshopId || '__auto__'; counters[k] = (counters[k] || 0) + 1; p.no = counters[k]; }
}

let matrixStageId = null, matrixArticleId = null, matrixPartiaId = null;

function renderMatrix() {
  const root = document.getElementById('matrix');
  if (!state.articles.length) { root.innerHTML = '<div class="panel"><div class="mini">Нет артикулов. Добавь их во вкладке «Данные».</div></div>'; return; }
  if (!matrixArticleId || !state.articles.find((a) => a.id === matrixArticleId)) matrixArticleId = state.articles[0].id;
  const sStages = seasonStages();
  if (!matrixStageId || !sStages.find((s) => s.id === matrixStageId)) matrixStageId = sStages[0]?.id;

  const a = state.articles.find((x) => x.id === matrixArticleId);
  const stage = state.stages.find((s) => s.id === matrixStageId);
  if (!stage) { root.innerHTML = '<div class="panel"><div class="mini">В выбранном сезоне нет этапов.</div></div>'; return; }
  const stIdx = state.stages.findIndex((s) => s.id === stage.id) + 1;
  const parts = partiasOf(a.id, stage.id);
  // выбранная партия
  let p = parts.find((x) => x.id === matrixPartiaId);
  if (!p) { p = parts[0] || null; matrixPartiaId = p ? p.id : null; }

  const controls = `
    <div class="matrix-controls">
      <label>Этап (период):
        <select id="mx-stage">${sStages.map((s) => `<option value="${s.id}"${s.id === stage.id ? ' selected' : ''}>Этап ${state.stages.findIndex((z) => z.id === s.id) + 1}${s.salesMonths ? ' · ' + s.salesMonths : ''}</option>`).join('')}</select>
      </label>
      <label>Артикул:
        <select id="mx-article">${articlesSorted().map((x) => `<option value="${x.id}"${x.id === a.id ? ' selected' : ''}>${x.id} — ${x.name}</option>`).join('')}</select>
      </label>
      <label>Партия:
        <select id="mx-partia">${parts.map((x) => `<option value="${x.id}"${p && x.id === p.id ? ' selected' : ''}>Партия ${x.no}${x.workshopId ? ' · ' + (state.workshops.find((w) => w.id === x.workshopId)?.name || '') : ' · авто'} · ${partiaPlanUnits(x)} шт</option>`).join('') || '<option>нет партий</option>'}</select>
      </label>
      <button id="mx-add-partia" class="btn">＋ партия</button>
    </div>`;

  if (!p) {
    root.innerHTML = `<div class="panel">${controls}
      <div class="mini" style="margin:10px 0">На этот артикул и этап партий пока нет. Нажми <b>«＋ партия»</b>, чтобы создать план-заявку.</div></div>`;
    bindMatrixControls(a, stage);
    document.getElementById('mx-add-partia').addEventListener('click', () => addPartia(a, stage));
    applyCollapsibles();
    return;
  }

  const M = (p.planMatrix = p.planMatrix || {});
  for (const c of a.colors) { M[c] = M[c] || {}; for (const s of a.sizes) if (M[c][s] == null) M[c][s] = 0; }
  const hasGrid = a.colors.length && a.sizes.length;
  const cyc = (schedule?.cycles || []).filter((c) => c.partiaId === p.id);
  const cycInfo = cyc.length ? cyc.map((c) => `${c.workshopName} — ${c.units.toLocaleString('ru')} шт`).join(' · ') : 'не назначено (сохрани и пересчитай)';

  root.innerHTML = `
    <div class="panel">
      ${controls}
      <div class="partia-bar">
        <span class="partia-badge">Партия ${p.no}${p.workshopId ? '' : ' (авто)'}</span>
        <label>Цех:
          <select id="mx-ws"><option value="">Авто (распределит система)</option>
            ${state.workshops.map((w) => `<option value="${w.id}"${w.id === p.workshopId ? ' selected' : ''}>${w.name}${w.role === 'aux' ? ' (вспом.)' : ''}</option>`).join('')}
          </select>
        </label>
        <button id="mx-del-partia" class="btn btn-danger">Удалить партию</button>
        <button id="mx-save" class="btn btn-primary">Сохранить план</button>
      </div>
      <div class="mini" style="margin-bottom:12px">Введи количества и нажми <b>«Сохранить план»</b>. Номер партии — свой у каждого цеха. Статус производства и факт — на вкладке «Факт». Сейчас отшивает: <b>${cycInfo}</b>.</div>
      ${hasGrid ? matrixTable(a, M) : '<div class="mini">У артикула не заданы цвета или размерный ряд — добавь их во вкладке «Данные».</div>'}
    </div>`;

  bindMatrixControls(a, stage);
  document.getElementById('mx-partia').addEventListener('change', (e) => { matrixPartiaId = e.target.value; renderMatrix(); });
  document.getElementById('mx-add-partia').addEventListener('click', () => addPartia(a, stage));
  document.getElementById('mx-ws').addEventListener('change', (e) => { p.workshopId = e.target.value; recomputePartiaNumbers(); dirty = true; renderMatrix(); });
  document.getElementById('mx-del-partia').addEventListener('click', () => {
    if (!confirm(`Удалить Партию ${p.no}?`)) return;
    state.partias = state.partias.filter((x) => x.id !== p.id);
    matrixPartiaId = null; dirty = true; renderMatrix();
  });
  document.getElementById('mx-save').addEventListener('click', () => {
    recalc(true).then(() => { renderMatrix(); toast('План сохранён и пересчитан'); }).catch((err) => toast('Ошибка: ' + err.message, true));
  });
  root.querySelectorAll('input[data-mx]').forEach((inp) => inp.addEventListener('input', onMatrixInput));
  applyCollapsibles();
}

function bindMatrixControls(a, stage) {
  document.getElementById('mx-stage').addEventListener('change', (e) => { matrixStageId = e.target.value; matrixPartiaId = null; renderMatrix(); });
  document.getElementById('mx-article').addEventListener('change', (e) => { matrixArticleId = e.target.value; matrixPartiaId = null; renderMatrix(); });
}
function addPartia(a, stage) {
  const parts = partiasOf(a.id, stage.id);
  const np = newPartia(a.id, stage.id);
  state.partias.push(np);
  matrixPartiaId = np.id; dirty = true; renderMatrix();
  toast(`Создана Партия ${np.no}`);
}

// строка с цехом(ами), отшивающими артикул на данном этапе
function workshopLine(cycles) {
  if (!cycles || !cycles.length) return '<div class="mini-ws none">🏭 Цех не назначен — нажми «Пересчитать»</div>';
  if (cycles.length === 1) {
    const c = cycles[0];
    return `<div class="mini-ws">🏭 Цех: <b>${c.workshopName}</b> — ${c.units.toLocaleString('ru')} шт${c.workshopRole === 'aux' ? ' <span class="mini">(вспом.)</span>' : ''}</div>`;
  }
  const ordered = [...cycles].sort((x, y) => (y.primary === true) - (x.primary === true) || y.units - x.units);
  return `<div class="mini-ws split">🏭 Дробление между цехами:<br>${ordered.map((c) => `<b>${c.workshopName}</b> — ${c.units.toLocaleString('ru')} шт${c.primary ? '' : ' <span class="mini">(доп.)</span>'}`).join(' · ')}</div>`;
}

// мини-таблица (только чтение) для одной ПАРТИИ
function spMiniTable(partia, a, cycles) {
  if (!a.colors.length || !a.sizes.length) return '';
  const M = partia.planMatrix || {};
  const total = sumMatrix(M);
  if (total <= 0) return '';
  return `<div class="mini-card${cycles && cycles.length > 1 ? ' mini-split' : ''}${['done', 'shipped'].includes(partia.status) ? ' mini-done' : ''}">
    <div class="mini-head"><span class="partia-badge">Партия ${partia.no}</span> <b>${a.id}</b> — ${a.name} ${statusBadge(partia.status)}</div>
    ${a.comment ? `<div class="mini-comment">💬 ${a.comment}</div>` : ''}
    ${workshopLine(cycles)}
    <div class="matrix-scroll"><table class="matrix-table mini">
      <thead><tr><th class="mx-corner">Размер</th>${a.colors.map((c) => `<th class="mx-color">${swatchTag(a, c, 60, 30)}<div>${c}</div></th>`).join('')}<th class="mx-rowtot-h">Σ</th></tr></thead>
      <tbody>${a.sizes.map((s) => `<tr><th class="mx-size">${s}</th>${a.colors.map((c) => { const v = cell(M, c, s); return `<td class="num">${v || '<span class="mini">·</span>'}</td>`; }).join('')}<td class="num mx-rowtot">${a.colors.reduce((n, c) => n + cell(M, c, s), 0)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th class="mx-vsego">ВСЕГО</th>${a.colors.map((c) => `<td class="num mx-coltot">${a.sizes.reduce((n, s) => n + cell(M, c, s), 0)}</td>`).join('')}<td class="num mx-grand">${total.toLocaleString('ru')}</td></tr></tfoot>
    </table></div>
  </div>`;
}
function statusBadge(status) {
  const cls = { plan: 'st-plan', cutting: 'st-prog', sewing: 'st-prog', done: 'st-done', shipped: 'st-ship' }[status] || 'st-plan';
  return `<span class="st-badge ${cls}">${PARTIA_STATUS_RU[status] || status}</span>`;
}

function matrixTable(a, M) {
  return `
  <div class="matrix-scroll">
  <table class="matrix-table">
    <thead>
      <tr><th class="mx-corner">Размер \\ Цвет</th>
        ${a.colors.map((c) => `<th class="mx-color">${swatchTag(a, c, 72, 34)}<div>${c}</div></th>`).join('')}
        <th class="mx-rowtot-h">Итого по размеру</th></tr>
    </thead>
    <tbody>
      ${a.sizes.map((s) => `<tr>
        <th class="mx-size">${s}</th>
        ${a.colors.map((c) => `<td><input data-mx data-c="${encodeURIComponent(c)}" data-s="${encodeURIComponent(s)}" type="number" min="0" value="${cell(M, c, s)}"></td>`).join('')}
        <td class="num mx-rowtot" data-rowtot="${encodeURIComponent(s)}">${a.colors.reduce((n, c) => n + cell(M, c, s), 0)}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot>
      <tr><th class="mx-size mx-vsego">ВСЕГО</th>
        ${a.colors.map((c) => `<td class="num mx-coltot" data-coltot="${encodeURIComponent(c)}">${a.sizes.reduce((n, s) => n + cell(M, c, s), 0)}</td>`).join('')}
        <td class="num mx-grand" data-grand>${sumMatrix(M)}</td>
      </tr>
    </tfoot>
  </table>
  </div>`;
}

function onMatrixInput(e) {
  const a = state.articles.find((x) => x.id === matrixArticleId);
  const p = (state.partias || []).find((x) => x.id === matrixPartiaId);
  if (!p) return;
  const c = decodeURIComponent(e.target.dataset.c);
  const s = decodeURIComponent(e.target.dataset.s);
  const v = Math.max(0, Math.round(+e.target.value || 0));
  p.planMatrix = p.planMatrix || {};
  p.planMatrix[c] = p.planMatrix[c] || {};
  p.planMatrix[c][s] = v;
  dirty = true; setStatus();

  const M = p.planMatrix;
  const root = document.getElementById('matrix');
  root.querySelectorAll('[data-coltot]').forEach((el) => { const col = decodeURIComponent(el.dataset.coltot); el.textContent = a.sizes.reduce((n, sz) => n + cell(M, col, sz), 0); });
  root.querySelectorAll('[data-rowtot]').forEach((el) => { const sz = decodeURIComponent(el.dataset.rowtot); el.textContent = a.colors.reduce((n, col) => n + cell(M, col, sz), 0); });
  const g = root.querySelector('[data-grand]'); if (g) g.textContent = sumMatrix(M);
}

async function onOverride(cycleId, cutStart) {
  try {
    const r = await api('/api/override', { method: 'POST', body: JSON.stringify({ cycleId, cutStart, clear: cutStart === null }) });
    state = r.state; schedule = r.schedule;
    renderCurrent(); setStatus();
    toast(cutStart === null ? 'Ручной сдвиг сброшен' : 'Сдвиг сохранён, план пересчитан');
  } catch (e) { toast('Ошибка: ' + e.message, true); }
}

// ---------- ДАШБОРД ----------
function renderDashboard() {
  const root = document.getElementById('dashboard');
  const cy = schedule.cycles;
  const totalUnits = cy.reduce((s, c) => s + c.units, 0);
  const errs = schedule.warnings.filter((w) => w.level === 'error');
  const warns = schedule.warnings.filter((w) => w.level === 'warn');
  const totalMeters = (schedule.fabricOrders || []).reduce((s, o) => s + o.totalMeters, 0);

  // загрузка цехов (сумма дней пошива / доступные дни в месяцах этапов)
  const wsLoad = workshopLoad();

  root.innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Артикулов</div><div class="v">${state.articles.length}</div></div>
      <div class="card"><div class="k">Цехов</div><div class="v">${state.workshops.length}</div></div>
      <div class="card"><div class="k">Циклов производства</div><div class="v">${cy.length}</div></div>
      <div class="card"><div class="k">Всего к пошиву</div><div class="v">${totalUnits.toLocaleString('ru')} шт</div></div>
      <div class="card"><div class="k">Ткань (заказ)</div><div class="v">${totalMeters.toLocaleString('ru')} м</div></div>
      <div class="card"><div class="k">Срывы сроков</div><div class="v ${errs.length ? 'bad' : 'good'}">${errs.length}</div></div>
    </div>

    ${warns.length || errs.length ? `<div class="panel"><h3>Риски и предупреждения</h3>
      ${[...errs, ...warns].map((w) => `<div class="warn-item ${w.level}">${w.level === 'error' ? '⛔' : '⚠️'} ${w.message}</div>`).join('')}
    </div>` : '<div class="panel"><h3>Риски</h3><div class="mini">Срывов и предупреждений нет ✓</div></div>'}

    <div class="panel"><h3>Загрузка цехов</h3>
      <table><thead><tr><th>Цех</th><th>Роль</th><th class="num">Пошив, шт/дн</th><th class="num">Занято дней</th><th class="num">Циклов</th><th style="width:220px">Загрузка</th></tr></thead>
      <tbody>${wsLoad.map((r) => `<tr>
        <td>${r.name}</td>
        <td><span class="badge ${r.role}">${r.role === 'main' ? 'основной' : 'вспом.'}</span></td>
        <td class="num">${r.sew}</td>
        <td class="num">${r.busyDays} / ${r.availDays}</td>
        <td class="num">${r.cycles}</td>
        <td><div class="load-bar"><span class="${r.pct > 100 ? 'over' : ''}" style="width:${Math.min(100, r.pct)}%"></span></div><span class="mini">${r.pct}%</span></td>
      </tr>`).join('')}</tbody></table>
    </div>

    <div class="panel"><h3>Артикулы и этапы (готовность / приход на WB)</h3>
      <table><thead><tr><th>Артикул</th><th>Цвета</th>${seasonStages().map((s) => `<th>${s.name}<div class="mini">${s.salesMonths}</div></th>`).join('')}</tr></thead>
      <tbody>${state.articles.map((a) => `<tr>
        <td><b>${a.id}</b><div class="mini">${a.name}</div></td>
        <td class="mini">${(a.colors || []).length} цв.</td>
        ${seasonStages().map((s) => articleStageCell(a, s)).join('')}
      </tr>`).join('')}</tbody></table>
    </div>

    <div class="panel"><h3>Вехи по циклам</h3>
      <table><thead><tr><th>Этап</th><th>Артикул</th><th>Цех</th><th class="num">Шт</th>
        <th>Заказ ткани</th><th>Ткань в цех</th><th>Крой</th><th>Пошив</th><th>Готово</th><th>Отгрузка</th><th>WB</th></tr></thead>
      <tbody>${cy.map((c) => `<tr>
        <td>${c.stageName}</td>
        <td><b>${c.articleId}</b> ${c.split ? '<span class="badge split">⚡</span>' : ''}</td>
        <td>${c.workshopName}</td>
        <td class="num">${c.units}</td>
        <td>${fmt(c.fabric.orderDate)}</td><td>${fmt(c.fabric.atWorkshop)}</td>
        <td>${fmt(c.ops.cut.start)}</td><td>${fmt(c.ops.sew.start)}</td><td>${fmt(c.readyDate)}</td>
        <td>${fmt(c.logistics.shipment)}</td>
        <td>${c.logistics.lateDays > 0 ? `<span class="badge late">${fmt(c.logistics.wbArrival)}</span>` : fmt(c.logistics.wbArrival)}</td>
      </tr>`).join('')}</tbody></table>
    </div>

    <div class="panel"><h3>Заказ ткани (запас на ${state.settings.fabric.safetyStages} этапа, лид-тайм ${state.settings.fabric.leadTimeDays} дн)</h3>
      <table><thead><tr><th>Артикул</th><th class="num">Всего метров</th><th>Первый заказ</th><th>Разбивка по этапам</th></tr></thead>
      <tbody>${(schedule.fabricOrders || []).map((o) => `<tr>
        <td><b>${o.articleId}</b></td>
        <td class="num">${o.totalMeters.toLocaleString('ru')}</td>
        <td>${fmt(o.firstOrderDate)}</td>
        <td class="mini">${o.byStage.map((b) => `${b.stageId}: ${b.meters}м (заказ ${fmt(b.orderDate)})`).join(' · ')}</td>
      </tr>`).join('')}</tbody></table>
    </div>
  `;
}

function articleStageCell(a, s) {
  const units = articleStageTotal(a, s.id);
  if (!units) return '<td class="mini">—</td>';
  const cs = schedule.cycles.filter((c) => c.articleId === a.id && c.stageId === s.id);
  const ready = cs.map((c) => c.readyDate).sort().pop();
  const late = cs.some((c) => c.logistics.lateDays > 0);
  const split = cs.length > 1;
  return `<td><b>${units}</b> шт${split ? ' <span class="badge split">⚡</span>' : ''}
    <div class="mini">готов ${fmt(ready)}${late ? ' <span style="color:var(--danger)">⛔</span>' : ''}</div></td>`;
}

function workshopLoad() {
  // доступные дни: сумма рабочих дней месяцев этапов, где цех участвует
  const rows = [];
  for (const w of state.workshops) {
    const cs = schedule.cycles.filter((c) => c.workshopId === w.id);
    // занятые дни пошива ≈ сумма ceil(units/sew)
    const busyDays = cs.reduce((s, c) => s + Math.ceil(c.units / w.capacities.sew), 0);
    const stagesUsed = new Set(cs.map((c) => c.stageId));
    const availDays = [...stagesUsed].reduce((s, sid) => {
      const st = state.stages.find((x) => x.id === sid);
      return s + workingDaysInMonth(st?.productionMonth);
    }, 0) || workingDaysInMonth(state.stages[0]?.productionMonth) * Math.max(1, stagesUsed.size);
    rows.push({
      name: w.name, role: w.role, sew: w.capacities.sew,
      busyDays, availDays, cycles: cs.length,
      pct: availDays ? Math.round((busyDays / availDays) * 100) : 0,
    });
  }
  return rows;
}
function workingDaysInMonth(ym) {
  if (!ym) return 26;
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let c = 0;
  for (let d = 1; d <= last; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 0) c++;
  return c;
}

// ---------- ДАННЫЕ (формы) ----------
function renderData() {
  const root = document.getElementById('data-forms');
  root.innerHTML = `
    <div class="panel"><div class="mini">Ввод количеств по размерам — вкладка «План по размерам». Сводка плана — вкладка «План продаж».</div></div>
    ${dataArticlesPanel()}
    ${dataWorkshopsPanel()}
    ${dataSeasonsPanel()}
    ${dataStagesPanel()}
    ${dataSettingsPanel()}
    <div class="panel"><button class="btn btn-danger" id="btn-reset">Сбросить к примеру</button></div>
  `;
  bindDataEvents();
  applyCollapsibles();
}

function dataArticlesPanel() {
  return `<div class="panel"><div class="subhead"><h3>Артикулы</h3><button class="btn" id="btn-add-article">+ Артикул</button></div>
    <div class="form-grid">${state.articles.map((a, i) => `
      <div class="card">
        <div class="row-flex">
          <div class="field"><label>Артикул</label><input data-art="${i}" data-f="id" value="${a.id}"></div>
          <div class="field" style="flex:2"><label>Название</label><input data-art="${i}" data-f="name" value="${a.name}"></div>
        </div>
        <div class="field"><label>Комментарий (кратко об особенностях)</label><input data-art="${i}" data-f="comment" value="${(a.comment || '').replace(/"/g, '&quot;')}" placeholder="напр.: твид, приталенная, отложной воротник"></div>
        <div class="row-flex">
          <div class="field"><label>Расход ткани, м/шт</label><input data-art="${i}" data-f="fabricPerUnit" value="${a.fabricPerUnit}" style="width:90px"></div>
          <div class="field"><label>Цена ткани, $/м</label><input data-art="${i}" data-f="fabricPricePerMeter" value="${a.fabricPricePerMeter || 0}" style="width:90px"></div>
        </div>
        <div class="field"><label>Размерный ряд (через запятую)</label><input data-art="${i}" data-f="sizes" value="${(a.sizes || []).join(', ')}"></div>
        <div class="field"><label>Цвета и образцы ткани (название · образец 80×40 · № планшета · № цвета)</label>
          <div class="swatch-row">${(a.colors || []).map((c, ci) => { const fi = (a.fabricInfo && a.fabricInfo[c]) || {}; return `<div class="swatch-item">
            ${fabricImgSrc(a, c) ? `<img class="swatch" src="${fabricImgSrc(a, c)}" alt="">` : '<div class="swatch swatch-empty">нет образца</div>'}
            <input class="swatch-name-input" data-colorname data-art="${i}" data-idx="${ci}" value="${String(c).replace(/"/g, '&quot;')}" placeholder="цвет" title="переименование сохранит количества и образец">
            <input class="swatch-meta" data-fabmeta data-art="${i}" data-color="${encodeURIComponent(c)}" data-f="plansheet" value="${(fi.plansheet || '').replace(/"/g, '&quot;')}" placeholder="№ планшета">
            <input class="swatch-meta" data-fabmeta data-art="${i}" data-color="${encodeURIComponent(c)}" data-f="colorNo" value="${(fi.colorNo || '').replace(/"/g, '&quot;')}" placeholder="№ цвета">
            <div class="swatch-actions">
              <label class="fab-up">${fabricImgSrc(a, c) ? 'заменить' : '＋ образец'}<input type="file" accept="image/*" data-artimg data-art="${i}" data-color="${encodeURIComponent(c)}" hidden></label>
              <button class="swatch-del" data-color-del data-art="${i}" data-idx="${ci}" title="удалить цвет">✕</button>
            </div>
          </div>`; }).join('') || '<span class="mini">Цветов пока нет.</span>'}
          <button class="btn swatch-add" data-color-add="${i}">＋ цвет</button></div>
        </div>
        <button class="btn btn-danger" data-del-art="${i}">Удалить</button>
      </div>`).join('')}</div></div>`;
}

function dataWorkshopsPanel() {
  return `<div class="panel"><div class="subhead"><h3>Цеха</h3><button class="btn" id="btn-add-ws">+ Цех</button></div>
    <table><thead><tr>
      <th>Название</th><th>Роль</th>
      <th class="num">Крой</th><th class="num">Пошив</th><th class="num">Утюжка</th><th class="num">ОТК</th>
      <th class="num" title="На сколько раб. дней старт пошива смещён относительно старта кроя">Сдвиг пошива</th>
      <th class="num" title="На сколько раб. дней старт утюжки смещён относительно старта пошива">Сдвиг утюжки</th>
      <th class="num" title="На сколько раб. дней старт ОТК смещён относительно старта утюжки">Сдвиг ОТК</th>
      <th></th></tr></thead>
    <tbody>${state.workshops.map((w, i) => `<tr>
      <td><input data-ws="${i}" data-f="name" value="${w.name}" style="width:110px"></td>
      <td><select data-ws="${i}" data-f="role"><option value="main"${w.role === 'main' ? ' selected' : ''}>основной</option><option value="aux"${w.role === 'aux' ? ' selected' : ''}>вспомог.</option></select></td>
      ${['cut', 'sew', 'iron', 'otk'].map((k) => `<td class="num"><input data-ws="${i}" data-cap="${k}" value="${w.capacities[k]}" style="width:66px;text-align:right"></td>`).join('')}
      ${['sew', 'iron', 'otk'].map((k) => `<td class="num"><input data-ws="${i}" data-off="${k}" value="${(w.flowOffsets && w.flowOffsets[k] != null) ? w.flowOffsets[k] : ''}" placeholder="авто" style="width:62px;text-align:right"></td>`).join('')}
      <td><button class="btn btn-danger" data-del-ws="${i}">✕</button></td>
    </tr>`).join('')}</tbody></table>
    <div class="mini" style="margin-top:8px">Мощность — штук в день (узкое горлышко — пошив). Сдвиги (раб. дней) задают перекрытие операций внутри цикла: на сколько дней старт пошива смещён от кроя, утюжки — от пошива, ОТК — от утюжки. Пусто = «авто» (движок посчитает по мощности). У каждого цеха свои значения.</div></div>`;
}

function dataSeasonsPanel() {
  return `<div class="panel"><div class="subhead"><h3>Сезоны</h3><button class="btn" id="btn-add-season">+ Сезон</button></div>
    <table><thead><tr><th>Название сезона</th><th class="num">Этапов</th><th></th></tr></thead>
    <tbody>${(state.seasons || []).map((se, i) => `<tr>
      <td><input data-season="${i}" value="${(se.name || '').replace(/"/g, '&quot;')}" style="width:220px"></td>
      <td class="num">${state.stages.filter((s) => s.seasonId === se.id).length}</td>
      <td>${(state.seasons.length > 1) ? `<button class="btn btn-danger" data-del-season="${i}">✕</button>` : '<span class="mini">послед.</span>'}</td>
    </tr>`).join('')}</tbody></table>
    <div class="mini" style="margin-top:8px">Сезон — контейнер над этапами (напр. «Осень-Зима 2026»). Селектор сезона в шапке фильтрует все листы. Новый сезон добавляет свои 4 этапа, продолжающие календарь предыдущего.</div></div>`;
}

function dataStagesPanel() {
  return `<div class="panel"><div class="subhead"><h3>Этапы производства</h3><button class="btn" id="btn-add-stage">+ Этап</button></div>
    <table><thead><tr><th>Сезон</th><th>Название</th><th>Месяцы продаж</th><th>Месяц отшива (YYYY-MM)</th><th>Дедлайн WB (YYYY-MM-DD)</th><th></th></tr></thead>
    <tbody>${state.stages.map((s, i) => `<tr>
      <td><select data-stage-i="${i}" data-f="seasonId">${(state.seasons || []).map((se) => `<option value="${se.id}"${se.id === s.seasonId ? ' selected' : ''}>${se.name}</option>`).join('')}</select></td>
      <td><input data-stage-i="${i}" data-f="name" value="${s.name}" style="width:90px"></td>
      <td><input data-stage-i="${i}" data-f="salesMonths" value="${s.salesMonths || ''}" style="width:110px"></td>
      <td><input data-stage-i="${i}" data-f="productionMonth" value="${s.productionMonth || ''}" style="width:110px"></td>
      <td><input data-stage-i="${i}" data-f="deadline" value="${s.deadline || ''}" style="width:130px"></td>
      <td><button class="btn btn-danger" data-del-stage="${i}">✕</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function dataSettingsPanel() {
  const f = state.settings.fabric, l = state.settings.logistics, fl = state.settings.flow;
  return `<div class="panel"><h3>Параметры расчёта</h3><div class="form-grid">
    <div class="card"><div class="mini" style="margin-bottom:8px">Ткань</div>
      <div class="field"><label>Лид-тайм заказа, дней</label><input data-set="fabric.leadTimeDays" value="${f.leadTimeDays}"></div>
      <div class="field"><label>Запас, этапов</label><input data-set="fabric.safetyStages" value="${f.safetyStages}"></div>
      <div class="field"><label>Запас по кол-ву, %</label><input data-set="fabric.wastagePct" value="${f.wastagePct}"></div>
      <div class="field"><label>Буфер «ткань раньше кроя», дней</label><input data-set="fabric.bufferDays" value="${f.bufferDays}"></div>
    </div>
    <div class="card"><div class="mini" style="margin-bottom:8px">Логистика до WB</div>
      <div class="field"><label>Мин. дней</label><input data-set="logistics.minDays" value="${l.minDays}"></div>
      <div class="field"><label>Макс. дней</label><input data-set="logistics.maxDays" value="${l.maxDays}"></div>
      <div class="field"><label>День вывоза карго (1=пн … 6=сб)</label><input data-set="logistics.cargoPickupWeekday" value="${l.cargoPickupWeekday}"></div>
    </div>
    <div class="card"><div class="mini" style="margin-bottom:8px">Поток (перекрытие операций, шт)</div>
      <div class="field"><label>Пошив стартует после кроя</label><input data-set="flow.sewAfterCut" value="${fl.sewAfterCut}"></div>
      <div class="field"><label>Утюжка после пошива</label><input data-set="flow.ironAfterSew" value="${fl.ironAfterSew}"></div>
      <div class="field"><label>ОТК после утюжки</label><input data-set="flow.otkAfterIron" value="${fl.otkAfterIron}"></div>
      <div class="field"><label>Буфер под форс-мажор, раб. дней</label><input data-set="riskBufferDays" value="${state.settings.riskBufferDays}"></div>
    </div>
  </div></div>`;
}

function bindDataEvents() {
  const root = document.getElementById('data-forms');
  const mark = () => { dirty = true; setStatus(); };

  root.querySelectorAll('input[data-art]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = state.articles[+e.target.dataset.art]; const f = e.target.dataset.f;
    if (f === 'colors') { a.colors = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); mark(); renderData(); return; }
    else if (f === 'sizes') a.sizes = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (f === 'fabricPerUnit') a.fabricPerUnit = +e.target.value || 1.6;
    else if (f === 'fabricPricePerMeter') a.fabricPricePerMeter = Math.max(0, +e.target.value || 0);
    else a[f] = e.target.value; mark();
  }));
  root.querySelectorAll('input[data-artimg]').forEach((inp) => inp.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1200000) { toast('Изображение слишком большое (макс ~1 МБ)', true); return; }
    const a = state.articles[+e.target.dataset.art];
    const c = decodeURIComponent(e.target.dataset.color);
    const reader = new FileReader();
    reader.onload = () => { a.fabricInfo = a.fabricInfo || {}; a.fabricInfo[c] = a.fabricInfo[c] || {}; a.fabricInfo[c].image = reader.result; mark(); renderData(); toast('Образец добавлен (не забудь «Сохранить»)'); };
    reader.readAsDataURL(file);
  }));
  root.querySelectorAll('[data-artimg-del]').forEach((b) => b.addEventListener('click', () => {
    const a = state.articles[+b.dataset.art];
    const c = decodeURIComponent(b.dataset.color);
    if (a.fabricInfo && a.fabricInfo[c]) delete a.fabricInfo[c].image;
    mark(); renderData();
  }));
  // переименование цвета — с переносом количеств (матрица всех этапов) и образца
  root.querySelectorAll('input[data-colorname]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = state.articles[+e.target.dataset.art];
    const idx = +e.target.dataset.idx;
    const oldName = a.colors[idx];
    const newName = e.target.value.trim();
    if (!newName) { toast('Название цвета не может быть пустым', true); renderData(); return; }
    if (newName === oldName) return;
    if (a.colors.includes(newName)) { toast('Такой цвет уже есть у артикула', true); renderData(); return; }
    renameColorKeys(a, oldName, newName);
    a.colors[idx] = newName;
    mark(); renderData();
  }));
  root.querySelectorAll('[data-color-del]').forEach((b) => b.addEventListener('click', () => {
    const a = state.articles[+b.dataset.art];
    const idx = +b.dataset.idx;
    const color = a.colors[idx];
    a.colors.splice(idx, 1);
    for (const p of (state.partias || []).filter((x) => x.articleId === a.id)) {
      if (p.planMatrix) delete p.planMatrix[color];
      if (p.factMatrix) delete p.factMatrix[color];
    }
    if (a.fabricInfo) delete a.fabricInfo[color];
    mark(); renderData();
  }));
  root.querySelectorAll('[data-color-add]').forEach((b) => b.addEventListener('click', () => {
    const a = state.articles[+b.dataset.colorAdd];
    let n = 1, name;
    do { name = 'цвет ' + n++; } while (a.colors.includes(name));
    a.colors.push(name);
    mark(); renderData();
  }));
  root.querySelectorAll('input[data-fabmeta]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = state.articles[+e.target.dataset.art];
    const c = decodeURIComponent(e.target.dataset.color);
    a.fabricInfo = a.fabricInfo || {}; a.fabricInfo[c] = a.fabricInfo[c] || {};
    a.fabricInfo[c][e.target.dataset.f] = e.target.value.trim();
    mark();
  }));
  root.querySelectorAll('[data-del-art]').forEach((b) => b.addEventListener('click', () => { state.articles.splice(+b.dataset.delArt, 1); mark(); renderData(); }));
  root.querySelector('#btn-add-article')?.addEventListener('click', () => {
    state.articles.push({ id: uid('art').slice(0, 6), name: 'Новый артикул', comment: '', fabricPerUnit: 1.6, fabricPricePerMeter: 0, colors: ['белый'], sizes: ['S', 'M', 'L', 'XL'], plan: {} }); mark(); renderData();
  });

  root.querySelectorAll('input[data-ws],select[data-ws]').forEach((inp) => inp.addEventListener('change', (e) => {
    const w = state.workshops[+e.target.dataset.ws];
    if (e.target.dataset.cap) w.capacities[e.target.dataset.cap] = Math.max(1, +e.target.value || 1);
    else if (e.target.dataset.off) {
      w.flowOffsets = w.flowOffsets || {};
      const v = e.target.value.trim();
      w.flowOffsets[e.target.dataset.off] = v === '' ? null : Math.max(0, Math.round(+v || 0));
    } else w[e.target.dataset.f] = e.target.value; mark();
  }));
  root.querySelectorAll('[data-del-ws]').forEach((b) => b.addEventListener('click', () => { state.workshops.splice(+b.dataset.delWs, 1); mark(); renderData(); }));
  root.querySelector('#btn-add-ws')?.addEventListener('click', () => {
    state.workshops.push({ id: uid('w'), name: 'Новый цех', role: 'aux', capacities: { cut: 300, sew: 150, iron: 300, otk: 600 } }); mark(); renderData();
  });

  root.querySelectorAll('[data-stage-i]').forEach((inp) => inp.addEventListener('change', (e) => {
    state.stages[+e.target.dataset.stageI][e.target.dataset.f] = e.target.value; mark();
    if (e.target.dataset.f === 'seasonId') renderData();
  }));
  root.querySelectorAll('[data-del-stage]').forEach((b) => b.addEventListener('click', () => { state.stages.splice(+b.dataset.delStage, 1); mark(); renderData(); }));
  root.querySelector('#btn-add-stage')?.addEventListener('click', () => {
    const n = state.stages.length + 1;
    state.stages.push({ id: uid('stage'), name: `Этап ${n}`, seasonId: (state.seasons[state.seasons.length - 1] || {}).id, salesMonths: '', productionMonth: '', deadline: '' }); mark(); renderData();
  });

  // сезоны
  root.querySelectorAll('input[data-season]').forEach((inp) => inp.addEventListener('change', (e) => {
    state.seasons[+e.target.dataset.season].name = e.target.value.trim() || 'Сезон'; mark(); renderData();
  }));
  root.querySelectorAll('[data-del-season]').forEach((b) => b.addEventListener('click', () => {
    const se = state.seasons[+b.dataset.delSeason];
    const hasStages = state.stages.some((s) => s.seasonId === se.id);
    if (hasStages && !confirm(`Удалить сезон «${se.name}» и его этапы вместе с партиями?`)) return;
    // удалить этапы сезона и их партии
    const stageIds = new Set(state.stages.filter((s) => s.seasonId === se.id).map((s) => s.id));
    state.stages = state.stages.filter((s) => s.seasonId !== se.id);
    state.partias = (state.partias || []).filter((p) => !stageIds.has(p.stageId));
    state.seasons.splice(+b.dataset.delSeason, 1);
    mark(); renderData();
  }));
  root.querySelector('#btn-add-season')?.addEventListener('click', () => { addSeason(); mark(); renderData(); });

  root.querySelectorAll('input[data-set]').forEach((inp) => inp.addEventListener('change', (e) => {
    const [grp, key] = e.target.dataset.set.split('.');
    if (key) state.settings[grp][key] = num(e.target.value);
    else state.settings[grp] = num(e.target.value); mark();
  }));

  root.querySelector('#btn-reset')?.addEventListener('click', async () => {
    if (!confirm('Сбросить все данные к примеру?')) return;
    const r = await api('/api/state/reset', { method: 'POST' });
    state = r.state; dirty = false; await recalc(false); renderData(); toast('Сброшено к примеру');
  });
}
function num(v) { const n = +v; return Number.isFinite(n) ? n : v; }

// ---------- тема ----------
function applyTheme(t) {
  const theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('planner-theme', theme); } catch (e) {}
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
  if (activeTab === 'gantt' && schedule) renderCurrent(); // перерисовать SVG под тему
}
function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem('planner-theme') || 'light'; } catch (e) {}
  applyTheme(saved);
  document.getElementById('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
}

// ---------- инициализация ----------
function initScrollTop() {
  const btn = document.getElementById('scroll-top');
  if (!btn) return;
  const onScroll = () => btn.classList.toggle('show', (window.scrollY || document.documentElement.scrollTop) > 300);
  window.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  onScroll();
}

async function init() {
  initTheme();
  initCollapsibles();
  initScrollTop();
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.getElementById('btn-recalc').addEventListener('click', () => recalc(false).then(() => toast('Пересчитано')));
  document.getElementById('btn-save').addEventListener('click', () => recalc(true).then(() => toast('Сохранено и пересчитано')).catch((e) => toast('Ошибка: ' + e.message, true)));
  document.getElementById('zoom').addEventListener('input', (e) => { pxPerDay = +e.target.value; if (activeTab === 'gantt') renderCurrent(); });
  document.getElementById('season-filter').addEventListener('change', (e) => {
    activeSeasonId = e.target.value;
    matrixStageId = null; fabricStageId = null; factFilterStage = '';
    renderCurrent();
  });

  try {
    await loadAll();
    switchTab('gantt');
    setStatus();
  } catch (e) {
    document.getElementById('gantt').innerHTML = `<div style="padding:24px;color:var(--danger)">Ошибка загрузки: ${e.message}</div>`;
  }
}
init();
