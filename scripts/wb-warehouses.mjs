// scripts/wb-warehouses.mjs — получить список НАШИХ складов продавца (FBS/DBS)
// из WB API и сохранить снимок в config/warehouses.json.
//
// Это «склады продавца» из категории Маркетплейс — те, что участвуют в схеме
// FBS (Fulfillment by Seller). Метод: GET /api/v3/warehouses (marketplace-api).
//
//   npm run wb:warehouses          # вывести в stdout (таблицей) и обновить config
//   node scripts/wb-warehouses.mjs --no-save   # только показать, не писать файл
//
// Токен берётся резолвером lib/wbToken.js (env WB_API_TOKEN / Wildberries_API
// или .env). Лимиты соблюдает клиент lib/wbClient.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from '../lib/wbClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../config/warehouses.json');
const save = !process.argv.includes('--no-save');

// Расшифровка кодов из ответа /api/v3/warehouses (см. docs/wb-api/fbs.md).
const DELIVERY_TYPE = {
  1: 'обычная доставка (стандартная FBS-логистика через WB)',
  2: 'доставка силами продавца (DBS)',
  3: 'экспресс-доставка',
};
const CARGO_TYPE = {
  1: 'обычный габарит (СГТ)',
  2: 'крупногабаритный (КГТ)',
  3: 'сверхгабаритный',
};

const wb = new WbClient({ tokenType: process.env.WB_TOKEN_TYPE || 'personal' });
process.stderr.write(`Токен: ${wb.tokenSource} | тип: ${wb.tokenType}\n`);

// Лимит метода «Склады продавца» — из категории Маркетплейс (базовый лимит
// токена). Отдельного жёсткого лимита у метода нет, полагаемся на клиента.
const { data: warehouses } = await wb.get('marketplace', '/api/v3/warehouses');

if (!Array.isArray(warehouses)) {
  process.stderr.write('Неожиданный ответ WB API:\n' + JSON.stringify(warehouses, null, 2) + '\n');
  process.exit(1);
}

// Красивая таблица в stderr для человека.
process.stderr.write(`\nНаши склады продавца (FBS): ${warehouses.length}\n`);
for (const w of warehouses) {
  process.stderr.write(
    `  • ${String(w.name).padEnd(20)} id=${w.id} officeId=${w.officeId} ` +
    `[${DELIVERY_TYPE[w.deliveryType] || 'deliveryType=' + w.deliveryType}` +
    (w.cargoType ? `, ${CARGO_TYPE[w.cargoType] || 'cargoType=' + w.cargoType}` : '') + ']\n'
  );
}

const snapshot = {
  _comment:
    'Снимок складов продавца (FBS), полученный из WB API GET /api/v3/warehouses. ' +
    'Обновить: npm run wb:warehouses. Коды deliveryType/cargoType — см. docs/wb-api/fbs.md.',
  source: 'GET https://marketplace-api.wildberries.ru/api/v3/warehouses',
  count: warehouses.length,
  warehouses,
};

if (save) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
  process.stderr.write(`\n→ сохранено в ${path.relative(process.cwd(), OUT)}\n`);
}

// В stdout — чистый JSON (удобно пайпить дальше).
process.stdout.write(JSON.stringify(warehouses, null, 2) + '\n');
