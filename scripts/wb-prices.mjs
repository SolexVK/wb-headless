#!/usr/bin/env node
/**
 * Выгружает цены со скидкой продавца из кабинета WB в data/catalog/prices.json.
 *
 * Это база всех расчётов маржи. Цену из MPStats использовать нельзя: она витринная,
 * то есть с СПП, и на проверенной выборке ниже кабинетной в среднем на 24,6 %.
 *
 * Запуск:
 *   node scripts/wb-prices.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGoods, flattenPrices } from '../lib/wbPrices.js';
import { tokenSource } from '../lib/wbContent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(ROOT, 'data', 'catalog', 'prices.json');

console.log(`токен из переменной: ${tokenSource() ?? 'НЕ НАЙДЕН'}`);

const goods = await fetchGoods();
const { cards, sizes, warnings } = flattenPrices(goods);

const payload = {
  description: 'Цены со скидкой продавца (без СПП) из кабинета WB. База для расчёта маржи.',
  fetchedAt: new Date().toISOString().slice(0, 10),
  note: 'discountedPrice — цена со скидкой продавца. price — цена до скидки. СПП здесь не участвует.',
  cardCount: cards.length,
  cards: cards.sort((a, b) => a.nmID - b.nmID),
  sizes: sizes.sort((a, b) => a.nmID - b.nmID),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

const dp = cards.map((c) => c.discountedPrice).filter(Boolean);
const rub = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n));
console.log(`Карточек с ценой: ${cards.length}`);
console.log(`Цена со скидкой продавца: мин ${rub(Math.min(...dp))} ₽, макс ${rub(Math.max(...dp))} ₽, среднее ${rub(dp.reduce((a, b) => a + b, 0) / dp.length)} ₽`);

const mixed = cards.filter((c) => c.mixed);
if (mixed.length) {
  console.log(`\nРазные цены внутри карточки (взята медиана) — ${mixed.length}:`);
  mixed.slice(0, 10).forEach((c) => console.log(`  ${c.nmID} ${c.vendorCode}`));
}

const costFile = path.join(ROOT, 'data', 'catalog', 'cost.json');
if (fs.existsSync(costFile)) {
  const cost = new Map(JSON.parse(fs.readFileSync(costFile, 'utf8')).items.map((i) => [i.wb, i.cost]));
  const noPrice = [...cost.keys()].filter((wb) => !cards.some((c) => c.nmID === wb));
  console.log(`\nЕсть себестоимость, но нет цены в кабинете: ${noPrice.length}`);
}

if (warnings.length) {
  console.log(`\nПредупреждения (${warnings.length}):`);
  warnings.slice(0, 10).forEach((w) => console.log(`  ${w}`));
}
console.log(`\n→ ${path.relative(ROOT, out)}`);
