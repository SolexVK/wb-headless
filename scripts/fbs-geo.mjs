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

// Склады продавца: id→имя, множество московских.
const WH_NAME = {}; const MOSCOW_IDS = new Set(); const MOSCOW_NAMES = [];
try {
  for (const w of JSON.parse(fs.readFileSync(path.join(REPO, 'config/warehouses.json'), 'utf8')).warehouses || []) {
    WH_NAME[w.id] = w.name;
    if (/мск|москв/i.test(w.name)) { MOSCOW_IDS.add(w.id); MOSCOW_NAMES.push(w.name); }
  }
} catch { /* */ }
const parseArt = (vc) => { const m = String(vc || '').match(/^\s*(\d+)/); return m ? m[1] : String(vc || '').trim(); };

const fromDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
// FBS-заказы храним ~90 дней — тянем максимально глубоко, чтобы привязать возвраты.
const ORD_DAYS = Math.min(88, Math.max(DAYS, 60));

// ── FBS-заказы: rid → {wh, article}, отгрузки по ФФ, nmID московских FF ───────
async function fetchOrders() {
  const rid = new Map(); const ordersByFF = {}; const moscowNm = new Set();
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - ORD_DAYS * 86400;
  const CHUNK = 28 * 86400; const seen = new Set();
  for (let end = nowSec; end > fromSec;) {
    const start = Math.max(fromSec, end - CHUNK); let next = 0;
    for (let p = 1; ; p++) {
      const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: start, dateTo: end }, methodLimit: MP });
      const b = data.orders || [];
      for (const o of b) {
        const id = String(o.rid); if (seen.has(id)) continue; seen.add(id);
        const name = WH_NAME[o.warehouseId] || ('склад ' + o.warehouseId);
        rid.set(id, { ff: name, mos: MOSCOW_IDS.has(o.warehouseId), article: parseArt(o.article), nm: o.nmId });
        ordersByFF[name] = (ordersByFF[name] || 0) + 1;
        if (MOSCOW_IDS.has(o.warehouseId) && o.nmId) moscowNm.add(o.nmId);
      }
      if (b.length < 1000) break; next = data.next;
    }
    end = start;
  }
  return { rid, ordersByFF, moscowNm };
}

// ── Продажи + возвраты (пагинация по lastChangeDate, дедуп по srid) ───────────
async function fetchSales() {
  const seen = new Set(); const rows = [];
  let dateFrom = fromDate;
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

const ord = await fetchOrders();
log(`FBS-заказов (rid): ${ord.rid.size} · московские FF: ${MOSCOW_NAMES.join(', ') || '—'} (nmID ${ord.moscowNm.size})`);
const sales = await fetchSales();

const isReturn = (s) => String(s.saleID || '').startsWith('R');
const rub = (s) => Math.abs(Number(s.finishedPrice) || 0);
const okrugOf = (s) => (s.oblastOkrugName || '—');
const regionOf = (s) => (s.regionName || '—');
const r2 = (x) => Math.round(x);

// ── Регионы по ВСЕМ продажам (как раньше: all + товары московских FF) ────────
function aggregateRegions(pred) {
  const byRegion = new Map(); const byOkrug = new Map();
  const bump = (map, key, extra, s) => {
    if (!map.has(key)) map.set(key, { ...extra, salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 });
    const e = map.get(key);
    if (isReturn(s)) { e.returnCount += 1; e.returnRub += rub(s); } else { e.salesCount += 1; e.salesRub += rub(s); }
  };
  for (const s of sales) {
    if (!pred(s)) continue;
    bump(byRegion, okrugOf(s) + '||' + regionOf(s), { okrug: okrugOf(s), region: regionOf(s) }, s);
    bump(byOkrug, okrugOf(s), { okrug: okrugOf(s) }, s);
  }
  const fin = (arr) => arr.map((e) => ({ ...e, salesRub: r2(e.salesRub), returnRub: r2(e.returnRub), returnPct: e.salesCount ? Math.round(e.returnCount / e.salesCount * 1000) / 10 : 0 })).sort((a, b) => b.salesCount - a.salesCount);
  const regions = fin([...byRegion.values()]); const okrugs = fin([...byOkrug.values()]);
  const t = regions.reduce((a, r) => ({ salesCount: a.salesCount + r.salesCount, returnCount: a.returnCount + r.returnCount, salesRub: a.salesRub + r.salesRub, returnRub: a.returnRub + r.returnRub }), { salesCount: 0, returnCount: 0, salesRub: 0, returnRub: 0 });
  t.regions = regions.length; t.returnPct = t.salesCount ? Math.round(t.returnCount / t.salesCount * 1000) / 10 : 0;
  return { totals: t, byRegion: regions, byOkrug: okrugs };
}

// ── FBS: привязка к ФФ отгрузки (srid = rid) ─────────────────────────────────
const pctOf = (ret, sal) => (sal ? Math.round(ret / sal * 1000) / 10 : 0);
function aggregateFbs() {
  const byFF = new Map(); const ffReg = new Map(); const byDay = new Map(); const byArt = new Map();
  let unSales = 0, unRet = 0; const tot = { salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 };
  for (const s of sales) {
    const o = ord.rid.get(String(s.srid));
    if (!o) { // FBS-строка без заказа в окне (старше ~90 дн) — не привязать к ФФ
      if (/продав/i.test(s.warehouseType || '')) { if (isReturn(s)) unRet += 1; else unSales += 1; }
      continue;
    }
    const ret = isReturn(s); const money = rub(s); const day = String(s.date || '').slice(0, 10);
    if (ret) { tot.returnCount += 1; tot.returnRub += money; } else { tot.salesCount += 1; tot.salesRub += money; }
    const add = (map, key, extra) => { if (!map.has(key)) map.set(key, { ...extra, salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 }); const e = map.get(key); if (ret) { e.returnCount += 1; e.returnRub += money; } else { e.salesCount += 1; e.salesRub += money; } };
    add(byFF, o.ff, { ff: o.ff });
    add(ffReg, o.ff + '||' + regionOf(s), { ff: o.ff, okrug: okrugOf(s), region: regionOf(s) });
    add(byArt, o.article, { article: o.article, ff: o.ff });
    if (day) { if (!byDay.has(day)) byDay.set(day, { date: day, salesCount: 0, returnCount: 0 }); const d = byDay.get(day); if (ret) d.returnCount += 1; else d.salesCount += 1; }
  }
  const finFF = (arr) => arr.map((e) => ({ ...e, salesRub: r2(e.salesRub), returnRub: r2(e.returnRub), returnPct: pctOf(e.returnCount, e.salesCount), shipped: ord.ordersByFF[e.ff] || 0 })).sort((a, b) => b.returnCount - a.returnCount || b.salesCount - a.salesCount);
  const finReg = (arr) => arr.map((e) => ({ ...e, salesRub: r2(e.salesRub), returnRub: r2(e.returnRub), returnPct: pctOf(e.returnCount, e.salesCount) })).sort((a, b) => b.returnCount - a.returnCount || b.salesCount - a.salesCount);
  const finArt = (arr) => arr.map((e) => ({ ...e, salesRub: r2(e.salesRub), returnRub: r2(e.returnRub), returnPct: pctOf(e.returnCount, e.salesCount) })).sort((a, b) => b.returnCount - a.returnCount || b.salesCount - a.salesCount).slice(0, 60);
  tot.salesRub = r2(tot.salesRub); tot.returnRub = r2(tot.returnRub); tot.returnPct = pctOf(tot.returnCount, tot.salesCount);
  tot.shipped = Object.values(ord.ordersByFF).reduce((a, b) => a + b, 0);
  return {
    totals: tot, ordersByFF: ord.ordersByFF,
    byFF: finFF([...byFF.values()]),
    ffByRegion: finReg([...ffReg.values()]),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byArticle: finArt([...byArt.values()]),
    unattributed: { salesCount: unSales, returnCount: unRet },
  };
}

const fbs = aggregateFbs();
const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate, ordDays: ORD_DAYS,
  moscowWarehouses: MOSCOW_NAMES, moscowNmCount: ord.moscowNm.size,
  scopes: { all: aggregateRegions(() => true), moscow: aggregateRegions((s) => ord.moscowNm.has(s.nmId)) },
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
