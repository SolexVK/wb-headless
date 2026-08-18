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
import { loadWarehouses } from './lib/warehouses.mjs';

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

// Имена складов — ЖИВЫМ запросом по токену кабинета (новые ФФ подхватятся сами); откат на config.
const WH = await loadWarehouses(wb, { methodLimit: MP });

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
  // WB /api/v3/orders не принимает окно больше ~30 дней одним запросом — тянем
  // кусками ≤28 дней (как в подсорте) и дедупим по id на стыках.
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
      if (b.length < 1000 || data.next == null || data.next === next) break; next = data.next;
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
    if (b.length < 1000 || data.next == null || data.next === next) break; next = data.next;
  }
  const missing = [...neededIds].filter((id) => id && !map.has(id));
  for (const id of missing) { try { const { data } = await wb.get('marketplace', `/api/v3/supplies/${id}`, { methodLimit: MP }); map.set(id, data); } catch (e) { log(`  ! supply ${id}: ${e.message}`); } }
  return map;
}

const orders = await fetchOrders();
const supplies = await fetchSupplies(new Set(orders.map((o) => o.supplyId).filter(Boolean)));

// ── Агрегация по дням ───────────────────────────────────────────────────────
// Два потока на каждый день/склад:
//   accepted  — принято на фулфилмент = сборочные задания, созданные в этот день;
//   delivered — передано в доставку   = задания, чья поставка закрыта в этот день.
const byDay = new Map();
const bump = (day, kind, wid) => {
  if (!inWindow.has(day)) return;
  if (!byDay.has(day)) byDay.set(day, { accepted: {}, delivered: {} });
  const g = byDay.get(day)[kind];
  g[wid] = (g[wid] || 0) + 1;
};
const whSeen = new Set();
for (const o of orders) {
  whSeen.add(o.warehouseId);
  bump(dayOf(o.createdAt), 'accepted', o.warehouseId);          // принято — по дате создания задания
  const s = o.supplyId ? supplies.get(o.supplyId) : null;
  const closed = s && (s.done || s.closedAt) ? s.closedAt : null;
  if (closed) bump(dayOf(closed), 'delivered', o.warehouseId);  // передано — по дате передачи в доставку
}

const fulfillments = [...whSeen].map((id) => ({ id, name: WH.nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
const nameById = Object.fromEntries(fulfillments.map((f) => [f.id, f.name]));
const byName = (src) => {
  const o = {}; let total = 0;
  for (const [wid, c] of Object.entries(src || {})) { o[nameById[wid] || wid] = c; total += c; }
  return { total, byFulfillment: o };
};

const days = windowDays.map((date) => {
  const isToday = date === todayStr;
  const accepted = byName(byDay.get(date)?.accepted);
  const delivered = byName(byDay.get(date)?.delivered);
  // Разница «передано − принято» по складам и всего.
  const diffBy = {};
  for (const n of new Set([...Object.keys(accepted.byFulfillment), ...Object.keys(delivered.byFulfillment)])) {
    diffBy[n] = (delivered.byFulfillment[n] || 0) - (accepted.byFulfillment[n] || 0);
  }
  const diff = { total: delivered.total - accepted.total, byFulfillment: diffBy };
  // Совместимость с дашбордом #1: total/byFulfillment = передано (прошлые дни) / принято (сегодня-план).
  const compat = isToday ? accepted : delivered;
  return { date, isToday, accepted, delivered, diff, total: compat.total, byFulfillment: compat.byFulfillment,
    metric: isToday ? 'заданий в плане' : 'передано в доставку' };
});

const sumBy = (pick) => days.filter((d) => !d.isToday).reduce((acc, d) => {
  for (const [n, c] of Object.entries(pick(d).byFulfillment)) acc[n] = (acc[n] || 0) + c;
  return acc;
}, {});
const totalsByFulfillment = sumBy((d) => d.delivered);   // передано за 7 дн. по складам
const acceptedByFulfillment = sumBy((d) => d.accepted);  // принято за 7 дн. по складам

const snapshot = {
  generatedAt: new Date().toISOString(),
  tz: TZ,
  today: todayStr,
  pastDays: PAST_DAYS,
  fulfillments: fulfillments.map((f) => f.name),
  days,
  totalsByFulfillment,
  acceptedByFulfillment,
  factTotal7d: days.filter((d) => !d.isToday).reduce((s, d) => s + d.delivered.total, 0),
  acceptedTotal7d: days.filter((d) => !d.isToday).reduce((s, d) => s + d.accepted.total, 0),
  planToday: days.find((d) => d.isToday)?.accepted.total || 0,
};
snapshot.diffTotal7d = snapshot.factTotal7d - snapshot.acceptedTotal7d;

log(`\nОкно (МСК): ${windowDays.join(', ')}`);
log('День'.padEnd(12) + 'Принято'.padStart(9) + 'Передано'.padStart(10) + 'Разница'.padStart(10));
for (const d of days) log(d.date.padEnd(12) + String(d.accepted.total).padStart(9) + String(d.delivered.total).padStart(10) + (d.diff.total >= 0 ? '+' : '') + String(d.diff.total).padStart(d.diff.total >= 0 ? 9 : 10));
log(`\nПринято за ${PAST_DAYS} дн.: ${snapshot.acceptedTotal7d} | передано: ${snapshot.factTotal7d} | разница: ${snapshot.diffTotal7d >= 0 ? '+' : ''}${snapshot.diffTotal7d}`);
log('Принято по фулфилментам (7 дн.): ' + Object.entries(acceptedByFulfillment).map(([n, c]) => `${n} ${c}`).join(' · '));

if (!jsonOnly) {
  const out = path.join(REPO, 'reports-output', 'fbs-delivery-daily.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  log(`\n→ ${path.relative(process.cwd(), out)}`);
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
