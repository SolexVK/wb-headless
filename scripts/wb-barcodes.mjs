#!/usr/bin/env node
/**
 * Выгружает справочник баркодов из WB Content API в data/catalog/barcodes.json.
 *
 * Закрывает главный пробел волны 1: до размера у нас не было ни одного источника.
 *
 * Запуск:
 *   WB_CONTENT_TOKEN=xxx node scripts/wb-barcodes.mjs
 *   WB_CONTENT_TOKEN=xxx node scripts/wb-barcodes.mjs --out data/catalog/barcodes.json
 *
 * Печатает сводку и сверку с config/skus.json и data/catalog/cost.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCards, flattenToBarcodes } from '../lib/wbContent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(ROOT, 'data', 'catalog', 'barcodes.json');

const cards = await fetchCards();
const { barcodes, cards: flatCards, warnings } = flattenToBarcodes(cards);

const payload = {
  description: 'Справочник баркодов: одна строка = одна торгуемая единица (nmID × размер).',
  fetchedAt: new Date().toISOString().slice(0, 10),
  cardCount: flatCards.length,
  barcodeCount: barcodes.length,
  cards: flatCards.sort((a, b) => a.nmID - b.nmID),
  barcodes: barcodes.sort((a, b) => a.nmID - b.nmID || String(a.techSize).localeCompare(String(b.techSize))),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`Карточек (nmID): ${flatCards.length}`);
console.log(`Баркодов:        ${barcodes.length}`);
const byBrand = new Map();
for (const c of flatCards) byBrand.set(c.brand || '—', (byBrand.get(c.brand || '—') || 0) + 1);
console.log('По брендам: ' + [...byBrand].map(([b, n]) => `${b} ${n}`).join(', '));
console.log(`→ ${path.relative(ROOT, out)}`);

// Сверка со справочником и себестоимостью.
const nmSet = new Set(flatCards.map((c) => c.nmID));
const skusFile = path.join(ROOT, 'config', 'skus.json');
if (fs.existsSync(skusFile)) {
  const skus = JSON.parse(fs.readFileSync(skusFile, 'utf8')).items;
  const missingInWb = skus.filter((s) => !nmSet.has(s.wb));
  const missingInCatalog = flatCards.filter((c) => !skus.some((s) => s.wb === c.nmID));
  console.log('');
  console.log(`config/skus.json: ${skus.length} nmID`);
  console.log(`  нет в кабинете WB:      ${missingInWb.length}`);
  console.log(`  есть в WB, нет в файле: ${missingInCatalog.length}`);
  if (missingInCatalog.length) {
    console.log('  добавить в справочник (первые 10):');
    missingInCatalog.slice(0, 10).forEach((c) => console.log(`    ${c.nmID} ${c.vendorCode}`));
  }
}

const costFile = path.join(ROOT, 'data', 'catalog', 'cost.json');
if (fs.existsSync(costFile)) {
  const cost = JSON.parse(fs.readFileSync(costFile, 'utf8')).items;
  const costSet = new Set(cost.map((i) => i.wb));
  const noCost = flatCards.filter((c) => !costSet.has(c.nmID));
  console.log('');
  console.log(`Себестоимость есть у ${flatCards.length - noCost.length} из ${flatCards.length} карточек кабинета`);
  if (noCost.length) {
    console.log('  без себестоимости — маржа не считается (первые 10):');
    noCost.slice(0, 10).forEach((c) => console.log(`    ${c.nmID} ${c.vendorCode}`));
  }
}

if (warnings.length) {
  console.log('');
  console.log(`Предупреждения (${warnings.length}):`);
  warnings.slice(0, 15).forEach((w) => console.log(`  ${w}`));
  if (warnings.length > 15) console.log(`  … ещё ${warnings.length - 15}`);
}
