// service/smoke-test.mjs — in-process дымовой тест Фазы 0 (без внешнего сервера).
// Поднимает app на эфемерном порту, гоняет auth-флоу через fetch с ручным cookie-jar.
//   node smoke-test.mjs
// Использует временную БД (DB_PATH), чтобы не трогать рабочую.
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-please-change';
process.env.DB_PATH = path.join(os.tmpdir(), `fbs-smoke-${process.pid}.sqlite`);

const { buildApp } = await import('./app.js');
const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
async function req(method, url, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  const sc = res.headers.getSetCookie?.() || [];
  for (const c of sc) cookie = c.split(';')[0];        // простой jar: последний cookie
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}
const form = (o) => new URLSearchParams(o).toString();
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

let failed = 0;
const ok = (cond, msg) => { process.stdout.write(`${cond ? '✓' : '✗ FAIL'}  ${msg}\n`); if (!cond) failed++; };

try {
  const email = `smoke${Date.now()}@example.com`;

  ok((await req('GET', '/healthz')).status === 200, 'GET /healthz → 200');

  let r = await req('GET', '/register');
  const csrf1 = csrfOf(r.text);
  ok(r.status === 200 && !!csrf1, 'GET /register → 200 + CSRF-токен');

  r = await req('POST', '/register', form({ _csrf: csrf1, email, password: 'supersecret1', name: 'Смоук' }));
  ok(r.status === 302 && r.location === '/', 'POST /register → 302 /');

  r = await req('GET', '/');
  ok(r.status === 200 && r.text.includes('Смоук') && r.text.includes('owner'), 'GET / → домашняя (имя + роль owner)');

  const csrfLogout = csrfOf(r.text);
  ok(!!csrfLogout, 'форма «Выйти» содержит CSRF-поле');

  r = await req('POST', '/logout', form({ _csrf: csrfLogout }));
  ok(r.status === 302 && r.location === '/login', 'POST /logout → 302 /login');

  r = await req('GET', '/');
  ok(r.status === 302 && r.location === '/login', 'GET / без сессии → 302 /login');

  r = await req('GET', '/login');
  const csrfL = csrfOf(r.text);
  r = await req('POST', '/login', form({ _csrf: csrfL, email, password: 'supersecret1' }));
  ok(r.status === 302 && r.location === '/', 'POST /login (верный пароль) → 302 /');

  cookie = ''; // негативные проверки — из анонимной сессии (авторизованного GET /login редиректит)
  r = await req('GET', '/login');
  const csrfW = csrfOf(r.text);
  r = await req('POST', '/login', form({ _csrf: csrfW, email, password: 'wrongpass!' }));
  ok(r.status === 401, 'POST /login (неверный пароль) → 401');

  // CSRF: POST без токена → 403
  r = await req('POST', '/login', form({ email, password: 'x' }));
  ok(r.status === 403, 'POST без CSRF → 403');
} catch (e) {
  console.error('Ошибка теста:', e); failed++;
} finally {
  server.close();
  try { fs.rmSync(process.env.DB_PATH, { force: true }); fs.rmSync(process.env.DB_PATH + '-wal', { force: true }); fs.rmSync(process.env.DB_PATH + '-shm', { force: true }); } catch { /* */ }
}
process.stdout.write(failed ? `\n${failed} проверок упало\n` : '\nВсе проверки зелёные\n');
process.exit(failed ? 1 : 0);
