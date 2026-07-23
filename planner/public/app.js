// app.js — оболочка SPA: загрузка данных, вкладки, дашборд, формы, Гант.
import { renderGantt } from './gantt.js';
import { unitParams, analyze } from './unitCalc.js';

// Метка сборки — по ней в консоли браузера видно, что загружен свежий app.js
// (если после обновления её нет — браузер держит старый кэш, нужен hard-reload).
const APP_BUILD = 'season-2026-07-22e';
console.log('[planner] UI build:', APP_BUILD);

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
  else if (activeTab === 'season') renderSeason();
  else if (activeTab === 'unit') renderUnit();
  else if (activeTab === 'data') renderData();
  applyCollapsibles();
}

// ---------- ФАКТ (фактические количества по партиям) ----------
let factPartiaId = null;
let factFilterStage = '', factFilterArticle = '', factFilterWs = '';
function renderFact() {
  const root = document.getElementById('fact');
  // база: только сохранённые партии со сформированным планом (сумма>0) в активном сезоне
  const base = (state.partias || []).filter((p) => stageInSeason(p.stageId) && partiaPlanUnits(p) > 0);
  if (!base.length) { root.innerHTML = '<div class="panel"><div class="mini">Нет сформированных планов. Заполни количества на «План по размерам».</div></div>'; return; }

  // перекрёстное сужение: каждый список зависит от ВСЕХ остальных выбранных фильтров.
  const passStage = (p) => !factFilterStage || p.stageId === factFilterStage;
  const passArticle = (p) => !factFilterArticle || p.articleId === factFilterArticle;
  const passWs = (p) => !factFilterWs || (factFilterWs === '__auto__' ? !p.workshopId : p.workshopId === factFilterWs);
  let stageOpts, artOpts, wsOpts, guard = 0, changed = true;
  while (changed && guard++ < 6) {
    changed = false;
    stageOpts = new Set(base.filter((p) => passArticle(p) && passWs(p)).map((p) => p.stageId));
    artOpts = new Set(base.filter((p) => passStage(p) && passWs(p)).map((p) => p.articleId));
    wsOpts = new Set(base.filter((p) => passStage(p) && passArticle(p)).map((p) => p.workshopId || '__auto__'));
    if (factFilterStage && !stageOpts.has(factFilterStage)) { factFilterStage = ''; changed = true; }
    if (factFilterArticle && !artOpts.has(factFilterArticle)) { factFilterArticle = ''; changed = true; }
    if (factFilterWs && !wsOpts.has(factFilterWs)) { factFilterWs = ''; changed = true; }
  }
  const stageOrder = {}; state.stages.forEach((s, i) => { stageOrder[s.id] = i; });
  const parts = base.filter((p) => passStage(p) && passArticle(p) && passWs(p))
    .sort((x, y) => (stageOrder[x.stageId] - stageOrder[y.stageId]) || (x.workshopId || '').localeCompare(y.workshopId || '') || x.no - y.no);
  const gIdx = (id) => state.stages.findIndex((z) => z.id === id) + 1;
  const stageList = seasonStages().filter((s) => stageOpts.has(s.id));
  const artList = articlesSorted().filter((a) => artOpts.has(a.id));
  const wsList = state.workshops.filter((w) => wsOpts.has(w.id));

  const filtersHtml = `
    <div class="matrix-controls">
      <label>Этап: <select id="ff-stage"><option value="">все</option>${stageList.map((s) => `<option value="${s.id}"${s.id === factFilterStage ? ' selected' : ''}>Этап ${gIdx(s.id)}${s.salesMonths ? ' · ' + s.salesMonths : ''}</option>`).join('')}</select></label>
      <label>Артикул: <select id="ff-article"><option value="">все</option>${artList.map((x) => `<option value="${x.id}"${x.id === factFilterArticle ? ' selected' : ''}>${x.id}</option>`).join('')}</select></label>
      <label>Цех: <select id="ff-ws"><option value="">все</option>${wsOpts.has('__auto__') ? `<option value="__auto__"${factFilterWs === '__auto__' ? ' selected' : ''}>авто (не назначен)</option>` : ''}${wsList.map((w) => `<option value="${w.id}"${w.id === factFilterWs ? ' selected' : ''}>${w.name}</option>`).join('')}</select></label>
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
// удалить из матрицы ключи цветов/размеров, которых больше нет у артикула (иначе они «прячутся»
// в общей сумме, но не попадают в итоги по строкам/столбцам → расхождение сумм)
function pruneMatrix(M, a) {
  if (!M || typeof M !== 'object' || !a) return M || {};
  const cset = new Set(a.colors || []), sset = new Set(a.sizes || []);
  const out = {};
  for (const c in M) {
    if (!cset.has(c)) continue;
    const row = M[c] || {}; out[c] = {};
    for (const sz in row) if (sset.has(sz)) out[c][sz] = Math.max(0, Math.round(+row[sz] || 0));
  }
  return out;
}
// привести все партии артикула к его текущим цветам/размерам
function pruneArticlePartias(a) {
  for (const p of (state.partias || []).filter((x) => x.articleId === a.id)) {
    p.planMatrix = pruneMatrix(p.planMatrix, a);
    p.factMatrix = pruneMatrix(p.factMatrix, a);
  }
}

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
      <div class="matrix-io">
        <span class="mini">Ввод: вручную · <b>вставка из буфера</b> (встань на ячейку и Ctrl+V — блок из Excel/Sheets) · через .xlsx-шаблон:</span>
        <button id="mx-tpl-one" class="btn">⤓ шаблон .xlsx: ${a.id}</button>
        <button id="mx-tpl-all" class="btn">⤓ шаблон .xlsx: все</button>
        <label class="btn">⤒ загрузить (.xlsx)<input type="file" accept=".xlsx,.xls,.tsv,.txt,.csv" id="mx-import" hidden></label>
      </div>
      <div class="mini" style="margin-bottom:12px">Введи количества и нажми <b>«Сохранить план»</b>. Номер партии — свой у каждого цеха. Статус производства и факт — на вкладке «Факт». Сейчас отшивает: <b>${cycInfo}</b>.</div>
      ${hasGrid ? matrixTable(a, M) : '<div class="mini">У артикула не заданы цвета или размерный ряд — добавь их во вкладке «Данные».</div>'}
    </div>`;

  bindMatrixControls(a, stage);
  document.getElementById('mx-tpl-one').addEventListener('click', () => exportPlanXlsx([a.id], `plan_${a.id}.xlsx`));
  document.getElementById('mx-tpl-all').addEventListener('click', () => exportPlanXlsx(state.articles.map((x) => x.id), 'plan_all.xlsx'));
  document.getElementById('mx-import').addEventListener('change', (e) => importPlanAnyFile(e.target.files && e.target.files[0]));
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
  root.querySelectorAll('input[data-mx]').forEach((inp) => { inp.addEventListener('input', onMatrixInput); inp.addEventListener('paste', onMatrixPaste); });
  applyCollapsibles();
}

// вставка блока из буфера, начиная с активной ячейки (строки×столбцы = размеры×цвета)
function onMatrixPaste(e) {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text || !/[\t\n]/.test(text)) return; // одиночное значение — обычная вставка
  e.preventDefault();
  const a = state.articles.find((x) => x.id === matrixArticleId);
  const p = (state.partias || []).find((x) => x.id === matrixPartiaId);
  if (!a || !p) return;
  const r0 = a.sizes.indexOf(decodeURIComponent(e.target.dataset.s));
  const c0 = a.colors.indexOf(decodeURIComponent(e.target.dataset.c));
  const grid = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((r) => r.split('\t'));
  p.planMatrix = p.planMatrix || {};
  grid.forEach((cells, ri) => {
    const s = a.sizes[r0 + ri]; if (!s) return;
    cells.forEach((val, ci) => {
      const c = a.colors[c0 + ci]; if (!c) return;
      p.planMatrix[c] = p.planMatrix[c] || {};
      p.planMatrix[c][s] = parseQty(val);
    });
  });
  dirty = true; renderMatrix(); toast('Вставлено из буфера');
}
function parseQty(v) { return Math.max(0, Math.round(parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0)); }

// ---- шаблон плана (TSV): экспорт/импорт ----
function buildPlanTemplate(articleIds) {
  const lines = [
    '# Шаблон плана по размерам (TSV, разделитель — табуляция).',
    '# Заполни количества и загрузи обратно. Строки ARTICLE/STAGE не удаляй.',
    '# В блоке: шапка — цвета, первый столбец — размеры.',
  ];
  const stages = seasonStages();
  for (const aid of articleIds) {
    const a = state.articles.find((x) => x.id === aid);
    if (!a || !a.colors.length || !a.sizes.length) continue;
    lines.push('', ['ARTICLE', a.id, a.name].join('\t'));
    for (const st of stages) {
      lines.push(['STAGE', st.id, st.name + (st.salesMonths ? ' ' + st.salesMonths : '')].join('\t'));
      lines.push(['', ...a.colors].join('\t'));
      const M = (partiasOf(a.id, st.id)[0] || {}).planMatrix || {};
      for (const s of a.sizes) lines.push([s, ...a.colors.map((c) => cell(M, c, s) || '')].join('\t'));
    }
  }
  return lines.join('\n');
}
function parsePlanTemplate(text) {
  const res = {}; let curA = null, curStage = null, curColors = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    const cells = raw.split('\t');
    const key = (cells[0] || '').trim();
    if (key === 'ARTICLE') { curA = (cells[1] || '').trim(); curStage = null; curColors = null; continue; }
    if (key === 'STAGE') { curStage = (cells[1] || '').trim(); curColors = null; continue; }
    if (key === '') { curColors = cells.slice(1).map((x) => x.trim()); continue; } // шапка цветов
    if (curA && curStage && curColors) {
      const size = key;
      cells.slice(1).forEach((val, i) => {
        const color = curColors[i]; if (!color) return;
        ((res[curA] ||= {})[curStage] ||= {})[color] ||= {};
        res[curA][curStage][color][size] = parseQty(val);
      });
    }
  }
  return res;
}
function applyPlanImport(parsed) {
  let filled = 0, skipped = 0;
  for (const [aid, byStage] of Object.entries(parsed)) {
    const a = state.articles.find((x) => x.id === aid);
    if (!a) { skipped++; continue; }
    for (const [stageId, matrix] of Object.entries(byStage)) {
      if (!state.stages.find((s) => s.id === stageId)) { skipped++; continue; }
      let p = partiasOf(a.id, stageId)[0];
      if (!p) { p = newPartia(a.id, stageId); state.partias.push(p); }
      const nm = {};
      for (const c of a.colors) { nm[c] = {}; for (const s of a.sizes) nm[c][s] = (matrix[c] && matrix[c][s]) || 0; }
      p.planMatrix = nm; filled++;
    }
  }
  return { filled, skipped };
}
function importPlanFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parsePlanTemplate(String(reader.result).replace(/^﻿/, ''));
      const { filled, skipped } = applyPlanImport(parsed);
      dirty = true;
      recalc(true).then(() => { renderMatrix(); toast(`Загружено: ${filled} блоков${skipped ? `, пропущено ${skipped}` : ''}`); }).catch((err) => toast('Ошибка: ' + err.message, true));
    } catch (err) { toast('Не удалось разобрать файл: ' + err.message, true); }
  };
  reader.readAsText(file, 'utf-8');
}
function downloadText(filename, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/tab-separated-values;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a'); el.href = url; el.download = filename; document.body.appendChild(el); el.click();
  setTimeout(() => { URL.revokeObjectURL(url); el.remove(); }, 1000);
}

// ---- шаблон плана (.xlsx): экспорт/импорт (лист = артикул, блоки по этапам) ----
// строки одного артикула для листа .xlsx (AoA): маркеры ARTICLE/STAGE, шапка цветов, строки размеров
function planAoAForArticle(a) {
  const rows = [['ARTICLE', a.id, a.name]];
  for (const st of seasonStages()) {
    rows.push(['STAGE', st.id, st.name + (st.salesMonths ? ' ' + st.salesMonths : '')]);
    rows.push(['', ...a.colors]);
    const M = (partiasOf(a.id, st.id)[0] || {}).planMatrix || {};
    for (const s of a.sizes) rows.push([s, ...a.colors.map((c) => cell(M, c, s) || 0)]);
    rows.push([]); // разделитель между этапами
  }
  return rows;
}
function exportPlanXlsx(articleIds, filename) {
  if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу (Cmd+Shift+R)', true); return; }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  let added = 0;
  for (const aid of articleIds) {
    const a = state.articles.find((x) => x.id === aid);
    if (!a || !a.colors.length || !a.sizes.length) continue;
    const ws = XLSX.utils.aoa_to_sheet(planAoAForArticle(a));
    ws['!cols'] = [{ wch: 10 }, ...a.colors.map(() => ({ wch: 12 }))];
    // имя листа: id артикула (Excel — макс 31 символ, без : \ / ? * [ ]); уникализируем
    let name = String(a.id).replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || ('арт' + (added + 1));
    let base = name, n = 2; while (used.has(name)) name = (base.slice(0, 28) + '_' + n++);
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
    added++;
  }
  if (!added) { toast('Нет артикулов с заданными цветами и размерами', true); return; }
  XLSX.writeFile(wb, filename || 'plan.xlsx');
}
// разобрать книгу .xlsx в структуру { articleId: { stageId: { color: { size: qty } } } }
function parsePlanWorkbook(wb) {
  const res = {};
  for (const sheetName of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, blankrows: false });
    let curA = null, curStage = null, curColors = null;
    for (const row of aoa) {
      const cells = row || [];
      const key = String(cells[0] == null ? '' : cells[0]).trim();
      if (key === 'ARTICLE') { curA = String(cells[1] == null ? '' : cells[1]).trim(); curStage = null; curColors = null; continue; }
      if (key === 'STAGE') { curStage = String(cells[1] == null ? '' : cells[1]).trim(); curColors = null; continue; }
      if (key === '') { // шапка цветов (первый столбец пуст, справа — названия цветов)
        const rest = cells.slice(1).map((x) => String(x == null ? '' : x).trim());
        if (rest.some((x) => x)) curColors = rest;
        continue;
      }
      if (curA && curStage && curColors) {
        const size = key;
        cells.slice(1).forEach((val, i) => {
          const color = curColors[i]; if (!color) return;
          ((res[curA] ||= {})[curStage] ||= {})[color] ||= {};
          res[curA][curStage][color][size] = parseQty(val);
        });
      }
    }
  }
  return res;
}
function importPlanAnyFile(file) {
  if (!file) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) { importPlanFile(file); return; } // tsv/csv — прежний путь
  if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу (Cmd+Shift+R)', true); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
      const { filled, skipped } = applyPlanImport(parsePlanWorkbook(wb));
      dirty = true;
      recalc(true).then(() => { renderMatrix(); toast(`Загружено из .xlsx: ${filled} блоков${skipped ? `, пропущено ${skipped}` : ''}`); }).catch((err) => toast('Ошибка: ' + err.message, true));
    } catch (err) { toast('Не удалось разобрать .xlsx: ' + err.message, true); }
  };
  reader.readAsArrayBuffer(file);
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

// ---------- РАНГ СЕЗОННОСТИ (план продаж по сезонности) ----------
// Цвета этапов — как в скилле seasonality-sales-plan (references/outputs.md).
const PHASE_COLORS = {
  // ПЕРИОДЫ (заливка на графике) — едины для прогноза и истории
  'Разгон':     { band: '#22c55e', row: 'rgba(34,197,94,.16)' },
  'Сезон':      { band: '#f97316', row: 'rgba(249,115,22,.16)' },
  'Распродажа': { band: '#ec4899', row: 'rgba(236,72,153,.16)' },
  'Межсезонье': { band: '#94a3b8', row: 'rgba(148,163,184,.12)' },
};
const FAVORABLE_BAND = 'rgba(250,204,21,.85)'; // ленточка благоприятного периода (сверху, со звёздами)
const SEASON_LAG = 7; // средний лаг заказ→выкуп (дней): заказ сегодня — выкуп через ~lag
const seEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const seFmtD = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const SE_MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const seMonthLabel = (ym) => `${SE_MON[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const seFmtDate = (iso) => `${iso.slice(8, 10)} ${SE_MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const seFmtRange = (a, b) => `${seFmtDate(a)} — ${seFmtDate(b)}`;

let seasonBuildArticle = null;   // артикул в форме построения
let seasonSelArticle = null;     // артикул в накопителе (просмотр)
let seasonGran = 'day';          // день/неделя/месяц в таблице
let seasonBuilding = false;
let seasonPlansIndex = [];
let seasonHasToken = null;
const SE_CHARTS = {};            // реестр графиков для тултипа: id → {rows, геометрия, valueKey}
let seChartSeq = 0;

// всплывающая подсказка на графиках (дата, продажи, цена, остатки)
function seasonTipEl() {
  let el = document.getElementById('se-tip');
  if (!el) { el = document.createElement('div'); el.id = 'se-tip'; el.className = 'se-tip'; document.body.appendChild(el); }
  return el;
}
function attachSeasonTip(svg) {
  const meta = SE_CHARTS[svg.dataset.chart];
  if (!meta) return;
  const cursor = svg.querySelector('.se-cursor');
  const tip = seasonTipEl();
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const vbX = (e.clientX - rect.left) * (meta.W / rect.width);
    if (vbX < meta.padL || vbX > meta.padL + meta.plotW || meta.n < 1) { cursor.setAttribute('opacity', '0'); tip.style.display = 'none'; return; }
    const frac = (vbX - meta.padL) / meta.plotW;
    let idx = Math.round(frac * (meta.n - 1)); idx = Math.max(0, Math.min(meta.n - 1, idx));
    const r = meta.rows[idx] || {};
    const cx = (meta.padL + (meta.n > 1 ? idx / (meta.n - 1) : 0) * meta.plotW).toFixed(1);
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('opacity', '0.45');
    const val = Math.round(+r[meta.valueKey] || 0);
    const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(r.date + 'T00:00:00Z').getUTCDay()];
    const st = r.stage || '—';
    const stColor = (PHASE_COLORS[st] || {}).band || 'var(--muted)';
    tip.innerHTML = `<div class="se-tip-st"><i style="background:${stColor}"></i>${st.charAt(0).toUpperCase() + st.slice(1)}${r.favorable ? ' ⭐' : ''}</div>`
      + `<div class="se-tip-d">${seFmtDate(r.date)} (${wd})</div>`
      + `<div><i style="background:${SE_COL.demand}"></i>Продажи: <b>${val.toLocaleString('ru')}</b> шт</div>`
      + `<div><i style="background:${SE_COL.price}"></i>Цена: <b>${Math.round(+r.price || 0).toLocaleString('ru')}</b> ₽</div>`
      + `<div><i style="background:${SE_COL.stock}"></i>Остатки: <b>${Math.round(+r.stock || 0).toLocaleString('ru')}</b> шт</div>`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = e.clientX + 14, top = e.clientY + 14;
    if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 14;
    if (top + th > window.innerHeight - 8) top = e.clientY - th - 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  });
  svg.addEventListener('mouseleave', () => { cursor.setAttribute('opacity', '0'); tip.style.display = 'none'; });
}

async function renderSeason() {
  const root = document.getElementById('season');
  if (seasonHasToken === null) {
    try { seasonHasToken = (await api('/api/season/status')).hasToken; } catch { seasonHasToken = false; }
  }
  try { seasonPlansIndex = (await api('/api/season/plans')).plans || []; } catch { seasonPlansIndex = []; }
  root.innerHTML = seasonBuilderPanel() + seasonStorePanel();
  bindSeasonBuilder();
  bindSeasonStore();
  if (seasonSelArticle) renderSeasonView(seasonSelArticle);
}

// ── Часть 1 — конструктор ──
function seasonBuilderPanel() {
  const arts = articlesSorted();
  if (!arts.length) return '<div class="panel"><h3>Часть 1 — Построение плана продаж</h3><div class="mini">Сначала добавь артикулы во вкладке «Данные».</div></div>';
  const aid = (seasonBuildArticle && arts.find((a) => a.id === seasonBuildArticle)) ? seasonBuildArticle : arts[0].id;
  seasonBuildArticle = aid;
  const a = arts.find((x) => x.id === aid);
  const f = a.seasonFilter || {};
  const warn = seasonHasToken ? ''
    : '<div class="season-warn">⚠ Не задан <b>MPSTATS_TOKEN</b> в окружении службы — построение недоступно. Добавь токен в <code>planner/data/.env</code> на Mac mini (см. DEPLOY.md) и перезапусти службу.</div>';
  return `<div class="panel season-builder">
    <div class="subhead"><h3>Часть 1 — Построение плана продаж (по конкурентам)</h3></div>
    ${warn}
    <div class="season-form season-grid">
      <div class="field"><label>Артикул</label><select id="se-article">${arts.map((x) => `<option value="${x.id}"${x.id === aid ? ' selected' : ''}>${x.id} — ${seEsc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Размер группы аналогов</label><input id="se-limit" type="number" value="${f.limit ?? 60}"></div>

      <div class="field span2"><label>Путь предмета WB</label>
        <div class="se-path-row">
          <input id="se-path" value="${seEsc(f.path || '')}" placeholder="Женщинам/Блузки и рубашки/Рубашка">
          <input id="se-path-q" placeholder="поиск по слову" title="напр. рубаш">
          <button class="btn" id="se-path-find" type="button">найти путь</button>
        </div>
        <div id="se-path-list" class="se-path-list"></div>
      </div>

      <div class="field"><label>Слова в названии (любое из)</label><input id="se-words" value="${seEsc(f.words || '')}" placeholder="рубашка"></div>
      <div class="field"><label>Доп. слова-признаки</label><input id="se-allwords" value="${seEsc(f.allWords || '')}" placeholder="оверсайз, длинный рукав"></div>

      <div class="field span2"><label>Исключить слова</label><input id="se-exclude" value="${seEsc(f.exclude || '')}" placeholder="детск, мужск, блузка"></div>

      <div class="field"><label>Цена от, ₽</label><input id="se-pmin" type="number" value="${f.priceMin ?? ''}"></div>
      <div class="field"><label>Цена до, ₽</label><input id="se-pmax" type="number" value="${f.priceMax ?? ''}"></div>

      <div class="field"><label>Мин. продаж/мес</label><input id="se-minsales" type="number" value="${f.minSales ?? ''}"></div>
      <div class="field"><label>Мин. выручка/мес, ₽</label><input id="se-minrev" type="number" value="${f.minRevenue ?? ''}"></div>

      <div class="field"><label title="Год старта сезона. Вход, пик и распродажу движок выбирает сам из годового анализа рынка.">Целевой сезон (год старта)</label><input id="se-year" type="number" min="2024" max="2032" value="${f.targetYear || (new Date().getUTCFullYear())}"></div>
      <div class="field"><label title="Уровень, на который движок выводит пик плана. ТОП-3 — средняя трёх сильнейших аналогов (реалистично). ТОП-1 — уровень самого сильного аналога по выручке в вашем ценовом сегменте (амбициозно: цель занять ТОП-1, максимальный объём и заказ на производство).">Целевой уровень (пик плана)</label>
        <select id="se-level">
          <option value="top3"${f.targetLevel === 'top1' ? '' : ' selected'}>ТОП-3 — средний (реалистично)</option>
          <option value="top1"${f.targetLevel === 'top1' ? ' selected' : ''}>ТОП-1 — максимум (амбициозно)</option>
        </select>
      </div>

      <div class="span2 se-opts">
        <label class="se-check"><input type="checkbox" id="se-oos"${f.oos !== false ? ' checked' : ''}> OOS-поправка</label>
        <label class="se-check"><input type="checkbox" id="se-weekly"${f.weekly !== false ? ' checked' : ''}> недельный профиль</label>
      </div>
      <div class="span2 season-actions">
        <button class="btn btn-primary" id="se-build"${seasonHasToken && !seasonBuilding ? '' : ' disabled'}>${seasonBuilding ? '⏳ Строю план…' : '▶ Построить план'}</button>
        <span class="mini">Данные берутся из MPStats по конкурентам-аналогам (несколько секунд, ~3–4 запроса). Готовый план сохранится в накопитель ниже.</span>
      </div>
    </div>
  </div>`;
}

function collectSeasonForm() {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  return {
    articleId: seasonBuildArticle,
    path: v('se-path'), words: v('se-words'), allWords: v('se-allwords'), exclude: v('se-exclude'),
    priceMin: v('se-pmin'), priceMax: v('se-pmax'), minSales: v('se-minsales'), minRevenue: v('se-minrev'),
    limit: v('se-limit'), targetYear: v('se-year'),
    targetLevel: (document.getElementById('se-level')?.value === 'top1') ? 'top1' : 'top3',
    oos: document.getElementById('se-oos')?.checked !== false,
    weekly: document.getElementById('se-weekly')?.checked !== false,
  };
}

function bindSeasonBuilder() {
  const g = (id) => document.getElementById(id);
  g('se-article')?.addEventListener('change', (e) => { seasonBuildArticle = e.target.value; renderSeason(); });
  g('se-path-find')?.addEventListener('click', async () => {
    const q = g('se-path-q').value.trim();
    const box = g('se-path-list');
    if (!q) { box.innerHTML = '<span class="mini">Введи слово для поиска пути (напр. рубаш).</span>'; return; }
    box.innerHTML = '<span class="mini">Ищу…</span>';
    try {
      const r = await api('/api/season/categories?q=' + encodeURIComponent(q));
      box.innerHTML = (r.paths || []).length
        ? r.paths.map((p) => `<button class="btn se-path-opt" type="button" data-path="${seEsc(p)}">${seEsc(p)}</button>`).join('')
        : '<span class="mini">Ничего не найдено.</span>';
      box.querySelectorAll('.se-path-opt').forEach((b) => b.addEventListener('click', () => { g('se-path').value = b.dataset.path; box.innerHTML = ''; }));
    } catch (e) { box.innerHTML = '<span class="mini bad">Ошибка: ' + e.message + '</span>'; }
  });
  g('se-build')?.addEventListener('click', async () => {
    const cfg = collectSeasonForm();
    if (!cfg.path) { toast('Укажи путь предмета WB', true); return; }
    seasonBuilding = true; renderSeason();
    try {
      await api('/api/season/build', { method: 'POST', body: JSON.stringify(cfg) });
      // запомнить фильтр в артикуле, чтобы перестраивать в один клик
      const a = state.articles.find((x) => x.id === cfg.articleId);
      if (a) {
        a.seasonFilter = { path: cfg.path, words: cfg.words, allWords: cfg.allWords, exclude: cfg.exclude,
          priceMin: cfg.priceMin, priceMax: cfg.priceMax, minSales: cfg.minSales, minRevenue: cfg.minRevenue,
          limit: cfg.limit, targetYear: cfg.targetYear, targetLevel: cfg.targetLevel, oos: cfg.oos, weekly: cfg.weekly };
        await recalc(true).catch(() => {});
      }
      seasonSelArticle = cfg.articleId;
      toast('План построен и сохранён');
    } catch (e) {
      toast('Ошибка построения: ' + e.message, true);
    } finally {
      seasonBuilding = false; renderSeason();
    }
  });
}

// ── Часть 2 — накопитель ──
function seasonStorePanel() {
  const plans = seasonPlansIndex;
  const opts = plans.map((p) => `<option value="${p.articleId}"${p.articleId === seasonSelArticle ? ' selected' : ''}>${p.articleId}${p.label ? ' — ' + seEsc(p.label) : ''}${p.forecastPeriod ? ` (${p.forecastPeriod.from}…${p.forecastPeriod.to})` : ''}</option>`).join('');
  return `<div class="panel season-store">
    <div class="subhead"><h3>Часть 2 — Сохранённые планы (накопитель)</h3></div>
    ${plans.length ? `<div class="season-form se-view-pick">
        <div class="field grow"><label>Артикул с построенным планом</label>
          <select id="se-view-article"><option value="">— выбери артикул —</option>${opts}</select></div>
        <button class="btn btn-danger" id="se-del" type="button" title="удалить сохранённый план">✕ удалить план</button>
      </div>`
      : '<div class="mini">Пока нет сохранённых планов. Построй план в Части 1 — он появится здесь.</div>'}
    <div id="se-view"></div>
  </div>`;
}

function bindSeasonStore() {
  const sel = document.getElementById('se-view-article');
  sel?.addEventListener('change', (e) => { seasonSelArticle = e.target.value || null; renderSeasonView(seasonSelArticle); });
  document.getElementById('se-del')?.addEventListener('click', async () => {
    if (!seasonSelArticle) { toast('Сначала выбери артикул', true); return; }
    try {
      await api('/api/season/plan?articleId=' + encodeURIComponent(seasonSelArticle), { method: 'DELETE' });
      toast('План удалён'); seasonSelArticle = null; renderSeason();
    } catch (e) { toast('Ошибка: ' + e.message, true); }
  });
}

async function renderSeasonView(articleId) {
  const box = document.getElementById('se-view');
  if (!box) return;
  if (!articleId) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="mini">Загрузка плана…</div>';
  let rec;
  try { rec = await api('/api/season/plan?articleId=' + encodeURIComponent(articleId)); }
  catch (e) { box.innerHTML = '<div class="mini bad">Не удалось загрузить: ' + e.message + '</div>'; return; }
  const rep = rec.report, p = rep.plan || {};
  // План построен СТАРЫМ движком (нет календаря сезона/поставок) → графики отрисуются
  // по устаревшим данным. Просим перестроить, иначе новые правки «не видно».
  const stale = !p.seasonCal || !Array.isArray(p.deliveries);
  const canRebuild = stale && rec.cfg && rec.cfg.path;
  const staleBanner = stale
    ? `<div class="se-stale">⚠ Этот план построен предыдущей версией движка — новые периоды, вехи, лента благоприятного периода и поставки частями появятся только после пересборки.${canRebuild ? ' <button class="btn btn-primary" id="se-rebuild" type="button">↻ Построить заново</button>' : ' Откройте конструктор выше, выберите этот артикул и нажмите «▶ Построить план».'}</div>`
    : '';
  box.innerHTML = staleBanner + seasonSummary(rep, p) + seasonPlanChecks(rep, p) + seasonChartsBlock(rep, p) + `<div id="se-table">${seasonTableBlock(p)}</div>`;
  bindSeasonView(p);
  // Пересборка в один клик прямо из баннера (тем же cfg, что сохранён у плана).
  if (canRebuild) {
    document.getElementById('se-rebuild')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '⏳ Пересобираю план…';
      try {
        await api('/api/season/build', { method: 'POST', body: JSON.stringify({ ...rec.cfg, articleId }) });
        toast('План пересобран новым движком');
        await renderSeasonView(articleId);
      } catch (err) {
        toast('Ошибка пересборки: ' + err.message, true);
        btn.disabled = false; btn.textContent = '↻ Построить заново';
      }
    });
  }
}

function seasonPhaseLegend() {
  return `<div class="se-phases">${Object.entries(PHASE_COLORS).map(([name, c]) => `<span class="se-phase-chip"><i style="background:${c.band}"></i>${name}</span>`).join('')}<span class="se-phase-chip"><i style="background:${FAVORABLE_BAND}"></i>благоприятный период</span></div>`;
}

function seasonBuyoutOf(articleId) {
  const a = (state.articles || []).find((x) => x.id === articleId);
  return a && +a.buyoutPct > 0 ? +a.buyoutPct : 40;
}
// таймлайн выбранных движком дат фаз + блок самопроверки плана
function seasonPlanChecks(rep, p) {
  const ph = p.phaseDates || {}, val = p.validation || {};
  const df = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '—');
  const steps = [['Вход', ph.entry], ['Старт сезона', ph.hotStart], ['Пик', ph.peak], ['Начало распродажи', ph.saleStart], ['Конец', ph.end]];
  const tl = steps.map(([n, d]) => `<div class="se-tl-step"><div class="se-tl-n">${n}</div><div class="se-tl-d">${df(d)}</div></div>`).join('<span class="se-tl-arr">→</span>');
  const checks = Object.values(val).map((v) => `<div class="se-chk ${v.ok ? 'ok' : 'bad'}"><span class="se-chk-i">${v.ok ? '✅' : '❌'}</span><span class="se-chk-l">${v.label}</span><span class="se-chk-v">${v.value} <span class="mini">(${v.ref})</span></span></div>`).join('');
  // План поставок на склад WB (частями) + крайний срок подсорта
  const dv = p.deliveries || [];
  let deliv = '';
  if (dv.length) {
    const cells = dv.map((d) => `<div class="se-dv-step" title="${seEsc(d.title || '')}"><div class="se-dv-tag">${d.tag}</div><div class="se-dv-q">${Math.round(d.qty).toLocaleString('ru')} шт</div><div class="se-dv-d">${df(d.date)}</div></div>`).join('<span class="se-tl-arr">→</span>');
    const rs = p.restockDeadline ? `<div class="se-dv-restock" title="${seEsc(p.restockDeadline.note || '')}">⚠ подсорт ≤ ${df(p.restockDeadline.date)} (за неделю до Пика, если факт&gt;плана)</div>` : '';
    deliv = `<div class="se-chk-head">Поставки на склад WB (частями)</div><div class="se-deliveries">${cells}</div>${rs}`;
  }
  return `<div class="se-checks">
    <div class="se-tl-head">Сезон и фазы (движок выбрал по спросу):</div>
    <div class="se-timeline">${tl}</div>
    ${deliv}
    ${checks ? `<div class="se-chk-head">Самопроверка плана</div><div class="se-chk-grid">${checks}</div>` : ''}
  </div>`;
}

function seasonSummary(rep, p) {
  const rank = p.rank || {};
  const fd = p.forecastDaily || [];
  const total = Math.round(fd.reduce((s, d) => s + (+d.plannedOrders || 0), 0)); // выкупы
  const buyout = seasonBuyoutOf(seasonSelArticle);
  const orders = Math.round(total / (buyout / 100)); // заказы = выкупы / %выкупа
  const prices = fd.map((d) => +d.price || 0).filter((x) => x > 0);
  const pmin = prices.length ? Math.min(...prices) : 0, pmax = prices.length ? Math.max(...prices) : 0;
  const favM = (p.favorable && p.favorable.months || []).map((m) => SE_MON[m - 1]).join(', ');
  const gen = rep.generatedAt ? rep.generatedAt.slice(0, 10) : '';
  return `<div class="se-summary">
    <div class="se-cards">
      <div class="se-card"><div class="k">Ранг сезонности</div><div class="v">${rank.rank || '—'}</div><div class="mini">амплитуда p90/p50 = ${rank.amplitude ?? '—'}</div></div>
      <div class="se-card"><div class="k">Выкупы (прогноз), шт</div><div class="v good">${total.toLocaleString('ru')}</div><div class="mini">MPStats «продажи» = выкупы · база для производства</div></div>
      <div class="se-card"><div class="k">Заказы (оценка), шт</div><div class="v">${orders.toLocaleString('ru')}</div><div class="mini">выкупы ÷ выкуп: <input id="se-buyout" type="number" min="1" max="100" value="${buyout}" title="% выкупа"> %</div></div>
      <div class="se-card"><div class="k">Цена, ₽</div><div class="v">${pmin ? pmin.toLocaleString('ru') + '–' + pmax.toLocaleString('ru') : '—'}</div><div class="mini">якорь: медиана ТОПов −10%</div></div>
      <div class="se-card"><div class="k">Благоприятные месяцы</div><div class="v">${favM || '—'}</div><div class="mini">спрос выше среднего, остатки ниже</div></div>
    </div>
    ${seasonLevelNote(p)}
    <div class="mini">Группа-аналогов: ${rep.itemsWithData ?? '—'} из ${rep.groupSize ?? '—'} · сбор: ${rep.method === 'category-bulk' ? 'одним запросом по категории' : rep.method === 'per-sku' ? 'по каждому товару' : (rep.method || '—')} (${rep.requests ?? '—'} обращ. к MPStats) · построено ${gen}</div>
  </div>`;
}

// Пояснение к целевому уровню (ТОП-3/ТОП-1) с обоими значениями для сравнения.
function seasonLevelNote(p) {
  const li = p.levelInfo; if (!li || !li.targetLevel) return '';
  const isTop1 = li.targetLevel === 'top1';
  const active = isTop1 ? 'ТОП-1 (максимум)' : 'ТОП-3 (средний)';
  const cur = isTop1 ? li.top1Daily : li.top3Daily;
  const alt = isTop1 ? `реалистичный ТОП-3 дал бы ${li.top3Daily}` : `амбициозный ТОП-1 дал бы ${li.top1Daily}`;
  const who = isTop1 && li.top1Name ? ` (сильнейший аналог: «${seEsc(String(li.top1Name).slice(0, 46))}»)` : '';
  return `<div class="mini se-level-note">🎯 Целевой уровень пика: <b>${active}</b> ≈ <b>${cur}</b> шт/день${who}. ${alt} шт/день — переключается в конструкторе и требует пересборки.</div>`;
}

function seasonChartsBlock(rep, p) {
  for (const k of Object.keys(SE_CHARTS)) delete SE_CHARTS[k]; // сброс реестра тултипов
  const fp = rep.forecastPeriod, hp = rep.historyPeriod;
  const fTitle = 'Прогноз спроса, цены и остатков — ' + (fp ? seFmtRange(fp.from, fp.to) : 'на запрошенный период');
  const hTitle = 'История за 2 года (реальные данные аналогов)' + (hp ? ' — ' + seFmtRange(hp.d1, hp.d2) : '');
  const ph = p.phaseDates || {};
  const milestones = [
    { date: ph.entry, name: 'Вход' }, { date: ph.hotStart, name: 'Старт сезона' },
    { date: ph.peak, name: 'Пик' }, { date: ph.saleStart, name: 'Начало распродажи' }, { date: ph.end, name: 'Конец' },
  ].filter((m) => m.date);
  return `<div class="se-charts">
    ${seasonChartSVG(fTitle, p.forecastDaily || [], 'plannedOrders', { demand: 'план продаж (выкупы), шт/день', stock: 'наш склад (план поставок), шт', milestones, deliveries: p.deliveries || [], restock: p.restockDeadline || null })}
    ${seasonChartSVG(hTitle, p.historyDaily || [], 'sales', { demand: 'продажи аналогов, шт/день', stock: 'остатки конкурентов, шт', milestones: p.historyMilestones || [], milestoneLabels: false })}
  </div>`;
}

// сглаживание MA(k) для линии спроса (шумный дневной ряд)
function seMA(arr, k = 7) {
  if (arr.length < k) return arr.slice();
  const out = new Array(arr.length); const h = Math.floor(k / 2);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) { s += arr[j]; n++; }
    out[i] = s / n;
  }
  return out;
}

const SE_COL = { demand: '#3b82f6', price: '#ef4444', stock: '#a78bfa' };
const seFmtK = (v) => { v = Math.round(v); const a = Math.abs(v); if (a >= 100000) return Math.round(v / 1000) + 'k'; if (a >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'; return v.toLocaleString('ru'); };

function seasonChartSVG(title, rows, valueKey, labels = {}) {
  const lab = { demand: 'спрос, шт/день', stock: 'остатки, шт', ...labels };
  if (!rows || !rows.length) return `<div class="se-chart"><div class="se-chart-title">${title}</div><div class="mini">нет данных</div></div>`;
  const W = 980, H = 344, padL = 54, padR = 104, padT = 46, padB = 58;
  const n = rows.length;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (n > 1 ? i * plotW / (n - 1) : 0);
  const weekly = n <= 300; // прогноз — недельные вехи; история — по месяцам

  // реестр для тултипа/крестика
  const chartId = 'sec' + (seChartSeq++);
  SE_CHARTS[chartId] = { rows, padL, plotW, n, W, valueKey };

  // РЕАЛИСТИЧНЫЕ линии: рисуем по ДНЯМ (без недельного усреднения). Цену forward-fill
  // (в дни без продаж цена = последняя известная), чтобы линия не падала в 0.
  const dvals = rows.map((r) => +r[valueKey] || 0);
  const svals = rows.map((r) => +r.stock || 0);
  const pvals = []; let lastP = 0;
  for (const r of rows) { const pv = +r.price || 0; if (pv > 0) lastP = pv; pvals.push(lastP || pv); }
  const dMax = Math.max(1, ...dvals), pMax = Math.max(1, ...pvals), sMax = Math.max(1, ...svals);
  const yOf = (v, mx) => padT + plotH * (1 - v / mx);
  const poly = (arr, mx) => arr.map((v, i) => `${x(i).toFixed(1)},${yOf(v, mx).toFixed(1)}`).join(' ');
  const bandH = plotH.toFixed(1);

  const idxByDate = {}; rows.forEach((r, ii) => { idxByDate[r.date] = ii; });
  // фон-полосы этапов + ПОДПИСЬ названия этапа на сегменте
  let bands = '', bandLabels = '', i = 0;
  while (i < n) {
    let j = i; const st = rows[i].stage; while (j + 1 < n && rows[j + 1].stage === st) j++;
    const c = PHASE_COLORS[st];
    if (c) {
      const x0 = x(i), x1 = x(j) + (j === i ? 2 : 0);
      bands += `<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${bandH}" fill="${c.band}" fill-opacity="0.16"/>`;
      if (st && (x1 - x0) > 40) bandLabels += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${padT + 15}" class="se-band-label" text-anchor="middle" fill="${c.band}">${st}</text>`;
    }
    i = j + 1;
  }
  // БЛАГОПРИЯТНЫЙ период — ленточка НАД цветными периодами (в верхнем поле), рамка + звёзды
  let favRibbon = ''; i = 0;
  while (i < n) {
    if (rows[i].favorable) {
      let j = i; while (j + 1 < n && rows[j + 1].favorable) j++;
      const x0 = x(i), x1 = x(j) + 2, w = Math.max(4, x1 - x0), yr = padT - 13;
      favRibbon += `<rect x="${x0.toFixed(1)}" y="${yr}" width="${w.toFixed(1)}" height="10" rx="3" fill="${FAVORABLE_BAND}" stroke="#a16207" stroke-width="0.8"/>`;
      const stars = Math.max(1, Math.min(20, Math.floor(w / 15)));
      favRibbon += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(yr + 8).toFixed(1)}" text-anchor="middle" class="se-stars">${'★'.repeat(stars)}</text>`;
      i = j + 1;
    } else i++;
  }
  // ВЕХИ (одиночные дни): вертикальная линия через график + подпись сверху.
  // На истории (milestoneLabels:false) вехи повторяются каждый год → подписи наложились бы;
  // оставляем линии с тултипом, границы периодов и так читаются по смене цвета.
  // Подписи вех раскладываем в ДВА ряда, если соседние близко (Пик рядом с Началом распродажи).
  const showMsLabels = labels.milestoneLabels !== false;
  const msList = (labels.milestones || []).map((ms) => ({ ...ms, mi: idxByDate[ms.date] }))
    .filter((m) => m.mi != null).sort((a, b) => a.mi - b.mi);
  let milestones = '';
  const lastRight = [-1e9, -1e9]; // правый край подписи в ряду 0 и 1
  for (const ms of msList) {
    const mxN = x(ms.mi), mx = mxN.toFixed(1);
    milestones += `<line x1="${mx}" y1="${padT}" x2="${mx}" y2="${H - padB}" stroke="var(--text)" stroke-width="1" opacity="0.32"><title>${seEsc(ms.name)}</title></line>`;
    milestones += `<circle cx="${mx}" cy="${padT}" r="2.5" fill="var(--text)" opacity="0.55"><title>${seEsc(ms.name)}</title></circle>`;
    if (showMsLabels) {
      const halfW = Math.max(16, ms.name.length * 3.3); // оценка полуширины подписи
      let row = mxN - halfW > lastRight[0] ? 0 : (mxN - halfW > lastRight[1] ? 1 : 0);
      lastRight[row] = mxN + halfW;
      milestones += `<text x="${mx}" y="${row === 0 ? 12 : 26}" class="se-ms-label" text-anchor="middle">${ms.name}</text>`;
    }
  }
  // КРАЙНИЙ СРОК ПОДСОРТА — оранжевая пунктирная веха (контингент, если факт > плана)
  if (labels.restock && idxByDate[labels.restock.date] != null) {
    const rx = x(idxByDate[labels.restock.date]).toFixed(1);
    milestones += `<line x1="${rx}" y1="${padT}" x2="${rx}" y2="${H - padB}" stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.9"><title>${seEsc(labels.restock.note || 'Крайний срок подсорта')}</title></line>`;
    milestones += `<rect x="${(+rx - 4).toFixed(1)}" y="${padT - 4}" width="8" height="8" fill="#f59e0b" opacity="0.95"><title>${seEsc(labels.restock.note || '')}</title></rect>`;
  }
  // ПОСТАВКИ на склад WB (частями) — треугольные маркеры на линии остатков
  let deliv = '';
  for (const dv of (labels.deliveries || [])) {
    const di = idxByDate[dv.date]; if (di == null) continue;
    const dx = x(di); const sy = yOf(+(rows[di] || {}).stock || 0, sMax); const ty = Math.min(H - padB - 2, Math.max(padT + 14, sy));
    deliv += `<path d="M ${dx.toFixed(1)} ${(ty - 10).toFixed(1)} L ${(dx - 5).toFixed(1)} ${ty.toFixed(1)} L ${(dx + 5).toFixed(1)} ${ty.toFixed(1)} Z" fill="${SE_COL.stock}" stroke="#fff" stroke-width="0.5"><title>${seEsc(dv.title || '')} — ${Math.round(dv.qty).toLocaleString('ru')} шт (${dv.date})</title></path>`;
    deliv += `<text x="${dx.toFixed(1)}" y="${(ty - 12).toFixed(1)}" class="se-deliv-l" text-anchor="middle">${dv.tag}</text>`;
  }

  // ── горизонтальные линии сетки + вертикальные шкалы (3 оси, ОТ НУЛЯ) ──
  let hgrid = '', yAxes = '';
  const LV = 5; // уровней сетки (0 … max)
  for (let k = 0; k < LV; k++) {
    const f = k / (LV - 1); const yy = (padT + plotH * (1 - f)).toFixed(1);
    hgrid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--line)" opacity="${k === 0 ? 0.6 : 0.3}"/>`;
    yAxes += `<text x="${padL - 6}" y="${(+yy + 3).toFixed(1)}" class="se-axis" text-anchor="end" fill="${SE_COL.demand}">${seFmtK(dMax * f)}</text>`;
    yAxes += `<text x="${W - padR + 8}" y="${(+yy + 3).toFixed(1)}" class="se-axis" text-anchor="start" fill="${SE_COL.price}">${seFmtK(pMax * f)}</text>`;
    yAxes += `<text x="${W - 4}" y="${(+yy + 3).toFixed(1)}" class="se-axis" text-anchor="end" fill="${SE_COL.stock}">${seFmtK(sMax * f)}</text>`;
  }
  yAxes += `<text x="${padL - 6}" y="${padT - 6}" class="se-axis" text-anchor="end" fill="${SE_COL.demand}">шт/дн</text>`;
  yAxes += `<text x="${W - padR + 8}" y="${padT - 6}" class="se-axis" text-anchor="start" fill="${SE_COL.price}">₽</text>`;
  yAxes += `<text x="${W - 4}" y="${padT - 6}" class="se-axis" text-anchor="end" fill="${SE_COL.stock}">ост.</text>`;

  // ── горизонтальная ось ──
  const mondays = [];
  rows.forEach((r, idx) => { const d = new Date(r.date + 'T00:00:00Z'); if (d.getUTCDay() === 1 || idx === 0) mondays.push(idx); });
  let vgrid = '', xlab = '';
  if (weekly) {
    // понедельные вехи: линия + подпись даты по диагонали (−40°), чтобы умещались
    for (const idx of mondays) {
      const xx = x(idx).toFixed(1); const dt = rows[idx].date;
      vgrid += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H - padB}" stroke="var(--line)" opacity="0.22"/>`;
      xlab += `<text x="${xx}" y="${H - padB + 12}" class="se-axis se-wk" text-anchor="end" transform="rotate(-40 ${xx} ${H - padB + 12})">${dt.slice(8, 10)}.${dt.slice(5, 7)}</text>`;
    }
    // границы месяцев — жирнее (месяц читается по датам)
    let lastM = null;
    rows.forEach((r, idx) => { const m = r.date.slice(0, 7); if (m !== lastM) { lastM = m; vgrid += `<line x1="${x(idx).toFixed(1)}" y1="${padT}" x2="${x(idx).toFixed(1)}" y2="${H - padB}" stroke="var(--muted)" stroke-dasharray="2 3" opacity="0.5"/>`; } });
  } else {
    // история: недельная сетка (тонкая) + подписи по месяцам ПО ДИАГОНАЛИ
    for (const idx of mondays) vgrid += `<line x1="${x(idx).toFixed(1)}" y1="${padT}" x2="${x(idx).toFixed(1)}" y2="${H - padB}" stroke="var(--line)" opacity="0.14"/>`;
    let lastM = null;
    rows.forEach((r, idx) => { const m = r.date.slice(0, 7); if (m !== lastM) { lastM = m; const xx = x(idx).toFixed(1); vgrid += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H - padB}" stroke="var(--muted)" stroke-dasharray="2 3" opacity="0.45"/>`; xlab += `<text x="${xx}" y="${H - padB + 12}" class="se-axis se-mo" text-anchor="end" transform="rotate(-40 ${xx} ${H - padB + 12})">${SE_MON[+r.date.slice(5, 7) - 1]} ${r.date.slice(2, 4)}</text>`; } });
  }

  return `<div class="se-chart"><div class="se-chart-title">${title}</div>
    <div class="se-svg-wrap"><svg viewBox="0 0 ${W} ${H}" class="se-svg" data-chart="${chartId}" preserveAspectRatio="xMidYMid meet">
      ${bands}${hgrid}${vgrid}${xlab}${milestones}
      <polyline points="${poly(svals, sMax)}" fill="none" stroke="${SE_COL.stock}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.8"/>
      <polyline points="${poly(pvals, pMax)}" fill="none" stroke="${SE_COL.price}" stroke-width="1.3" stroke-dasharray="5 3" opacity="0.9"/>
      <polyline points="${poly(dvals, dMax)}" fill="none" stroke="${SE_COL.demand}" stroke-width="1.6"/>
      <line class="se-cursor" x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="var(--text)" stroke-width="1" opacity="0"/>
      ${bandLabels}${favRibbon}${deliv}${yAxes}
    </svg></div>
    <div class="se-legend">
      <span><i style="background:${SE_COL.demand}"></i>${lab.demand} (лев. ось, от 0)</span>
      <span><i style="background:${SE_COL.price}"></i>цена ₽ (прав. ось, от 0)</span>
      <span><i style="background:${SE_COL.stock}"></i>${lab.stock} (крайняя прав. ось, от 0)</span>${(labels.deliveries && labels.deliveries.length) ? `<span><i style="background:${SE_COL.stock};clip-path:polygon(50% 0,0 100%,100% 100%)"></i>▲ поставки частями · <span style="color:#f59e0b">┊</span> крайний срок подсорта</span>` : ''}
    </div>
  </div>`;
}

// агрегирование дневного ряда прогноза до день/неделя/месяц
// агрегирование дневного плана + расчёт ЗАКАЗОВ с лагом: заказ размещается за ~lag
// дней ДО выкупа (товар едет к покупателю). Заказы[день] = выкупы[день+lag] / %выкупа.
function seasonAgg(rows, gran, buyout) {
  const ordFactor = 1 / ((buyout || 40) / 100);
  const salesByDate = {}; rows.forEach((r) => { salesByDate[r.date] = +r.plannedOrders || 0; });
  const addD = (iso, k) => new Date(Date.parse(iso + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
  const daily = rows.map((r) => ({
    date: r.date, stage: r.stage, favorable: !!r.favorable,
    units: Math.round(+r.plannedOrders || 0), // выкупы (продажи)
    orders: Math.round((salesByDate[addD(r.date, SEASON_LAG)] || 0) * ordFactor), // заказы (сдвиг на лаг)
    price: Math.round(+r.price || 0),
  }));
  if (gran === 'day') return daily.map((d) => ({ label: seFmtD(d.date), ...d }));
  const buckets = new Map();
  for (const r of daily) {
    let key, label;
    if (gran === 'month') { key = r.date.slice(0, 7); label = seMonthLabel(key); }
    else { const d = new Date(r.date + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); key = d.toISOString().slice(0, 10); label = 'нед. ' + seFmtD(key); }
    let b = buckets.get(key);
    if (!b) { b = { label, units: 0, orders: 0, priceSum: 0, priceDays: 0, favorable: false, stages: {} }; buckets.set(key, b); }
    b.units += r.units; b.orders += r.orders;
    if (r.price > 0) { b.priceSum += r.price; b.priceDays++; }
    if (r.favorable) b.favorable = true;
    b.stages[r.stage] = (b.stages[r.stage] || 0) + 1;
  }
  return [...buckets.values()].map((b) => ({
    label: b.label,
    stage: Object.entries(b.stages).sort((a, c) => c[1] - a[1])[0]?.[0] || '',
    favorable: b.favorable, units: Math.round(b.units), orders: Math.round(b.orders),
    price: b.priceDays ? Math.round(b.priceSum / b.priceDays) : 0,
  }));
}

function seasonTableBlock(p) {
  const buyout = seasonBuyoutOf(seasonSelArticle);
  const rows = seasonAgg(p.forecastDaily || [], seasonGran, buyout);
  const total = rows.reduce((s, r) => s + r.units, 0);
  const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
  const gbtn = (g, t) => `<button class="btn se-gran${seasonGran === g ? ' active' : ''}" type="button" data-gran="${g}">${t}</button>`;
  return `<div class="se-table-head">
      <b>План продаж по ${seasonGran === 'day' ? 'дням' : seasonGran === 'week' ? 'неделям' : 'месяцам'}</b>
      <span class="se-gran-group">${gbtn('day', 'дни')}${gbtn('week', 'недели')}${gbtn('month', 'месяцы')}</span>
    </div>
    <div class="matrix-scroll"><table class="matrix-table se-plan-table">
      <thead><tr><th>Период</th><th>Этап сезона</th><th class="num" title="MPStats «продажи» = выкупы. База для производства.">Выкупы, шт</th><th class="num" title="Заказы = выкупы через ~${SEASON_LAG} дн ÷ %выкупа (лаг «заказ→доставка→выкуп»).">Заказы, шт</th><th class="num">Цена, ₽</th><th>Благопр.</th></tr></thead>
      <tbody>${rows.map((r) => { const c = PHASE_COLORS[r.stage]; return `<tr style="background:${c ? c.row : 'transparent'}"><td>${r.label}</td><td>${r.stage || '—'}</td><td class="num">${r.units.toLocaleString('ru')}</td><td class="num se-orders">${r.orders.toLocaleString('ru')}</td><td class="num">${r.price ? r.price.toLocaleString('ru') : '—'}</td><td>${r.favorable ? '⭐' : ''}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><th colspan="2">ИТОГО</th><th class="num">${total.toLocaleString('ru')}</th><th class="num se-orders">${totalOrders.toLocaleString('ru')}</th><th colspan="2"></th></tr></tfoot>
    </table></div>`;
}

function bindSeasonView(p) {
  document.querySelectorAll('.se-gran').forEach((b) => b.addEventListener('click', () => {
    seasonGran = b.dataset.gran;
    const box = document.getElementById('se-table');
    if (box) box.innerHTML = seasonTableBlock(p);
    bindSeasonView(p);
  }));
  const bo = document.getElementById('se-buyout');
  bo?.addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(100, +e.target.value || 40));
    const a = (state.articles || []).find((x) => x.id === seasonSelArticle);
    if (a) { a.buyoutPct = v; dirty = true; setStatus(); }
    renderSeasonView(seasonSelArticle); // пересчитать заказы в сводке и таблице
  });
  document.querySelectorAll('.se-svg[data-chart]').forEach((svg) => attachSeasonTip(svg));
}

// ---------- ЮНИТ-ЭКОНОМИКА ----------
const unitExpanded = new Set(); // id артикулов с раскрытой деталью
let unitSettingsOpen = false;   // раскрыт ли блок глобальных параметров
const uFmtR = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('ru') + ' ₽');
const uFmtP = (v) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(1).replace(/\.0$/, '') + '%');

// Автосохранение юнит-данных: дебаунс PUT /api/state (без пересчёта расписания и
// перерисовки), чтобы введённое не терялось при перезагрузке страницы.
let unitSaveT;
function unitPersist() {
  clearTimeout(unitSaveT);
  unitSaveT = setTimeout(() => {
    api('/api/state', { method: 'PUT', body: JSON.stringify(state) })
      .then(() => { dirty = false; setStatus(); })
      .catch(() => { /* оставляем dirty — сохранится общей кнопкой */ });
  }, 700);
}

// ── Привязка к карточкам WB (габариты) + расчёт логистики по тарифам ──
let wbCards = null, wbCardsLoading = false, wbHasToken = null;
function ensureWbCards() {
  if (wbHasToken == null) api('/api/wb/status').then((r) => { wbHasToken = !!r.hasToken; if (activeTab === 'unit') renderUnit(); }).catch(() => { wbHasToken = false; });
  if (wbCards != null || wbCardsLoading) return;
  wbCardsLoading = true;
  api('/api/wb/cards').then((r) => { wbCards = r.cards || []; wbCardsLoading = false; if (activeTab === 'unit') renderUnit(); })
    .catch(() => { wbCards = []; wbCardsLoading = false; });
}
// Привязать карточку WB к артикулу: тянем логистику по nmID и складываем в a.unit.wb.
async function wbLinkArticle(a, nmID, days) {
  const d = days || (a.unit && a.unit.wb && a.unit.wb.storageDays) || 60;
  try {
    const r = await api(`/api/wb/logistics?nmID=${encodeURIComponent(nmID)}&days=${d}`);
    if (!r.logistics || r.volumeL == null) { toast('У карточки нет габаритов', true); return; }
    const card = (wbCards || []).find((c) => String(c.nmID) === String(nmID));
    a.unit = a.unit || {};
    a.unit.wb = {
      nmID: +nmID, vendorCode: card ? card.vendorCode : '',
      volumeL: r.volumeL, warehouse: r.warehouse, tariffDate: r.tariffDate, storageDays: d,
      deliveryPerOrder: r.logistics.deliveryPerOrder,
      returnLogistics: r.logistics.returnLogistics,
      storageTotal: r.logistics.storageTotal,
    };
    dirty = true; unitPersist(); renderUnit();
  } catch (e) { toast('Ошибка логистики WB: ' + e.message, true); }
}

// Параметры движка (доли/₽) из глобальных настроек + переопределений артикула.
function unitPr(a) {
  const g = state.unit || {};
  const o = (a && a.unit && a.unit.over) || {};
  const val = (k, d) => { const v = o[k] != null ? +o[k] : +g[k]; return Number.isFinite(v) ? v : d; };
  return unitParams({
    commission: val('commission', 35.7) / 100, spp: val('spp', 4) / 100, wallet: val('wallet', 2) / 100,
    acquiring: val('acquiring', 4.7) / 100, tax: val('tax', 2) / 100,
    drr_launch: val('drrLaunch', 30) / 100, drr_steady: val('drrSteady', 8) / 100,
    extra: val('extra', 0) / 100, opexShare: val('opexShare', 50) / 100,
    logisticsPvz: val('logisticsPvz', 0), returnLogistics: val('returnLogistics', 0),
    storage: val('storage', 0), acceptanceTariff: val('acceptanceTariff', 0),
    m_min: val('mMin', 25) / 100, m_max: val('mMax', 30) / 100,
  });
}
// Полный расчёт по артикулу (базовая цена/скидка/выкуп/фаза ДРР/плановая вилка).
function unitAnalyze(a) {
  const u = a.unit || {};
  const pr = unitPr(a);
  // Логистика/хранение из WB-тарифов (если артикул привязан) перекрывают глобальные.
  const wb = u.wb;
  if (wb) {
    if (wb.deliveryPerOrder != null) pr.logisticsPvz = wb.deliveryPerOrder;
    if (wb.returnLogistics != null) pr.returnLogistics = wb.returnLogistics;
    if (wb.storageTotal != null) pr.storage = wb.storageTotal;
  }
  const drr = u.drrPhase === 'launch' ? pr.drr_launch : pr.drr_steady;
  const inp = {
    pr, drr, buyout: (a.buyoutPct || 40) / 100,
    basePrice: u.basePrice, sellerDiscount: (u.sellerDiscount || 0) / 100,
    cost: u.cost || 0, logisticsToWb: u.logisticsToWb || 0, acceptanceCoef: u.acceptanceCoef == null ? 1 : u.acceptanceCoef,
  };
  if (u.target && u.target.mode === 'profit' && u.target.profit != null) inp.targetProfit = u.target.profit;
  else if (u.target && u.target.margin != null) inp.targetMargin = (u.target.margin || 0) / 100;
  return analyze(inp);
}

function renderUnit() {
  const root = document.getElementById('unit');
  const arts = articlesSorted();
  const g = state.unit || {};
  ensureWbCards();
  const wbDatalist = wbCards ? `<datalist id="wb-cards">${wbCards.map((c) => `<option value="${seEsc(c.vendorCode)}">${c.volumeL != null ? c.volumeL + ' л' : 'нет габаритов'} · nmID ${c.nmID}</option>`).join('')}</datalist>` : '';
  const gi = (k, label, suf = '%') => `<label class="u-gi"><span>${label}</span><input type="number" step="0.1" min="0" data-ug="${k}" value="${g[k] ?? ''}"><i>${suf}</i></label>`;
  const settings = `<details class="u-settings"${unitSettingsOpen ? ' open' : ''}>
    <summary>Параметры ВБ, налоги и расходы (применяются ко всем артикулам)</summary>
    <div class="u-subhead">Услуги ВБ, %</div>
    <div class="u-grid">${gi('commission', 'Комиссия ВБ (от S)')}${gi('acquiring', 'Эквайринг (от Pб)')}${gi('drrLaunch', 'ДРР запуск (от Pб)')}${gi('drrSteady', 'ДРР выход (от Pб)')}</div>
    <div class="u-subhead">Скидки покупателю, % (выплату продавцу не уменьшают)</div>
    <div class="u-grid">${gi('spp', 'СПП')}${gi('wallet', 'WB Кошелёк')}</div>
    <div class="u-subhead">Логистика / хранение / приёмка, ₽</div>
    <div class="u-grid">${gi('logisticsPvz', 'Логистика до ПВЗ', '₽/зак')}${gi('returnLogistics', 'Обратная логистика', '₽/зак')}${gi('storage', 'Хранение', '₽/ед')}${gi('acceptanceTariff', 'Тариф приёмки', '₽/ед')}</div>
    <div class="u-subhead">Налоги и расходы</div>
    <div class="u-grid">${gi('tax', 'Налог (от оборота Pб)')}${gi('extra', 'Доп. расходы (от S)')}${gi('opexShare', 'Опер. расходы (доля валовой)')}${gi('mMin', 'Целевая маржа, низ')}${gi('mMax', 'Целевая маржа, верх')}</div>
    <div class="mini">S — цена после скидки продавца (база комиссии, выплаты, знаменатель маржи). Pб — конечная цена покупателя (после СПП и Кошелька; база эквайринга/налога). Чистая прибыль = ${g.opexShare ?? 50}% валовой (остаток — опер.расходы).</div>
  </details>`;

  const rows = arts.map((a) => {
    const u = a.unit || {};
    const r = unitAnalyze(a);
    const marg = r.unit ? r.unit.marginGross : null; // маржинальность = валовая/S
    const net = r.unit ? r.unit.net : null;
    const cls = marg == null ? '' : marg < 0 ? 'bad' : marg >= (g.mMin || 25) / 100 ? 'good' : 'warn';
    const cor = r.corridor.loS != null ? `${uFmtR(r.corridor.loS)}–${uFmtR(r.corridor.hiS)}` : '—';
    const sVal = u.basePrice != null ? Math.round(u.basePrice * (1 - (u.sellerDiscount || 0) / 100)) : '';
    const open = unitExpanded.has(a.id);
    const main = `<tr class="u-row${open ? ' open' : ''}" data-uexp="${a.id}">
      <td class="u-name">${open ? '▾' : '▸'} ${a.id} — ${seEsc(a.name)}</td>
      <td class="num"><input class="u-in" type="number" min="0" step="1" data-uf="cost" data-id="${a.id}" value="${u.cost || ''}" placeholder="0"></td>
      <td class="num"><input class="u-in" type="number" min="0" step="1" data-uf="logisticsToWb" data-id="${a.id}" value="${u.logisticsToWb || ''}" placeholder="0"></td>
      <td class="num"><input class="u-in" type="number" min="0" step="1" data-uf="basePrice" data-id="${a.id}" value="${u.basePrice ?? ''}" placeholder="—"></td>
      <td class="num"><input class="u-in u-in-sm" type="number" min="0" max="99" step="1" data-uf="sellerDiscount" data-id="${a.id}" value="${u.sellerDiscount || ''}" placeholder="0"></td>
      <td class="num"><input class="u-in" type="number" min="0" step="1" data-uf="priceS" data-id="${a.id}" value="${sVal}" placeholder="—" title="Цена после скидки. Правка меняет размер скидки (базовая — статична)."></td>
      <td class="num ${cls}">${uFmtP(marg)}</td>
      <td class="num ${net != null && net < 0 ? 'bad' : ''}">${uFmtR(net)}</td>
      <td class="num">${cor}</td>
      <td class="num">${uFmtR(r.breakeven.S)}</td>
    </tr>`;
    return main;
  }).join('');
  // Деталь раскрытых артикулов — ОТДЕЛЬНЫМИ блоками под таблицей (полная ширина →
  // карточки корректно стекаются на мобильном, таблица скроллится независимо).
  const details = arts.filter((a) => unitExpanded.has(a.id)).map((a) => `<div class="u-detail-block">
      <div class="u-detail-head"><b>${a.id} — ${seEsc(a.name)}</b><button class="btn u-toggle" data-uclose="${a.id}">свернуть ▲</button></div>
      ${unitDetail(a, unitAnalyze(a))}</div>`).join('');

  root.innerHTML = `<div class="panel u-panel">
    <div class="subhead"><h3>Юнит-экономика по артикулам</h3></div>
    ${settings}
    <div class="u-tablewrap"><table class="matrix-table u-table">
      <thead><tr>
        <th>Артикул</th>
        <th class="num" title="Себестоимость, ₽">Себест.</th>
        <th class="num" title="Логистика до склада ВБ (first-mile), ₽/ед — суммируется с себестоимостью">Лог.→ВБ</th>
        <th class="num" title="Базовая цена до скидки продавца. Пусто — считаем только коридор/безубыток.">Базовая цена</th>
        <th class="num" title="Скидка продавца, %">Скидка</th>
        <th class="num" title="Цена после скидки продавца (S). Правка меняет размер скидки; базовая цена статична.">Цена со скидкой (S)</th>
        <th class="num" title="Маржинальность = валовая прибыль / цена после скидки (S)">Маржинальность</th>
        <th class="num" title="Чистая прибыль на единицу, ₽">Чистая/ед</th>
        <th class="num" title="Цена после скидки (S) под целевую валовую маржинальность mMin–mMax">Коридор цены до СПП (S)</th>
        <th class="num" title="Цена после скидки (S), при которой прибыль = 0">Безубыток (S)</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="10" class="mini">Нет артикулов — добавь во вкладке «Данные».</td></tr>'}</tbody>
    </table></div>
    <div class="mini">Расчёт мгновенный. Правки сохраняются кнопкой «Сохранить» в шапке. Клик по строке — полный каскад P&L и обратный расчёт.</div>
    ${details}
  </div>${wbDatalist}`;
  bindUnit();
}

// Полный каскад P&L + переключатели для одного артикула.
function unitDetail(a, r) {
  const u = a.unit || {};
  const pr = r.pr;
  const un = r.unit;
  const drrPct = uFmtP(un ? un.drr : (u.drrPhase === 'launch' ? pr.drr_launch : pr.drr_steady));
  const line = (name, val, extra = '', cls = '') => `<tr><td>${name}${extra ? ` <span class="u-ex">${extra}</span>` : ''}</td><td class="num ${cls}">${val}</td></tr>`;
  const neg = (v) => (v ? '−' + uFmtR(v) : uFmtR(0));

  let waterfall = '<div class="mini">Укажи базовую цену в строке — появится полный каскад.</div>';
  if (un) {
    waterfall = `<table class="u-art"><tbody>
      ${line('Базовая цена', uFmtR(r.input.basePrice))}
      ${line('− Скидка продавца', uFmtP((u.sellerDiscount || 0) / 100), '', 'bad')}
      ${line('= Цена после скидки (S)', '<b>' + uFmtR(un.S) + '</b>', 'база комиссии/выплаты')}
      ${line('− СПП', uFmtP(pr.spp))}
      ${line('= Цена после СПП', uFmtR(un.priceAfterSpp))}
      ${line('− WB Кошелёк', uFmtP(pr.wallet))}
      ${line('= Конечная цена покупателя (Pб)', '<b>' + uFmtR(un.buyerPrice) + '</b>', 'база эквайринга/налога')}
      <tr class="u-sep"><td colspan="2">Услуги ВБ (на 1 выкуп)</td></tr>
      ${line('Комиссия ВБ', neg(un.commission), uFmtP(pr.commission) + ' от S', 'bad')}
      ${line('Эквайринг', neg(un.acquiring), uFmtP(pr.acquiring) + ' от Pб', 'bad')}
      ${line('Реклама (ДРР)', neg(un.ad), drrPct + ' от Pб', 'bad')}
      ${line('Логистика (с учётом выкупа)', neg(un.logistics), 'выкуп ' + uFmtP(un.buyout), 'bad')}
      ${line('Хранение', neg(un.storage), '₽/ед', 'bad')}
      ${line('Платная приёмка', neg(un.acceptance), '×' + (u.acceptanceCoef == null ? 1 : u.acceptanceCoef), 'bad')}
      ${line('Итого услуги ВБ', neg(un.wbServices), '', 'bad')}
      ${line('= Перечисления на р/с', '<b>' + uFmtR(un.payout) + '</b>')}
      <tr class="u-sep"><td colspan="2">Затраты и налоги</td></tr>
      ${line('Полная себестоимость', neg(un.fullCost), 'себест.+лог.до ВБ', 'bad')}
      ${line('Налог', neg(un.tax), uFmtP(pr.tax) + ' от Pб', 'bad')}
      ${line('Доп. расходы', neg(un.extra), uFmtP(pr.extra) + ' от S', 'bad')}
      <tr class="u-tot"><td>Валовая прибыль</td><td class="num ${un.gross < 0 ? 'bad' : ''}">${uFmtR(un.gross)}</td></tr>
      ${line('Опер. расходы', uFmtR(-un.opex), uFmtP(pr.opexShare) + ' валовой', un.opex >= 0 ? 'bad' : '')}
      <tr class="u-tot"><td>ЧИСТАЯ прибыль</td><td class="num ${un.net < 0 ? 'bad' : 'good'}"><b>${uFmtR(un.net)}</b></td></tr>
      ${line('Маржинальность (валовая /S)', '<b>' + uFmtP(un.marginGross) + '</b>')}
      ${line('Чистая маржинальность (/S)', uFmtP(un.marginNet), 'для справки')}
      ${line('Рентабельность (чистая /себест.)', uFmtP(un.roi))}
    </tbody></table>`;
  }

  const tmode = u.target && u.target.mode === 'profit' ? 'profit' : 'margin';
  const phase = u.drrPhase === 'launch' ? 'launch' : 'steady';
  const rev = r.reverse || {};
  const dsc = (u.sellerDiscount || 0);
  const baseHint = (base) => (base != null ? ` <span class="mini">(при скидке ${dsc}% базовая ${uFmtR(base)})</span>` : '');
  const revLine = tmode === 'profit'
    ? (rev.profit ? `Под чистую прибыль <b>${uFmtR(rev.profit.target)}</b>/ед → цена после скидки S = <b class="good">${uFmtR(rev.profit.S)}</b>${rev.profit.S != null ? baseHint(rev.profit.base) : ' — недостижимо'}` : '—')
    : (rev.margin ? `Под валовую маржинальность <b>${uFmtP(rev.margin.target)}</b> → цена после скидки S = <b class="good">${uFmtR(rev.margin.S)}</b>${rev.margin.S != null ? baseHint(rev.margin.base) : ' — недостижимо'}` : '—');

  const sens = r.sensitivity.map((s) => `<tr class="${s.delta === 0 ? 'hl' : ''}"><td class="num">${uFmtR(s.base)}</td><td class="num">${uFmtR(s.S)}</td><td class="num ${s.net < 0 ? 'bad' : ''}">${uFmtR(s.net)}</td><td class="num">${uFmtP(s.margin)}</td></tr>`).join('');

  return `<div class="u-detail">
    <div class="u-detail-grid">
      <div class="u-card u-card-wide">
        <div class="u-card-h">Полный каскад P&L ${un ? `<span class="mini">(ДРР ${drrPct}, выкуп ${uFmtP((a.buyoutPct || 40) / 100)})</span>` : ''}</div>
        ${waterfall}
      </div>
      <div class="u-card">
        <div class="u-card-h">Обратный расчёт цены</div>
        <div class="u-toggle-row">
          <span class="mini">от:</span>
          <button class="btn u-toggle${tmode === 'margin' ? ' active' : ''}" data-utmode="margin" data-id="${a.id}">валовой маржинальности</button>
          <button class="btn u-toggle${tmode === 'profit' ? ' active' : ''}" data-utmode="profit" data-id="${a.id}">чистой прибыли</button>
        </div>
        <div class="u-target-in">
          ${tmode === 'profit'
            ? `<label>Целевая чистая прибыль/ед <input class="u-in" type="number" min="0" step="1" data-uf="target.profit" data-id="${a.id}" value="${u.target && u.target.profit != null ? u.target.profit : ''}" placeholder="₽"></label>`
            : `<label>Целевая валовая маржинальность <input class="u-in u-in-sm" type="number" min="0" step="1" data-uf="target.margin" data-id="${a.id}" value="${u.target ? u.target.margin : 25}"> %</label>`}
        </div>
        <div class="u-rev">${revLine}</div>
        <div class="u-card-h" style="margin-top:12px">Коридор и безубыток (цена после скидки S)</div>
        <div class="mini">Целевая маржинальность ${uFmtP(pr.m_min)}–${uFmtP(pr.m_max)} → S <b class="good">${r.corridor.loS != null ? uFmtR(r.corridor.loS) + '–' + uFmtR(r.corridor.hiS) : 'недостижимо'}</b></div>
        <div class="mini">Безубыток: S <b>${uFmtR(r.breakeven.S)}</b></div>
        <div class="u-toggle-row" style="margin-top:10px">
          <span class="mini">Фаза ДРР:</span>
          <button class="btn u-toggle${phase === 'steady' ? ' active' : ''}" data-uphase="steady" data-id="${a.id}">выход (${uFmtP(pr.drr_steady)})</button>
          <button class="btn u-toggle${phase === 'launch' ? ' active' : ''}" data-uphase="launch" data-id="${a.id}">запуск (${uFmtP(pr.drr_launch)})</button>
        </div>
        <div class="u-target-in"><label>Выкуп, % <input class="u-in u-in-sm" type="number" min="1" max="100" step="1" data-ubuyout="1" data-id="${a.id}" value="${a.buyoutPct || 40}"></label> <span class="mini">(влияет на логистику)</span></div>
        <div class="u-target-in"><label>Коэф. приёмки <input class="u-in u-in-sm" type="number" min="0" step="0.5" data-uf="acceptanceCoef" data-id="${a.id}" value="${u.acceptanceCoef == null ? 1 : u.acceptanceCoef}"></label></div>
      </div>
      <div class="u-card">
        <div class="u-card-h">Чувствительность по базовой цене</div>
        <table class="u-art"><thead><tr><th class="num">Базовая</th><th class="num">S</th><th class="num">Чистая</th><th class="num">Маржинальность</th></tr></thead><tbody>${sens}</tbody></table>
      </div>
      ${unitWbCard(a)}
    </div>
  </div>`;
}

// Карточка «Логистика ВБ» в детали артикула (привязка к nmID + расчёт по тарифам).
function unitWbCard(a) {
  const wb = a.unit && a.unit.wb;
  const tokenWarn = wbHasToken === false ? '<div class="mini bad">Нет WB-токена в planner/data/.env (WB_API_TOKEN или Wildberries_API).</div>' : '';
  const loading = wbCards == null ? '<div class="mini">Загружаю карточки WB…</div>' : '';
  const linked = wb ? `
    <div class="mini">nmID ${wb.nmID} · <b>${seEsc(wb.vendorCode || '')}</b> · объём <b>${wb.volumeL} л</b> · ${seEsc(wb.warehouse || '—')} · тариф ${wb.tariffDate || ''}</div>
    <table class="u-art"><tbody>
      <tr><td>Прямая логистика</td><td class="num">${uFmtR(wb.deliveryPerOrder)} <span class="mini">/заказ</span></td></tr>
      <tr><td>Обратная логистика</td><td class="num">${uFmtR(wb.returnLogistics)} <span class="mini">/возврат</span></td></tr>
      <tr><td>Хранение (${wb.storageDays || 60} дн)</td><td class="num">${uFmtR(wb.storageTotal)} <span class="mini">/ед</span></td></tr>
    </tbody></table>
    <div class="mini">→ в расчёт: на 1 выкуп = (прямая + обратная×(1−выкуп))/выкуп при выкупе ${a.buyoutPct || 40}%.</div>
    <div class="u-toggle-row" style="margin-top:8px">
      <label class="mini">Дней хранения <input class="u-in u-in-sm" type="number" min="1" data-wbdays="1" data-id="${a.id}" value="${wb.storageDays || 60}"></label>
      <button class="btn u-toggle" data-wbrefresh="1" data-id="${a.id}">↻ обновить</button>
      <button class="btn u-toggle" data-wbunlink="1" data-id="${a.id}">отвязать</button>
    </div>` : '<div class="mini">Привяжи карточку WB — подтянем объём упаковки и рассчитаем логистику/хранение по тарифам склада Коледино.</div>';
  return `<div class="u-card">
    <div class="u-card-h">Логистика ВБ (тарифы, склад Коледино)</div>
    ${tokenWarn}${loading}
    <div class="u-target-in"><label>Артикул WB <input class="u-in" list="wb-cards" data-wblink="1" data-id="${a.id}" value="${wb ? seEsc(wb.vendorCode || '') : ''}" placeholder="vendorCode…"></label></div>
    ${linked}
  </div>`;
}

function bindUnit() {
  const g = () => state.unit;
  const findA = (el) => state.articles.find((x) => x.id === el.dataset.id);
  document.querySelectorAll('input[data-ug]').forEach((inp) => inp.addEventListener('change', (e) => {
    const k = e.target.dataset.ug; g()[k] = Math.max(0, +e.target.value || 0); dirty = true; unitPersist(); renderUnit();
  }));
  // привязка карточки WB (по vendorCode из datalist)
  document.querySelectorAll('input[data-wblink]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = findA(e.target); if (!a) return;
    const vc = e.target.value.trim();
    if (!vc) { if (a.unit) a.unit.wb = null; dirty = true; unitPersist(); renderUnit(); return; }
    const card = (wbCards || []).find((c) => c.vendorCode === vc);
    if (!card) { toast('Карточка WB не найдена: ' + vc, true); return; }
    wbLinkArticle(a, card.nmID);
  }));
  document.querySelectorAll('input[data-wbdays]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = findA(e.target); if (!a || !a.unit || !a.unit.wb) return;
    wbLinkArticle(a, a.unit.wb.nmID, Math.max(1, +e.target.value || 60));
  }));
  document.querySelectorAll('button[data-wbrefresh]').forEach((b) => b.addEventListener('click', () => {
    const a = findA(b); if (!a || !a.unit || !a.unit.wb) return;
    wbLinkArticle(a, a.unit.wb.nmID, a.unit.wb.storageDays);
  }));
  document.querySelectorAll('button[data-wbunlink]').forEach((b) => b.addEventListener('click', () => {
    const a = findA(b); if (!a) return;
    if (a.unit) a.unit.wb = null; dirty = true; unitPersist(); renderUnit();
  }));
  const det = document.querySelector('.u-settings');
  if (det) det.addEventListener('toggle', () => { unitSettingsOpen = det.open; });
  document.querySelectorAll('tr[data-uexp]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('input,button,label')) return;
    const id = tr.dataset.uexp;
    if (unitExpanded.has(id)) unitExpanded.delete(id); else unitExpanded.add(id);
    renderUnit();
  }));
  document.querySelectorAll('button[data-uclose]').forEach((b) => b.addEventListener('click', () => {
    unitExpanded.delete(b.dataset.uclose); renderUnit();
  }));
  document.querySelectorAll('input.u-in[data-uf]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = state.articles.find((x) => x.id === e.target.dataset.id); if (!a) return;
    a.unit = a.unit || {}; a.unit.target = a.unit.target || { mode: 'margin', margin: 25, profit: null };
    const f = e.target.dataset.uf; const raw = e.target.value.trim();
    const nv = raw === '' ? null : Math.max(0, +raw || 0);
    if (f === 'cost') a.unit.cost = nv || 0;
    else if (f === 'logisticsToWb') a.unit.logisticsToWb = nv || 0;
    else if (f === 'basePrice') a.unit.basePrice = nv;
    else if (f === 'sellerDiscount') a.unit.sellerDiscount = Math.min(99, nv || 0);
    else if (f === 'priceS') {
      // Правка цены после скидки (S): базовая статична → пересчитываем размер скидки.
      const S = nv || 0; const base = a.unit.basePrice;
      if (base && base > 0) a.unit.sellerDiscount = Math.max(0, Math.min(99, Math.round((1 - S / base) * 100)));
      else { a.unit.basePrice = S || null; a.unit.sellerDiscount = 0; } // нет базовой — S становится базовой
    }
    else if (f === 'acceptanceCoef') a.unit.acceptanceCoef = nv == null ? 1 : nv;
    else if (f === 'target.margin') a.unit.target.margin = nv == null ? 0 : nv;
    else if (f === 'target.profit') a.unit.target.profit = nv;
    dirty = true; unitPersist(); renderUnit();
  }));
  document.querySelectorAll('input[data-ubuyout]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = state.articles.find((x) => x.id === e.target.dataset.id); if (!a) return;
    a.buyoutPct = Math.max(1, Math.min(100, +e.target.value || 40)); dirty = true; unitPersist(); renderUnit();
  }));
  document.querySelectorAll('button[data-utmode]').forEach((b) => b.addEventListener('click', () => {
    const a = state.articles.find((x) => x.id === b.dataset.id); if (!a) return;
    a.unit = a.unit || {}; a.unit.target = a.unit.target || { mode: 'margin', margin: 25, profit: null };
    a.unit.target.mode = b.dataset.utmode; dirty = true; unitPersist(); renderUnit();
  }));
  document.querySelectorAll('button[data-uphase]').forEach((b) => b.addEventListener('click', () => {
    const a = state.articles.find((x) => x.id === b.dataset.id); if (!a) return;
    a.unit = a.unit || {}; a.unit.drrPhase = b.dataset.uphase; dirty = true; unitPersist(); renderUnit();
  }));
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
          <div class="field"><label title="Доля заказов, которые выкупают. Для одежды ~30–60%. Заказы = выкупы / (%выкупа)">% выкупа</label><input data-art="${i}" data-f="buyoutPct" type="number" min="1" max="100" value="${a.buyoutPct ?? 40}" style="width:80px"></div>
        </div>
        <div class="field"><label>Размерный ряд (через запятую)</label><input data-art="${i}" data-f="sizes" value="${(a.sizes || []).join(', ')}"></div>
        <div class="field"><label>Цвета и образцы ткани (название · образец 80×40 · № планшета · № цвета)</label>
          <div class="swatch-row">${(a.colors || []).map((c, ci) => { const fi = (a.fabricInfo && a.fabricInfo[c]) || {}; return `<div class="swatch-item" data-swatch-art="${i}" data-swatch-idx="${ci}">
            <span class="swatch-drag" draggable="true" data-color-drag data-art="${i}" data-idx="${ci}" title="перетащи, чтобы изменить порядок">⠿</span>
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

// перестановка порядка цветов перетаскиванием (ручка ⠿).
// Порядок хранится в a.colors; все листы итерируют a.colors, а fabricInfo и
// матрицы партий ключуются по имени цвета — поэтому достаточно переставить массив.
let colorDragSrc = null; // { art, idx }
function bindColorDnD(root) {
  const mark = () => { dirty = true; setStatus(); };
  root.querySelectorAll('[data-color-drag]').forEach((h) => {
    h.addEventListener('dragstart', (e) => {
      colorDragSrc = { art: +h.dataset.art, idx: +h.dataset.idx };
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(h.dataset.idx)); } catch (_) {}
      h.closest('.swatch-item')?.classList.add('dragging');
    });
    h.addEventListener('dragend', () => {
      colorDragSrc = null;
      root.querySelectorAll('.swatch-item.dragging,.swatch-item.drop-target')
        .forEach((el) => el.classList.remove('dragging', 'drop-target'));
    });
  });
  root.querySelectorAll('.swatch-item').forEach((item) => {
    item.addEventListener('dragover', (e) => {
      if (!colorDragSrc || +item.dataset.swatchArt !== colorDragSrc.art) return; // только внутри одного артикула
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!colorDragSrc || +item.dataset.swatchArt !== colorDragSrc.art) return;
      const a = state.articles[colorDragSrc.art];
      const from = colorDragSrc.idx;
      const to = +item.dataset.swatchIdx;
      if (a && from !== to && from >= 0 && to >= 0 && from < a.colors.length) {
        const [moved] = a.colors.splice(from, 1);
        a.colors.splice(to, 0, moved);
        colorDragSrc = null;
        mark(); renderData();
      }
    });
  });
}

function bindDataEvents() {
  const root = document.getElementById('data-forms');
  const mark = () => { dirty = true; setStatus(); };

  root.querySelectorAll('input[data-art]').forEach((inp) => inp.addEventListener('change', (e) => {
    const a = state.articles[+e.target.dataset.art]; const f = e.target.dataset.f;
    if (f === 'colors') { a.colors = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); pruneArticlePartias(a); mark(); renderData(); return; }
    else if (f === 'sizes') { a.sizes = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); pruneArticlePartias(a); mark(); renderData(); return; }
    else if (f === 'fabricPerUnit') a.fabricPerUnit = +e.target.value || 1.6;
    else if (f === 'fabricPricePerMeter') a.fabricPricePerMeter = Math.max(0, +e.target.value || 0);
    else if (f === 'buyoutPct') a.buyoutPct = Math.max(1, Math.min(100, +e.target.value || 40));
    else a[f] = e.target.value; mark();
  }));
  root.querySelectorAll('input[data-artimg]').forEach((inp) => inp.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1200000) { toast('Изображение слишком большое (макс ~1 МБ)', true); return; }
    const a = state.articles[+e.target.dataset.art];
    const c = decodeURIComponent(e.target.dataset.color);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        // сохраняем картинку на диск (planner/data/samples), в state кладём только путь
        const r = await api('/api/sample', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) });
        a.fabricInfo = a.fabricInfo || {}; a.fabricInfo[c] = a.fabricInfo[c] || {};
        a.fabricInfo[c].image = r.path; mark(); renderData(); toast('Образец добавлен (не забудь «Сохранить»)');
      } catch (err) { toast('Не удалось загрузить образец: ' + err.message, true); }
    };
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
  bindColorDnD(root);
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
