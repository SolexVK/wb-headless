// scripts/fbs-orders-retro.mjs — ретроспектива заказов FBS по фулфилмент-складам.
//
// Отвечает на вопросы за период (по умолчанию 7 дней):
//   • сколько заказов сделано каждым нашим складом-фулфилментом (warehouseId);
//   • сколько из них обработано (отгружено = поставка передана в доставку);
//   • за какое время обработаны (createdAt → supply.closedAt): среднее, медиана, макс;
//   • какие заказы выполнялись критически долго (> порога, по умолчанию 48 ч).
//
// Методы WB API (категория Маркетплейс):
//   GET /api/v3/orders    — сборочные задания за период: warehouseId + createdAt + supplyId
//   GET /api/v3/supplies  — поставки: createdAt + closedAt (+ /{supplyId} для добора)
// Время обработки = момент передачи поставки в доставку (closedAt) − создание заказа.
//
//   npm run fbs:retro                # последние 7 дней, снимок в reports-output/
//   node scripts/fbs-orders-retro.mjs --days 14 --crit 36 --json
//
// ВАЖНО: статистический GET /api/v1/supplier/orders для FBS относит заказ к
// приёмке/СЦ WB (warehouseName вроде «СЦ Чебоксары»), а НЕ к нашему складу —
// поэтому для атрибуции «по нашему фулфилменту» берём warehouseId отсюда.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const DAYS = Number(arg('days', 7));
const CRIT_H = Number(arg('crit', 48));   // порог «критически долго», часов
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP_LIMIT = { limit: 300, periodSec: 60, burst: 20 };

// Имена наших складов (для читаемого вывода).
let WH_NAME = {};
try {
  const snap = JSON.parse(fs.readFileSync(path.join(REPO, 'config/warehouses.json'), 'utf8'));
  for (const w of snap.warehouses || []) WH_NAME[w.id] = w.name;
} catch { /* нет файла — покажем id */ }

// ── 1. Все сборочные задания за период (пагинация по next) ──────────────────
async function fetchOrders() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - DAYS * 24 * 3600;
  const orders = [];
  let next = 0;
  for (let page = 1; ; page++) {
    const { data } = await wb.get('marketplace', '/api/v3/orders', {
      query: { limit: 1000, next, dateFrom: fromSec, dateTo: nowSec },
      methodLimit: MP_LIMIT,
    });
    const batch = data.orders || [];
    orders.push(...batch);
    log(`  orders: страница ${page}, +${batch.length} (всего ${orders.length})`);
    if (batch.length < 1000) break;
    next = data.next;
  }
  return orders;
}

// ── 2. Поставки: карта supplyId → {createdAt, closedAt, done} ────────────────
async function fetchSupplies(neededIds) {
  const map = new Map();
  let next = 0;
  for (let page = 1; ; page++) {
    const { data } = await wb.get('marketplace', '/api/v3/supplies', {
      query: { limit: 1000, next }, methodLimit: MP_LIMIT,
    });
    const batch = data.supplies || [];
    for (const s of batch) map.set(s.id, s);
    log(`  supplies: страница ${page}, +${batch.length} (всего ${map.size})`);
    if (batch.length < 1000) break;
    next = data.next;
  }
  // Доводим недостающие поставки точечными запросами.
  const missing = [...neededIds].filter((id) => id && !map.has(id));
  if (missing.length) {
    log(`  добираю ${missing.length} поставок точечно…`);
    for (const id of missing) {
      try {
        const { data } = await wb.get('marketplace', `/api/v3/supplies/${id}`, { methodLimit: MP_LIMIT });
        map.set(id, data);
      } catch (e) { log(`    ! ${id}: ${e.status || ''} ${e.message}`); }
    }
  }
  return map;
}

// ── 3. Статусы сборочных заданий (supplierStatus), чанки по 1000 ────────────
async function fetchStatuses(ids) {
  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const map = new Map(); // id → supplierStatus
  let page = 0;
  for (const part of chunk(ids, 1000)) {
    const { data } = await wb.request('marketplace', '/api/v3/orders/status', {
      method: 'POST', body: { orders: part }, methodLimit: MP_LIMIT,
    });
    for (const s of data.orders || []) map.set(s.id, s.supplierStatus);
    log(`  statuses: чанк ${++page}, +${(data.orders || []).length} (всего ${map.size})`);
  }
  return map;
}

// Группируем supplierStatus в укрупнённые корзины для «в работе / не отгружено».
const STATUS_BUCKET = {
  new: 'new',            // новое — не взято в сборку (не отгружено)
  confirm: 'confirm',    // на сборке — в работе
  complete: 'complete',  // в доставке — обработано/отгружено
  cancel: 'cancel',
  cancel_carrier: 'cancel',
};
const emptyStatus = () => ({ new: 0, confirm: 0, complete: 0, cancel: 0 });

// ── main ────────────────────────────────────────────────────────────────────
const hrs = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmtH = (h) => (h >= 24 ? (h / 24).toFixed(1) + ' сут' : h.toFixed(1) + ' ч');

log(`Период: последние ${DAYS} дн. | порог критичности: ${CRIT_H} ч`);
const orders = await fetchOrders();
const supplyIds = new Set(orders.map((o) => o.supplyId).filter(Boolean));
const supplies = await fetchSupplies(supplyIds);
const statuses = await fetchStatuses(orders.map((o) => o.id));

// Группировка по нашему фулфилменту (warehouseId).
const byWh = new Map();
const critical = [];
for (const o of orders) {
  const wid = o.warehouseId;
  if (!byWh.has(wid)) byWh.set(wid, { warehouseId: wid, name: WH_NAME[wid] || String(wid), made: 0, processed: 0, pending: 0, times: [], status: emptyStatus() });
  const g = byWh.get(wid);
  g.made++;

  const bucket = STATUS_BUCKET[statuses.get(o.id)] || 'new';
  g.status[bucket]++;

  const sup = o.supplyId ? supplies.get(o.supplyId) : null;
  const closedAt = sup && (sup.done || sup.closedAt) ? sup.closedAt : null;
  if (closedAt) {
    const t = hrs(o.createdAt, closedAt);
    g.processed++;
    g.times.push(t);
    if (t > CRIT_H) {
      critical.push({ warehouse: g.name, warehouseId: wid, orderId: o.id, article: o.article, nmId: o.nmId,
        createdAt: o.createdAt, closedAt, hours: +t.toFixed(1), supplyId: o.supplyId });
    }
  } else {
    g.pending++; // ещё не отгружен (нет поставки или поставка не закрыта)
  }
}

const rows = [...byWh.values()].map((g) => {
  const avg = g.times.length ? g.times.reduce((a, b) => a + b, 0) / g.times.length : 0;
  return {
    warehouseId: g.warehouseId, name: g.name,
    made: g.made, processed: g.processed, pending: g.pending,
    avgHours: +avg.toFixed(2), medianHours: +median(g.times).toFixed(2),
    maxHours: g.times.length ? +Math.max(...g.times).toFixed(2) : 0,
    criticalCount: critical.filter((c) => c.warehouseId === g.warehouseId).length,
    status: { ...g.status },
  };
}).sort((a, b) => b.made - a.made);

critical.sort((a, b) => b.hours - a.hours);

const statusTotals = rows.reduce((t, r) => {
  for (const k of ['new', 'confirm', 'complete', 'cancel']) t[k] += r.status[k];
  return t;
}, emptyStatus());

const allTimes = rows.flatMap((r) => byWh.get(r.warehouseId).times);
const timingBuckets = { '<6ч': 0, '6-24ч': 0, '24-48ч': 0, '>48ч': 0 };
for (const t of allTimes) {
  if (t < 6) timingBuckets['<6ч']++;
  else if (t < 24) timingBuckets['6-24ч']++;
  else if (t < 48) timingBuckets['24-48ч']++;
  else timingBuckets['>48ч']++;
}
const snapshot = {
  generatedAt: new Date().toISOString(),
  periodDays: DAYS,
  criticalThresholdHours: CRIT_H,
  ordersTotal: orders.length,
  processedTotal: rows.reduce((s, r) => s + r.processed, 0),
  pendingTotal: rows.reduce((s, r) => s + r.pending, 0),
  overallAvgHours: allTimes.length ? +(allTimes.reduce((a, b) => a + b, 0) / allTimes.length).toFixed(2) : 0,
  overallMedianHours: +median(allTimes).toFixed(2),
  statusTotals,
  timingBuckets,
  byFulfillment: rows,
  critical,
};

// Человекочитаемый вывод.
log(`\nЗаказов FBS за ${DAYS} дн.: ${snapshot.ordersTotal} | обработано: ${snapshot.processedTotal} | не отгружено: ${snapshot.pendingTotal}`);
log('');
log('Фулфилмент'.padEnd(20) + 'Сделано'.padStart(9) + 'Обраб.'.padStart(8) + 'В работе'.padStart(10) + 'Сред.t'.padStart(10) + 'Медиана'.padStart(10) + 'Макс.t'.padStart(10) + 'Крит.'.padStart(7));
for (const r of rows) {
  log(r.name.padEnd(20) + String(r.made).padStart(9) + String(r.processed).padStart(8) + String(r.pending).padStart(10) +
    fmtH(r.avgHours).padStart(10) + fmtH(r.medianHours).padStart(10) + fmtH(r.maxHours).padStart(10) + String(r.criticalCount).padStart(7));
}
log(`\nСтатусы (supplierStatus): новых ${statusTotals.new} · на сборке ${statusTotals.confirm} · в доставке ${statusTotals.complete} · отменено ${statusTotals.cancel}`);
log(`Общее среднее время обработки: ${fmtH(snapshot.overallAvgHours)} | медиана: ${fmtH(snapshot.overallMedianHours)}`);
log(`Критически долгих (> ${CRIT_H} ч): ${critical.length}`);
for (const c of critical.slice(0, 12)) {
  log(`   ${fmtH(c.hours).padStart(9)}  ${c.warehouse.padEnd(18)} ${String(c.article).padEnd(24)} заказ ${c.orderId} | ${c.createdAt.slice(0, 16)} → ${c.closedAt.slice(0, 16)}`);
}

if (!jsonOnly) {
  const outDir = path.join(REPO, 'reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'fbs-orders-retro.json');
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  log(`\n→ снимок: ${path.relative(process.cwd(), out)}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
