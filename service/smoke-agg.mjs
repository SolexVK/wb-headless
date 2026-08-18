// service/smoke-agg.mjs — юнит-тесты чистых агрегаторов отчётов на фиксированных
// входах (без сети). Числа посчитаны вручную в комментариях — это защита от
// регрессий в сроках/медианах/бакетах, которую не даёт smoke-reports (fake-путь).
//
//   node smoke-agg.mjs
import { avg, median, pct, r2, mskDate } from '../scripts/lib/agg/stats.mjs';
import { buildAssembly, buildDelivery } from '../scripts/lib/agg/logistics.mjs';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'}  ${msg}`); if (!cond) failed++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (${JSON.stringify(a)} = ${JSON.stringify(b)})`);

// ── stats ─────────────────────────────────────────────────────────────────────
eq(avg([]), 0, 'avg пусто → 0');
eq(avg([2, 4]), 3, 'avg [2,4] = 3');
eq(median([]), 0, 'median пусто → 0');
eq(median([1, 2, 3]), 2, 'median нечёт = центр');
eq(median([1, 2, 3, 4]), 2.5, 'median чёт = среднее двух центральных');
eq(pct([10, 20, 30, 40, 50], 90), 50, 'p90 из 5 = верхний');
eq(pct([1, 2, 3, 4], 90), 4, 'p90 из 4 (ближайший ранг)');
eq(r2(3.14159), 3.14, 'r2 до 2 знаков');
// MSK-нормализация: дата без смещения трактуется как +03:00, с Z — остаётся UTC.
eq(mskDate('2026-08-10T09:00:00').getTime(), Date.parse('2026-08-10T09:00:00+03:00'), 'mskDate без смещения → +03:00');
eq(mskDate('2026-08-10T09:00:00Z').getTime(), Date.parse('2026-08-10T09:00:00Z'), 'mskDate с Z → UTC как есть');

// ── СБОРКА: createdAt → closedAt ────────────────────────────────────────────────
// ФФ «A»: o1 +10ч, o2 +50ч (крит >48), o3 без закрытия (pending). ФФ «B»: o4 +4ч.
const asmFromSec = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);
const orders = [
  { ff: 'A', warehouseId: 1, createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-01T10:00:00Z', article: '001' },
  { ff: 'A', warehouseId: 1, createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-03T02:00:00Z', article: '002' }, // +50ч
  { ff: 'A', warehouseId: 1, createdAt: '2026-08-01T00:00:00Z', closedAt: null, article: '003' },
  { ff: 'B', warehouseId: 2, createdAt: '2026-08-02T00:00:00Z', closedAt: '2026-08-02T04:00:00Z', article: '004' },
];
const closedOf = (o) => o.closedAt || null;
const asm = buildAssembly(orders, closedOf, { critH: 48, asmFromSec });
eq(asm.totals.orders, 4, 'сборка: всего заданий 4');
eq(asm.totals.processed, 3, 'сборка: обработано 3');
eq(asm.totals.pending, 1, 'сборка: в работе 1');
eq(asm.totals.avgHours, 21.33, 'сборка: среднее (10+50+4)/3 = 21.33');
eq(asm.totals.medianHours, 10, 'сборка: медиана [4,10,50] = 10');
eq(asm.totals.p90Hours, 50, 'сборка: p90 = 50');
eq(asm.totals.criticalCount, 1, 'сборка: критичных (>48ч) = 1');
eq(asm.byFF.map((r) => r.ff), ['A', 'B'], 'сборка: ФФ отсортированы по объёму');
eq(asm.byFF[0], { ff: 'A', warehouseId: 1, made: 3, processed: 2, pending: 1, avgHours: 30, medianHours: 30, p90Hours: 50, maxHours: 50, criticalCount: 1 }, 'сборка: строка ФФ «A» точная');
eq(asm.buckets, { '<6ч': 1, '6–24ч': 1, '24–48ч': 0, '>48ч': 1 }, 'сборка: бакеты часов');
eq(asm.critical.length, 1, 'сборка: один критичный в списке');

// ── ДОСТАВКА: closedAt(ship) → sale.date, привязка по srid==rid ─────────────────
// r1(A) выкуп +45ч; r1 возврат R — игнор; r2(A) +117ч; r3(B) без поставки → ship=createdAt +21ч;
// rX неизвестен → не привязан.
const ridMap = new Map([
  ['r1', { ff: 'A', createdAt: '2026-08-10T00:00:00Z', closedAt: '2026-08-10T00:00:00Z' }],
  ['r2', { ff: 'A', createdAt: '2026-08-10T00:00:00Z', closedAt: '2026-08-10T00:00:00Z' }],
  ['r3', { ff: 'B', createdAt: '2026-08-10T00:00:00Z', closedAt: null }],
]);
const delClosedOf = (o) => o.closedAt || null;
const sales = [
  { srid: 'r1', saleID: 'S1', date: '2026-08-12T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный' }, // +45ч
  { srid: 'r1', saleID: 'R1', date: '2026-08-20T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный' }, // возврат → игнор
  { srid: 'r2', saleID: 'S2', date: '2026-08-15T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный' }, // +117ч
  { srid: 'rX', saleID: 'S9', date: '2026-08-12T00:00:00', regionName: 'Тула', oblastOkrugName: 'Центральный' }, // нет в ridMap
  { srid: 'r3', saleID: 'S4', date: '2026-08-11T00:00:00', regionName: 'СПб', oblastOkrugName: 'Северо-Западный' }, // +21ч (ship=createdAt)
];
const del = buildDelivery(sales, ridMap, delClosedOf);
eq(del.available, true, 'доставка: есть данные');
eq(del.totals.joined, 3, 'доставка: привязано выкупов 3 (rX не привязан, возврат не в счёт)');
eq(del.totals.count, 3, 'доставка: измерено 3');
eq(del.totals.avgHours, 61, 'доставка: среднее (45+117+21)/3 = 61');
eq(del.totals.medianHours, 45, 'доставка: медиана [21,45,117] = 45');
eq(del.totals.p90Hours, 117, 'доставка: p90 = 117');
eq(del.byFF.map((r) => [r.ff, r.count]), [['A', 2], ['B', 1]], 'доставка: по ФФ (A:2, B:1)');
eq(del.byFF[0], { ff: 'A', count: 2, avgHours: 81, medianHours: 81, p90Hours: 117, minHours: 45, maxHours: 117 }, 'доставка: строка ФФ «A» точная');
eq(del.buckets, { '<2 сут': 2, '2–4 сут': 0, '4–7 сут': 1, '>7 сут': 0 }, 'доставка: бакеты суток');
eq(del.byRegion.map((r) => [r.region, r.count]), [['Москва', 2], ['СПб', 1]], 'доставка: по регионам');
eq(del.byDay.map((r) => r.date), ['2026-08-11', '2026-08-12', '2026-08-15'], 'доставка: дни по возрастанию');

// Пустой вход — доступности нет, без падения.
const delEmpty = buildDelivery([], new Map(), () => null);
eq(delEmpty.available, false, 'доставка: пусто → available=false');
eq(delEmpty.totals.count, 0, 'доставка: пусто → 0 измерений');

console.log(`\nАгрегаторы (agg): ${failed ? failed + ' ПРОВАЛ(ов)' : 'все проверки зелёные'}`);
process.exit(failed ? 1 : 0);
