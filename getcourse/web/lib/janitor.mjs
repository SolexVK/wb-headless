// Background cleanup for the delivery spool. Runs on an interval and:
//   1. deletes any spooled file older than the retention window (measured from
//      last activity: production or download — download refreshes the file's
//      mtime, so the countdown restarts when the user pulls it);
//   2. enforces a per-user spool size cap by deleting the oldest files first;
//   3. removes empty job/user folders.
// Robust across restarts because it works purely from the filesystem.
import fs from 'node:fs';
import path from 'node:path';
import { cfg, bytesPerGB } from './config.mjs';

function walkFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else { try { out.push({ p, ...fs.statSync(p) }); } catch {} }
  }
  return out;
}

function rmEmptyDirs(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) rmEmptyDirs(path.join(dir, e.name));
  try { if (fs.readdirSync(dir).length === 0 && path.resolve(dir) !== cfg.spoolRoot) fs.rmdirSync(dir); } catch {}
}

export function sweepOnce() {
  const root = cfg.spoolRoot;
  if (!fs.existsSync(root)) return { deletedExpired: 0, deletedQuota: 0 };
  const now = Date.now();
  const maxAge = cfg.retentionMin * 60 * 1000;
  let deletedExpired = 0, deletedQuota = 0;

  // 1. retention sweep
  for (const f of walkFiles(root)) {
    if (now - f.mtimeMs > maxAge) { try { fs.rmSync(f.p); deletedExpired++; } catch {} }
  }

  // 2. per-user quota (each direct child of spoolRoot is a user folder)
  const cap = (cfg.userQuotaGB || cfg.dailyGB) * bytesPerGB;
  let userDirs = [];
  try { userDirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name)); } catch {}
  for (const ud of userDirs) {
    const files = walkFiles(ud).sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= cap) break;
      try { fs.rmSync(f.p); total -= f.size; deletedQuota++; } catch {}
    }
  }

  rmEmptyDirs(root);
  return { deletedExpired, deletedQuota };
}

export function startJanitor(intervalMin = 5) {
  fs.mkdirSync(cfg.spoolRoot, { recursive: true });
  const tick = () => { try { sweepOnce(); } catch (e) { console.error('janitor error', e.message); } };
  tick();
  return setInterval(tick, Math.max(1, intervalMin) * 60 * 1000);
}
