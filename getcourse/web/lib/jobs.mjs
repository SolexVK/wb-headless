// Job manager: runs course downloads one at a time and streams progress to any
// number of Server-Sent-Events subscribers.
//
// Two storage modes:
//   - 'local'    (owner/admin with localAccess): files are written straight into
//     a folder the user chose on the Mac Mini. No file serving.
//   - 'delivery' (subscribers): files go to a per-user spool folder, are offered
//     to the browser for download, count against a daily quota and are swept by
//     the janitor after the retention window.
//
// GetCourse credentials are held only in memory for a run and never persisted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.mjs';
import { cfg, bytesPerGB } from './config.mjs';
import { getUsage, addUsage, quotaBlock } from './quota.mjs';
import { runCourseDownload } from '../../src/run.mjs';

const jobs = new Map();
const queue = [];
let running = false;
const MAX_LOG = 500;

function persist(job) {
  const rec = {
    id: job.id, userId: job.userId, username: job.username, mode: job.mode,
    startUrl: job.startUrl, output: job.mode === 'local' ? job.output : '(delivery)',
    status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    summary: job.summary,
  };
  const i = db.jobs.findIndex(j => j.id === job.id);
  if (i > -1) db.jobs[i] = rec; else db.jobs.push(rec);
  db.save();
}

function broadcast(job, evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of job.subscribers) { try { res.write(payload); } catch {} }
}
function pushLog(job, message) {
  job.log.push({ t: Date.now(), message });
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
}

function registerFile(job, evt) {
  // delivery mode: expose the finished file for browser download + quota
  const rel = path.relative(job.output, evt.file);
  const rec = {
    index: job.files.length,
    name: rel.split(path.sep).join(' / '),
    filename: path.basename(evt.file),
    absPath: evt.file,
    bytes: evt.bytes,
    height: evt.height,
    completedAt: Date.now(),
    expiresAt: Date.now() + cfg.retentionMin * 60 * 1000,
  };
  job.files.push(rec);
  const u = db.users.find(x => x.id === job.userId);
  if (u) addUsage(u, evt.bytes);
  broadcast(job, { type: 'file', file: publicFile(rec) });
}

function onEvent(job, evt) {
  switch (evt.type) {
    case 'course': job.course = evt.blocks; job.totalLessons = evt.totalLessons; break;
    case 'lesson-start': job.current = { bi: evt.bi, li: evt.li, title: evt.title, done: 0, total: 0 }; break;
    case 'video-progress': if (job.current) { job.current.done = evt.done; job.current.total = evt.total; } break;
    case 'video-done':
      job.completedVideos = (job.completedVideos || 0) + 1;
      if (job.mode === 'delivery') registerFile(job, evt);
      break;
    case 'done': job.summary = { ok: evt.ok, skipped: evt.skipped, problems: evt.problems }; break;
    case 'log': pushLog(job, evt.message); break;
  }
  broadcast(job, evt);
}

function quotaExhausted(job) {
  if (job.mode !== 'delivery') return false;
  const u = db.users.find(x => x.id === job.userId);
  if (!u || u.role === 'admin') return false;
  const usage = getUsage(u);
  return usage.bytes >= cfg.dailyGB * bytesPerGB || (cfg.dailyFiles && usage.files >= cfg.dailyFiles);
}

async function runNext() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return runNext();
  running = true;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  persist(job);
  broadcast(job, { type: 'status', status: 'running' });
  try {
    await runCourseDownload({
      email: job._email, password: job._password, startUrl: job.realStartUrl,
      output: job.output, concurrency: job.concurrency, limit: job.limit, plan: job.plan,
      onEvent: (evt) => onEvent(job, evt),
      shouldCancel: () => {
        if (job.cancel) return true;
        if (quotaExhausted(job)) { job.quotaStopped = true; if (!job._warned) { job._warned = true; pushLog(job, 'Достигнут дневной лимит — остановка.'); broadcast(job, { type: 'log', message: 'Достигнут дневной лимит — остановка.' }); } return true; }
        return false;
      },
    });
    job.status = job.cancel ? 'cancelled' : (job.quotaStopped ? 'limited' : 'done');
  } catch (e) {
    job.status = 'error'; job.error = e.message;
    pushLog(job, 'ОШИБКА: ' + e.message);
    broadcast(job, { type: 'fatal', error: e.message });
  } finally {
    job._email = job._password = undefined;
    job.finishedAt = new Date().toISOString();
    persist(job);
    broadcast(job, { type: 'status', status: job.status });
    running = false;
    setImmediate(runNext);
  }
}

export function createJob(user, { email, password, startUrl, output, concurrency = 10, limit = 0, plan = null }) {
  if (!email || !password || (!startUrl && !(plan && plan.length))) throw new Error('нужны email, password и ссылка (или выбор уроков)');
  const mode = user.localAccess ? 'local' : 'delivery';
  const id = crypto.randomUUID();
  let outDir;
  if (mode === 'local') {
    if (!output) throw new Error('не выбрана папка');
    outDir = output; // already validated/resolved by the caller
  } else {
    // ignore any client-provided path — subscribers never touch the server FS
    outDir = path.join(cfg.spoolRoot, user.id, id);
    fs.mkdirSync(outDir, { recursive: true });
    const block = quotaBlock(user, 0);
    if (block) throw new Error(block);
  }
  const planLessons = plan ? plan.reduce((n, b) => n + (b.lessons ? b.lessons.length : 0), 0) : 0;
  const job = {
    id, userId: user.id, username: user.username, mode,
    realStartUrl: startUrl || null, // actual URL passed to the engine (null for plan)
    startUrl: startUrl || (plan ? `Выбранные уроки: ${planLessons}` : ''), // display label
    plan, output: outDir, concurrency, limit,
    status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    log: [], course: null, current: null, completedVideos: 0, summary: null,
    files: [], cancel: false, quotaStopped: false, subscribers: new Set(),
    _email: email, _password: password,
  };
  jobs.set(id, job);
  persist(job);
  queue.push(id);
  setImmediate(runNext);
  return publicJob(job);
}

export function cancelJob(id, user) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.userId !== user.id && user.role !== 'admin') return false;
  job.cancel = true;
  if (job.status === 'queued') {
    const qi = queue.indexOf(id); if (qi > -1) queue.splice(qi, 1);
    job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); persist(job);
  }
  return true;
}

export function subscribe(id, res, user) {
  const job = jobs.get(id);
  if (!job) { res.status(404).end(); return; }
  if (job.userId !== user.id && user.role !== 'admin') { res.status(403).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'snapshot', job: publicJob(job), log: job.log })}\n\n`);
  job.subscribers.add(res);
  res.on('close', () => job.subscribers.delete(res));
}

function publicFile(f) {
  return {
    index: f.index, name: f.name, filename: f.filename, bytes: f.bytes, height: f.height,
    completedAt: f.completedAt, expiresAt: f.expiresAt,
    available: fsExists(f.absPath),
  };
}
function fsExists(p) { try { return fs.existsSync(p); } catch { return false; } }

export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id, username: job.username, mode: job.mode,
    startUrl: job.startUrl, output: job.mode === 'local' ? job.output : undefined,
    status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    course: job.course, totalLessons: job.totalLessons, current: job.current,
    completedVideos: job.completedVideos, summary: job.summary, error: job.error,
    quotaStopped: job.quotaStopped,
    files: job.mode === 'delivery' ? job.files.map(publicFile) : undefined,
  };
}

export function listJobs(user) {
  const all = [...jobs.values()];
  const mine = user.role === 'admin' ? all : all.filter(j => j.userId === user.id);
  return mine.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1)).map(publicJob);
}

export function getJob(id, user) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.userId !== user.id && user.role !== 'admin') return null;
  return { ...publicJob(job), log: job.log };
}

// Resolve a downloadable delivery file (with ownership check). Touching mtime is
// done by the caller so the retention countdown restarts on download.
export function getJobFile(id, user, index) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.userId !== user.id && user.role !== 'admin') return null;
  if (job.mode !== 'delivery') return null;
  const f = job.files[+index];
  if (!f || !fsExists(f.absPath)) return null;
  return { absPath: f.absPath, filename: f.filename };
}
