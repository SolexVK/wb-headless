// scripts/fbs-replenishment.mjs — подсорт FBS по КАЖДОМУ складу и РАЗМЕРУ.
//
// ФИНАЛЬНАЯ ЛОГИКА (согласовано; основа будущего HTML-сервиса):
//   • только FF-склады (FBS); FBO не учитываем (распродаём).
//   • расчёт ДЛЯ КАЖДОГО склада отдельно И ПО КАЖДОМУ РАЗМЕРУ: скорость и остаток
//     берутся по (склад × штрихкод), где штрихкод = конкретный размер карточки.
//   • лид-тайм подсорта = сборка + доставка на FF (мин–макс, дн). Заказ покрывает
//     горизонт = leadMax + cover; статус «разрыв до поставки» = закончится раньше
//     leadMin (подсорт не успеет доехать), «риск разрыва» = может не дожить до leadMax.
//   • сортировка: артикул № → цвет → размер.
//   • ассортимент в работе — белый список номеров артикулов (articles). Весь отчёт
//     (и подсорт, и завоз) считается только по ним; сезонные вне списка — нет.
//   • пробный завоз (seed): для (склад × артикул × цвет × размер), где на складе
//     этого размера ещё не было, — seedMin шт на КАЖДЫЙ размер. kind: «новинка»
//     (карточка не была ни на одном FF) / «докладка» (есть на других складах).
//
// Настройки — config/replenishment.json (articles, seedMin, velocityDays,
// leadMax, leadMin, cover). CLI переопределяет конфиг.
//
//   npm run fbs:podsort   # весь конвейер: stock → replenish → dashboard → xlsx
//   npm run fbs:replenish -- --articles 002,003 --cover 28 --seed-min 10 --json
//
// Данные: GET /api/v3/orders (спрос по складу×штрихкоду; история 90 дн),
//   снимок остатков reports-output/fbs-stock.json (остаток по штрихкоду),
//   content/v2/get/cards/list (размеры: штрихкод → techSize, все размеры карточки).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
// REPORTS_OUTPUT_DIR — папка ввода/вывода (для мультитенант-сервиса, свой каталог на кабинет).
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config/replenishment.json'), 'utf8')); } catch { /* дефолты */ }
const numOr = (name, cfgKey, def) => { const v = arg(name, null); return Number(v != null ? v : (CFG[cfgKey] != null ? CFG[cfgKey] : def)); };
const VEL_DAYS = numOr('velocity-days', 'velocityDays', 28);
const LEAD = numOr('lead', 'leadMax', 18);
const LEAD_MIN = numOr('lead-min', 'leadMin', 12);
const COVER = numOr('cover', 'cover', 28);
const SEED_MIN = numOr('seed-min', 'seedMin', 10);
const HISTORY_DAYS = numOr('history-days', 'historyDays', 90);
// Флаг --articles/--seed-articles ПЕРЕДАН (сервис всегда его передаёт, пусть и пустым) →
// уважаем его как есть: пусто = все артикулы (см. inScope). НЕ подставляем config-список
// (это ассортимент одного продавца — в мультитенанте была бы утечка между кабинетами).
// Флаг ОТСУТСТВУЕТ (одно-продавцовый CLI-прогон) → берём список из config как раньше.
const artFlagPresent = process.argv.includes('--articles') || process.argv.includes('--seed-articles');
const artArg = arg('articles', arg('seed-articles', null));
const articles = artFlagPresent
  ? (artArg ? artArg.split(',').map((s) => s.trim()).filter(Boolean) : [])
  : (CFG.articles || CFG.seedArticles || []);
const scopeInts = new Set(articles.map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n)));
const inScope = (numInt) => !scopeInts.size || scopeInts.has(numInt);
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };
const HORIZON = LEAD + COVER;

// Артикул: ведущий номер + вариант (цвет).
function parseArt(vc) {
  const s = String(vc || '');
  const m = s.match(/^\s*(\d+)/);
  const num = m ? m[1] : '';
  const numInt = m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  let variant = s.slice(m ? m[0].length : 0).replace(/^[\s_\-/]+/, '').trim();
  if (!variant) variant = s;
  return { num, numInt, variant };
}
// Порядок размеров для сортировки.
const SZ = { XXS: -4, XS: -3, S: -2, M: -1, L: 0, XL: 1, XXL: 2, '2XL': 2, '3XL': 3, '4XL': 4, '5XL': 5, '6XL': 6, '7XL': 7 };
function sizeRank(ts) {
  const t = String(ts || '').trim().toUpperCase();
  if (t in SZ) return SZ[t];
  const m = t.match(/^\d+/);
  if (m) return 100 + parseInt(m[0], 10);
  return 900;
}

// ── Остатки по (склад × штрихкод=размер) ────────────────────────────────────
if (!fs.existsSync(R('fbs-stock.json'))) { log('Нет reports-output/fbs-stock.json — сначала: npm run fbs:stock'); process.exit(1); }
const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const warehouses = (stock.warehouses || []).map((w) => ({ id: w.id, name: w.name }));
const stockWB = new Map();       // "wid|barcode" → amount
const bcMeta = new Map();         // barcode → { nmID, vendorCode }
for (const w of stock.warehouses || []) {
  for (const p of w.positions || []) {
    stockWB.set(`${w.id}|${p.sku}`, (stockWB.get(`${w.id}|${p.sku}`) || 0) + p.amount);
    if (!bcMeta.has(p.sku)) bcMeta.set(p.sku, { nmID: p.nmID, vendorCode: p.vendorCode });
  }
}

// ── Заказы: история 90 дн (chunks ≤30) — присутствие и скорость по штрихкоду ──
async function fetchRange(fromSec, toSec) {
  const out = []; let next = 0;
  for (;;) {
    const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: fromSec, dateTo: toSec }, methodLimit: MP });
    const b = data.orders || []; out.push(...b);
    if (b.length < 1000 || data.next == null || data.next === next) break; next = data.next;
  }
  return out;
}
const nowSec = Math.floor(Date.now() / 1000);
const histStart = nowSec - HISTORY_DAYS * 86400;
let allOrders = [];
for (let end = nowSec; end > histStart;) {
  const from = Math.max(histStart, end - 30 * 86400);
  const part = await fetchRange(from, end);
  allOrders.push(...part);
  log(`  orders ${new Date(from * 1000).toISOString().slice(0, 10)}..${new Date(end * 1000).toISOString().slice(0, 10)}: +${part.length} (${allOrders.length})`);
  end = from;
}
const velCut = nowSec - VEL_DAYS * 86400;
const everPlacedNm = new Set();          // nmID был хоть на одном FF
const velWB = new Map();                  // "wid|barcode" → заказы за окно скорости
const placedWB = new Set();               // "wid|barcode" → был на этом складе (история/остаток)
for (const bc of bcMeta.keys()) { /* остаток учтём ниже */ }
for (const k of stockWB.keys()) if (stockWB.get(k) > 0) placedWB.add(k);
for (const p of stock.warehouses || []) for (const q of p.positions || []) everPlacedNm.add(q.nmID);
for (const o of allOrders) {
  everPlacedNm.add(o.nmId);
  const created = Math.floor(new Date(o.createdAt).getTime() / 1000);
  for (const bc of (o.skus || [])) {
    if (!bcMeta.has(bc)) bcMeta.set(bc, { nmID: o.nmId, vendorCode: o.article });
    placedWB.add(`${o.warehouseId}|${bc}`);
    if (created >= velCut) velWB.set(`${o.warehouseId}|${bc}`, (velWB.get(`${o.warehouseId}|${bc}`) || 0) + 1);
  }
}

// ── Карточки: штрихкод → размер; все размеры карточки ───────────────────────
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
const bcSize = new Map();     // barcode → { techSize, nmID, vendorCode }
const cardSizes = new Map();  // nmID → [{ barcode, techSize }]
for (const c of cards) {
  const list = [];
  for (const s of c.sizes || []) {
    for (const bc of (s.skus || [])) {
      bcSize.set(bc, { techSize: s.techSize || '', nmID: c.nmID, vendorCode: c.vendorCode });
      if (!bcMeta.has(bc)) bcMeta.set(bc, { nmID: c.nmID, vendorCode: c.vendorCode });
      list.push({ barcode: bc, techSize: s.techSize || '' });
    }
  }
  cardSizes.set(c.nmID, list);
}
const sizeOf = (bc) => (bcSize.get(bc)?.techSize) || '—';
const vendorOf = (bc) => (bcMeta.get(bc)?.vendorCode) || (bcSize.get(bc)?.vendorCode) || '';
const nmOf = (bc) => (bcMeta.get(bc)?.nmID) ?? (bcSize.get(bc)?.nmID);

// ── Подсорт по складу × размеру ─────────────────────────────────────────────
const statusOf = (perDay, stk, dtz) => {
  if (perDay === 0) return stk > 0 ? 'неликвид' : 'нет данных';
  if (stk === 0) return 'нет остатка';
  if (dtz < LEAD_MIN) return 'разрыв до поставки';
  if (dtz < LEAD) return 'риск разрыва';
  return 'ок';
};
const whReports = [];
for (const w of warehouses) {
  const bcs = new Set();
  for (const k of stockWB.keys()) if (k.startsWith(w.id + '|')) bcs.add(k.slice(String(w.id).length + 1));
  for (const k of velWB.keys()) if (k.startsWith(w.id + '|')) bcs.add(k.slice(String(w.id).length + 1));
  const rows = [];
  for (const bc of bcs) {
    const stk = stockWB.get(`${w.id}|${bc}`) || 0;
    const perDay = (velWB.get(`${w.id}|${bc}`) || 0) / VEL_DAYS;
    if (stk === 0 && perDay === 0) continue;
    const vc = vendorOf(bc);
    const { num, numInt, variant } = parseArt(vc);
    if (!inScope(numInt)) continue;
    const dtz = perDay > 0 ? stk / perDay : (stk > 0 ? Infinity : 0);
    const reorder = Math.max(0, Math.ceil(perDay * HORIZON - stk));
    const techSize = sizeOf(bc);
    rows.push({
      nmID: nmOf(bc), barcode: bc, articleNum: num, articleNumInt: numInt, variant, techSize, sizeRank: sizeRank(techSize),
      stock: stk, perDay: +perDay.toFixed(2), daysToZero: dtz === Infinity ? null : +dtz.toFixed(1), reorderQty: reorder, status: statusOf(perDay, stk, dtz),
    });
  }
  rows.sort((a, b) => (a.articleNumInt - b.articleNumInt) || a.variant.localeCompare(b.variant, 'ru') || (a.sizeRank - b.sizeRank) || String(a.techSize).localeCompare(String(b.techSize), 'ru'));
  whReports.push({
    warehouseId: w.id, name: w.name,
    stockUnits: rows.reduce((s, r) => s + r.stock, 0),
    reorderUnits: rows.reduce((s, r) => s + r.reorderQty, 0),
    riskCount: rows.filter((r) => ['разрыв до поставки', 'нет остатка', 'риск разрыва'].includes(r.status)).length,
    rows,
  });
}
whReports.sort((a, b) => b.reorderUnits - a.reorderUnits || b.stockUnits - a.stockUnits);

// ── Пробный завоз по складу × размеру (белый список) ────────────────────────
const regWarehouses = warehouses;
const seedGrid = [];
for (const c of cards) {
  const { num, numInt, variant } = parseArt(c.vendorCode);
  if (!inScope(numInt)) continue;
  const kind = everPlacedNm.has(c.nmID) ? 'докладка' : 'новинка';
  for (const s of (cardSizes.get(c.nmID) || [])) {
    const seedByWarehouse = {}; let seedTotal = 0;
    for (const w of regWarehouses) {
      if (placedWB.has(`${w.id}|${s.barcode}`)) continue; // уже есть на складе (этот размер)
      seedByWarehouse[w.name] = SEED_MIN; seedTotal += SEED_MIN;
    }
    if (seedTotal === 0) continue;
    seedGrid.push({
      nmID: c.nmID, barcode: s.barcode, articleNum: num, articleNumInt: numInt, variant,
      techSize: s.techSize || '—', sizeRank: sizeRank(s.techSize), kind, seedByWarehouse, seedTotal,
    });
  }
}
seedGrid.sort((a, b) => (a.articleNumInt - b.articleNumInt) || a.variant.localeCompare(b.variant, 'ru') || (a.sizeRank - b.sizeRank));

// ── Сводная: подсорт по (артикул × цвет × размер) × склад ────────────────────
const pivotMap = new Map(); // key → { articleNum, articleNumInt, variant, techSize, sizeRank, byWarehouse:{}, total }
for (const w of whReports) {
  for (const r of w.rows) {
    if (!r.reorderQty) continue;
    const key = `${r.articleNum}|${r.variant}|${r.techSize}`;
    if (!pivotMap.has(key)) pivotMap.set(key, { articleNum: r.articleNum, articleNumInt: r.articleNumInt, variant: r.variant, techSize: r.techSize, sizeRank: r.sizeRank, byWarehouse: {}, total: 0 });
    const e = pivotMap.get(key);
    e.byWarehouse[w.name] = (e.byWarehouse[w.name] || 0) + r.reorderQty;
    e.total += r.reorderQty;
  }
}
const pivot = [...pivotMap.values()].sort((a, b) => (a.articleNumInt - b.articleNumInt) || a.variant.localeCompare(b.variant, 'ru') || (a.sizeRank - b.sizeRank));

const snapshot = {
  generatedAt: new Date().toISOString(),
  params: { velocityDays: VEL_DAYS, leadMin: LEAD_MIN, leadMax: LEAD, coverDays: COVER, horizonDays: HORIZON, seedMin: SEED_MIN, historyDays: HISTORY_DAYS, articles },
  totals: {
    warehouses: whReports.length,
    registeredWarehouses: regWarehouses.length,
    reorderUnits: whReports.reduce((s, w) => s + w.reorderUnits, 0),
    riskRows: whReports.reduce((s, w) => s + w.riskCount, 0),
    seedRows: seedGrid.length,
    seedNovelty: seedGrid.filter((r) => r.kind === 'новинка').length,
    seedRefill: seedGrid.filter((r) => r.kind === 'докладка').length,
    seedUnits: seedGrid.reduce((s, r) => s + r.seedTotal, 0),
    pivotRows: pivot.length,
    nomenclature: cards.length,
  },
  warehouseList: regWarehouses.map((w) => w.name),
  warehouses: whReports,
  seedGrid,
  pivot,
};

log(`\nЛид-тайм ${LEAD_MIN}–${LEAD} дн · запас ${COVER} · горизонт ${HORIZON} · окно скорости ${VEL_DAYS} дн`);
if (articles.length) log(`Ассортимент: ${articles.join(', ')}`);
log(`Подсорт всего ${snapshot.totals.reorderUnits} шт · строк в риске ${snapshot.totals.riskRows} · сводная строк (арт×цвет×размер) ${pivot.length}`);
log(`Пробный завоз ${seedGrid.length} строк (новинок ${snapshot.totals.seedNovelty} + докладок ${snapshot.totals.seedRefill}) = ${snapshot.totals.seedUnits} шт`);
for (const w of whReports.slice(0, 3)) {
  log(`\n=== ${w.name} === остаток ${w.stockUnits} · подсорт ${w.reorderUnits} шт · строк ${w.rows.length}`);
  log('Арт'.padEnd(5) + 'Цвет'.padEnd(20) + 'Разм'.padEnd(6) + 'Ост'.padStart(5) + '/дн'.padStart(7) + 'Подсорт'.padStart(9) + '  Статус');
  for (const r of w.rows.slice(0, 10)) log(r.articleNum.padEnd(5) + r.variant.slice(0, 19).padEnd(20) + String(r.techSize).padEnd(6) + String(r.stock).padStart(5) + String(r.perDay).padStart(7) + String(r.reorderQty).padStart(9) + '  ' + r.status);
  if (w.rows.length > 10) log(`  … ещё ${w.rows.length - 10}`);
}

if (!jsonOnly) {
  fs.writeFileSync(R('fbs-replenishment.json'), JSON.stringify(snapshot, null, 2) + '\n');
  log(`\n→ ${path.relative(process.cwd(), R('fbs-replenishment.json'))}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
