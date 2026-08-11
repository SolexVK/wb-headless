// GetCourse Downloader — web server.
// Express app that drives the download engine, with account-based access,
// subscription gating, a directory picker and live job progress over SSE.
//
// Binds to 127.0.0.1 by default; expose it with `tailscale serve` (see
// scripts/tailscale-serve.sh) so it gets an HTTPS URL with a friendly name
// inside your tailnet (or `tailscale funnel` for public access).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
  ensureAdminSeed, findUser, verifyPassword, createUser, createSession, destroySession,
  currentUser, requireAuth, requireAdmin, requireSubscription, hasActiveSubscription, publicUser,
} from './lib/auth.mjs';
import { db } from './lib/db.mjs';
import { createJob, cancelJob, subscribe, listJobs, getJob } from './lib/jobs.mjs';
import { listDir, createDir, resolveWritableOutput, ROOT } from './lib/fsbrowse.mjs';

// load .env from the getcourse root
const here = path.dirname(fileURLToPath(import.meta.url));
for (const p of [path.join(here, '..', '.env')]) {
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) {
      let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

ensureAdminSeed();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { const u = currentUser(req); if (u) req.user = u; next(); });

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = findUser(username);
  if (!u || !verifyPassword(String(password || ''), u.salt, u.hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
  }
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
});
app.post('/api/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user), browseRoot: ROOT }));

// ---------- billing (subscription) ----------
// Minimal license-key redemption so paid access works today; a real payment
// provider (Stripe / ЮKassa) can later flip subscription.active via a webhook.
app.get('/api/billing/info', requireAuth, (req, res) => {
  res.json({
    active: hasActiveSubscription(req.user),
    subscription: req.user.subscription,
    priceNote: process.env.GCUI_PRICE_NOTE || 'Доступ по подписке. Ключ выдаёт администратор.',
  });
});
app.post('/api/billing/redeem', requireAuth, (req, res) => {
  const keys = (process.env.GCUI_LICENSE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  const { code } = req.body || {};
  if (!code || !keys.includes(String(code))) return res.status(400).json({ error: 'invalid_code', message: 'Неверный ключ' });
  const days = +(process.env.GCUI_LICENSE_DAYS || 30);
  const expires = new Date(Date.now() + days * 864e5).toISOString();
  req.user.subscription = { active: true, expires };
  db.save();
  res.json({ ok: true, subscription: req.user.subscription });
});

// ---------- admin ----------
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, role, subscriptionActive } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing', message: 'нужны логин и пароль' });
    const u = createUser({ username, password, role: role === 'admin' ? 'admin' : 'user', subscriptionActive: !!subscriptionActive });
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: 'create_failed', message: e.message }); }
});
app.post('/api/admin/users/:id/subscription', requireAuth, requireAdmin, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const { active, expires } = req.body || {};
  u.subscription = { active: !!active, expires: expires || null };
  db.save();
  res.json({ user: publicUser(u) });
});
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'self', message: 'нельзя удалить себя' });
  const i = db.users.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not_found' });
  db.users.splice(i, 1); db.save();
  res.json({ ok: true });
});

// ---------- filesystem browser ----------
app.get('/api/fs/list', requireAuth, (req, res) => {
  try { res.json(listDir(req.query.path || '.')); }
  catch (e) { res.status(400).json({ error: 'fs', message: e.message }); }
});
app.post('/api/fs/mkdir', requireAuth, (req, res) => {
  try { res.json(createDir(req.body?.path || '.', req.body?.name)); }
  catch (e) { res.status(400).json({ error: 'fs', message: e.message }); }
});

// ---------- jobs ----------
app.get('/api/jobs', requireAuth, (req, res) => res.json({ jobs: listJobs(req.user) }));
app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const j = getJob(req.params.id, req.user);
  if (!j) return res.status(404).json({ error: 'not_found' });
  res.json({ job: j });
});
app.post('/api/jobs', requireAuth, requireSubscription, (req, res) => {
  try {
    const { email, password, startUrl, output, concurrency, limit } = req.body || {};
    const outAbs = resolveWritableOutput(output);
    const job = createJob(req.user, {
      email, password, startUrl,
      output: outAbs,
      concurrency: Math.min(20, Math.max(1, +concurrency || 10)),
      limit: Math.max(0, +limit || 0),
    });
    res.json({ job });
  } catch (e) { res.status(400).json({ error: 'job_failed', message: e.message }); }
});
app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => {
  res.json({ ok: cancelJob(req.params.id, req.user) });
});
app.get('/api/jobs/:id/events', requireAuth, (req, res) => subscribe(req.params.id, res, req.user));

// ---------- static frontend ----------
app.use(express.static(path.join(here, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(here, 'public', 'index.html')));

const PORT = +(process.env.GCUI_PORT || 7837);
const HOST = process.env.GCUI_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`GetCourse Downloader UI: http://${HOST}:${PORT}`);
  console.log(`Каталог для выбора папок ограничен: ${ROOT}`);
});
