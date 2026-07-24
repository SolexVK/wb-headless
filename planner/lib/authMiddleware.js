// authMiddleware.js — установка Telegram-авторизации и контроля доступа на Express-app.
//
// Модель доступа (жёсткая привязка к Telegram-аккаунту):
//   1. Вход только через Telegram Login Widget → подпись проверяется HMAC (auth.js).
//   2. Пускаем ТОЛЬКО аккаунты из allowlist (таблица users): status=active и не просрочен.
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
//
// Если TELEGRAM_BOT_TOKEN не задан — авторизация ВЫКЛЮЧЕНА (как раньше, открытый доступ
// для локальной сети). Так локальная разработка не ломается.

import crypto from 'crypto';
import {
  dbAvailable, metaGet, metaSet,
  userGet, userList, userUpsert, userSetStatus, userSetExpiry, userDelete, userMarkLogin,
} from './db.js';
import { verifyTelegramAuth, verifySession, signSession, newSessionId } from './auth.js';

const COOKIE = 'planner_session';
const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 дней

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
export function installAuth(app) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
  const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID) || 0;
  const SECRET = resolveSessionSecret();

  // Владелец всегда админ с бессрочным доступом (bootstrap при старте).
  if (OWNER_ID && dbAvailable()) {
    userUpsert({ telegramId: OWNER_ID, isAdmin: 1, status: 'active', note: 'owner' });
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

  // Публичные пути (без входа): страница логина, health, сам callback авторизации.
  const PUBLIC_EXACT = new Set(['/login', '/login.html', '/api/health', '/auth/telegram', '/api/me']);
  const isPublic = (p) => PUBLIC_EXACT.has(p) || p.startsWith('/styles') || p === '/favicon.ico';

  // ── Callback Telegram Login Widget: проверка подписи → allowlist → сессия ──
  app.get('/auth/telegram', (req, res) => {
    const data = { ...req.query };
    if (!verifyTelegramAuth(data, BOT_TOKEN)) {
      return res.status(401).send(loginRedirect('bad_signature'));
    }
    const tid = Number(data.id);
    let user = userGet(tid);
    // Владелец может войти всегда (на случай пустого allowlist).
    if (!user && tid === OWNER_ID) { userUpsert({ telegramId: tid, isAdmin: 1, status: 'active', note: 'owner' }); user = userGet(tid); }
    const denial = accessDenial(user);
    if (denial) {
      // Регистрируем «ожидающего»: создаём заблокированную запись, чтобы админ видел заявку.
      if (!user) {
        userUpsert({
          telegramId: tid,
          username: data.username || null,
          name: [data.first_name, data.last_name].filter(Boolean).join(' ') || null,
          photoUrl: data.photo_url || null,
          status: 'blocked', isAdmin: 0, note: 'заявка на доступ',
        });
      }
      return res.status(403).send(deniedPage(denial, tid, data.username));
    }
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

  app.post('/auth/logout', (req, res) => {
    const u = currentUser(req);
    if (u) userMarkLogin(u.telegramId, {}, null); // сбрасываем activeSession
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Кто я (для фронта: показать имя, признак админа).
  app.get('/api/me', (req, res) => {
    const u = currentUser(req);
    // botUsername нужен странице логина ДО входа (для виджета Telegram) — отдаём всегда.
    if (!u) return res.json({ authEnabled: true, user: null, botUsername: BOT_USERNAME });
    res.json({
      authEnabled: true,
      user: {
        telegramId: u.telegramId, username: u.username, name: u.name, photoUrl: u.photoUrl,
        isAdmin: !!u.isAdmin, expiresAt: u.expiresAt || null,
      },
      botUsername: BOT_USERNAME,
    });
  });

  // ── Guard: всё остальное требует активной сессии ──
  app.use((req, res, next) => {
    if (isPublic(req.path)) return next();
    const u = currentUser(req);
    if (!u) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'auth_required' });
      return res.redirect('/login');
    }
    req.user = u;
    next();
  });

  // ── Админ-роуты: управление allowlist. Только isAdmin. ──
  const adminOnly = (req, res, next) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ ok: false, error: 'admin_only' });
    next();
  };
  app.get('/api/admin/users', adminOnly, (req, res) => {
    res.json({ ok: true, users: userList(), ownerId: OWNER_ID });
  });
  // Выдать/обновить доступ: { telegramId, status?, isAdmin?, expiresAt?, note?, name?, username? }
  app.post('/api/admin/users', adminOnly, (req, res) => {
    const b = req.body || {};
    const tid = Number(b.telegramId);
    if (!tid) return res.status(400).json({ ok: false, error: 'нужен числовой telegramId' });
    userUpsert({
      telegramId: tid,
      status: b.status || 'active',
      isAdmin: b.isAdmin ? 1 : 0,
      expiresAt: b.expiresAt || null,
      note: b.note ?? null,
      name: b.name ?? null,
      username: b.username ?? null,
    });
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
