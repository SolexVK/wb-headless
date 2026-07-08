// lib/db.js — слой доступа к локальной БД (SQLite, файл в репозитории).
//
// Зачем: копить структурированные данные между запусками, периодически к ним
// обращаться, пересчитывать отчёты и снова сохранять — без внешней БД-инфры.
// Файл БД (по умолчанию data/wb.db) коммитится в git, поэтому вся история
// изменений и накопленные ряды переживают эфемерные раннеры GitHub Actions.
//
// Архитектура схемы (см. migrate()):
//   • products / groups / product_groups — справочник товаров и линеек;
//   • sku_daily                          — СЫРЬЁ: дневные ряды по каждому SKU
//                                          (остаток, продажи, выручка), основа
//                                          для накопления и пересчёта задним числом;
//   • report_runs / report_rows          — снимки готовых отчётов по периодам;
//   • tool_exports                       — универсальный «приёмник» произвольных
//                                          выгрузок из будущих инструментов
//                                          (по мере их появления пишем сюда, а
//                                          типизированные таблицы добавляем миграцией).
//
// Драйвер — better-sqlite3 (синхронный). Транзакции обёрнуты в db.transaction(),
// поэтому пакетные upsert'ы атомарны и быстры.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Путь к файлу БД. Переопределяется через env DB_PATH. */
export function defaultDbPath() {
  return process.env.DB_PATH || path.join(__dirname, '..', 'data', 'wb.db');
}

/**
 * Открывает (создаёт при отсутствии) БД и прогоняет миграции.
 * @param {string} [dbPath]
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dbPath = defaultDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // Внешние ключи и разумные дефолты. journal_mode оставляем DELETE (по
  // умолчанию), чтобы после закрытия оставался ровно ОДИН файл .db — его и
  // коммитим, без болтающихся -wal/-shm.
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000'); // бот и CLI могут писать в рантайм-БД одновременно
  migrate(db);
  return db;
}

/** Закрывает БД (после этого файл самодостаточен для коммита). */
export function closeDb(db) {
  try { db.close(); } catch (_) {}
}

// ─────────────────────────── миграции ───────────────────────────

// Каждая миграция — SQL, выполняемый один раз. Версия хранится в
// user_version (PRAGMA). Новый инструмент = добавить элемент в массив;
// прогонятся только ещё не применённые.
const MIGRATIONS = [
  // v1 — базовая схема
  `
  CREATE TABLE IF NOT EXISTS products (
    wb         INTEGER PRIMARY KEY,          -- WB nmId (артикул WB)
    seller     TEXT NOT NULL DEFAULT '',     -- артикул продавца (человекочитаемый)
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    name TEXT PRIMARY KEY                     -- метка линейки (РМП, МС, …)
  );

  CREATE TABLE IF NOT EXISTS product_groups (
    group_name TEXT NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    wb         INTEGER NOT NULL REFERENCES products(wb) ON DELETE CASCADE,
    PRIMARY KEY (group_name, wb)
  );

  -- Сырьё: дневной ряд по SKU. source позволяет держать данные из разных
  -- источников бок о бок (сейчас 'mpstats'; позже другие инструменты).
  CREATE TABLE IF NOT EXISTS sku_daily (
    wb         INTEGER NOT NULL,
    date       TEXT NOT NULL,                 -- YYYY-MM-DD
    balance    INTEGER,                       -- остаток на конец дня
    sales      INTEGER,                       -- продано штук
    price      REAL,                          -- цена продажи, ₽
    revenue    REAL,                          -- выручка за день, ₽
    source     TEXT NOT NULL DEFAULT 'mpstats',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (wb, date, source)
  );
  CREATE INDEX IF NOT EXISTS idx_sku_daily_date ON sku_daily(date);

  -- Снимок готового отчёта за период.
  CREATE TABLE IF NOT EXISTS report_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,                -- 'stock-availability'
    d1          TEXT NOT NULL,
    d2          TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    totals_json TEXT                          -- сводка totals (JSON)
  );
  CREATE INDEX IF NOT EXISTS idx_report_runs_kind ON report_runs(kind, created_at);

  CREATE TABLE IF NOT EXISTS report_rows (
    run_id       INTEGER NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
    wb           INTEGER NOT NULL,
    seller       TEXT,
    metrics_json TEXT NOT NULL,               -- вся строка отчёта (JSON) — гибко под разные отчёты
    PRIMARY KEY (run_id, wb)
  );

  -- Универсальный приёмник произвольных выгрузок из будущих инструментов.
  -- Позволяет начать складывать данные нового инструмента СРАЗУ, до того как
  -- под него спроектирована типизированная таблица.
  CREATE TABLE IF NOT EXISTS tool_exports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tool         TEXT NOT NULL,               -- имя инструмента-источника
    entity       TEXT,                        -- к чему относится (напр. WB SKU), опц.
    captured_at  TEXT NOT NULL,
    payload_json TEXT NOT NULL                -- произвольная структурированная выгрузка (JSON)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_exports ON tool_exports(tool, entity, captured_at);
  `,

  // v2 — слой Telegram-бота: пользователи, кэш вытяжек, сырые файлы отчётов,
  // склейка по цветам, прогоны скиллов и лениво отрендеренные форматы.
  // Аддитивно к v1: существующие таблицы не трогаем.
  `
  -- Пользователи бота. Один кабинет WB на всех; разграничение по роли и
  -- персональная выдача по telegram_id.
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    name        TEXT,
    role        TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'admin'
    created_at  TEXT NOT NULL
  );

  -- Пер-пользовательские настройки/пресеты (бренды, наш арт. по умолчанию…).
  CREATE TABLE IF NOT EXISTS user_settings (
    telegram_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT,
    PRIMARY KEY (telegram_id, key)
  );

  -- Слой 1 кэша: атомарные вытяжки из источников. Дедуп по (source, key_hash).
  -- expires_at        — валидность НАШЕГО кэша (NULL = бессрочно, напр. закрытый период).
  -- source_expires_at — когда сгорит доступ у ИСТОЧНИКА (напр. 72 ч у WB-отчёта).
  CREATE TABLE IF NOT EXISTS source_cache (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    source            TEXT NOT NULL,            -- 'mpstats.search' | 'wb.sales' | 'wb.cards-compare' | 'wb.card'
    key_hash          TEXT NOT NULL,            -- sha256(канонизированный key_json)
    key_json          TEXT NOT NULL,            -- читаемый ключ (phrase/d1/d2/…)
    entity            TEXT,                     -- к чему относится (nmId / фраза), опц.
    captured_at       TEXT NOT NULL,
    expires_at        TEXT,                     -- NULL = бессрочно
    source_expires_at TEXT,                     -- NULL = у источника не сгорает
    cost_units        REAL NOT NULL DEFAULT 0,  -- сколько лимита стоила вытяжка (телеметрия)
    payload_json      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_source_cache_key ON source_cache(source, key_hash);
  CREATE INDEX IF NOT EXISTS idx_source_cache_entity ON source_cache(source, entity, captured_at);

  -- Сырые файлы отчётов (BLOB) — чтобы пережить истечение доступа у источника
  -- (правило 72 ч). Пока БД коммитится в git, BLOB едет вместе с ней.
  CREATE TABLE IF NOT EXISTS report_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,                  -- откуда файл (напр. 'wb.cards-compare')
    entity      TEXT,                           -- к чему относится
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       BLOB NOT NULL,
    captured_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_report_files ON report_files(source, entity, captured_at);

  -- Склейка по цветам: все цветовые варианты одной карточки делят imt_id.
  -- Позволяет реюзать нишевый слой анализа между цветами одной склейки.
  CREATE TABLE IF NOT EXISTS card_variants (
    imt_id     INTEGER NOT NULL,
    nm_id      INTEGER NOT NULL,
    color      TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (imt_id, nm_id)
  );
  CREATE INDEX IF NOT EXISTS idx_card_variants_nm ON card_variants(nm_id);

  -- Прогоны скиллов: снимок отчёта (result_json) + статус для FSM/очереди.
  -- Индексация по (skill, params_hash) — дедуп и реюз одинаковых запросов.
  CREATE TABLE IF NOT EXISTS skill_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id  INTEGER,                       -- владелец (персональная выдача)
    skill        TEXT NOT NULL,
    params_json  TEXT NOT NULL,
    params_hash  TEXT NOT NULL,
    status       TEXT NOT NULL,                 -- queued|running|awaiting_user|done|error
    started_at   TEXT,
    finished_at  TEXT,
    result_json  TEXT,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_skill_runs_dedup ON skill_runs(skill, params_hash, status);
  CREATE INDEX IF NOT EXISTS idx_skill_runs_owner ON skill_runs(telegram_id, skill, finished_at);

  -- Лениво отрендеренные форматы отчёта (кэш): HTML/PDF/XLSX на прогон.
  CREATE TABLE IF NOT EXISTS skill_artifacts (
    run_id     INTEGER NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
    format     TEXT NOT NULL,                   -- 'html'|'pdf'|'xlsx'
    file_id    INTEGER REFERENCES report_files(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, format)
  );
  `,

  // v3 — персист состояния диалога (FSM) grammY. Ключ — chat/user, значение —
  // сериализованная сессия. Диалоги переживают рестарт бота.
  `
  CREATE TABLE IF NOT EXISTS bot_sessions (
    key        TEXT PRIMARY KEY,               -- напр. '<chatId>' или '<chatId>:<userId>'
    data_json  TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

/** Прогоняет ещё не применённые миграции; версия — в PRAGMA user_version. */
export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
  }
  return MIGRATIONS.length;
}

// ─────────────────────────── запись ───────────────────────────

const nowIso = () => new Date().toISOString();

/** Upsert справочника товаров из items [{wb, seller}]. */
export function syncProducts(db, items = []) {
  const stmt = db.prepare(
    `INSERT INTO products (wb, seller, updated_at) VALUES (@wb, @seller, @updated_at)
     ON CONFLICT(wb) DO UPDATE SET seller = excluded.seller, updated_at = excluded.updated_at`
  );
  const at = nowIso();
  const run = db.transaction((rows) => {
    for (const it of rows) {
      const wb = Number(it.wb);
      if (!Number.isFinite(wb)) continue;
      stmt.run({ wb, seller: String(it.seller || ''), updated_at: at });
    }
  });
  run(items);
  return items.length;
}

/** Upsert линеек и их состава из groups { метка: [wb, …] }. */
export function syncGroups(db, groups = {}) {
  const insGroup = db.prepare(`INSERT OR IGNORE INTO groups (name) VALUES (?)`);
  const clearLinks = db.prepare(`DELETE FROM product_groups WHERE group_name = ?`);
  // Заглушка товара на случай, если группа ссылается на WB, которого ещё нет
  // в справочнике (рассогласование groups.json/skus.json не должно ронять БД).
  const insStub = db.prepare(
    `INSERT OR IGNORE INTO products (wb, seller, updated_at) VALUES (?, '', ?)`
  );
  const insLink = db.prepare(
    `INSERT OR IGNORE INTO product_groups (group_name, wb) VALUES (?, ?)`
  );
  const at = nowIso();
  const run = db.transaction((g) => {
    for (const [name, list] of Object.entries(g)) {
      insGroup.run(name);
      clearLinks.run(name); // состав задаётся конфигом целиком — пересобираем
      for (const wb of list || []) {
        const n = Number(wb);
        if (!Number.isFinite(n)) continue;
        insStub.run(n, at); // гарантируем наличие товара до связывания (FK)
        insLink.run(name, n);
      }
    }
  });
  run(groups);
  return Object.keys(groups).length;
}

/**
 * Upsert дневного ряда по одному SKU.
 * @param {number|string} wb
 * @param {Array<{date,balance,sales,price,revenue}>} daily
 * @param {string} [source]
 * @returns {number} число записанных дней
 */
export function saveSkuDaily(db, wb, daily = [], source = 'mpstats') {
  const stmt = db.prepare(
    `INSERT INTO sku_daily (wb, date, balance, sales, price, revenue, source, updated_at)
     VALUES (@wb, @date, @balance, @sales, @price, @revenue, @source, @updated_at)
     ON CONFLICT(wb, date, source) DO UPDATE SET
       balance = excluded.balance, sales = excluded.sales,
       price = excluded.price, revenue = excluded.revenue,
       updated_at = excluded.updated_at`
  );
  const at = nowIso();
  const n = Number(wb);
  const run = db.transaction((rows) => {
    let count = 0;
    for (const r of rows) {
      if (!r || !r.date) continue;
      stmt.run({
        wb: n,
        date: String(r.date).slice(0, 10),
        balance: r.balance ?? null,
        sales: r.sales ?? null,
        price: r.price ?? null,
        revenue: r.revenue ?? null,
        source,
        updated_at: at,
      });
      count++;
    }
    return count;
  });
  return run(daily);
}

/**
 * Сохраняет снимок отчёта: report_runs + report_rows. Возвращает id запуска.
 * Метрики каждой строки кладём как JSON — схема отчёта может меняться, а
 * таблица останется прежней.
 */
export function saveReport(db, report, { kind = 'stock-availability' } = {}) {
  const insRun = db.prepare(
    `INSERT INTO report_runs (kind, d1, d2, created_at, totals_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insRow = db.prepare(
    `INSERT INTO report_rows (run_id, wb, seller, metrics_json)
     VALUES (@run_id, @wb, @seller, @metrics_json)
     ON CONFLICT(run_id, wb) DO UPDATE SET
       seller = excluded.seller, metrics_json = excluded.metrics_json`
  );
  const at = nowIso();
  const run = db.transaction(() => {
    const info = insRun.run(
      kind,
      report?.period?.d1 || '',
      report?.period?.d2 || '',
      at,
      JSON.stringify(report?.totals || {})
    );
    const runId = info.lastInsertRowid;
    for (const r of report?.rows || []) {
      const wb = Number(r.sku ?? r.wb);
      if (!Number.isFinite(wb)) continue;
      insRow.run({
        run_id: runId,
        wb,
        seller: r.seller || '',
        metrics_json: JSON.stringify(r),
      });
    }
    return runId;
  });
  return run();
}

/**
 * Складывает произвольную выгрузку инструмента в универсальный приёмник.
 * Точка входа для будущих инструментов: пишем сюда JSON, типизацию добавим позже.
 */
export function saveToolExport(db, { tool, entity = null, payload }) {
  if (!tool) throw new Error('saveToolExport: не задан tool');
  return db
    .prepare(
      `INSERT INTO tool_exports (tool, entity, captured_at, payload_json)
       VALUES (?, ?, ?, ?)`
    )
    .run(tool, entity, nowIso(), JSON.stringify(payload ?? null)).lastInsertRowid;
}

// ─────────────────────────── чтение ───────────────────────────

/** Дневной ряд по SKU за период [d1, d2] (или весь, если период не задан). */
export function getSkuDaily(db, wb, d1, d2, source = 'mpstats') {
  if (d1 && d2) {
    return db
      .prepare(
        `SELECT date, balance, sales, price, revenue FROM sku_daily
         WHERE wb = ? AND source = ? AND date BETWEEN ? AND ? ORDER BY date`
      )
      .all(Number(wb), source, d1, d2);
  }
  return db
    .prepare(
      `SELECT date, balance, sales, price, revenue FROM sku_daily
       WHERE wb = ? AND source = ? ORDER BY date`
    )
    .all(Number(wb), source);
}

/** Последний сохранённый отчёт заданного типа (шапка + разобранные строки). */
export function latestReport(db, kind = 'stock-availability') {
  const runRow = db
    .prepare(
      `SELECT * FROM report_runs WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(kind);
  if (!runRow) return null;
  const rows = db
    .prepare(`SELECT wb, seller, metrics_json FROM report_rows WHERE run_id = ?`)
    .all(runRow.id)
    .map((r) => ({ wb: r.wb, seller: r.seller, ...JSON.parse(r.metrics_json) }));
  return {
    id: runRow.id,
    kind: runRow.kind,
    period: { d1: runRow.d1, d2: runRow.d2 },
    createdAt: runRow.created_at,
    totals: runRow.totals_json ? JSON.parse(runRow.totals_json) : {},
    rows,
  };
}

/** Короткая сводка о содержимом БД — для CLI/health. */
export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  const daily = one(
    `SELECT COUNT(*) AS rows, COUNT(DISTINCT wb) AS skus,
            MIN(date) AS from_date, MAX(date) AS to_date FROM sku_daily`
  );
  return {
    products: one(`SELECT COUNT(*) AS n FROM products`).n,
    groups: one(`SELECT COUNT(*) AS n FROM groups`).n,
    skuDailyRows: daily.rows,
    skuDailyDistinct: daily.skus,
    skuDailyRange: daily.from_date ? { from: daily.from_date, to: daily.to_date } : null,
    reportRuns: one(`SELECT COUNT(*) AS n FROM report_runs`).n,
    toolExports: one(`SELECT COUNT(*) AS n FROM tool_exports`).n,
    // v2 — слой бота (таблицы появляются после миграции v2)
    users: one(`SELECT COUNT(*) AS n FROM users`).n,
    sourceCache: one(`SELECT COUNT(*) AS n FROM source_cache`).n,
    reportFiles: one(`SELECT COUNT(*) AS n FROM report_files`).n,
    cardVariants: one(`SELECT COUNT(*) AS n FROM card_variants`).n,
    skillRuns: one(`SELECT COUNT(*) AS n FROM skill_runs`).n,
  };
}

// ═══════════════════════ v2 — слой Telegram-бота ═══════════════════════

/**
 * Глубокая сортировка ключей объекта → стабильная сериализация. Нужна, чтобы
 * один и тот же логический ключ/набор параметров давал один и тот же hash
 * независимо от порядка полей.
 */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .reduce((o, k) => {
        o[k] = sortDeep(v[k]);
        return o;
      }, {});
  }
  return v;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Канонический ключ вытяжки: {keyJson, keyHash}. */
export function cacheKey(obj) {
  const keyJson = JSON.stringify(sortDeep(obj ?? {}));
  return { keyJson, keyHash: sha256(keyJson) };
}

// ─────────────── Слой 1: кэш атомарных вытяжек ───────────────

/**
 * Достаёт вытяжку из кэша, если она ещё свежа (expires_at в будущем или NULL).
 * @returns {null | {id, payload, entity, capturedAt, expiresAt, sourceExpiresAt, costUnits}}
 */
export function cacheGet(db, source, key) {
  const { keyHash } = cacheKey(key);
  const row = db
    .prepare(`SELECT * FROM source_cache WHERE source = ? AND key_hash = ?`)
    .get(source, keyHash);
  if (!row) return null;
  if (row.expires_at && row.expires_at < nowIso()) return null; // наш кэш протух
  return {
    id: row.id,
    payload: JSON.parse(row.payload_json),
    entity: row.entity,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    sourceExpiresAt: row.source_expires_at,
    costUnits: row.cost_units,
  };
}

/** Кладёт/обновляет вытяжку в кэш (upsert по source+key_hash). Возвращает id. */
export function cachePut(
  db,
  { source, key, entity = null, payload, expiresAt = null, sourceExpiresAt = null, costUnits = 0 }
) {
  if (!source) throw new Error('cachePut: не задан source');
  const { keyJson, keyHash } = cacheKey(key);
  return db
    .prepare(
      `INSERT INTO source_cache
         (source, key_hash, key_json, entity, captured_at, expires_at, source_expires_at, cost_units, payload_json)
       VALUES (@source, @key_hash, @key_json, @entity, @captured_at, @expires_at, @source_expires_at, @cost_units, @payload_json)
       ON CONFLICT(source, key_hash) DO UPDATE SET
         key_json = excluded.key_json, entity = excluded.entity, captured_at = excluded.captured_at,
         expires_at = excluded.expires_at, source_expires_at = excluded.source_expires_at,
         cost_units = excluded.cost_units, payload_json = excluded.payload_json`
    )
    .run({
      source,
      key_hash: keyHash,
      key_json: keyJson,
      entity,
      captured_at: nowIso(),
      expires_at: expiresAt,
      source_expires_at: sourceExpiresAt,
      cost_units: costUnits,
      payload_json: JSON.stringify(payload ?? null),
    }).lastInsertRowid;
}

// ─────────────── Сырые файлы отчётов (правило 72 ч) ───────────────

/** Сохраняет сырой файл отчёта (BLOB). bytes — Buffer/Uint8Array. Возвращает id. */
export function saveReportFile(db, { source, entity = null, filename, mime, bytes }) {
  if (!source || !filename) throw new Error('saveReportFile: нужны source и filename');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return db
    .prepare(
      `INSERT INTO report_files (source, entity, filename, mime, bytes, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(source, entity, filename, String(mime || 'application/octet-stream'), buf, nowIso())
    .lastInsertRowid;
}

/** Файл отчёта по id (с BLOB). */
export function getReportFile(db, id) {
  const row = db.prepare(`SELECT * FROM report_files WHERE id = ?`).get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    entity: row.entity,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    capturedAt: row.captured_at,
  };
}

/** Метаданные последнего файла по источнику/сущности (без BLOB — для листинга). */
export function latestReportFileMeta(db, source, entity = null) {
  const sql = entity
    ? `SELECT id, source, entity, filename, mime, captured_at FROM report_files
       WHERE source = ? AND entity = ? ORDER BY captured_at DESC, id DESC LIMIT 1`
    : `SELECT id, source, entity, filename, mime, captured_at FROM report_files
       WHERE source = ? ORDER BY captured_at DESC, id DESC LIMIT 1`;
  return (entity ? db.prepare(sql).get(source, entity) : db.prepare(sql).get(source)) || null;
}

// ─────────────── Склейка по цветам (imtID) ───────────────

/** Upsert склейки: imtId + [{nmId, color}]. Возвращает число записей. */
export function saveCardVariants(db, imtId, variants = []) {
  const stmt = db.prepare(
    `INSERT INTO card_variants (imt_id, nm_id, color, updated_at)
     VALUES (@imt_id, @nm_id, @color, @updated_at)
     ON CONFLICT(imt_id, nm_id) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`
  );
  const at = nowIso();
  const imt = Number(imtId);
  const run = db.transaction((rows) => {
    let n = 0;
    for (const v of rows) {
      const nm = Number(v.nmId ?? v.nm_id);
      if (!Number.isFinite(nm)) continue;
      stmt.run({ imt_id: imt, nm_id: nm, color: v.color ?? null, updated_at: at });
      n++;
    }
    return n;
  });
  return run(variants);
}

/** Все «братья» по склейке для nmId (включая его самого), если склейка известна. */
export function getCardSiblings(db, nmId) {
  const self = db.prepare(`SELECT imt_id FROM card_variants WHERE nm_id = ?`).get(Number(nmId));
  if (!self) return [];
  return db
    .prepare(`SELECT nm_id, color FROM card_variants WHERE imt_id = ? ORDER BY nm_id`)
    .all(self.imt_id)
    .map((r) => ({ nmId: r.nm_id, color: r.color }));
}

// ─────────────── Пользователи и настройки ───────────────

/** Upsert пользователя бота (имя не затираем на null). */
export function upsertUser(db, { telegramId, name = null, role = 'user' }) {
  db.prepare(
    `INSERT INTO users (telegram_id, name, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET name = COALESCE(excluded.name, users.name)`
  ).run(Number(telegramId), name, role, nowIso());
  return Number(telegramId);
}

export function getUser(db, telegramId) {
  return (
    db
      .prepare(`SELECT telegram_id, name, role, created_at FROM users WHERE telegram_id = ?`)
      .get(Number(telegramId)) || null
  );
}

export function setUserSetting(db, telegramId, key, value) {
  db.prepare(
    `INSERT INTO user_settings (telegram_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, key) DO UPDATE SET value = excluded.value`
  ).run(Number(telegramId), key, value == null ? null : String(value));
}

export function getUserSetting(db, telegramId, key) {
  const row = db
    .prepare(`SELECT value FROM user_settings WHERE telegram_id = ? AND key = ?`)
    .get(Number(telegramId), key);
  return row ? row.value : null;
}

// ─────────────── Прогоны скиллов (Слой 2) ───────────────

/** Хэш прогона: стабилен по (skill, params) независимо от порядка полей. */
export function runHash(skill, params) {
  return sha256(skill + '|' + JSON.stringify(sortDeep(params ?? {})));
}

/**
 * Создаёт прогон скилла. Возвращает {id, paramsHash}.
 * started_at проставляется, если статус сразу 'running'.
 */
export function createRun(db, { telegramId = null, skill, params, status = 'queued' }) {
  if (!skill) throw new Error('createRun: не задан skill');
  const paramsJson = JSON.stringify(sortDeep(params ?? {}));
  const paramsHash = runHash(skill, params);
  const info = db
    .prepare(
      `INSERT INTO skill_runs (telegram_id, skill, params_json, params_hash, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      telegramId == null ? null : Number(telegramId),
      skill,
      paramsJson,
      paramsHash,
      status,
      status === 'running' ? nowIso() : null
    );
  return { id: Number(info.lastInsertRowid), paramsHash };
}

/** Меняет статус/поля прогона (частичное обновление). */
export function updateRun(db, id, { status, result, error, startedAt, finishedAt } = {}) {
  const cur = db.prepare(`SELECT * FROM skill_runs WHERE id = ?`).get(Number(id));
  if (!cur) return null;
  db.prepare(
    `UPDATE skill_runs SET status = @status, result_json = @result_json, error = @error,
       started_at = @started_at, finished_at = @finished_at WHERE id = @id`
  ).run({
    id: Number(id),
    status: status ?? cur.status,
    result_json: result !== undefined ? JSON.stringify(result) : cur.result_json,
    error: error !== undefined ? error : cur.error,
    started_at: startedAt !== undefined ? startedAt : cur.started_at,
    finished_at: finishedAt !== undefined ? finishedAt : cur.finished_at,
  });
  return Number(id);
}

/** Завершает прогон: done (result) или error (error) + finished_at. */
export function finishRun(db, id, { result = null, error = null } = {}) {
  return updateRun(db, id, { status: error ? 'error' : 'done', result, error, finishedAt: nowIso() });
}

export function getRun(db, id) {
  const row = db.prepare(`SELECT * FROM skill_runs WHERE id = ?`).get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    telegramId: row.telegram_id,
    skill: row.skill,
    params: JSON.parse(row.params_json),
    paramsHash: row.params_hash,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
  };
}

/**
 * Реюз: последний успешный прогон с тем же (skill, params). Если задан maxAgeMs —
 * старые прогоны отсекаются.
 */
export function findReusableRun(db, { skill, params, maxAgeMs = null }) {
  const paramsHash = runHash(skill, params);
  const row = db
    .prepare(
      `SELECT * FROM skill_runs WHERE skill = ? AND params_hash = ? AND status = 'done'
       ORDER BY finished_at DESC, id DESC LIMIT 1`
    )
    .get(skill, paramsHash);
  if (!row) return null;
  if (maxAgeMs && row.finished_at) {
    const age = Date.parse(nowIso()) - Date.parse(row.finished_at);
    if (Number.isFinite(age) && age > maxAgeMs) return null;
  }
  return {
    id: row.id,
    skill: row.skill,
    telegramId: row.telegram_id,
    params: JSON.parse(row.params_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    finishedAt: row.finished_at,
  };
}

// ─────────────── Артефакты формата (лениво отрендеренные) ───────────────

/** Привязывает отрендеренный формат к прогону (upsert по run+format). */
export function saveArtifact(db, runId, format, fileId) {
  db.prepare(
    `INSERT INTO skill_artifacts (run_id, format, file_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id, format) DO UPDATE SET file_id = excluded.file_id, created_at = excluded.created_at`
  ).run(Number(runId), format, fileId == null ? null : Number(fileId), nowIso());
}

/** Метаданные отрендеренного формата (run_id, format, file_id), если кэширован. */
export function getArtifact(db, runId, format) {
  return (
    db
      .prepare(
        `SELECT run_id, format, file_id, created_at FROM skill_artifacts WHERE run_id = ? AND format = ?`
      )
      .get(Number(runId), format) || null
  );
}

// ─────────────── Сессии диалога (FSM grammY) ───────────────

/** Читает сессию по ключу (или undefined). */
export function sessionGet(db, key) {
  const row = db.prepare(`SELECT data_json FROM bot_sessions WHERE key = ?`).get(String(key));
  return row ? JSON.parse(row.data_json) : undefined;
}

/** Пишет/обновляет сессию (upsert). */
export function sessionSet(db, key, value) {
  db.prepare(
    `INSERT INTO bot_sessions (key, data_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).run(String(key), JSON.stringify(value ?? null), nowIso());
}

/** Удаляет сессию. */
export function sessionDelete(db, key) {
  db.prepare(`DELETE FROM bot_sessions WHERE key = ?`).run(String(key));
}
