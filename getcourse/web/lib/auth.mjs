// Authentication: scrypt password hashing, server-side sessions via an
// httpOnly cookie, and Express middleware for auth / subscription / admin gates.
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { cfg } from './config.mjs';

const COOKIE = 'gc_sess';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}

export function findUser(username) {
  return db.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
}
export function findByEmail(email) {
  const e = String(email || '').toLowerCase();
  return db.users.find(u => (u.email || u.username || '').toLowerCase() === e);
}
export function findByGoogleId(googleId) {
  return db.users.find(u => u.googleId === googleId);
}

export function createUser({ username, password, role = 'user', subscriptionActive = false, localAccess, email, provider = 'local', googleId }) {
  if (findUser(username)) throw new Error('пользователь уже существует');
  const rec = {
    id: crypto.randomUUID(),
    username,
    email: email || username,
    provider,               // 'local' | 'google'
    googleId: googleId || null,
    role,                   // 'admin' | 'user'
    // localAccess: may browse and save into the Mac Mini's own folders.
    // Only the owner/admin gets this; regular subscribers use delivery mode and
    // never see the server's filesystem.
    localAccess: localAccess === undefined ? role === 'admin' : !!localAccess,
    subscription: { active: !!subscriptionActive, expires: null },
    createdAt: new Date().toISOString(),
  };
  if (password) { const { salt, hash } = hashPassword(password); rec.salt = salt; rec.hash = hash; }
  db.users.push(rec);
  db.save();
  return rec;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Grant / extend an active subscription for N days (0/undefined = indefinite).
export function grantLicense(user, days) {
  const expires = days ? new Date(Date.now() + days * 864e5).toISOString() : null;
  user.subscription = { active: true, expires };
  db.save();
  return user.subscription;
}

// Public self-registration. Auto-grants a license for now (see cfg.signupLicenseDays).
export function registerUser({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('Введите корректный email');
  if (!password || String(password).length < 6) throw new Error('Пароль не короче 6 символов');
  if (findByEmail(email) || findUser(email)) throw new Error('Пользователь с таким email уже есть');
  const user = createUser({ username: email, email, password, role: 'user', localAccess: false });
  if (cfg.signupLicenseDays) grantLicense(user, cfg.signupLicenseDays);
  return user;
}

// Find-or-create a user from a verified Google profile (auto-license too).
export function upsertGoogleUser({ googleId, email }) {
  email = String(email || '').trim().toLowerCase();
  let user = findByGoogleId(googleId) || (email && findByEmail(email));
  if (user) {
    if (!user.googleId) { user.googleId = googleId; user.provider = user.provider || 'google'; db.save(); }
    return user;
  }
  user = createUser({ username: email, email, role: 'user', localAccess: false, provider: 'google', googleId });
  if (cfg.signupLicenseDays) grantLicense(user, cfg.signupLicenseDays);
  return user;
}

export function setPassword(user, newPassword) {
  if (!newPassword || String(newPassword).length < 6) throw new Error('Пароль не короче 6 символов');
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt; user.hash = hash; db.save();
}

// --- password reset tokens ---
export function createReset(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const arr = db.resets; // one active reset per user
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].userId === user.id) arr.splice(i, 1);
  arr.push({ token, userId: user.id, email: user.email || user.username, expires: Date.now() + RESET_TTL_MS, used: false, createdAt: new Date().toISOString() });
  db.save();
  return token;
}
export function peekReset(token) {
  const r = db.resets.find(r => r.token === token);
  if (!r || r.used || r.expires < Date.now()) return null;
  return r;
}
export function consumeReset(token, newPassword) {
  const r = peekReset(token);
  if (!r) throw new Error('Ссылка недействительна или истекла');
  const user = db.users.find(u => u.id === r.userId);
  if (!user) throw new Error('Пользователь не найден');
  setPassword(user, newPassword);
  r.used = true; db.save();
  return user;
}

// Seed an admin account from env on first boot if there are no users yet.
export function ensureAdminSeed() {
  if (db.users.length) return;
  const username = process.env.GCUI_ADMIN_USER || 'admin';
  const password = process.env.GCUI_ADMIN_PASS || crypto.randomBytes(6).toString('base64url');
  createUser({ username, password, role: 'admin', subscriptionActive: true });
  console.log('╭───────────────────────────────────────────────');
  console.log('│ Создан администратор:');
  console.log(`│   логин:  ${username}`);
  console.log(`│   пароль: ${password}`);
  console.log('│ (задаётся через GCUI_ADMIN_USER / GCUI_ADMIN_PASS)');
  console.log('╰───────────────────────────────────────────────');
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId, expires: Date.now() + SESSION_TTL_MS });
  db.save();
  const secure = process.env.GCUI_COOKIE_INSECURE ? '' : ' Secure;';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)};${secure}`);
}

export function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) {
    const i = db.sessions.findIndex(s => s.token === token);
    if (i > -1) { db.sessions.splice(i, 1); db.save(); }
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0;`);
}

export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = db.sessions.find(s => s.token === token);
  if (!s) return null;
  if (s.expires < Date.now()) return null;
  return db.users.find(u => u.id === s.userId) || null;
}

export function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = u;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

export function hasActiveSubscription(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const sub = user.subscription || {};
  if (!sub.active) return false;
  if (sub.expires && new Date(sub.expires).getTime() < Date.now()) return false;
  return true;
}

export function requireSubscription(req, res, next) {
  if (!hasActiveSubscription(req.user)) {
    return res.status(402).json({ error: 'subscription_required', message: 'Требуется активная подписка' });
  }
  next();
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, email: u.email || u.username, provider: u.provider || 'local', role: u.role,
    localAccess: u.localAccess === undefined ? u.role === 'admin' : !!u.localAccess,
    subscription: u.subscription, active: hasActiveSubscription(u), createdAt: u.createdAt,
  };
}
