// app.js — оболочка SPA: загрузка данных, вкладки, дашборд, формы, Гант.
import { renderGantt } from './gantt.js';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
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
function renderCurrent() {
  if (activeTab === 'gantt') renderGantt(document.getElementById('gantt'), schedule, state, { pxPerDay, onOverride });
  else if (activeTab === 'matrix') renderMatrix();
  else if (activeTab === 'salesplan') renderSalesPlan();
  else if (activeTab === 'dashboard') renderDashboard();
  else if (activeTab === 'data') renderData();
}

// ---------- ПЛАН ПРОДАЖ (сводка с выбором артикулов/этапов) ----------
let spStages = null, spArticles = null; // выбранные (Set id); null = все

function renderSalesPlan() {
  const root = document.getElementById('salesplan');
  if (!state.articles.length || !state.stages.length) {
    root.innerHTML = '<div class="panel"><div class="mini">Нет артикулов или этапов. Заполни во вкладке «Данные».</div></div>';
    return;
  }
  if (!spStages) spStages = new Set(state.stages.map((s) => s.id));
  if (!spArticles) spArticles = new Set(state.articles.map((a) => a.id));
  // подчистить от удалённых
  spStages = new Set([...spStages].filter((id) => state.stages.some((s) => s.id === id)));
  spArticles = new Set([...spArticles].filter((id) => state.articles.some((a) => a.id === id)));

  const stageIndex = Object.fromEntries(state.stages.map((s, i) => [s.id, i + 1]));
  const stages = state.stages.filter((s) => spStages.has(s.id));
  const arts = state.articles.filter((a) => spArticles.has(a.id));

  const filtersHtml = `
    <div class="panel">
      <div class="subhead"><h3>План продаж — детально по партиям и артикулам</h3><span class="mini">выбери партии и артикулы для просмотра</span></div>
      <div class="sp-filters">
        <div class="sp-group">
          <div class="sp-title">Партии (этапы) <button class="sp-all" data-all="stages">все</button> <button class="sp-all" data-none="stages">снять</button></div>
          <div class="sp-chips">${state.stages.map((s) => `<label class="sp-chip${spStages.has(s.id) ? ' on' : ''}"><input type="checkbox" data-sp-stage="${s.id}"${spStages.has(s.id) ? ' checked' : ''}> Партия ${stageIndex[s.id]} · ${s.name}${s.salesMonths ? ' · ' + s.salesMonths : ''}</label>`).join('')}</div>
        </div>
        <div class="sp-group">
          <div class="sp-title">Артикулы <button class="sp-all" data-all="articles">все</button> <button class="sp-all" data-none="articles">снять</button></div>
          <div class="sp-chips">${state.articles.map((a) => `<label class="sp-chip${spArticles.has(a.id) ? ' on' : ''}"><input type="checkbox" data-sp-article="${a.id}"${spArticles.has(a.id) ? ' checked' : ''}> ${a.id}</label>`).join('')}</div>
        </div>
      </div>
    </div>`;

  let body = '';
  if (!stages.length || !arts.length) {
    body = '<div class="panel"><div class="mini">Выбери хотя бы одну партию и один артикул.</div></div>';
  } else {
    for (const s of stages) {
      const cards = arts.map((a) => spMiniTable(a, s)).filter(Boolean).join('');
      body += `<div class="panel">
        <h3 class="sp-partia">Партия ${stageIndex[s.id]} · ${s.name}${s.salesMonths ? ' · ' + s.salesMonths : ''}</h3>
        ${cards ? `<div class="mini-grid">${cards}</div>` : '<div class="mini">По выбранным артикулам нет плана на эту партию.</div>'}
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
  root.querySelectorAll('.sp-all').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.all === 'stages') spStages = new Set(state.stages.map((s) => s.id));
    else if (b.dataset.none === 'stages') spStages = new Set();
    else if (b.dataset.all === 'articles') spArticles = new Set(state.articles.map((a) => a.id));
    else if (b.dataset.none === 'articles') spArticles = new Set();
    renderSalesPlan();
  }));
}

// ---------- матрица размер×цвет ----------
function sumMatrix(M) { let s = 0; for (const c in M) { const r = M[c] || {}; for (const k in r) s += +r[k] || 0; } return Math.round(s); }
function cell(M, c, s) { return +((M[c] || {})[s]) || 0; }
function articleStageTotal(a, stageId) {
  const m = a.matrix && a.matrix[stageId];
  const fromMatrix = m ? sumMatrix(m) : 0;
  if (fromMatrix > 0) return fromMatrix;
  return Math.max(0, Math.round(+(a.plan?.[stageId]) || 0));
}

let matrixStageId = null, matrixArticleId = null;

function renderMatrix() {
  const root = document.getElementById('matrix');
  if (!state.articles.length) { root.innerHTML = '<div class="panel"><div class="mini">Нет артикулов. Добавь их во вкладке «Данные».</div></div>'; return; }
  if (!matrixArticleId || !state.articles.find((a) => a.id === matrixArticleId)) matrixArticleId = state.articles[0].id;
  if (!matrixStageId || !state.stages.find((s) => s.id === matrixStageId)) matrixStageId = state.stages[0]?.id;

  const a = state.articles.find((x) => x.id === matrixArticleId);
  const stage = state.stages.find((s) => s.id === matrixStageId);
  a.matrix = a.matrix || {};
  const M = (a.matrix[stage.id] = a.matrix[stage.id] || {});
  for (const c of a.colors) { M[c] = M[c] || {}; for (const s of a.sizes) if (M[c][s] == null) M[c][s] = 0; }

  const hasGrid = a.colors.length && a.sizes.length;
  root.innerHTML = `
    <div class="panel">
      <div class="matrix-controls">
        <label>Партия:
          <select id="mx-stage">${state.stages.map((s) => `<option value="${s.id}"${s.id === stage.id ? ' selected' : ''}>${s.name}${s.salesMonths ? ' · ' + s.salesMonths : ''}</option>`).join('')}</select>
        </label>
        <label>Артикул:
          <select id="mx-article">${state.articles.map((x) => `<option value="${x.id}"${x.id === a.id ? ' selected' : ''}>${x.id} — ${x.name}</option>`).join('')}</select>
        </label>
        <span class="mini">Введи количество по размерам — итоги считаются автоматически. Затем нажми «Сохранить».</span>
      </div>
      ${hasGrid ? matrixTable(a, M) : '<div class="mini">У артикула не заданы цвета или размерный ряд — добавь их во вкладке «Данные».</div>'}
    </div>`;

  document.getElementById('mx-stage').addEventListener('change', (e) => { matrixStageId = e.target.value; renderMatrix(); });
  document.getElementById('mx-article').addEventListener('change', (e) => { matrixArticleId = e.target.value; renderMatrix(); });
  root.querySelectorAll('input[data-mx]').forEach((inp) => inp.addEventListener('input', onMatrixInput));
}

// мини-таблица (только чтение) для одного артикула на одной партии/этапе
function spMiniTable(a, stage) {
  if (!a.colors.length || !a.sizes.length) return '';
  const M = (a.matrix && a.matrix[stage.id]) || {};
  const total = sumMatrix(M);
  if (total <= 0) return ''; // нет плана — не показываем карточку
  return `<div class="mini-card">
    <div class="mini-head"><b>${a.id}</b> — ${a.name}</div>
    <div class="matrix-scroll"><table class="matrix-table mini">
      <thead><tr><th class="mx-corner">Размер</th>${a.colors.map((c) => `<th class="mx-color">${c}</th>`).join('')}<th class="mx-rowtot-h">Σ</th></tr></thead>
      <tbody>${a.sizes.map((s) => `<tr><th class="mx-size">${s}</th>${a.colors.map((c) => { const v = cell(M, c, s); return `<td class="num">${v || '<span class="mini">·</span>'}</td>`; }).join('')}<td class="num mx-rowtot">${a.colors.reduce((n, c) => n + cell(M, c, s), 0)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th class="mx-vsego">ВСЕГО</th>${a.colors.map((c) => `<td class="num mx-coltot">${a.sizes.reduce((n, s) => n + cell(M, c, s), 0)}</td>`).join('')}<td class="num mx-grand">${total.toLocaleString('ru')}</td></tr></tfoot>
    </table></div>
  </div>`;
}

function matrixTable(a, M) {
  return `
  <div class="matrix-scroll">
  <table class="matrix-table">
    <thead>
      <tr><th class="mx-corner">Размер \\ Цвет</th>
        ${a.colors.map((c) => `<th class="mx-color">${c}</th>`).join('')}
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
  const stageId = matrixStageId;
  const c = decodeURIComponent(e.target.dataset.c);
  const s = decodeURIComponent(e.target.dataset.s);
  const v = Math.max(0, Math.round(+e.target.value || 0));
  a.matrix[stageId] = a.matrix[stageId] || {};
  a.matrix[stageId][c] = a.matrix[stageId][c] || {};
  a.matrix[stageId][c][s] = v;
  a.plan = a.plan || {};
  a.plan[stageId] = sumMatrix(a.matrix[stageId]); // держим суммарный план в синхроне
  dirty = true; setStatus();

  const M = a.matrix[stageId];
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
      <table><thead><tr><th>Артикул</th><th>Цвета</th>${state.stages.map((s) => `<th>${s.name}<div class="mini">${s.salesMonths}</div></th>`).join('')}</tr></thead>
      <tbody>${state.articles.map((a) => `<tr>
        <td><b>${a.id}</b><div class="mini">${a.name}</div></td>
        <td class="mini">${(a.colors || []).length} цв.</td>
        ${state.stages.map((s) => articleStageCell(a, s)).join('')}
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
    ${dataStagesPanel()}
    ${dataSettingsPanel()}
    <div class="panel"><button class="btn btn-danger" id="btn-reset">Сбросить к примеру</button></div>
  `;
  bindDataEvents();
}

function dataArticlesPanel() {
  return `<div class="panel"><div class="subhead"><h3>Артикулы</h3><button class="btn" id="btn-add-article">+ Артикул</button></div>
    <div class="form-grid">${state.articles.map((a, i) => `
      <div class="card">
        <div class="row-flex">
          <div class="field"><label>Артикул</label><input data-art="${i}" data-f="id" value="${a.id}"></div>
          <div class="field" style="flex:2"><label>Название</label><input data-art="${i}" data-f="name" value="${a.name}"></div>
        </div>
        <div class="row-flex">
          <div class="field"><label>Расход ткани, м/шт</label><input data-art="${i}" data-f="fabricPerUnit" value="${a.fabricPerUnit}" style="width:90px"></div>
          <div class="field" style="flex:2"><label>Цвета (через запятую)</label><input data-art="${i}" data-f="colors" value="${(a.colors || []).join(', ')}"></div>
        </div>
        <div class="field"><label>Размерный ряд (через запятую)</label><input data-art="${i}" data-f="sizes" value="${(a.sizes || []).join(', ')}"></div>
        <button class="btn btn-danger" data-del-art="${i}">Удалить</button>
      </div>`).join('')}</div></div>`;
}

function dataWorkshopsPanel() {
  return `<div class="panel"><div class="subhead"><h3>Цеха</h3><button class="btn" id="btn-add-ws">+ Цех</button></div>
    <table><thead><tr><th>Название</th><th>Роль</th><th class="num">Крой</th><th class="num">Пошив</th><th class="num">Утюжка</th><th class="num">ОТК</th><th></th></tr></thead>
    <tbody>${state.workshops.map((w, i) => `<tr>
      <td><input data-ws="${i}" data-f="name" value="${w.name}" style="width:110px"></td>
      <td><select data-ws="${i}" data-f="role"><option value="main"${w.role === 'main' ? ' selected' : ''}>основной</option><option value="aux"${w.role === 'aux' ? ' selected' : ''}>вспомог.</option></select></td>
      ${['cut', 'sew', 'iron', 'otk'].map((k) => `<td class="num"><input data-ws="${i}" data-cap="${k}" value="${w.capacities[k]}" style="width:70px;text-align:right"></td>`).join('')}
      <td><button class="btn btn-danger" data-del-ws="${i}">✕</button></td>
    </tr>`).join('')}</tbody></table>
    <div class="mini" style="margin-top:8px">Мощность указывается в штуках в день. Узкое горлышко — пошив.</div></div>`;
}

function dataStagesPanel() {
  return `<div class="panel"><div class="subhead"><h3>Этапы производства</h3><button class="btn" id="btn-add-stage">+ Этап</button></div>
    <table><thead><tr><th>Название</th><th>Месяцы продаж</th><th>Месяц отшива (YYYY-MM)</th><th>Дедлайн WB (YYYY-MM-DD)</th><th></th></tr></thead>
    <tbody>${state.stages.map((s, i) => `<tr>
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
    if (f === 'colors') a.colors = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (f === 'sizes') a.sizes = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if (f === 'fabricPerUnit') a.fabricPerUnit = +e.target.value || 1.6;
    else a[f] = e.target.value; mark();
  }));
  root.querySelectorAll('[data-del-art]').forEach((b) => b.addEventListener('click', () => { state.articles.splice(+b.dataset.delArt, 1); mark(); renderData(); }));
  root.querySelector('#btn-add-article')?.addEventListener('click', () => {
    state.articles.push({ id: uid('art').slice(0, 6), name: 'Новый артикул', fabricPerUnit: 1.6, colors: ['белый'], sizes: ['S', 'M', 'L', 'XL'], plan: {} }); mark(); renderData();
  });

  root.querySelectorAll('input[data-ws],select[data-ws]').forEach((inp) => inp.addEventListener('change', (e) => {
    const w = state.workshops[+e.target.dataset.ws];
    if (e.target.dataset.cap) w.capacities[e.target.dataset.cap] = Math.max(1, +e.target.value || 1);
    else w[e.target.dataset.f] = e.target.value; mark();
  }));
  root.querySelectorAll('[data-del-ws]').forEach((b) => b.addEventListener('click', () => { state.workshops.splice(+b.dataset.delWs, 1); mark(); renderData(); }));
  root.querySelector('#btn-add-ws')?.addEventListener('click', () => {
    state.workshops.push({ id: uid('w'), name: 'Новый цех', role: 'aux', capacities: { cut: 300, sew: 150, iron: 300, otk: 600 } }); mark(); renderData();
  });

  root.querySelectorAll('input[data-stage-i]').forEach((inp) => inp.addEventListener('change', (e) => {
    state.stages[+e.target.dataset.stageI][e.target.dataset.f] = e.target.value; mark();
  }));
  root.querySelectorAll('[data-del-stage]').forEach((b) => b.addEventListener('click', () => { state.stages.splice(+b.dataset.delStage, 1); mark(); renderData(); }));
  root.querySelector('#btn-add-stage')?.addEventListener('click', () => {
    const n = state.stages.length + 1;
    state.stages.push({ id: uid('stage'), name: `Этап ${n}`, salesMonths: '', productionMonth: '', deadline: '' }); mark(); renderData();
  });

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
async function init() {
  initTheme();
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.getElementById('btn-recalc').addEventListener('click', () => recalc(false).then(() => toast('Пересчитано')));
  document.getElementById('btn-save').addEventListener('click', () => recalc(true).then(() => toast('Сохранено и пересчитано')).catch((e) => toast('Ошибка: ' + e.message, true)));
  document.getElementById('zoom').addEventListener('input', (e) => { pxPerDay = +e.target.value; if (activeTab === 'gantt') renderCurrent(); });

  try {
    await loadAll();
    switchTab('gantt');
    setStatus();
  } catch (e) {
    document.getElementById('gantt').innerHTML = `<div style="padding:24px;color:var(--danger)">Ошибка загрузки: ${e.message}</div>`;
  }
}
init();
