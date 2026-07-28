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
    CREATE TABLE IF NOT EXISTS feature_dict (
      path TEXT PRIMARY KEY, json TEXT, fetchedAt TEXT
    );
    -- Кэш поисковых фраз ОДНОГО товара (by_keywords). Дорогой запрос (тратит суточный
    -- лимит MPStats), поэтому храним профиль в БД и переиспользуем между отчётами.
    CREATE TABLE IF NOT EXISTS wb_keywords (
      nmID INTEGER PRIMARY KEY,
      d1 TEXT, d2 TEXT,
      phrases TEXT,           -- JSON [{phrase,traffic}]
      total INTEGER,          -- суммарный трафик по фразам
      fetchedAt TEXT
    );
    -- Кэш поисковых фраз ПРЕДМЕТА (category/by_keywords) — 1 запрос отдаёт сотни фраз.
    CREATE TABLE IF NOT EXISTS wb_subject_keywords (
      path TEXT PRIMARY KEY,
      d1 TEXT, d2 TEXT,
      phrases TEXT,           -- JSON [{phrase,traffic,count}]
      fetchedAt TEXT
    );
    -- Память запросов «Ранга сезонности»: введённые слова/минусы/выбранные фразы и
    -- найденные артикулы — чтобы переиспользовать наработки для похожих предметов.
    CREATE TABLE IF NOT EXISTS season_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT,
      targetWords TEXT,       -- JSON []
      minusWords TEXT,        -- JSON []
      pickedPhrases TEXT,     -- JSON []
      threshold REAL,
      keptIds TEXT,           -- JSON [] nmID отобранных аналогов
      resultCount INTEGER,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_season_searches_path ON season_searches(path);
    -- Журнал производственных событий (append-only): смены статусов, новые даты,
    -- выполненные количества (Шаг 2), заметки. Источник истории/аудита/динамики.
    CREATE TABLE IF NOT EXISTS prod_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,                -- ISO-время события
      actor INTEGER,          -- telegramId автора (NULL = система)
      kind TEXT,              -- status | expected | qty | note
      partiaId TEXT,
      articleId TEXT,
      color TEXT,
      workshopId TEXT,
      op TEXT,                -- операция cut|sew|iron|otk (или NULL)
      qty INTEGER,            -- количество (kind=qty)
      dateValue TEXT,         -- дата (kind=status/expected)
      fromValue TEXT,
      toValue TEXT,
      note TEXT,
      payload TEXT            -- доп. JSON
    );
    CREATE INDEX IF NOT EXISTS idx_prod_events_partia ON prod_events(partiaId);
    CREATE INDEX IF NOT EXISTS idx_prod_events_article ON prod_events(articleId);
    CREATE INDEX IF NOT EXISTS idx_prod_events_ts ON prod_events(ts);
    -- Ответственные по (цех × роль). role — ключ из реестра ролей (cut|flow|otk|…).
    CREATE TABLE IF NOT EXISTS responsibles (
      workshopId TEXT,
      role TEXT,
      telegramId INTEGER,
      updatedAt TEXT,
      PRIMARY KEY (workshopId, role)
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

// ── Словарь признаков предмета (кэш по path) ──
export function featureDictLoad(path, maxAgeMs) {
  const db = getDb(); if (!db) return null;
  const r = db.prepare('SELECT json, fetchedAt FROM feature_dict WHERE path = ?').get(String(path));
  if (!r) return null;
  if (maxAgeMs != null && r.fetchedAt && (Date.now() - Date.parse(r.fetchedAt) > maxAgeMs)) return null;
  try { return JSON.parse(r.json); } catch { return null; }
}
export function featureDictSave(path, data) {
  const db = getDb(); if (!db) return false;
  db.prepare('INSERT INTO feature_dict(path,json,fetchedAt) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET json=excluded.json, fetchedAt=excluded.fetchedAt')
    .run(String(path), JSON.stringify(data), new Date().toISOString());
  return true;
}

// ── Кэш поисковых фраз товара (by_keywords) ──
// Профиль запросов меняется медленно; храним в БД, чтобы не тратить суточный лимит.
export function keywordsLoad(nmID, maxAgeMs) {
  const db = getDb(); if (!db) return null;
  const r = db.prepare('SELECT phrases, total, fetchedAt FROM wb_keywords WHERE nmID = ?').get(Number(nmID));
  if (!r) return null;
  if (maxAgeMs != null && r.fetchedAt && (Date.now() - Date.parse(r.fetchedAt) > maxAgeMs)) return null;
  try { return { phrases: JSON.parse(r.phrases || '[]'), total: r.total || 0, fetchedAt: r.fetchedAt }; } catch { return null; }
}
/** Вернуть Map nmID→профиль для набора id (только свежие). Один запрос к БД. */
export function keywordsLoadMany(nmIds, maxAgeMs) {
  const db = getDb(); const out = new Map(); if (!db || !nmIds || !nmIds.length) return out;
  const uniq = [...new Set(nmIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const minTs = maxAgeMs != null ? Date.now() - maxAgeMs : null;
  const q = db.prepare(`SELECT nmID, phrases, total, fetchedAt FROM wb_keywords WHERE nmID IN (${uniq.map(() => '?').join(',')})`);
  for (const r of q.all(...uniq)) {
    if (minTs != null && r.fetchedAt && Date.parse(r.fetchedAt) < minTs) continue;
    try { out.set(Number(r.nmID), { phrases: JSON.parse(r.phrases || '[]'), total: r.total || 0, fetchedAt: r.fetchedAt }); } catch { /* skip */ }
  }
  return out;
}
export function keywordsSave(nmID, profile, d1, d2) {
  const db = getDb(); if (!db) return false;
  const phrases = (profile && profile.phrases) || [];
  db.prepare(`INSERT INTO wb_keywords(nmID,d1,d2,phrases,total,fetchedAt) VALUES(?,?,?,?,?,?)
    ON CONFLICT(nmID) DO UPDATE SET d1=excluded.d1, d2=excluded.d2, phrases=excluded.phrases, total=excluded.total, fetchedAt=excluded.fetchedAt`)
    .run(Number(nmID), d1 || null, d2 || null, JSON.stringify(phrases), Math.round((profile && profile.total) || 0), new Date().toISOString());
  return true;
}

// ── Кэш поисковых фраз предмета (category/by_keywords) ──
export function subjectKeywordsLoad(path, maxAgeMs) {
  const db = getDb(); if (!db) return null;
  const r = db.prepare('SELECT phrases, d1, d2, fetchedAt FROM wb_subject_keywords WHERE path = ?').get(String(path));
  if (!r) return null;
  if (maxAgeMs != null && r.fetchedAt && (Date.now() - Date.parse(r.fetchedAt) > maxAgeMs)) return null;
  try { return { phrases: JSON.parse(r.phrases || '[]'), d1: r.d1, d2: r.d2, fetchedAt: r.fetchedAt }; } catch { return null; }
}
export function subjectKeywordsSave(path, phrases, d1, d2) {
  const db = getDb(); if (!db) return false;
  db.prepare(`INSERT INTO wb_subject_keywords(path,d1,d2,phrases,fetchedAt) VALUES(?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET d1=excluded.d1, d2=excluded.d2, phrases=excluded.phrases, fetchedAt=excluded.fetchedAt`)
    .run(String(path), d1 || null, d2 || null, JSON.stringify(phrases || []), new Date().toISOString());
  return true;
}

// ── Память запросов «Ранга сезонности» ──
export function searchSave(rec) {
  const db = getDb(); if (!db) return null;
  const info = db.prepare(`INSERT INTO season_searches(path,targetWords,minusWords,pickedPhrases,threshold,keptIds,resultCount,createdAt)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(String(rec.path || ''), JSON.stringify(rec.targetWords || []), JSON.stringify(rec.minusWords || []),
      JSON.stringify(rec.pickedPhrases || []), rec.threshold ?? null, JSON.stringify(rec.keptIds || []),
      (rec.keptIds || []).length, new Date().toISOString());
  return info.lastInsertRowid;
}
export function searchList(path, limit = 20) {
  const db = getDb(); if (!db) return [];
  const rows = path
    ? db.prepare('SELECT * FROM season_searches WHERE path = ? ORDER BY id DESC LIMIT ?').all(String(path), limit)
    : db.prepare('SELECT * FROM season_searches ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    id: r.id, path: r.path, targetWords: JSON.parse(r.targetWords || '[]'), minusWords: JSON.parse(r.minusWords || '[]'),
    pickedPhrases: JSON.parse(r.pickedPhrases || '[]'), threshold: r.threshold, resultCount: r.resultCount, createdAt: r.createdAt,
  }));
}

// ── Дневной счётчик запросов к MPStats (защита суточного лимита ~150) ──
const _today = () => new Date().toISOString().slice(0, 10);
export function mpstatsBudgetToday() {
  const limit = Number(process.env.MPSTATS_DAILY_LIMIT) || 150;
  const m = metaGet('mpstats_budget');
  let used = 0;
  try { const j = JSON.parse(m && m.value || '{}'); if (j.date === _today()) used = Number(j.used) || 0; } catch { /* ignore */ }
  return { date: _today(), used, limit, left: Math.max(0, limit - used) };
}
export function mpstatsBudgetAdd(n) {
  const add = Number(n) || 0; if (add <= 0) return mpstatsBudgetToday();
  const cur = mpstatsBudgetToday();
  metaSet('mpstats_budget', JSON.stringify({ date: cur.date, used: cur.used + add }));
  return mpstatsBudgetToday();
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

// ── Журнал производственных событий (append-only) ──
export function eventAdd(e) {
  const db = getDb(); if (!db) return false;
  db.prepare(`INSERT INTO prod_events(ts,actor,kind,partiaId,articleId,color,workshopId,op,qty,dateValue,fromValue,toValue,note,payload)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(e.ts || new Date().toISOString(), e.actor ?? null, e.kind || 'note',
      e.partiaId ?? null, e.articleId ?? null, e.color ?? null, e.workshopId ?? null,
      e.op ?? null, e.qty ?? null, e.dateValue ?? null, e.fromValue ?? null, e.toValue ?? null,
      e.note ?? null, e.payload == null ? null : (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)));
  return true;
}
export function eventsForPartia(partiaId, limit = 200) {
  const db = getDb(); if (!db) return [];
  return db.prepare('SELECT * FROM prod_events WHERE partiaId = ? ORDER BY id DESC LIMIT ?').all(String(partiaId), limit);
}
export function eventsRecent(limit = 200) {
  const db = getDb(); if (!db) return [];
  return db.prepare('SELECT * FROM prod_events ORDER BY id DESC LIMIT ?').all(limit);
}

// ── Ответственные (цех × роль → пользователь) ──
export function responsibleList() {
  const db = getDb(); if (!db) return [];
  return db.prepare('SELECT workshopId, role, telegramId FROM responsibles').all();
}
export function responsibleSet(workshopId, role, telegramId) {
  const db = getDb(); if (!db) return false;
  if (telegramId == null || telegramId === '') {
    db.prepare('DELETE FROM responsibles WHERE workshopId=? AND role=?').run(String(workshopId), String(role));
    return true;
  }
  db.prepare(`INSERT INTO responsibles(workshopId,role,telegramId,updatedAt) VALUES(?,?,?,?)
    ON CONFLICT(workshopId,role) DO UPDATE SET telegramId=excluded.telegramId, updatedAt=excluded.updatedAt`)
    .run(String(workshopId), String(role), Number(telegramId), new Date().toISOString());
  return true;
}

// Полные записи (для построения индекса — как в JSON-версии listPlans).
export function planList() {
  const db = getDb(); if (!db) return null;
  const rows = db.prepare('SELECT articleId,cfg,report,savedAt FROM season_plans ORDER BY articleId').all();
  return rows.map((r) => ({ articleId: r.articleId, cfg: JSON.parse(r.cfg || 'null'), report: JSON.parse(r.report || 'null'), savedAt: r.savedAt }));
}
