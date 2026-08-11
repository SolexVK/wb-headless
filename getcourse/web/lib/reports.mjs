// Session logs / error reports sent by users. The browser keeps a rolling
// session log in the background; on an error the user can send it here. Each
// report is stored as a JSON file under <data>/reports and indexed in the DB so
// the admin can browse and read them from the admin panel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.mjs';

const REPORTS_DIR = path.join(db.dataDir, 'reports');

export function saveReport(user, { message, entries, context } = {}) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeEntries = Array.isArray(entries) ? entries.slice(-1000) : [];
  const doc = {
    id, createdAt,
    userId: user?.id || null,
    username: user?.username || 'anon',
    message: String(message || '').slice(0, 2000),
    context: context || {},
    entries: safeEntries,
  };
  fs.writeFileSync(path.join(REPORTS_DIR, id + '.json'), JSON.stringify(doc, null, 2));
  db.reports.push({ id, createdAt, userId: doc.userId, username: doc.username, message: doc.message, entriesCount: safeEntries.length, read: false });
  // keep the index bounded
  if (db.reports.length > 2000) db.reports.splice(0, db.reports.length - 2000);
  db.save();
  return { id, createdAt };
}

export function listReports() {
  return [...db.reports].sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

export function readReport(id) {
  const p = path.join(REPORTS_DIR, path.basename(id) + '.json');
  if (!fs.existsSync(p)) return null;
  const idx = db.reports.find(r => r.id === id);
  if (idx && !idx.read) { idx.read = true; db.save(); }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function unreadCount() { return db.reports.filter(r => !r.read).length; }
