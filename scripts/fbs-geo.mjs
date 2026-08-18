// scripts/fbs-geo.mjs — «География продаж и возвратов» + FBS-атрибуция к ФФ отгрузки.
//
// Идея: у FBS продажа/возврат в статистике несёт srid, равный rid FBS-заказа
// (проверено: 100% для «Склад продавца»). У заказа есть warehouseId = наш ФФ
// отгрузки. Значит возврат можно привязать к ИСХОДНОМУ ФФ (откуда уехал товар),
// даже если физически он вернулся на московский ПВЗ.
//
// Источники: statistics /api/v1/supplier/sales (регион покупателя, продажи «S…»
// + возвраты «R…», srid) и marketplace /api/v3/orders (rid→warehouseId/nmId/article).
//
//   node scripts/fbs-geo.mjs --days 30 --json
// Лимиты: sales — 1 запрос/мин; заказы FBS хранятся ~90 дней (глубже возврат к ФФ не привязать).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';
import { loadWarehouses } from './lib/warehouses.mjs';
import { fetchOrders as wbFetchOrders, fetchSales as wbFetchSales } from './lib/wbFetch.mjs';
import { aggregateRegions, aggregateFbs } from './lib/agg/geo.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = Math.min(90, Math.max(1, Number(arg('days', 30))));
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };
const STAT = { limit: 1, periodSec: 60, burst: 1 };

// Склады продавца (id→имя, множество московских) — ЖИВЫМ запросом по токену кабинета,
// чтобы новые (в т.ч. московские) ФФ подхватывались автоматически. Откат на config при офлайне.
const WH = await loadWarehouses(wb, { methodLimit: MP });
const MOSCOW_NAMES = WH.moscowNames;
const parseArt = (vc) => { const m = String(vc || '').match(/^\s*(\d+)/); return m ? m[1] : String(vc || '').trim(); };

const fromDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
// FBS-заказы храним ~90 дней — тянем максимально глубоко, чтобы привязать возвраты.
const ORD_DAYS = Math.min(88, Math.max(DAYS, 60));

// ── FBS-заказы: rid → {wh, article}, отгрузки по ФФ, nmID московских FF ───────
async function fetchOrders() {
  const rid = new Map(); const ordersByFF = {}; const moscowNm = new Set();
  const nowSec = Math.floor(Date.now() / 1000);
  const orders = await wbFetchOrders(wb, { fromSec: nowSec - ORD_DAYS * 86400, toSec: nowSec, chunkDays: 28, dedupBy: 'rid', methodLimit: MP, onLog: (m) => log('  ' + m) });
  for (const o of orders) {
    const id = String(o.rid);
    const name = WH.nameOf(o.warehouseId);
    rid.set(id, { ff: name, mos: WH.isMoscow(o.warehouseId), article: parseArt(o.article), nm: o.nmId });
    ordersByFF[name] = (ordersByFF[name] || 0) + 1;
    if (WH.isMoscow(o.warehouseId) && o.nmId) moscowNm.add(o.nmId);
  }
  return { rid, ordersByFF, moscowNm };
}

// ── Продажи + возвраты (дедуп по srid+saleID — см. wbFetch/фикс B1) ───────────
const fetchSales = () => wbFetchSales(wb, { dateFrom: fromDate, methodLimit: STAT, onLog: (m) => log('  ' + m) });

const ord = await fetchOrders();
log(`FBS-заказов (rid): ${ord.rid.size} · московские FF: ${MOSCOW_NAMES.join(', ') || '—'} (nmID ${ord.moscowNm.size})`);
const sales = await fetchSales();

// Агрегация вынесена в lib/agg/geo.mjs (покрыта юнит-тестами smoke-agg.mjs).
const fbs = aggregateFbs(sales, ord);
const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate, ordDays: ORD_DAYS,
  moscowWarehouses: MOSCOW_NAMES, moscowNmCount: ord.moscowNm.size,
  scopes: { all: aggregateRegions(sales, () => true), moscow: aggregateRegions(sales, (s) => ord.moscowNm.has(s.nmId)) },
  fbs,
};

const A = snapshot.scopes.all.totals;
log(`\nВся РФ: продаж ${A.salesCount} · возвратов ${A.returnCount} (${A.returnPct}%) · регионов ${A.regions}`);
log(`FBS (привязано к ФФ): отгружено ${fbs.totals.shipped} · продаж ${fbs.totals.salesCount} · возвратов ${fbs.totals.returnCount} (${fbs.totals.returnPct}%)`);
log('FBS возвраты по ФФ отгрузки: ' + (fbs.byFF.filter((f) => f.returnCount).map((f) => `${f.ff} ${f.returnCount}`).join(' · ') || '— (за период нет FBS-возвратов)'));
if (fbs.unattributed.returnCount) log(`Не привязано к ФФ (заказ старше ~${ORD_DAYS} дн): возвратов ${fbs.unattributed.returnCount}`);

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fbs-geo.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
