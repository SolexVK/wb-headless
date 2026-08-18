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
import { fetchOrders as wbFetchOrders, fetchSupplies as wbFetchSupplies, fetchSales as wbFetchSales } from './lib/wbFetch.mjs';
import { buildAssembly, buildDelivery, buildReturnPath } from './lib/agg/logistics.mjs';

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
  const raw = await wbFetchOrders(wb, { fromSec: nowSec - ORD_DAYS * 86400, toSec: nowSec, chunkDays: 28, dedupBy: 'rid', methodLimit: MP, onLog: (m) => log('  ' + m) });
  for (const o of raw) {
    const id = String(o.rid);
    const name = WH.nameOf(o.warehouseId);
    const rec = { ff: name, warehouseId: o.warehouseId, createdAt: o.createdAt, supplyId: o.supplyId, article: parseArt(o.article), nmId: o.nmId };
    rid.set(id, rec); orders.push(rec);
  }
  return { rid, orders };
}

// Поставки и продажи — через общие выборки (список+добор / дедуп srid+saleID).
const fetchSupplies = (neededIds) => wbFetchSupplies(wb, { neededIds, methodLimit: MP, onLog: (m) => log('  ' + m) });
const fetchSales = () => wbFetchSales(wb, { dateFrom: fromDate, methodLimit: STAT, onLog: (m) => log('  ' + m) });

const ord = await fetchOrders();
log(`FBS-заказов (rid): ${ord.rid.size} за ${ORD_DAYS} дн.`);
const supplyIds = new Set(ord.orders.map((o) => o.supplyId).filter(Boolean));
const supplies = await fetchSupplies(supplyIds);
const closedOf = (o) => { const sup = o.supplyId ? supplies.get(o.supplyId) : null; return sup && (sup.done || sup.closedAt) ? sup.closedAt : null; };

// ── 1) СБОРКА: createdAt → closedAt по ФФ (только заказы за окно DAYS) ────────
// Агрегация вынесена в lib/agg/logistics.mjs (покрыта юнит-тестами smoke-agg.mjs).
const asmFromSec = nowSec - DAYS * 86400;
const assembly = buildAssembly(ord.orders, closedOf, { critH: CRIT_H, asmFromSec });

// ── 2) ДОСТАВКА: closedAt → sale.date по ФФ и по региону покупателя ──────────
const sales = await fetchSales();
const delivery = buildDelivery(sales, ord.rid, closedOf);

// ── 3) ПУТЬ ВОЗВРАТА: ФФ отгрузки → регион продажи → регион возврата → склад
//       возврата WB; кол-во по этапам + времена «отгрузка→выкуп» и «у клиента».
const returnPath = buildReturnPath(sales, ord.rid, closedOf);

const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate, ordDays: ORD_DAYS, critAssemblyH: CRIT_H,
  assembly, delivery, returnPath,
};

// Человекочитаемый вывод.
const fmtH = (h) => (h >= 24 ? (h / 24).toFixed(1) + ' сут' : h.toFixed(1) + ' ч');
log(`\nСБОРКА за ${DAYS} дн.: заказов ${assembly.totals.orders} · обработано ${assembly.totals.processed} · среднее ${fmtH(assembly.totals.avgHours)} · медиана ${fmtH(assembly.totals.medianHours)}`);
for (const r of assembly.byFF) log(`   ${r.ff.padEnd(18)} сделано ${String(r.made).padStart(5)} · среднее ${fmtH(r.avgHours).padStart(9)} · медиана ${fmtH(r.medianHours).padStart(9)} · крит ${r.criticalCount}`);
log(`\nДОСТАВКА (ФФ → клиент): выкупов с привязкой ${delivery.totals.joined} · измерено ${delivery.totals.count} · среднее ${fmtH(delivery.totals.avgHours)} · медиана ${fmtH(delivery.totals.medianHours)}`);
for (const r of delivery.byFF) log(`   ${r.ff.padEnd(18)} выкупов ${String(r.count).padStart(5)} · среднее ${fmtH(r.avgHours).padStart(9)} · медиана ${fmtH(r.medianHours).padStart(9)}`);
if (!delivery.available) log('Доставка: за период нет выкупов, привязанных к ФФ (появится при первых продажах FBS).');
const rp = returnPath;
log(`\nПУТЬ ВОЗВРАТА: отгружено ${rp.funnel.shipped} · выкуплено ${rp.funnel.sold} · возвращено ${rp.funnel.returned} (${rp.funnel.returnPct}%)`);
if (rp.available) log(`   у клиента: медиана ${rp.stageTimes.hold.medianDays} сут · доставка до выкупа: медиана ${fmtH(rp.stageTimes.deliver.medianHours)}`);
for (const r of rp.byFF) log(`   ${r.ff.padEnd(18)} возвратов ${String(r.count).padStart(5)}${r.holdDays != null ? ` · у клиента ${r.holdDays} сут` : ''}`);

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fbs-logistics.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
