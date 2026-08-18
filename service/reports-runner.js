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

// Дефолты формы подсорта. Числовые параметры (лид-тайм, запас, окна) — генерик, берём из
// общего config/replenishment.json. НО список артикулов оттуда НЕ берём: это ассортимент
// ОДНОГО продавца, и в мультитенанте он префилил бы форму кабинета B артикулами кабинета A.
// По умолчанию артикулы пустые (= все); каждый кабинет задаёт свой список в форме (он же
// восстанавливается из параметров последнего запуска).
let CFG_DEFAULTS = { articles: [], seedMin: 10, velocityDays: 28, leadMax: 18, leadMin: 12, cover: 28, historyDays: 90 };
try {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, 'config/replenishment.json'), 'utf8'));
  CFG_DEFAULTS = { ...CFG_DEFAULTS, ...c, articles: [] }; // числовые дефолты — да, артикулы — нет
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

// ── Движение заказов (принято/передано) ─────────────────────────────────────
export const movementDefaults = () => ({ days: 14, articles: '', tz: '+03:00' });
export function normalizeMovement(body = {}) {
  const days = Math.min(45, Math.max(1, Math.round(Number(body.days)) || 14));
  const articles = String(body.articles ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const tz = /^[+-]\d{2}:\d{2}$/.test(String(body.tz || '')) ? String(body.tz) : '+03:00';
  return { days, articles, tz };
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

// ── Пайплайн «Остатки»: fbs-stock → агрегация по артикулу+цвету ──────────────
function parseArt(vc) {
  const s = String(vc || '');
  const m = s.match(/^\s*(\d+)/);
  const num = m ? m[1] : '';
  const numInt = m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  let variant = s.slice(m ? m[0].length : 0).replace(/^[\s_\-/]+/, '').trim();
  if (!variant) variant = s;
  return { num, numInt, variant };
}
function buildStockSnapshot(raw) {
  const warehouses = (raw.warehouses || []).map((w) => ({ id: w.id, name: w.name, totalQuantity: w.totalQuantity || 0, skuInStock: w.skuInStock || 0 }))
    .sort((a, b) => b.totalQuantity - a.totalQuantity);
  const artMap = new Map();
  for (const w of raw.warehouses || []) {
    for (const p of w.positions || []) {
      if (!artMap.has(p.nmID)) { const a = parseArt(p.vendorCode); artMap.set(p.nmID, { nmID: p.nmID, vendorCode: p.vendorCode, articleNum: a.num, articleNumInt: a.numInt, variant: a.variant, byWarehouse: {}, total: 0 }); }
      const e = artMap.get(p.nmID); e.byWarehouse[w.name] = (e.byWarehouse[w.name] || 0) + p.amount; e.total += p.amount;
    }
  }
  const articles = [...artMap.values()].sort((a, b) => b.total - a.total || (a.articleNumInt - b.articleNumInt));
  const active = warehouses.filter((w) => w.totalQuantity > 0);
  return {
    generatedAt: new Date().toISOString(),
    warehouseList: active.map((w) => w.name),
    warehouses, articles,
    totals: { grandTotal: raw.grandTotalQuantity || warehouses.reduce((s, w) => s + w.totalQuantity, 0), warehouseCount: warehouses.length, activeWarehouses: active.length, articleCount: articles.length },
  };
}
function fakeStock() {
  return buildStockSnapshot({ grandTotalQuantity: 12, warehouses: [
    { id: 1, name: 'Тест-склад', totalQuantity: 12, skuInStock: 2, positions: [
      { sku: 'b1', nmID: 1, vendorCode: '002_чёрный', amount: 7 },
      { sku: 'b2', nmID: 2, vendorCode: '003_синий', amount: 5 }] }] });
}
async function runStockPipeline(cabinet, token, meta, params, onLog) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.PODSORT_FAKE) return fakeStock();
  const env = envFor(token, meta, dir);
  onLog?.('Получаю остатки по складам (fbs-stock)…');
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-stock.mjs'), '--json'], { env, cwd: REPO });
  if (r.code !== 0) throw new Error('Ошибка получения остатков (fbs-stock):\n' + tail(r.err));
  let raw; try { raw = JSON.parse(r.out); } catch { throw new Error('Не удалось разобрать остатки.'); }
  return buildStockSnapshot(raw);
}

// ── Пайплайн «Движение заказов»: fbs-movement (заказы+поставки) ──────────────
function fakeMovement(params) {
  const N = params.days || 14;
  const span = Math.min(88, 2 * N);
  const today = new Date();
  const days = [];
  for (let i = span - 1; i >= 0; i--) days.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  const cell = (c) => ({ count: c, money: c * 500, moneyAvg: c * 700, byFulfillment: c ? { 'Тест-склад': { count: c, money: c * 500, moneyAvg: c * 700 } } : {} });
  const series = days.map((date, idx) => ({ date, accepted: cell((idx + 1) * 2), delivered: cell(idx * 2) }));
  return { generatedAt: new Date().toISOString(), tz: '+03:00', today: days[days.length - 1], days: N, span,
    articles: params.articles || [], currency: '₽', avgSalePrice: 700, salesAvailable: true, fulfillments: ['Тест-склад'], series };
}
async function runMovementPipeline(cabinet, token, meta, params, onLog) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.PODSORT_FAKE) return fakeMovement(params);
  const env = envFor(token, meta, dir);
  onLog?.('Получаю заказы и поставки (fbs-movement)…');
  const args = [path.join(SCRIPTS, 'fbs-movement.mjs'), '--days', String(params.days), '--tz', params.tz, '--json'];
  if (params.articles?.length) args.push('--articles', params.articles.join(','));
  const r = await spawnCapture(process.execPath, args, { env, cwd: REPO, timeoutMs: 12 * 60_000 });
  if (r.code !== 0) throw new Error('Ошибка получения движения заказов (fbs-movement):\n' + tail(r.err));
  let snap; try { snap = JSON.parse(r.out); } catch { throw new Error('Не удалось разобрать движение заказов.'); }
  return snap;
}
function movementSummary(snap, p) {
  const N = p.days || snap.days || 14;
  const last = (snap.series || []).slice(-N);
  const acc = last.reduce((s, d) => s + (d.accepted?.count || 0), 0);
  const del = last.reduce((s, d) => s + (d.delivered?.count || 0), 0);
  const delMoney = last.reduce((s, d) => s + (d.delivered?.money || 0), 0);
  return { days: N, articles: p.articles || [], acceptedTotal: acc, deliveredTotal: del, diffTotal: del - acc, deliveredMoney: Math.round(delMoney) };
}

// ── Пайплайн «География продаж и возвратов» ──────────────────────────────────
export const geoDefaults = () => ({ days: 30 });
export function normalizeGeo(body = {}) {
  const days = [7, 14, 30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 30;
  return { days };
}
function fakeGeo(params) {
  const mk = (o, r, sc, rc) => ({ okrug: o, region: r, salesCount: sc, salesRub: sc * 1000, returnCount: rc, returnRub: rc * 1000, returnPct: sc ? Math.round(rc / sc * 1000) / 10 : 0 });
  const regions = [mk('Центральный федеральный округ', 'Москва', 100, 8), mk('Центральный федеральный округ', 'Московская область', 60, 3), mk('Сибирский федеральный округ', 'Омская область', 20, 4)];
  const okrugs = [mk('Центральный федеральный округ', '', 160, 11), mk('Сибирский федеральный округ', '', 20, 4)].map(({ region, ...x }) => x);
  const tot = (arr) => { const t = arr.reduce((a, r) => ({ salesCount: a.salesCount + r.salesCount, returnCount: a.returnCount + r.returnCount, salesRub: a.salesRub + r.salesRub, returnRub: a.returnRub + r.returnRub }), { salesCount: 0, returnCount: 0, salesRub: 0, returnRub: 0 }); t.regions = regions.length; t.returnPct = t.salesCount ? Math.round(t.returnCount / t.salesCount * 1000) / 10 : 0; return t; };
  const scope = { totals: tot(regions), byRegion: regions, byOkrug: okrugs };
  const fbs = {
    totals: { shipped: 80, salesCount: 60, returnCount: 13, returnPct: 21.7, salesRub: 60000, returnRub: 13000 },
    ordersByFF: { 'Мск зелёная зона': 50, 'Казань': 30 },
    byFF: [
      { ff: 'Казань', shipped: 30, salesCount: 20, returnCount: 8, returnPct: 40, salesRub: 20000, returnRub: 8000 },
      { ff: 'Мск зелёная зона', shipped: 50, salesCount: 40, returnCount: 5, returnPct: 12.5, salesRub: 40000, returnRub: 5000 },
    ],
    ffByRegion: [
      { ff: 'Казань', okrug: 'Центральный федеральный округ', region: 'Москва', salesCount: 10, returnCount: 8, returnPct: 80, salesRub: 10000, returnRub: 8000 },
      { ff: 'Мск зелёная зона', okrug: 'Центральный федеральный округ', region: 'Московская область', salesCount: 30, returnCount: 5, returnPct: 16.7, salesRub: 30000, returnRub: 5000 },
    ],
    byDay: [{ date: '2026-08-12', salesCount: 20, returnCount: 4 }, { date: '2026-08-13', salesCount: 22, returnCount: 5 }, { date: '2026-08-14', salesCount: 18, returnCount: 4 }],
    byArticle: [{ article: '014', ff: 'Казань', salesCount: 20, returnCount: 8, returnPct: 40, salesRub: 20000, returnRub: 8000 }, { article: '018', ff: 'Мск зелёная зона', salesCount: 40, returnCount: 5, returnPct: 12.5, salesRub: 40000, returnRub: 5000 }],
    unattributed: { salesCount: 0, returnCount: 0 },
  };
  return { generatedAt: new Date().toISOString(), days: params.days || 30, from: '2026-07-15', ordDays: 88, moscowWarehouses: ['Мск зелёная зона'], moscowNmCount: 2, scopes: { all: scope, moscow: scope }, fbs };
}
async function runGeoPipeline(cabinet, token, meta, params, onLog) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.PODSORT_FAKE) return fakeGeo(params);
  const env = envFor(token, meta, dir);
  onLog?.('Собираю продажи, возвраты и заказы (fbs-geo)…');
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-geo.mjs'), '--days', String(params.days), '--json'], { env, cwd: REPO, timeoutMs: 12 * 60_000 });
  if (r.code !== 0) throw new Error('Ошибка сбора географии (fbs-geo):\n' + tail(r.err));
  let snap; try { snap = JSON.parse(r.out); } catch { throw new Error('Не удалось разобрать географию.'); }
  return snap;
}
function geoSummary(snap, p) {
  const t = snap?.scopes?.all?.totals || {};
  return { days: p.days || snap.days || 30, salesCount: t.salesCount || 0, returnCount: t.returnCount || 0, returnPct: t.returnPct || 0, regions: t.regions || 0, salesRub: t.salesRub || 0 };
}
export function startGeo(cabinet, token, meta, params, userId) {
  return startRun({ cabinet, token, meta, params, userId, report: 'geo', pipeline: runGeoPipeline, summarize: geoSummary });
}
export async function buildGeoXlsx(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-geo-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture('python3', [path.join(SCRIPTS, 'fbs-geo-xlsx.py')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-geo.xlsx');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать Excel географии:\n' + tail(r.err));
  return out;
}
export async function buildGeoDashboardHtml(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-geo-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-geo-dashboard.mjs')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-geo-dashboard.html');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать HTML-дашборд географии:\n' + tail(r.err));
  return out;
}

// ── Пайплайн «Логистика» (сроки сборки и доставки по ФФ) ─────────────────────
export const logisticsDefaults = () => ({ days: 30 });
export function normalizeLogistics(body = {}) {
  const days = [7, 14, 30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 30;
  return { days };
}
function fakeLogistics(params) {
  const days = params.days || 30;
  const asmFF = [
    { ff: 'Мск зелёная зона', warehouseId: 1939911, made: 120, processed: 110, pending: 10, avgHours: 9.2, medianHours: 7.5, p90Hours: 20.1, maxHours: 51.3, criticalCount: 2 },
    { ff: 'Казань', warehouseId: 700, made: 60, processed: 55, pending: 5, avgHours: 14.6, medianHours: 12.0, p90Hours: 33.0, maxHours: 60.2, criticalCount: 3 },
  ];
  const delFF = [
    { ff: 'Мск зелёная зона', count: 90, avgHours: 62.4, medianHours: 58.0, p90Hours: 110.0, minHours: 18.0, maxHours: 190.0 },
    { ff: 'Казань', count: 40, avgHours: 88.7, medianHours: 84.0, p90Hours: 150.0, minHours: 30.0, maxHours: 240.0 },
  ];
  const delReg = [
    { okrug: 'Центральный федеральный округ', region: 'Москва', count: 70, avgHours: 40.2, medianHours: 36.0 },
    { okrug: 'Приволжский федеральный округ', region: 'Республика Татарстан', count: 30, avgHours: 30.5, medianHours: 28.0 },
    { okrug: 'Сибирский федеральный округ', region: 'Омская область', count: 30, avgHours: 150.0, medianHours: 144.0 },
  ];
  return {
    generatedAt: new Date().toISOString(), days, from: '2026-07-16', ordDays: 88, critAssemblyH: 48,
    assembly: {
      totals: { orders: 180, processed: 165, pending: 15, avgHours: 11.1, medianHours: 9.0, p90Hours: 26.0, criticalCount: 5 },
      byFF: asmFF, buckets: { '<6ч': 60, '6–24ч': 80, '24–48ч': 20, '>48ч': 5 },
      critical: [{ ff: 'Казань', article: '014', hours: 60.2, createdAt: '2026-08-10T08:00:00Z', closedAt: '2026-08-12T20:12:00Z' }],
    },
    delivery: {
      available: true,
      totals: { count: 130, joined: 135, avgHours: 70.5, medianHours: 64.0, p90Hours: 132.0 },
      byFF: delFF, byRegion: delReg, buckets: { '<2 сут': 40, '2–4 сут': 60, '4–7 сут': 20, '>7 сут': 10 },
      byDay: [{ date: '2026-08-12', count: 45, avgHours: 66.0 }, { date: '2026-08-13', count: 48, avgHours: 70.0 }, { date: '2026-08-14', count: 37, avgHours: 74.0 }],
    },
  };
}
async function runLogisticsPipeline(cabinet, token, meta, params, onLog) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.PODSORT_FAKE) return fakeLogistics(params);
  const env = envFor(token, meta, dir);
  onLog?.('Собираю заказы, поставки и выкупы (fbs-logistics)…');
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-logistics.mjs'), '--days', String(params.days), '--json'], { env, cwd: REPO, timeoutMs: 12 * 60_000 });
  if (r.code !== 0) throw new Error('Ошибка сбора логистики (fbs-logistics):\n' + tail(r.err));
  let snap; try { snap = JSON.parse(r.out); } catch { throw new Error('Не удалось разобрать логистику.'); }
  return snap;
}
function logisticsSummary(snap, p) {
  const a = snap?.assembly?.totals || {}; const d = snap?.delivery?.totals || {};
  return { days: p.days || snap.days || 30, asmMedianHours: a.medianHours || 0, asmProcessed: a.processed || 0, delMedianHours: d.medianHours || 0, delCount: d.count || 0 };
}
export function startLogistics(cabinet, token, meta, params, userId) {
  return startRun({ cabinet, token, meta, params, userId, report: 'logistics', pipeline: runLogisticsPipeline, summarize: logisticsSummary });
}
export async function buildLogisticsXlsx(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-logistics-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture('python3', [path.join(SCRIPTS, 'fbs-logistics-xlsx.py')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-logistics.xlsx');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать Excel логистики:\n' + tail(r.err));
  return out;
}
export async function buildLogisticsDashboardHtml(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-logistics-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-logistics-dashboard.mjs')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-logistics-dashboard.html');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать HTML-дашборд логистики:\n' + tail(r.err));
  return out;
}

// ── Single-flight + фоновый статус (ключ = кабинет:отчёт) ────────────────────
const jobs = new Map();
const jobKey = (cabinetId, report) => `${Number(cabinetId)}:${report}`;
export function getJob(cabinetId, report = 'podsort') { return jobs.get(jobKey(cabinetId, report)) || null; }

// Обобщённый фоновый запуск отчёта с сохранением в архив.
function startRun({ cabinet, token, meta, params, userId, report, pipeline, summarize }) {
  const id = Number(cabinet.id);
  const key = jobKey(id, report);
  const cur = jobs.get(key);
  if (cur && cur.state === 'running') return { already: true, job: cur };
  const ph = paramsHash(params);
  const job = { state: 'running', startedAt: Date.now(), finishedAt: null, error: null, log: 'старт…', paramsHash: ph };
  jobs.set(key, job);
  logger.info({ cabinetId: id, report }, 'отчёт: старт пересчёта');
  (async () => {
    try {
      const snap = await pipeline(cabinet, token, meta, params, (m) => { job.log = m; });
      ReportRuns.add({ cabinetId: id, report, paramsHash: ph, params, userId, summary: summarize(snap, params), snapshot: snap });
      job.state = 'done'; job.finishedAt = Date.now(); job.log = 'готово';
      logger.info({ cabinetId: id, report }, 'отчёт: готово, сохранено в архив');
    } catch (e) {
      job.state = 'error'; job.finishedAt = Date.now(); job.error = e.message; job.log = 'ошибка';
      logger.error({ cabinetId: id, report, err: e.message }, 'отчёт: ошибка');
    }
  })();
  return { already: false, job };
}

export function startPodsort(cabinet, token, meta, params, userId) {
  return startRun({ cabinet, token, meta, params, userId, report: 'podsort', pipeline: runPodsortPipeline,
    summarize: (snap, p) => { const t = snap?.totals || {}; return { reorderUnits: t.reorderUnits, riskRows: t.riskRows, seedUnits: t.seedUnits, warehouses: t.warehouses, nomenclature: t.nomenclature, pivotRows: t.pivotRows, articles: p.articles, leadMin: p.leadMin, leadMax: p.leadMax, cover: p.cover }; } });
}
export function startStock(cabinet, token, meta, params, userId) {
  return startRun({ cabinet, token, meta, params, userId, report: 'stock', pipeline: runStockPipeline,
    summarize: (snap) => { const t = snap?.totals || {}; return { grandTotal: t.grandTotal, activeWarehouses: t.activeWarehouses, articleCount: t.articleCount }; } });
}
export function startMovement(cabinet, token, meta, params, userId) {
  return startRun({ cabinet, token, meta, params, userId, report: 'movement', pipeline: runMovementPipeline, summarize: movementSummary });
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

// Excel по остаткам: пишем агрегированный снимок и запускаем python-генератор.
export async function buildStockXlsx(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-stock-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture('python3', [path.join(SCRIPTS, 'fbs-stock-xlsx.py')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-stock.xlsx');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать Excel остатков:\n' + tail(r.err));
  return out;
}

// Excel по движению заказов: пишем снимок и запускаем python-генератор.
export async function buildMovementXlsx(cabinet, snapshot, cost = 620) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-movement-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture('python3', [path.join(SCRIPTS, 'fbs-movement-xlsx.py')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir, COST_PER_UNIT: String(cost) }, cwd: REPO });
  const out = path.join(dir, 'fbs-movement.xlsx');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать Excel движения:\n' + tail(r.err));
  return out;
}

export async function buildDashboardHtml(cabinet, snapshot) {
  const dir = ensureSnapshotFile(cabinet, snapshot);
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-replenishment-dashboard.mjs')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-replenishment-dashboard.html');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать HTML-дашборд:\n' + tail(r.err));
  return out;
}

// HTML-дашборд остатков (тот же снимок, что и для Excel).
export async function buildStockDashboardHtml(cabinet, snapshot) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-stock-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-stock-dashboard.mjs')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir }, cwd: REPO });
  const out = path.join(dir, 'fbs-stock-dashboard.html');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать HTML-дашборд остатков:\n' + tail(r.err));
  return out;
}

// HTML-дашборд движения заказов (cost — себестоимость ₽/шт для оценки).
export async function buildMovementDashboardHtml(cabinet, snapshot, cost = 620) {
  const dir = cabinetDir(cabinet.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fbs-movement-service.json'), JSON.stringify(snapshot, null, 2));
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'fbs-movement-dashboard.mjs')], { env: { ...process.env, REPORTS_OUTPUT_DIR: dir, COST_PER_UNIT: String(cost) }, cwd: REPO });
  const out = path.join(dir, 'fbs-movement-dashboard.html');
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать HTML-дашборд движения:\n' + tail(r.err));
  return out;
}

// Рендер готовой HTML-страницы дашборда в PDF (встроенный Chromium).
export async function dashboardToPdf(htmlPath) {
  const out = htmlPath.replace(/\.html$/, '.pdf');
  // Альбомная — чтобы широкие таблицы (день × склад) не обрезались по правому краю.
  const r = await spawnCapture(process.execPath, [path.join(SCRIPTS, 'html-to-pdf.mjs'), htmlPath, out, '--landscape'], { env: process.env, cwd: REPO, timeoutMs: 3 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Не удалось собрать PDF:\n' + tail(r.err));
  return out;
}
