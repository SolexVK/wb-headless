// Job manager: runs course downloads one at a time and streams progress to any
// number of Server-Sent-Events subscribers. GetCourse credentials are held only
// in memory for the duration of a run and are never written to disk.
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { runCourseDownload } from '../../src/run.mjs';

const jobs = new Map();      // id -> live job (includes subscribers, not persisted)
const queue = [];            // ids waiting to run
let running = false;

const MAX_LOG = 500;

function persist(job) {
  const rec = {
    id: job.id, userId: job.userId, username: job.username,
    startUrl: job.startUrl, output: job.output,
    status: job.status, createdAt: job.createdAt,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    summary: job.summary, course: job.course,
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

function onEvent(job, evt) {
  // maintain a compact live view of progress
  switch (evt.type) {
    case 'course':
      job.course = evt.blocks; job.totalLessons = evt.totalLessons; break;
    case 'lesson-start':
      job.current = { bi: evt.bi, li: evt.li, title: evt.title, done: 0, total: 0 }; break;
    case 'video-progress':
      if (job.current) { job.current.done = evt.done; job.current.total = evt.total; } break;
    case 'video-done':
      job.completedVideos = (job.completedVideos || 0) + 1; break;
    case 'done':
      job.summary = { ok: evt.ok, skipped: evt.skipped, problems: evt.problems, output: evt.output }; break;
    case 'log':
      pushLog(job, evt.message); break;
  }
  broadcast(job, evt);
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
      email: job._email,
      password: job._password,
      startUrl: job.startUrl,
      output: job.output,
      concurrency: job.concurrency,
      limit: job.limit,
      onEvent: (evt) => onEvent(job, evt),
      shouldCancel: () => job.cancel,
    });
    job.status = job.cancel ? 'cancelled' : 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    pushLog(job, 'ОШИБКА: ' + e.message);
    broadcast(job, { type: 'fatal', error: e.message });
  } finally {
    job._email = job._password = undefined; // drop credentials
    job.finishedAt = new Date().toISOString();
    persist(job);
    broadcast(job, { type: 'status', status: job.status });
    running = false;
    setImmediate(runNext);
  }
}

export function createJob(user, { email, password, startUrl, output, concurrency = 10, limit = 0 }) {
  if (!email || !password || !startUrl || !output) throw new Error('нужны email, password, startUrl и output');
  const id = crypto.randomUUID();
  const job = {
    id, userId: user.id, username: user.username,
    startUrl, output, concurrency, limit,
    status: 'queued', createdAt: new Date().toISOString(),
    startedAt: null, finishedAt: null,
    log: [], course: null, current: null, completedVideos: 0, summary: null,
    cancel: false, subscribers: new Set(),
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
    const qi = queue.indexOf(id);
    if (qi > -1) queue.splice(qi, 1);
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    persist(job);
  }
  return true;
}

export function subscribe(id, res, user) {
  const job = jobs.get(id);
  if (!job) { res.status(404).end(); return; }
  if (job.userId !== user.id && user.role !== 'admin') { res.status(403).end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // send backlog snapshot
  res.write(`data: ${JSON.stringify({ type: 'snapshot', job: publicJob(job), log: job.log })}\n\n`);
  job.subscribers.add(res);
  res.on('close', () => job.subscribers.delete(res));
}

export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id, username: job.username, startUrl: job.startUrl, output: job.output,
    status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    course: job.course, totalLessons: job.totalLessons, current: job.current,
    completedVideos: job.completedVideos, summary: job.summary, error: job.error,
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
