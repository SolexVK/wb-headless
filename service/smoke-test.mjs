// service/smoke-test.mjs — in-process дымовой тест Фазы 0 (без внешнего сервера).
// Поднимает app на эфемерном порту, гоняет auth-флоу через fetch с ручным cookie-jar.
//   node smoke-test.mjs
// Использует временную БД (DB_PATH), чтобы не трогать рабочую.
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.BASE_PATH = ''; // тест в корне: не даём .env (BASE_PATH=/fbs) сбить пути
process.env.SESSION_SECRET = 'test-secret-please-change';
process.env.TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'; // 32 байта hex (тест)
process.env.WB_PING_ONLINE = '0'; // офлайн: проверяем токен только по маске (без сети)
process.env.DEFAULT_LICENSE_SEATS = '3'; // тест приглашений: 3 места
process.env.SUPER_ADMIN_EMAILS = 'super@example.com'; // супер-админ для теста панели
process.env.DB_PATH = path.join(os.tmpdir(), `fbs-smoke-${process.pid}.sqlite`);

// Собрать фейковый WB-JWT (подпись не проверяется — важен только payload).
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeWbToken({ bits, acc = 1, days = 365 }) {
  let s = 0; for (const b of bits) s += 2 ** b;
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = { s, acc, sid: '11111111-2222-3333-4444-555555555555', exp, t: false };
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}
const GOOD_TOKEN = fakeWbToken({ bits: [1, 4, 5] });        // Контент+Маркетплейс+Статистика
const BAD_TOKEN = fakeWbToken({ bits: [1, 4] });            // без Статистики

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

  // ── Фаза 1: организация, кабинет+токен WB, права, приглашения ───────────────
  cookie = '';
  const email2 = `phase1_${Date.now()}@example.com`;
  r = await req('GET', '/register');
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email: email2, password: 'supersecret1', name: 'Фаза1' }));
  ok(r.status === 302, 'Ф1: регистрация владельца');

  r = await req('GET', '/');
  const orgId = (r.text.match(/href="\/org\/(\d+)"/) || [])[1];
  ok(!!orgId, 'Ф1: на главной есть ссылка на организацию');
  ok(r.text.includes('Создать компанию'), 'Ф1: на главной есть форма создания компании');

  // Создание доп. компании из интерфейса (на случай, если у пользователя её нет).
  const csrfHome = csrfOf(r.text);
  r = await req('POST', '/company', form({ _csrf: csrfHome, company: 'Вторая компания' }));
  ok(r.status === 302 && /\/org\/\d+/.test(r.location || ''), 'Ф1: создание компании → редирект на её страницу');
  r = await req('GET', r.location);
  ok(r.status === 200 && r.text.includes('Вторая компания'), 'Ф1: новая компания открывается');

  r = await req('GET', `/org/${orgId}`);
  const csrfOrg = csrfOf(r.text);
  ok(r.status === 200 && r.text.includes('Настройка компании') && r.text.includes('Участники'), 'Ф1: страница компании (настройка + участники)');

  // Плохой токен (без Статистики) → 400 с упоминанием категории.
  r = await req('POST', `/org/${orgId}/cabinet`, form({ _csrf: csrfOrg, company: 'Тест', token: BAD_TOKEN }));
  ok(r.status === 400 && r.text.includes('Статистика'), 'Ф1: токен без Статистики отклонён (400)');

  // Настройка компании: имя + валидный токен → создаётся единственный кабинет.
  r = await req('POST', `/org/${orgId}/cabinet`, form({ _csrf: csrfOrg, company: 'Тест-компания', token: GOOD_TOKEN }));
  ok(r.status === 200 && r.text.includes('сохранён'), 'Ф1: валидный токен принят, компания настроена');
  ok(r.text.includes('Тест-компания') && r.text.includes('подключён'), 'Ф1: кабинет подключён, имя компании применено');
  ok(!r.text.includes(GOOD_TOKEN), 'Ф1: токен НЕ отображается на странице');

  // Настройка одноразовая: форма настройки исчезла, есть «Обновить токен».
  ok(!r.text.includes('Настройка компании') && r.text.includes('Обновить токен'), 'Ф1: форма настройки скрыта, есть обновление токена');

  // Приглашение конкретного email → PRG-редирект, ссылка на странице организации.
  const inviteeEmail = `invitee_${Date.now()}@example.com`;
  r = await req('POST', `/org/${orgId}/invite`, form({ _csrf: csrfOrg, email: inviteeEmail }));
  ok(r.status === 302 && r.location === `/org/${orgId}`, 'Ф1: приглашение → 302 на организацию (PRG)');
  r = await req('GET', `/org/${orgId}`);
  const inviteTok = (r.text.match(/\/invite\/([A-Za-z0-9_-]{10,})/) || [])[1];
  ok(!!inviteTok && r.text.includes('создана'), 'Ф1: кликабельная ссылка-приглашение на странице');

  // Строгая привязка: ЧУЖОЙ email принять не может.
  cookie = '';
  const wrongEmail = `wrong_${Date.now()}@example.com`;
  r = await req('GET', '/register');
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email: wrongEmail, password: 'supersecret1', name: 'Чужой' }));
  r = await req('GET', `/invite/${inviteTok}`);
  ok(r.status === 200 && r.text.includes('Другой аккаунт'), 'Ф1: чужой email видит «Другой аккаунт»');
  r = await req('POST', `/invite/${inviteTok}/accept`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 403, 'Ф1: чужой email не может принять (403)');

  // Правильный email принимает и попадает в организацию.
  cookie = '';
  r = await req('GET', '/register');
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email: inviteeEmail, password: 'supersecret1', name: 'Гость' }));
  r = await req('GET', `/invite/${inviteTok}`);
  ok(r.status === 200 && r.text.includes('Принять приглашение'), 'Ф1: нужный email видит приём приглашения');
  r = await req('POST', `/invite/${inviteTok}/accept`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 302 && r.location === `/org/${orgId}`, 'Ф1: приглашение принято → организация');
  r = await req('GET', `/org/${orgId}`);
  ok(r.status === 200 && r.text.includes('Гость'), 'Ф1: приглашённый видит компанию как участник');
  // Участник НЕ видит поля токена и формы приглашений (проверяем сами контролы).
  ok(!r.text.includes('name="token"') && !r.text.includes('id="invemail"'), 'Ф1: участник не видит токен/приглашения');
  // Участник НЕ может приглашать (owner-only) → 403.
  const csrfMember = csrfOf(r.text);
  r = await req('POST', `/org/${orgId}/invite`, form({ _csrf: csrfMember, email: `nope_${Date.now()}@example.com` }));
  ok(r.status === 403, 'Ф1: участник не может приглашать (403)');

  // Лицензия: у владельца 3 места, занято 2 → одно ещё можно, следующее — нет.
  cookie = '';
  r = await req('GET', '/login');
  r = await req('POST', '/login', form({ _csrf: csrfOf(r.text), email: email2, password: 'supersecret1' }));
  r = await req('GET', `/org/${orgId}`);
  const csrfOwner = csrfOf(r.text);
  r = await req('POST', `/org/${orgId}/invite`, form({ _csrf: csrfOwner, email: `seat3_${Date.now()}@example.com` }));
  ok(r.status === 302, 'Ф1: 3-е место — приглашение проходит');
  r = await req('POST', `/org/${orgId}/invite`, form({ _csrf: csrfOwner, email: `seat4_${Date.now()}@example.com` }));
  ok(r.status === 403 && r.text.includes('Лимит мест'), 'Ф1: сверх лицензии — приглашение отклонено (403)');

  // Место держит неиспользованное приглашение: отзыв освобождает место.
  r = await req('GET', `/org/${orgId}`);
  ok(/приглашений\s*<?\/?b?>?\s*1/.test(r.text) || r.text.includes('приглашений 1'), 'Ф1: видно, что место держит приглашение');
  const revokeId = (r.text.match(/\/invite\/(\d+)\/revoke/) || [])[1];
  r = await req('POST', `/org/${orgId}/invite/${revokeId}/revoke`, form({ _csrf: csrfOwner }));
  ok(r.status === 200, 'Ф1: приглашение отозвано');
  r = await req('POST', `/org/${orgId}/invite`, form({ _csrf: csrfOwner, email: `freed_${Date.now()}@example.com` }));
  ok(r.status === 302, 'Ф1: после отзыва место освободилось — приглашение снова проходит');

  // Доступ: чужая/несуществующая компания → 404.
  r = await req('GET', `/org/${Number(orgId) + 99999}`);
  ok(r.status === 404, 'Ф1: чужая компания недоступна (404)');

  // Изоляция: посторонний (владелец своей компании) НЕ видит чужую и не входит в /admin.
  cookie = '';
  r = await req('GET', '/register');
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email: `outsider_${Date.now()}@example.com`, password: 'supersecret1', name: 'Посторонний' }));
  r = await req('GET', `/org/${orgId}`);
  ok(r.status === 404, 'Ф1: посторонний не видит чужую компанию (404)');
  r = await req('GET', '/');
  ok(!r.text.includes(`/org/${orgId}"`), 'Ф1: чужая компания не показана на главной постороннего');
  r = await req('GET', '/admin');
  ok(r.status === 403, 'Ф1: посторонний не видит панель супер-админа (403)');
  cookie = '';
  r = await req('GET', '/register');
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email: 'super@example.com', password: 'supersecret1', name: 'Админ' }));
  r = await req('GET', '/admin');
  const csrfAdmin = csrfOf(r.text);
  ok(r.status === 200 && r.text.includes('Панель супер-админа') && r.text.includes('Пользователи'), 'Ф1: супер-админ видит панель (компании + пользователи)');
  r = await req('POST', `/admin/org/${orgId}/seats`, form({ _csrf: csrfAdmin, seats: '5' }));
  ok(r.status === 302, 'Ф1: супер-админ меняет число мест');
  r = await req('POST', `/admin/org/${orgId}/rename`, form({ _csrf: csrfAdmin, name: 'Переимен-супером' }));
  r = await req('GET', '/admin');
  ok(r.text.includes('Переимен-супером'), 'Ф1: супер-админ переименовал компанию');
  const delUserId = (r.text.match(/\/admin\/user\/(\d+)\/delete/) || [])[1];
  r = await req('POST', `/admin/user/${delUserId}/delete`, form({ _csrf: csrfAdmin }));
  ok(r.status === 302, 'Ф1: супер-админ полностью удалил пользователя');
} catch (e) {
  console.error('Ошибка теста:', e); failed++;
} finally {
  server.close();
  try { fs.rmSync(process.env.DB_PATH, { force: true }); fs.rmSync(process.env.DB_PATH + '-wal', { force: true }); fs.rmSync(process.env.DB_PATH + '-shm', { force: true }); } catch { /* */ }
}
process.stdout.write(failed ? `\n${failed} проверок упало\n` : '\nВсе проверки зелёные\n');
process.exit(failed ? 1 : 0);
