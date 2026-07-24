// db.js — единое локальное хранилище planner на SQLite (встроенный node:sqlite).
//
// Требует запуска Node с флагом --experimental-sqlite (см. deploy/start.sh и
// package.json). Если модуль недоступен (старый Node или нет флага) — dbAvailable()
// вернёт false, и вызывающий код должен откатиться на JSON-файлы. Так сервис
// работает даже без БД (мягкая деградация).
//
// Файл БД: planner/data/planner.db. Схема создаётся идемпотентно при первом open.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'planner.db');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* node:sqlite недоступен → JSON-фолбэк */ }

let _db = null, _opened = false;

/** Схема БД (идемпотентно). Новые таблицы/поля добавлять сюда. */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS wb_cards (
      nmID INTEGER PRIMARY KEY,
      vendorCode TEXT, brand TEXT,
      length REAL, width REAL, height REAL, weightBrutto REAL, isValid INTEGER,
      volumeL REAL,
      fetchedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS wb_tariffs (
      date TEXT, warehouseName TEXT, geoName TEXT,
      deliveryBase REAL, deliveryLiter REAL, deliveryCoef REAL,
      storageBase REAL, storageLiter REAL, storageCoef REAL,
      fetchedAt TEXT,
      PRIMARY KEY (date, warehouseName)
    );
    CREATE TABLE IF NOT EXISTS season_plans (
      articleId TEXT PRIMARY KEY,
      cfg TEXT, report TEXT, savedAt TEXT,
      label TEXT, generatedAt TEXT, totalUnits INTEGER
    );
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT, updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      telegramId INTEGER PRIMARY KEY,
      username TEXT, name TEXT, photoUrl TEXT,
      status TEXT DEFAULT 'active',   -- active | blocked
      isAdmin INTEGER DEFAULT 0,
      grantedAt TEXT, expiresAt TEXT, -- срок подписки (NULL = бессрочно)
      lastLoginAt TEXT, activeSession TEXT, note TEXT,
      role TEXT DEFAULT 'viewer',     -- admin | editor | viewer | custom
      perms TEXT,                     -- JSON карта прав по листам {tab: none|view|edit}
      accessRequest TEXT              -- текст заявки на расширение доступа (NULL = нет)
    );
  `);
  // Идемпотентно добавить новые колонки в уже существующую таблицу users (старые БД).
  for (const [col, decl] of [['role', "TEXT DEFAULT 'viewer'"], ['perms', 'TEXT'], ['accessRequest', 'TEXT']]) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col} ${decl}`); } catch { /* колонка уже есть */ }
  }
}

/** Открыть (лениво) БД. Возвращает объект БД или null, если SQLite недоступен. */
export function getDb() {
  if (_opened) return _db;
  _opened = true;
  if (!DatabaseSync) return (_db = null);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(_db);
    return _db;
  } catch (e) {
    console.error('[planner] SQLite недоступен, откат на JSON:', String(e.message || e));
    return (_db = null);
  }
}

export function dbAvailable() { return !!getDb(); }

// ── meta (служебные ключи, напр. время последней загрузки) ──
export function metaGet(key) {
  const db = getDb(); if (!db) return null;
  const row = db.prepare('SELECT value, updatedAt FROM meta WHERE key = ?').get(key);
  return row || null;
}
export function metaSet(key, value) {
  const db = getDb(); if (!db) return;
  db.prepare('INSERT INTO meta(key,value,updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt')
    .run(key, String(value), new Date().toISOString());
}

// ── WB карточки ──
export function wbSaveCards(cards) {
  const db = getDb(); if (!db) return false;
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO wb_cards(nmID,vendorCode,brand,length,width,height,weightBrutto,isValid,volumeL,fetchedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(nmID) DO UPDATE SET vendorCode=excluded.vendorCode, brand=excluded.brand,
      length=excluded.length, width=excluded.width, height=excluded.height, weightBrutto=excluded.weightBrutto,
      isValid=excluded.isValid, volumeL=excluded.volumeL, fetchedAt=excluded.fetchedAt`);
  db.exec('BEGIN');
  try {
    for (const c of cards) {
      const d = c.dimensions || {};
      ins.run(c.nmID, c.vendorCode || '', c.brand || '', d.length ?? null, d.width ?? null, d.height ?? null,
        d.weightBrutto ?? null, d.isValid ? 1 : 0, c.volumeL ?? null, now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  metaSet('wb_cards_fetchedAt', now);
  return true;
}
/** Вернуть карточки, если кэш свежее maxAgeMs; иначе null. */
export function wbLoadCards(maxAgeMs) {
  const db = getDb(); if (!db) return null;
  const m = metaGet('wb_cards_fetchedAt');
  if (!m || (maxAgeMs != null && Date.now() - Date.parse(m.value) > maxAgeMs)) return null;
  const rows = db.prepare('SELECT * FROM wb_cards').all();
  if (!rows.length) return null;
  return rows.map((r) => ({
    nmID: r.nmID, vendorCode: r.vendorCode, brand: r.brand, volumeL: r.volumeL,
    dimensions: { length: r.length, width: r.width, height: r.height, weightBrutto: r.weightBrutto, isValid: !!r.isValid },
  }));
}

// ── WB тарифы box (по дате) ──
export function wbSaveTariffs(date, list) {
  const db = getDb(); if (!db) return false;
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO wb_tariffs(date,warehouseName,geoName,deliveryBase,deliveryLiter,deliveryCoef,storageBase,storageLiter,storageCoef,fetchedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date,warehouseName) DO UPDATE SET geoName=excluded.geoName,
      deliveryBase=excluded.deliveryBase, deliveryLiter=excluded.deliveryLiter, deliveryCoef=excluded.deliveryCoef,
      storageBase=excluded.storageBase, storageLiter=excluded.storageLiter, storageCoef=excluded.storageCoef, fetchedAt=excluded.fetchedAt`);
  db.exec('BEGIN');
  try {
    for (const w of list) ins.run(date, w.warehouseName, w.geoName, w.deliveryBase, w.deliveryLiter, w.deliveryCoef, w.storageBase, w.storageLiter, w.storageCoef, now);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  metaSet('wb_tariffs_' + date, now);
  return true;
}
/** Вернуть тарифы на дату, если кэш свежее maxAgeMs; иначе null. */
export function wbLoadTariffs(date, maxAgeMs) {
  const db = getDb(); if (!db) return null;
  const m = metaGet('wb_tariffs_' + date);
  if (!m || (maxAgeMs != null && Date.now() - Date.parse(m.value) > maxAgeMs)) return null;
  const rows = db.prepare('SELECT * FROM wb_tariffs WHERE date = ?').all(date);
  if (!rows.length) return null;
  return { date, warehouseList: rows.map((r) => ({
    warehouseName: r.warehouseName, geoName: r.geoName,
    deliveryBase: r.deliveryBase, deliveryLiter: r.deliveryLiter, deliveryCoef: r.deliveryCoef,
    storageBase: r.storageBase, storageLiter: r.storageLiter, storageCoef: r.storageCoef,
  })) };
}

// ── Планы сезонности ──
export function planSave(articleId, rec) {
  const db = getDb(); if (!db) return false;
  const rep = rec.report || {};
  const fd = (rep.plan && rep.plan.forecastDaily) || [];
  const totalUnits = Math.round(fd.reduce((s, d) => s + (+d.plannedOrders || 0), 0));
  db.prepare(`INSERT INTO season_plans(articleId,cfg,report,savedAt,label,generatedAt,totalUnits)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(articleId) DO UPDATE SET cfg=excluded.cfg, report=excluded.report, savedAt=excluded.savedAt,
      label=excluded.label, generatedAt=excluded.generatedAt, totalUnits=excluded.totalUnits`)
    .run(String(articleId), JSON.stringify(rec.cfg || null), JSON.stringify(rep), rec.savedAt || new Date().toISOString(),
      rep.label || '', rep.generatedAt || '', totalUnits);
  return true;
}
export function planLoad(articleId) {
  const db = getDb(); if (!db) return null;
  const r = db.prepare('SELECT * FROM season_plans WHERE articleId = ?').get(String(articleId));
  if (!r) return null;
  return { articleId: r.articleId, cfg: JSON.parse(r.cfg || 'null'), report: JSON.parse(r.report || 'null'), savedAt: r.savedAt };
}
export function planDelete(articleId) {
  const db = getDb(); if (!db) return false;
  const info = db.prepare('DELETE FROM season_plans WHERE articleId = ?').run(String(articleId));
  return info.changes > 0;
}
// ── Пользователи (allowlist Telegram-аккаунтов) ──
export function userGet(telegramId) {
  const db = getDb(); if (!db) return null;
  return db.prepare('SELECT * FROM users WHERE telegramId = ?').get(Number(telegramId)) || null;
}
export function userList() {
  const db = getDb(); if (!db) return [];
  return db.prepare('SELECT * FROM users ORDER BY (isAdmin=1) DESC, grantedAt DESC').all();
}
/** Создать/обновить пользователя из данных Telegram (при выдаче доступа или входе). */
export function userUpsert(u) {
  const db = getDb(); if (!db) return false;
  const now = new Date().toISOString();
  const permsJson = u.perms == null ? null : (typeof u.perms === 'string' ? u.perms : JSON.stringify(u.perms));
  db.prepare(`INSERT INTO users(telegramId,username,name,photoUrl,status,isAdmin,grantedAt,expiresAt,note,role,perms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(telegramId) DO UPDATE SET
      username=COALESCE(excluded.username,users.username),
      name=COALESCE(excluded.name,users.name),
      photoUrl=COALESCE(excluded.photoUrl,users.photoUrl),
      status=COALESCE(excluded.status,users.status),
      isAdmin=COALESCE(excluded.isAdmin,users.isAdmin),
      expiresAt=excluded.expiresAt, note=COALESCE(excluded.note,users.note),
      role=COALESCE(excluded.role,users.role),
      perms=COALESCE(excluded.perms,users.perms)`)
    .run(Number(u.telegramId), u.username ?? null, u.name ?? null, u.photoUrl ?? null,
      u.status ?? 'active', u.isAdmin ? 1 : 0, u.grantedAt ?? now, u.expiresAt ?? null, u.note ?? null,
      u.role ?? null, permsJson);
  return true;
}
/** Задать роль и карту прав пользователю (перезаписывает perms целиком). */
export function userSetPerms(telegramId, role, perms) {
  const db = getDb(); if (!db) return false;
  const permsJson = perms == null ? null : (typeof perms === 'string' ? perms : JSON.stringify(perms));
  db.prepare('UPDATE users SET role=COALESCE(?,role), perms=? WHERE telegramId=?')
    .run(role ?? null, permsJson, Number(telegramId));
  return true;
}
/** Записать/снять заявку пользователя на расширение доступа. */
export function userSetAccessRequest(telegramId, text) {
  const db = getDb(); if (!db) return false;
  db.prepare('UPDATE users SET accessRequest=? WHERE telegramId=?').run(text ?? null, Number(telegramId));
  return true;
}
export function userSetStatus(telegramId, status) {
  const db = getDb(); if (!db) return false;
  db.prepare('UPDATE users SET status=? WHERE telegramId=?').run(status, Number(telegramId));
  return true;
}
export function userSetExpiry(telegramId, expiresAt) {
  const db = getDb(); if (!db) return false;
  db.prepare('UPDATE users SET expiresAt=? WHERE telegramId=?').run(expiresAt || null, Number(telegramId));
  return true;
}
export function userDelete(telegramId) {
  const db = getDb(); if (!db) return false;
  return db.prepare('DELETE FROM users WHERE telegramId=?').run(Number(telegramId)).changes > 0;
}
/** Отметить вход: обновить профиль, lastLoginAt и активную сессию (одна на аккаунт). */
export function userMarkLogin(telegramId, patch = {}, sessionId = null) {
  const db = getDb(); if (!db) return false;
  db.prepare('UPDATE users SET username=COALESCE(?,username), name=COALESCE(?,name), photoUrl=COALESCE(?,photoUrl), lastLoginAt=?, activeSession=? WHERE telegramId=?')
    .run(patch.username ?? null, patch.name ?? null, patch.photoUrl ?? null, new Date().toISOString(), sessionId, Number(telegramId));
  return true;
}

// ── App-state (всё состояние приложения единым JSON-блобом) ──
export function stateLoadJson() {
  const db = getDb(); if (!db) return null;
  const r = db.prepare('SELECT json FROM app_state WHERE id = 1').get();
  return r ? r.json : null;
}
export function stateSaveJson(json) {
  const db = getDb(); if (!db) return false;
  db.prepare('INSERT INTO app_state(id,json,updatedAt) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt')
    .run(String(json), new Date().toISOString());
  return true;
}

// Полные записи (для построения индекса — как в JSON-версии listPlans).
export function planList() {
  const db = getDb(); if (!db) return null;
  const rows = db.prepare('SELECT articleId,cfg,report,savedAt FROM season_plans ORDER BY articleId').all();
  return rows.map((r) => ({ articleId: r.articleId, cfg: JSON.parse(r.cfg || 'null'), report: JSON.parse(r.report || 'null'), savedAt: r.savedAt }));
}
