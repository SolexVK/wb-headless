'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let ME = null, CAPS = { signup: true, google: false };
let YK_ENABLED = false;
let localDirHandle = null;            // File System Access API handle (delivery)
const streams = new Map();            // jobId -> EventSource

// ---------- session log + error reporting ----------
const SESSION_LOG = [];
function slog(type, msg) {
  SESSION_LOG.push({ t: Date.now(), type, msg: String(msg).slice(0, 500) });
  if (SESSION_LOG.length > 500) SESSION_LOG.splice(0, SESSION_LOG.length - 500);
}
function noteError(msg) { slog('error', msg); const b = $('#report-btn'); if (b) b.classList.remove('hidden'); }
window.addEventListener('error', e => noteError('JS: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', e => noteError('promise: ' + (e.reason && e.reason.message || e.reason)));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = Object.assign(new Error((data && data.message) || res.statusText), { status: res.status, data });
    slog('api-error', `${opts.method || 'GET'} ${path} -> ${res.status} ${err.message}`);
    if (res.status >= 500) noteError(`Сервер вернул ошибку ${res.status} на ${path}`);
    throw err;
  }
  return data;
}

// ---------- password eye toggles ----------
function attachEyes(root = document) {
  $$('input[type="password"]', root).forEach(inp => {
    if (inp.dataset.eye) return;
    inp.dataset.eye = '1';
    const wrap = document.createElement('span'); wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'eye'; btn.tabIndex = -1; btn.textContent = '👁';
    btn.title = 'Показать пароль';
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
    });
    wrap.appendChild(btn);
  });
}

// ---------- boot ----------
init();
async function init() {
  attachEyes();
  try {
    const me = await api('/api/me');
    CAPS = me.capabilities || CAPS;
    if (me.user) { ME = me.user; showMain(); return; }
  } catch {}
  showLogin();
}

// ---------- auth screens ----------
function showLogin() {
  $('#view-login').classList.remove('hidden');
  $('#view-main').classList.add('hidden');
  // Google + register availability
  $('#google-block').classList.toggle('hidden', !CAPS.google);
  $$('[data-go="register"]').forEach(a => a.classList.toggle('hidden', !CAPS.signup));
  // reset mode?
  const token = new URLSearchParams(location.search).get('reset');
  if (token) {
    api('/api/password/check?token=' + encodeURIComponent(token)).then(r => {
      if (r.valid) { authMode('reset'); $('#reset-form').dataset.token = token; }
      else { authMode('login'); $('#auth-error').textContent = 'Ссылка для сброса недействительна или истекла.'; }
    }).catch(() => authMode('login'));
  } else authMode('login');
}
function authMode(mode) {
  ['login', 'register', 'forgot', 'reset'].forEach(m => $('#' + m + '-form').classList.toggle('hidden', m !== mode));
  $('#auth-error').textContent = ''; $('#auth-msg').textContent = '';
  $('#google-block').classList.toggle('hidden', !CAPS.google || mode === 'reset');
}
$$('[data-go]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); authMode(a.dataset.go); }));

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('/api/login', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value } });
    ME = r.user; slog('auth', 'login ok'); showMain();
  } catch (err) { $('#auth-error').textContent = err.message || 'Ошибка входа'; }
});
$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('/api/register', { method: 'POST', body: { email: e.target.email.value, password: e.target.password.value } });
    ME = r.user; slog('auth', 'register ok'); showMain();
  } catch (err) { $('#auth-error').textContent = err.message || 'Не удалось зарегистрироваться'; }
});
$('#forgot-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('/api/password/forgot', { method: 'POST', body: { email: e.target.email.value } });
    $('#auth-msg').textContent = r.message || 'Если аккаунт существует, ссылка подготовлена.';
    $('#auth-error').textContent = '';
  } catch (err) { $('#auth-error').textContent = err.message; }
});
$('#reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const token = $('#reset-form').dataset.token;
    const r = await api('/api/password/reset', { method: 'POST', body: { token, password: e.target.password.value } });
    ME = r.user; history.replaceState({}, '', '/'); showMain();
  } catch (err) { $('#auth-error').textContent = err.message; }
});

function showMain() {
  $('#view-login').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  $('#whoami').textContent = ME.email || ME.username;
  const sub = $('#sub-badge');
  sub.textContent = ME.active ? 'подписка активна' : 'нет подписки';
  sub.className = 'badge ' + (ME.active ? 'ok' : 'no');
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', ME.role !== 'admin'));
  const local = !!ME.localAccess;
  $('#folder-block').classList.toggle('hidden', !local);
  $('#delivery-note').classList.toggle('hidden', local);
  $('#usage-box').classList.toggle('hidden', local);
  $('#local-folder-block').classList.toggle('hidden', local);
  if (!local) {
    const supported = 'showDirectoryPicker' in window;
    $('#local-unsupported').classList.toggle('hidden', supported);
    $('#btn-local').classList.toggle('hidden', !supported);
  }
  updateGate();
  refreshUsage();
  loadJobs();
  if (ME.role === 'admin') { loadUsers(); loadResets(); loadReports(); }
}
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; });

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

// ---------- tabs ----------
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const t = b.dataset.tab;
  ['download', 'jobs', 'admin', 'reports'].forEach(name => $('#tab-' + name).classList.toggle('hidden', name !== t));
  slog('nav', 'tab ' + t);
  if (t === 'jobs') loadJobs();
  if (t === 'admin') { loadUsers(); loadResets(); }
  if (t === 'reports') loadReports();
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
$('#redeem-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/billing/redeem', { method: 'POST', body: { code: e.target.code.value } });
    $('#redeem-msg').textContent = 'Готово! Подписка активирована.';
    const me = await api('/api/me'); ME = me.user; showMain();
  } catch (err) { $('#redeem-msg').textContent = err.message || 'Не удалось активировать'; }
});
$('#pay-yk').addEventListener('click', async () => {
  if (!YK_ENABLED) return;
  try { const r = await api('/api/billing/yookassa/create', { method: 'POST' }); if (r.confirmationUrl) location.href = r.confirmationUrl; }
  catch (err) { $('#redeem-msg').textContent = err.message || 'ЮKassa недоступна'; }
});

// ---------- server folder picker (owner/admin) ----------
let curPath = '.';
$('#btn-browse').addEventListener('click', () => openModal('.'));
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

// ---------- local folder (delivery, File System Access API) ----------
$('#btn-local').addEventListener('click', async () => {
  try {
    localDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('#local-out').value = localDirHandle.name + ' (выбрана)';
  } catch (e) { /* user cancelled */ }
});
async function saveToLocalFolder(job) {
  if (!localDirHandle) { alert('Сначала выберите папку на компьютере.'); return; }
  const files = (job.files || []).filter(f => f.available);
  for (const f of files) {
    try {
      const res = await fetch(`/api/jobs/${job.id}/files/${f.index}/download`);
      const blob = await res.blob();
      const safe = f.name.replace(/\s*\/\s*/g, ' - ').replace(/[\\/:*?"<>|]+/g, '-');
      const fh = await localDirHandle.getFileHandle(safe, { create: true });
      const w = await fh.createWritable(); await w.write(blob); await w.close();
    } catch (e) { noteError('Не удалось сохранить ' + f.name + ': ' + e.message); }
  }
  alert('Готово: файлы сохранены в «' + localDirHandle.name + '».');
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
    slog('job', 'created');
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
  const total = j.totalLessons || 0, completed = j.completedVideos || 0, cur = j.current;
  el.querySelector('.bar>span').style.width = (total ? Math.min(100, Math.round(completed / total * 100)) : 0) + '%';
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
  if (!j.files) { box.classList.add('hidden'); return; } // local (server-save) mode
  box.classList.remove('hidden');
  box.innerHTML = '';
  if (!j.files.length) return;
  const head = document.createElement('div');
  head.className = 'files-head';
  head.innerHTML = '<span class="muted">Готовые файлы — сохраните к себе:</span>';
  if (localDirHandle) {
    const all = document.createElement('button'); all.className = 'link'; all.textContent = '⬇ Сохранить всё в «' + localDirHandle.name + '»';
    all.addEventListener('click', () => saveToLocalFolder(j));
    head.appendChild(all);
  }
  box.appendChild(head);
  j.files.forEach(f => {
    const row = document.createElement('div'); row.className = 'file';
    const mb = (f.bytes / 1048576).toFixed(1);
    const mins = Math.max(0, Math.round((f.expiresAt - Date.now()) / 60000));
    row.innerHTML = `<span class="fname">${esc(f.name)}</span><span class="fmeta">${f.height ? f.height + 'p, ' : ''}${mb} МБ</span>`;
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
    const el = document.getElementById('job-' + id); if (!el) return;
    if (d.type === 'snapshot') { renderJob(d.job); appendLog(el, d.log || []); }
    else if (d.type === 'log') { appendLog(el, [{ message: d.message }]); }
    else if (d.type === 'status' || d.type === 'fatal') {
      if (d.type === 'fatal') noteError('Задача упала: ' + d.error);
      if (d.type === 'status' && d.status === 'error') noteError('Задача завершилась с ошибкой');
      loadJobs(); refreshUsage();
      if (d.type === 'status' && ['done','error','cancelled','limited'].includes(d.status)) { es.close(); streams.delete(id); }
    }
    else if (d.type === 'file') { refreshJob(id); refreshUsage(); }
    else if (d.type === 'lesson-error') { slog('job', 'lesson-error: ' + d.error); refreshJob(id); }
    else refreshJob(id);
  };
  es.onerror = () => {};
}
let refreshTimers = {};
function refreshJob(id) {
  if (refreshTimers[id]) return;
  refreshTimers[id] = setTimeout(async () => {
    refreshTimers[id] = null;
    try { const { job } = await api('/api/jobs/' + id); const el = document.getElementById('job-' + id); if (el && job) { const st = el.querySelector('.status'); st.textContent = statusRu(job.status); st.className = 'status ' + job.status; updateJobView(el, job); } } catch {}
  }, 600);
}

// ---------- error report ----------
$('#report-btn').addEventListener('click', async () => {
  try {
    await api('/api/report', { method: 'POST', body: { message: 'Пользователь сообщил об ошибке', entries: SESSION_LOG, context: { ua: navigator.userAgent, url: location.href } } });
    $('#report-btn').textContent = '✓ Лог отправлен администратору';
    setTimeout(() => { const b = $('#report-btn'); b.classList.add('hidden'); b.textContent = '⚠ Сообщить об ошибке'; }, 3000);
  } catch (e) { $('#report-btn').textContent = 'Не удалось отправить'; }
});

// ---------- admin: users ----------
async function loadUsers() {
  if (ME.role !== 'admin') return;
  try {
    const { users } = await api('/api/admin/users');
    const tb = $('#users-table tbody'); tb.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(u.email || u.username)}${u.provider === 'google' ? ' <span class="tag">G</span>' : ''}</td>
        <td>${u.role}${u.localAccess ? ' <span class="tag">папки</span>' : ''}</td>
        <td>${u.active ? '✅' : '—'}${u.subscription && u.subscription.expires ? ' до ' + u.subscription.expires.slice(0,10) : ''}</td>
        <td></td>`;
      const td = tr.lastElementChild;
      const t = document.createElement('button'); t.className = 'link'; t.textContent = u.active ? 'выкл' : 'вкл';
      t.addEventListener('click', async () => { await api('/api/admin/users/' + u.id + '/subscription', { method: 'POST', body: { active: !u.active } }); loadUsers(); });
      td.appendChild(t);
      const rl = document.createElement('button'); rl.className = 'link'; rl.textContent = 'сброс';
      rl.title = 'Сгенерировать ссылку для сброса пароля';
      rl.addEventListener('click', async () => { const r = await api('/api/admin/users/' + u.id + '/reset-link', { method: 'POST' }); prompt('Ссылка для сброса пароля (передайте пользователю):', r.link); });
      td.appendChild(rl);
      if (u.id !== ME.id) {
        const del = document.createElement('button'); del.className = 'link'; del.textContent = '🗑';
        del.addEventListener('click', async () => { if (confirm('Удалить ' + (u.email || u.username) + '?')) { await api('/api/admin/users/' + u.id, { method: 'DELETE' }); loadUsers(); } });
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

// ---------- admin: reset requests ----------
async function loadResets() {
  if (ME.role !== 'admin') return;
  try {
    const { resets } = await api('/api/admin/resets');
    const box = $('#resets-list');
    if (!resets.length) { box.textContent = 'Нет активных запросов.'; return; }
    box.innerHTML = '';
    resets.forEach(r => {
      const d = document.createElement('div'); d.className = 'reset-row';
      d.innerHTML = `<b>${esc(r.email)}</b> <span class="muted">${new Date(r.createdAt).toLocaleString()}</span> `;
      const c = document.createElement('button'); c.className = 'link'; c.textContent = 'скопировать ссылку';
      c.addEventListener('click', () => { navigator.clipboard?.writeText(r.link); prompt('Ссылка для сброса:', r.link); });
      d.appendChild(c); box.appendChild(d);
    });
  } catch {}
}

// ---------- admin: reports ----------
async function loadReports() {
  if (ME.role !== 'admin') return;
  try {
    const { reports, unread } = await api('/api/admin/reports');
    const badge = $('#reports-badge');
    badge.textContent = unread; badge.classList.toggle('hidden', !unread);
    const tb = $('#reports-table tbody'); tb.innerHTML = '';
    reports.forEach(r => {
      const tr = document.createElement('tr'); if (!r.read) tr.className = 'unread';
      tr.innerHTML = `<td>${new Date(r.createdAt).toLocaleString()}</td><td>${esc(r.username)}</td><td>${esc(r.message || '')}</td><td></td>`;
      const open = document.createElement('button'); open.className = 'link'; open.textContent = 'открыть';
      open.addEventListener('click', async () => {
        const { report } = await api('/api/admin/reports/' + r.id);
        $('#report-view').classList.remove('hidden');
        $('#report-view').textContent = JSON.stringify(report, null, 2);
        loadReports();
      });
      tr.lastElementChild.appendChild(open); tb.appendChild(tr);
    });
  } catch {}
}

function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
