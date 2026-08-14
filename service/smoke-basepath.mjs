// service/smoke-basepath.mjs — проверка работы под префиксом (BASE_PATH=/fbs).
// Отдельный процесс: config читает BASE_PATH один раз при импорте.
//   node --experimental-sqlite smoke-basepath.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-please-change';
process.env.TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.WB_PING_ONLINE = '0';
process.env.BASE_PATH = '/fbs';
process.env.DB_PATH = path.join(os.tmpdir(), `fbs-smoke-bp-${process.pid}.sqlite`);

const { buildApp } = await import('./app.js');
const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
let lastSetCookie = [];
async function req(method, url, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  lastSetCookie = res.headers.getSetCookie?.() || [];
  for (const c of lastSetCookie) cookie = c.split(';')[0];
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}
const form = (o) => new URLSearchParams(o).toString();
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

let failed = 0;
const ok = (cond, msg) => { process.stdout.write(`${cond ? '✓' : '✗ FAIL'}  ${msg}\n`); if (!cond) failed++; };

try {
  // Health-check доступен и по корню, и под префиксом.
  ok((await req('GET', '/healthz')).status === 200, 'BP: GET /healthz (корень) → 200');
  ok((await req('GET', '/fbs/healthz')).status === 200, 'BP: GET /fbs/healthz → 200');

  // Без префикса приложения нет.
  ok((await req('GET', '/login')).status === 404, 'BP: GET /login без префикса → 404');

  // Страница входа под префиксом: ссылки/экшены содержат /fbs.
  let r = await req('GET', '/fbs/login');
  ok(r.status === 200 && r.text.includes('action="/fbs/login"') && r.text.includes('href="/fbs/register"'),
    'BP: /fbs/login рендерится со ссылками с префиксом');

  // Кука сессии ограничена префиксом.
  r = await req('GET', '/fbs/register');
  const csrf1 = csrfOf(r.text);
  ok(lastSetCookie.some((c) => /Path=\/fbs/.test(c)), 'BP: cookie сессии Path=/fbs');

  // Регистрация → редирект на /fbs/ (префикс подставлен обёрткой redirect).
  const email = `bp_${Date.now()}@example.com`;
  r = await req('POST', '/fbs/register', form({ _csrf: csrf1, email, password: 'supersecret1', name: 'Префикс' }));
  ok(r.status === 302 && r.location === '/fbs/', 'BP: POST /fbs/register → 302 /fbs/');

  // Домашняя под префиксом, ссылка на организацию с префиксом.
  r = await req('GET', '/fbs/');
  const orgHref = (r.text.match(/href="(\/fbs\/org\/\d+)"/) || [])[1];
  ok(r.status === 200 && r.text.includes('Префикс') && !!orgHref, 'BP: /fbs/ домашняя со ссылкой /fbs/org/...');

  // Логаут-форма шлёт на /fbs/logout.
  ok(r.text.includes('action="/fbs/logout"'), 'BP: форма выхода → /fbs/logout');

  // Неавторизованный заход на приглашение под префиксом → редирект на /fbs/login.
  cookie = '';
  r = await req('GET', '/fbs/invite/doesnotexist');
  ok(r.status === 302 && r.location === '/fbs/login', 'BP: /fbs/invite/... без входа → 302 /fbs/login');
} catch (e) {
  console.error('Ошибка теста:', e); failed++;
} finally {
  server.close();
  for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + suf, { force: true }); } catch { /* */ } }
}
process.stdout.write(failed ? `\n${failed} проверок упало\n` : '\nBASE_PATH: все проверки зелёные\n');
process.exit(failed ? 1 : 0);
