// authMiddleware.js — установка Telegram-авторизации и контроля доступа на Express-app.
//
// Модель доступа (жёсткая привязка к Telegram-аккаунту):
//   1. Вход только через Telegram Login Widget → подпись проверяется HMAC (auth.js).
//   2. Пускаем ТОЛЬКО аккаунты из allowlist (таблица users): status=active и не просрочен.
//      Незнакомый аккаунт попадает в allowlist ОДНИМ способом — по ссылке-приглашению
//      с кодом (INVITE_STAFF_CODE / INVITE_GUEST_CODE). Без кода — отказ: «сам себя»
//      зарегистрировать нельзя, сколько бы аккаунтов Telegram человек ни завёл.
//   3. Сессия — подписанный cookie; в нём tid + sid. sid сверяется с users.activeSession,
//      поэтому активна ОДНА сессия на аккаунт (новый вход вытесняет старый).
//   4. Права/статус/срок проверяются по БД на КАЖДОМ запросе → мгновенный отзыв.
//   5. Выдавать доступ может только админ (страница /admin, роуты /api/admin/*).
//
// Конфигурация (planner/data/.env):
//   TELEGRAM_BOT_TOKEN     — секрет бота из @BotFather (включает авторизацию)
//   TELEGRAM_BOT_USERNAME  — имя бота без @ (для виджета входа)
//   OWNER_TELEGRAM_ID      — числовой Telegram-id владельца (сеется как админ)
//   SESSION_SECRET         — секрет подписи сессий (если пуст — генерируем и храним в БД)
//   INVITE_STAFF_CODE      — код приглашения для сотрудников: /login?i=КОД → роль staff
//   INVITE_GUEST_CODE      — код гостевой ссылки: /login?i=КОД → роль guest (демо-стенд)
//   Смена кода мгновенно обесценивает старые ссылки; выданный ранее доступ сохраняется.
//
// Если TELEGRAM_BOT_TOKEN не задан — авторизация ВЫКЛЮЧЕНА (как раньше, открытый доступ
// для локальной сети). Так локальная разработка не ломается.

import crypto from 'crypto';
import {
  dbAvailable, metaGet, metaSet,
  userGet, userList, userUpsert, userSetStatus, userSetExpiry, userDelete, userMarkLogin,
  userSetPerms, userSetAccessRequest,
} from './db.js';
import { verifyTelegramAuth, verifySession, signSession, newSessionId } from './auth.js';
import { permsFor, canView, canEdit, TABS, TAB_KEYS, presetTabs } from './permissions.js';

// Мидлвары-гейты для маршрутов server.js. Если авторизация выключена (req.perms нет) —
// пропускаем (локальная сеть). Иначе проверяем право просмотра/редактирования листа.
export function requireView(tab) {
  return (req, res, next) => {
    if (!req.perms) return next();
    if (canView(req.perms, tab)) return next();
    return res.status(403).json({ ok: false, error: 'forbidden', tab });
  };
}
export function requireEdit(tab) {
  return (req, res, next) => {
    if (!req.perms) return next();
    if (canEdit(req.perms, tab)) return next();
    return res.status(403).json({ ok: false, error: 'forbidden', tab });
  };
}

const COOKIE = 'planner_session';
const INVITE_COOKIE = 'planner_invite';
const INVITE_TTL_SEC = 900;             // 15 минут: успеть пройти виджет Telegram
const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 дней
const LEVELS = new Set(['none', 'view', 'edit']);

// Оставить только валидные листы и уровни (защита от мусора в запросе админа).
function sanitizeTabs(tabs) {
  const out = {};
  if (tabs && typeof tabs === 'object') {
    for (const k of TAB_KEYS) {
      const v = tabs[k];
      if (LEVELS.has(v)) out[k] = v;
    }
  }
  return out;
}

// ── cookie helpers (без внешних зависимостей) ──
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (isHttps(req)) parts.push('Secure'); // за Tailscale Funnel — всегда HTTPS
  res.append('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
// Код приглашения кладём в короткоживущий cookie на странице входа: виджет Telegram
// уводит человека на telegram.org и возвращает на /auth/telegram уже без наших параметров.
function setInviteCookie(req, res, code) {
  const parts = [
    `${INVITE_COOKIE}=${encodeURIComponent(code)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${INVITE_TTL_SEC}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearInviteCookie(res) {
  res.append('Set-Cookie', `${INVITE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── секрет подписи сессий: env → БД(meta) → сгенерировать и сохранить ──
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (dbAvailable()) {
    const row = metaGet('session_secret');
    if (row && row.value) return row.value;
    const gen = crypto.randomBytes(32).toString('hex');
    metaSet('session_secret', gen);
    return gen;
  }
  // Без БД и без env — эфемерный секрет (сессии живут до перезапуска).
  return crypto.randomBytes(32).toString('hex');
}

// Статус пользователя: причина отказа или null, если доступ есть.
function accessDenial(user) {
  if (!user) return 'not_allowed';
  if (user.status === 'blocked') return 'blocked';
  if (user.expiresAt && Date.now() > Date.parse(user.expiresAt)) return 'expired';
  return null;
}

/**
 * Установить авторизацию на app. Возвращает { enabled }.
 * publicPaths — пути/префиксы, доступные без входа (страница логина, статика виджета).
 */
// Таймингобезопасное сравнение строк (защита от подбора по времени ответа).
function safeEqualStr(a, b) {
  const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

export function installAuth(app) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
  const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID) || 0;
  const SECRET = resolveSessionSecret();
  // Резервный вход по секретному коду (для регионов, где Telegram-виджет не грузится).
  // Задаётся в planner/data/.env как PLANNER_LOGIN_CODE=... — входит КАК ВЛАДЕЛЕЦ (admin).
  const LOGIN_CODE = (process.env.PLANNER_LOGIN_CODE || '').trim();
  let codeFails = 0, codeLockUntil = 0; // простой троттлинг перебора

  // Коды приглашений: единственный способ попасть в allowlist без участия админа.
  const INVITES = [
    { code: (process.env.INVITE_STAFF_CODE || '').trim(), role: 'staff', label: 'сотрудник' },
    { code: (process.env.INVITE_GUEST_CODE || '').trim(), role: 'guest', label: 'гость' },
  ].filter((i) => i.code.length >= 8); // короткий код = подбираемый, такой не принимаем
  const matchInvite = (raw) => {
    const v = String(raw || '').trim();
    if (!v) return null;
    return INVITES.find((i) => safeEqualStr(v, i.code)) || null;
  };

  // Уведомление владельцу в личку бота (HTTPS-API — исходящий SMTP у netcup закрыт).
  // Тихое: любая ошибка отправки не должна ломать вход пользователя.
  const notifyOwner = (text) => {
    if (!BOT_TOKEN || !OWNER_ID) return;
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => { /* не критично */ });
  };

  // Владелец всегда админ с бессрочным доступом (bootstrap при старте).
  if (OWNER_ID && dbAvailable()) {
    userUpsert({ telegramId: OWNER_ID, isAdmin: 1, role: 'admin', status: 'active', note: 'owner' });
  }

  if (!BOT_TOKEN) {
    console.log('[planner] Telegram-авторизация ВЫКЛЮЧЕНА (нет TELEGRAM_BOT_TOKEN). Доступ открыт — только для локальной сети.');
    // Совместимость: req.user отсутствует, но эндпоинты работают.
    app.get('/api/me', (req, res) => res.json({ authEnabled: false, user: null }));
    return { enabled: false };
  }
  if (!dbAvailable()) {
    console.log('[planner] ВНИМАНИЕ: Telegram-токен задан, но БД недоступна — allowlist работать не будет. Авторизация не включена.');
    app.get('/api/me', (req, res) => res.json({ authEnabled: false, user: null, warning: 'no-db' }));
    return { enabled: false };
  }

  console.log(`[planner] Telegram-авторизация ВКЛЮЧЕНА (бот @${BOT_USERNAME || '?'}${OWNER_ID ? ', владелец ' + OWNER_ID : ''}).`);

  // Достать текущего пользователя из cookie (null, если нет/невалиден).
  function currentUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const payload = verifySession(token, SECRET);
    if (!payload || !payload.tid) return null;
    const user = userGet(payload.tid);
    if (!user) return null;
    if (accessDenial(user)) return null;
    // одна активная сессия на аккаунт: sid должен совпадать
    if (user.activeSession && payload.sid !== user.activeSession) return null;
    return user;
  }

  // Ссылка-приглашение вида /login?i=КОД — код запоминаем в cookie и отдаём страницу
  // дальше по цепочке (её рисует server.js). Сам код в адресной строке не оставляем.
  app.get(['/login', '/login.html'], (req, res, next) => {
    const code = String(req.query.i || '').trim();
    if (!code) return next();
    setInviteCookie(req, res, code);
    return res.redirect('/login');
  });

  // Публичные пути (без входа): страница логина, health, сам callback авторизации.
  const PUBLIC_EXACT = new Set(['/login', '/login.html', '/api/health', '/auth/telegram', '/auth/code', '/api/me']);
  const isPublic = (p) => PUBLIC_EXACT.has(p) || p.startsWith('/styles') || p === '/favicon.ico';

  // ── Callback Telegram Login Widget: проверка подписи → allowlist → сессия ──
  app.get('/auth/telegram', (req, res) => {
    const data = { ...req.query };
    if (!verifyTelegramAuth(data, BOT_TOKEN)) {
      return res.status(401).send(loginRedirect('bad_signature'));
    }
    const tid = Number(data.id);
    let user = userGet(tid);
    const profile = {
      username: data.username || null,
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || null,
      photoUrl: data.photo_url || null,
    };
    // Владелец может войти всегда (на случай пустого allowlist).
    if (!user && tid === OWNER_ID) { userUpsert({ telegramId: tid, isAdmin: 1, role: 'admin', status: 'active', note: 'owner' }); user = userGet(tid); }
    // Незнакомый аккаунт принимаем ТОЛЬКО по действующему коду приглашения.
    // Права выдаются пресетом роли, зашитым в код: сотрудник или гость.
    if (!user) {
      const invite = matchInvite(parseCookies(req)[INVITE_COOKIE]);
      if (!invite) {
        clearInviteCookie(res);
        return res.status(403).send(deniedPage('not_allowed', tid, data.username));
      }
      userUpsert({
        telegramId: tid, ...profile,
        status: 'active', isAdmin: 0, role: invite.role,
        perms: { tabs: presetTabs(invite.role) },
        note: `по приглашению (${invite.label})`,
      });
      user = userGet(tid);
      const who = [profile.name, profile.username ? '@' + profile.username : null]
        .filter(Boolean).join(' ') || 'без имени';
      notifyOwner(`👤 Новый вход в planner\nРоль: ${invite.label}\n${who}\nTelegram-ID: ${tid}\n\nПрава можно изменить: /admin`);
    }
    clearInviteCookie(res);
    const denial = accessDenial(user); // теперь блокирует только явно blocked/expired
    if (denial) return res.status(403).send(deniedPage(denial, tid, data.username));
    // Успех: ротируем сессию (вытесняем прочие), пишем профиль, ставим cookie.
    const sid = newSessionId();
    userMarkLogin(tid, {
      username: data.username || null,
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || null,
      photoUrl: data.photo_url || null,
    }, sid);
    const token = signSession({ tid, sid, iat: Math.floor(Date.now() / 1000) }, SECRET);
    setSessionCookie(req, res, token);
    res.redirect('/');
  });

  // ── Резервный вход по секретному коду (без Telegram): выдаёт сессию ВЛАДЕЛЬЦА ──
  app.post('/auth/code', (req, res) => {
    if (!LOGIN_CODE) return res.status(404).json({ ok: false, error: 'вход по коду не настроен' });
    if (!OWNER_ID) return res.status(500).json({ ok: false, error: 'не задан OWNER_TELEGRAM_ID' });
    const now = Date.now();
    if (now < codeLockUntil) return res.status(429).json({ ok: false, error: 'слишком много попыток — подождите минуту' });
    const code = String((req.body && req.body.code) || '');
    if (!safeEqualStr(code, LOGIN_CODE)) {
      codeFails += 1;
      if (codeFails >= 5) { codeLockUntil = now + 60000; codeFails = 0; }
      return res.status(401).json({ ok: false, error: 'неверный код' });
    }
    codeFails = 0;
    // вход как владелец: гарантируем аккаунт-владельца, выдаём сессию (ротация вытесняет прочие)
    let user = userGet(OWNER_ID);
    if (!user) { userUpsert({ telegramId: OWNER_ID, isAdmin: 1, role: 'admin', status: 'active', note: 'owner' }); user = userGet(OWNER_ID); }
    const sid = newSessionId();
    userMarkLogin(OWNER_ID, { name: (user && user.name) || 'Владелец' }, sid);
    const token = signSession({ tid: OWNER_ID, sid, iat: Math.floor(now / 1000) }, SECRET);
    setSessionCookie(req, res, token);
    res.json({ ok: true });
  });

  app.post('/auth/logout', (req, res) => {
    const u = currentUser(req);
    if (u) userMarkLogin(u.telegramId, {}, null); // сбрасываем activeSession
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Кто я (для фронта: показать имя, признак админа, карту прав по листам).
  app.get('/api/me', (req, res) => {
    const u = currentUser(req);
    // botUsername нужен странице логина ДО входа (для виджета Telegram) — отдаём всегда.
    if (!u) return res.json({ authEnabled: true, user: null, botUsername: BOT_USERNAME, codeLogin: !!LOGIN_CODE });
    const perms = permsFor(u);
    res.json({
      authEnabled: true,
      user: {
        telegramId: u.telegramId, username: u.username, name: u.name, photoUrl: u.photoUrl,
        isAdmin: !!u.isAdmin, role: perms.role, expiresAt: u.expiresAt || null,
      },
      perms: { isAdmin: perms.isAdmin, tabs: perms.tabs },
      tabs: TABS,
      botUsername: BOT_USERNAME,
    });
  });

  // Пользователь просит расширить доступ (заявка админу).
  app.post('/api/access/request', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ ok: false, error: 'auth_required' });
    const msg = String((req.body && req.body.message) || '').slice(0, 500);
    userSetAccessRequest(u.telegramId, msg || 'Запрос доступа');
    res.json({ ok: true });
  });

  // ── Guard: всё остальное требует активной сессии; вычисляем права ──
  app.use((req, res, next) => {
    if (isPublic(req.path)) return next();
    const u = currentUser(req);
    if (!u) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'auth_required' });
      return res.redirect('/login');
    }
    req.user = u;
    req.perms = permsFor(u);
    next();
  });

  // ── Админ-роуты: управление allowlist. Только isAdmin. ──
  const adminOnly = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ ok: false, error: 'admin_only' });
    next();
  };
  app.get('/api/admin/users', adminOnly, (req, res) => {
    res.json({ ok: true, users: userList(), ownerId: OWNER_ID, tabs: TABS });
  });
  // Выдать/обновить доступ: { telegramId, status?, isAdmin?, role?, perms?, expiresAt?, note?, name?, username? }
  app.post('/api/admin/users', adminOnly, (req, res) => {
    const b = req.body || {};
    const tid = Number(b.telegramId);
    if (!tid) return res.status(400).json({ ok: false, error: 'нужен числовой telegramId' });
    // Роль-пресет заполняет карту прав, если perms не передан явно.
    const role = b.role || 'viewer';
    const perms = b.perms != null ? { tabs: sanitizeTabs(b.perms.tabs || b.perms) } : { tabs: presetTabs(role) };
    userUpsert({
      telegramId: tid,
      status: b.status || 'active',
      isAdmin: b.isAdmin ? 1 : 0,
      role: b.isAdmin ? 'admin' : role,
      perms,
      expiresAt: b.expiresAt || null,
      note: b.note ?? null,
      name: b.name ?? null,
      username: b.username ?? null,
    });
    userSetAccessRequest(tid, null); // выдали доступ — снимаем заявку
    res.json({ ok: true, user: userGet(tid) });
  });
  // Точечно задать роль/права листов: { role?, perms:{tabs:{…}} }
  app.post('/api/admin/users/:id/perms', adminOnly, (req, res) => {
    const tid = Number(req.params.id);
    const b = req.body || {};
    if (tid === OWNER_ID) return res.status(400).json({ ok: false, error: 'права владельца менять нельзя' });
    userSetPerms(tid, b.role || 'custom', { tabs: sanitizeTabs((b.perms && b.perms.tabs) || b.perms || {}) });
    userSetAccessRequest(tid, null);
    res.json({ ok: true, user: userGet(tid) });
  });
  app.post('/api/admin/users/:id/status', adminOnly, (req, res) => {
    const tid = Number(req.params.id);
    const status = (req.body && req.body.status) === 'active' ? 'active' : 'blocked';
    if (tid === OWNER_ID && status !== 'active') return res.status(400).json({ ok: false, error: 'нельзя заблокировать владельца' });
    userSetStatus(tid, status);
    if (status === 'blocked') userMarkLogin(tid, {}, null); // выкинуть активную сессию
    res.json({ ok: true, user: userGet(tid) });
  });
  app.post('/api/admin/users/:id/expiry', adminOnly, (req, res) => {
    userSetExpiry(Number(req.params.id), (req.body && req.body.expiresAt) || null);
    res.json({ ok: true, user: userGet(Number(req.params.id)) });
  });
  app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
    const tid = Number(req.params.id);
    if (tid === OWNER_ID) return res.status(400).json({ ok: false, error: 'нельзя удалить владельца' });
    res.json({ ok: userDelete(tid) });
  });

  return { enabled: true };
}

// Мини-страница «доступ запрещён» с телеграм-id для заявки админу.
function deniedPage(reason, tid, username) {
  const msg = {
    not_allowed: 'Ваш аккаунт не в списке доступа.',
    blocked: 'Доступ заблокирован администратором.',
    expired: 'Срок доступа (подписка) истёк.',
  }[reason] || 'Доступ запрещён.';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Доступ запрещён</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:420px;padding:28px;background:#181b22;border:1px solid #262a33;border-radius:14px;text-align:center}
.id{font-size:22px;font-weight:700;color:#ffd166;margin:12px 0;user-select:all}
a{color:#6ea8fe}</style></head><body><div class="card">
<h2>⛔ ${msg}</h2>
<p>Чтобы получить доступ, передайте администратору ваш Telegram-ID:</p>
<div class="id">${tid}</div>
${username ? `<p>(@${String(username).replace(/[^\w]/g, '')})</p>` : ''}
<p><a href="/login">← Вернуться на страницу входа</a></p>
</div></body></html>`;
}
// Редирект на логин с сообщением об ошибке.
function loginRedirect(err) {
  return `<!doctype html><meta charset="utf-8"><script>location.replace('/login?err=${encodeURIComponent(err)}')</script>`;
}
