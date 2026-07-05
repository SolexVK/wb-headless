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
  };
}
