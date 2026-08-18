// report-burned-matrix.mjs — матрица потерь NMID × склад (шт) + сумма × себестоимость.
//
// Источник количеств: warehouse_remains (текущий пул) + последний снимок report:fire
// (по складам, которые WB уже обнулил после пожара — Коледино и др.). По каждой паре
// (NMID, склад) берётся пик остатков = max(сейчас, снимок). Список сгоревших складов —
// из config/fire-warehouses.json (собран по открытым источникам).
//
// Выход: reports-output/burned-matrix-<ts>.json (+ .csv). Из него собираются xlsx и pdf.
//
// Запуск: WB_API_TOKEN=xxx node report-burned-matrix.mjs [--cost 620]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './lib/wbClient.js';
import { resolveWbToken, resolveTokenType } from './lib/wbToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCfg() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'fire-warehouses.json'), 'utf8')); }
const matchBurned = (name, pats) => { const n = String(name).toLowerCase(); return pats.some((p) => n.includes(String(p).toLowerCase())); };
function latestFireLosses(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^fire-losses-.*\.json$/.test(f))
      .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? JSON.parse(fs.readFileSync(files[0], 'utf8')) : null;
  } catch (_) { return null; }
}
// "Склад:12; Другой склад:3" → [[name,qty],...]
function parseWhString(s) {
  return String(s || '').split(';').map((t) => t.trim()).filter(Boolean).map((t) => {
    const i = t.lastIndexOf(':');
    return [t.slice(0, i).trim(), Number(t.slice(i + 1)) || 0];
  });
}

// Персистентный peak-ledger (коммитится в git, переживает эфемерный контейнер).
// Хранит пик остатков по каждой ячейке NMID×склад — чтобы потери, которые WB уже
// списал, не терялись между запусками. Формат:
//   { updatedAt, cost, meta:{nmId:{vendorCode,brand,subjectName}}, cells:{"nmId|склад":qty}, history:[...] }
const LEDGER = () => path.join(__dirname, 'snapshots', 'peak-ledger.json');
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER(), 'utf8')); } catch (_) { return null; }
}
function saveLedger(M, cost, snapshotAt, grandQty, grandSumRub, whCount) {
  const meta = {}, cells = {};
  for (const r of M.values()) {
    meta[r.nmId] = { vendorCode: r.vendorCode, brand: r.brand, subjectName: r.subjectName };
    for (const [name, q] of r.wh) if (q > 0) cells[`${r.nmId}|${name}`] = q;
  }
  const prev = loadLedger();
  const history = (prev?.history || []).filter((h) => h.date !== snapshotAt.slice(0, 10));
  history.push({ date: snapshotAt.slice(0, 10), grandQty, grandSumRub, warehouses: whCount });
  history.sort((a, b) => a.date.localeCompare(b.date));
  const dir = path.join(__dirname, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER(), JSON.stringify({ updatedAt: snapshotAt, cost, meta, cells, history }, null, 2));
}

async function fetchFbo(wb) {
  const create = await wb.get('analytics', '/api/v1/warehouse_remains', {
    query: { locale: 'ru', groupByNm: true, groupBySa: true, groupByBrand: true, groupBySubject: true },
    methodLimit: { limit: 1, periodSec: 60, burst: 5 },
  });
  const taskId = create.data?.data?.taskId;
  if (!taskId) throw new Error('нет taskId');
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('таймаут');
    await sleep(6000);
    const st = await wb.get('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/status`, { methodLimit: { limit: 1, periodSec: 5, burst: 5 } });
    const s = st.data?.data?.status; log('  FBO статус:', s);
    if (s === 'done') break;
    if (['canceled', 'purged', 'error'].includes(s)) throw new Error('remains: ' + s);
  }
  const dl = await wb.get('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/download`, { methodLimit: { limit: 1, periodSec: 5, burst: 5 } });
  return dl.data;
}

async function main() {
  const cost = Number((process.argv.includes('--cost') ? process.argv[process.argv.indexOf('--cost') + 1] : 0)) || Number(loadCfg().avgCostRub) || 620;
  const pats = loadCfg().patterns;
  const { token } = resolveWbToken();
  if (!token) { log('нет токена'); process.exit(2); }
  const wb = new WbClient({ token, tokenType: resolveTokenType() });

  // nmId -> { meta, wh: Map(name->qty) }
  const M = new Map();
  const ensure = (nmId, meta) => {
    if (!M.has(nmId)) M.set(nmId, { nmId, vendorCode: '', brand: '', subjectName: '', wh: new Map() });
    const r = M.get(nmId);
    for (const k of ['vendorCode', 'brand', 'subjectName']) if (!r[k] && meta[k]) r[k] = meta[k];
    return r;
  };
  const bump = (r, name, qty) => { if (qty > 0) r.wh.set(name, Math.max(r.wh.get(name) || 0, qty)); };

  log('→ тяну warehouse_remains (текущий)…');
  const items = await fetchFbo(wb);
  for (const it of items) {
    const r = ensure(it.nmId, { vendorCode: it.vendorCode, brand: it.brand, subjectName: it.subjectName });
    for (const w of (it.warehouses || [])) if (matchBurned(w.warehouseName, pats)) bump(r, w.warehouseName, Number(w.quantity) || 0);
  }

  const hist = latestFireLosses(path.join(__dirname, 'reports-output'));
  if (hist) {
    log(`→ мерж со снимком ${new Date(hist.snapshotAt).toLocaleDateString('ru-RU')} (обнулённые склады)…`);
    for (const a of hist.articles) {
      const r = ensure(a.nmId, { vendorCode: a.vendorCode, brand: a.brand, subjectName: a.subjectName });
      for (const [name, qty] of parseWhString(a.warehouses)) if (matchBurned(name, pats)) bump(r, name, qty);
    }
  }

  // Персистентный ledger (переживает эфемерный контейнер): пик по ячейке из прошлых прогонов.
  const ledger = loadLedger();
  if (ledger) {
    log(`→ мерж с peak-ledger (обновлён ${String(ledger.updatedAt).slice(0, 10)}, ${Object.keys(ledger.cells || {}).length} ячеек)…`);
    for (const [key, qty] of Object.entries(ledger.cells || {})) {
      const i = key.lastIndexOf('|'); const nmId = Number(key.slice(0, i)); const name = key.slice(i + 1);
      if (!matchBurned(name, pats)) continue;
      const r = ensure(nmId, ledger.meta?.[nmId] || {});
      bump(r, name, qty);
    }
  }

  // Колонки-склады: все встреченные, по убыванию суммарного количества.
  const whTotals = new Map();
  for (const r of M.values()) for (const [n, q] of r.wh) whTotals.set(n, (whTotals.get(n) || 0) + q);
  const warehouses = [...whTotals.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);

  const rows = [...M.values()].map((r) => {
    const perWh = {}; let total = 0;
    for (const n of warehouses) { const q = r.wh.get(n) || 0; perWh[n] = q; total += q; }
    return { nmId: r.nmId, vendorCode: r.vendorCode, brand: r.brand, subjectName: r.subjectName, perWh, totalQty: total, sumRub: total * cost };
  }).filter((r) => r.totalQty > 0).sort((a, b) => b.sumRub - a.sumRub);

  const grandQty = rows.reduce((s, r) => s + r.totalQty, 0);
  const srcParts = ['warehouse_remains (сейчас)'];
  if (hist) srcParts.push(`снимок ${new Date(hist.snapshotAt).toLocaleDateString('ru-RU')}`);
  if (ledger) srcParts.push('peak-ledger');
  const out = {
    snapshotAt: new Date().toISOString(), cost,
    basis: srcParts.join(' + ') + ', пик по ячейке',
    warehouses, warehouseTotals: Object.fromEntries(warehouses.map((n) => [n, whTotals.get(n)])),
    rows, grandQty, grandSumRub: grandQty * cost,
  };

  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = out.snapshotAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `burned-matrix-${stamp}.json`), JSON.stringify(out, null, 2));

  // Обновляем персистентный ledger (пик по ячейке) — коммитится в git.
  saveLedger(M, cost, out.snapshotAt, grandQty, grandQty * cost, warehouses.length);
  log(`  peak-ledger обновлён: snapshots/peak-ledger.json`);

  // CSV (для быстрой проверки).
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['nmId', 'vendorCode', 'brand', 'subjectName', ...warehouses, 'Итого шт', 'Себестоимость', 'Сумма ₽'];
  const lines = [head.join(';')];
  for (const r of rows) lines.push([r.nmId, r.vendorCode, r.brand, r.subjectName, ...warehouses.map((n) => r.perWh[n] || 0), r.totalQty, cost, r.sumRub].map(esc).join(';'));
  fs.writeFileSync(path.join(dir, `burned-matrix-${stamp}.csv`), lines.join('\n'));

  log(`\nсклады: ${warehouses.length} · артикулов: ${rows.length} · всего: ${grandQty} ед · ${(grandQty * cost).toLocaleString('ru-RU')} ₽`);
  log(`сохранено: reports-output/burned-matrix-${stamp}.json / .csv`);
  process.stdout.write(path.join(dir, `burned-matrix-${stamp}.json`) + '\n');
}
main().catch((e) => { log('✗ ' + (e.stack || e.message)); process.exit(1); });
