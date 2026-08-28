// scripts/fbs-cancels.mjs — «Отказы по фулфилментам»: где ФФ проваливает заказы и
// во что это обходится. По каждому нашему складу-фулфилменту (warehouseId):
//   сколько сборочных заданий создано, сколько выкуплено, сколько отменено
//   продавцом (= отказ ФФ), клиентом, браком; % отказов ФФ и упущенная выручка ₽.
//
// Источники WB (scope marketplace — уже выдан кабинету, новых прав не нужно):
//   GET  /api/v3/orders          — сборочные задания: id, rid, warehouseId, createdAt, price
//   POST /api/v3/orders/status   — статусы заданий: supplierStatus / wbStatus (до 1000 id)
//
// Ограничение честно: /api/v3/orders отдаёт задания за ≤3 мес; статус — ТЕКУЩИЙ.
// Поэтому отчёт точен на недавнем окне; для длинного тренда нужны накопительные снимки.
//
//   node scripts/fbs-cancels.mjs --days 30 --json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';
import { loadWarehouses } from './lib/warehouses.mjs';
import { fetchOrders as wbFetchOrders, fetchSupplies as wbFetchSupplies, fetchFinanceDetail } from './lib/wbFetch.mjs';
import { buildCancels, buildMoney, buildScorecard } from './lib/agg/cancels.mjs';
import { buildAssembly } from './lib/agg/logistics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = Math.min(90, Math.max(1, Number(arg('days', 30))));
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };
const FIN = { limit: 1, periodSec: 60, burst: 1 };  // finance-детализация: 1 запрос/мин

const WH = await loadWarehouses(wb, { methodLimit: MP });
const parseArt = (vc) => { const m = String(vc || '').match(/^\s*(\d+)/); return m ? m[1] : String(vc || '').trim(); };
const priceRub = (o) => { const v = Number(o.convertedPrice ?? o.price ?? 0); return v > 0 ? v / 100 : 0; }; // WB отдаёт цену в копейках

const nowSec = Math.floor(Date.now() / 1000);
const fromDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

// ── Заказы за окно: id → {ff, warehouseId, createdAt, priceRub, article, nmId, supplyId} ──
const raw = await wbFetchOrders(wb, { fromSec: nowSec - DAYS * 86400, toSec: nowSec, chunkDays: 28, dedupBy: 'id', methodLimit: MP, onLog: (m) => log('  ' + m) });
const orders = raw.map((o) => ({
  id: o.id, rid: o.rid, ff: WH.nameOf(o.warehouseId), warehouseId: o.warehouseId,
  createdAt: o.createdAt, priceRub: priceRub(o), article: parseArt(o.article), nmId: o.nmId, supplyId: o.supplyId,
}));
log(`FBS-заданий: ${orders.length} за ${DAYS} дн.`);
// Привязка денег/выкупов к ФФ отгрузки по номеру заказа (srid = rid, проверено для FBS).
const ridToFF = new Map(orders.filter((o) => o.rid != null).map((o) => [String(o.rid), { ff: o.ff, warehouseId: o.warehouseId }]));

// ── Статусы: батчами по 1000 id, POST /api/v3/orders/status ──────────────────
const statusMap = new Map(); // id → { supplierStatus, wbStatus }
const ids = orders.map((o) => o.id).filter((v) => v != null);
for (let i = 0; i < ids.length; i += 1000) {
  const chunk = ids.slice(i, i + 1000);
  try {
    const { data } = await wb.request('marketplace', '/api/v3/orders/status', { method: 'POST', body: { orders: chunk }, methodLimit: MP });
    for (const s of data.orders || []) statusMap.set(s.id, { supplierStatus: s.supplierStatus, wbStatus: s.wbStatus });
    log(`  статусы ${Math.min(i + 1000, ids.length)}/${ids.length}`);
  } catch (e) { log(`  ! статусы ${i}..: ${e.message || e}`); }
}

// ── Отказы (чистая агрегация, покрыта юнит-тестами) ──────────────────────────
const statusOf = (o) => statusMap.get(o.id) || null;
const result = buildCancels(orders, statusOf);

// ── Сборка: createdAt → передача поставки в доставку (closedAt), медиана по ФФ ──
const supplyIds = new Set(orders.map((o) => o.supplyId).filter(Boolean));
const supplies = await wbFetchSupplies(wb, { neededIds: supplyIds, methodLimit: MP, onLog: (m) => log('  ' + m) });
const closedOf = (o) => { const sup = o.supplyId ? supplies.get(o.supplyId) : null; return sup && (sup.done || sup.closedAt) ? sup.closedAt : null; };
const assembly = buildAssembly(orders, closedOf, { critH: 48, asmFromSec: nowSec - DAYS * 86400 });

// ── Деньги из реализации (finance-api, scope «Финансы»): штрафы/удержания/обр.логистика ──
let money = { available: false, reason: 'нет данных' };
try {
  const details = await fetchFinanceDetail(wb, { dateFrom: fromDate, dateTo: new Date().toISOString().slice(0, 10), period: 'weekly', methodLimit: FIN, onLog: (m) => log('  ' + m) });
  money = buildMoney(details, ridToFF);
  log(`Реализация: строк ${details.length}, привязано к нашим ФФ ${money.matched}, штрафы ${Math.round(money.totals.penalty)} ₽`);
} catch (e) {
  const noScope = e.status === 403;
  money = { available: false, reason: noScope ? 'нет доступа к категории «Финансы» в токене' : (e.message || 'ошибка'), totals: { penalty: 0, deduction: 0, returnLogistics: 0, ffLossRub: 0 }, byFF: [], reasons: [] };
  log(`! Реализация: ${money.reason}`);
}

// ── Сводка ФФ: скорость сборки ↔ отказы ↔ деньги ────────────────────────────
const scorecard = buildScorecard(result.byFF, assembly.byFF, money.byFF || []);

const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate, ordDays: DAYS,
  warehouseList: result.byFF.map((r) => r.ff),
  ...result,
  assembly, money, scorecard,
};

// Человекочитаемый вывод.
const t = result.totals;
log(`\nОТКАЗЫ за ${DAYS} дн.: заданий ${t.made} · со статусом ${t.withStatus} · выкуплено ${t.sold}`);
log(`   отказ ФФ ${t.sellerCancel} (${t.sellerCancelPct}% от решённых) · брак ${t.defect} · отказ клиента ${t.clientRefusal}`);
log(`   упущенная выручка по вине ФФ: ${Math.round(t.lostRub).toLocaleString('ru-RU')} ₽`);
if (money.available) log(`ДЕНЬГИ (реализация): штрафы ${Math.round(money.totals.penalty).toLocaleString('ru-RU')} ₽ · обр.логистика ${Math.round(money.totals.returnLogistics).toLocaleString('ru-RU')} ₽ · удержания ${Math.round(money.totals.deduction).toLocaleString('ru-RU')} ₽`);
else log(`ДЕНЬГИ (реализация): недоступно — ${money.reason}`);
for (const r of scorecard) log(`   ${String(r.ff).padEnd(20)} сборка~${r.asmMedianHours ?? '—'}ч · отказ ФФ ${String(r.sellerCancel).padStart(4)} (${r.sellerCancelPct}%) · ИТОГО потерь ${Math.round(r.totalLossRub).toLocaleString('ru-RU')} ₽`);

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fbs-cancels.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
