// service/smoke-agg.mjs — юнит-тесты чистых агрегаторов отчётов на фиксированных
// входах (без сети). Числа посчитаны вручную в комментариях — это защита от
// регрессий в сроках/медианах/бакетах, которую не даёт smoke-reports (fake-путь).
//
//   node smoke-agg.mjs
import { avg, median, pct, r2, mskDate } from '../scripts/lib/agg/stats.mjs';
import { buildAssembly, buildDelivery, buildReturnPath } from '../scripts/lib/agg/logistics.mjs';
import { aggregateRegions, aggregateFbs } from '../scripts/lib/agg/geo.mjs';
import { stockMetrics, oosLabel } from '../scripts/lib/agg/stock.mjs';

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

// ── ГЕОГРАФИЯ: регионы/округа + FBS-привязка ────────────────────────────────────
const geoSales = [
  { saleID: 'S1', finishedPrice: 1000, regionName: 'Москва', oblastOkrugName: 'Центральный', nmId: 100 },
  { saleID: 'S2', finishedPrice: 500, regionName: 'Тула', oblastOkrugName: 'Центральный', nmId: 100 },
  { saleID: 'R3', finishedPrice: 300, regionName: 'Москва', oblastOkrugName: 'Центральный', nmId: 100 }, // возврат
  { saleID: 'S4', finishedPrice: 2000, regionName: 'СПб', oblastOkrugName: 'Северо-Западный', nmId: 200 },
];
const regAll = aggregateRegions(geoSales, () => true);
eq(regAll.totals, { salesCount: 3, returnCount: 1, salesRub: 3500, returnRub: 300, regions: 3, returnPct: 33.3 }, 'гео регионы: итоги «Вся РФ»');
eq(regAll.byRegion.map((r) => [r.region, r.salesCount, r.returnCount]), [['Москва', 1, 1], ['Тула', 1, 0], ['СПб', 1, 0]], 'гео регионы: по регионам');
eq(regAll.byOkrug.find((o) => o.okrug === 'Центральный').returnPct, 50, 'гео округа: % возврата Центрального = 50');
// Фильтр по nmId (товары московских FF) — только nm 100.
const regMos = aggregateRegions(geoSales, (s) => s.nmId === 100);
eq(regMos.totals, { salesCount: 2, returnCount: 1, salesRub: 1500, returnRub: 300, regions: 2, returnPct: 50 }, 'гео регионы: фильтр по nmId');

// FBS-привязка: srid==rid → ФФ отгрузки; чужие srid попадают в unattributed (только «Склад продавца»).
const geoOrd = {
  rid: new Map([
    ['r1', { ff: 'A', mos: false, article: '001', nm: 100 }],
    ['r3', { ff: 'B', mos: false, article: '002', nm: 200 }],
  ]),
  ordersByFF: { A: 2, B: 1 },
};
const fbsSales = [
  { srid: 'r1', saleID: 'S1', finishedPrice: 1000, date: '2026-08-10T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный', warehouseType: 'Склад продавца' },
  { srid: 'r1', saleID: 'R1', finishedPrice: 1000, date: '2026-08-12T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный', warehouseType: 'Склад продавца' }, // возврат A
  { srid: 'r3', saleID: 'S3', finishedPrice: 2000, date: '2026-08-11T00:00:00', regionName: 'СПб', oblastOkrugName: 'Северо-Западный', warehouseType: 'Склад продавца' },
  { srid: 'rX', saleID: 'S9', finishedPrice: 700, date: '2026-08-11T00:00:00', warehouseType: 'Склад продавца' }, // не привязан
  { srid: 'rY', saleID: 'R9', finishedPrice: 400, date: '2026-08-11T00:00:00', warehouseType: 'Склад продавца' }, // не привязан (возврат)
];
const fbs = aggregateFbs(fbsSales, geoOrd);
eq(fbs.totals.salesCount, 2, 'гео FBS: продаж привязано 2');
eq(fbs.totals.returnCount, 1, 'гео FBS: возвратов привязано 1');
eq(fbs.totals.salesRub, 3000, 'гео FBS: сумма продаж 3000');
eq(fbs.totals.returnPct, 50, 'гео FBS: % возврата 50 (1/2)');
eq(fbs.totals.shipped, 3, 'гео FBS: отгружено 3 (A2+B1)');
eq(fbs.byFF.map((r) => [r.ff, r.returnCount]), [['A', 1], ['B', 0]], 'гео FBS: ФФ по возвратам');
eq(fbs.byFF[0], { ff: 'A', salesCount: 1, salesRub: 1000, returnCount: 1, returnRub: 1000, returnPct: 100, shipped: 2 }, 'гео FBS: строка ФФ «A» точная');
eq(fbs.byDay.map((d) => d.date), ['2026-08-10', '2026-08-11', '2026-08-12'], 'гео FBS: дни по возрастанию');
eq(fbs.unattributed, { salesCount: 1, returnCount: 1 }, 'гео FBS: непривязанные (rX/rY «Склад продавца»)');

// ── ПУТЬ ВОЗВРАТА: ФФ отгрузки → регион продажи → регион возврата → склад WB ─────
// r1(A) продан в Москве, возвращён из Москвы на «Подольск»; r2(A) — СПб/«Коледино»;
// r3(B) продан без возврата; rX — чужой srid (не привязан).
const rpRid = new Map([
  ['r1', { ff: 'A', createdAt: '2026-08-10T00:00:00Z', closedAt: '2026-08-10T00:00:00Z' }],
  ['r2', { ff: 'A', createdAt: '2026-08-10T00:00:00Z', closedAt: '2026-08-10T00:00:00Z' }],
  ['r3', { ff: 'B', createdAt: '2026-08-10T00:00:00Z', closedAt: null }],
]);
const rpClosedOf = (o) => o.closedAt || null;
const rpSales = [
  { srid: 'r1', saleID: 'S1', date: '2026-08-12T00:00:00', regionName: 'Москва' },              // выкуп +45ч
  { srid: 'r1', saleID: 'R1', date: '2026-08-15T00:00:00', regionName: 'Москва', warehouseName: 'Подольск' },  // возврат +72ч у клиента
  { srid: 'r2', saleID: 'S2', date: '2026-08-11T00:00:00', regionName: 'СПб' },                 // выкуп +21ч
  { srid: 'r2', saleID: 'R2', date: '2026-08-13T00:00:00', regionName: 'СПб', warehouseName: 'Коледино' },     // возврат +48ч у клиента
  { srid: 'r3', saleID: 'S3', date: '2026-08-11T00:00:00', regionName: 'Казань' },              // продан, без возврата
  { srid: 'rX', saleID: 'R9', date: '2026-08-14T00:00:00', regionName: 'Тула', warehouseName: 'Электросталь' }, // чужой srid
];
const rp = buildReturnPath(rpSales, rpRid, rpClosedOf);
eq(rp.available, true, 'путь возврата: есть данные');
eq(rp.funnel, { shipped: 3, sold: 3, returned: 2, returnPct: 66.67 }, 'путь возврата: воронка (отгружено/выкуплено/возвращено/%)');
eq(rp.stageTimes.hold.medianDays, 2.5, 'путь возврата: медиана «у клиента» = 2.5 сут ([48,72]ч)');
eq(rp.stageTimes.deliver.medianHours, 33, 'путь возврата: медиана доставки до выкупа = 33 ч ([21,45])');
eq(rp.byFF[0], { ff: 'A', count: 2, holdDays: 2.5, deliverHours: 33 }, 'путь возврата: ФФ «A» точный');
eq(rp.byReturnWarehouse.map((w) => [w.warehouse, w.count]), [['Подольск', 1], ['Коледино', 1]], 'путь возврата: склады возврата WB');
eq(rp.routes[0], { ff: 'A', regionSale: 'Москва', regionReturn: 'Москва', returnWarehouse: 'Подольск', count: 1, holdDays: 3, deliverHours: 45 }, 'путь возврата: маршрут r1 точный');
const rpEmpty = buildReturnPath([], new Map(), () => null);
eq(rpEmpty.available, false, 'путь возврата: пусто → available=false');

// ── ДИНАМИКА ОСТАТКОВ: тренд, «дни до нуля», вырос/просел ────────────────────────
// A: 100→80 (span=2, тренд −10/дн → 80/10 = 8 дн); B: 50→60 (растёт → null);
// C: 30→5 (тренд −12.5 → round(0.4)=0 дн).
const sm = stockMetrics({
  count: 3, dates: ['d1', 'd2', 'd3'],
  warehouses: [
    { name: 'A', values: [100, 90, 80] },
    { name: 'B', values: [50, 55, 60] },
    { name: 'C', values: [30, 20, 5] },
  ],
  grand: [180, 165, 145],
});
eq(sm.grandNow, 145, 'динамика: текущий суммарный остаток');
eq([sm.grow.name, sm.grow.delta], ['B', 10], 'динамика: больше всех вырос B (+10)');
eq([sm.drop.name, sm.drop.delta], ['C', -25], 'динамика: сильнее всех просел C (−25)');
eq(sm.per.find((p) => p.name === 'A').daysToZero, 8, 'динамика: A дней до нуля = 8');
eq(sm.per.find((p) => p.name === 'B').daysToZero, null, 'динамика: B растёт → null');
eq(sm.per.find((p) => p.name === 'C').daysToZero, 0, 'динамика: C дней до нуля = 0');
eq([sm.soonest.name, sm.soonest.daysToZero], ['C', 0], 'динамика: быстрее всех закончится C');
eq(sm.riskCount, 2, 'динамика: 2 ФФ в риске (<14 дн)');
eq(oosLabel(null), 'растёт/стаб.', 'динамика: подпись OOS для null');
eq(oosLabel(8), '≈ 8 дн до 0', 'динамика: подпись OOS для числа');

console.log(`\nАгрегаторы (agg): ${failed ? failed + ' ПРОВАЛ(ов)' : 'все проверки зелёные'}`);
process.exit(failed ? 1 : 0);
