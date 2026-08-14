// service/db.js — SQLite (ВСТРОЕННЫЙ node:sqlite) + схема + сессионный стор.
// Нативных зависимостей нет (важно для надёжной установки). Требует Node >= 22.5
// и флаг --experimental-sqlite (прописан в npm-скриптах). Тонкий слой: вся схема
// здесь; при переезде на Postgres меняем только этот модуль.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import session from 'express-session';
import { config } from './config.js';
import { logger } from './logger.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Хелпер транзакции (в node:sqlite нет db.transaction, как в better-sqlite3).
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
}

// ── Схема (idempotent) ──────────────────────────────────────────────────────
// Полная модель заведена сразу; в Фазе 0 используются users/organizations/memberships.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  license_seats INTEGER NOT NULL DEFAULT 1,   -- лицензия: мест всего (владелец + приглашённые)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, org_id)
);

-- Готово к Фазе 1+ (пока не используется в коде):
CREATE TABLE IF NOT EXISTS cabinets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  wb_token_enc   TEXT,            -- AES-256-GCM ciphertext (base64)
  token_iv       TEXT,
  token_tag      TEXT,
  token_meta     TEXT,            -- JSON: категории/срок/тип
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invitations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('admin','member')),
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshot_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cabinet_id   INTEGER NOT NULL REFERENCES cabinets(id) ON DELETE CASCADE,
  report       TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  json         TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cabinet_id, report, params_hash)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Миграции для уже существующих БД (idempotent): добавляем недостающие столбцы.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    logger.info({ table, column }, 'миграция: добавлен столбец');
  }
}
ensureColumn('organizations', 'license_seats', 'license_seats INTEGER NOT NULL DEFAULT 1');

logger.info({ db: config.dbPath }, 'SQLite готова, схема применена');

// ── Минимальный сессионный стор на SQLite (persistent, переживает рестарт) ───
export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this._get = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
    this._set = db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at');
    this._del = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._gc = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
    setInterval(() => { try { this._gc.run(Date.now()); } catch (e) { logger.warn(e, 'session gc'); } }, 3600_000).unref();
  }
  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) { this._del.run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400_000;
      this._set.run(sid, JSON.stringify(sess), exp);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) { try { this._del.run(sid); cb(null); } catch (e) { cb(e); } }
}
