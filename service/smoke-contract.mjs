// service/smoke-contract.mjs — контракт формы снимков. Проверяет, что снимок
// каждого отчёта содержит поля, которые читают потребители (views.js, *-xlsx.py,
// *-dashboard.mjs). Гоняется по двум источникам:
//   • fake-генераторы раннера (PODSORT_FAKE-путь и демо) — чтобы они не «рассохлись»;
//   • живой выход чистых агрегаторов (geo/logistics) на фикстурах — чтобы прод-снимок
//     совпадал по форме с fake.
// Так ловится расхождение между тем, что рисуют тесты, и тем, что отдаёт прод.
//   node --experimental-sqlite smoke-contract.mjs
import os from 'os';
import path from 'path';

// Тот же тестовый контур, что и в smoke-reports (config/models при импорте открывают БД).
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-please-change';
process.env.TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.DB_PATH = path.join(os.tmpdir(), `fbs-contract-${process.pid}.sqlite`);

const { fakeSnapshot, fakeStock, fakeMovement, fakeGeo, fakeLogistics, fakeCancels, normalizePodsort, normalizeMovement, geoDefaults, logisticsDefaults, cancelsDefaults } = await import('./reports-runner.js');
const { buildAssembly, buildDelivery, buildReturnPath } = await import('../scripts/lib/agg/logistics.mjs');
const { aggregateRegions, aggregateFbs } = await import('../scripts/lib/agg/geo.mjs');
const { buildCancels, buildMoney, buildScorecard } = await import('../scripts/lib/agg/cancels.mjs');

let failed = 0;
// Проверка формы: строка → typeof; массив ['array', spec?] → Array + форма первого элемента;
// объект → рекурсивно. Пустой объект/массив-без-spec проверяет только тип-контейнер.
function checkShape(obj, spec, p, fails) {
  for (const [key, want] of Object.entries(spec)) {
    const at = p ? `${p}.${key}` : key;
    const v = obj == null ? undefined : obj[key];
    if (v === undefined || v === null) { fails.push(`нет ${at}`); continue; }
    if (typeof want === 'string') { if (typeof v !== want) fails.push(`${at}: ${typeof v}, ждали ${want}`); }
    else if (Array.isArray(want)) {
      if (!Array.isArray(v)) { fails.push(`${at}: не массив`); continue; }
      if (want[1] && v.length) checkShape(v[0], want[1], `${at}[0]`, fails);
    } else if (typeof want === 'object') {
      if (typeof v !== 'object') { fails.push(`${at}: не объект`); continue; }
      checkShape(v, want, at, fails);
    }
  }
}
function contract(name, obj, spec) {
  const fails = [];
  checkShape(obj, spec, '', fails);
  console.log(`${fails.length ? '✗' : '✓'}  ${name}${fails.length ? ' — ' + fails.join('; ') : ''}`);
  if (fails.length) failed++;
}

// ── Контракты (только поля, которые реально читают потребители) ──────────────────
const podsortSpec = {
  totals: { reorderUnits: 'number', riskRows: 'number', seedUnits: 'number', warehouses: 'number', nomenclature: 'number' },
  warehouseList: ['array'],
  warehouses: ['array', { name: 'string', rows: ['array', { articleNum: 'string', variant: 'string', techSize: 'string', stock: 'number', perDay: 'number', reorderQty: 'number', status: 'string' }] }],
  seedGrid: ['array'],
  pivot: ['array', { articleNum: 'string', variant: 'string', byWarehouse: {}, total: 'number' }],
  params: { articles: ['array'] },
};
const stockSpec = {
  warehouseList: ['array'],
  warehouses: ['array', { name: 'string', totalQuantity: 'number', skuInStock: 'number' }],
  articles: ['array', { articleNum: 'string', variant: 'string', byWarehouse: {}, total: 'number' }],
  totals: { grandTotal: 'number', activeWarehouses: 'number', articleCount: 'number' },
};
const movementSpec = {
  days: 'number', span: 'number', currency: 'string', fulfillments: ['array'],
  series: ['array', { date: 'string', accepted: { count: 'number', money: 'number', byFulfillment: {} }, delivered: { count: 'number', money: 'number', byFulfillment: {} } }],
};
const scopeSpec = { totals: { salesCount: 'number', returnCount: 'number', returnPct: 'number', regions: 'number' }, byRegion: ['array', { region: 'string', salesCount: 'number', returnCount: 'number', returnPct: 'number' }], byOkrug: ['array', { okrug: 'string' }] };
const geoSpec = {
  scopes: { all: scopeSpec, moscow: { totals: { salesCount: 'number' }, byRegion: ['array'] } },
  fbs: {
    totals: { salesCount: 'number', returnCount: 'number', returnPct: 'number', shipped: 'number' },
    byFF: ['array', { ff: 'string', salesCount: 'number', returnCount: 'number', returnPct: 'number', shipped: 'number' }],
    byDay: ['array', { date: 'string' }], byArticle: ['array'],
    unattributed: { salesCount: 'number', returnCount: 'number' },
  },
};
const logisticsSpec = {
  assembly: {
    totals: { orders: 'number', processed: 'number', pending: 'number', avgHours: 'number', medianHours: 'number', p90Hours: 'number', criticalCount: 'number' },
    byFF: ['array', { ff: 'string', made: 'number', processed: 'number', avgHours: 'number', medianHours: 'number', p90Hours: 'number', criticalCount: 'number' }],
    buckets: {}, critical: ['array'],
  },
  delivery: {
    available: 'boolean',
    totals: { count: 'number', joined: 'number', avgHours: 'number', medianHours: 'number', p90Hours: 'number' },
    byFF: ['array', { ff: 'string', count: 'number', avgHours: 'number', medianHours: 'number' }],
    byRegion: ['array'], buckets: {}, byDay: ['array', { date: 'string', count: 'number' }],
  },
  returnPath: {
    available: 'boolean',
    funnel: { shipped: 'number', sold: 'number', returned: 'number', returnPct: 'number' },
    stageTimes: { deliver: { count: 'number', medianHours: 'number' }, hold: { count: 'number', medianDays: 'number' } },
    byFF: ['array', { ff: 'string', count: 'number' }],
    routes: ['array', { ff: 'string', regionSale: 'string', regionReturn: 'string', returnWarehouse: 'string', count: 'number' }],
    byReturnWarehouse: ['array', { warehouse: 'string', count: 'number' }],
  },
};

const cancelsSpec = {
  days: 'number', warehouseList: ['array'],
  totals: { made: 'number', decided: 'number', sold: 'number', sellerCancel: 'number', sellerCancelPct: 'number', defect: 'number', clientRefusal: 'number', inWork: 'number', unknown: 'number', lostRub: 'number', clientRefusalRub: 'number' },
  byFF: ['array', { ff: 'string', made: 'number', sold: 'number', sellerCancel: 'number', sellerCancelPct: 'number', defect: 'number', clientRefusal: 'number', inWork: 'number', lostRub: 'number' }],
  reasons: ['array', { key: 'string', ru: 'string', blame: 'string', count: 'number', rub: 'number' }],
  assembly: { byFF: ['array', { ff: 'string', medianHours: 'number' }] },
  money: {
    available: 'boolean',
    totals: { penalty: 'number', deduction: 'number', returnLogistics: 'number', ffLossRub: 'number' },
    byFF: ['array', { ff: 'string', penalty: 'number', returnLogistics: 'number', deduction: 'number', ffLossRub: 'number' }],
    reasons: ['array', { reason: 'string', penalty: 'number', deduction: 'number', rub: 'number', count: 'number' }],
  },
  scorecard: ['array', { ff: 'string', sellerCancel: 'number', sellerCancelPct: 'number', cancelLostRub: 'number', penaltyRub: 'number', returnLogRub: 'number', totalLossRub: 'number' }],
};

// ── fake-снимки (демо/тестовый путь) ────────────────────────────────────────────
contract('подсорт (fake)', fakeSnapshot(normalizePodsort({})), podsortSpec);
contract('остатки (fake)', fakeStock(), stockSpec);
contract('движение (fake)', fakeMovement(normalizeMovement({})), movementSpec);
contract('география (fake)', fakeGeo(geoDefaults()), geoSpec);
contract('логистика (fake)', fakeLogistics(logisticsDefaults()), logisticsSpec);
contract('отказы (fake)', fakeCancels(cancelsDefaults()), cancelsSpec);

// ── живой выход агрегаторов на фикстурах — та же форма, что fake ────────────────
const gsales = [
  { srid: 'r1', saleID: 'S1', finishedPrice: 1000, date: '2026-08-10T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный', nmId: 100, warehouseType: 'Склад продавца' },
  { srid: 'r1', saleID: 'R1', finishedPrice: 1000, date: '2026-08-12T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный', nmId: 100, warehouseType: 'Склад продавца' },
];
const gord = { rid: new Map([['r1', { ff: 'A', mos: false, article: '001', nm: 100 }]]), ordersByFF: { A: 2 } };
const geoLive = { scopes: { all: aggregateRegions(gsales, () => true), moscow: aggregateRegions(gsales, (s) => s.nmId === 100) }, fbs: aggregateFbs(gsales, gord) };
contract('география (агрегатор)', geoLive, geoSpec);

const lord = [{ ff: 'A', warehouseId: 1, createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-01T10:00:00Z', article: '001' }];
const lClosedOf = (o) => o.closedAt || null;
const lsales = [
  { srid: 'r1', saleID: 'S1', date: '2026-08-12T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный' },
  { srid: 'r1', saleID: 'R1', date: '2026-08-15T00:00:00', regionName: 'Москва', oblastOkrugName: 'Центральный', warehouseName: 'Подольск' },
];
const lridMap = new Map([['r1', { ff: 'A', createdAt: '2026-08-10T00:00:00Z', closedAt: '2026-08-10T00:00:00Z' }]]);
const logiLive = {
  assembly: buildAssembly(lord, lClosedOf, { critH: 48, asmFromSec: Math.floor(Date.parse('2026-01-01') / 1000) }),
  delivery: buildDelivery(lsales, lridMap, () => '2026-08-10T00:00:00Z'),
  returnPath: buildReturnPath(lsales, lridMap, () => '2026-08-10T00:00:00Z'),
};
contract('логистика (агрегатор)', logiLive, logisticsSpec);

const cOrders = [
  { id: 1, rid: 'r1', ff: 'A', warehouseId: 1, priceRub: 1000, createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-01T10:00:00Z' },
  { id: 2, rid: 'r2', ff: 'A', warehouseId: 1, priceRub: 1000, createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-01T10:00:00Z' },
  { id: 3, rid: 'r3', ff: 'B', warehouseId: 2, priceRub: 1000, createdAt: '2026-08-01T00:00:00Z', closedAt: '2026-08-01T10:00:00Z' },
];
const cStatus = new Map([[1, { supplierStatus: 'complete', wbStatus: 'sold' }], [2, { supplierStatus: 'cancel', wbStatus: 'canceled' }], [3, { supplierStatus: 'confirm', wbStatus: 'defect' }]]);
const cRes = buildCancels(cOrders, (o) => cStatus.get(o.id) || null);
const cAsm = buildAssembly(cOrders, (o) => o.closedAt || null, { critH: 48, asmFromSec: Math.floor(Date.parse('2026-01-01') / 1000) });
const cMoney = buildMoney([{ srid: 'r2', docTypeName: 'Продажа', penalty: '100', bonusTypeName: 'Штраф' }], new Map(cOrders.map((o) => [o.rid, { ff: o.ff, warehouseId: o.warehouseId }])));
const cScore = buildScorecard(cRes.byFF, cAsm.byFF, cMoney.byFF);
const cancelsLive = { days: 30, warehouseList: ['A', 'B'], ...cRes, assembly: cAsm, money: cMoney, scorecard: cScore };
contract('отказы (агрегатор)', cancelsLive, cancelsSpec);

console.log(`\nКонтракт снимков (contract): ${failed ? failed + ' ПРОВАЛ(ов)' : 'все проверки зелёные'}`);
process.exit(failed ? 1 : 0);
