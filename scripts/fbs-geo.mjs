// scripts/fbs-geo.mjs — «География продаж и возвратов» FBS для веб-сервиса.
//
// Источник: Statistics /api/v1/supplier/sales (продажи saleID «S…» + возвраты
// «R…», у каждой строки регион покупателя: oblastOkrugName/regionName) и
// Marketplace /api/v3/orders (чтобы понять, какие nmID отгружаются с МОСКОВСКИХ
// FF-складов — по warehouseId из config/warehouses.json, имя содержит «Мск/Москв»).
//
//   node scripts/fbs-geo.mjs --days 30 --json
//
// Лимит sales — 1 запрос/мин (держит lib/wbClient.js). Данные ~90 дней, обновление ~30 мин.
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

// Московские FF-склады продавца (по имени «Мск/Москв»).
let MOSCOW_IDS = new Set(), MOSCOW_NAMES = [];
try {
  for (const w of JSON.parse(fs.readFileSync(path.join(REPO, 'config/warehouses.json'), 'utf8')).warehouses || []) {
    if (/мск|москв/i.test(w.name)) { MOSCOW_IDS.add(w.id); MOSCOW_NAMES.push(w.name); }
  }
} catch { /* */ }

const fromDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

// ── nmID, отгружаемые с московских FF (из FBS-заказов за окно) ────────────────
async function moscowNmSet() {
  const set = new Set();
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = Math.floor(Date.parse(fromDate + 'T00:00:00Z') / 1000);
  const CHUNK = 28 * 86400;
  const seen = new Set();
  for (let end = nowSec; end > fromSec;) {
    const start = Math.max(fromSec, end - CHUNK);
    let next = 0;
    for (let p = 1; ; p++) {
      const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: start, dateTo: end }, methodLimit: MP });
      const b = data.orders || [];
      for (const o of b) { const id = o.id ?? o.rid; if (seen.has(id)) continue; seen.add(id); if (MOSCOW_IDS.has(o.warehouseId) && o.nmId) set.add(o.nmId); }
      if (b.length < 1000) break; next = data.next;
    }
    end = start;
  }
  return set;
}

// ── Продажи + возвраты со статистики (пагинация по lastChangeDate) ────────────
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

const moscowNm = await moscowNmSet();
log(`Московские FF: ${MOSCOW_NAMES.join(', ') || '—'} · nmID с них: ${moscowNm.size}`);
const sales = await fetchSales();

// ── Агрегация по регионам (для всей РФ и для товаров московских FF) ───────────
const isReturn = (s) => String(s.saleID || '').startsWith('R');
const rub = (s) => Math.abs(Number(s.finishedPrice) || 0);
const okrugOf = (s) => (s.oblastOkrugName || '—');
const regionOf = (s) => (s.regionName || '—');

function aggregate(pred) {
  const byRegion = new Map(); const byOkrug = new Map();
  const bump = (map, key, extra, s) => {
    if (!map.has(key)) map.set(key, { ...extra, salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 });
    const e = map.get(key);
    if (isReturn(s)) { e.returnCount += 1; e.returnRub += rub(s); }
    else { e.salesCount += 1; e.salesRub += rub(s); }
  };
  for (const s of sales) {
    if (!pred(s)) continue;
    bump(byRegion, okrugOf(s) + '||' + regionOf(s), { okrug: okrugOf(s), region: regionOf(s) }, s);
    bump(byOkrug, okrugOf(s), { okrug: okrugOf(s) }, s);
  }
  const fin = (arr) => arr.map((e) => ({ ...e, salesRub: Math.round(e.salesRub), returnRub: Math.round(e.returnRub), returnPct: e.salesCount ? Math.round(e.returnCount / e.salesCount * 1000) / 10 : 0 }))
    .sort((a, b) => b.salesCount - a.salesCount);
  const regions = fin([...byRegion.values()]);
  const okrugs = fin([...byOkrug.values()]);
  const t = regions.reduce((a, r) => ({ salesCount: a.salesCount + r.salesCount, returnCount: a.returnCount + r.returnCount, salesRub: a.salesRub + r.salesRub, returnRub: a.returnRub + r.returnRub }), { salesCount: 0, returnCount: 0, salesRub: 0, returnRub: 0 });
  t.regions = regions.length;
  t.returnPct = t.salesCount ? Math.round(t.returnCount / t.salesCount * 1000) / 10 : 0;
  return { totals: t, byRegion: regions, byOkrug: okrugs };
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate,
  moscowWarehouses: MOSCOW_NAMES, moscowNmCount: moscowNm.size,
  scopes: {
    all: aggregate(() => true),
    moscow: aggregate((s) => moscowNm.has(s.nmId)),
  },
};

const A = snapshot.scopes.all.totals, M = snapshot.scopes.moscow.totals;
log(`\nВся РФ: продаж ${A.salesCount} · возвратов ${A.returnCount} (${A.returnPct}%) · регионов ${A.regions}`);
log(`Товары моск. FF: продаж ${M.salesCount} · возвратов ${M.returnCount} (${M.returnPct}%)`);
log('Топ-5 регионов по возвратам (вся РФ): ' + [...snapshot.scopes.all.byRegion].sort((a, b) => b.returnCount - a.returnCount).slice(0, 5).map((r) => `${r.region} ${r.returnCount}`).join(' · '));

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fbs-geo.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
