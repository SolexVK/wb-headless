// scripts/fbs-stock.mjs — сколько товара сейчас на КАЖДОМ складе продавца (FBS).
//
// Источник истины по остаткам FBS — метод Маркетплейса
//   POST /api/v3/stocks/{warehouseId}  body: { skus: [штрихкоды] }
// Он принимает ШТРИХКОДЫ (не nmID), поэтому сначала берём карту
// штрихкод → nmID/артикул из Content API (карточки товаров), затем по каждому
// складу спрашиваем остатки по всем нашим штрихкодам.
//
//   npm run fbs:stock                 # опросить и сохранить снимок
//   node scripts/fbs-stock.mjs --json # только JSON снимок в stdout
//
// Снимок: reports-output/fbs-stock.json (папка в .gitignore).
// Лимиты соблюдает lib/wbClient.js (token bucket на категорию, 429 → ожидание).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const jsonOnly = process.argv.includes('--json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });

// ── 1. Склады продавца (FBS) ────────────────────────────────────────────────
async function getWarehouses() {
  const { data } = await wb.get('marketplace', '/api/v3/warehouses');
  if (!Array.isArray(data)) throw new Error('warehouses: неожиданный ответ');
  return data;
}

// ── 2. Карта штрихкод → {nmID, vendorCode} из Content API (все карточки) ─────
async function getBarcodeMap() {
  const map = new Map(); // barcode → { nmID, vendorCode }
  let cursor = { limit: 100 };
  for (let page = 1; ; page++) {
    const { data } = await wb.request('content', '/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { cursor, filter: { withPhoto: -1 } } },
      methodLimit: { limit: 100, periodSec: 60, burst: 20 },
    });
    const cards = data?.cards || [];
    for (const c of cards) {
      for (const s of c.sizes || []) {
        for (const bc of s.skus || []) {
          map.set(String(bc), { nmID: c.nmID, vendorCode: c.vendorCode });
        }
      }
    }
    const total = data?.cursor?.total ?? 0;
    log(`  карточки: страница ${page}, получено ${cards.length}, штрихкодов всего ${map.size}`);
    if (cards.length < cursor.limit || total < cursor.limit) break;
    cursor = { limit: 100, updatedAt: data.cursor.updatedAt, nmID: data.cursor.nmID };
  }
  return map;
}

// ── 3. Остатки по складу (chunk по 1000 штрихкодов) ─────────────────────────
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function getStocks(warehouseId, barcodes) {
  const amount = new Map(); // barcode → amount
  for (const part of chunk(barcodes, 1000)) {
    const { data } = await wb.request('marketplace', `/api/v3/stocks/${warehouseId}`, {
      method: 'POST',
      body: { skus: part },
      methodLimit: { limit: 300, periodSec: 60, burst: 20 },
    });
    for (const s of data?.stocks || []) amount.set(String(s.sku), s.amount || 0);
  }
  return amount;
}

// ── main ────────────────────────────────────────────────────────────────────
const warehouses = await getWarehouses();
log(`Складов FBS: ${warehouses.length}`);

const barcodeMap = await getBarcodeMap();
const barcodes = [...barcodeMap.keys()];
log(`Штрихкодов для опроса: ${barcodes.length}`);

const result = [];
for (const w of warehouses) {
  const amounts = await getStocks(w.id, barcodes);
  const positions = [];
  let total = 0;
  for (const [bc, amt] of amounts) {
    if (amt > 0) {
      const meta = barcodeMap.get(bc) || {};
      positions.push({ sku: bc, nmID: meta.nmID, vendorCode: meta.vendorCode, amount: amt });
      total += amt;
    }
  }
  positions.sort((a, b) => b.amount - a.amount);
  result.push({
    id: w.id,
    name: w.name,
    officeId: w.officeId,
    totalQuantity: total,
    skuInStock: positions.length,
    positions,
  });
  log(`  • ${String(w.name).padEnd(20)} остаток: ${total} шт, позиций: ${positions.length}`);
}

const grandTotal = result.reduce((s, w) => s + w.totalQuantity, 0);
const snapshot = {
  source: 'WB API: content/v2/get/cards/list + marketplace /api/v3/stocks/{warehouseId}',
  warehouseCount: warehouses.length,
  barcodeCount: barcodes.length,
  grandTotalQuantity: grandTotal,
  warehouses: result,
};

if (!jsonOnly) {
  const outDir = path.join(REPO, 'reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'fbs-stock.json');
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  log(`\nИтого по FBS: ${grandTotal} шт на ${warehouses.length} складах`);
  log(`→ снимок: ${path.relative(process.cwd(), out)}`);
}

process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
