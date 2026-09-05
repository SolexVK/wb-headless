#!/usr/bin/env node
/**
 * Сводит отчёты о наличии по линейкам в один.
 *
 * Полный прогон по всему ассортименту упирается в суточный лимит MPStats, поэтому
 * report-stock.js запускается по группам из config/groups.json, а результаты
 * складываются здесь. На выходе — обычный отчёт, который принимает sku-economics.mjs.
 *
 * Запуск:
 *   node scripts/merge-stock-reports.mjs [--dir reports-output/by-group] [--out путь]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const dir = arg('dir') || path.join(ROOT, 'reports-output', 'by-group');
const out = arg('out') || path.join(ROOT, 'reports-output', 'stock-merged.json');

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) { console.error(`нет отчётов в ${dir}`); process.exit(1); }

const seen = new Map();      // sku → строка, дубли между группами схлопываем
const dupes = [];
const periods = new Set();
let skipped = 0;

for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (r.period?.d1) periods.add(`${r.period.d1}…${r.period.d2}`);
  for (const row of r.rows || []) {
    if (!row.hasData) { skipped += 1; continue; }
    if (seen.has(row.sku)) { dupes.push({ sku: row.sku, seller: row.seller, file: f }); continue; }
    seen.set(row.sku, row);
  }
}

if (periods.size > 1) {
  console.log(`ВНИМАНИЕ: отчёты за разные периоды — ${[...periods].join(', ')}`);
  console.log('Сравнивать такие строки между собой нельзя.');
}

const rows = [...seen.values()].sort((a, b) => b.lostRevenue - a.lostRevenue);
const totals = rows.reduce((a, r) => ({
  skuCount: a.skuCount + 1,
  unitsSold: a.unitsSold + r.unitsSold,
  revenue: a.revenue + r.revenue,
  lostUnits: a.lostUnits + r.lostUnits,
  lostRevenue: a.lostRevenue + r.lostRevenue,
  daysOutOfStock: a.daysOutOfStock + r.daysOutOfStock,
}), { skuCount: 0, unitsSold: 0, revenue: 0, lostUnits: 0, lostRevenue: 0, daysOutOfStock: 0 });

const first = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
fs.writeFileSync(out, JSON.stringify({ period: first.period, mergedFrom: files, rows, totals }, null, 2) + '\n');

const rub = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n));
console.log(`Сведено линеек: ${files.length}`);
console.log(`SKU с данными:  ${rows.length}${skipped ? `  (без данных: ${skipped})` : ''}`);
if (dupes.length) console.log(`Дубли между группами схлопнуты: ${dupes.length}`);
console.log(`Заказов:        ${rub(totals.unitsSold)} шт на ${rub(totals.revenue)} ₽`);
console.log(`Упущено:        ${rub(totals.lostUnits)} шт ≈ ${rub(totals.lostRevenue)} ₽  (${totals.daysOutOfStock} дней простоя)`);
console.log(`→ ${path.relative(ROOT, out)}`);
