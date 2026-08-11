// Authentication: scrypt password hashing, server-side sessions via an
// httpOnly cookie, and Express middleware for auth / subscription / admin gates.
import crypto from 'node:crypto';
import { db } from './db.mjs';

const COOKIE = 'gc_sess';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

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

export function createUser({ username, password, role = 'user', subscriptionActive = false }) {
  if (findUser(username)) throw new Error('пользователь уже существует');
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username,
    salt, hash,
    role, // 'admin' | 'user'
    subscription: { active: !!subscriptionActive, expires: null },
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  db.save();
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
  return { id: u.id, username: u.username, role: u.role, subscription: u.subscription, active: hasActiveSubscription(u), createdAt: u.createdAt };
}
