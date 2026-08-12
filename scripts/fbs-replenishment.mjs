// scripts/fbs-replenishment.mjs — «дни до нуля» и рекомендации к дозаказу (FBS).
//
// По каждому артикулу+цвету (карточка nmID) считаем СУММАРНО по всем нашим
// складам: текущий остаток и скорость расхода (заказы в день за окно), делим →
// на сколько дней хватит. Ниже порога — риск out-of-stock; считаем, сколько
// дозаказать до целевого покрытия. Плюс показываем, ГДЕ физически лежит остаток
// (распределение по складам) — для решения о ребалансе.
//
// Почему суммарно по складам: остаток между нашими складами перемещается, а
// спрос исторически «привязан» к тому складу, что исполнял заказ. Поэтому разрез
// «склад×артикул» шумит (ложное «нет остатка»); надёжный сигнал к дозаказу —
// уровень артикула по всей сети складов.
//
//   npm run fbs:replenish
//   node scripts/fbs-replenishment.mjs --velocity-days 28 --target-days 14 --low 7 --json
//
// Данные: GET /api/v3/orders (спрос по nmID за окно) + снимок остатков
// reports-output/fbs-stock.json (npm run fbs:stock).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const VEL_DAYS = Number(arg('velocity-days', 28));
const TARGET_DAYS = Number(arg('target-days', 14));
const LOW = Number(arg('low', 7));
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };
let WH_NAME = {};
try { for (const w of JSON.parse(fs.readFileSync(path.join(REPO, 'config/warehouses.json'), 'utf8')).warehouses || []) WH_NAME[w.id] = w.name; } catch { /* */ }

// ── Остатки: per nmID (сумма по складам) + распределение по складам ──────────
if (!fs.existsSync(R('fbs-stock.json'))) { log('Нет reports-output/fbs-stock.json — сначала: npm run fbs:stock'); process.exit(1); }
const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const stockByNm = new Map();   // nmID → { vendorCode, total, byWh:{name:qty} }
for (const w of stock.warehouses || []) {
  for (const p of w.positions || []) {
    const e = stockByNm.get(p.nmID) || { vendorCode: p.vendorCode, total: 0, byWh: {} };
    e.total += p.amount; e.byWh[w.name] = (e.byWh[w.name] || 0) + p.amount;
    if (!e.vendorCode) e.vendorCode = p.vendorCode;
    stockByNm.set(p.nmID, e);
  }
}

// ── Спрос: заказы за окно, счётчик per nmID (сумма по складам) ───────────────
async function fetchOrders() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - VEL_DAYS * 86400;
  const orders = []; let next = 0;
  for (let p = 1; ; p++) {
    const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: fromSec, dateTo: nowSec }, methodLimit: MP });
    const b = data.orders || []; orders.push(...b);
    log(`  orders: стр.${p} +${b.length} (${orders.length})`);
    if (b.length < 1000) break; next = data.next;
  }
  return orders;
}
const orders = await fetchOrders();
const demandByNm = new Map();  // nmID → { count, vendor }
for (const o of orders) {
  const e = demandByNm.get(o.nmId) || { count: 0, vendor: o.article };
  e.count += 1; demandByNm.set(o.nmId, e);
}

// ── Свод по артикул+цвет (nmID) ─────────────────────────────────────────────
const nmIds = new Set([...stockByNm.keys(), ...demandByNm.keys()]);
const rows = [];
for (const nmID of nmIds) {
  const s = stockByNm.get(nmID);
  const d = demandByNm.get(nmID);
  const vendorCode = s?.vendorCode || d?.vendor || String(nmID);
  const stockQty = s?.total || 0;
  const ordered = d?.count || 0;
  const perDay = ordered / VEL_DAYS;
  const daysToZero = perDay > 0 ? stockQty / perDay : (stockQty > 0 ? Infinity : 0);
  const reorderQty = Math.max(0, Math.ceil(perDay * TARGET_DAYS - stockQty));
  const status = perDay === 0 ? (stockQty > 0 ? 'неликвид' : 'нет спроса')
    : (stockQty === 0 ? 'нет остатка' : (daysToZero <= LOW ? 'риск' : 'ок'));
  rows.push({
    nmID, vendorCode, stock: stockQty, orderedInWindow: ordered, perDay: +perDay.toFixed(2),
    daysToZero: daysToZero === Infinity ? null : +daysToZero.toFixed(1),
    reorderQty, status, stockByWarehouse: s?.byWh || {},
  });
}
const rank = { 'нет остатка': 0, 'риск': 1, 'ок': 2, 'неликвид': 3, 'нет спроса': 4 };
rows.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.daysToZero ?? 1e9) - (b.daysToZero ?? 1e9)) || (b.perDay - a.perDay));

const risk = rows.filter((r) => r.status === 'риск' || r.status === 'нет остатка');
const snapshot = {
  generatedAt: new Date().toISOString(),
  velocityDays: VEL_DAYS, targetDays: TARGET_DAYS, lowThresholdDays: LOW,
  totals: {
    articles: rows.length,
    risk: risk.length,
    outOfStock: rows.filter((r) => r.status === 'нет остатка').length,
    deadStock: rows.filter((r) => r.status === 'неликвид').length,
    reorderUnits: rows.reduce((s, r) => s + r.reorderQty, 0),
    stockUnits: rows.reduce((s, r) => s + r.stock, 0),
    demandPerDay: +rows.reduce((s, r) => s + r.perDay, 0).toFixed(1),
  },
  rows,
};

log(`\nОкно спроса: ${VEL_DAYS} дн. | целевое покрытие: ${TARGET_DAYS} дн. | порог риска: ≤${LOW} дн.`);
log(`Артикул+цвет: ${rows.length} | риск/нет остатка: ${risk.length} | неликвид: ${snapshot.totals.deadStock} | суммарно к дозаказу: ${snapshot.totals.reorderUnits} шт`);
log('\nТОП к дозаказу (заканчивается или уже 0):');
log('Артикул+цвет'.padEnd(30) + 'Ост'.padStart(6) + '/дн'.padStart(7) + 'ДоНуля'.padStart(8) + 'Дозак'.padStart(7) + '  Где остаток');
for (const r of risk.slice(0, 20)) {
  const where = Object.entries(r.stockByWarehouse).map(([n, q]) => `${n}:${q}`).join(', ') || '—';
  log(String(r.vendorCode).slice(0, 29).padEnd(30) + String(r.stock).padStart(6) + String(r.perDay).padStart(7) + (r.daysToZero == null ? '∞' : String(r.daysToZero)).padStart(8) + String(r.reorderQty).padStart(7) + '  ' + where);
}

if (!jsonOnly) {
  fs.writeFileSync(R('fbs-replenishment.json'), JSON.stringify(snapshot, null, 2) + '\n');
  log(`\n→ ${path.relative(process.cwd(), R('fbs-replenishment.json'))}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
