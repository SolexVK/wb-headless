// app.js — оболочка SPA: загрузка данных, вкладки, дашборд, формы, Гант.
import { renderGantt } from './gantt.js';
import { unitParams, analyze } from './unitCalc.js';
import { reconcilePlan, splitMatrixByShares } from './reconcile.js';
import { canonColor, aliasKey } from './colorNorm.js';

// Метка сборки — по ней в консоли браузера видно, что загружен свежий app.js
// (если после обновления её нет — браузер держит старый кэш, нужен hard-reload).
const APP_BUILD = 'apply-diagnostics-2026-08-02g';
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
  if (!res.ok) {
    // HTTP/2 (через Funnel) часто отдаёт пустой statusText → показываем код,
    // чтобы ошибка не была безымянной (напр. HTTP 404 = служба не перезапущена).
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || res.statusText || ('HTTP ' + res.status + ' ' + path));
  }
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

// ---------- права доступа (RBAC) ----------
// PERMS === null → авторизация выключена (локальная сеть) ИЛИ админ: полный доступ.
let PERMS = null;
async function loadPerms() {
  try { const me = await api('/api/me'); PERMS = (me && me.authEnabled && me.perms && !me.perms.isAdmin) ? me.perms : null; }
  catch { PERMS = null; }
}
function tabAllowed(key) { if (!PERMS) return true; const l = PERMS.tabs[key]; return l === 'view' || l === 'edit'; }
function tabEditable(key) { if (!PERMS) return true; return PERMS.tabs[key] === 'edit'; }
function canEditAny() { if (!PERMS) return true; return Object.values(PERMS.tabs).some((v) => v === 'edit'); }
async function requestAccess() {
  const msg = prompt('Что нужно открыть/дать на редактирование? (сообщение админу)', '');
  if (msg === null) return;
  try { await api('/api/access/request', { method: 'POST', body: JSON.stringify({ message: msg }) }); toast('Заявка отправлена администратору'); }
  catch (e) { toast('Не удалось отправить: ' + e.message, true); }
}
function firstAllowedTab() {
  const order = ['gantt', 'matrix', 'salesplan', 'fact', 'fabric', 'dashboard', 'season', 'unit', 'data'];
  return order.find(tabAllowed) || 'dashboard';
}
// Спрятать запрещённые вкладки, пометить листы «только просмотр» классом ro,
// скрыть глобальную кнопку «Сохранить», если редактировать нечего.
function applyAccessUI() {
  if (!PERMS) return; // полный доступ — ничего не трогаем
  for (const btn of document.querySelectorAll('.tab')) {
    const key = btn.dataset.tab;
    const vis = tabAllowed(key);
    btn.style.display = vis ? '' : 'none';
    const view = document.getElementById('view-' + key);
    if (view) {
      const ro = vis && !tabEditable(key);
      view.classList.toggle('ro', ro);
      // баннер «режим просмотра» (один раз на лист)
      let b = view.querySelector(':scope > .ro-banner');
      if (ro && !b) {
        b = document.createElement('div');
        b.className = 'ro-banner';
        b.innerHTML = '👁 Режим просмотра — изменения недоступны. '
          + '<button data-nav class="ro-req btn" style="margin-left:8px;padding:2px 10px">Запросить доступ</button>';
        b.querySelector('.ro-req').addEventListener('click', requestAccess);
        view.insertBefore(b, view.firstChild);
      } else if (!ro && b) { b.remove(); }
    }
  }
  const save = document.getElementById('btn-save');
  if (save && !canEditAny()) save.style.display = 'none';
}
// Блокировка ввода в листах «только просмотр» (класс ro на .view). Один перехватчик на
// документе — переживает перерисовки. Селекты (навигация/фильтры) не трогаем; правки
// всё равно режутся на сервере, здесь — только чтобы поля были недоступны на ввод.
function installReadonlyGuard() {
  const inRO = (el) => !!(el && el.closest && el.closest('.view.ro'));
  const isField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  const NAV_KEYS = new Set(['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Meta', 'Alt']);
  const guard = (e) => {
    const t = e.target;
    if (!inRO(t)) return;
    if (isField(t)) {
      if (e.type === 'beforeinput' || e.type === 'paste' || e.type === 'drop') { e.preventDefault(); e.stopPropagation(); return; }
      if (e.type === 'keydown') { if (!(e.ctrlKey || e.metaKey || NAV_KEYS.has(e.key))) { e.preventDefault(); e.stopPropagation(); } return; }
      if ((t.type === 'checkbox' || t.type === 'radio') && e.type === 'click') { e.preventDefault(); e.stopPropagation(); return; }
    }
    if (e.type === 'click') {
      const btn = t.closest && t.closest('button');
      if (btn && !btn.hasAttribute('data-nav')) { e.preventDefault(); e.stopPropagation(); }
    }
  };
  ['beforeinput', 'paste', 'drop', 'keydown', 'click'].forEach((ev) => document.addEventListener(ev, guard, true));
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
function stageInSeason(stageId) { if (!activeSeasonId) return true; if (!stageId) return true; const st = state.stages.find((s) => s.id === stageId); return !!st && st.seasonId === activeSeasonId; }
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
    renderGantt(document.getElementById('gantt'), sch, state, { pxPerDay, onOverride, onProgress });
  }
  else if (activeTab === 'matrix') renderMatrix();
  else if (activeTab === 'salesplan') renderSalesPlan();
  else if (activeTab === 'fact') renderFact();
  else if (activeTab === 'timing') renderTiming();
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
  const stageOrder = {}, stageDl = {}; state.stages.forEach((s, i) => { stageOrder[s.id] = i; stageDl[s.id] = s.deadline || ''; });
  const tKey = (p) => p.deadline || stageDl[p.stageId] || '9999-12-31';
  const parts = base.filter((p) => passStage(p) && passArticle(p) && passWs(p))
    .sort((x, y) => tKey(x).localeCompare(tKey(y)) || (x.workshopId || '').localeCompare(y.workshopId || '') || x.no - y.no);
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
  if (!a) { root.innerHTML = '<div class="panel"><div class="mini">Партия ссылается на удалённый артикул.</div></div>'; return; }
  const stIdx = stage ? state.stages.findIndex((s) => s.id === stage.id) + 1 : 0;
  // подпись периода: этап (legacy) или метка/срок поставки
  const periodLbl = stage ? `Этап ${stIdx}${stage.salesMonths ? ' (' + stage.salesMonths + ')' : ''}`
    : (p.deliveryTag ? `Поставка ${seEsc(p.deliveryTag)}` : 'Ручная') + (p.deadline ? ` · WB ${p.deadline.slice(8, 10)}.${p.deadline.slice(5, 7)}` : '');
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
      <div class="mini" style="margin-bottom:10px">Партия ${p.no} · <b>${a.id}</b> ${a.name} · ${periodLbl} · цех ${ws ? ws.name : 'авто'} · статус ${statusBadge(p.status)}. Введи фактически произведённое — оно уедет на склад WB (план остаётся для производства).</div>
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
// ---------- КОНТРОЛЬ СРОКОВ («тихий контроль» — список исключений) ----------
function renderTiming() {
  const root = document.getElementById('timing');
  const cyc = (schedule?.cycles || []).filter((c) => stageInSeason(c.stageId) && !c.historical);
  if (!cyc.length) { root.innerHTML = '<div class="panel"><div class="mini">Нет партий в плане. Заполни «План по размерам».</div></div>'; return; }
  const threshold = state.settings.delayThresholdDays ?? 6;
  const today = /^\d{4}-\d{2}-\d{2}$/.test(state.settings.planningDate || '') ? state.settings.planningDate : new Date().toISOString().slice(0, 10);
  const gIdx = (id) => state.stages.findIndex((z) => z.id === id) + 1;
  const pById = (id) => (state.partias || []).find((p) => p.id === id);

  const attention = cyc.filter((c) => (c.delay && c.delay.attention) || c.logistics.lateDays > 0)
    .sort((a, b) => (Number(b.logistics.lateDays > 0) - Number(a.logistics.lateDays > 0)) || ((b.delay ? b.delay.days : 0) - (a.delay ? a.delay.days : 0)));

  const actions = (c) => {
    const p = pById(c.partiaId);
    const canRescue = p && p.status === 'plan' && (c.logistics.lateDays > 0 || (c.delay && c.delay.willMiss));
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">
      <button class="btn" data-tm-done="${c.partiaId}">✓ Готово вовремя</button>
      <label style="display:flex;gap:4px;align-items:center;font-size:12px">⏱ Задержка до:
        <input type="date" data-tm-exp="${c.partiaId}" value="${(p && p.expectedReady) || ''}" style="padding:3px 5px;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px"></label>
      <button class="btn" data-tm-snooze="${c.partiaId}">Идёт по плану</button>
      ${canRescue ? `<button class="btn btn-primary" data-tm-rescue="${c.partiaId}">🛟 Показать спасение</button>` : ''}
    </div>`;
  };

  const attnItems = attention.map((c) => {
    const d = c.delay;
    let problem;
    if (d && d.state === 'overdue') problem = `<span style="color:var(--danger)">просрочена готовность: план ${fmt(c.readyDate)}, статус ещё «${c.statusRu}» (${d.overdueDays} дн без подтверждения)</span>`;
    else if (d && d.willMiss) problem = `<span style="color:var(--danger)">риск срыва: приход на WB ~${fmt(d.projWb)} позже дедлайна ${fmt(c.logistics.deadline)}</span>`;
    else if (d && d.state === 'delayed') problem = `<span style="color:#d97706">задержка: ожидается ${fmt(d.expectedReady)} (в пределах дедлайна ${fmt(c.logistics.deadline)})</span>`;
    else problem = `<span style="color:var(--danger)">план не укладывается в дедлайн: приход на WB ${fmt(c.logistics.wbArrival)} позже ${fmt(c.logistics.deadline)} (опоздание ${c.logistics.lateDays} дн)</span>`;
    return `<div style="padding:10px 0;border-top:1px solid var(--line)">
      <div><b>${c.articleId}</b> · Партия ${c.partiaNo} · ${c.workshopName}${c.own ? ' <span class="mini">свой</span>' : ''} <span class="mini">· Этап ${gIdx(c.stageId)} · ${c.units.toLocaleString('ru')} шт</span></div>
      <div class="mini" style="margin-top:2px">${problem}</div>
      ${actions(c)}
      <div id="rescue-${c.partiaId}"></div>
    </div>`;
  }).join('');

  // полный список (свёрнуто) — все партии по состоянию
  const stateBadge = (c) => {
    const d = c.delay;
    if (d && d.state === 'done') return d.days > 0 ? `<span style="color:#d97706">готово (+${d.days} дн)</span>` : '<span style="color:var(--accent-2)">готово в срок</span>';
    if (d && d.state === 'overdue') return '<span style="color:var(--danger)">просрочка</span>';
    if (d && d.state === 'delayed') return `<span style="color:#d97706">задержка до ${fmt(d.expectedReady)}</span>`;
    if (c.logistics.lateDays > 0) return `<span style="color:var(--danger)">план опаздывает</span>`;
    return '<span style="color:var(--accent-2)">в срок</span>';
  };
  const allRows = [...cyc].sort((a, b) => (a.readyDate < b.readyDate ? -1 : 1)).map((c) => `<tr>
    <td><b>${c.articleId}</b> · П${c.partiaNo}</td><td>${c.workshopName}</td><td class="mini">Этап ${gIdx(c.stageId)}</td>
    <td>${c.statusRu || '—'}</td><td>${fmt(c.readyDate)}</td><td>${fmt(c.logistics.deadline)}</td><td>${stateBadge(c)}</td>
  </tr>`).join('');

  root.innerHTML = `
    <div class="panel"><div class="mini">Тихий контроль: тревожим только по исключениям. Сегодня <b>${fmt(today)}</b> · порог ${threshold} дн (меняется в «Данные → Контроль сроков»). Статусы партий двигай как обычно — система сама запомнит даты и посчитает готовность. «Готово вовремя» ставит статус «готово» сегодняшним числом; «Задержка» фиксирует новую ожидаемую дату; «Идёт по плану» откладывает вопрос на 3 дня.</div></div>
    <div class="panel"><h3>Требует внимания${attention.length ? ` (${attention.length})` : ''}</h3>
      ${attention.length ? attnItems : '<div style="color:var(--accent-2)">Всё по плану ✓ Ничего не требует внимания.</div>'}
    </div>
    <details class="panel"><summary style="cursor:pointer;font-weight:600">Все партии (${cyc.length})</summary>
      <div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>Партия</th><th>Цех</th><th>Этап</th><th>Статус</th><th>План готов</th><th>Дедлайн WB</th><th>Состояние</th></tr></thead>
      <tbody>${allRows}</tbody></table></div>
    </details>`;

  const save = async (fn) => { fn(); dirty = true; try { await recalc(true); toast('Сохранено, пересчитано'); } catch (e) { toast('Ошибка: ' + e.message, true); } };
  root.querySelectorAll('[data-tm-done]').forEach((b) => b.addEventListener('click', () => { const p = pById(b.dataset.tmDone); if (p) save(() => { p.status = 'done'; p.expectedReady = ''; p.snoozeUntil = ''; }); }));
  root.querySelectorAll('[data-tm-exp]').forEach((inp) => inp.addEventListener('change', () => { const p = pById(inp.dataset.tmExp); if (p) save(() => { p.expectedReady = inp.value || ''; p.snoozeUntil = ''; }); }));
  root.querySelectorAll('[data-tm-snooze]').forEach((b) => b.addEventListener('click', () => { const p = pById(b.dataset.tmSnooze); if (!p) return; const dt = new Date(Date.parse(today) + 3 * 86400000).toISOString().slice(0, 10); save(() => { p.snoozeUntil = dt; }); }));
  root.querySelectorAll('[data-tm-rescue]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.tmRescue; const box = document.getElementById('rescue-' + id);
    box.innerHTML = '<div class="mini" style="margin-top:6px">Ищу варианты спасения…</div>';
    try {
      const r = await api('/api/rescue', { method: 'POST', body: JSON.stringify(state) });
      const pr = (r.proposals || []).find((x) => x.partiaId === id);
      box.innerHTML = renderRescueCard(pr);
      const ap = box.querySelector('[data-rescue-apply]');
      if (ap) ap.addEventListener('click', () => { const p = pById(id); if (p) save(() => { p.workshopId = ap.dataset.rescueApply; }); });
      const sp = box.querySelector('[data-rescue-split]');
      if (sp) sp.addEventListener('click', () => {
        const p = pById(id); if (!p) return;
        const move = +sp.dataset.rescueMove || Math.round(matrixSum(p.planMatrix) / 2);
        const { chunk, remainder } = splitMatrixClient(p.planMatrix, move, nestingRules());
        if (matrixSum(chunk) <= 0 || matrixSum(remainder) <= 0) { toast('Не удалось разделить (настил)', true); return; }
        save(() => {
          // осколок наследует срок/метку поставки исходной партии (чтобы дедлайн WB сохранился)
          const np = newPartia(p.articleId, p.stageId, '', { deadline: p.deadline, deliveryTag: p.deliveryTag, origin: p.origin });
          np.planMatrix = chunk; np.workshopId = sp.dataset.rescueSplit;
          p.planMatrix = remainder;
          state.partias.push(np); recomputePartiaNumbers();
        });
      });
    } catch (e) { box.innerHTML = `<div class="mini" style="color:var(--danger)">Ошибка: ${e.message}</div>`; }
  }));
}

function renderRescueCard(pr) {
  if (!pr) return '<div class="mini" style="margin-top:6px">Партия уже не требует спасения (пересчитано).</div>';
  const o = pr.options && pr.options[0];
  if (pr.escalate || !o) {
    return `<div style="margin-top:8px;padding:10px;border:1px solid var(--danger);border-radius:8px;background:rgba(248,113,113,.08)">
      <div style="color:var(--danger);font-weight:700">⚠ СРОЧНО НУЖЕН ЕЩЁ ОДИН АУТСОРС-ЦЕХ</div>
      <div class="mini" style="margin-top:4px">Ни один действующий цех не может взять эту партию (даже частью) к дедлайну без срыва других партий. Варианты: подключить дополнительный цех или осознанно сдвинуть срок.</div>
    </div>`;
  }
  if (o.type === 'split') {
    return `<div style="margin-top:8px;padding:10px;border:1px solid var(--accent-2);border-radius:8px;background:rgba(52,211,153,.08)">
      <div style="font-weight:700">✂ Разделить и передать часть в цех «${o.toWorkshopName}»</div>
      <div class="mini" style="margin-top:4px">Оставить <b>${o.stayUnits.toLocaleString('ru')} шт</b> на «${pr.workshopName}» (WB ${fmt(o.wbStay)}), передать <b>${o.moveUnits.toLocaleString('ru')} шт</b> в «${o.toWorkshopName}» (WB ${fmt(o.wbMove)}). Ткань — +${o.transferDays} дн на переброску.</div>
      <div class="mini" style="margin-top:4px;color:#d97706">⚠ Предварительно: согласуй точную раскладку по размерам с ответственным.</div>
      <button class="btn btn-primary" style="margin-top:8px" data-rescue-split="${o.toWorkshopId}" data-rescue-move="${o.moveUnits}">Применить (создать под-партию)</button>
    </div>`;
  }
  const shifted = o.affected && o.affected.length
    ? ` Подвинутся во времени (но успевают к своим дедлайнам): ${o.affected.map((a) => `${a.articleId} (+${a.shiftDays} дн)`).join(', ')}.`
    : ' Другие партии не затрагиваются.';
  return `<div style="margin-top:8px;padding:10px;border:1px solid var(--accent-2);border-radius:8px;background:rgba(52,211,153,.08)">
    <div style="font-weight:700">🛟 Переназначить целиком в цех «${o.toWorkshopName}»</div>
    <div class="mini" style="margin-top:4px">Новый приход на WB: <b>${fmt(o.newWb)}</b> (запас ${o.slack} дн до дедлайна).${shifted} Ткань — заложить +${o.transferDays} дн на переброску в другой цех.</div>
    <button class="btn btn-primary" style="margin-top:8px" data-rescue-apply="${o.toWorkshopId}">Применить</button>
  </div>`;
}

// короткая метка этапа: «Э1», «Э2» …
function stageShort(sid) {
  const i = state.stages.findIndex((s) => s.id === sid);
  return i >= 0 ? 'Э' + (i + 1) : '—';
}

function renderFabricOrder() {
  const root = document.getElementById('fabric');
  if (!state.stages.length || !state.articles.length) {
    root.innerHTML = '<div class="panel"><div class="mini">Нет этапов или артикулов.</div></div>';
    return;
  }
  const money = (v) => '$' + Math.round(v || 0).toLocaleString('ru');
  const fo = schedule?.fabricOrders;
  const today = /^\d{4}-\d{2}-\d{2}$/.test(state.settings.planningDate || '') ? state.settings.planningDate : new Date().toISOString().slice(0, 10);
  const dayDiff = (iso) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);

  // ── БЛОК 1. Что заказать: сводка + плоский список ближайших заказов по датам ──
  let planHTML;
  if (!fo || !(fo.suppliers || []).length) {
    planHTML = '<div class="panel"><div class="mini">План закупки появится после расчёта — нажми «Пересчитать».</div></div>';
  } else {
    // плоский список всех заказов (через поставщиков и ткани), сортировка по дате
    const all = [];
    for (const g of fo.suppliers) for (const f of g.fabrics) for (const o of f.orders) all.push({ o, supplierName: g.supplierName, fabricLabel: f.label, image: f.image });
    all.sort((a, b) => (a.o.orderDate < b.o.orderDate ? -1 : a.o.orderDate > b.o.orderDate ? 1 : 0));
    const urgency = (d) => { const dd = dayDiff(d); return dd < 0 ? `<span style="color:var(--danger);font-weight:700">просрочено ${-dd} дн</span>` : dd <= 7 ? `<span style="color:#d97706;font-weight:700">через ${dd} дн</span>` : `<span class="mini">через ${dd} дн</span>`; };
    const rowBg = (d) => { const dd = dayDiff(d); return dd < 0 ? 'background:rgba(248,113,113,.10)' : dd <= 7 ? 'background:rgba(245,158,11,.10)' : ''; };
    const upcomingRows = all.map(({ o, supplierName, fabricLabel, image }) => `<tr style="${rowBg(o.orderDate)}">
      <td><b>${fmt(o.orderDate)}</b><div>${urgency(o.orderDate)}</div></td>
      <td>${supplierName}</td>
      <td>${image ? `<img class="fab-thumb" src="${image}" alt="">` : ''} ${fabricLabel}</td>
      <td class="mini">${o.coversStages.map(stageShort).join('+')} · нужно к ${fmt(o.needBy)}</td>
      <td class="num">${o.meters.toLocaleString('ru')} м</td>
      <td class="num">${o.cost ? money(o.cost) : '<span class="mini">—</span>'}</td>
    </tr>`).join('');

    // полный план по поставщикам (чисто: одна строка = один заказ)
    const supBlocks = fo.suppliers.map((g) => {
      const modeTxt = g.orderMode === 'season' ? 'оплата сразу — один заказ на сезон' : `рассрочка — выборка по ${g.drawStages} эт.`;
      const rows = g.fabrics.map((f) => f.orders.map((o, i) => `<tr>
        <td>${i === 0 ? `${f.image ? `<img class="fab-thumb" src="${f.image}" alt="">` : ''} <b>${f.label}</b> <span class="mini">арт ${f.articleIds.join(', ')}</span>` : '<span class="mini">↳</span>'}</td>
        <td>${fmt(o.orderDate)}</td><td>${fmt(o.needBy)}</td><td class="mini">${o.coversStages.map(stageShort).join('+')}</td>
        <td class="num">${o.meters.toLocaleString('ru')} м</td><td class="num">${o.cost ? money(o.cost) : '<span class="mini">—</span>'}</td>
      </tr>`).join('')).join('');
      return `<div class="panel"><div class="subhead"><h3>${g.supplierName}</h3><span class="mini">${modeTxt} · заказать к <b>${fmt(g.earliestOrderDate)}</b></span></div>
        <table><thead><tr><th>Ткань</th><th>Разместить</th><th>Нужно к</th><th>Этапы</th><th class="num">Метраж</th><th class="num">Стоимость</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th colspan="4">Итого по поставщику</th><th class="num">${g.totalMeters.toLocaleString('ru')} м</th><th class="num">${money(g.totalCost)}</th></tr></tfoot></table></div>`;
    }).join('');

    planHTML = `
      <div class="panel"><div class="fab-summary">
        <div><div class="k">Поставщиков</div><div class="v">${fo.suppliers.length}</div></div>
        <div><div class="k">Заказов</div><div class="v">${all.length}</div></div>
        <div><div class="k">Всего ткани</div><div class="v good">${fo.totals.meters.toLocaleString('ru')} м</div></div>
        <div><div class="k">Стоимость</div><div class="v good">${money(fo.totals.cost)}</div></div>
      </div></div>
      <div class="panel"><h3>Ближайшие заказы</h3>
        <div style="overflow-x:auto"><table><thead><tr><th>Разместить</th><th>Поставщик</th><th>Ткань</th><th>Покрывает</th><th class="num">Метраж</th><th class="num">Стоимость</th></tr></thead>
        <tbody>${upcomingRows}</tbody></table></div>
        <div class="mini" style="margin-top:6px">По дате размещения. <span style="color:var(--danger)">Красное</span> — просрочено, <span style="color:#d97706">жёлтое</span> — в ближайшую неделю. Метраж — с раскроем и страховым +${state.settings.fabric.safetyPct}%; итоговый заказ по ткани берёт остаток (без мёртвого излишка).</div>
      </div>
      <details class="panel"><summary style="cursor:pointer;font-weight:600">Полный план по поставщикам (${fo.suppliers.length})</summary>
        <div style="margin-top:8px">${supBlocks}</div>
      </details>`;
  }

  // ── БЛОК 2. Детализация по артикулам/цветам (проверка данных, по этапу) ──
  const sStages = seasonStages();
  if (!fabricStageId || !sStages.find((s) => s.id === fabricStageId)) fabricStageId = sStages[0]?.id;
  const stage = state.stages.find((s) => s.id === fabricStageId);
  const wastage = +(state.settings.fabric.wastagePct) || 0;
  const meters = (units, perUnit) => Math.ceil(units * perUnit * (1 + wastage / 100));
  let detailHTML = '';
  if (stage) {
    const arts = articlesSorted().filter((a) => articleStageTotal(a, stage.id) > 0);
    const sections = arts.map((a) => {
      a.fabricInfo = a.fabricInfo || {};
      const price = +a.fabricPricePerMeter || 0;
      const supName = (state.suppliers.find((s) => s.id === a.supplierId) || {}).name || '— не задан';
      let sub = 0, subCost = 0;
      const rows = a.colors.map((c) => {
        const u = colorUnits(a, stage.id, c);
        if (u <= 0) return '';
        const info = (a.fabricInfo[c] = a.fabricInfo[c] || {});
        const m = meters(u, a.fabricPerUnit); sub += m;
        const cost = m * price; subCost += cost;
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
          <span class="mini">поставщик: ${supName} · расход ${a.fabricPerUnit} м/шт · цена ${price ? '$' + price + '/м' : '— (задай в «Данные»)'}</span></div>
        <table><thead><tr><th>Цвет</th><th>Планшет поставщика</th><th>Образец</th><th>№ цвета</th><th class="num">Штук</th><th class="num">Метраж (с раскроем)</th><th class="num">Стоимость</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th colspan="5">Итого по артикулу</th><th class="num">${sub.toLocaleString('ru')} м</th><th class="num">${price ? money(subCost) : '—'}</th></tr></tfoot></table>
      </div>`;
    }).join('');
    detailHTML = `<details class="panel"><summary style="cursor:pointer;font-weight:600">Детализация по артикулам и цветам (проверка данных)</summary>
      <div class="matrix-controls" style="margin-top:8px">
        <label>Этап:
          <select id="fab-stage">${sStages.map((s) => `<option value="${s.id}"${s.id === stage.id ? ' selected' : ''}>Этап ${state.stages.findIndex((x) => x.id === s.id) + 1}${s.salesMonths ? ' · ' + s.salesMonths : ''}</option>`).join('')}</select>
        </label>
        <span class="mini">Штук, метраж (с раскроем +${wastage}%), планшет, цвет, образец. Это НЕ заказ — заказ формируется выше.</span>
      </div>
      ${sections || '<div class="mini">На этот этап нет плана.</div>'}
    </details>`;
  }

  root.innerHTML = planHTML + detailHTML;

  const sel = document.getElementById('fab-stage');
  if (sel) sel.addEventListener('change', (e) => { fabricStageId = e.target.value; renderFabricOrder(); });
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
// Все партии артикула (любой этап/поставка) — по времени поставки (deadline), затем по номеру.
function partiasOfArticle(articleId) {
  return (state.partias || []).filter((p) => p.articleId === articleId)
    .sort((a, b) => (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') || (a.no - b.no));
}
// Метка партии для выпадающих списков (поставка/этап/ручная + срок WB + цех + объём).
function partiaLabel(p) {
  const ws = p.workshopId ? (state.workshops.find((w) => w.id === p.workshopId)?.name || '') : 'авто';
  const when = p.deliveryTag || (p.stageId ? (state.stages.find((s) => s.id === p.stageId)?.name || '') : 'ручная');
  const dl = p.deadline ? ` · WB ${p.deadline.slice(8, 10)}.${p.deadline.slice(5, 7)}` : '';
  return `Партия ${p.no} · ${when}${dl} · ${ws} · ${partiaPlanUnits(p)} шт`;
}
function roleRankClient(w) { return w.own ? 0 : (w.role === 'main' ? 1 : 2); }
// Оценка рабочих дней от «сегодня» (или planningDate) до даты (6-дневка ≈ ×6/7).
function workingDaysUntil(dateISO) {
  if (!dateISO) return 60;
  const today = /^\d{4}-\d{2}-\d{2}$/.test(state.settings.planningDate) ? state.settings.planningDate : new Date().toISOString().slice(0, 10);
  const days = Math.round((new Date(dateISO) - new Date(today)) / 86400000);
  return Math.max(1, Math.round(days * 6 / 7));
}
// Распределить матрицу партии по цехам пропорционально мощности, чтобы уложиться в срок.
// Свой цех — первым; добавляем цеха, пока суммарной мощности хватает. Настил соблюдается.
// Возвращает [{workshopId, matrix}] (1..N).
function distributeByCapacity(matrix, deadline) {
  const total = matrixSum(matrix);
  if (total <= 0) return [{ workshopId: '', matrix }];
  const buffer = state.settings.riskBufferDays || 0;
  const availDays = Math.max(1, workingDaysUntil(deadline) - buffer);
  const ws = state.workshops.filter((w) => (w.capacities && w.capacities.sew) > 0)
    .sort((a, b) => (roleRankClient(a) - roleRankClient(b)) || (b.capacities.sew - a.capacities.sew));
  if (!ws.length) return [{ workshopId: '', matrix }];
  const chosen = []; let cap = 0;
  for (const w of ws) { chosen.push(w); cap += w.capacities.sew * availDays; if (cap >= total) break; }
  if (chosen.length === 1) return [{ workshopId: chosen[0].id, matrix }];
  const capSum = chosen.reduce((s, w) => s + w.capacities.sew, 0);
  const out = []; let rem = JSON.parse(JSON.stringify(matrix));
  for (let i = 0; i < chosen.length - 1; i++) {
    const target = Math.round(total * chosen[i].capacities.sew / capSum);
    const { chunk, remainder } = splitMatrixClient(rem, target, nestingRules());
    if (matrixSum(chunk) > 0) out.push({ workshopId: chosen[i].id, matrix: chunk });
    rem = remainder;
    if (matrixSum(rem) <= 0) break;
  }
  if (matrixSum(rem) > 0) out.push({ workshopId: chosen[chosen.length - 1].id, matrix: rem });
  return out;
}
// Применить распределение по мощностям к одной партии: первый кусок — в неё, остальные — новые
// партии (наследуют срок/метку/происхождение). Возвращает число получившихся частей.
function distributePartiaByCapacity(p, articleId) {
  if (p.status !== 'plan' || matrixSum(p.planMatrix) < 2) return 0;
  const pieces = distributeByCapacity(p.planMatrix, p.deadline);
  p.planMatrix = pieces[0].matrix; p.workshopId = pieces[0].workshopId;
  for (let i = 1; i < pieces.length; i++) {
    const np = newPartia(articleId, p.stageId, pieces[i].workshopId, { deadline: p.deadline, deliveryTag: p.deliveryTag, origin: p.origin });
    np.planMatrix = pieces[i].matrix; state.partias.push(np);
  }
  return pieces.length;
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
function newPartia(articleId, stageId, workshopId = '', extra = {}) {
  return {
    id: genPartiaIdClient(), no: 0, articleId, stageId, workshopId,
    planMatrix: {}, factMatrix: {}, status: 'plan', historical: false,
    deadline: extra.deadline || '', deliveryTag: extra.deliveryTag || '', origin: extra.origin || 'manual',
  };
}
// нумерация партий: у каждого цеха своя (1,2,3…); авто-партии — отдельная группа.
// Порядок — по времени поставки (deadline партии → дедлайн этапа → в конец), как на сервере.
function recomputePartiaNumbers() {
  const parts = state.partias || [];
  const stageOrder = {}, stageDl = {};
  state.stages.forEach((st, i) => { stageOrder[st.id] = i; stageDl[st.id] = st.deadline || ''; });
  const timeKey = (p) => p.deadline || stageDl[p.stageId] || '9999-12-31';
  const indexed = parts.map((p, idx) => ({ p, idx }));
  indexed.sort((A, B) => timeKey(A.p).localeCompare(timeKey(B.p))
    || (stageOrder[A.p.stageId] ?? 99) - (stageOrder[B.p.stageId] ?? 99) || A.idx - B.idx);
  const counters = {};
  for (const { p } of indexed) { const k = p.workshopId || '__auto__'; counters[k] = (counters[k] || 0) + 1; p.no = counters[k]; }
}

let matrixStageId = null, matrixArticleId = null, matrixPartiaId = null;

// ── настил (клиентские хелперы, зеркало lib/nesting.js) ──
function nestingRules() { const n = state.settings.nesting || {}; return { minSizeQty: +n.minSizeQty || 20, minColorQty: +n.minColorQty || 400 }; }
function colorSum(row) { let s = 0; for (const k in (row || {})) s += +row[k] || 0; return Math.round(s); }
function matrixSum(M) { let s = 0; for (const c in (M || {})) s += colorSum(M[c]); return Math.round(s); }
function nestingViolations(M, r) {
  const out = [];
  for (const color of Object.keys(M || {})) {
    const row = M[color] || {}; const tot = colorSum(row);
    if (tot > 0 && tot < r.minColorQty) out.push({ kind: 'color', color, qty: tot });
    for (const size of Object.keys(row)) { const q = +row[size] || 0; if (q > 0 && q < r.minSizeQty) out.push({ kind: 'size', color, size, qty: q }); }
  }
  return out;
}
function splitMatrixClient(M, target, r) {
  // по целым цветам (крупные первыми)
  const colors = Object.keys(M || {}).map((c) => ({ c, tot: colorSum(M[c]) })).filter((x) => x.tot > 0).sort((a, b) => b.tot - a.tot);
  const chunk = {}, rem = {}; let acc = 0;
  for (const { c, tot } of colors) { if (acc < target) { chunk[c] = { ...M[c] }; acc += tot; } else rem[c] = { ...M[c] }; }
  if (matrixSum(chunk) > 0 && matrixSum(rem) > 0) return { chunk, remainder: rem };
  // внутри цвета (один цвет): пропорционально, размер ≥ min иначе целиком
  const total = matrixSum(M); const ratio = total ? Math.min(0.99, Math.max(0.01, target / total)) : 0.5;
  const c2 = {}, r2 = {};
  for (const c of Object.keys(M || {})) {
    const ch = {}, rm = {};
    for (const s of Object.keys(M[c] || {})) {
      const q = +M[c][s] || 0; if (q <= 0) continue;
      let a = Math.round(q * ratio), b = q - a;
      if ((a > 0 && a < r.minSizeQty) || (b > 0 && b < r.minSizeQty)) { if (ratio >= 0.5) { a = q; b = 0; } else { a = 0; b = q; } }
      if (a > 0) ch[s] = a; if (b > 0) rm[s] = b;
    }
    if (Object.keys(ch).length) c2[c] = ch; if (Object.keys(rm).length) r2[c] = rm;
  }
  return { chunk: c2, remainder: r2 };
}

function renderMatrix() {
  const root = document.getElementById('matrix');
  if (!state.articles.length) { root.innerHTML = '<div class="panel"><div class="mini">Нет артикулов. Добавь их во вкладке «Данные».</div></div>'; return; }
  if (!matrixArticleId || !state.articles.find((a) => a.id === matrixArticleId)) matrixArticleId = state.articles[0].id;
  const a = state.articles.find((x) => x.id === matrixArticleId);
  const parts = partiasOfArticle(a.id); // все партии артикула (поставки + ручные + legacy-этапы)
  // выбранная партия
  let p = parts.find((x) => x.id === matrixPartiaId);
  if (!p) { p = parts[0] || null; matrixPartiaId = p ? p.id : null; }

  const controls = `
    <div class="matrix-controls">
      <label>Артикул:
        <select id="mx-article">${articlesSorted().map((x) => `<option value="${x.id}"${x.id === a.id ? ' selected' : ''}>${x.id} — ${x.name}</option>`).join('')}</select>
      </label>
      <label>Партия:
        <select id="mx-partia">${parts.map((x) => `<option value="${x.id}"${p && x.id === p.id ? ' selected' : ''}>${seEsc(partiaLabel(x))}</option>`).join('') || '<option>нет партий</option>'}</select>
      </label>
      <button id="mx-add-partia" class="btn">＋ партия (ручная)</button>
      ${parts.some((x) => x.status === 'plan') ? '<button id="mx-distribute-all" class="btn" title="Раздробить каждую партию этого артикула по цехам пропорционально мощности, чтобы уложиться в сроки">⚙ Распределить все по мощностям</button>' : ''}
    </div>`;

  if (!p) {
    root.innerHTML = `<div class="panel">${controls}
      <div class="mini" style="margin:10px 0">На этот артикул партий пока нет. Заполни «🧩 План по размерам из прогноза» в разделе «Ранг сезонности» — оттуда перенесутся партии-поставки. Или нажми <b>«＋ партия (ручная)»</b> для срочной внеплановой партии.</div></div>`;
    bindMatrixControls(a);
    document.getElementById('mx-add-partia').addEventListener('click', () => addPartia(a));
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
        <span class="partia-badge">Партия ${p.no}${p.deliveryTag ? ' · ' + seEsc(p.deliveryTag) : ''}${p.origin === 'forecast' ? ' <span class="mini">из прогноза</span>' : ''}</span>
        <label>Цех:
          <select id="mx-ws"><option value="">Авто (распределит система)</option>
            ${state.workshops.map((w) => `<option value="${w.id}"${w.id === p.workshopId ? ' selected' : ''}>${w.name}${w.role === 'aux' ? ' (вспом.)' : ''}</option>`).join('')}
          </select>
        </label>
        <label>Срок WB: <input type="date" id="mx-deadline" value="${p.deadline || ''}"></label>
        <button id="mx-distribute" class="btn" title="Раздробить партию по цехам пропорционально мощности, чтобы уложиться в срок (свой цех первым; настил соблюдается)">⚙ Распределить по мощностям</button>
        <button id="mx-split-partia" class="btn" title="Разделить партию на две по правилам настила (цвета целиком; при необходимости — по размерам ≥ мин)">✂ Разделить пополам</button>
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
      ${(() => { const v = nestingViolations(M, nestingRules()); if (!v.length) return ''; const r = nestingRules(); return `<div style="margin-top:10px;padding:8px 10px;border:1px solid #d97706;border-radius:8px;background:rgba(245,158,11,.1)"><div class="mini"><b>Настил (ориентир):</b> ${v.map((x) => x.kind === 'color' ? `цвет «${x.color}» ${x.qty} шт (&lt;${r.minColorQty})` : `${x.color}/${x.size} ${x.qty} шт (&lt;${r.minSizeQty})`).join(' · ')}. Мягкое предупреждение — можно продолжать.</div></div>`; })()}
    </div>`;

  bindMatrixControls(a);
  document.getElementById('mx-tpl-one').addEventListener('click', () => exportPlanXlsx([a.id], `plan_${a.id}.xlsx`));
  document.getElementById('mx-tpl-all').addEventListener('click', () => exportPlanXlsx(state.articles.map((x) => x.id), 'plan_all.xlsx'));
  document.getElementById('mx-import').addEventListener('change', (e) => importPlanAnyFile(e.target.files && e.target.files[0]));
  document.getElementById('mx-partia').addEventListener('change', (e) => { matrixPartiaId = e.target.value; renderMatrix(); });
  document.getElementById('mx-add-partia').addEventListener('click', () => addPartia(a));
  document.getElementById('mx-ws').addEventListener('change', (e) => { p.workshopId = e.target.value; recomputePartiaNumbers(); dirty = true; renderMatrix(); });
  document.getElementById('mx-deadline').addEventListener('change', (e) => { p.deadline = e.target.value || ''; recomputePartiaNumbers(); dirty = true; renderMatrix(); });
  document.getElementById('mx-del-partia').addEventListener('click', () => {
    if (!confirm(`Удалить Партию ${p.no}?`)) return;
    state.partias = state.partias.filter((x) => x.id !== p.id);
    matrixPartiaId = null; dirty = true; renderMatrix();
  });
  document.getElementById('mx-distribute').addEventListener('click', () => {
    if (p.status !== 'plan') { toast('Распределять можно только не начатую партию (статус «план»)', true); return; }
    if (matrixSum(p.planMatrix) < 2) { toast('Партия слишком мала для распределения', true); return; }
    const n = distributePartiaByCapacity(p, a.id);
    recomputePartiaNumbers(); dirty = true; renderMatrix();
    toast(n <= 1 ? 'Одного цеха достаточно к сроку — закреплён. Нажми «Сохранить план».'
      : `Распределено на ${n} цеха по мощностям. Нажми «Сохранить план».`);
  });
  const distAll = document.getElementById('mx-distribute-all');
  if (distAll) distAll.addEventListener('click', () => {
    let touched = 0, added = 0;
    for (const pt of partiasOfArticle(a.id).filter((x) => x.status === 'plan' && matrixSum(x.planMatrix) >= 2)) {
      const n = distributePartiaByCapacity(pt, a.id); if (n >= 1) touched++; if (n > 1) added += n - 1;
    }
    recomputePartiaNumbers(); dirty = true; renderMatrix();
    toast(touched ? `Распределены все партии по мощностям (+${added} новых). Нажми «Сохранить план».` : 'Нечего распределять', !touched);
  });
  document.getElementById('mx-split-partia').addEventListener('click', () => {
    const total = matrixSum(p.planMatrix);
    if (total < 2) { toast('Партия слишком мала для деления', true); return; }
    if (p.status !== 'plan') { toast('Делить можно только не начатую партию (статус «план»)', true); return; }
    const { chunk, remainder } = splitMatrixClient(p.planMatrix, Math.round(total / 2), nestingRules());
    if (matrixSum(chunk) <= 0 || matrixSum(remainder) <= 0) { toast('Не удалось разделить (проверь настил-ориентиры)', true); return; }
    // осколок наследует срок/метку поставки исходной партии
    const np = newPartia(a.id, p.stageId, '', { deadline: p.deadline, deliveryTag: p.deliveryTag, origin: p.origin });
    np.planMatrix = chunk;
    p.planMatrix = remainder;
    state.partias.push(np);
    recomputePartiaNumbers(); dirty = true; matrixPartiaId = np.id; renderMatrix();
    toast(`Партия разделена: ${matrixSum(remainder)} + ${matrixSum(chunk)} шт`);
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

function bindMatrixControls(a) {
  document.getElementById('mx-article').addEventListener('change', (e) => { matrixArticleId = e.target.value; matrixPartiaId = null; renderMatrix(); });
}
function addPartia(a) {
  // ручная срочная партия: без этапа, без даты (пользователь задаст «Срок WB» и цех в баре)
  const np = newPartia(a.id, '', '', { origin: 'manual' });
  state.partias.push(np);
  recomputePartiaNumbers();
  matrixPartiaId = np.id; dirty = true; renderMatrix();
  toast(`Создана ручная Партия ${np.no}`);
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

// отметка факта завершения операции партии (из детального окна Ганта)
async function onProgress(partiaId, op, date) {
  const p = (state.partias || []).find((x) => x.id === partiaId);
  if (!p) return;
  p.progress = p.progress || { cut: '', sew: '', iron: '', otk: '' };
  p.progress[op] = date || '';
  dirty = true;
  try { await recalc(true); toast('Факт сохранён, отставание пересчитано'); }
  catch (e) { toast('Ошибка: ' + e.message, true); }
}

// ---------- ДАШБОРД ----------
function renderDashboard() {
  const root = document.getElementById('dashboard');
  const cy = schedule.cycles;
  const totalUnits = cy.reduce((s, c) => s + c.units, 0);
  const errs = schedule.warnings.filter((w) => w.level === 'error');
  const warns = schedule.warnings.filter((w) => w.level === 'warn');
  const totalMeters = schedule.fabricOrders?.totals?.meters || 0;

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
        <td>${r.own ? '<span class="badge main">свой</span>' : `<span class="badge ${r.role}">${r.role === 'main' ? 'основной' : 'вспом.'}</span>`}</td>
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

    <div class="panel"><h3>Заказ ткани по поставщикам (лид-тайм ${state.settings.fabric.leadTimeDays} дн, страховой +${state.settings.fabric.safetyPct}%)</h3>
      <table><thead><tr><th>Поставщик</th><th>Режим</th><th>Ближайший заказ</th><th class="num">Заказов</th><th class="num">Метраж</th><th class="num">Стоимость</th></tr></thead>
      <tbody>${(schedule.fabricOrders?.suppliers || []).map((g) => `<tr>
        <td><b>${g.supplierName}</b></td>
        <td class="mini">${g.orderMode === 'season' ? 'оплата сразу' : `выборка по ${g.drawStages} эт.`}</td>
        <td>${fmt(g.earliestOrderDate)}</td>
        <td class="num">${g.fabrics.reduce((s, f) => s + f.orders.length, 0)}</td>
        <td class="num">${g.totalMeters.toLocaleString('ru')} м</td>
        <td class="num">$${g.totalCost.toLocaleString('ru')}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="mini">Нажми «Пересчитать».</td></tr>'}</tbody>
      ${schedule.fabricOrders?.totals ? `<tfoot><tr><th colspan="4">ВСЕГО</th><th class="num">${schedule.fabricOrders.totals.meters.toLocaleString('ru')} м</th><th class="num">$${schedule.fabricOrders.totals.cost.toLocaleString('ru')}</th></tr></tfoot>` : ''}
      </table>
      <div class="mini" style="margin-top:6px">Подробный план заказа — на листе «Заказ ткани».</div>
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
  // Загрузка по РЕАЛЬНОМУ расписанию (конвейер): доступные дни = рабочие дни от
  // старта производства до последней готовности, занятые = дни пошива (узкое
  // горлышко). Окно ограничиваем горизонтом плана (последний дедлайн + 60 дн),
  // чтобы битая мощность одного цеха не обнуляла загрузку всех.
  const cycles = schedule.cycles || [];
  const P = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  let minCut = null, maxReady = null;
  for (const c of cycles) {
    if (minCut === null || P(c.ops.cut.start) < P(minCut)) minCut = c.ops.cut.start;
    if (maxReady === null || P(c.readyDate) > P(maxReady)) maxReady = c.readyDate;
  }
  const deadlines = (state.stages || []).map((s) => s.deadline).filter(Boolean);
  if (deadlines.length && maxReady) {
    const latest = deadlines.reduce((m, d) => (P(d) > P(m) ? d : m), deadlines[0]);
    const cap = P(latest) + 60 * 86400000;
    if (P(maxReady) > cap) maxReady = new Date(cap).toISOString().slice(0, 10);
  }
  const availDays = (minCut && maxReady) ? countWorkingDays(minCut, maxReady) : 0;

  const rows = [];
  for (const w of state.workshops) {
    const cs = cycles.filter((c) => c.workshopId === w.id);
    const busyDays = cs.reduce((s, c) => s + Math.ceil(c.units / Math.max(1, w.capacities.sew)), 0);
    rows.push({
      name: w.name, role: w.role, own: !!w.own, sew: w.capacities.sew,
      busyDays, availDays, cycles: cs.length,
      pct: availDays ? Math.round((busyDays / availDays) * 100) : 0,
    });
  }
  return rows;
}
// рабочих дней между датами включительно (без воскресений — 6-дневка)
function countWorkingDays(fromISO, toISO) {
  const P = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  let c = 0;
  for (let t = P(fromISO); t <= P(toISO); t += 86400000) if (new Date(t).getUTCDay() !== 0) c++;
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
let seasonColorMinRel = 40;      // порог силы цвета относительно лучшего, % (слабее → в сноску)
let seasonColorMinCount = 5;     // минимум расцветок в ассортименте (добираем даже слабые)
let seasonBuilding = false;
let seasonPlansIndex = [];
let seasonHasToken = null;
let featureOpen = false;                 // раскрыт ли блок «Словарь признаков»
const featureDictCache = {};             // path -> собранный словарь признаков
const featureSel = {};                   // path -> { plus:Set, minus:Set } выбранные признаки
function featSelFor(path) { if (!featureSel[path]) featureSel[path] = { plus: new Set(), minus: new Set() }; return featureSel[path]; }
let seasonRunLog = [];                    // расширенный лог этапов текущего прогона
function seasonLogPush(lines) { if (Array.isArray(lines) && lines.length) seasonRunLog.push(...lines); }
function seasonLogText() { return seasonRunLog.map((l) => `[${String(l.t || '').slice(11, 19)}] ${l.stage || ''}: ${l.msg}`).join('\n'); }
function renderLogComment(el, lines) { if (!el) return; el.innerHTML = (lines || []).map((l) => `<div class="se-log-line">✓ ${seEsc(l.msg)}</div>`).join(''); }
function downloadSeasonLog() {
  const txt = seasonLogText() || 'Лог пуст. Соберите признаки / проверьте неопределённые / постройте план.';
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'season-log.txt'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}
const seasonIncludeByPath = {};          // path -> Set(wb) вручную одобренные «неопределённые»
function seasonIncludeFor(path) { if (!seasonIncludeByPath[path]) seasonIncludeByPath[path] = new Set(); return seasonIncludeByPath[path]; }
// Поведенческая релевантность: фразы предмета + выбранные пользователем + дневной бюджет.
let seasonBudget = null;                 // {used, limit, left} суточный лимит MPStats
let seasonApproved = new Set();           // nmID, вручную одобренные в «Предв. выборе»
let seasonHintByArticle = {};             // {articleId: seasonalityHint} — подсказка типа после построения
let seasonExcludedByArticle = {};         // {articleId: Set(nmID)} — исключённые вручную из ТОП-15 конкуренты
let _seExclTimer = null;                   // дебаунс авто-пересборки после отжима чекбоксов
const seasonPhrasesByPath = {};          // path -> [{phrase,norm,freq,words}]
const seasonPickedByPath = {};           // path -> Set(norm) отмеченные галочками фразы
function seasonPickedFor(path) { if (!seasonPickedByPath[path]) seasonPickedByPath[path] = new Set(); return seasonPickedByPath[path]; }
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
  const f0 = (articlesSorted().find((a) => a.id === seasonBuildArticle) || {}).seasonFilter || {};
  try {
    const st = await api('/api/season/status' + (f0.path ? '?path=' + encodeURIComponent(f0.path) : ''));
    seasonHasToken = st.hasToken; seasonBudget = st.budget || null;
  } catch { if (seasonHasToken === null) seasonHasToken = false; }
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
    <div class="subhead"><h3>Часть 1 — Построение плана продаж (по конкурентам)</h3>${seasonBudgetBadge()}</div>
    ${warn}
    <div class="season-form se-builder-grid">

      <!-- 1. Артикул + целевые фразы -->
      <div class="u-pg se-wide">
        <div class="u-pg-t">1 · Артикул и целевые фразы</div>
        <div class="se-fields se-fields-2">
          <div class="field"><label>Артикул</label><select id="se-article">${arts.map((x) => `<option value="${x.id}"${x.id === aid ? ' selected' : ''}>${x.id} — ${seEsc(x.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field span2" style="margin-top:10px"><label title="Слова, которых быть не должно в НАЗВАНИИ. Матч по корню: пишите в короткой форме (пижама → ловит пижамный/пижамах; детск → детская/детские). Осторожно: не пишите слова своей ниши (муслин часто зовут «прозрачная»).">Минус-слова <span class="mini">(по корню; пиши коротко: пижама, детск, комплект)</span></label><input id="se-minus" value="${seEsc(f.minusWords || '')}" placeholder="пижама, детск, мужск, комплект, для мальчик"></div>
        <div class="field" style="margin-top:10px"><label title="1–3 поисковые фразы, по которым покупатели находят товары вашей ниши. По каждой фразе — 1 запрос: система берёт ВСЕ товары, которые реально по ней находятся (даже если в названии нет вашего слова), с их продажами за 2 года.">🎯 Целевые фразы <span class="mini">(по одной в строке, 1–3 шт. — каждая = 1 запрос)</span></label>
          <textarea id="se-phrases" rows="3" placeholder="рубашка муслиновая женская&#10;рубашка из муслина&#10;марлевка рубашка">${seEsc(f.phrases || '')}</textarea>
        </div>
        <div class="field span2" style="margin-top:10px"><label title="Только само нишевое слово (не весь запрос!): муслин, марлевка. По нему делится «явные» (есть в названии → авто в выборку) и «на отсмотр» (нет в названии → в «Предв. выбор»). Если пусто — беру ключи из фраз (может зацепить фасон вроде «длинный рукав»).">🧵 Нишевое слово <span class="mini">(для проверки названия — напр. «муслин, марлевка»)</span></label><input id="se-niche" value="${seEsc(f.nicheWords || '')}" placeholder="муслин, марлевка"></div>
        <div class="mini">⚠ Минус-слова ищутся <b>в названии</b> — оставляйте их минимум, иначе можно потерять релевантные ТОПы (муслин часто называют «прозрачная»/«лёгкая»). Товары по фразам объединяются, дубли убираются; минус-слова, цена и выручка применяются бесплатно.</div>
      </div>

      <!-- 2. Фильтры плана -->
      <div class="u-pg se-wide">
        <div class="u-pg-t">2 · Фильтры и параметры плана</div>
        <div class="field span2"><label title="Сезонный — товар с ярко выраженным сезоном (лёгкий муслин, марлёвка): план = разгон с нуля → сезон → распродажа с обнулением остатков. Круглогодичный — товар с яркими сезонами, но продажами весь год (полоска, клетка): план на 12 мес с сезонным пиком, мягким спадом и межсезонной базой + мини-сезоны (НГ, 14/23 фев, 8 марта). Движок подскажет тип после построения.">Тип артикула</label>
            <select id="se-arttype">
              <option value="seasonal"${f.articleType === 'allseason' ? '' : ' selected'}>Сезонный — только высокий сезон (разгон → сезон → распродажа в ноль)</option>
              <option value="allseason"${f.articleType === 'allseason' ? ' selected' : ''}>Круглогодичный — весь год с яркими сезонами (пик → база + мини-сезоны)</option>
            </select>
            <div class="mini" id="se-arttype-hint">${seasonHintText(seasonHintByArticle[aid], f.articleType === 'allseason' ? 'allseason' : 'seasonal')}</div>
          </div>
        <div class="se-fields se-fields-2">
          <div class="field"><label title="Пол берётся из характеристики карточки WB (в названии и выдаче его нет). Отсекает товары противоположного пола. «Любой» — не фильтровать (быстрее).">Пол</label>
            <select id="se-gender">
              <option value=""${!f.gender ? ' selected' : ''}>Любой (не фильтровать)</option>
              <option value="female"${f.gender === 'female' ? ' selected' : ''}>Женский</option>
              <option value="male"${f.gender === 'male' ? ' selected' : ''}>Мужской</option>
              <option value="kids"${f.gender === 'kids' ? ' selected' : ''}>Детский</option>
            </select>
          </div>
          <div class="field"><label>Цена от, ₽</label><input id="se-pmin" type="number" value="${f.priceMin ?? ''}"></div>
          <div class="field"><label>Цена до, ₽</label><input id="se-pmax" type="number" value="${f.priceMax ?? ''}"></div>
          <div class="field"><label>Мин. продаж/мес</label><input id="se-minsales" type="number" value="${f.minSales ?? ''}"></div>
          <div class="field"><label>Мин. выручка/мес, ₽</label><input id="se-minrev" type="number" value="${f.minRevenue ?? ''}"></div>
          <div class="field"><label title="Сколько верхних по выручке аналогов брать в основу ранга. До 200 на одну фразу; для 300 используйте 2 фразы (выборки объединятся).">Размер группы аналогов</label><input id="se-limit" type="number" value="${f.limit ?? 60}"></div>
          <div class="field"><label title="Год, в котором планируете продавать. Если сезон в этом году ещё впереди — план строится на него; если сезон уже прошёл — движок сам сдвинет прогноз на следующий год (всегда вперёд от сегодня).">Целевой год продаж</label><input id="se-year" type="number" min="2024" max="2032" value="${f.targetYear || (new Date().getUTCFullYear())}"></div>
          <div class="field span2"><label title="ТОП-3 — средняя трёх сильнейших аналогов (реалистично). ТОП-1 — уровень самого сильного аналога по выручке в сегменте (амбициозно).">Целевой уровень (пик плана)</label>
            <select id="se-level">
              <option value="top3"${f.targetLevel === 'top1' ? '' : ' selected'}>ТОП-3 — средний (реалистично)</option>
              <option value="top1"${f.targetLevel === 'top1' ? ' selected' : ''}>ТОП-1 — максимум (амбициозно)</option>
            </select>
          </div>
          <div class="field"><label title="Как проецируем рост рынка на прогнозный год. Когорта — рост по одним и тем же товарам оба года (без новичков), реалистично для карточки. Рынок — весь рынок вместе с новыми продавцами (агрессивно, завышает). Без роста — только факт прошлого года.">Проекция роста</label>
            <select id="se-growth">
              <option value="cohort"${f.growthMode === 'market' || f.growthMode === 'none' ? '' : ' selected'}>Когорта — рост карточки (реалистично)</option>
              <option value="market"${f.growthMode === 'market' ? ' selected' : ''}>Весь рынок (агрессивно)</option>
              <option value="none"${f.growthMode === 'none' ? ' selected' : ''}>Без роста</option>
            </select>
          </div>
          <div class="field"><label title="Ручной коэффициент годового роста — перекрывает авто-расчёт. Напр. 1.25 = +25%/год, 0.9 = спад −10%/год. Пусто = считать автоматически по выбранному режиму. Полезно, если тренд ускоряется или замедляется.">Коэф. роста/год (ручной)</label><input id="se-growth-manual" type="number" step="0.05" min="0.5" max="3" value="${f.growthManual ?? ''}" placeholder="авто"></div>
          <div class="field"><label title="Ценовой сегмент, в котором планируешь продавать. Выборка бьётся на 4 сегмента по квартилям медианной цены за год (адаптивно к нише). Выбор сегмента → объём, цена и ТОП-15 считаются по лидерам именно этого сегмента и ПЕРЕОПРЕДЕЛЯЕТ окно от себестоимости. «Авто» → окно берётся от себестоимости×наценки (если заданы), иначе вся выборка.">Ценовой сегмент</label>
            <select id="se-segment">
              <option value="auto"${['cheap','mid','high','premium'].includes(f.priceSegment) ? '' : ' selected'}>Авто — от себестоимости / весь диапазон</option>
              <option value="cheap"${f.priceSegment === 'cheap' ? ' selected' : ''}>Дешёвый (нижние 25%)</option>
              <option value="mid"${f.priceSegment === 'mid' ? ' selected' : ''}>Средний (25–50%)</option>
              <option value="high"${f.priceSegment === 'high' ? ' selected' : ''}>Высокий (50–75%)</option>
              <option value="premium"${f.priceSegment === 'premium' ? ' selected' : ''}>Премиум (верхние 25%)</option>
            </select>
          </div>
          <div class="field"><label title="Себестоимость товара, ₽ (примерно). Основа для целевой цены: себестоимость × наценка = бухгалтерская цена. Пусто = не считать выгодность и не подбирать конкурентов от себестоимости.">Себестоимость, ₽</label><input id="se-cost" type="number" min="0" value="${f.cost ?? ''}" placeholder="напр. 550"></div>
          <div class="field"><label title="Наценка к себестоимости — задаёт целевую БУХГАЛТЕРСКУЮ цену (себест × наценка). Вилка ×от…×до = целевое ценовое окно. Напр. 4 и 5 при себест. 550 → 2200–2750 ₽. Через СПП переведём в цену покупателя и подберём конкурентов там.">Наценка ×от … ×до</label>
            <div style="display:flex;gap:6px"><input id="se-markup-min" type="number" step="0.5" min="1" value="${f.markupMin ?? ''}" placeholder="4" style="width:70px"><span style="align-self:center">…</span><input id="se-markup-max" type="number" step="0.5" min="1" value="${f.markupMax ?? ''}" placeholder="5" style="width:70px"></div>
          </div>
          <div class="field"><label title="СПП — скидка постоянного покупателя (WB). Мост между твоей бухгалтерской ценой и ценой покупателя, которую показывает MPStats: цена_покупателя = бухгалтерская × (1 − СПП%). Задаётся вручную, у каждого товара своя. Напр. 20.">СПП, %</label><input id="se-spp" type="number" min="0" max="90" value="${f.spp ?? ''}" placeholder="напр. 20"></div>
          <div class="field"><label title="На сколько % подрезать цену ниже медианы сегмента (чтобы быть чуть дешевле конкурентов). 0 = по медиане. Напр. 10 = на 10% ниже.">Подрезать цену, %</label><input id="se-undercut" type="number" min="0" max="50" value="${f.priceUndercut ?? ''}" placeholder="0"></div>
          <div class="field"><label title="Ручной множитель прогнозных ЦЕН по дням (не путать с ростом продаж — цены год-к-году не коррелируют с объёмом). 1.0 = историческая цена (медиана × сезонный профиль). Напр. 1.1 = поднять цены на 10%, 0.9 = снизить. Авто-дрейф цен не применяется — показан подсказкой.">Множитель цены</label><input id="se-price-mult" type="number" step="0.05" min="0.3" max="3" value="${f.priceMultiplier ?? ''}" placeholder="1.0"></div>
          <div class="field span2 se-opts">
            <label class="se-check"><input type="checkbox" id="se-oos"${f.oos !== false ? ' checked' : ''}> OOS-поправка</label>
            <label class="se-check"><input type="checkbox" id="se-weekly"${f.weekly !== false ? ' checked' : ''}> недельный профиль</label>
            <button class="btn btn-danger" id="se-filter-reset" type="button" title="Сбросить числовые фильтры к значениям по умолчанию">✕ Сбросить фильтры</button>
          </div>
        </div>
      </div>

      <!-- 3. Предв. выбор ТОПов без ключа в названии -->
      <div class="u-pg se-wide">
        <div class="u-pg-t">3 · 🔍 Предв. выбор аналогов без ключа в названии</div>
        <div class="se-feat-bar">
          <button class="btn btn-primary" id="se-precheck" type="button">Предв. выбор</button>
          <span class="mini" id="se-precheck-status">${(f.approvedIds || []).length ? `отобрано: ${(f.approvedIds || []).length}` : ''}</span>
        </div>
        <div class="mini">ТОП по продажам среди тех, у кого в названии НЕТ нишевого ключа (муслин…). Отметьте галочками релевантные и «Сохранить» — они войдут в выборку наравне с явными.</div>
        <details class="se-comp se-wide" id="se-precheck-box"><summary>Кандидаты на отсмотр <span class="mini" id="se-precheck-count"></span></summary>
          <div class="se-comp-body" id="se-precheck-body"></div>
        </details>
      </div>

      <!-- 4. Построить план -->
      <div class="se-wide season-actions">
        <button class="btn btn-primary" id="se-build"${seasonHasToken && !seasonBuilding ? '' : ' disabled'}>${seasonBuilding ? '⏳ Строю план…' : '▶ Построить план'}</button>
        <button class="btn" id="se-log-dl" type="button" title="Скачать расширенный лог всех этапов (.txt)">⬇ Скачать лог</button>
        <span class="mini">По каждой фразе — товары из поиска WB с продажами за 2 года → графики ранга сезонности и план продаж.</span>
      </div>
      <div id="se-build-log" class="se-log se-wide"></div>
    </div>
  </div>`;
}

// Подсказка типа артикула по рыночному рельефу (после построения). Сравнивает совет движка
// с выбранным типом и мягко предлагает переключиться, если рынок говорит иное.
function seasonHintText(hint, chosen) {
  if (!hint || !hint.suggest) return '💡 Подсказка по типу появится после построения (движок оценит рынок).';
  const nameOf = (t) => t === 'allseason' ? 'круглогодичный' : t === 'seasonal' ? 'сезонный' : 'смешанный';
  const base = `💡 Рынок похож на <b>${nameOf(hint.suggest)}</b> (амплитуда пик/медиана ×${hint.amplitude}, межсезонный «пол» ${hint.floorSharePct}% от пика).`;
  if (hint.suggest !== 'mixed' && hint.suggest !== chosen) {
    return `${base} У тебя выбран «${nameOf(chosen)}» — возможно, стоит переключить и перестроить.`;
  }
  return `${base} Выбранный тип «${nameOf(chosen)}» — подходит.`;
}

// Значок остатка суточного лимита MPStats.
function seasonBudgetBadge() {
  if (!seasonBudget) return '';
  const { used, limit, left } = seasonBudget;
  const cls = left <= 15 ? ' danger' : (left <= 40 ? ' warn' : '');
  return `<span class="se-budget${cls}" title="Суточный лимит запросов MPStats. Проверенные из базы товары лимит не тратят.">лимит MPStats: ${left} из ${limit} осталось${used ? ` (использовано ${used})` : ''}</span>`;
}

function collectSeasonForm() {
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  const phrases = v('se-phrases').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  return {
    articleId: seasonBuildArticle,
    phrases,
    minusWords: v('se-minus'),
    nicheWords: v('se-niche'),
    approvedIds: [...seasonApproved],
    excludedIds: [...(seasonExcludedByArticle[seasonBuildArticle] || [])],
    gender: document.getElementById('se-gender')?.value || '',
    priceMin: v('se-pmin'), priceMax: v('se-pmax'), minSales: v('se-minsales'), minRevenue: v('se-minrev'),
    limit: v('se-limit'), targetYear: v('se-year'),
    targetLevel: (document.getElementById('se-level')?.value === 'top1') ? 'top1' : 'top3',
    articleType: (document.getElementById('se-arttype')?.value === 'allseason') ? 'allseason' : 'seasonal',
    growthMode: (() => { const v = document.getElementById('se-growth')?.value; return ['cohort', 'market', 'none'].includes(v) ? v : 'cohort'; })(),
    growthManual: v('se-growth-manual'),
    priceSegment: (() => { const v = document.getElementById('se-segment')?.value; return ['cheap', 'mid', 'high', 'premium'].includes(v) ? v : 'auto'; })(),
    cost: v('se-cost'),
    markupMin: v('se-markup-min'), markupMax: v('se-markup-max'), spp: v('se-spp'),
    priceUndercut: v('se-undercut'), priceMultiplier: v('se-price-mult'),
    oos: document.getElementById('se-oos')?.checked !== false,
    weekly: document.getElementById('se-weekly')?.checked !== false,
  };
}

// Отрисовать фразы галочками: целевые (со словом ниши) сверху и подсвечены + поиск.
let _phSearch = '';
function renderSeasonPhrases(path) {
  const body = document.getElementById('se-phrases-body'); if (!body) return;
  const phrases = seasonPhrasesByPath[path] || [];
  if (!phrases.length) { body.innerHTML = ''; return; }
  const picked = seasonPickedFor(path);
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const q = _phSearch.toLowerCase().replace(/ё/g, 'е').trim();
  // при поиске — все подходящие; без поиска — целевые + добор до 40 (целевые уже сверху)
  let view = phrases;
  if (q) view = phrases.filter((p) => p.norm.includes(q) || picked.has(p.norm));
  else view = phrases.filter((p) => p.target || picked.has(p.norm)).concat(
    phrases.filter((p) => !p.target && !picked.has(p.norm))).slice(0, 40);
  const row = (p) => `<label class="se-ph${p.target ? ' tgt' : ''}${picked.has(p.norm) ? ' on' : ''}">
      <input type="checkbox" class="se-ph-cb" data-norm="${seEsc(p.norm)}"${picked.has(p.norm) ? ' checked' : ''}>
      <span class="se-ph-t">${seEsc(p.phrase)}</span><span class="se-ph-f">${fmt(p.freq)}</span></label>`;
  const tgtN = phrases.filter((p) => p.target).length;
  body.innerHTML = `<div class="se-ph-search"><input id="se-ph-search" placeholder="🔎 поиск по фразам (например: длинн, оверсайз)" value="${seEsc(_phSearch)}"></div>
    <div class="se-ph-list">${view.map(row).join('')}</div>
    <div class="mini">Всего фраз: ${phrases.length}${tgtN ? `, с целевым словом: ${tgtN} (наверху, 🎯)` : ''}. ${q ? `Найдено: ${view.length}.` : (phrases.length > view.length ? `Показаны первые ${view.length} — остальные через поиск.` : '')}</div>`;
  const s = document.getElementById('se-ph-search');
  if (s) s.addEventListener('input', (e) => { _phSearch = e.target.value; renderSeasonPhrases(path); document.getElementById('se-ph-search')?.focus(); });
  body.querySelectorAll('.se-ph-cb').forEach((cb) => cb.addEventListener('change', () => {
    const n = cb.dataset.norm;
    if (cb.checked) picked.add(n); else picked.delete(n);
    cb.closest('.se-ph')?.classList.toggle('on', cb.checked);
    const c = document.getElementById('se-picked-count'); if (c) c.textContent = picked.size;
  }));
}

async function loadSeasonPhrases(force) {
  const g = (id) => (document.getElementById(id)?.value || '').trim();
  const path = g('se-path');
  const status = document.getElementById('se-phrases-status');
  if (!path) { toast('Сначала укажи путь предмета WB', true); return; }
  if (!g('se-target')) { toast('Впиши целевое слово (например «муслин») — по нему ищем товары ниши', true); return; }
  if (status) status.textContent = 'Ищу товары ниши и собираю их фразы…';
  try {
    const r = await api('/api/season/phrases', { method: 'POST', body: JSON.stringify({ path, targetWords: g('se-target'), minusWords: g('se-minus'), force: !!force }) });
    seasonPhrasesByPath[path] = r.phrases || [];
    _phSearch = '';
    // авто-отметка целевых фраз (с словом ниши), если пользователь ещё ничего не выбрал
    const picked = seasonPickedFor(path);
    if (!picked.size) for (const p of seasonPhrasesByPath[path]) if (p.target) picked.add(p.norm);
    if (r.budget) { seasonBudget = r.budget; const b = document.querySelector('.se-budget'); if (b) b.outerHTML = seasonBudgetBadge(); }
    if (status) status.textContent = `фраз: ${(r.phrases || []).length}, из них целевых: ${r.targetCount ?? 0}${r.cached ? ' (из базы)' : ` (эталонов: ${r.seedsUsed ?? 0})`}${r.dailyLimit ? ' · ⚠ лимит' : ''}`;
    if (!(r.phrases || []).length) toast('Не нашёл товаров с целевым словом в этом предмете — проверь слово/предмет или ослабь минус-слова', true);
    renderSeasonPhrases(path);
    const c = document.getElementById('se-picked-count'); if (c) c.textContent = picked.size;
  } catch (e) { if (status) status.textContent = ''; toast('Ошибка загрузки фраз: ' + e.message, true); }
}

// Отрисовать словарь признаков: группы характеристик + частые слова, у каждого +/−.
function renderFeatureDictBody(dict) {
  const body = document.getElementById('se-feat-body'); if (!body) return;
  if (!dict) { body.innerHTML = ''; return; }
  const sel = featSelFor(dict.path);
  const chip = (w) => {
    const p = sel.plus.has(w) ? ' on' : '', m = sel.minus.has(w) ? ' on' : '';
    return `<span class="se-fw">
      <button class="se-fw-b plus${p}" data-fw-plus="${seEsc(w)}" title="плюс-слово">+</button>
      <button class="se-fw-b minus${m}" data-fw-minus="${seEsc(w)}" title="минус-слово">−</button>
      <span class="se-fw-t">${seEsc(w)}</span></span>`;
  };
  const groups = (dict.attributes || []).map((a) => `<div class="se-fg">
      <div class="se-fg-h">${seEsc(a.name)} <span class="mini">${a.values.length}</span></div>
      <div class="se-fg-vals">${a.values.map((v) => chip(v.value)).join('')}</div></div>`).join('');
  const kw = (dict.keywords || []).length ? `<div class="se-fg">
      <div class="se-fg-h">Частые слова из названий/описаний <span class="mini">${dict.keywords.length}</span></div>
      <div class="se-fg-vals">${dict.keywords.map((k) => chip(k.word)).join('')}</div></div>` : '';
  body.innerHTML = `<div class="mini" style="margin:8px 0">Собрано по ${dict.sample} товарам${dict.withCards ? ` (карточек: ${dict.withCards})` : ' (карточки WB недоступны — только названия)'}. ${dict.cached ? 'из кэша' : 'свежий сбор'}.</div>
    <div class="se-fg-list">${groups}${kw}</div>`;
  // обработчики +/− (взаимоисключающие); выбор запоминаем на артикул
  body.querySelectorAll('[data-fw-plus]').forEach((b) => b.addEventListener('click', () => {
    const w = b.dataset.fwPlus; if (sel.plus.has(w)) sel.plus.delete(w); else { sel.plus.add(w); sel.minus.delete(w); }
    renderFeatureDictBody(dict); seasonSelPersist(dict.path);
  }));
  body.querySelectorAll('[data-fw-minus]').forEach((b) => b.addEventListener('click', () => {
    const w = b.dataset.fwMinus; if (sel.minus.has(w)) sel.minus.delete(w); else { sel.minus.add(w); sel.plus.delete(w); }
    renderFeatureDictBody(dict); seasonSelPersist(dict.path);
  }));
}
// Запомнить выбранные признаки и одобренные «неопределённые» в артикуле (переживает
// перезагрузку и повторные итерации). Дебаунс-сейв тем же механизмом, что юнит-данные.
function seasonSelPersist(path) {
  const a = (state.articles || []).find((x) => x.id === seasonBuildArticle);
  if (!a) return;
  const p = path || (document.getElementById('se-path')?.value || (a.seasonFilter && a.seasonFilter.path) || '').trim();
  if (!p) return;
  const sel = featureSel[p];
  a.seasonFilter = a.seasonFilter || {};
  if (!a.seasonFilter.path) a.seasonFilter.path = p;
  a.seasonFilter.featurePlus = sel ? [...sel.plus] : [];
  a.seasonFilter.featureMinus = sel ? [...sel.minus] : [];
  a.seasonFilter.includeWb = [...(seasonIncludeByPath[p] || [])];
  unitPersist();
}
// Восстановить выбор признаков/включений для предмета из сохранённого фильтра артикула.
function hydrateSeasonSel(f) {
  if (!f || !f.path) return;
  if (!featureSel[f.path]) {
    const s = featSelFor(f.path);
    (f.featurePlus || []).forEach((w) => s.plus.add(w));
    (f.featureMinus || []).forEach((w) => s.minus.add(w));
    // Миграция прежнего ручного ввода (words/exclude) в признаки — чтобы старые планы
    // не теряли слова после перехода на выбор признаков.
    const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!(f.featurePlus?.length)) csv(f.words).forEach((w) => s.plus.add(w));
    if (!(f.featureMinus?.length)) csv(f.exclude).forEach((w) => s.minus.add(w));
  }
  if ((f.includeWb || []).length && !seasonIncludeByPath[f.path]) {
    const inc = seasonIncludeFor(f.path); (f.includeWb || []).forEach((w) => inc.add(String(w)));
  }
}
async function loadFeatureDict(force) {
  const path = (document.getElementById('se-path')?.value || '').trim();
  const status = document.getElementById('se-feat-status');
  if (!path) { toast('Сначала укажи путь предмета WB', true); return; }
  if (status) status.textContent = 'Собираю признаки…';
  try {
    const r = await api('/api/season/features?path=' + encodeURIComponent(path) + (force ? '&force=1' : ''));
    featureDictCache[path] = r.dict;
    if (status) status.textContent = `всего в предмете: ${r.dict.total ?? '—'}, карточек: ${r.dict.withCards ?? 0}`;
    renderFeatureDictBody(r.dict);
    seasonLogPush(r.dict.log); renderLogComment(document.getElementById('se-feat-log'), r.dict.log);
  } catch (e) { if (status) status.textContent = ''; toast('Ошибка сбора признаков: ' + e.message, true); }
}

// ТОП-20 «неопределённых»: превью (с зумом), продажи, средняя цена, чекбокс + Сохранить.
let _undetSel = new Set();
function renderUndetermined(list, path) {
  const body = document.getElementById('se-undet-body'); if (!body) return;
  if (!list || !list.length) { body.innerHTML = '<div class="mini">Неопределённых артикулов не найдено (все прошли фильтр либо ниже порога выручки/сегмента).</div>'; return; }
  _undetSel = new Set();
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const rows = list.map((m) => {
    const nm = String(m.wb);
    const link = `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;
    return `<tr>
      <td><input type="checkbox" class="se-undet-cb" data-wb="${nm}"></td>
      <td class="se-comp-name"><span class="se-comp-thumb"><img loading="lazy" alt="" data-nm="${nm}" src="${wbThumbUrl(nm, 'tm')}"></span><a href="${link}" target="_blank" rel="noopener">${seEsc(m.name || ('арт. ' + nm))}</a></td>
      <td>${seEsc(m.brand || '—')}</td>
      <td class="num">${m.avgPrice != null ? fmt(m.avgPrice) + ' ₽' : '—'}</td>
      <td class="num">${fmt(m.unitsSold)}</td>
      <td class="num">${fmt(m.revenue)} ₽</td>
      <td class="num">${fmt(m.monthlyRevenue)} ₽</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<div class="se-comp-scroll"><table class="se-comp-table" style="min-width:640px">
      <thead><tr><th>✓</th><th>Название</th><th>Бренд</th><th class="num">Ср. цена</th><th class="num">Продаж</th><th class="num">Выручка</th><th class="num">₽/мес</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="se-feat-bar" style="margin-top:10px">
      <button class="btn btn-primary" id="se-undet-save" type="button">Сохранить выбранные в выборку</button>
      <span class="mini" id="se-undet-selinfo">Выбрано: 0</span>
    </div>`;
  installSeasonZoom();
  const selinfo = document.getElementById('se-undet-selinfo');
  body.querySelectorAll('.se-undet-cb').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) _undetSel.add(cb.dataset.wb); else _undetSel.delete(cb.dataset.wb);
    if (selinfo) selinfo.textContent = 'Выбрано: ' + _undetSel.size;
  }));
  document.getElementById('se-undet-save')?.addEventListener('click', () => {
    if (!_undetSel.size) { toast('Отметьте хотя бы один артикул'); return; }
    const inc = seasonIncludeFor(path);
    _undetSel.forEach((w) => inc.add(w));
    const added = _undetSel.size;
    _undetSel = new Set();
    seasonSelPersist(path); // запомнить одобренные в артикуле
    renderSeason(); // самоочистка блока + обновление счётчика «добавлено вручную»
    toast(`Добавлено в выборку: ${added}. Теперь «Построить план».`);
  });
}
async function loadSeasonCandidates() {
  const cfg = collectSeasonForm();
  if (!cfg.phrases.length) { toast('Сначала впиши целевые фразы', true); return; }
  const status = document.getElementById('se-precheck-status');
  const box = document.getElementById('se-precheck-box');
  if (status) status.textContent = 'Собираю кандидатов…';
  try {
    const r = await api('/api/season/candidates', { method: 'POST', body: JSON.stringify(cfg) });
    if (status) status.textContent = `без ключа: ${r.noKeyCount} (с ключом ${r.withKey})`;
    const cnt = document.getElementById('se-precheck-count');
    if (cnt) cnt.textContent = `— нишевые ключи: [${(r.keys || []).join(', ') || '—'}]`;
    renderSeasonCandidates(r.candidates || []);
    if (box) box.open = true;
    seasonLogPush(r.log);
    if (r.budget) seasonBudget = r.budget;
  } catch (e) { if (status) status.textContent = ''; toast('Ошибка: ' + e.message, true); }
}
function renderSeasonCandidates(list) {
  const body = document.getElementById('se-precheck-body'); if (!body) return;
  if (!list.length) { body.innerHTML = '<div class="mini">Кандидатов без нишевого ключа не нашлось — вся выдача уже с ключом в названии.</div>'; return; }
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const rows = list.map((m) => {
    const nm = String(m.wb); const link = `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;
    const imgSrc = m.thumb || wbThumbUrl(nm, 'tm');
    return `<tr>
      <td><input type="checkbox" class="se-cand-cb" data-wb="${nm}"${seasonApproved.has(+nm) ? ' checked' : ''}></td>
      <td class="se-comp-name"><span class="se-comp-thumb"><img loading="lazy" alt="" data-nm="${nm}" data-thumb="${seEsc(m.thumb || '')}" src="${imgSrc}"></span><a href="${link}" target="_blank" rel="noopener">${seEsc(m.name || ('арт. ' + nm))}</a></td>
      <td>${seEsc(m.brand || '—')}</td>
      <td class="num">${nm}</td>
      <td class="num">${fmt(m.avgPrice)} ₽</td>
      <td class="num">${fmt(m.unitsSold)}</td>
      <td class="num">${fmt(m.revenue)} ₽</td>
      <td class="num">${fmt(m.monthlyRevenue)} ₽</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<div class="se-comp-scroll"><table class="se-comp-table" style="min-width:720px">
      <thead><tr><th>✓</th><th>Название</th><th>Бренд</th><th class="num">Артикул</th><th class="num">Ср. цена</th><th class="num">Продаж</th><th class="num">Выручка</th><th class="num">≈ ₽/мес</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="se-feat-bar" style="margin-top:10px">
      <button class="btn btn-primary" id="se-cand-save" type="button">💾 Сохранить отобранные</button>
      <span class="mini" id="se-cand-info">Отмечено: ${seasonApproved.size}</span>
    </div>`;
  installSeasonZoom();
  const info = document.getElementById('se-cand-info');
  body.querySelectorAll('.se-cand-cb').forEach((cb) => cb.addEventListener('change', () => {
    const id = +cb.dataset.wb;
    if (cb.checked) seasonApproved.add(id); else seasonApproved.delete(id);
    if (info) info.textContent = 'Отмечено: ' + seasonApproved.size;
  }));
  document.getElementById('se-cand-save')?.addEventListener('click', () => {
    const a = state.articles.find((x) => x.id === seasonBuildArticle); if (!a) return;
    a.seasonFilter = a.seasonFilter || {}; a.seasonFilter.approvedIds = [...seasonApproved]; unitPersist();
    const st = document.getElementById('se-precheck-status'); if (st) st.textContent = `отобрано: ${seasonApproved.size}`;
    toast(`Сохранено отобранных: ${seasonApproved.size}. Теперь «Построить план».`);
  });
}

function bindSeasonBuilder() {
  const g = (id) => document.getElementById(id);
  g('se-article')?.addEventListener('change', (e) => { seasonBuildArticle = e.target.value; renderSeason(); });
  g('se-log-dl')?.addEventListener('click', downloadSeasonLog);
  // Одобренные в «Предв. выборе» — восстановить для текущего артикула.
  { const a = state.articles.find((x) => x.id === seasonBuildArticle); seasonApproved = new Set(((a && a.seasonFilter && a.seasonFilter.approvedIds) || []).map(Number)); }
  g('se-precheck')?.addEventListener('click', loadSeasonCandidates);
  // Запоминаем фразы и минус-слова для артикула сразу при вводе (дебаунс-сейв в БД),
  // чтобы в следующий раз не вводить заново.
  const persistField = (id, key) => g(id)?.addEventListener('input', () => {
    const a = state.articles.find((x) => x.id === seasonBuildArticle); if (!a) return;
    a.seasonFilter = a.seasonFilter || {}; a.seasonFilter[key] = g(id).value; unitPersist();
  });
  persistField('se-phrases', 'phrases');
  persistField('se-minus', 'minusWords');
  persistField('se-niche', 'nicheWords');
  g('se-gender')?.addEventListener('change', () => {
    const a = state.articles.find((x) => x.id === seasonBuildArticle); if (!a) return;
    a.seasonFilter = a.seasonFilter || {}; a.seasonFilter.gender = g('se-gender').value; unitPersist();
  });
  g('se-arttype')?.addEventListener('change', () => {
    const a = state.articles.find((x) => x.id === seasonBuildArticle); if (!a) return;
    a.seasonFilter = a.seasonFilter || {}; a.seasonFilter.articleType = g('se-arttype').value; unitPersist();
  });
  g('se-filter-reset')?.addEventListener('click', () => {
    const set = (id, val) => { const el = g(id); if (el) el.value = val; };
    set('se-limit', '60'); set('se-pmin', ''); set('se-pmax', ''); set('se-minsales', ''); set('se-minrev', '');
    set('se-year', String(new Date().getUTCFullYear()));
    set('se-growth-manual', ''); set('se-cost', ''); set('se-undercut', '');
    set('se-markup-min', ''); set('se-markup-max', ''); set('se-spp', ''); set('se-price-mult', '');
    if (g('se-level')) g('se-level').value = 'top3';
    if (g('se-growth')) g('se-growth').value = 'cohort';
    if (g('se-segment')) g('se-segment').value = 'auto';
    ['se-oos', 'se-weekly'].forEach((id) => { const el = g(id); if (el) el.checked = true; });
    toast('Фильтры сброшены');
  });
  g('se-build')?.addEventListener('click', async () => {
    const cfg = collectSeasonForm();
    if (!cfg.phrases.length) { toast('Впиши хотя бы одну целевую фразу (по ней ищем товары)', true); return; }
    seasonBuilding = true; renderSeason();
    try {
      const built = await api('/api/season/build', { method: 'POST', body: JSON.stringify(cfg) });
      const blog = (built && built.report && built.report.log) || [];
      seasonLogPush(blog); renderLogComment(document.getElementById('se-build-log'), blog);
      // запомнить подсказку типа артикула (движок оценил рельеф рынка)
      const hint = built && built.report && built.report.plan && built.report.plan.seasonalityHint;
      if (hint) seasonHintByArticle[cfg.articleId] = hint;
      // запомнить фильтр в артикуле, чтобы перестраивать в один клик
      const a = state.articles.find((x) => x.id === cfg.articleId);
      if (a) {
        a.seasonFilter = { ...(a.seasonFilter || {}),
          phrases: g('se-phrases')?.value || '', minusWords: cfg.minusWords, nicheWords: cfg.nicheWords,
          approvedIds: cfg.approvedIds, excludedIds: cfg.excludedIds, gender: cfg.gender,
          priceMin: cfg.priceMin, priceMax: cfg.priceMax, minSales: cfg.minSales, minRevenue: cfg.minRevenue,
          limit: cfg.limit, targetYear: cfg.targetYear, targetLevel: cfg.targetLevel, articleType: cfg.articleType,
          growthMode: cfg.growthMode, growthManual: cfg.growthManual,
          priceSegment: cfg.priceSegment, cost: cfg.cost, markupMin: cfg.markupMin, markupMax: cfg.markupMax, spp: cfg.spp,
          priceUndercut: cfg.priceUndercut, priceMultiplier: cfg.priceMultiplier, oos: cfg.oos, weekly: cfg.weekly };
        await recalc(true).catch(() => {});
      }
      // обновить остаток лимита после построения
      try { const st = await api('/api/season/status'); seasonBudget = st.budget || seasonBudget; } catch { /* ignore */ }
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
  // Исключённые конкуренты: восстановить из cfg плана (если пересобирали с исключениями).
  if (!seasonExcludedByArticle[articleId]) {
    seasonExcludedByArticle[articleId] = new Set(((rec.cfg && rec.cfg.excludedIds) || []).map(Number).filter(Boolean));
  }
  const exSet = seasonExcludedByArticle[articleId];
  // План построен СТАРЫМ движком (нет календаря сезона/поставок) → графики отрисуются
  // по устаревшим данным. Просим перестроить, иначе новые правки «не видно».
  const stale = !p.seasonCal || !Array.isArray(p.deliveries);
  const canRebuild = stale && rec.cfg && rec.cfg.path;
  const staleBanner = stale
    ? `<div class="se-stale">⚠ Этот план построен предыдущей версией движка — новые периоды, вехи, лента благоприятного периода и поставки частями появятся только после пересборки.${canRebuild ? ' <button class="btn btn-primary" id="se-rebuild" type="button">↻ Построить заново</button>' : ' Откройте конструктор выше, выберите этот артикул и нажмите «▶ Построить план».'}</div>`
    : '';
  box.innerHTML = staleBanner + seasonSummary(rep, p) + seasonSegmentsBlock(rep) + seasonColorsBlock(rep, p) + seasonSizesBlock(rep) + seasonReconcileBlock(rep, p, articleId) + seasonPlanChecks(rep, p) + seasonAttributesBlock(rep) + seasonCompetitorsBlock(rep, articleId) + seasonChartsBlock(rep, p) + `<div id="se-table">${seasonTableBlock(p)}</div>`;
  installSeasonZoom();
  // Чекбоксы ТОП-15: отжатие → исключить конкурента и пересобрать план (дебаунс, кэш SERP).
  box.querySelectorAll('.se-comp-cb').forEach((cb) => {
    const wb = Number(cb.dataset.wb);
    if (exSet.has(wb)) { cb.checked = false; cb.closest('tr')?.classList.add('se-row-off'); }
    cb.addEventListener('change', () => {
      if (cb.checked) exSet.delete(wb); else exSet.add(wb);
      cb.closest('tr')?.classList.toggle('se-row-off', !cb.checked);
      scheduleSeasonExclusionRebuild(articleId, rec.cfg || {}, exSet);
    });
  });
  // Клик по значению характеристики → вписать строгий ключ в конструктор (Часть 1).
  box.querySelectorAll('.se-attr-chip').forEach((b) => b.addEventListener('click', () => {
    const inp = document.getElementById('se-must'); if (!inp) return;
    inp.value = b.dataset.attrVal || '';
    inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); inp.focus();
    toast('Ключ вписан в конструктор — нажмите «Построить план»');
  }));
  bindSeasonView(p);
  bindReconcile(rep, p, articleId); // Этап 3: слой примирения прогноз↔карточка → План по размерам
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

// Дебаунс: пользователь может отжать несколько конкурентов подряд — пересобираем один раз.
function scheduleSeasonExclusionRebuild(articleId, baseCfg, exSet) {
  clearTimeout(_seExclTimer);
  const status = document.getElementById('se-comp-status');
  if (status) status.textContent = `исключено: ${exSet.size} · пересчёт через мгновение…`;
  _seExclTimer = setTimeout(() => applySeasonExclusions(articleId, baseCfg, exSet), 900);
}

// Пересобрать план на выборке БЕЗ исключённых конкурентов (место занимают следующие по
// выручке). Из кэша SERP — без обращений к MPStats. Перестраивает оба графика и ТОП-15.
async function applySeasonExclusions(articleId, baseCfg, exSet) {
  const status = document.getElementById('se-comp-status');
  const cfg = { ...baseCfg, articleId, excludedIds: [...exSet] };
  if (!(cfg.phrases && cfg.phrases.length) && !cfg.path) { if (status) status.textContent = 'нет параметров для пересборки'; return; }
  if (status) status.textContent = 'пересобираю план…';
  try {
    await api('/api/season/build', { method: 'POST', body: JSON.stringify(cfg) });
    // запомнить исключения в артикуле, чтобы не отжимать заново
    const a = state.articles.find((x) => x.id === articleId);
    if (a) { a.seasonFilter = a.seasonFilter || {}; a.seasonFilter.excludedIds = [...exSet]; unitPersist(); }
    try { const st = await api('/api/season/status'); seasonBudget = st.budget || seasonBudget; } catch { /* ignore */ }
    await renderSeasonView(articleId);
    toast(exSet.size ? `Выборка обновлена: исключено ${exSet.size}, план пересобран` : 'Выборка восстановлена, план пересобран');
  } catch (e) {
    if (status) status.textContent = 'ошибка: ' + e.message;
    toast('Ошибка пересборки: ' + e.message, true);
  }
}

// Хост basket-CDN Wildberries по «тому» (vol) nmID. Диапазоны расширяются со временем;
// при промахе есть перебор соседних хостов на onerror (см. installSeasonZoom).
function wbBasketHost(vol) {
  const t = [143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2833, 3061, 3299, 3537, 3823, 3959, 4193, 4293, 4483, 4783];
  for (let i = 0; i < t.length; i++) if (vol <= t[i]) return String(i + 1).padStart(2, '0');
  return String(t.length + 1).padStart(2, '0');
}
// URL превью первого слайда карточки WB по nmID. size: 'tm' (мелкое) | 'big' (крупное).
function wbThumbUrl(nmId, size = 'big', hostShift = 0) {
  const id = Number(nmId); if (!Number.isFinite(id) || id <= 0) return '';
  const vol = Math.floor(id / 100000), part = Math.floor(id / 1000);
  let host = Number(wbBasketHost(vol)) + hostShift;
  if (host < 1) host = 1;
  return `https://basket-${String(host).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${id}/images/${size}/1.webp`;
}

// Разворачиваемый блок «Топ-10 конкурентов в выборке» — чтобы проверить релевантность
// фильтра: на каких именно аналогах построена аналитика. Свёрнут по умолчанию.
function seasonCompetitorsBlock(rep, articleId) {
  const items = (rep.perItem || []).filter((m) => m && ((+m.revenue > 0) || (+m.unitsSold > 0)));
  if (!items.length) return '';
  const exSet = (articleId && seasonExcludedByArticle[articleId]) || new Set();
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const hasShare = items.some((m) => m.share != null);
  // Витрина ТОП-15 — за ПОСЛЕДНИЙ ГОД (revenueLY/unitsSoldLY), если есть (SERP-план);
  // для старых планов — за весь период анализа.
  const hasLY = items.some((m) => m.revenueLY != null);
  const rev = (m) => hasLY ? (+m.revenueLY || 0) : (+m.revenue || 0);
  const units = (m) => hasLY ? (+m.unitsSoldLY || 0) : (+m.unitsSold || 0);
  const top = items.slice().sort((a, b) => rev(b) - rev(a)).slice(0, 15);
  const rows = top.map((m, i) => {
    const nm = m.wb != null ? String(m.wb) : '';
    const link = nm ? `https://www.wildberries.ru/catalog/${nm}/detail.aspx` : '';
    const perMonth = hasLY ? Math.round(rev(m) / 12) : (m.days > 0 ? Math.round((+m.revenue || 0) / m.days * 30) : null);
    // Ср. цена: медианная за год (устойчива к распродажам), иначе выручка/штук.
    const avgPrice = (+m.priceMed > 0) ? +m.priceMed : ((units(m) > 0) ? rev(m) / units(m) : (+m.price || null));
    const title = seEsc(m.name || (nm ? 'арт. ' + nm : '—'));
    // Картинку берём из готового URL serp (m.thumb) — он точный; иначе гадаем хост по nmID.
    const imgSrc = m.thumb || (nm ? wbThumbUrl(nm, 'tm') : '');
    const thumb = imgSrc
      ? `<span class="se-comp-thumb"><img loading="lazy" alt="" data-nm="${nm}" data-thumb="${seEsc(m.thumb || '')}" src="${imgSrc}"></span>`
      : '<span class="se-comp-thumb noimg"></span>';
    const nameCell = nm ? `${thumb}<a href="${link}" target="_blank" rel="noopener">${title}</a>` : `${thumb}${title}`;
    // Оборачиваемость (дн) — на сколько дней хватит склада при текущем темпе продаж.
    // SERP отдаёт только текущий остаток (balance) без дневной истории: считаем
    // balance ÷ среднесуточные продажи за год (unitsSoldLY/365). Для старых планов —
    // прежняя формула по среднему остатку (avgStock·days/units).
    const turnover = (+m.balance > 0 && units(m) > 0)
      ? Math.round(+m.balance / (units(m) / 365))
      : ((m.avgStock > 0 && +m.unitsSold > 0 && m.days > 0)
          ? Math.round(m.avgStock * m.days / m.unitsSold) : null);
    const shareCell = hasShare ? `<td class="num" title="Доля поискового трафика по целевым словам/фразам">${m.share != null ? Math.round(m.share * 100) + '%' : '—'}</td>` : '';
    const cb = `<td class="num"><input type="checkbox" class="se-comp-cb" data-wb="${nm}" title="Снять галочку → убрать этого конкурента из выборки (место займёт следующий по выручке)" checked></td>`;
    return `<tr>
      ${cb}
      <td class="num">${i + 1}</td>
      <td class="se-comp-name">${nameCell}</td>
      <td>${seEsc(m.brand || '—')}</td>
      <td class="num">${nm || '—'}</td>
      ${shareCell}
      <td class="num">${avgPrice != null ? fmt(avgPrice) + ' ₽' : '—'}</td>
      <td class="num se-comp-range" title="Разброс дневной цены за год (мин–макс). Широкий разброс = частые распродажи; смотри, адекватна ли ср. цена.">${(+m.priceLo > 0 && +m.priceHi > 0) ? fmt(m.priceLo) + '–' + fmt(m.priceHi) : '—'}</td>
      <td class="num">${fmt(units(m))}</td>
      <td class="num">${fmt(rev(m))} ₽</td>
      <td class="num">${perMonth != null ? fmt(perMonth) + ' ₽' : '—'}</td>
      <td class="num">${turnover != null ? turnover + ' дн' : '—'}</td>
    </tr>`;
  }).join('');
  const totalKept = rep.groupSize != null ? rep.groupSize : items.length;
  const withData = rep.itemsWithData != null ? rep.itemsWithData : items.length;
  const relInfo = rep.relevance ? `<div class="mini" style="color:var(--accent-2)">🎯 Поведенческая релевантность: порог доли ${Math.round((rep.relevance.threshold||0)*100)}%, профилей из базы ${rep.relevance.cached||0}, запросов сети ${rep.relevance.requests||0}${rep.relevance.dailyLimit ? ' · ⚠ упёрлись в суточный лимит — часть кандидатов не проверена' : ''}.</div>` : '';
  const exCount = exSet.size;
  return `<details class="se-comp"${exCount ? ' open' : ''}>
    <summary>🔍 Топ-15 конкурентов в выборке — проверка релевантности <span class="mini">(в выборке ${totalKept}, с данными ${withData}${exCount ? `, исключено ${exCount}` : ''})</span></summary>
    <div class="se-comp-body">
      <div class="mini">Продаж/Выручка/₽мес — за <b>${hasLY ? 'последний год' : 'период анализа (2 года)'}</b> (ранг сезонности строится на 2 годах). Наведите на превью — увеличится; клик по названию — карточка на Wildberries.</div>
      <div class="mini" style="color:var(--accent-2)">☑ Все конкуренты включены. <b>Снимите галочку</b> у нерелевантного — он уйдёт из выборки, а его место займёт следующий по выручке, и план пересоберётся автоматически (без обращений к MPStats). <span id="se-comp-status"></span></div>
      ${relInfo}
      <div class="se-comp-scroll"><table class="se-comp-table">
        <thead><tr><th class="num" title="В выборке / исключить">✓</th><th class="num">#</th><th>Название</th><th>Бренд</th><th class="num">Артикул WB</th>${hasShare ? '<th class="num" title="Доля поискового трафика по целевым словам/фразам">Доля</th>' : ''}<th class="num" title="Средняя цена продажи (медиана по штукам за год) — цена покупателя">Ср. цена</th><th class="num" title="Разброс дневной цены за год (мин–макс)">Разброс</th><th class="num">Продаж</th><th class="num">Выручка</th><th class="num" title="Средняя выручка в месяц, пока товар был в наличии">≈ ₽/мес</th><th class="num" title="Оборачиваемость = средний остаток / среднесуточные продажи. Меньше — быстрее распродаётся. Доступно для планов, построенных новой версией.">Оборачив.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  </details>`;
}

// Наведение на превью конкурента → увеличенное фото над строкой; + перебор basket-хостов
// WB при промахе URL. Один перехватчик на документе (переживает перерисовки блока).
let _seZoomBound = false;
function installSeasonZoom() {
  if (_seZoomBound) return; _seZoomBound = true;
  let zoom = null;
  const show = (img) => {
    const nm = img.getAttribute('data-nm'); if (!nm) return;
    if (!zoom) { zoom = document.createElement('div'); zoom.className = 'se-zoom'; zoom.innerHTML = '<img alt="">'; document.body.appendChild(zoom); }
    const shift = +(img.dataset.shift || 0);
    const w = Math.min(Math.round(window.innerWidth * 0.7), 300); // 4–5× от превью, адаптивно
    zoom.style.width = w + 'px';
    // Крупное фото: из точного URL serp (заменяем размер на big), иначе гадаем хост.
    const t = img.getAttribute('data-thumb');
    zoom.querySelector('img').src = t ? t.replace(/\/images\/[^/]+\//, '/images/big/') : wbThumbUrl(nm, 'big', shift);
    zoom.style.display = 'block';
    const r = img.getBoundingClientRect();
    const zh = w * 4 / 3 + 10;                 // карточка WB ~3:4
    let top = r.top - zh - 8;                  // над строкой
    if (top < 8) top = r.bottom + 8;           // не влезло сверху — показать снизу
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    zoom.style.left = left + 'px'; zoom.style.top = Math.max(8, top) + 'px';
  };
  const hide = () => { if (zoom) zoom.style.display = 'none'; };
  document.addEventListener('mouseover', (e) => { const img = e.target.closest && e.target.closest('.se-comp-thumb img'); if (img) show(img); });
  document.addEventListener('mouseout', (e) => { const img = e.target.closest && e.target.closest('.se-comp-thumb img'); if (img) hide(); });
  document.addEventListener('scroll', hide, true);
  // Перебор соседних basket-хостов при промахе URL превью.
  document.addEventListener('error', (e) => {
    const img = e.target; if (!(img instanceof HTMLImageElement) || !img.closest || !img.closest('.se-comp-thumb')) return;
    const nm = img.getAttribute('data-nm'); if (!nm) return;
    const shifts = [1, -1, 2, -2, 3, 4];
    const att = +(img.dataset.att || 0);
    if (att < shifts.length) { img.dataset.att = att + 1; img.dataset.shift = shifts[att]; img.src = wbThumbUrl(nm, 'tm', shifts[att]); }
    else { const w = img.closest('.se-comp-thumb'); if (w) w.classList.add('noimg'); img.remove(); }
  }, true);
}

// Ценовые сегменты выборки (квартили по медианной цене за год) + выгодность по себестоимости.
// Показывает, как объём/выручка/цена отличаются по сегментам, и в каком ты работаешь.
function seasonSegmentsBlock(rep) {
  const s = rep.segments;
  if (!s || !Array.isArray(s.bands) || !s.bands.length) return '';
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const vClass = (v) => v === 'ok' ? 'se-seg-ok' : v === 'thin' ? 'se-seg-thin' : v === 'loss' ? 'se-seg-loss' : '';
  const vLabel = (v) => v === 'ok' ? '✅ в плюс' : v === 'thin' ? '⚠ тонкая маржа' : v === 'loss' ? '⛔ в убыток' : '';
  // Попадает ли сегмент в целевое окно (от себестоимости) — по пересечению диапазонов.
  const tb = s.targetBand;
  const inTarget = (b) => tb ? (b.lo <= (tb.hi == null ? Infinity : tb.hi) && (b.hi == null ? Infinity : b.hi) >= tb.lo) : false;
  const rows = s.bands.map((b) => {
    const active = (s.active && s.active === b.key) || inTarget(b);
    const range = `${fmt(b.lo)}–${b.hi != null ? fmt(b.hi) : '∞'} ₽`;
    const acc = s.cost ? `<td class="num" title="Наша бухгалтерская цена = цена покупателя / (1 − СПП ${s.spp || 0}%)">${b.accounting ? fmt(b.accounting) + ' ₽' : '—'}</td>` : '';
    const viab = s.cost ? `<td class="num ${vClass(b.viable)}" title="Наценка нашей бухгалтерской цены к себестоимости ${fmt(s.cost)}₽">×${b.markup || '—'} ${vLabel(b.viable)}</td>` : '';
    return `<tr class="${active ? 'se-seg-active' : ''} ${vClass(b.viable)}">
      <td>${active ? '🎯 ' : ''}${seEsc(b.name)}</td>
      <td class="num">${range}</td>
      <td class="num">${b.count}</td>
      <td class="num">${fmt(b.top3Units)}</td>
      <td class="num">${fmt(b.top3Rev)} ₽</td>
      <td class="num">${fmt(b.avgPrice)} ₽</td>
      ${acc}${viab}
    </tr>`;
  }).join('');
  const costNote = s.cost
    ? `Себестоимость ${fmt(s.cost)} ₽, СПП ${s.spp || 0}%. «Наша цена» = цена покупателя ÷ (1 − СПП) — от неё считается наценка. Зелёный — наценка ≥ целевой, жёлтый — ниже цели, красный — в убыток. Грубая прикидка (без полного юнита).`
    : 'Задай себестоимость, наценку и СПП в конструкторе — подсветим, в каком сегменте достигается твоя целевая наценка.';
  const activeNote = tb
    ? `🎯 Целевое окно цены покупателя <b>${fmt(tb.lo)}–${tb.hi != null ? fmt(tb.hi) : '∞'} ₽</b> (${seEsc(tb.source || '')}). План построен по конкурентам этого окна — объём, цена и ТОП-15 по ним.`
    : (s.active && s.active !== 'auto'
      ? `План построен по сегменту <b>«${seEsc((s.bands.find((b) => b.key === s.active) || {}).name || s.active)}»</b>.`
      : 'План построен по <b>всей выборке</b>. Задай себестоимость+наценку (или выбери сегмент) в конструкторе, чтобы считать по своему ценовому окну.');
  return `<details class="se-comp" open>
    <summary>💰 Ценовые сегменты выборки <span class="mini">(объём и цена сильно зависят от сегмента)</span></summary>
    <div class="se-comp-body">
      <div class="mini">${activeNote}</div>
      <div class="se-comp-scroll"><table class="se-comp-table se-seg-table">
        <thead><tr><th>Сегмент</th><th class="num" title="Цена покупателя (с СПП), как в MPStats">Цена покупателя</th><th class="num" title="Товаров в сегменте">Тов.</th><th class="num" title="Средние продажи ТОП-3 сегмента за год">ТОП-3 продаж/год</th><th class="num" title="Средняя выручка ТОП-3 сегмента за год">ТОП-3 выручка/год</th><th class="num" title="Средняя цена продажи ТОП-3 (медиана по штукам)">Ср. цена</th>${s.cost ? '<th class="num" title="Наша бухгалтерская цена = цена покупателя / (1−СПП)">Наша цена</th><th class="num">Наценка</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="mini">${costNote}</div>
    </div>
  </details>`;
}

// Кол-во к пошиву по цветам. ЛОГИКА: «Выкупы (прогноз)» = объём ОДНОГО лучшего цвета, а не
// итог на все. Поэтому лучший цвет = прогноз (100%), остальные масштабируются ОТНОСИТЕЛЬНО
// лучшего по силе на 1 карточку (avgPerSku). Итог = сумма (больше прогноза). Зеркалит чистую
// colorQuantities() из lib/season/colorSize.js (та же формула, проверена тестом).
// База — СУММАРНЫЙ объём продаж цвета (units) = реальный спрос. Зеркалит colorQuantities()
// из lib/season/colorSize.js (проверено тестом). Ср/арт — справочно + флаг «эфф».
function seasonColorQuantities(colors, forecast, minRelPct, minCount, minColors) {
  const F = Math.max(0, +forecast || 0);
  const named = (colors || []).filter((c) => c && Number(c.units) > 0 && c.name !== 'не указан');
  if (!named.length || !F) return null;
  const mc = minCount || 3;
  const trusted = named.filter((c) => (c.skus || 0) >= mc);
  const lowData = named.filter((c) => (c.skus || 0) < mc);
  const scalePool = trusted.length ? trusted : named;
  const bestUnits = Math.max(...scalePool.map((c) => c.units));
  const mkRow = (c, low) => {
    const rel = Math.min(c.units / bestUnits, 1);
    return { name: c.name, units: c.units, avgPerSku: c.avgPerSku, skus: c.skus, normShare: c.normShare, rel: Math.round(rel * 1000) / 10, qty: Math.round(F * rel), lowData: !!low, efficient: false };
  };
  const trustedRows = trusted.map((c) => mkRow(c, false)).sort((a, b) => b.units - a.units);
  const lowRows = lowData.map((c) => mkRow(c, true)).sort((a, b) => (b.skus - a.skus) || (b.units - a.units));
  const leaderAvg = (trustedRows[0] || lowRows[0] || {}).avgPerSku || 0;
  for (const r of [...trustedRows, ...lowRows]) r.efficient = leaderAvg > 0 && (r.avgPerSku || 0) > leaderAvg * 1.15;
  const passCount = trustedRows.filter((r) => r.rel >= minRelPct).length;
  const ordered = [...trustedRows, ...lowRows];
  const keep = Math.min(ordered.length, Math.max(passCount, Math.max(1, minColors || 1)));
  const core = ordered.slice(0, keep);
  const weak = ordered.slice(keep);
  return {
    best: trustedRows[0] || core[0], core, weak,
    grandTotal: core.reduce((s, r) => s + r.qty, 0),
    weakSummary: weak.length ? { count: weak.length, qty: weak.reduce((s, r) => s + r.qty, 0), names: weak.map((r) => r.name) } : null,
  };
}

// Доли спроса по ЦВЕТАМ + количество к пошиву. Нормализованная доля = среднее на 1 артикул
// (÷ Σсредних) — убирает перекос «белого больше выкладывают». Кол-во считается относительно
// лучшего цвета (см. seasonColorQuantities).
function seasonColorsBlock(rep, p) {
  const ca = rep.colorAnalysis;
  if (!ca || !Array.isArray(ca.colors) || !ca.colors.length) return '';
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const forecast = Math.round(((p && p.forecastDaily) || []).reduce((s, d) => s + (+d.plannedOrders || 0), 0));
  const cq = seasonColorQuantities(ca.colors, forecast, seasonColorMinRel, ca.minCount, seasonColorMinCount);
  const qtyByName = new Map();
  const bestName = cq ? cq.best.name : null;
  if (cq) { cq.core.forEach((r) => qtyByName.set(r.name, { qty: r.qty, rel: r.rel, core: true, lowData: r.lowData, efficient: r.efficient })); cq.weak.forEach((r) => qtyByName.set(r.name, { qty: r.qty, rel: r.rel, core: false, lowData: r.lowData, efficient: r.efficient })); }

  // Отображение — строго по «Доле объёма» убыв. (что просил пользователь). Значки ⚑ добор / ⚠ мало
  // остаются на своих строках, но не ломают порядок: лидер (макс. доля) естественно оказывается сверху.
  const ordered = (cq
    ? [...cq.core, ...cq.weak].map((r) => ca.colors.find((c) => c.name === r.name)).filter(Boolean)
      .concat(ca.colors.filter((c) => !qtyByName.has(c.name)))
    : ca.colors.slice())
    .slice().sort((x, y) => (y.rawShare || 0) - (x.rawShare || 0) || (y.units || 0) - (x.units || 0));
  const maxRaw = Math.max(1, ...ca.colors.map((c) => c.rawShare || 0)); // масштаб полоски доли объёма
  // Ячейка «число + подпись»: число прижато к правому краю фикс-колонки, подпись (▲ эфф / ⚑ добор /
  // · доп.) — в отдельной колонке справа. Так цифры Ср/арт и Кол-во стоят строго друг под другом,
  // а надписи не смещают их влево (просьба пользователя по выравниванию).
  const numCell = (val, note, title) => `<span class="numcell"><span class="nv">${val}</span><span class="nn"${title ? ` title="${title}"` : ''}>${note || ''}</span></span>`;
  const rows = ordered.map((c) => {
    const q = qtyByName.get(c.name);
    const isBest = c.name === bestName;
    const qtyVal = q ? (q.core ? `<b>${fmt(q.qty)}</b>` : fmt(q.qty)) : '—';
    const qtyNote = q ? (q.core ? (q.lowData ? '⚑ добор' : '') : '· доп.') : '';
    const cls = isBest ? 'se-color-best' : ((!q || q.core) ? '' : 'se-seg-thin');
    const effNote = q && q.efficient ? '▲ эфф' : '';
    const nameCell = `${isBest ? '★ <b>' : ''}${seEsc(c.name)}${isBest ? '</b> <span class="mini">лидер</span>' : ''}${c.lowConfidence ? ' <span class="mini">⚠ мало</span>' : ''}`;
    return `<tr class="${cls}"${isBest ? ' style="background:rgba(255,196,0,.16)"' : ''}>
      <td>${nameCell}</td>
      <td class="num">${c.skus}</td>
      <td class="num">${fmt(c.units)}</td>
      <td class="num se-share-cell"><span class="se-share-bar" style="width:${Math.round((c.rawShare || 0) / maxRaw * 90)}px"></span>${c.rawShare != null ? c.rawShare + '%' : '—'}</td>
      <td class="num">${numCell(fmt(c.avgPerSku), effNote, effNote ? 'Ср/арт выше, чем у лидера — цвет продаётся лучше на карточку при меньшем объёме: возможная недооценённая ниша' : '')}</td>
      <td class="num">${numCell(qtyVal, qtyNote)}</td>
    </tr>`;
  }).join('');

  const head = cq
    ? `<div class="mini"><b>Логика количества:</b> база — <b>суммарный объём продаж</b> цвета (реальный спрос). «Выкупы (прогноз)» = ${fmt(forecast)} шт — это объём <b>лидера по объёму</b> (★ ${seEsc(cq.best.name)}). Остальные — меньше, <b>пропорционально своему объёму относительно лидера</b> (кол-во = прогноз × доля÷лидер). Ассортимент — минимум <b>${seasonColorMinCount}</b> расцветок (сперва надёжные ≥${ca.minCount} карточек, затем <b>⚑ добор</b>). <b>Ср/арт</b> — справочно; <b>▲ эфф</b> = продаётся лучше на карточку, чем лидер (возможная недооценённая ниша).</div>`
    : `<div class="mini">Доля объёма = суммарные продажи цвета ÷ все продажи. Кол-во появится, когда есть прогноз и доверенные цвета.</div>`;
  const totalLine = cq
    ? `<div class="se-color-total"><b>Общий тираж (${cq.core.length} цвет. ассортимента): ${fmt(cq.grandTotal)} шт</b> — больше прогноза, т.к. прогноз = только лидер по объёму.${cq.weakSummary ? ` Доп. (${cq.weakSummary.count}): ${seEsc(cq.weakSummary.names.join(', '))} — ещё ~${fmt(cq.weakSummary.qty)} шт, если расширять.` : ''}
        <label class="mini" style="margin-left:8px">цветов в ассортименте: <input id="se-color-count" type="number" min="1" max="20" step="1" value="${seasonColorMinCount}" style="width:52px" title="Гарантированный минимум расцветок — движок добирает даже слабые"></label>
        <label class="mini" style="margin-left:8px">порог силы: <input id="se-color-thr" type="number" min="5" max="100" step="5" value="${seasonColorMinRel}" style="width:52px" title="Цвета сильнее этого % от лучшего входят сверх минимума"> %</label></div>`
    : '';
  const poolNote = ca.poolSize
    ? `по <b>${ca.poolSize}</b> артикулам выдачи${ca.planSize && ca.poolSize > ca.planSize ? ` (план — по ТОП-${ca.planSize})` : ''}${ca.serpTotal ? ` из ${ca.serpTotal} найденных` : ''} · продаж ${fmt(ca.total.units)}`
    : `конкурентов ${ca.total.skus}, продаж ${fmt(ca.total.units)}`;
  // строка ВСЕГО: суммарный тираж по всем цветам (что реально отшивается) — прямо под колонкой Кол-во
  const totSkus = ordered.reduce((s, c) => s + (c.skus || 0), 0);
  const totUnits = ordered.reduce((s, c) => s + (c.units || 0), 0);
  const totQty = ordered.reduce((s, c) => { const q = qtyByName.get(c.name); return s + (q ? q.qty : 0); }, 0);
  const footRow = cq
    ? `<tfoot><tr class="mx-vsego"><th>ВСЕГО (${ordered.filter((c) => qtyByName.get(c.name)).length} цв.)</th><th class="num">${totSkus}</th><th class="num">${fmt(totUnits)}</th><th class="num">100%</th><th class="num">—</th><th class="num"><b>${fmt(totQty)}</b></th></tr></tfoot>`
    : '';
  return `<details class="se-comp" open>
    <summary>🎨 Цвета: доли спроса и кол-во к пошиву <span class="mini">(${poolNote})</span></summary>
    <div class="se-comp-body">
      ${head}
      <div class="se-comp-scroll"><table class="se-comp-table se-seg-table">
        <thead><tr><th>Цвет</th><th class="num" title="Артикулов конкурентов этого цвета">Тов.</th><th class="num" title="Суммарные продажи цвета за период анализа (штук) — реальный спрос. Период определяется системой (лучший/заданный).">Продажи в период</th><th class="num" title="Доля суммарного объёма продаж цвета от всех — база плана">Доля объёма</th><th class="num" title="Средняя продажа на 1 карточку (справочно); ▲ эфф = выше лидера">Ср/арт</th><th class="num" title="Кол-во к пошиву = прогноз × доля объёма относительно лидера">Кол-во, шт</th></tr></thead>
        <tbody>${rows}</tbody>
        ${footRow}
      </table></div>
      ${totalLine}
    </div>
  </details>`;
}

// Размерный спрос из ОФИЦИАЛЬНОГО API MPStats (sales/sizes) по ТОП-N конкурентов. Доля спроса
// = продажи размера ÷ всех продаж; покрытие = доля карточек ТОПа, кто держит размер (→ ядро).
function seasonSizesBlock(rep) {
  const sa = rep.sizeAnalysis;
  if (!sa) return '';
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const dg = sa.diag || {};
  const win = sa.window ? `${seEsc(sa.window.d1)}…${seEsc(sa.window.d2)}` : seEsc(dg.window || '');
  // Пустой результат — не прячем блок, а объясняем причину (иначе «ничего не появилось»).
  if (!Array.isArray(sa.sizes) || !sa.sizes.length) {
    const err = (dg.errors || [])[0];
    const q = dg.quota ? ` Остаток квоты MPStats: ${dg.quota.remaining} из ${dg.quota.available}.` : '';
    const why = {
      'no-live-nm': 'Среди конкурентов нет карточек с продажами — не с кого брать размеры.',
      'low-quota': `Не хватает квоты MPStats на запрос ТОП-${dg.topN || 10}.${q} Раздел не строился, чтобы не жечь лимит. Повтори завтра или подними тариф.`,
      'fetch-throw': `Запрос к MPStats упал${err ? `: ${seEsc(err)}` : ''}.`,
      'all-one-size': 'Все конкуренты ТОПа продаются как ONE SIZE — размерного сплита нет.',
      'empty': 'MPStats не вернул продажи по размерам для этих карточек за период.',
    }[dg.reason] || 'Размерный спрос недоступен.';
    return `<details class="se-comp" open>
      <summary>📏 Размерная сетка и спрос <span class="mini">(нет данных)</span></summary>
      <div class="se-comp-body">
        <div class="mini">${why}</div>
        <div class="mini">Диагностика: источник MPStats sales/sizes, окно ${win || '—'}, ТОП-${dg.topN || 10}, запрошено ${dg.requested || 0}, из кэша ${dg.fromCache || 0}, живых вызовов ${dg.fetched || 0}${(dg.errors || []).length ? `, ошибки: ${seEsc((dg.errors || []).slice(0, 2).join('; '))}` : ''}.</div>
      </div>
    </details>`;
  }
  // В основную таблицу — только ядро сетки (что точно шить). Крайние размеры (низкое
  // покрытие) свёрнуты в сноску, чтобы не шуметь и не двоить шкалу.
  const core = sa.sizes.filter((s) => s.core);
  const shown = core.length ? core : sa.sizes; // страховка: если ядра нет — показать всё
  const coreShare = core.reduce((a, s) => a + s.share, 0);
  const rows = shown.map((s) => `<tr>
      <td><b>${seEsc(s.size)}</b>${s.origin ? ` <span class="mini">${seEsc(s.origin)}</span>` : ''}</td>
      <td class="num">${s.coverage}%</td>
      <td class="num">${s.carriers}</td>
      <td class="num">${fmt(s.sales)}</td>
      <td class="num se-share-cell"><span class="se-share-bar" style="width:${Math.round((s.share || 0) * 2.2)}px"></span><b>${s.share}%</b></td>
    </tr>`).join('');
  const ex = sa.extremeSummary;
  const exRow = ex ? `<tr class="se-seg-thin">
      <td><span class="mini">Крайние (${ex.count}): ${seEsc((ex.sizes || []).join(', '))} — редкие, под мин.партию/настил</span></td>
      <td class="num">—</td><td class="num">—</td><td class="num">${fmt(ex.sales)}</td>
      <td class="num se-share-cell"><b>${ex.share}%</b></td>
    </tr>` : '';
  const oneNote = sa.oneSizeCount ? ` <span class="mini">(+${sa.oneSizeCount} карточек ONE SIZE — вне размерного сплита)</span>` : '';
  const cacheNote = dg.fetched != null ? `Вызовов MPStats: ${dg.fetched} (из кэша ${dg.fromCache || 0}).` : '';
  return `<details class="se-comp" open>
    <summary>📏 Размерная сетка и спрос <span class="mini">(MPStats · продажи по размерам · ТОП-${sa.sizedCompetitors || sa.nmCount || ''} конкурентов)</span></summary>
    <div class="se-comp-body">
      <div class="mini"><b>Доля спроса</b> = продажи размера ÷ всех продаж ТОПа — это готовый рецепт сплита тиража. <b>Покрытие</b> = доля карточек ТОПа, кто держит размер (высокое → <b>ядро</b> сетки — шить обязательно). Одиночные размеры сведены в диапазоны ниши. Продажи — штук за окно ${win}.${oneNote}</div>
      <div class="mini">Ядро (${shown.length} размеров, ${Math.round(coreShare)}% спроса): <b>${(sa.grid.core || []).join(', ') || '—'}</b>. Всего продаж в выборке: ${fmt(sa.totalSales)}. ${cacheNote}</div>
      <div class="se-comp-scroll"><table class="se-comp-table se-seg-table">
        <thead><tr><th>Размер (диапазон)</th><th class="num" title="Доля карточек ТОПа, кто держит размер">Покрытие</th><th class="num" title="Сколько карточек держат размер (штучно)">Карт.</th><th class="num" title="Продажи размера за окно, штук">Продажи</th><th class="num" title="Рабочая доля для плана производства">Доля спроса</th></tr></thead>
        <tbody>${rows}${exRow}</tbody>
      </table></div>
    </div>
  </details>`;
}

// ============ Этап 3: слой примирения прогноз ↔ карточка → «План по размерам» ============
// Прогноз (Ранг сезонности) даёт кол-во по КАНОН-цветам × доли размеров-диапазонов. Карточка —
// свои имена цветов и дискретный ряд. reconcilePlan() (public/reconcile.js) сводит их в матрицу
// цвет×размер партии: авто-матч по канону/алиасам; ⚠ спорные и ➕ новые — на решение пользователю;
// непокрытое — явно в «не размещено» (ноль потерь). Применение пишет НОВУЮ партию (существующие
// не трогаются), учит алиасы (глобально) и привязки (пер-артикул), помечает новые цвета под ткань.

// Интерактивное состояние панели предпросмотра (одно активное на артикул).
// { articleId, open, choices:{demand→цвет|'__new__'|'__skip__'}, newNames:{demand→строка}, archive:{цвет→bool} }
let seasonReconcile = null;

// Активные (не архивные) цвета карточки — цель для сопоставления и отображения на листах.
function activeColors(a) {
  const arch = new Set((a && a.archivedColors) || []);
  return ((a && a.colors) || []).filter((c) => !arch.has(c));
}

// Поставки прогноза (приход на WB частями). Фолбэк — одна поставка на конец периода, если план
// не разбит на довозы. Берём только объём>0. Из объёмов используем ТОЛЬКО доли по времени (Разв.1-A).
function reconcileDeliveries(p) {
  const dv = (p && Array.isArray(p.deliveries) ? p.deliveries : []).filter((d) => (+d.qty || 0) > 0);
  if (dv.length) return dv.map((d) => ({ date: String(d.date || '').slice(0, 10), qty: Math.round(+d.qty || 0), tag: d.tag || '', title: d.title || '' }));
  const end = String((p && p.forecastPeriod && p.forecastPeriod.to) || '').slice(0, 10);
  return [{ date: end, qty: 1, tag: 'всё', title: 'вся партия одной поставкой' }];
}

// Дефолт решений: новый цвет по умолчанию СОЗДАЁТСЯ (иначе его объём молча уходил в «не размещено» —
// это и был баг «создать цвет не пишется»). Возвращает копию choices с заполненными дефолтами.
function resolveChoices(result, sr) {
  const choices = { ...((sr && sr.choices) || {}) };
  for (const c of result.colors) {
    if (choices[c.demand] === undefined && c.status === 'new') choices[c.demand] = '__new__';
  }
  return choices;
}

// Вход движка из отчёта: кол-во по цветам (ядро ассортимента) + доли размеров (ядро сетки).
function reconcileInputs(rep, p) {
  const ca = rep.colorAnalysis, sa = rep.sizeAnalysis;
  if (!ca || !Array.isArray(ca.colors) || !ca.colors.length) return null;
  if (!sa || !Array.isArray(sa.sizes) || !sa.sizes.length) return null;
  const forecast = Math.round(((p && p.forecastDaily) || []).reduce((s, d) => s + (+d.plannedOrders || 0), 0));
  const cq = seasonColorQuantities(ca.colors, forecast, seasonColorMinRel, ca.minCount, seasonColorMinCount);
  if (!cq) return null;
  const core = sa.sizes.filter((s) => s.core);
  return {
    forecast,
    colorRows: cq.core.map((r) => ({ name: r.name, qty: r.qty })),
    sizeRows: (core.length ? core : sa.sizes).map((s) => ({ size: s.size, origin: s.origin, share: s.share })),
  };
}

// Эффективная карточка с учётом решений пользователя — для предпросмотра И применения одинаково.
// База цветов — только АКТИВНЫЕ (архивные не могут быть целью сопоставления).
function reconcileEffectiveArticle(article, choices, newNames) {
  const colors = activeColors(article);
  const colorMap = {};
  // сохраняем только привязки на активные цвета
  for (const [k, v] of Object.entries(article.colorMap || {})) if (colors.includes(v)) colorMap[k] = v;
  for (const [demand, choice] of Object.entries(choices || {})) {
    if (choice === '__skip__') { delete colorMap[demand]; continue; }
    if (!choice) continue;
    if (choice === '__new__') {
      const nm = String((newNames && newNames[demand]) || demand).trim();
      if (nm) { if (!colors.includes(nm)) colors.push(nm); colorMap[demand] = nm; }
    } else if (colors.includes(choice)) colorMap[demand] = choice;
  }
  return { colors, sizes: article.sizes || [], colorMap };
}

// Прогнать движок. Два прохода: 1) узнать статусы; 2) с дефолтами (новые цвета → создать).
// Возвращает { result, inp, article, eff, choices } (choices — с заполненными дефолтами) или null.
function runReconcile(rep, p, articleId) {
  const inp = reconcileInputs(rep, p);
  const article = state.articles.find((x) => x.id === articleId);
  if (!inp || !article) return null;
  const sr = (seasonReconcile && seasonReconcile.articleId === articleId) ? seasonReconcile : { choices: {}, newNames: {} };
  const opts = { aliases: (state.settings && state.settings.colorAliases) || {}, sizeSplit: 'equal' };
  const res1 = reconcilePlan(reconcileEffectiveArticle(article, sr.choices, sr.newNames), inp.colorRows, inp.sizeRows, opts);
  const choices = resolveChoices(res1, sr); // новые цвета по умолчанию создаются
  const eff = reconcileEffectiveArticle(article, choices, sr.newNames);
  const result = reconcilePlan(eff, inp.colorRows, inp.sizeRows, opts);
  return { result, inp, article, eff, choices };
}

// Блок-обёртка: кнопка + (если открыто) панель предпросмотра. Или объяснение, почему недоступно.
function seasonReconcileBlock(rep, p, articleId) {
  const article = state.articles.find((x) => x.id === articleId);
  const inp = reconcileInputs(rep, p);
  if (!article || !inp) {
    const why = !article ? 'нет карточки артикула в «Данные»'
      : (!(article.colors || []).length || !(article.sizes || []).length) ? 'в «Данные» не заданы цвета и/или размеры ряда'
      : 'нет анализа цветов/размеров (построй план в Части 1)';
    return `<details class="se-comp"><summary>🧩 План по размерам из прогноза <span class="mini">(недоступно)</span></summary>
      <div class="se-comp-body"><div class="mini">Не могу собрать матрицу: ${why}.</div></div></details>`;
  }
  const open = seasonReconcile && seasonReconcile.articleId === articleId && seasonReconcile.open;
  return `<details class="se-comp"${open ? ' open' : ''}>
    <summary>🧩 План по размерам из прогноза <span class="mini">(цвет × размер → партия)</span></summary>
    <div class="se-comp-body">
      <div class="mini">Свести прогноз (кол-во по цветам × доли размеров) в матрицу партии по цветам и ряду карточки. Совпавшее — авто; спорное/новое — на твоё решение; непокрытое — явно «не размещено» (ничего не теряем). Ткань не трогаем: новым цветам поставим метку «заведи ткань».</div>
      <div style="margin:8px 0"><button id="se-rec-open" class="btn">${open ? '↻ Обновить предпросмотр' : '→ Заполнить План по размерам'}</button></div>
      <div id="se-reconcile">${open ? reconcilePanelHTML(rep, p, articleId) : ''}</div>
    </div>
  </details>`;
}

// HTML панели предпросмотра: матрица (полный тираж) + цвета/размеры + архив + «не размещено» +
// таблица ПОСТАВОК + строка применения (серия партий-поставок, без этапов).
function reconcilePanelHTML(rep, p, articleId) {
  const r = runReconcile(rep, p, articleId);
  if (!r) return '<div class="mini">Недостаточно данных для сведения.</div>';
  const { result, eff, article, choices } = r;
  const sr = seasonReconcile;
  const fmt = (n) => Math.round(+n || 0).toLocaleString('ru');
  const df = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}` : '—'); // ДД.ММ.ГГ
  const artSizes = eff.sizes, artColors = eff.colors;
  const colUnits = (col) => artSizes.reduce((a, s) => a + ((result.matrix[col] || {})[s] || 0), 0);

  // — матрица цвет×размер (полный тираж; пустые строки скрыты)
  const head = `<tr><th>Цвет \\ Размер</th>${artSizes.map((s) => `<th class="num">${seEsc(s)}</th>`).join('')}<th class="num">Σ</th></tr>`;
  const body = artColors.map((col) => {
    const row = result.matrix[col] || {}; const sum = colUnits(col);
    if (!sum) return '';
    return `<tr><td><b>${seEsc(col)}</b></td>${artSizes.map((s) => `<td class="num">${row[s] ? fmt(row[s]) : '<span class="mini">·</span>'}</td>`).join('')}<td class="num"><b>${fmt(sum)}</b></td></tr>`;
  }).join('');
  const matrixTbl = `<div class="se-comp-scroll"><table class="se-comp-table se-seg-table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${artSizes.length + 2}" class="mini">пусто — сопоставь цвета ниже</td></tr>`}</tbody></table></div>`;

  // — ЦВЕТА: единый выбор у КАЖДОГО цвета (сменить/отвязать/создать). Дефолт — авто-решение движка.
  const colorRow = (c) => {
    const bound = article.colorMap && article.colorMap[c.demand]; // сохранённая ранее привязка
    const sel = (choices[c.demand] !== undefined) ? choices[c.demand]
      : (c.status === 'matched' ? c.articleColor : (c.status === 'new' ? '__new__' : ''));
    const icon = c.status === 'matched' ? '✅' : (c.status === 'ambiguous' ? '⚠️' : '➕');
    const opts = [`<option value="">— выбрать —</option>`, `<option value="__skip__"${sel === '__skip__' ? ' selected' : ''}>✖ не размещать</option>`]
      .concat(activeColors(article).map((ac) => `<option value="${seEsc(ac)}"${sel === ac ? ' selected' : ''}>→ ${seEsc(ac)}</option>`))
      .concat(`<option value="__new__"${sel === '__new__' ? ' selected' : ''}>➕ создать новый цвет</option>`).join('');
    const newNm = sel === '__new__' ? ` <input class="se-rec-newname" data-demand="${seEsc(c.demand)}" value="${seEsc((sr.newNames || {})[c.demand] || c.demand)}" style="width:130px" placeholder="имя цвета в карточке">` : '';
    const boundHint = bound ? ` <span class="mini" title="Запомненная привязка. Выбери «✖ не размещать», чтобы отвязать.">🔗</span>` : '';
    return `<tr><td><b>${seEsc(c.demand)}</b> <span class="mini">${fmt(c.qty)} шт</span></td>
      <td>${icon} <select class="se-rec-choice" data-demand="${seEsc(c.demand)}">${opts}</select>${boundHint}${newNm}</td></tr>`;
  };
  const colorsTbl = `<table class="se-comp-table"><thead><tr><th>Цвет спроса</th><th>Куда в карточке</th></tr></thead><tbody>${result.colors.map(colorRow).join('')}</tbody></table>`;

  // — размеры: диапазон спроса → размеры ряда
  const sizeRows = result.sizes.map((s) => `<tr><td><b>${seEsc(s.demand)}</b>${s.origin ? ` <span class="mini">${seEsc(s.origin)}</span>` : ''} <span class="mini">${s.share}%</span></td><td>${s.covered ? '→ ' + s.articleSizes.map(seEsc).join(', ') : '<span class="mini">⚠ нет в ряду → «не размещено»</span>'}</td></tr>`).join('');
  const sizesTbl = `<table class="se-comp-table"><thead><tr><th>Размер спроса</th><th>Размеры ряда</th></tr></thead><tbody>${sizeRows}</tbody></table>`;

  // — АРХИВ: активные цвета карточки, которым новый план не дал объёма → предложить архивировать.
  const idle = activeColors(article).filter((c) => colUnits(c) <= 0);
  const archRows = idle.map((c) => {
    const on = !!(sr.archive && sr.archive[c]);
    return `<label class="se-rec-arch"><input type="checkbox" class="se-rec-archcb" data-arch="${seEsc(c)}"${on ? ' checked' : ''}> ${seEsc(c)}</label>`;
  }).join(' ');
  const archBox = idle.length
    ? `<div class="se-rec-archbox"><div class="mini"><b>Не в плане</b> (нет объёма от прогноза). Отметь — уйдут в архив: останутся в «Данные», но скроются на листах и не будут считаться. ${archRows}</div></div>`
    : '';

  // — не размещено (явно, с причинами)
  const un = result.unassigned;
  const reasonRu = { 'new-color': 'новый цвет', 'ambiguous-color': 'спорный цвет', 'unmapped-size': 'размер вне ряда' };
  const unItems = un.items.map((i) => `${seEsc(i.color)}${i.articleColor ? '→' + seEsc(i.articleColor) : ''}: <b>${fmt(i.qty)}</b> <span class="mini">(${reasonRu[i.reason] || i.reason})</span>`).join(' · ');
  const unBox = `<div class="se-color-total"${un.total ? ' style="background:rgba(255,90,90,.12)"' : ''}><b>🧺 Не размещено: ${fmt(un.total)} шт</b>${un.total ? ' — ' + unItems : ' — всё разложено ✅'}</div>`;

  // — ПОСТАВКИ: серия довозов на WB (доля времени × полный тираж). Каждая станет партией с датой WB.
  const dvs = reconcileDeliveries(p);
  const totQ = dvs.reduce((a, d) => a + d.qty, 0) || 1;
  const parts = splitMatrixByShares(result.matrix, dvs.map((d) => d.qty));
  const partUnits = parts.map((m) => Object.values(m).reduce((a, row) => a + Object.values(row).reduce((x, v) => x + v, 0), 0));
  const dvRows = dvs.map((d, i) => `<tr>
      <td><b>${seEsc(d.tag || ('П' + (i + 1)))}</b>${d.title ? ` <span class="mini">${seEsc(d.title)}</span>` : ''}</td>
      <td class="num">${d.date ? df(d.date) : '<span class="mini">—</span>'}</td>
      <td class="num">${Math.round(d.qty / totQ * 100)}%</td>
      <td class="num"><b>${fmt(partUnits[i])}</b></td>
    </tr>`).join('');
  const dvTbl = `<div class="se-rec-deliv"><div class="mini"><b>Поставки на WB</b> (частями; доля по времени из прогноза, объём — от полного тиража):</div>
    <div class="se-comp-scroll"><table class="se-comp-table"><thead><tr><th>Поставка</th><th class="num">Дата на WB</th><th class="num">Доля</th><th class="num">Объём партии</th></tr></thead>
    <tbody>${dvRows}</tbody><tfoot><tr><th>Итого (${dvs.length})</th><th></th><th></th><th class="num"><b>${fmt(result.totalPlanned)}</b></th></tr></tfoot></table></div></div>`;

  // — применение: серия партий-поставок (без этапов; цех — авто, ручной выбор на листе «План по размерам»)
  const newC = result.colors.filter((c) => choices[c.demand] === '__new__').map((c) => (sr.newNames || {})[c.demand] || c.demand);
  const archCount = idle.filter((c) => sr.archive && sr.archive[c]).length;
  const notes = [
    newC.length ? `➕ Новые цвета: <b>${newC.map(seEsc).join(', ')}</b> — заведи им ткань в «Данные».` : '',
    archCount ? `🗄 В архив уйдёт цветов: <b>${archCount}</b>.` : '',
  ].filter(Boolean).map((t) => `<div class="mini">${t}</div>`).join('');
  const applyRow = `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button id="se-rec-apply" class="btn btn-primary"${result.totalPlanned ? '' : ' disabled'}>Применить: ${dvs.length} ${dvs.length === 1 ? 'партия' : 'партии-поставки'} · ${fmt(result.totalPlanned)} шт</button>
    <span class="mini">цех — авто (распределит конвейер); ручной выбор цеха — на листе «План по размерам»</span></div>${notes}`;

  return `${matrixTbl}
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px">
      <div style="flex:1;min-width:260px"><div class="mini"><b>Цвета</b> (спрос → карточка)</div>${colorsTbl}</div>
      <div style="flex:1;min-width:220px"><div class="mini"><b>Размеры</b> (диапазон → ряд, поровну)</div>${sizesTbl}</div>
    </div>
    ${archBox}${unBox}${dvTbl}${applyRow}`;
}

// Навесить события панели (вызывается и при первом рендере сезонки, и при ре-рендере панели).
function bindReconcile(rep, p, articleId) {
  const openBtn = document.getElementById('se-rec-open');
  if (!openBtn) return;
  openBtn.addEventListener('click', () => {
    if (!seasonReconcile || seasonReconcile.articleId !== articleId) seasonReconcile = { articleId, choices: {}, newNames: {}, archive: {} };
    seasonReconcile.open = true;
    rerenderReconcile(rep, p, articleId);
  });
  bindReconcilePanel(rep, p, articleId);
}

function rerenderReconcile(rep, p, articleId) {
  const host = document.getElementById('se-reconcile');
  if (!host) return;
  host.innerHTML = reconcilePanelHTML(rep, p, articleId);
  const ob = document.getElementById('se-rec-open'); if (ob) ob.textContent = '↻ Обновить предпросмотр';
  bindReconcilePanel(rep, p, articleId);
}

function bindReconcilePanel(rep, p, articleId) {
  if (!seasonReconcile || seasonReconcile.articleId !== articleId) return;
  document.querySelectorAll('.se-rec-choice').forEach((sel) => sel.addEventListener('change', () => {
    seasonReconcile.choices[sel.dataset.demand] = sel.value;
    rerenderReconcile(rep, p, articleId);
  }));
  document.querySelectorAll('.se-rec-newname').forEach((inp) => {
    inp.addEventListener('input', () => { seasonReconcile.newNames[inp.dataset.demand] = inp.value; });
    inp.addEventListener('change', () => rerenderReconcile(rep, p, articleId)); // пересобрать матрицу по Enter/blur
  });
  document.querySelectorAll('.se-rec-archcb').forEach((cb) => cb.addEventListener('change', () => {
    seasonReconcile.archive = seasonReconcile.archive || {};
    seasonReconcile.archive[cb.dataset.arch] = cb.checked;
    rerenderReconcile(rep, p, articleId); // обновить счётчик архива в строке применения
  }));
  const applyBtn = document.getElementById('se-rec-apply');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true; applyBtn.classList.add('is-loading'); applyBtn.textContent = '⏳ Создаю партии-поставки…';
    await applyReconcile(rep, p, articleId);
    // при успехе панель закрывается и открывается Гант; при ошибке — вернуть кнопку в рабочее состояние
    if (seasonReconcile && seasonReconcile.open) rerenderReconcile(rep, p, articleId);
  });
}

// Применить: выучить привязки/алиасы, завести новые цвета, заархивировать лишние, затем создать
// СЕРИЮ партий-поставок (доля времени × полный тираж), у каждой — своя дата прихода на WB.
async function applyReconcile(rep, p, articleId) {
 try {
  const r = runReconcile(rep, p, articleId);
  if (!r) { toast('Не удалось собрать план (нет данных прогноза)', true); return; }
  const { result, article, choices } = r; // choices — с дефолтами (новые цвета создаются)
  if (!result.totalPlanned) { toast('Нечего размещать — сопоставь цвета', true); return; }
  const aliases = (state.settings.colorAliases = state.settings.colorAliases || {});
  const newNames = seasonReconcile.newNames || {};
  article.colorMap = article.colorMap || {};
  article.fabricInfo = article.fabricInfo || {};
  const createdColors = [];
  for (const c of result.colors) {
    const choice = choices[c.demand];
    if (c.status === 'matched' && choice === undefined) article.colorMap[c.demand] = c.articleColor; // зафиксировать авто-матч
    if (choice === '__skip__') { delete article.colorMap[c.demand]; continue; } // отвязать
    if (!choice) continue;
    if (choice === '__new__') {
      const nm = String(newNames[c.demand] || c.demand).trim();
      if (!nm) continue;
      if (!article.colors.includes(nm)) { article.colors.push(nm); createdColors.push(nm); }
      // если цвет был в архиве — вернуть в оборот
      article.archivedColors = (article.archivedColors || []).filter((x) => x !== nm);
      article.colorMap[c.demand] = nm;
      if (!article.fabricInfo[nm]) article.fabricInfo[nm] = { plansheet: '', colorNo: '', image: '' }; // заготовка под ткань
    } else if (article.colors.includes(choice)) {
      article.colorMap[c.demand] = choice; // пер-артикул привязка
      if (canonColor(choice, aliases) !== c.demand) aliases[aliasKey(choice)] = c.demand; // глоб. синоним на будущее
    }
  }
  // архивация выбранных «не в плане» цветов (остаются в a.colors, но помечены)
  const archived = [];
  for (const [col, on] of Object.entries(seasonReconcile.archive || {})) {
    if (on && article.colors.includes(col) && !(article.archivedColors || []).includes(col)) {
      article.archivedColors = article.archivedColors || []; article.archivedColors.push(col); archived.push(col);
    }
  }

  // серия партий-поставок: полный тираж → доли по времени (Хэмилтон, ноль потерь)
  const dvs = reconcileDeliveries(p);
  const parts = splitMatrixByShares(result.matrix, dvs.map((d) => d.qty));
  let firstId = null, made = 0;
  dvs.forEach((d, i) => {
    const mtx = parts[i] || {};
    for (const col of Object.keys(mtx)) if (Object.values(mtx[col]).reduce((a, v) => a + v, 0) <= 0) delete mtx[col];
    if (!Object.keys(mtx).length) return; // пустую поставку не создаём
    // дата на WB строго ГГГГ-ММ-ДД (иначе сервер отбраковывает партию без этапа); фолбэк — конец периода
    const dl = String(d.date || '').slice(0, 10) || String((p && p.forecastPeriod && p.forecastPeriod.to) || '').slice(0, 10);
    const np = newPartia(articleId, '', '', { deadline: dl, deliveryTag: d.tag || ('П' + (i + 1)), origin: 'forecast' });
    np.planMatrix = mtx;
    state.partias.push(np); made++; if (!firstId) firstId = np.id;
  });
  if (!made) { toast('Не удалось сформировать партии (пустая матрица)', true); return; }
  recomputePartiaNumbers();
  dirty = true;
  console.log('[apply] до сохранения: articleId=%s, партий создано=%d, дедлайны=%o, цвета матрицы=%o',
    articleId, made, dvs.map((d) => d.date), Object.keys(result.matrix));
  await recalc(true);
  // диагностика: сколько партий этого артикула ВЫЖИЛО после серверной нормализации
  const survived = (state.partias || []).filter((p) => p.articleId === articleId).length;
  console.log('[apply] после сохранения: партий артикула %s = %d (всего %d)', articleId, survived, (state.partias || []).length);
  if (made > 0 && survived === 0) {
    toast('⚠ Партии созданы, но сервер их отбраковал. Скорее всего НЕ перезапущен backend (npm start) — старый model.js. Детали: консоль [apply].', true);
    return;
  }
  const un = result.unassigned.total;
  toast(`Создано партий-поставок: ${made} · ${result.totalPlanned.toLocaleString('ru')} шт`
    + `${createdColors.length ? `, новых цветов ${createdColors.length} (заведи ткань)` : ''}`
    + `${archived.length ? `, в архив ${archived.length}` : ''}`
    + `${un ? `, не размещено ${un.toLocaleString('ru')} шт` : ''}`);
  if (seasonReconcile) seasonReconcile.open = false;
  // Переходим на «План по размерам» с выбранным артикулом и первой партией — там видны все
  // партии-поставки (и распределение по цехам). На Ганте они появятся после «Сохранить план».
  matrixArticleId = articleId; matrixPartiaId = firstId;
  switchTab('matrix');
 } catch (e) { toast('Ошибка применения: ' + (e && e.message || e), true); console.error('[applyReconcile]', e); }
}

// Блок «Характеристики выборки» — реальные Состав/Сезон/Крой с количеством из карточек
// отобранных конкурентов. Помогает проверить состав выборки и подобрать строгий ключ.
function seasonAttributesBlock(rep) {
  const attrs = rep.attributesFound || [];
  if (!attrs.length) return '';
  const rows = attrs.map((a) => {
    const chips = a.values.map((v) => `<button class="se-attr-chip" data-attr-val="${seEsc(v.value)}" title="Вписать как строгий ключ">${seEsc(v.value)} <span class="se-attr-cnt">${v.count}</span></button>`).join('');
    return `<div class="se-attr-row"><div class="se-attr-name">${seEsc(a.name)}</div><div class="se-attr-vals">${chips}</div></div>`;
  }).join('');
  return `<details class="se-comp se-attrs">
    <summary>🧩 Характеристики выборки — состав, сезон, крой <span class="mini">(клик по значению → строгий ключ)</span></summary>
    <div class="se-comp-body">
      <div class="mini">Реальные характеристики карточек отобранных конкурентов (с количеством). Клик по значению впишет его как строгий ключ в конструктор (Часть 1) — затем «Построить план», чтобы оставить только такие товары.</div>
      <div class="se-attr-list">${rows}</div>
    </div>
  </details>`;
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

// Подпись к «Выкупам»: объём прибит к фактическим продажам ТОП-1/ТОП-3 финальной
// выборки за аналогичный сезонный период прошлого года (форма кривой — синтетическая).
// Подпись к «Цене»: цена = медиана продаж по штукам × сезонный профиль × ручной множитель.
// Авто-дрейф цен год-к-году не применяется (показан подсказкой — можно учесть вручную).
function seasonPriceBasis(p) {
  const mult = (p.priceMultiplier != null) ? p.priceMultiplier : ((p.opts && p.opts.priceMultiplier) || 1);
  const drift = p.adjustments && p.adjustments.priceAdj;
  const anchor = p.priceInfo && p.priceInfo.anchor;
  const base = `медиана по штукам${anchor ? ' ' + Math.round(anchor).toLocaleString('ru') + '₽' : ''} × сезонный профиль × множитель ${mult}`;
  const hint = (drift && Math.abs(drift - 1) >= 0.05) ? ` · замеренный дрейф цен ×${drift} (не применён — крути «Множитель цены» вручную)` : '';
  return base + hint;
}

function seasonVolumeBasis(p) {
  const st = p.levelInfo && p.levelInfo.seasonTargets;
  if (!st || !st.used) return 'MPStats «продажи» = выкупы · база для производства';
  const lvl = p.levelInfo.targetLevel === 'top1' ? 'ТОП-1' : 'ТОП-3';
  const w = st.window ? `${seFmtRange(st.window.from, st.window.to)}` : '';
  const modeName = st.growthManual ? `вручную ${st.growthManual}/год`
    : st.growthMode === 'market' ? `рынок ${st.growthYoY}/год`
    : st.growthMode === 'none' ? 'без роста'
    : `когорта ${st.growthYoY}/год`;
  const meas = (st.growthMeasured && st.growthManual) ? ` (авто было ${st.growthMeasured})` : '';
  const g = (st.growthFactor && st.growthFactor !== 1)
    ? ` × рост ${st.growthFactor} [${modeName}${st.growthYears > 1 ? ` за ${st.growthYears} г.` : ''}${meas}]`
    : ` · ${modeName}`;
  if (st.mode === 'allseason-monthly') {
    return `= сумма помесячных продаж ${lvl} (свои лидеры каждого месяца) за год${g}`;
  }
  return `= продажи ${lvl} за ${w}${g}`;
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
      <div class="se-card"><div class="k">Выкупы (прогноз), шт</div><div class="v good">${total.toLocaleString('ru')}</div><div class="mini">${seasonVolumeBasis(p)}</div></div>
      <div class="se-card"><div class="k">Заказы (оценка), шт</div><div class="v">${orders.toLocaleString('ru')}</div><div class="mini">выкупы ÷ выкуп: <input id="se-buyout" type="number" min="1" max="100" value="${buyout}" title="% выкупа"> %</div></div>
      <div class="se-card"><div class="k">Цена, ₽</div><div class="v">${pmin ? pmin.toLocaleString('ru') + '–' + pmax.toLocaleString('ru') : '—'}</div><div class="mini">${seasonPriceBasis(p)}</div></div>
      <div class="se-card"><div class="k">Благоприятные месяцы</div><div class="v">${favM || '—'}</div><div class="mini">спрос выше среднего, остатки ниже</div></div>
    </div>
    ${seasonModeNote(p)}
    ${seasonLevelNote(p)}
    <div class="mini">Группа-аналогов: ${rep.itemsWithData ?? '—'} из ${rep.groupSize ?? '—'} · сбор: ${rep.method === 'category-bulk' ? 'одним запросом по категории' : rep.method === 'per-sku' ? 'по каждому товару' : (rep.method || '—')} (${rep.requests ?? '—'} обращ. к MPStats) · построено ${gen}</div>
  </div>`;
}

// Бейдж режима плана + мини-сезоны (для круглогодичного).
function seasonModeNote(p) {
  if (p.mode !== 'allseason') return '<div class="mini se-mode-note">📅 Режим: <b>сезонный</b> — план на один высокий сезон (разгон → сезон → распродажа).</div>';
  const ms = (p.miniSeasons || []);
  const conf = ms.filter((m) => m.confirmed);
  const list = ms.length
    ? ms.map((m) => `${m.confirmed ? '✅' : '≈'} ${seEsc(m.name)} (${seFmtDate(m.peakDate)})`).join(' · ')
    : 'не обнаружены';
  return `<div class="mini se-mode-note">🔄 Режим: <b>круглогодичный</b> — план на 12 мес: сезонный пик, мягкий спад и межсезонная база (склад не обнуляется).
    <br>🎉 Мини-сезоны (подтв. рынком ${conf.length} из ${ms.length}): ${list}</div>`;
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
  const isAll = p.mode === 'allseason';
  // Круглогодичный: вехи = главный пик + мини-сезоны (НГ, 14/23 фев, 8 марта). Сезонный: фазы.
  const milestones = isAll
    ? [{ date: ph.peak, name: 'Пик сезона' }].concat((p.miniSeasons || []).map((m) => ({ date: m.peakDate, name: (m.confirmed ? '' : '≈') + m.name }))).filter((m) => m.date)
    : [
        { date: ph.entry, name: 'Вход' }, { date: ph.hotStart, name: 'Старт сезона' },
        { date: ph.peak, name: 'Пик' }, { date: ph.saleStart, name: 'Начало распродажи' }, { date: ph.end, name: 'Конец' },
      ].filter((m) => m.date);
  const demandLbl = isAll ? 'план продаж (весь год), шт/день' : 'план продаж (выкупы), шт/день';
  return `<div class="se-charts">
    ${seasonChartSVG(fTitle, p.forecastDaily || [], 'plannedOrders', { demand: demandLbl, stock: 'наш склад (план поставок), шт', milestones, deliveries: p.deliveries || [], restock: p.restockDeadline || null })}
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
  // Живой порог силы цвета: слабее X% от лучшего → в «доп.». Пересобирать план не нужно.
  const cthr = document.getElementById('se-color-thr');
  cthr?.addEventListener('change', (e) => {
    seasonColorMinRel = Math.max(5, Math.min(100, +e.target.value || 40));
    renderSeasonView(seasonSelArticle);
  });
  // Живой минимум расцветок в ассортименте: движок добирает слабые до этого числа.
  const ccnt = document.getElementById('se-color-count');
  ccnt?.addEventListener('change', (e) => {
    seasonColorMinCount = Math.max(1, Math.min(20, Math.round(+e.target.value || 5)));
    renderSeasonView(seasonSelArticle);
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
  const pg = (title, inner) => `<div class="u-pg"><div class="u-pg-t">${title}</div><div class="u-grid">${inner}</div></div>`;
  const settings = `<details class="u-settings"${unitSettingsOpen ? ' open' : ''}>
    <summary>Параметры ВБ, налоги и расходы (применяются ко всем артикулам)</summary>
    <div class="u-params">
      ${pg('Услуги ВБ, %', gi('commission', 'Комиссия ВБ (от S)') + gi('acquiring', 'Эквайринг (от Pб)') + gi('drrLaunch', 'ДРР запуск (от Pб)') + gi('drrSteady', 'ДРР выход (от Pб)'))}
      ${pg('Скидки покупателю, % (выплату не уменьшают)', gi('spp', 'СПП') + gi('wallet', 'WB Кошелёк'))}
      ${pg('Логистика / хранение / приёмка, ₽', gi('logisticsPvz', 'Логистика до ПВЗ', '₽/зак') + gi('returnLogistics', 'Обратная логистика', '₽/зак') + gi('storage', 'Хранение', '₽/ед') + gi('acceptanceTariff', 'Тариф приёмки', '₽/ед'))}
      ${pg('Налоги и расходы', gi('tax', 'Налог (от оборота Pб)') + gi('extra', 'Доп. расходы (от S)') + gi('opexShare', 'Опер. расходы (доля валовой)'))}
      ${pg('Целевой коридор маржинальности, %', gi('mMin', 'Мин.') + gi('mMax', 'Макс.'))}
    </div>
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
      <td class="num u-pb">${r.unit ? uFmtR(r.unit.buyerPrice) : '—'}</td>
      <td class="num ${cls}">${uFmtP(marg)}</td>
      <td class="num ${net != null && net < 0 ? 'bad' : ''}">${uFmtR(net)}</td>
      <td class="num">${cor}</td>
      <td class="num">${uFmtR(r.breakeven.S)}</td>
    </tr>`;
    // Деталь — СТРОКОЙ прямо под артикулом (остальные строки смещаются вниз).
    // Контейнер u-detail-inner залипает по левому краю и получает ширину видимой
    // области скролла (JS), чтобы на мобильном карточки стекались по ширине экрана.
    const detail = open ? `<tr class="u-detail-row"><td colspan="11" class="u-detail-cell"><div class="u-detail-inner">${unitDetail(a, r)}</div></td></tr>` : '';
    return main + detail;
  }).join('');

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
        <th class="num" title="Конечная цена покупателя (Pб) = S после СПП и WB Кошелька. Это цена на витрине ВБ и средняя цена продажи в MPStats.">Цена покупателя (Pб)</th>
        <th class="num" title="Маржинальность = валовая прибыль / цена после скидки (S)">Маржинальность</th>
        <th class="num" title="Чистая прибыль на единицу, ₽">Чистая/ед</th>
        <th class="num" title="Цена после скидки (S) под целевую валовую маржинальность mMin–mMax">Коридор цены до СПП (S)</th>
        <th class="num" title="Цена после скидки (S), при которой прибыль = 0">Безубыток (S)</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="mini">Нет артикулов — добавь во вкладке «Данные».</td></tr>'}</tbody>
    </table></div>
    <div class="mini">Расчёт мгновенный. Правки сохраняются кнопкой «Сохранить» в шапке. Клик по строке — полный каскад P&L и обратный расчёт.</div>
  </div>${wbDatalist}`;
  bindUnit();
  fixUnitDetailWidths();
}

// Ширина раскрытой детали = видимая ширина скролла таблицы (чтобы деталь не тянула
// таблицу вширь и корректно стекалась на мобильном). Обновляется и на ресайзе.
function fixUnitDetailWidths() {
  const wrap = document.querySelector('.u-tablewrap'); if (!wrap) return;
  const w = wrap.clientWidth;
  document.querySelectorAll('.u-detail-inner').forEach((el) => { el.style.width = w + 'px'; });
}
let _uResizeBound = false;
function bindUnitResize() {
  if (_uResizeBound) return; _uResizeBound = true;
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (activeTab === 'unit') fixUnitDetailWidths(); }, 120); });
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

  const sens = r.sensitivity.map((s) => `<tr class="${s.current ? 'hl' : ''}"><td class="num"><b>${s.marginTarget}%</b></td><td class="num">${uFmtR(s.S)}</td><td class="num">${uFmtR(s.buyerPrice)}</td><td class="num ${s.net < 0 ? 'bad' : ''}">${uFmtR(s.net)}</td></tr>`).join('');

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
        <div class="u-card-h">Чувствительность по маржинальности</div>
        <div class="mini">шаг 1% · от ${uFmtP(pr.m_min)} до ${uFmtP(pr.m_max)} (задаётся в параметрах ВБ)</div>
        <table class="u-art"><thead><tr><th class="num">Маржин.</th><th class="num">Цена S</th><th class="num">Pб</th><th class="num">Чистая</th></tr></thead><tbody>${sens}</tbody></table>
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
  bindUnitResize();
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
    ${dataSuppliersPanel()}
    ${dataArticlesPanel()}
    ${dataWorkshopsPanel()}
    ${dataResponsiblesPanel()}
    ${dataSeasonsPanel()}
    ${dataStagesPanel()}
    ${dataSettingsPanel()}
    <div class="panel"><button class="btn btn-danger" id="btn-reset">Сбросить к примеру</button></div>
  `;
  bindDataEvents();
  applyCollapsibles();
  loadResponsibles();
}

function dataResponsiblesPanel() {
  return `<div class="panel"><div class="subhead"><h3>Ответственные (цех × роль)</h3></div>
    <div class="mini" style="margin-bottom:8px">Кто отвечает за этап в цехе. Нужно для будущих Telegram-опросов (Шаг 2): система будет спрашивать именно ответственного по его этапу. Список людей — те, кто входил через Telegram.</div>
    <div id="responsibles-box"><div class="mini">Загрузка…</div></div></div>`;
}
async function loadResponsibles() {
  const box = document.getElementById('responsibles-box'); if (!box) return;
  let data;
  try { data = await api('/api/responsibles'); } catch { box.innerHTML = '<div class="mini">Раздел доступен при включённой БД и праве на «Данные».</div>'; return; }
  const roles = data.roles || [], users = data.users || [];
  const respMap = {}; for (const r of (data.responsibles || [])) respMap[r.workshopId + '|' + r.role] = r.telegramId;
  const opt = (sel) => '<option value="">— не задан —</option>' + users.map((u) => `<option value="${u.telegramId}"${String(u.telegramId) === String(sel) ? ' selected' : ''}>${u.name}${u.username ? ' (@' + u.username + ')' : ''}</option>`).join('');
  box.innerHTML = `<div style="overflow-x:auto"><table><thead><tr><th>Цех</th>${roles.map((r) => `<th>${r.name}</th>`).join('')}</tr></thead>
    <tbody>${state.workshops.map((w) => `<tr><td><b>${w.name}</b>${w.own ? ' <span class="mini">свой</span>' : ''}</td>
      ${roles.map((r) => `<td><select data-resp-ws="${w.id}" data-resp-role="${r.key}">${opt(respMap[w.id + '|' + r.key])}</select></td>`).join('')}
    </tr>`).join('')}</tbody></table></div>${users.length ? '' : '<div class="mini" style="margin-top:6px">Пользователей пока нет — появятся после входа через Telegram.</div>'}`;
  box.querySelectorAll('select[data-resp-ws]').forEach((sel) => sel.addEventListener('change', async (e) => {
    try { await api('/api/responsibles', { method: 'PUT', body: JSON.stringify({ workshopId: e.target.dataset.respWs, role: e.target.dataset.respRole, telegramId: e.target.value || null }) }); toast('Ответственный обновлён'); }
    catch (err) { toast('Ошибка: ' + err.message, true); }
  }));
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
        <div class="field"><label>Поставщик ткани</label><select data-art="${i}" data-f="supplierId">
          <option value="">— не задан —</option>
          ${state.suppliers.map((sup) => `<option value="${sup.id}"${sup.id === a.supplierId ? ' selected' : ''}>${sup.name}</option>`).join('')}
        </select></div>
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

function dataSuppliersPanel() {
  return `<div class="panel"><div class="subhead"><h3>Поставщики ткани</h3><button class="btn" id="btn-add-supplier">+ Поставщик</button></div>
    <div class="mini" style="margin-bottom:8px">Режим заказа управляет тем, как консолидируется закупка ткани: «оплата сразу» — один заказ на весь сезон; «рассрочка» — выборка отдельными заказами каждые N этапов.</div>
    <table><thead><tr><th>Название</th><th>Режим заказа</th><th class="num" title="Для рассрочки: один заказ покрывает столько этапов">Выборка, этапов</th><th></th></tr></thead>
    <tbody>${(state.suppliers || []).map((sup, i) => `<tr>
      <td><input data-sup="${i}" data-f="name" value="${(sup.name || '').replace(/"/g, '&quot;')}" style="width:180px"></td>
      <td><select data-sup="${i}" data-f="orderMode">
        <option value="season"${sup.orderMode === 'season' ? ' selected' : ''}>оплата сразу (заказ на сезон)</option>
        <option value="draw"${sup.orderMode === 'draw' ? ' selected' : ''}>рассрочка (выборка по этапам)</option>
      </select></td>
      <td class="num"><input data-sup="${i}" data-f="drawStages" type="number" min="1" value="${sup.drawStages || 1}" style="width:70px"${sup.orderMode === 'season' ? ' disabled' : ''}></td>
      <td><button class="btn btn-danger" data-del-sup="${i}" title="удалить поставщика">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="mini">Поставщиков пока нет.</td></tr>'}</tbody></table></div>`;
}

function dataWorkshopsPanel() {
  return `<div class="panel"><div class="subhead"><h3>Цеха</h3><button class="btn" id="btn-add-ws">+ Цех</button></div>
    <table><thead><tr>
      <th>Название</th><th>Роль</th><th title="Свой цех (наш, приоритет в очереди). Остальные — аутсорс.">Свой</th>
      <th class="num">Крой</th><th class="num">Пошив</th><th class="num">Утюжка</th><th class="num">ОТК</th>
      <th class="num" title="На сколько раб. дней старт пошива смещён относительно старта кроя">Сдвиг пошива</th>
      <th class="num" title="На сколько раб. дней старт утюжки смещён относительно старта пошива">Сдвиг утюжки</th>
      <th class="num" title="На сколько раб. дней старт ОТК смещён относительно старта утюжки">Сдвиг ОТК</th>
      <th></th></tr></thead>
    <tbody>${state.workshops.map((w, i) => `<tr>
      <td><input data-ws="${i}" data-f="name" value="${w.name}" style="width:110px"></td>
      <td><select data-ws="${i}" data-f="role"><option value="main"${w.role === 'main' ? ' selected' : ''}>основной</option><option value="aux"${w.role === 'aux' ? ' selected' : ''}>вспомог.</option></select></td>
      <td style="text-align:center"><input type="checkbox" data-ws="${i}" data-own${w.own ? ' checked' : ''} title="свой цех"></td>
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
      <div class="field"><label>Запас на раскрой, %</label><input data-set="fabric.wastagePct" value="${f.wastagePct}"></div>
      <div class="field"><label>Страховой запас закупки, %</label><input data-set="fabric.safetyPct" value="${f.safetyPct}"></div>
      <div class="field"><label>Буфер «ткань раньше кроя», дней</label><input data-set="fabric.bufferDays" value="${f.bufferDays}"></div>
      <div class="field"><label title="Настил: ориентир минимума на размер (мягкий).">Настил: мин. на размер, шт</label><input data-set="nesting.minSizeQty" value="${state.settings.nesting.minSizeQty}"></div>
      <div class="field"><label title="Настил: ориентир минимума на цвет (мягкий).">Настил: мин. на цвет, шт</label><input data-set="nesting.minColorQty" value="${state.settings.nesting.minColorQty}"></div>
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
      <div class="field"><label title="Подушка перед дедлайном: если партия приходит на WB меньше чем за столько раб. дней до дедлайна — покажем предупреждение «впритык», даже если формально успели. Даты производства не сдвигает.">Буфер под форс-мажор, раб. дней</label><input data-set="riskBufferDays" value="${state.settings.riskBufferDays}"></div>
    </div>
    <div class="card"><div class="mini" style="margin-bottom:8px">Контроль сроков</div>
      <div class="field"><label title="«Сегодня» для контроля отставания. Пусто = реальная текущая дата. Отставание считается для партий в статусе «крой»/«пошив».">Дата планирования (YYYY-MM-DD, пусто = сегодня)</label><input data-set="planningDate" value="${state.settings.planningDate || ''}" placeholder="сегодня"></div>
      <div class="field"><label title="Если активная партия (крой/пошив) отстаёт от плана больше чем на столько дней — тревога в «Рисках» с прогнозом срыва.">Порог отставания, дней</label><input data-set="delayThresholdDays" value="${state.settings.delayThresholdDays}"></div>
      <div class="field"><label title="Спасатель сроков: сколько дней заложить на переброску части партии и ткани в другой цех (все цеха в одном городе).">Переброска в др. цех, дней</label><input data-set="transferDays" value="${state.settings.transferDays}"></div>
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

  root.querySelectorAll('input[data-art],select[data-art]').forEach((inp) => inp.addEventListener('change', (e) => {
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
    if ('own' in e.target.dataset) {
      // свой цех — единственный: снимаем флаг у остальных
      for (const ws of state.workshops) ws.own = false;
      w.own = e.target.checked; mark(); renderData(); return;
    }
    if (e.target.dataset.cap) w.capacities[e.target.dataset.cap] = Math.max(1, +e.target.value || 1);
    else if (e.target.dataset.off) {
      w.flowOffsets = w.flowOffsets || {};
      const v = e.target.value.trim();
      w.flowOffsets[e.target.dataset.off] = v === '' ? null : Math.max(0, Math.round(+v || 0));
    } else w[e.target.dataset.f] = e.target.value; mark();
  }));
  root.querySelectorAll('[data-del-ws]').forEach((b) => b.addEventListener('click', () => { state.workshops.splice(+b.dataset.delWs, 1); mark(); renderData(); }));

  // поставщики ткани
  root.querySelectorAll('input[data-sup],select[data-sup]').forEach((inp) => inp.addEventListener('change', (e) => {
    const sup = state.suppliers[+e.target.dataset.sup]; if (!sup) return;
    const f = e.target.dataset.f;
    if (f === 'drawStages') { sup.drawStages = Math.max(1, Math.round(+e.target.value || 1)); mark(); }
    else if (f === 'orderMode') { sup.orderMode = e.target.value === 'season' ? 'season' : 'draw'; mark(); renderData(); }
    else { sup[f] = e.target.value; mark(); renderData(); } // имя влияет на списки у артикулов
  }));
  root.querySelectorAll('[data-del-sup]').forEach((b) => b.addEventListener('click', () => {
    const sup = state.suppliers[+b.dataset.delSup];
    if (sup) for (const a of state.articles) if (a.supplierId === sup.id) a.supplierId = '';
    state.suppliers.splice(+b.dataset.delSup, 1); mark(); renderData();
  }));
  root.querySelector('#btn-add-supplier')?.addEventListener('click', () => {
    state.suppliers.push({ id: uid('sup'), name: 'Новый поставщик', orderMode: 'draw', drawStages: 1 }); mark(); renderData();
  });
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

  installReadonlyGuard();
  try {
    await loadPerms();
    applyAccessUI();
    await loadAll();
    switchTab(firstAllowedTab());
    setStatus();
  } catch (e) {
    document.getElementById('gantt').innerHTML = `<div style="padding:24px;color:var(--danger)">Ошибка загрузки: ${e.message}</div>`;
  }
}
init();
