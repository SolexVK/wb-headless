// GetCourse Downloader — web server.
// Express app that drives the download engine, with account-based access,
// subscription gating, per-user storage modes, daily quotas and live progress.
//
// Storage modes:
//   - owner/admin (localAccess): browse & save into the Mac Mini's folders;
//   - subscribers: files go to a temporary per-user spool, are downloaded via
//     the browser, count against a daily quota and are auto-deleted after the
//     retention window. Subscribers never see the server filesystem.
//
// Binds to 127.0.0.1 by default; expose with `tailscale funnel` (public) or
// `tailscale serve` (private) — see scripts/tailscale-serve.sh.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureAdminSeed, findUser, verifyPassword, createUser, createSession, destroySession,
  currentUser, requireAuth, requireAdmin, requireSubscription, hasActiveSubscription, publicUser,
} from './lib/auth.mjs';
import { db } from './lib/db.mjs';
import { cfg } from './lib/config.mjs';
import { usageView } from './lib/quota.mjs';
import { createJob, cancelJob, subscribe, listJobs, getJob, getJobFile } from './lib/jobs.mjs';
import { listDir, createDir, resolveWritableOutput, ROOT } from './lib/fsbrowse.mjs';
import { startJanitor } from './lib/janitor.mjs';
import * as yookassa from './lib/billing_yookassa.mjs';

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

// only owner/admin accounts may touch the server filesystem
function requireLocalAccess(req, res, next) {
  if (!req.user || !req.user.localAccess) return res.status(403).json({ error: 'no_local_access', message: 'Обзор папок сервера недоступен' });
  next();
}

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
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: publicUser(req.user),
    browseRoot: req.user.localAccess ? ROOT : null,
    usage: usageView(req.user),
    yookassaEnabled: yookassa.isEnabled(),
  });
});
app.get('/api/usage', requireAuth, (req, res) => res.json(usageView(req.user)));

// ---------- billing ----------
app.get('/api/billing/info', requireAuth, (req, res) => {
  res.json({
    active: hasActiveSubscription(req.user),
    subscription: req.user.subscription,
    priceNote: cfg.priceNote,
    yookassaEnabled: yookassa.isEnabled(),
  });
});
app.post('/api/billing/redeem', requireAuth, (req, res) => {
  const { code } = req.body || {};
  if (!code || !cfg.licenseKeys.includes(String(code))) return res.status(400).json({ error: 'invalid_code', message: 'Неверный ключ' });
  req.user.subscription = { active: true, expires: new Date(Date.now() + cfg.licenseDays * 864e5).toISOString() };
  db.save();
  res.json({ ok: true, subscription: req.user.subscription });
});
// ЮKassa (stubbed until enabled)
app.post('/api/billing/yookassa/create', requireAuth, async (req, res) => {
  try { res.json(await yookassa.createPayment(req.user)); }
  catch (e) { res.status(e.code === 'disabled' ? 503 : 400).json({ error: 'yookassa', message: e.message }); }
});
app.post('/api/billing/yookassa/webhook', (req, res) => {
  const r = yookassa.handleWebhook(req.body);
  res.json(r);
});

// ---------- admin ----------
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => res.json({ users: db.users.map(publicUser) }));
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, role, subscriptionActive, localAccess } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing', message: 'нужны логин и пароль' });
    const u = createUser({ username, password, role: role === 'admin' ? 'admin' : 'user', subscriptionActive: !!subscriptionActive, localAccess: !!localAccess });
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

// ---------- filesystem browser (owner/admin only) ----------
app.get('/api/fs/list', requireAuth, requireLocalAccess, (req, res) => {
  try { res.json(listDir(req.query.path || '.')); }
  catch (e) { res.status(400).json({ error: 'fs', message: e.message }); }
});
app.post('/api/fs/mkdir', requireAuth, requireLocalAccess, (req, res) => {
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
    let outAbs;
    if (req.user.localAccess) outAbs = resolveWritableOutput(output); // save on the Mac Mini
    // delivery users: output is ignored; a per-user spool folder is used
    const job = createJob(req.user, {
      email, password, startUrl, output: outAbs,
      concurrency: Math.min(20, Math.max(1, +concurrency || 10)),
      limit: Math.max(0, +limit || 0),
    });
    res.json({ job });
  } catch (e) { res.status(400).json({ error: 'job_failed', message: e.message }); }
});
app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => res.json({ ok: cancelJob(req.params.id, req.user) }));
app.get('/api/jobs/:id/events', requireAuth, (req, res) => subscribe(req.params.id, res, req.user));

// download a finished delivery file to the user's own computer
app.get('/api/jobs/:id/files/:index/download', requireAuth, (req, res) => {
  const f = getJobFile(req.params.id, req.user, req.params.index);
  if (!f) return res.status(404).json({ error: 'not_found' });
  // refresh mtime so the retention countdown restarts from this download
  try { const now = new Date(); fs.utimesSync(f.absPath, now, now); } catch {}
  res.download(f.absPath, f.filename);
});

// ---------- static frontend ----------
app.use(express.static(path.join(here, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(here, 'public', 'index.html')));

startJanitor(5);
app.listen(cfg.port, cfg.host, () => {
  console.log(`GetCourse Downloader UI: http://${cfg.host}:${cfg.port}`);
  console.log(`Локальный обзор папок ограничен: ${ROOT}`);
  console.log(`Спул доставки: ${cfg.spoolRoot} (хранение ${cfg.retentionMin} мин, лимит ${cfg.dailyGB} ГБ/сут)`);
  console.log(`ЮKassa: ${yookassa.isEnabled() ? 'включена' : 'выключена (заглушка)'}`);
});
