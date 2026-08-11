'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let ME = null;
const streams = new Map(); // jobId -> EventSource

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error((data && data.message) || res.statusText), { status: res.status, data });
  return data;
}

// ---------- boot ----------
init();
async function init() {
  try {
    const me = await api('/api/me');
    if (me.user) { ME = me.user; showMain(); }
    else showLogin();
  } catch { showLogin(); }
}
function showLogin() { $('#view-login').classList.remove('hidden'); $('#view-main').classList.add('hidden'); }
let YK_ENABLED = false;
function showMain() {
  $('#view-login').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  $('#whoami').textContent = ME.username;
  const sub = $('#sub-badge');
  sub.textContent = ME.active ? 'подписка активна' : 'нет подписки';
  sub.className = 'badge ' + (ME.active ? 'ok' : 'no');
  $$('.admin-only').forEach(e => e.classList.toggle('hidden', ME.role !== 'admin'));
  // storage mode: owner/admin sees folder picker; subscribers get delivery mode
  const local = !!ME.localAccess;
  $('#folder-block').classList.toggle('hidden', !local);
  $('#delivery-note').classList.toggle('hidden', local);
  $('#usage-box').classList.toggle('hidden', local);
  updateGate();
  refreshUsage();
  loadJobs();
  if (ME.role === 'admin') loadUsers();
}
async function refreshUsage() {
  if (ME.localAccess) return;
  try {
    const u = await api('/api/usage');
    $('#note-retention').textContent = u.retentionMin;
    $('#note-limit').textContent = u.dailyGB + ' ГБ';
    const gb = b => (b / 1073741824).toFixed(1);
    $('#usage-text').textContent = `Сегодня скачано: ${gb(u.bytes)} / ${u.dailyGB} ГБ` + (u.dailyFiles ? `, файлов ${u.files}/${u.dailyFiles}` : '');
    $('#usage-bar').style.width = Math.min(100, Math.round(u.bytes / u.dailyBytes * 100)) + '%';
  } catch {}
}

// ---------- auth ----------
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('/api/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
    ME = r.user; showMain();
  } catch (err) { $('#login-error').textContent = err.message || 'Ошибка входа'; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });

// ---------- tabs ----------
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const t = b.dataset.tab;
  $('#tab-download').classList.toggle('hidden', t !== 'download');
  $('#tab-jobs').classList.toggle('hidden', t !== 'jobs');
  $('#tab-admin').classList.toggle('hidden', t !== 'admin');
  if (t === 'jobs') loadJobs();
  if (t === 'admin') loadUsers();
}));

// ---------- subscription gate ----------
async function updateGate() {
  const gate = $('#sub-gate');
  if (ME.active) { gate.classList.add('hidden'); return; }
  gate.classList.remove('hidden');
  try {
    const info = await api('/api/billing/info');
    $('#sub-note').textContent = info.priceNote || '';
    YK_ENABLED = !!info.yookassaEnabled;
    const yk = $('#pay-yk');
    yk.textContent = YK_ENABLED ? 'Оплатить картой (ЮKassa)' : 'Оплата картой — скоро';
    yk.disabled = !YK_ENABLED;
  } catch {}
}
$('#pay-yk').addEventListener('click', async () => {
  if (!YK_ENABLED) return;
  try {
    const r = await api('/api/billing/yookassa/create', { method: 'POST' });
    if (r.confirmationUrl) location.href = r.confirmationUrl;
  } catch (err) { $('#redeem-msg').textContent = err.message || 'ЮKassa недоступна'; }
});
$('#redeem-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/billing/redeem', { method: 'POST', body: { code: e.target.code.value } });
    $('#redeem-msg').textContent = 'Готово! Подписка активирована.';
    const me = await api('/api/me'); ME = me.user; showMain();
  } catch (err) { $('#redeem-msg').textContent = err.message || 'Не удалось активировать'; }
});

// ---------- folder picker ----------
let curPath = '.';
$('#btn-browse').addEventListener('click', () => { openModal('.'); });
$('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#pick-here').addEventListener('click', () => {
  $('#gc-out').value = $('#cur-path').dataset.abs;
  $('#gc-out').dataset.rel = curPath;
  $('#modal').classList.add('hidden');
});
$('#mkdir-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = e.target.name.value.trim(); if (!name) return;
  try { await api('/api/fs/mkdir', { method: 'POST', body: { path: curPath, name } }); e.target.name.value = ''; openModal(curPath); }
  catch (err) { alert(err.message); }
});
async function openModal(p) {
  $('#modal').classList.remove('hidden');
  try {
    const d = await api('/api/fs/list?path=' + encodeURIComponent(p));
    curPath = d.path || '.';
    const cp = $('#cur-path'); cp.textContent = d.absolute; cp.dataset.abs = d.absolute;
    const list = $('#dir-list'); list.innerHTML = '';
    if (d.parent !== null) list.appendChild(dirItem('.. (вверх)', d.parent, true));
    d.dirs.forEach(x => list.appendChild(dirItem(x.name, x.path, false)));
    if (!d.dirs.length && d.parent === null) list.insertAdjacentHTML('beforeend', '<div class="dir-item up">пусто</div>');
  } catch (err) { alert(err.message); }
}
function dirItem(name, p, up) {
  const el = document.createElement('div');
  el.className = 'dir-item' + (up ? ' up' : '');
  el.textContent = (up ? '↑ ' : '📁 ') + name;
  el.addEventListener('click', () => openModal(p));
  return el;
}

// ---------- start job ----------
$('#btn-start').addEventListener('click', async () => {
  const body = {
    email: $('#gc-email').value.trim(),
    password: $('#gc-pass').value,
    startUrl: $('#gc-url').value.trim(),
    output: $('#gc-out').dataset.rel || $('#gc-out').value.trim(),
    concurrency: +$('#gc-conc').value || 10,
    limit: +$('#gc-limit').value || 0,
  };
  const msg = $('#start-msg');
  const needFolder = !!ME.localAccess;
  if (!body.email || !body.password || !body.startUrl || (needFolder && !body.output)) {
    msg.textContent = needFolder ? 'Заполните email, пароль, ссылку и папку.' : 'Заполните email, пароль и ссылку.';
    return;
  }
  msg.textContent = 'Запуск…';
  try {
    await api('/api/jobs', { method: 'POST', body });
    $('#gc-pass').value = '';
    msg.textContent = 'Задача создана.';
    $$('.tab').find(b => b.dataset.tab === 'jobs').click();
  } catch (err) {
    if (err.status === 402) { msg.textContent = 'Требуется активная подписка.'; updateGate(); }
    else msg.textContent = err.message || 'Ошибка запуска';
  }
});

// ---------- jobs ----------
async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    const list = $('#jobs-list'); list.innerHTML = '';
    $('#jobs-empty').classList.toggle('hidden', jobs.length > 0);
    jobs.forEach(j => { list.appendChild(renderJob(j)); attachStream(j.id); });
  } catch {}
}
function renderJob(j) {
  let el = document.getElementById('job-' + j.id);
  if (!el) {
    el = document.createElement('div'); el.className = 'job'; el.id = 'job-' + j.id;
    el.innerHTML = `
      <div class="job-head">
        <div class="job-title"></div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="status"></span>
          <button class="link cancel">Отменить</button>
        </div>
      </div>
      <div class="bar"><span></span></div>
      <div class="job-meta"></div>
      <div class="files hidden"></div>
      <div class="log"></div>`;
    el.querySelector('.cancel').addEventListener('click', () => api('/api/jobs/' + j.id + '/cancel', { method: 'POST' }));
  }
  el.querySelector('.job-title').textContent = j.output || j.startUrl;
  const st = el.querySelector('.status'); st.textContent = statusRu(j.status); st.className = 'status ' + j.status;
  el.querySelector('.cancel').classList.toggle('hidden', !(j.status === 'running' || j.status === 'queued'));
  updateJobView(el, j);
  return el;
}
function statusRu(s){return {queued:'в очереди',running:'идёт',done:'готово',error:'ошибка',cancelled:'отменено',limited:'лимит дня'}[s]||s;}
function updateJobView(el, j) {
  const total = j.totalLessons || 0;
  const completed = j.completedVideos || 0;
  const cur = j.current;
  let pct = 0;
  if (total) pct = Math.min(100, Math.round((completed / total) * 100));
  el.querySelector('.bar>span').style.width = pct + '%';
  const meta = [];
  if (total) meta.push(`уроков: ${completed}/${total}`);
  if (cur && cur.total) meta.push(`текущий: сегменты ${cur.done}/${cur.total}`);
  if (cur && cur.title) meta.push(cur.title);
  if (j.summary) meta.push(`итог: ${j.summary.ok} скачано, ${j.summary.skipped} пропущено, ${j.summary.problems} проблем`);
  if (j.quotaStopped) meta.push('остановлено по дневному лимиту');
  el.querySelector('.job-meta').textContent = meta.join('  •  ');
  renderFiles(el, j);
}
function renderFiles(el, j) {
  const box = el.querySelector('.files');
  if (!j.files) { box.classList.add('hidden'); return; } // local mode: nothing to serve
  box.classList.remove('hidden');
  box.innerHTML = j.files.length ? '<div class="muted" style="font-size:12px;margin-bottom:4px">Готовые файлы — сохраните на свой компьютер:</div>' : '';
  j.files.forEach(f => {
    const row = document.createElement('div');
    row.className = 'file';
    const mb = (f.bytes / 1048576).toFixed(1);
    const mins = Math.max(0, Math.round((f.expiresAt - Date.now()) / 60000));
    row.innerHTML = `<span class="fname">${esc(f.name)}</span>
      <span class="fmeta">${f.height ? f.height + 'p, ' : ''}${mb} МБ</span>`;
    if (f.available) {
      const a = document.createElement('a');
      a.className = 'dl'; a.href = `/api/jobs/${j.id}/files/${f.index}/download`; a.textContent = 'Скачать'; a.setAttribute('download', '');
      row.appendChild(a);
      const exp = document.createElement('span'); exp.className = 'exp'; exp.textContent = `удалится через ~${mins} мин`;
      row.appendChild(exp);
    } else {
      const g = document.createElement('span'); g.className = 'exp'; g.textContent = 'удалён';
      row.appendChild(g);
    }
    box.appendChild(row);
  });
}
function appendLog(el, lines) {
  const box = el.querySelector('.log');
  lines.forEach(l => { const d = document.createElement('div'); d.textContent = l.message; box.appendChild(d); });
  while (box.children.length > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function attachStream(id) {
  if (streams.has(id)) return;
  const es = new EventSource('/api/jobs/' + id + '/events');
  streams.set(id, es);
  es.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    const el = document.getElementById('job-' + id);
    if (!el) return;
    if (d.type === 'snapshot') {
      renderJob(d.job); appendLog(el, d.log || []);
    } else if (d.type === 'log') {
      appendLog(el, [{ message: d.message }]);
    } else if (d.type === 'status' || d.type === 'fatal') {
      loadJobs();
      refreshUsage();
      if (d.type === 'status' && (d.status === 'done' || d.status === 'error' || d.status === 'cancelled' || d.status === 'limited')) { es.close(); streams.delete(id); }
    } else if (d.type === 'file') {
      refreshJob(id); refreshUsage();
    } else {
      // progress-ish events: refresh the compact view by refetching job state cheaply
      refreshJob(id);
    }
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}
let refreshTimers = {};
function refreshJob(id) {
  if (refreshTimers[id]) return;
  refreshTimers[id] = setTimeout(async () => {
    refreshTimers[id] = null;
    try { const { job } = await api('/api/jobs/' + id); const el = document.getElementById('job-' + id); if (el && job) { const st = el.querySelector('.status'); st.textContent = statusRu(job.status); st.className = 'status ' + job.status; updateJobView(el, job); } } catch {}
  }, 600);
}

// ---------- admin ----------
async function loadUsers() {
  if (ME.role !== 'admin') return;
  try {
    const { users } = await api('/api/admin/users');
    const tb = $('#users-table tbody'); tb.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(u.username)}</td><td>${u.role}</td>
        <td>${u.active ? '✅' : '—'}${u.subscription && u.subscription.expires ? ' до ' + u.subscription.expires.slice(0,10) : ''}</td>
        <td></td>`;
      const td = tr.lastElementChild;
      const t = document.createElement('button'); t.className = 'link'; t.textContent = u.active ? 'выкл' : 'вкл';
      t.addEventListener('click', async () => { await api('/api/admin/users/' + u.id + '/subscription', { method: 'POST', body: { active: !u.active } }); loadUsers(); });
      td.appendChild(t);
      if (u.id !== ME.id) {
        const del = document.createElement('button'); del.className = 'link'; del.textContent = '🗑';
        del.addEventListener('click', async () => { if (confirm('Удалить ' + u.username + '?')) { await api('/api/admin/users/' + u.id, { method: 'DELETE' }); loadUsers(); } });
        td.appendChild(del);
      }
      tb.appendChild(tr);
    });
  } catch {}
}
$('#nu-create').addEventListener('click', async () => {
  const body = { username: $('#nu-name').value.trim(), password: $('#nu-pass').value, role: $('#nu-admin').checked ? 'admin' : 'user', subscriptionActive: $('#nu-sub').checked, localAccess: $('#nu-local').checked };
  try { await api('/api/admin/users', { method: 'POST', body }); $('#nu-name').value = ''; $('#nu-pass').value = ''; $('#nu-msg').textContent = 'Создан.'; loadUsers(); }
  catch (err) { $('#nu-msg').textContent = err.message; }
});
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
