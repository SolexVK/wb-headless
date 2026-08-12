// scripts/fbs-replenishment.mjs — подсорт FBS по КАЖДОМУ складу отдельно.
//
// Парадигма (согласовано):
//   • считаем только по нашим FF-складам (FBS). FBO не учитываем.
//   • расчёт для КАЖДОГО склада отдельно: скорость продаж и остаток берутся
//     по конкретному складу, не суммарно по сети.
//   • лид-тайм подсорта = сборка + доставка на FF, 12–18 дней. Заказ должен
//     покрыть спрос за лид-тайм + запас (cover), чтобы не уйти в ноль до прихода.
//   • новинки: товары из номенклатуры, которые ни разу не заводились ни на один
//     FF-склад, — в заказ минимальным количеством (seed) для старта продаж.
//
//   npm run fbs:replenish
//   node scripts/fbs-replenishment.mjs --velocity-days 28 --lead 18 --lead-min 12 --cover 14 --seed-min 10 --json
//
// Данные: GET /api/v3/orders (спрос по складу×nmID; история до 90 дн для «новинок»),
//         снимок остатков reports-output/fbs-stock.json (npm run fbs:stock),
//         content/v2/get/cards/list (полная номенклатура для «новинок»).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const VEL_DAYS = Number(arg('velocity-days', 28));
const LEAD = Number(arg('lead', 18));          // лид-тайм (макс), дн — на приход подсорта
const LEAD_MIN = Number(arg('lead-min', 12));  // лид-тайм (мин), дн — для срочности
const COVER = Number(arg('cover', 14));        // запас после прихода, дн
const SEED_MIN = Number(arg('seed-min', 10));  // минимальный завоз новинки, шт
const HISTORY_DAYS = Number(arg('history-days', 90)); // окно «когда-либо заводился на FF»
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };
const HORIZON = LEAD + COVER; // «заказать до» покрытия, дн

// Разбор артикула: ведущий номер + вариант (цвет). Для сортировки арт→цвет.
function parseArt(vc) {
  const s = String(vc || '');
  const m = s.match(/^\s*(\d+)/);
  const num = m ? m[1] : '';
  const numInt = m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  let variant = s.slice(m ? m[0].length : 0).replace(/^[\s_\-/]+/, '').trim();
  if (!variant) variant = s;
  return { num, numInt, variant };
}

// ── Остатки по складу×nmID из снимка ────────────────────────────────────────
if (!fs.existsSync(R('fbs-stock.json'))) { log('Нет reports-output/fbs-stock.json — сначала: npm run fbs:stock'); process.exit(1); }
const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const warehouses = (stock.warehouses || []).map((w) => ({ id: w.id, name: w.name }));
const stockWN = new Map();   // "wid|nm" → qty
const nmVendor = new Map();  // nm → vendorCode
const stockNmIds = new Set();
for (const w of stock.warehouses || []) {
  for (const p of w.positions || []) {
    stockWN.set(`${w.id}|${p.nmID}`, (stockWN.get(`${w.id}|${p.nmID}`) || 0) + p.amount);
    if (!nmVendor.has(p.nmID)) nmVendor.set(p.nmID, p.vendorCode);
    stockNmIds.add(p.nmID);
  }
}

// ── Заказы: история до 90 дн (chunks ≤30 дн) для «когда-либо на FF» + скорость ─
async function fetchRange(fromSec, toSec) {
  const out = []; let next = 0;
  for (;;) {
    const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: fromSec, dateTo: toSec }, methodLimit: MP });
    const b = data.orders || []; out.push(...b);
    if (b.length < 1000) break; next = data.next;
  }
  return out;
}
const nowSec = Math.floor(Date.now() / 1000);
const histStart = nowSec - HISTORY_DAYS * 86400;
const CHUNK = 30 * 86400;
let allOrders = [];
for (let end = nowSec; end > histStart;) {
  const from = Math.max(histStart, end - CHUNK);
  const part = await fetchRange(from, end);
  allOrders.push(...part);
  log(`  orders ${new Date(from * 1000).toISOString().slice(0, 10)}..${new Date(end * 1000).toISOString().slice(0, 10)}: +${part.length} (${allOrders.length})`);
  end = from;
}
const velCut = nowSec - VEL_DAYS * 86400;
const everPlacedNm = new Set(stockNmIds);              // заводился на FF (есть остаток…)
const velWN = new Map();                                // "wid|nm" → заказы за окно скорости
for (const o of allOrders) {
  everPlacedNm.add(o.nmId);                             // …или был заказ (значит был на FF)
  if (!nmVendor.has(o.nmId)) nmVendor.set(o.nmId, o.article);
  const created = Math.floor(new Date(o.createdAt).getTime() / 1000);
  if (created >= velCut) velWN.set(`${o.warehouseId}|${o.nmId}`, (velWN.get(`${o.warehouseId}|${o.nmId}`) || 0) + 1);
}

// ── Полная номенклатура (карточки) — для «новинок» ──────────────────────────
async function fetchCards() {
  const cards = []; let cursor = { limit: 100 };
  for (;;) {
    const { data } = await wb.request('content', '/content/v2/get/cards/list', { method: 'POST', body: { settings: { cursor, filter: { withPhoto: -1 } } }, methodLimit: { limit: 100, periodSec: 60, burst: 20 } });
    const cs = data?.cards || []; cards.push(...cs);
    const total = data?.cursor?.total ?? 0;
    if (cs.length < cursor.limit || total < cursor.limit) break;
    cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
  }
  return cards;
}
const cards = await fetchCards();
for (const c of cards) if (!nmVendor.has(c.nmID)) nmVendor.set(c.nmID, c.vendorCode);

// ── Подсорт по каждому складу ───────────────────────────────────────────────
const perDayOf = (wid, nm) => (velWN.get(`${wid}|${nm}`) || 0) / VEL_DAYS;
const statusOf = (perDay, stk, dtz) => {
  if (perDay === 0) return stk > 0 ? 'неликвид' : 'нет данных';
  if (stk === 0) return 'нет остатка';
  if (dtz < LEAD_MIN) return 'разрыв до поставки';     // не доживёт даже до мин. срока
  if (dtz < LEAD) return 'риск разрыва';               // может не дожить до макс. срока
  return 'ок';
};

const whReports = [];
for (const w of warehouses) {
  // ключи: всё, что есть на складе ИЛИ продавалось со склада
  const keys = new Set();
  for (const k of stockWN.keys()) if (k.startsWith(w.id + '|')) keys.add(Number(k.split('|')[1]));
  for (const k of velWN.keys()) if (k.startsWith(w.id + '|')) keys.add(Number(k.split('|')[1]));
  const rows = [];
  for (const nm of keys) {
    const stk = stockWN.get(`${w.id}|${nm}`) || 0;
    const perDay = perDayOf(w.id, nm);
    if (stk === 0 && perDay === 0) continue;           // нечего показывать
    const dtz = perDay > 0 ? stk / perDay : (stk > 0 ? Infinity : 0);
    const reorder = Math.max(0, Math.ceil(perDay * HORIZON - stk));
    const vc = nmVendor.get(nm) || String(nm);
    const { num, numInt, variant } = parseArt(vc);
    rows.push({
      nmID: nm, vendorCode: vc, articleNum: num, articleNumInt: numInt, variant,
      stock: stk, perDay: +perDay.toFixed(2),
      daysToZero: dtz === Infinity ? null : +dtz.toFixed(1),
      reorderQty: reorder, status: statusOf(perDay, stk, dtz),
    });
  }
  // Сортировка: артикул № → цвет → количество (подсорт) убыв.
  rows.sort((a, b) => (a.articleNumInt - b.articleNumInt) || a.articleNum.localeCompare(b.articleNum, 'ru')
    || a.variant.localeCompare(b.variant, 'ru') || (b.reorderQty - a.reorderQty));
  whReports.push({
    warehouseId: w.id, name: w.name,
    stockUnits: rows.reduce((s, r) => s + r.stock, 0),
    reorderUnits: rows.reduce((s, r) => s + r.reorderQty, 0),
    riskCount: rows.filter((r) => r.status === 'разрыв до поставки' || r.status === 'нет остатка' || r.status === 'риск разрыва').length,
    rows,
  });
}
whReports.sort((a, b) => b.reorderUnits - a.reorderUnits || b.stockUnits - a.stockUnits);

// ── Новинки: в номенклатуре, но ни разу не на FF ────────────────────────────
const newProducts = cards
  .filter((c) => !everPlacedNm.has(c.nmID))
  .map((c) => { const { num, numInt, variant } = parseArt(c.vendorCode); return { nmID: c.nmID, vendorCode: c.vendorCode, articleNum: num, articleNumInt: numInt, variant, seedQty: SEED_MIN }; })
  .sort((a, b) => (a.articleNumInt - b.articleNumInt) || a.variant.localeCompare(b.variant, 'ru'));

const snapshot = {
  generatedAt: new Date().toISOString(),
  params: { velocityDays: VEL_DAYS, leadMin: LEAD_MIN, leadMax: LEAD, coverDays: COVER, horizonDays: HORIZON, seedMin: SEED_MIN, historyDays: HISTORY_DAYS },
  totals: {
    warehouses: whReports.length,
    reorderUnits: whReports.reduce((s, w) => s + w.reorderUnits, 0),
    riskRows: whReports.reduce((s, w) => s + w.riskCount, 0),
    newProducts: newProducts.length,
    seedUnits: newProducts.length * SEED_MIN,
    nomenclature: cards.length,
  },
  warehouses: whReports,
  newProducts,
};

log(`\nЛид-тайм: ${LEAD_MIN}–${LEAD} дн · запас: ${COVER} дн · горизонт заказа: ${HORIZON} дн · окно скорости: ${VEL_DAYS} дн`);
log(`Подсорт всего: ${snapshot.totals.reorderUnits} шт · строк в риске: ${snapshot.totals.riskRows} · новинок к заводу: ${newProducts.length} (${snapshot.totals.seedUnits} шт)`);
for (const w of whReports) {
  log(`\n=== ${w.name} === остаток ${w.stockUnits} · к подсорту ${w.reorderUnits} шт · позиций ${w.rows.length}`);
  log('Арт'.padEnd(6) + 'Цвет/вариант'.padEnd(26) + 'Ост'.padStart(5) + '/дн'.padStart(7) + 'ДоНуля'.padStart(8) + 'Подсорт'.padStart(9) + '  Статус');
  for (const r of w.rows.slice(0, 12)) {
    log(r.articleNum.padEnd(6) + r.variant.slice(0, 25).padEnd(26) + String(r.stock).padStart(5) + String(r.perDay).padStart(7) + (r.daysToZero == null ? '∞' : String(r.daysToZero)).padStart(8) + String(r.reorderQty).padStart(9) + '  ' + r.status);
  }
  if (w.rows.length > 12) log(`  … ещё ${w.rows.length - 12} строк`);
}
if (newProducts.length) {
  log(`\n=== НОВИНКИ (ни разу не на FF) — завезти по ${SEED_MIN} шт ===`);
  for (const n of newProducts.slice(0, 20)) log('  ' + n.articleNum.padEnd(6) + n.variant.slice(0, 30).padEnd(31) + `→ ${n.seedQty} шт  nmID ${n.nmID}`);
  if (newProducts.length > 20) log(`  … ещё ${newProducts.length - 20}`);
}

if (!jsonOnly) {
  fs.writeFileSync(R('fbs-replenishment.json'), JSON.stringify(snapshot, null, 2) + '\n');
  log(`\n→ ${path.relative(process.cwd(), R('fbs-replenishment.json'))}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
