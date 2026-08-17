#!/usr/bin/env node
/**
 * Импорт себестоимости из xlsx/csv в data/catalog/cost.json.
 *
 * Ожидаемая шапка (порядок колонок не важен, ищется по названию):
 *   «Артикул ВБ» | «Артикул продавца» | «Себестоимость»
 *
 * Запуск:
 *   node scripts/import-cost.mjs <файл.xlsx> [--out data/catalog/cost.json]
 *
 * Выводит отчёт о покрытии: сколько nmID из config/skus.json получили себестоимость,
 * по каким её нет и какие строки файла не нашлись в справочнике.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsxRows } from '../lib/oraclePhrases.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'data', 'catalog', 'cost.json');

if (!src) {
  console.error('Укажите файл: node scripts/import-cost.mjs <файл.xlsx>');
  process.exit(1);
}

const rows = readXlsxRows(src);
const rowNums = Object.keys(rows)
  .map(Number)
  .sort((a, b) => a - b);

// Шапка — первая строка, где есть колонка про себестоимость.
const headerRow = rowNums.find((r) =>
  Object.values(rows[r]).some((v) => /себестоимост/i.test(String(v))),
);
if (headerRow == null) throw new Error('не найдена шапка: нет колонки «Себестоимость»');

const header = rows[headerRow];
const colBy = (re) => Object.keys(header).find((c) => re.test(String(header[c])));
const colNm = colBy(/артикул\s*вб|nmid/i);
const colSeller = colBy(/артикул\s*продавц/i);
const colCost = colBy(/себестоимост/i);
if (!colNm || !colCost) throw new Error('нужны колонки «Артикул ВБ» и «Себестоимость»');

const items = [];
const problems = [];
for (const r of rowNums) {
  if (r <= headerRow) continue;
  const cell = rows[r];
  const nmRaw = cell[colNm];
  const costRaw = cell[colCost];
  if (nmRaw == null && costRaw == null) continue;

  const wb = Number(String(nmRaw).replace(/\s/g, ''));
  const cost = Number(String(costRaw).replace(/\s/g, '').replace(',', '.'));
  const seller = colSeller ? String(cell[colSeller] ?? '').trim() : '';

  if (!Number.isFinite(wb) || wb <= 0) { problems.push({ row: r, why: 'нечитаемый артикул ВБ', nmRaw }); continue; }
  if (!Number.isFinite(cost) || cost <= 0) { problems.push({ row: r, seller, why: 'нет себестоимости' }); continue; }
  items.push({ wb, seller, cost });
}

// Дубли по nmID: если себестоимость разная — это ошибка данных, молчать нельзя.
const byNm = new Map();
const conflicts = [];
for (const it of items) {
  const prev = byNm.get(it.wb);
  if (prev && prev.cost !== it.cost) conflicts.push({ wb: it.wb, seller: it.seller, costs: [prev.cost, it.cost] });
  byNm.set(it.wb, it);
}

// Сверка со справочником.
const skusPath = path.join(ROOT, 'config', 'skus.json');
const skus = JSON.parse(fs.readFileSync(skusPath, 'utf8')).items;
const known = new Set(skus.map((s) => s.wb));
const withCost = skus.filter((s) => byNm.has(s.wb));
const withoutCost = skus.filter((s) => !byNm.has(s.wb));
const notInCatalog = [...byNm.values()].filter((it) => !known.has(it.wb));

const payload = {
  description: 'Себестоимость производства, руб/шт, на уровне nmID (артикул WB = модель × цвет).',
  source: path.basename(src),
  importedAt: new Date().toISOString().slice(0, 10),
  note: 'Себестоимость задана на nmID, не на баркод: размеры одной карточки считаются равными по себестоимости.',
  items: [...byNm.values()].sort((a, b) => a.wb - b.wb),
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

const costs = payload.items.map((i) => i.cost);
console.log(`Импортировано: ${payload.items.length} позиций → ${path.relative(ROOT, out)}`);
console.log(`Себестоимость: мин ${Math.min(...costs)} ₽, макс ${Math.max(...costs)} ₽, среднее ${Math.round(costs.reduce((a, b) => a + b, 0) / costs.length)} ₽`);
console.log('');
console.log(`Покрытие справочника config/skus.json (${skus.length} nmID):`);
console.log(`  с себестоимостью:  ${withCost.length}`);
console.log(`  без себестоимости: ${withoutCost.length}`);
console.log(`  в файле, но нет в справочнике: ${notInCatalog.length}`);

if (conflicts.length) {
  console.log('');
  console.log('РАЗНАЯ СЕБЕСТОИМОСТЬ У ОДНОГО nmID — данные противоречивы:');
  conflicts.forEach((c) => console.log(`  ${c.wb} ${c.seller}: ${c.costs.join(' и ')}`));
}
if (problems.length) {
  console.log('');
  console.log('Пропущенные строки:');
  problems.slice(0, 20).forEach((p) => console.log(`  строка ${p.row}: ${p.why}${p.seller ? ` (${p.seller})` : ''}`));
  if (problems.length > 20) console.log(`  … ещё ${problems.length - 20}`);
}
if (notInCatalog.length) {
  console.log('');
  console.log('Есть себестоимость, но нет в справочнике (первые 20):');
  notInCatalog.slice(0, 20).forEach((i) => console.log(`  ${i.wb} ${i.seller}`));
}
if (withoutCost.length) {
  console.log('');
  console.log('Нет себестоимости (первые 20) — по ним расчёт маржи невозможен:');
  withoutCost.slice(0, 20).forEach((s) => console.log(`  ${s.wb} ${s.seller}`));
  if (withoutCost.length > 20) console.log(`  … ещё ${withoutCost.length - 20}`);
}
