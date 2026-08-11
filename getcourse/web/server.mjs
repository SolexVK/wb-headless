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
import './lib/loadenv.mjs'; // MUST be first: load .env before any env-reading module
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureAdminSeed, findUser, findByEmail, verifyPassword, createUser, createSession, destroySession,
  currentUser, requireAuth, requireAdmin, requireSubscription, hasActiveSubscription, publicUser,
  registerUser, upsertGoogleUser, grantLicense, createReset, peekReset, consumeReset, setPassword,
} from './lib/auth.mjs';
import { db } from './lib/db.mjs';
import { cfg } from './lib/config.mjs';
import { usageView } from './lib/quota.mjs';
import { createJob, cancelJob, subscribe, listJobs, getJob, getJobFile, clearHistory } from './lib/jobs.mjs';
import { listDir, createDir, resolveWritableOutput, ROOT } from './lib/fsbrowse.mjs';
import { startJanitor } from './lib/janitor.mjs';
import * as yookassa from './lib/billing_yookassa.mjs';
import * as google from './lib/google.mjs';
import { saveReport, listReports, readReport, unreadCount } from './lib/reports.mjs';
import { saveCreds, credsView, getEmail, getPassword } from './lib/gccreds.mjs';
import { listCourses, courseTree } from './lib/gcbrowse.mjs';

// Resolve GetCourse credentials for an action: use what the client sent, else
// the stored ones. Optionally persist them (remember).
function resolveGc(user, body) {
  const email = (body.email && String(body.email).trim()) || getEmail(user);
  const password = (body.password && String(body.password)) || getPassword(user);
  if (body.remember && (body.email || body.password)) saveCreds(user, { email, password, remember: true });
  else if (body.email !== undefined && !body.password && body.remember) saveCreds(user, { email, remember: true });
  return { email, password };
}

// Public base URL for building OAuth redirect + reset links.
function baseUrl(req) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}

// (.env already loaded by ./lib/loadenv.mjs, imported first above)
const here = path.dirname(fileURLToPath(import.meta.url));

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
  const u = findUser(username) || findByEmail(username);
  if (!u || !u.salt || !u.hash || !verifyPassword(String(password || ''), u.salt, u.hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный логин или пароль' });
  }
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
});
app.post('/api/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  const capabilities = { signup: cfg.allowSignup, google: google.isEnabled() };
  if (!req.user) return res.json({ user: null, capabilities });
  res.json({
    user: publicUser(req.user),
    browseRoot: req.user.localAccess ? ROOT : null,
    usage: usageView(req.user),
    yookassaEnabled: yookassa.isEnabled(),
    gc: credsView(req.user),
    capabilities,
  });
});

// ---------- GetCourse discovery ----------
app.post('/api/gc/creds', requireAuth, (req, res) => {
  const { email, password, remember } = req.body || {};
  saveCreds(req.user, { email, password, remember });
  res.json({ gc: credsView(req.user) });
});
app.post('/api/gc/courses', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { email, password } = resolveGc(req.user, req.body || {});
    if (!email || !password) return res.status(400).json({ error: 'no_creds', message: 'Введите email и пароль GetCourse' });
    const school = (req.body && req.body.school) || email.split('@')[0];
    const courses = await listCourses(email, password, req.body.school || req.body.schoolUrl || school);
    res.json({ courses });
  } catch (e) { res.status(400).json({ error: 'gc_courses', message: e.message }); }
});
app.post('/api/gc/tree', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { email, password } = resolveGc(req.user, req.body || {});
    const { courseUrl } = req.body || {};
    if (!courseUrl) return res.status(400).json({ error: 'no_url', message: 'Не указан курс' });
    if (!email || !password) return res.status(400).json({ error: 'no_creds', message: 'Введите email и пароль GetCourse' });
    const blocks = await courseTree(email, password, courseUrl);
    res.json({ blocks });
  } catch (e) { res.status(400).json({ error: 'gc_tree', message: e.message }); }
});
app.get('/api/usage', requireAuth, (req, res) => res.json(usageView(req.user)));

// ---------- registration & account recovery ----------
app.post('/api/register', (req, res) => {
  if (!cfg.allowSignup) return res.status(403).json({ error: 'signup_disabled', message: 'Регистрация отключена' });
  try {
    const { email, password } = req.body || {};
    const u = registerUser({ email, password });
    createSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: 'register_failed', message: e.message }); }
});

// "Forgot password": always answers 200 (no account enumeration). If SMTP is
// configured we'd email the link; otherwise it's surfaced to the admin panel.
app.post('/api/password/forgot', (req, res) => {
  const { email } = req.body || {};
  const u = findByEmail(email) || findUser(email);
  if (u && u.provider !== 'google') {
    const token = createReset(u);
    const link = `${baseUrl(req)}/?reset=${token}`;
    // TODO: if cfg.smtp.enabled -> send email with `link`. For now the admin
    // relays it (visible in the admin panel).
    if (process.env.GCUI_DEBUG_RESET) console.log('reset link for', u.username, link);
  }
  res.json({ ok: true, message: 'Если аккаунт существует, ссылка для сброса подготовлена. Если письмо не пришло, обратитесь к администратору.' });
});
app.get('/api/password/check', (req, res) => {
  res.json({ valid: !!peekReset(String(req.query.token || '')) });
});
app.post('/api/password/reset', (req, res) => {
  try {
    const { token, password } = req.body || {};
    const u = consumeReset(String(token || ''), String(password || ''));
    createSession(res, u.id);
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: 'reset_failed', message: e.message }); }
});

// ---------- Google OAuth ----------
app.get('/api/auth/google/start', (req, res) => {
  if (!google.isEnabled()) return res.status(404).send('Google вход не настроен');
  res.redirect(google.authUrl(baseUrl(req)));
});
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!google.isEnabled()) return res.status(404).send('Google вход не настроен');
    const { code, state } = req.query;
    if (!code || !google.checkState(String(state || ''))) return res.status(400).send('Некорректный ответ Google');
    const profile = await google.exchangeCode(String(code), baseUrl(req));
    if (!profile.email || !profile.emailVerified) return res.status(400).send('Google не подтвердил email');
    const user = upsertGoogleUser(profile);
    createSession(res, user.id);
    res.redirect('/');
  } catch (e) { res.status(400).send('Google вход не удался: ' + e.message); }
});

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
// admin: generate a password-reset link for a user (to relay manually)
app.post('/api/admin/users/:id/reset-link', requireAuth, requireAdmin, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const token = createReset(u);
  res.json({ link: `${baseUrl(req)}/?reset=${token}` });
});
// admin: pending (unused, unexpired) reset requests, with ready links
app.get('/api/admin/resets', requireAuth, requireAdmin, (req, res) => {
  const now = Date.now();
  const items = db.resets
    .filter(r => !r.used && r.expires > now)
    .map(r => ({ email: r.email, createdAt: r.createdAt, link: `${baseUrl(req)}/?reset=${r.token}` }));
  res.json({ resets: items });
});

// ---------- session logs / error reports ----------
app.post('/api/report', requireAuth, (req, res) => {
  const { message, entries, context } = req.body || {};
  const r = saveReport(req.user, { message, entries, context });
  res.json({ ok: true, id: r.id });
});
app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  res.json({ reports: listReports(), unread: unreadCount() });
});
app.get('/api/admin/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const doc = readReport(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json({ report: doc });
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
    const { startUrl, output, concurrency, limit, plan } = req.body || {};
    const { email, password } = resolveGc(req.user, req.body || {});
    if (!email || !password) return res.status(400).json({ error: 'no_creds', message: 'Введите email и пароль GetCourse' });
    let outAbs;
    if (req.user.localAccess) outAbs = resolveWritableOutput(output); // save on the Mac Mini
    // delivery users: output is ignored; a per-user spool folder is used
    const job = createJob(req.user, {
      email, password, startUrl, output: outAbs,
      concurrency: Math.min(20, Math.max(1, +concurrency || 10)),
      limit: Math.max(0, +limit || 0),
      plan: Array.isArray(plan) && plan.length ? plan : null,
    });
    res.json({ job });
  } catch (e) { res.status(400).json({ error: 'job_failed', message: e.message }); }
});
app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => res.json({ ok: cancelJob(req.params.id, req.user) }));
app.delete('/api/jobs', requireAuth, (req, res) => res.json({ cleared: clearHistory(req.user) }));
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
  console.log(`Регистрация: ${cfg.allowSignup ? 'включена' : 'выключена'} | Google-вход: ${google.isEnabled() ? 'включён' : 'выключен'} | ЮKassa: ${yookassa.isEnabled() ? 'включена' : 'выключена (заглушка)'}`);
});
