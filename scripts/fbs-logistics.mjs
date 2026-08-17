// scripts/fbs-logistics.mjs — «Логистика»: сроки сборки и доставки по ФФ.
//
// Две метрики по каждому нашему складу-фулфилменту (warehouseId):
//   1) СБОРКА  — время «создание заказа → передача поставки в доставку»
//      (createdAt → supply.closedAt): среднее, медиана, p90, максимум, критичные.
//   2) ДОСТАВКА — время «отгрузка с ФФ → получение/выкуп клиентом»
//      (supply.closedAt → sale.date из статистики). Привязка выкупа к ИСХОДНОМУ
//      ФФ отгрузки по номеру заказа (srid = rid, проверено 100% для FBS).
//
// Источники WB:
//   GET /api/v3/orders            — сборочные задания: warehouseId, createdAt, supplyId, rid
//   GET /api/v3/supplies[/{id}]   — поставки: createdAt, closedAt, done
//   GET /api/v1/supplier/sales    — выкупы (S…) + регион покупателя, srid (1 запрос/мин)
//
//   node scripts/fbs-logistics.mjs --days 30 --crit 48 --json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';
import { loadWarehouses } from './lib/warehouses.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = Math.min(90, Math.max(1, Number(arg('days', 30))));
const CRIT_H = Number(arg('crit', 48));   // порог «критически долгой сборки», часов
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };
const STAT = { limit: 1, periodSec: 60, burst: 1 };

// Имена наших складов — ЖИВЫМ запросом по токену кабинета (новые ФФ подхватятся
// автоматически); откат на config-снимок при офлайне.
const WH = await loadWarehouses(wb, { methodLimit: MP });
const parseArt = (vc) => { const m = String(vc || '').match(/^\s*(\d+)/); return m ? m[1] : String(vc || '').trim(); };

const nowSec = Math.floor(Date.now() / 1000);
const fromDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
// Заказы тянем шире окна продаж: выкуп сегодня мог уехать с ФФ 1–2 недели назад.
const ORD_DAYS = Math.min(88, Math.max(DAYS + 14, 45));

// ── Заказы: rid → {ff, warehouseId, createdAt, supplyId, article} ─────────────
async function fetchOrders() {
  const rid = new Map(); const orders = [];
  const fromSec = nowSec - ORD_DAYS * 86400;
  const CHUNK = 28 * 86400; const seen = new Set();
  for (let end = nowSec; end > fromSec;) {
    const start = Math.max(fromSec, end - CHUNK); let next = 0;
    for (let p = 1; ; p++) {
      const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: start, dateTo: end }, methodLimit: MP });
      const b = data.orders || [];
      for (const o of b) {
        const id = String(o.rid); if (seen.has(id)) continue; seen.add(id);
        const name = WH.nameOf(o.warehouseId);
        const rec = { ff: name, warehouseId: o.warehouseId, createdAt: o.createdAt, supplyId: o.supplyId, article: parseArt(o.article), nmId: o.nmId };
        rid.set(id, rec); orders.push(rec);
      }
      if (b.length < 1000) break; next = data.next;
    }
    end = start;
  }
  return { rid, orders };
}

// ── Поставки: supplyId → {createdAt, closedAt, done} (список + точечный добор) ─
async function fetchSupplies(neededIds) {
  const map = new Map(); let next = 0;
  for (let page = 1; ; page++) {
    const { data } = await wb.get('marketplace', '/api/v3/supplies', { query: { limit: 1000, next }, methodLimit: MP });
    const b = data.supplies || [];
    for (const s of b) map.set(s.id, s);
    if (b.length < 1000) break; next = data.next;
  }
  const missing = [...neededIds].filter((id) => id && !map.has(id));
  if (missing.length) {
    log(`  добираю ${missing.length} поставок точечно…`);
    for (const id of missing) { try { const { data } = await wb.get('marketplace', `/api/v3/supplies/${id}`, { methodLimit: MP }); map.set(id, data); } catch { /* пропускаем */ } }
  }
  return map;
}

// ── Продажи (выкупы) с регионом покупателя, дедуп по srid ─────────────────────
async function fetchSales() {
  const seen = new Set(); const rows = []; let dateFrom = fromDate;
  for (let page = 1; page <= 8; page++) {
    const { data } = await wb.get('statistics', '/api/v1/supplier/sales', { query: { dateFrom }, methodLimit: STAT });
    const b = Array.isArray(data) ? data : [];
    let last = null;
    for (const s of b) { if (s.srid && seen.has(s.srid)) continue; if (s.srid) seen.add(s.srid); rows.push(s); last = s.lastChangeDate || last; }
    log(`  sales стр.${page}: +${b.length} (всего ${rows.length})`);
    if (b.length < 80000 || !last) break; dateFrom = last;
  }
  return rows;
}

// ── Утилиты по времени ────────────────────────────────────────────────────────
const hrs = (a, b) => (new Date(b) - new Date(a)) / 3600000;
const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const i = Math.min(s.length - 1, Math.floor(p / 100 * s.length)); return s[i]; };
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const r2 = (x) => Math.round(x * 100) / 100;
const isReturn = (s) => String(s.saleID || '').startsWith('R');
const okrugOf = (s) => (s.oblastOkrugName || '—');
const regionOf = (s) => (s.regionName || '—');

const ord = await fetchOrders();
log(`FBS-заказов (rid): ${ord.rid.size} за ${ORD_DAYS} дн.`);
const supplyIds = new Set(ord.orders.map((o) => o.supplyId).filter(Boolean));
const supplies = await fetchSupplies(supplyIds);
const closedOf = (o) => { const sup = o.supplyId ? supplies.get(o.supplyId) : null; return sup && (sup.done || sup.closedAt) ? sup.closedAt : null; };

// ── 1) СБОРКА: createdAt → closedAt по ФФ (только заказы за окно DAYS) ────────
const asmFromSec = nowSec - DAYS * 86400;
const asmByFF = new Map();
const asmCrit = [];
for (const o of ord.orders) {
  const created = Math.floor(new Date(o.createdAt).getTime() / 1000);
  if (created < asmFromSec) continue; // сборку считаем за запрошенное окно
  if (!asmByFF.has(o.ff)) asmByFF.set(o.ff, { ff: o.ff, warehouseId: o.warehouseId, made: 0, processed: 0, pending: 0, times: [] });
  const g = asmByFF.get(o.ff); g.made++;
  const closed = closedOf(o);
  if (closed) { const t = hrs(o.createdAt, closed); if (t >= 0) { g.processed++; g.times.push(t); if (t > CRIT_H) asmCrit.push({ ff: o.ff, article: o.article, hours: r2(t), createdAt: o.createdAt, closedAt: closed }); } }
  else g.pending++;
}
const asmRows = [...asmByFF.values()].map((g) => ({
  ff: g.ff, warehouseId: g.warehouseId, made: g.made, processed: g.processed, pending: g.pending,
  avgHours: r2(avg(g.times)), medianHours: r2(median(g.times)), p90Hours: r2(pct(g.times, 90)),
  maxHours: g.times.length ? r2(Math.max(...g.times)) : 0,
  criticalCount: g.times.filter((t) => t > CRIT_H).length,
})).sort((a, b) => b.made - a.made);
const asmAll = [...asmByFF.values()].flatMap((g) => g.times);
const asmBuckets = { '<6ч': 0, '6–24ч': 0, '24–48ч': 0, '>48ч': 0 };
for (const t of asmAll) { if (t < 6) asmBuckets['<6ч']++; else if (t < 24) asmBuckets['6–24ч']++; else if (t < 48) asmBuckets['24–48ч']++; else asmBuckets['>48ч']++; }
const assembly = {
  totals: { orders: asmRows.reduce((s, r) => s + r.made, 0), processed: asmAll.length, pending: asmRows.reduce((s, r) => s + r.pending, 0),
    avgHours: r2(avg(asmAll)), medianHours: r2(median(asmAll)), p90Hours: r2(pct(asmAll, 90)), criticalCount: asmCrit.length },
  byFF: asmRows, buckets: asmBuckets,
  critical: asmCrit.sort((a, b) => b.hours - a.hours).slice(0, 40),
};

// ── 2) ДОСТАВКА: closedAt → sale.date по ФФ и по региону покупателя ──────────
const sales = await fetchSales();
const delByFF = new Map(); const delByReg = new Map(); const delByDay = new Map();
const delAll = []; let joined = 0, noShip = 0;
for (const s of sales) {
  if (isReturn(s)) continue;              // доставку меряем по выкупам
  const o = ord.rid.get(String(s.srid));  // привязка к ФФ отгрузки
  if (!o) continue;
  joined++;
  const ship = closedOf(o) || o.createdAt; // момент ухода с ФФ (передача в доставку)
  if (!ship) { noShip++; continue; }
  const t = hrs(ship, s.date);
  if (!(t > 0) || t > 60 * 24) continue;  // отсекаем аномалии (отрицательные / > 60 сут)
  delAll.push(t);
  const day = String(s.date || '').slice(0, 10);
  if (!delByFF.has(o.ff)) delByFF.set(o.ff, { ff: o.ff, times: [] });
  delByFF.get(o.ff).times.push(t);
  const rk = okrugOf(s) + '||' + regionOf(s);
  if (!delByReg.has(rk)) delByReg.set(rk, { okrug: okrugOf(s), region: regionOf(s), times: [] });
  delByReg.get(rk).times.push(t);
  if (day) { if (!delByDay.has(day)) delByDay.set(day, { date: day, times: [] }); delByDay.get(day).times.push(t); }
}
const delFFRows = [...delByFF.values()].map((g) => ({
  ff: g.ff, count: g.times.length, avgHours: r2(avg(g.times)), medianHours: r2(median(g.times)),
  p90Hours: r2(pct(g.times, 90)), minHours: g.times.length ? r2(Math.min(...g.times)) : 0, maxHours: g.times.length ? r2(Math.max(...g.times)) : 0,
})).sort((a, b) => b.count - a.count);
const delRegRows = [...delByReg.values()].map((g) => ({ okrug: g.okrug, region: g.region, count: g.times.length, avgHours: r2(avg(g.times)), medianHours: r2(median(g.times)) }))
  .sort((a, b) => b.count - a.count);
const delBuckets = { '<2 сут': 0, '2–4 сут': 0, '4–7 сут': 0, '>7 сут': 0 };
for (const t of delAll) { const d = t / 24; if (d < 2) delBuckets['<2 сут']++; else if (d < 4) delBuckets['2–4 сут']++; else if (d < 7) delBuckets['4–7 сут']++; else delBuckets['>7 сут']++; }
const delivery = {
  available: delAll.length > 0,
  totals: { count: delAll.length, joined, avgHours: r2(avg(delAll)), medianHours: r2(median(delAll)), p90Hours: r2(pct(delAll, 90)) },
  byFF: delFFRows, byRegion: delRegRows, buckets: delBuckets,
  byDay: [...delByDay.values()].map((g) => ({ date: g.date, count: g.times.length, avgHours: r2(avg(g.times)) })).sort((a, b) => a.date.localeCompare(b.date)),
};

const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate, ordDays: ORD_DAYS, critAssemblyH: CRIT_H,
  assembly, delivery,
};

// Человекочитаемый вывод.
const fmtH = (h) => (h >= 24 ? (h / 24).toFixed(1) + ' сут' : h.toFixed(1) + ' ч');
log(`\nСБОРКА за ${DAYS} дн.: заказов ${assembly.totals.orders} · обработано ${assembly.totals.processed} · среднее ${fmtH(assembly.totals.avgHours)} · медиана ${fmtH(assembly.totals.medianHours)}`);
for (const r of assembly.byFF) log(`   ${r.ff.padEnd(18)} сделано ${String(r.made).padStart(5)} · среднее ${fmtH(r.avgHours).padStart(9)} · медиана ${fmtH(r.medianHours).padStart(9)} · крит ${r.criticalCount}`);
log(`\nДОСТАВКА (ФФ → клиент): выкупов с привязкой ${delivery.totals.joined} · измерено ${delivery.totals.count} · среднее ${fmtH(delivery.totals.avgHours)} · медиана ${fmtH(delivery.totals.medianHours)}`);
for (const r of delivery.byFF) log(`   ${r.ff.padEnd(18)} выкупов ${String(r.count).padStart(5)} · среднее ${fmtH(r.avgHours).padStart(9)} · медиана ${fmtH(r.medianHours).padStart(9)}`);
if (!delivery.available) log('Доставка: за период нет выкупов, привязанных к ФФ (появится при первых продажах FBS).');

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fbs-logistics.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
