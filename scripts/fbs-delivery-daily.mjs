// scripts/fbs-delivery-daily.mjs — суточная серия «передано в доставку» по FBS.
//
// По аналогии со сторонним дашбордом «Выберите день»:
//   • прошедшие дни — сколько сборочных заданий ФАКТИЧЕСКИ передано в доставку
//     в этот день (по supply.closedAt), всего и по каждому нашему фулфилменту;
//   • сегодня — «заданий в плане» (создано сегодня, ещё в работе/уже отгружено).
//
// Окно: сегодня + 7 полных прошедших дней (по МСК, переопределяется --tz/--days).
// Заказы тянем с запасом назад, чтобы поймать отгрузки, созданные ранее окна.
//
//   npm run fbs:delivery            # снимок → reports-output/fbs-delivery-daily.json
//   node scripts/fbs-delivery-daily.mjs --days 7 --tz +03:00 --json
//
// Методы: GET /api/v3/orders (createdAt, warehouseId, supplyId) +
//         GET /api/v3/supplies (closedAt/done). Лимиты держит lib/wbClient.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PAST_DAYS = Number(arg('days', 7));           // сколько полных прошедших дней
const TZ = arg('tz', '+03:00');                      // деловой день по Москве
const BUFFER = 5;                                    // запас на отгрузки из «до окна»
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };

let WH_NAME = {};
try { for (const w of JSON.parse(fs.readFileSync(path.join(REPO, 'config/warehouses.json'), 'utf8')).warehouses || []) WH_NAME[w.id] = w.name; } catch { /* */ }

// Смещение TZ в минутах из строки вида "+03:00".
const tzMin = (() => { const m = /^([+-])(\d{2}):(\d{2})$/.exec(TZ); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 180; })();
const dayOf = (iso) => (iso ? new Date(new Date(iso).getTime() + tzMin * 60000).toISOString().slice(0, 10) : null);

// Сегодня и список дней окна (сегодня-первым, затем прошедшие по убыванию).
const todayStr = new Date(Date.now() + tzMin * 60000).toISOString().slice(0, 10);
const windowDays = [todayStr];
for (let i = 1; i <= PAST_DAYS; i++) {
  windowDays.push(new Date(Date.parse(todayStr + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10));
}
const inWindow = new Set(windowDays);

// ── Заказы за окно+буфер ────────────────────────────────────────────────────
async function fetchOrders() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = Math.floor(Date.parse(windowDays[windowDays.length - 1] + 'T00:00:00Z') / 1000) - BUFFER * 86400;
  const orders = []; let next = 0;
  for (let p = 1; ; p++) {
    const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: fromSec, dateTo: nowSec }, methodLimit: MP });
    const b = data.orders || []; orders.push(...b);
    log(`  orders: стр.${p} +${b.length} (${orders.length})`);
    if (b.length < 1000) break; next = data.next;
  }
  return orders;
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

const orders = await fetchOrders();
const supplies = await fetchSupplies(new Set(orders.map((o) => o.supplyId).filter(Boolean)));

// ── Агрегация по дням ───────────────────────────────────────────────────────
// day → { fact: {wid:count}, plan: {wid:count} }
const byDay = new Map();
const bump = (day, kind, wid) => {
  if (!inWindow.has(day)) return;
  if (!byDay.has(day)) byDay.set(day, { fact: {}, plan: {} });
  const g = byDay.get(day)[kind];
  g[wid] = (g[wid] || 0) + 1;
};
const whSeen = new Set();
for (const o of orders) {
  whSeen.add(o.warehouseId);
  bump(dayOf(o.createdAt), 'plan', o.warehouseId);              // план — по дате создания
  const s = o.supplyId ? supplies.get(o.supplyId) : null;
  const closed = s && (s.done || s.closedAt) ? s.closedAt : null;
  if (closed) bump(dayOf(closed), 'fact', o.warehouseId);       // факт — по дате передачи в доставку
}

const fulfillments = [...whSeen].map((id) => ({ id, name: WH_NAME[id] || String(id) })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const nameById = Object.fromEntries(fulfillments.map((f) => [f.id, f.name]));

const days = windowDays.map((date) => {
  const isToday = date === todayStr;
  const kind = isToday ? 'plan' : 'fact';
  const src = byDay.get(date)?.[kind] || {};
  const byFulfillment = {};
  let total = 0;
  for (const [wid, c] of Object.entries(src)) { byFulfillment[nameById[wid] || wid] = c; total += c; }
  const extra = isToday ? { shippedToday: Object.values(byDay.get(date)?.fact || {}).reduce((a, b) => a + b, 0) } : {};
  return { date, isToday, kind, metric: isToday ? 'заданий в плане' : 'передано в доставку', total, byFulfillment, ...extra };
});

// Итоги по фулфилментам за 7 прошедших дней (факт).
const totalsByFulfillment = {};
for (const d of days) if (!d.isToday) for (const [n, c] of Object.entries(d.byFulfillment)) totalsByFulfillment[n] = (totalsByFulfillment[n] || 0) + c;

const snapshot = {
  generatedAt: new Date().toISOString(),
  tz: TZ,
  today: todayStr,
  pastDays: PAST_DAYS,
  fulfillments: fulfillments.map((f) => f.name),
  days,
  totalsByFulfillment,
  factTotal7d: days.filter((d) => !d.isToday).reduce((s, d) => s + d.total, 0),
  planToday: days.find((d) => d.isToday)?.total || 0,
};

log(`\nОкно (МСК): ${windowDays.join(', ')}`);
log('День'.padEnd(12) + 'Метрика'.padEnd(22) + 'Всего'.padStart(8));
for (const d of days) log(d.date.padEnd(12) + (d.isToday ? 'план (создано сегодня)' : 'передано в доставку').padEnd(22) + String(d.total).padStart(8));
log(`\nФакт за ${PAST_DAYS} дн.: ${snapshot.factTotal7d} | план сегодня: ${snapshot.planToday}`);
log('По фулфилментам (7 дн.): ' + Object.entries(totalsByFulfillment).map(([n, c]) => `${n} ${c}`).join(' · '));

if (!jsonOnly) {
  const out = path.join(REPO, 'reports-output', 'fbs-delivery-daily.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  log(`\n→ ${path.relative(process.cwd(), out)}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
