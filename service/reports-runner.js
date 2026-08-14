// service/reports-runner.js — запуск отчётных пайплайнов на токене кабинета.
// Подсорт: scripts/fbs-stock.mjs → scripts/fbs-replenishment.mjs, каждый в СВОЁМ
// каталоге кабинета (REPORTS_OUTPUT_DIR) и на его токене (WB_API_TOKEN в env).
// Запуск фоновый с single-flight: один кабинет — один активный пересчёт.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { logger } from './logger.js';
import { ReportRuns } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DATA = path.dirname(config.dbPath);
const SCRIPTS = path.join(REPO, 'scripts');

// Дефолты формы подсорта — из общего config/replenishment.json (если есть).
let CFG_DEFAULTS = { articles: [], seedMin: 10, velocityDays: 28, leadMax: 18, leadMin: 12, cover: 28, historyDays: 90 };
try {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, 'config/replenishment.json'), 'utf8'));
  CFG_DEFAULTS = { ...CFG_DEFAULTS, ...c, articles: c.articles || [] };
} catch { /* дефолты */ }
export const podsortDefaults = () => ({
  articles: (CFG_DEFAULTS.articles || []).join(', '),
  seedMin: CFG_DEFAULTS.seedMin, velocityDays: CFG_DEFAULTS.velocityDays,
  leadMax: CFG_DEFAULTS.leadMax, leadMin: CFG_DEFAULTS.leadMin,
  cover: CFG_DEFAULTS.cover, historyDays: CFG_DEFAULTS.historyDays,
});

// Нормализация параметров формы (с дефолтами и границами).
export function normalizePodsort(body = {}) {
  const int = (v, def, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  const arts = String(body.articles ?? podsortDefaults().articles)
    .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return {
    articles: arts,
    seedMin: int(body.seedMin, CFG_DEFAULTS.seedMin, 0, 1000),
    velocityDays: int(body.velocityDays, CFG_DEFAULTS.velocityDays, 1, 365),
    leadMax: int(body.leadMax, CFG_DEFAULTS.leadMax, 1, 120),
    leadMin: int(body.leadMin, CFG_DEFAULTS.leadMin, 1, 120),
    cover: int(body.cover, CFG_DEFAULTS.cover, 1, 365),
    historyDays: int(body.historyDays, CFG_DEFAULTS.historyDays, 7, 365),
  };
}

export const paramsHash = (params) => crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 16);

const cabinetDir = (cabinetId) => path.join(DATA, 'cabinets', String(cabinetId));

function tokenType(meta) {
  return ({ 1: 'base', 2: 'test', 3: 'personal', 4: 'service' })[meta?.acc] || 'personal';
}

function envFor(token, meta, dir) {
  return { ...process.env, WB_API_TOKEN: token, WB_TOKEN_TYPE: tokenType(meta), REPORTS_OUTPUT_DIR: dir };
}

function spawnCapture(cmd, args, { env, cwd, timeoutMs = 10 * 60_000 }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, cwd });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out, err: err + '\n' + e.message }); });
    p.on('close', (code) => { clearTimeout(to); resolve({ code, out, err }); });
  });
}

const replenishArgs = (params) => [
  path.join(SCRIPTS, 'fbs-replenishment.mjs'),
  '--articles', params.articles.join(','),
  '--seed-min', String(params.seedMin),
  '--velocity-days', String(params.velocityDays),
  '--lead', String(params.leadMax),
  '--lead-min', String(params.leadMin),
  '--cover', String(params.cover),
  '--history-days', String(params.historyDays),
];

// Фейковый снимок для тестов (PODSORT_FAKE=1) — без обращения к WB.
function fakeSnapshot(params) {
  return {
    generatedAt: new Date().toISOString(),
    params: { velocityDays: params.velocityDays, leadMin: params.leadMin, leadMax: params.leadMax, coverDays: params.cover, horizonDays: params.leadMax + params.cover, seedMin: params.seedMin, historyDays: params.historyDays, articles: params.articles },
    totals: { warehouses: 1, registeredWarehouses: 1, reorderUnits: 42, riskRows: 1, seedRows: 1, seedNovelty: 1, seedRefill: 0, seedUnits: 10, pivotRows: 1, nomenclature: 3 },
    warehouseList: ['Тест-склад'],
    warehouses: [{ warehouseId: 1, name: 'Тест-склад', stockUnits: 5, reorderUnits: 42, riskCount: 1,
      rows: [{ nmID: 1, barcode: 'bc1', articleNum: '002', articleNumInt: 2, variant: 'чёрный', techSize: 'M', sizeRank: -1, stock: 5, perDay: 1.5, daysToZero: 3.3, reorderQty: 42, status: 'риск разрыва' }] }],
    seedGrid: [{ nmID: 2, barcode: 'bc2', articleNum: '003', articleNumInt: 3, variant: 'синий', techSize: 'L', sizeRank: 0, kind: 'новинка', seedByWarehouse: { 'Тест-склад': 10 }, seedTotal: 10 }],
    pivot: [{ articleNum: '002', articleNumInt: 2, variant: 'чёрный', techSize: 'M', sizeRank: -1, byWarehouse: { 'Тест-склад': 42 }, total: 42 }],
  };
}

// ── Собственно пайплайн подсорта (stock → replenishment) ────────────────────
async function runPodsortPipeline(cabinet, token, meta, params, onLog) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });

  if (process.env.PODSORT_FAKE) {
    const snap = fakeSnapshot(params);
    fs.writeFileSync(path.join(dir, 'fbs-replenishment.json'), JSON.stringify(snap, null, 2));
    return snap;
  }

  const env = envFor(token, meta, dir);
  onLog?.('Шаг 1/2: остатки по складам (fbs-stock)…');
  const s1 = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-stock.mjs')], { env, cwd: REPO });
  if (s1.code !== 0) throw new Error('Ошибка получения остатков (fbs-stock):\n' + tail(s1.err));

  onLog?.('Шаг 2/2: расчёт подсорта (fbs-replenishment)…');
  const s2 = await spawnCapture(process.execPath, replenishArgs(params), { env, cwd: REPO });
  if (s2.code !== 0) throw new Error('Ошибка расчёта подсорта (fbs-replenishment):\n' + tail(s2.err));

  let snap;
  try { snap = JSON.parse(s2.out); }
  catch { throw new Error('Не удалось разобрать результат расчёта.'); }
  return snap;
}
const tail = (s, n = 1200) => String(s || '').slice(-n);

// ── Single-flight + фоновый статус на кабинет ───────────────────────────────
const jobs = new Map(); // cabinetId → { state, startedAt, finishedAt, error, log, paramsHash }

export function getJob(cabinetId) { return jobs.get(Number(cabinetId)) || null; }

export function startPodsort(cabinet, token, meta, params, userId) {
  const id = Number(cabinet.id);
  const cur = jobs.get(id);
  if (cur && cur.state === 'running') return { already: true, job: cur };

  const ph = paramsHash(params);
  const job = { state: 'running', startedAt: Date.now(), finishedAt: null, error: null, log: 'старт…', paramsHash: ph };
  jobs.set(id, job);
  logger.info({ cabinetId: id, params }, 'подсорт: старт пересчёта');

  (async () => {
    try {
      const snap = await runPodsortPipeline(cabinet, token, meta, params, (m) => { job.log = m; });
      const t = snap?.totals || {};
      const summary = {
        reorderUnits: t.reorderUnits, riskRows: t.riskRows, seedUnits: t.seedUnits,
        warehouses: t.warehouses, nomenclature: t.nomenclature, pivotRows: t.pivotRows,
        articles: params.articles, leadMin: params.leadMin, leadMax: params.leadMax, cover: params.cover,
      };
      ReportRuns.add({ cabinetId: id, report: 'podsort', paramsHash: ph, params, userId, summary, snapshot: snap });
      job.state = 'done'; job.finishedAt = Date.now(); job.log = 'готово';
      logger.info({ cabinetId: id, reorderUnits: t.reorderUnits }, 'подсорт: готово, сохранено в архив');
    } catch (e) {
      job.state = 'error'; job.finishedAt = Date.now(); job.error = e.message; job.log = 'ошибка';
      logger.error({ cabinetId: id, err: e.message }, 'подсорт: ошибка');
    }
  })();

  return { already: false, job };
}

// ── Артефакты для скачивания (по последнему снимку в каталоге кабинета) ──────
// Гарантируем наличие fbs-replenishment.json в каталоге, затем запускаем генератор.
function ensureSnapshotFile(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-replenishment.json'), JSON.stringify(snapshot, null, 2));
  return dir;
}

export async function buildXlsx(cabinet, snapshot) {
  const dir = ensureSnapshotFile(cabinet, snapshot);
  const r = await spawnCapture('python3', [path.join(SCRIPTS, 'fbs-xlsx.py')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-podsort.xlsx');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать Excel:\n' + tail(r.err));
  return out;
}

export async function buildDashboardHtml(cabinet, snapshot) {
  const dir = ensureSnapshotFile(cabinet, snapshot);
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-replenishment-dashboard.mjs')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-replenishment-dashboard.artifact.html');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать HTML-дашборд:\n' + tail(r.err));
  return out;
}
