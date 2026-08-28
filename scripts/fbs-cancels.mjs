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
import { fetchOrders as wbFetchOrders } from './lib/wbFetch.mjs';
import { buildCancels } from './lib/agg/cancels.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DAYS = Math.min(90, Math.max(1, Number(arg('days', 30))));
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
const MP = { limit: 300, periodSec: 60, burst: 20 };

const WH = await loadWarehouses(wb, { methodLimit: MP });
const parseArt = (vc) => { const m = String(vc || '').match(/^\s*(\d+)/); return m ? m[1] : String(vc || '').trim(); };
const priceRub = (o) => { const v = Number(o.convertedPrice ?? o.price ?? 0); return v > 0 ? v / 100 : 0; }; // WB отдаёт цену в копейках

const nowSec = Math.floor(Date.now() / 1000);
const fromDate = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

// ── Заказы за окно: id → {ff, warehouseId, createdAt, priceRub, article, nmId} ──
const raw = await wbFetchOrders(wb, { fromSec: nowSec - DAYS * 86400, toSec: nowSec, chunkDays: 28, dedupBy: 'id', methodLimit: MP, onLog: (m) => log('  ' + m) });
const orders = raw.map((o) => ({
  id: o.id, rid: o.rid, ff: WH.nameOf(o.warehouseId), warehouseId: o.warehouseId,
  createdAt: o.createdAt, priceRub: priceRub(o), article: parseArt(o.article), nmId: o.nmId,
}));
log(`FBS-заданий: ${orders.length} за ${DAYS} дн.`);

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

// ── Агрегация (чистая, покрыта юнит-тестами) ─────────────────────────────────
const statusOf = (o) => statusMap.get(o.id) || null;
const result = buildCancels(orders, statusOf);

const snapshot = {
  generatedAt: new Date().toISOString(),
  days: DAYS, from: fromDate, ordDays: DAYS,
  warehouseList: result.byFF.map((r) => r.ff),
  ...result,
};

// Человекочитаемый вывод.
const t = result.totals;
log(`\nОТКАЗЫ за ${DAYS} дн.: заданий ${t.made} · со статусом ${t.withStatus} · выкуплено ${t.sold}`);
log(`   отказ ФФ ${t.sellerCancel} (${t.sellerCancelPct}% от решённых) · брак ${t.defect} · отказ клиента ${t.clientRefusal}`);
log(`   упущенная выручка по вине ФФ: ${Math.round(t.lostRub).toLocaleString('ru-RU')} ₽`);
for (const r of result.byFF) log(`   ${String(r.ff).padEnd(20)} заданий ${String(r.made).padStart(5)} · отказ ФФ ${String(r.sellerCancel).padStart(4)} (${r.sellerCancelPct}%) · потери ${Math.round(r.lostRub).toLocaleString('ru-RU')} ₽`);

if (!jsonOnly) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'fbs-cancels.json'), JSON.stringify(snapshot, null, 2) + '\n');
}
process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
