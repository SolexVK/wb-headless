// scripts/fbs-movement.mjs — «Движение заказов» FBS для веб-сервиса.
//
// Один пайплайн для двух отчётов, «Принято по дням» и «Передано в доставку»:
//   • accepted  — сборочные задания, СОЗДАННЫЕ в этот день (по createdAt);
//   • delivered — задания, чья ПОСТАВКА закрыта в этот день (по supply.closedAt).
// Для каждого дня и каждого нашего фулфилмента считаем количество (шт) и сумму (₽,
// из order.price/100). Отдаём серию по дням за 2×N (текущий период + предыдущий,
// чтобы сервис мог показать сравнение), не глубже ~88 дней (лимит WB — 3 месяца).
//
//   node scripts/fbs-movement.mjs --days 14 --tz +03:00 --articles 018,020 --json
//
// Методы: GET /api/v3/orders (createdAt, warehouseId, supplyId, price, article) +
//         GET /api/v3/supplies (closedAt/done). Лимиты держит lib/wbClient.js.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR
  ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = Math.min(45, Math.max(1, Number(arg('days', 14))));   // период отображения N
const TZ = arg('tz', '+03:00');                                    // деловой день (МСК)
const ARTICLES = String(arg('articles', '')).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
const jsonOnly = process.argv.includes('--json');
const BUFFER = 5;                                                   // запас на отгрузки «до окна»
const MAX_BACK = 88;                                               // WB хранит ~3 месяца
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };

let WH_NAME = {};
try { for (const w of JSON.parse(fs.readFileSync(path.join(REPO, 'config/warehouses.json'), 'utf8')).warehouses || []) WH_NAME[w.id] = w.name; } catch { /* */ }

// ── Фильтр по артикулам (по ведущему номеру модели, как в подсорте) ──────────
const norm = (t) => { const m = String(t).match(/^\s*0*(\d+)/); return m ? m[1] : String(t).trim().toLowerCase(); };
const artSet = new Set(ARTICLES.map(norm));
const artNum = (a) => { const m = String(a || '').match(/^\s*(\d+)/); return m ? String(Number(m[1])) : String(a || '').trim().toLowerCase(); };
const passArticle = (o) => artSet.size === 0 || artSet.has(artNum(o.article)) || artSet.has(String(o.article || '').trim().toLowerCase());

// ── Окно по МСК ──────────────────────────────────────────────────────────────
const tzMin = (() => { const m = /^([+-])(\d{2}):(\d{2})$/.exec(TZ); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 180; })();
const dayOf = (iso) => (iso ? new Date(new Date(iso).getTime() + tzMin * 60000).toISOString().slice(0, 10) : null);
const todayStr = new Date(Date.now() + tzMin * 60000).toISOString().slice(0, 10);
const span = Math.min(MAX_BACK, 2 * DAYS);          // сколько дней серии (текущий + предыдущий период)
const seriesDays = [];                               // от старых к новым
for (let i = span - 1; i >= 0; i--) seriesDays.push(new Date(Date.parse(todayStr + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10));
const inWindow = new Set(seriesDays);

// ── Заказы за окно+буфер (кусками ≤28 дней, дедуп по id) ─────────────────────
async function fetchOrders() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = Math.floor(Date.parse(seriesDays[0] + 'T00:00:00Z') / 1000) - BUFFER * 86400;
  const CHUNK = 28 * 86400;
  const byId = new Map();
  for (let end = nowSec; end > fromSec;) {
    const start = Math.max(fromSec, end - CHUNK);
    let next = 0;
    for (let p = 1; ; p++) {
      const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: start, dateTo: end }, methodLimit: MP });
      const b = data.orders || [];
      for (const o of b) byId.set(o.id ?? `${o.rid}`, o);
      log(`  orders ${new Date(start * 1000).toISOString().slice(0, 10)}..${new Date(end * 1000).toISOString().slice(0, 10)}: стр.${p} +${b.length} (${byId.size})`);
      if (b.length < 1000) break; next = data.next;
    }
    end = start;
  }
  return [...byId.values()];
}
async function fetchSupplies(neededIds) {
  const map = new Map(); let next = 0;
  for (let p = 1; ; p++) {
    const { data } = await wb.get('marketplace', '/api/v3/supplies', { query: { limit: 1000, next }, methodLimit: MP });
    const b = data.supplies || []; for (const s of b) map.set(s.id, s);
    if (b.length < 1000) break; next = data.next;
  }
  const missing = [...neededIds].filter((id) => id && !map.has(id));
  for (const id of missing) { try { const { data } = await wb.get('marketplace', `/api/v3/supplies/${id}`, { methodLimit: MP }); map.set(id, data); } catch (e) { log(`  ! supply ${id}: ${e.message}`); } }
  return map;
}

// Средняя цена продажи (finishedPrice) по nmID за последние 7 дней из статистики.
// Лимит метода — 1 запрос/мин. Возврат: {map: nmID→avg, overall, available, rows}.
async function fetchAvgSalePrices() {
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const byNm = new Map(); let rows = 0, sum = 0;
  const seen = new Set();
  try {
    let dateFrom = from;
    for (let page = 1; page <= 6; page++) {
      const { data } = await wb.get('statistics', '/api/v1/supplier/sales', { query: { dateFrom }, methodLimit: { limit: 1, periodSec: 60, burst: 1 } });
      const b = Array.isArray(data) ? data : [];
      let last = null;
      for (const s of b) {
        if (s.srid && seen.has(s.srid)) continue;
        if (s.srid) seen.add(s.srid);
        const fp = Number(s.finishedPrice) || 0;
        if (fp <= 0) continue;
        if (!byNm.has(s.nmId)) byNm.set(s.nmId, { c: 0, sum: 0 });
        const e = byNm.get(s.nmId); e.c += 1; e.sum += fp;
        rows += 1; sum += fp; last = s.lastChangeDate || last;
      }
      log(`  sales стр.${page}: +${b.length} (nmID ${byNm.size}, строк ${rows})`);
      if (b.length < 80000 || !last) break; dateFrom = last;
    }
  } catch (e) {
    log(`  ! статистика продаж недоступна: ${e.message}`);
    return { map: new Map(), overall: 0, available: false, rows: 0 };
  }
  const map = new Map(); for (const [nm, e] of byNm) map.set(nm, e.sum / e.c);
  return { map, overall: rows ? sum / rows : 0, available: rows > 0, rows };
}

const orders = (await fetchOrders()).filter(passArticle);
const supplies = await fetchSupplies(new Set(orders.map((o) => o.supplyId).filter(Boolean)));
const sales = await fetchAvgSalePrices();

// ── Агрегация: день → { accepted, delivered } → { [wid]: {count, money} } ─────
const byDay = new Map();
const bump = (day, kind, wid, rub, avg) => {
  if (!day || !inWindow.has(day)) return;
  if (!byDay.has(day)) byDay.set(day, { accepted: {}, delivered: {} });
  const g = byDay.get(day)[kind];
  if (!g[wid]) g[wid] = { count: 0, money: 0, moneyAvg: 0 };
  g[wid].count += 1; g[wid].money += rub; g[wid].moneyAvg += avg;
};
const whSeen = new Set();
for (const o of orders) {
  whSeen.add(o.warehouseId);
  const rub = Math.round((Number(o.price) || 0)) / 100;              // price в копейках → ₽
  const avg = sales.map.get(o.nmId) ?? sales.overall;               // ср. цена продажи 7д (фолбэк — общая средняя)
  bump(dayOf(o.createdAt), 'accepted', o.warehouseId, rub, avg);
  const s = o.supplyId ? supplies.get(o.supplyId) : null;
  const closed = s && (s.done || s.closedAt) ? s.closedAt : null;
  if (closed) bump(dayOf(closed), 'delivered', o.warehouseId, rub, avg);
}

const fulfillments = [...whSeen].map((id) => ({ id, name: WH_NAME[id] || String(id) })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const nameById = Object.fromEntries(fulfillments.map((f) => [f.id, f.name]));
const r2 = (x) => Math.round(x * 100) / 100;
const roll = (src) => {
  const byFulfillment = {}; let count = 0, money = 0, moneyAvg = 0;
  for (const [wid, v] of Object.entries(src || {})) {
    const n = nameById[wid] || String(wid);
    byFulfillment[n] = { count: v.count, money: r2(v.money), moneyAvg: r2(v.moneyAvg) };
    count += v.count; money += v.money; moneyAvg += v.moneyAvg;
  }
  return { count, money: r2(money), moneyAvg: r2(moneyAvg), byFulfillment };
};

const series = seriesDays.map((date) => ({
  date,
  accepted: roll(byDay.get(date)?.accepted),
  delivered: roll(byDay.get(date)?.delivered),
}));

const snapshot = {
  generatedAt: new Date().toISOString(),
  tz: TZ,
  today: todayStr,
  days: DAYS,
  span,
  articles: ARTICLES,
  currency: '₽',
  avgSalePrice: Math.round(sales.overall),   // общая ср. цена продажи 7д (справочно)
  salesAvailable: sales.available,           // была ли доступна статистика продаж
  fulfillments: fulfillments.map((f) => f.name),
  series,
};

// Сводка последних N дней (для лога).
const last = series.slice(-DAYS);
const sum = (k) => last.reduce((s, d) => s + d[k].count, 0);
log(`\nПериод N=${DAYS} дн (серия ${span} дн)${ARTICLES.length ? `, артикулы: ${ARTICLES.join(', ')}` : ''}`);
log(`Принято: ${sum('accepted')} шт | передано: ${sum('delivered')} шт`);

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'fbs-movement.json');
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  log(`→ ${path.relative(process.cwd(), out)}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
