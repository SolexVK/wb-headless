#!/usr/bin/env node
/* ============================================================
   Сервер калькулятора с аккаунтами (без внешних зависимостей).
   - Вход по форме + подписанная cookie-сессия (не Basic Auth).
   - Регистрация с подтверждением админом.
   - Восстановление пароля по коду восстановления (без email).
   - Пользователи в users.json (scrypt-хэши). Слушает 127.0.0.1.

   ENV:
     PORT           порт (по умолчанию 8787)
     CALC_USER      логин админа-сида (создаётся при первом запуске)
     CALC_PASS      пароль админа-сида (ОБЯЗАТЕЛЬНО при первом запуске)
     CALC_DIR       папка статики (по умолчанию — папка файла)
   Файлы рядом: users.json, .auth-secret (оба в .gitignore).
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.CALC_DIR || __dirname);
const PORT = parseInt(process.env.PORT || '8787', 10);
const USERS_FILE = path.join(ROOT, 'users.json');
const SECRET_FILE = path.join(ROOT, '.auth-secret');
const SEED_USER = process.env.CALC_USER || 'admin';
const SEED_PASS = process.env.CALC_PASS || '';
const SESSION_DAYS = 30;

/* ---------- секрет для подписи сессий ---------- */
function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE); } catch (e) {}
  const s = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

/* ---------- хранилище пользователей ---------- */
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (e) { return { users: {} }; }
}
function saveUsers(db) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}
function scryptHash(pw, saltHex) {
  return crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32).toString('hex');
}
function makeHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scryptHash(pw, salt) };
}
function verifyHash(pw, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const h = Buffer.from(scryptHash(pw, saltHex), 'hex');
  const e = Buffer.from(hashHex, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const g = () => Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  return `${g()}-${g()}-${g()}`;
}
function validUsername(u) { return /^[A-Za-z0-9_.-]{3,32}$/.test(u); }

// Сид админа при первом запуске
(function seedAdmin() {
  const db = loadUsers();
  if (Object.keys(db.users).length === 0 && SEED_PASS) {
    const { salt, hash } = makeHash(SEED_PASS);
    const code = genCode();
    const rc = makeHash(code);
    db.users[SEED_USER] = {
      salt, hash, status: 'approved', isAdmin: true,
      recoverySalt: rc.salt, recoveryHash: rc.hash,
      createdAt: new Date().toISOString(),
    };
    saveUsers(db);
    console.log(`Создан админ «${SEED_USER}». Код восстановления (сохраните): ${code}`);
  }
})();

/* ---------- сессии (подписанная cookie) ---------- */
function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return p + '.' + mac;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [p, mac] = tok.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return (o.exp && Date.now() > o.exp) ? null : o; }
  catch (e) { return null; }
}
function parseCookies(req) {
  const o = {}; (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }); return o;
}
function sessionUser(req) {
  const t = verifyToken(parseCookies(req).wbsess);
  if (!t) return null;
  const db = loadUsers(); const u = db.users[t.u];
  return (u && u.status === 'approved') ? { name: t.u, ...u } : null;
}
function setSession(res, req, username) {
  const tok = sign({ u: username, exp: Date.now() + SESSION_DAYS * 864e5 });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `wbsess=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'wbsess=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

/* ---------- тело запроса ---------- */
function readBody(req) {
  return new Promise((resolve) => {
    let d = '', size = 0;
    req.on('data', c => { size += c.length; if (size > 1e6) req.destroy(); else d += c; });
    req.on('end', () => resolve(d)); req.on('error', () => resolve(''));
  });
}
function parseForm(s) {
  const o = {}; (s || '').split('&').forEach(p => {
    if (!p) return; const i = p.indexOf('=');
    const k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\+/g, ' '));
    const v = decodeURIComponent((i < 0 ? '' : p.slice(i + 1)).replace(/\+/g, ' '));
    o[k] = v;
  }); return o;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- HTML страниц авторизации ---------- */
function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f6fb;color:#1a2230;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;box-shadow:0 6px 24px rgba(20,30,50,.08);width:100%;max-width:380px;padding:26px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#6b7688;font-size:13px;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}
input{width:100%;padding:10px 12px;font-size:14px;border:1px solid #e3e8f0;border-radius:9px;background:#f9fafc;outline:none}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.2)}
button{width:100%;margin-top:18px;padding:11px;font-size:14px;font-weight:700;color:#fff;background:#2e5496;border:0;border-radius:9px;cursor:pointer}
button:hover{background:#26467e}.links{margin-top:16px;font-size:13px;text-align:center}.links a{color:#2e5496;text-decoration:none;margin:0 6px}
.err{background:#fdeaea;color:#c0392b;border:1px solid #f5c6c6;border-radius:9px;padding:9px 11px;font-size:13px;margin-bottom:6px}
.ok{background:#e6f6ec;color:#1a8a4a;border:1px solid #b7e0c4;border-radius:9px;padding:9px 11px;font-size:13px}
.code{font-family:ui-monospace,Menlo,monospace;font-size:20px;font-weight:700;letter-spacing:1px;background:#f1f5fb;border:1px dashed #9db8e8;border-radius:9px;padding:12px;text-align:center;margin:10px 0;user-select:all}
</style></head><body><div class="card">${body}</div></body></html>`;
}
function loginPage(err) {
  return page('Вход — Юнит-калькулятор', `<h1>Юнит-калькулятор WB</h1><p class="sub">Вход в аккаунт</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
<form method="POST" action="/login">
<label>Логин</label><input name="username" autocomplete="username" autofocus>
<label>Пароль</label><input name="password" type="password" autocomplete="current-password">
<button type="submit">Войти</button></form>
<div class="links"><a href="/register">Регистрация</a>·<a href="/forgot">Забыли пароль?</a></div>`);
}
function registerPage(err) {
  return page('Регистрация', `<h1>Регистрация</h1><p class="sub">После регистрации аккаунт активирует администратор</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
<form method="POST" action="/register">
<label>Логин (3–32: буквы, цифры, _ . -)</label><input name="username" autocomplete="username" autofocus>
<label>Пароль (мин. 8 символов)</label><input name="password" type="password" autocomplete="new-password">
<label>Повторите пароль</label><input name="password2" type="password" autocomplete="new-password">
<button type="submit">Зарегистрироваться</button></form>
<div class="links"><a href="/login">Уже есть аккаунт — войти</a></div>`);
}
function registerDone(code) {
  return page('Регистрация завершена', `<h1>Готово ✓</h1>
<div class="ok">Аккаунт создан и ожидает одобрения администратора. Войти можно будет после активации.</div>
<p class="sub" style="margin-top:16px">Сохраните код восстановления — по нему можно сбросить пароль (показывается один раз):</p>
<div class="code">${esc(code)}</div>
<div class="links"><a href="/login">Перейти ко входу</a></div>`);
}
function forgotPage(err) {
  return page('Восстановление пароля', `<h1>Восстановление пароля</h1><p class="sub">Введите логин, код восстановления и новый пароль</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
<form method="POST" action="/forgot">
<label>Логин</label><input name="username" autofocus>
<label>Код восстановления</label><input name="code" placeholder="XXXX-XXXX-XXXX">
<label>Новый пароль (мин. 8)</label><input name="password" type="password" autocomplete="new-password">
<button type="submit">Сбросить пароль</button></form>
<div class="links"><a href="/login">Ко входу</a></div>`);
}
function forgotDone(code) {
  return page('Пароль изменён', `<h1>Пароль обновлён ✓</h1>
<div class="ok">Новый пароль сохранён. Ниже — новый код восстановления (старый больше не действует):</div>
<div class="code">${esc(code)}</div>
<div class="links"><a href="/login">Войти</a></div>`);
}
function adminPage(db, me) {
  const rows = Object.entries(db.users).map(([name, u]) => {
    const badge = u.status === 'approved' ? '✅ активен' : '⏳ ожидает';
    const admin = u.isAdmin ? ' <b>(админ)</b>' : '';
    const acts = [];
    if (u.status !== 'approved') acts.push(`<button name="a" value="approve">Одобрить</button>`);
    if (name !== me) acts.push(`<button name="a" value="delete" style="background:#c0392b">Удалить</button>`);
    return `<tr><td>${esc(name)}${admin}</td><td>${badge}</td><td>
      <form method="POST" action="/admin" style="display:flex;gap:6px;margin:0"><input type="hidden" name="user" value="${esc(name)}">${acts.join('')}</form></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Админ — пользователи</title><style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f6fb;color:#1a2230;margin:0;padding:24px}
.wrap{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:22px;box-shadow:0 6px 24px rgba(20,30,50,.08)}
h1{font-size:18px;margin:0 0 14px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px 8px;border-bottom:1px solid #eef1f6;font-size:14px}
button{padding:6px 10px;font-size:13px;font-weight:600;color:#fff;background:#2e5496;border:0;border-radius:8px;cursor:pointer}
a{color:#2e5496;text-decoration:none}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
</style></head><body><div class="wrap">
<div class="top"><h1>Пользователи</h1><div><a href="/">← Калькулятор</a> · <a href="/logout">Выход</a></div></div>
<table><thead><tr><th>Логин</th><th>Статус</th><th>Действие</th></tr></thead><tbody>${rows}</tbody></table>
</div></body></html>`;
}

/* ---------- отдача статики ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };
function send(res, code, type, body, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}
function redirect(res, loc, extra) { res.writeHead(302, Object.assign({ Location: loc }, extra || {})); res.end(); }

function serveStatic(req, res, urlPath, user) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const fp = path.join(ROOT, path.normalize(rel));
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');
  // не отдаём наружу секреты
  const base = path.basename(fp);
  if (base === 'users.json' || base === '.auth-secret') return send(res, 404, 'text/plain', 'Не найдено');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', 'Не найдено');
    // в index.html подставляем «кто вошёл + выход»
    if (base === 'index.html') {
      const adminLink = user.isAdmin ? `<a class="btn" href="/admin">Админ</a>` : '';
      const bar = `<span class="who" style="color:#fff;opacity:.9;font-size:13px;margin-right:6px">👤 ${esc(user.name)}</span>${adminLink}<form method="POST" action="/logout" style="display:inline;margin:0"><button class="btn" type="submit">Выход</button></form>`;
      data = Buffer.from(data.toString('utf8').replace('<span id="authslot"></span>', bar), 'utf8');
    }
    send(res, 200, MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', data, { 'Cache-Control': 'no-cache' });
  });
}

/* ---------- маршрутизатор ---------- */
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const method = req.method || 'GET';
  const user = sessionUser(req);

  // публичные (без входа)
  if (urlPath === '/login' && method === 'GET') return send(res, 200, 'text/html; charset=utf-8', loginPage(''));
  if (urlPath === '/register' && method === 'GET') return send(res, 200, 'text/html; charset=utf-8', registerPage(''));
  if (urlPath === '/forgot' && method === 'GET') return send(res, 200, 'text/html; charset=utf-8', forgotPage(''));
  if (urlPath === '/favicon.ico') return send(res, 204, 'text/plain', '');

  if (urlPath === '/login' && method === 'POST') {
    const f = parseForm(await readBody(req));
    const db = loadUsers(); const u = db.users[f.username];
    if (!u || !verifyHash(f.password || '', u.salt, u.hash)) return send(res, 401, 'text/html; charset=utf-8', loginPage('Неверный логин или пароль'));
    if (u.status !== 'approved') return send(res, 403, 'text/html; charset=utf-8', loginPage('Аккаунт ожидает одобрения администратора'));
    setSession(res, req, f.username); return redirect(res, '/');
  }
  if (urlPath === '/logout') { clearSession(res); return redirect(res, '/login'); }

  if (urlPath === '/register' && method === 'POST') {
    const f = parseForm(await readBody(req));
    const db = loadUsers();
    if (!validUsername(f.username || '')) return send(res, 400, 'text/html; charset=utf-8', registerPage('Логин 3–32: буквы, цифры, _ . -'));
    if (db.users[f.username]) return send(res, 400, 'text/html; charset=utf-8', registerPage('Такой логин уже занят'));
    if ((f.password || '').length < 8) return send(res, 400, 'text/html; charset=utf-8', registerPage('Пароль минимум 8 символов'));
    if (f.password !== f.password2) return send(res, 400, 'text/html; charset=utf-8', registerPage('Пароли не совпадают'));
    const { salt, hash } = makeHash(f.password);
    const code = genCode(); const rc = makeHash(code);
    db.users[f.username] = { salt, hash, status: 'pending', isAdmin: false, recoverySalt: rc.salt, recoveryHash: rc.hash, createdAt: new Date().toISOString() };
    saveUsers(db);
    return send(res, 200, 'text/html; charset=utf-8', registerDone(code));
  }

  if (urlPath === '/forgot' && method === 'POST') {
    const f = parseForm(await readBody(req));
    const db = loadUsers(); const u = db.users[f.username];
    const okCode = u && verifyHash((f.code || '').trim().toUpperCase(), u.recoverySalt, u.recoveryHash);
    if (!okCode) return send(res, 400, 'text/html; charset=utf-8', forgotPage('Неверный логин или код восстановления'));
    if ((f.password || '').length < 8) return send(res, 400, 'text/html; charset=utf-8', forgotPage('Новый пароль минимум 8 символов'));
    const ph = makeHash(f.password); const code = genCode(); const rc = makeHash(code);
    u.salt = ph.salt; u.hash = ph.hash; u.recoverySalt = rc.salt; u.recoveryHash = rc.hash;
    saveUsers(db);
    return send(res, 200, 'text/html; charset=utf-8', forgotDone(code));
  }

  // админ
  if (urlPath === '/admin') {
    if (!user) return redirect(res, '/login');
    if (!user.isAdmin) return send(res, 403, 'text/plain; charset=utf-8', 'Только для администратора');
    if (method === 'POST') {
      const f = parseForm(await readBody(req));
      const db = loadUsers(); const target = db.users[f.user];
      if (target) {
        if (f.a === 'approve') target.status = 'approved';
        else if (f.a === 'delete' && f.user !== user.name) delete db.users[f.user];
        saveUsers(db);
      }
      return redirect(res, '/admin');
    }
    return send(res, 200, 'text/html; charset=utf-8', adminPage(loadUsers(), user.name));
  }

  // всё остальное — только для вошедших
  if (!user) return redirect(res, '/login');
  return serveStatic(req, res, urlPath, user);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Калькулятор с аккаунтами: http://127.0.0.1:${PORT}`);
  console.log(`Пользователи: ${USERS_FILE}`);
  console.log('Наружу: tailscale funnel --bg --https=10000 ' + PORT);
});
