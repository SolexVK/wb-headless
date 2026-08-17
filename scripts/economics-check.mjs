#!/usr/bin/env node
/**
 * Проверка юнит-экономики по импортированной себестоимости.
 *
 * Отвечает на два вопроса:
 *   1. При какой цене артикул даёт целевую маржу — при разных сценариях выкупа.
 *   2. Какая маржа получается при заданной цене.
 *
 * Запуск:
 *   node scripts/economics-check.mjs                       # таблица по линейкам
 *   node scripts/economics-check.mjs --price 2100          # маржа при цене 2100
 *   node scripts/economics-check.mjs --redemption 45       # свой сценарий выкупа
 *   node scripts/economics-check.mjs --sku 535397255       # разложить один артикул
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEconomics, unitMargin, breakEvenPrice, fulfilmentPerSoldUnit } from '../lib/ownEconomics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const e = loadEconomics();
const cost = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'cost.json'), 'utf8'));
const groups = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'groups.json'), 'utf8')).groups;

const groupOf = new Map();
for (const [label, list] of Object.entries(groups)) for (const wb of list) groupOf.set(wb, label);

const rub = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const skuArg = arg('sku');
const priceArg = Number(arg('price'));
const redemption = Number(arg('redemption') || e.redemptionPct.default);

// ---- разбор одного артикула ----
if (skuArg) {
  const item = cost.items.find((i) => String(i.wb) === String(skuArg));
  if (!item) { console.error(`нет себестоимости для ${skuArg}`); process.exit(1); }
  const price = Number.isFinite(priceArg) ? priceArg : breakEvenPrice({ cost: item.cost, redemptionPct: redemption, targetMarginPct: e.targetMarginPct }, e);
  const m = unitMargin({ price, cost: item.cost, redemptionPct: redemption }, e);
  console.log(`${item.wb}  ${item.seller}`);
  console.log(`выкуп ${redemption} %, цена со скидкой продавца (без СПП) ${rub(price)} ₽\n`);
  const line = (k, v) => console.log(`  ${pad(k, 26)} ${padL(rub(v), 7)} ₽   ${padL(((v / price) * 100).toFixed(1), 5)} %`);
  line('комиссия WB', m.commission);
  line('фулфилмент', m.fulfilment);
  line('карго Бишкек → ФФ', m.cargo);
  line('себестоимость с браком', m.cost);
  line('налог', m.tax);
  console.log(`  ${pad('─'.repeat(26), 26)} ${padL('─'.repeat(7), 7)}`);
  line('расходы всего', m.totalCost);
  line('МАРЖА', m.margin);
  process.exit(0);
}

// ---- сводка по линейкам ----
const scenarios = [35, 45, 55];
console.log(`Комиссия ${e.commissionPct} %, налог ${e.taxPct} %, карго ${e.cargoRubPerUnit} ₽, брак ${e.defectPct} %`);
console.log(`Фулфилмент на проданную единицу: ${scenarios.map((r) => `${r} % выкупа → ${rub(fulfilmentPerSoldUnit(r, e))} ₽`).join(',  ')}`);
console.log('');

if (Number.isFinite(priceArg)) {
  console.log(`Маржа при цене ${rub(priceArg)} ₽ (выкуп ${redemption} %)\n`);
  console.log(`${pad('линейка', 12)}${padL('поз.', 5)}${padL('себест.', 9)}${padL('маржа ₽', 10)}${padL('маржа %', 9)}  статус`);
  const byGroup = groupBy(cost.items);
  for (const [label, items] of byGroup) {
    const avg = items.reduce((s, i) => s + i.cost, 0) / items.length;
    const m = unitMargin({ price: priceArg, cost: avg, redemptionPct: redemption }, e);
    const status = m.marginPct >= e.targetMarginPct ? 'цель' : m.marginPct >= e.minMarginPct ? 'ниже цели' : m.marginPct >= e.lossMarginPct ? 'нет смысла' : 'УБЫТОК';
    console.log(`${pad(label, 12)}${padL(items.length, 5)}${padL(rub(avg), 9)}${padL(rub(m.margin), 10)}${padL(m.marginPct.toFixed(1), 9)}  ${status}`);
  }
  process.exit(0);
}

console.log(`Цена, при которой достигается маржа ${e.targetMarginPct} %, при разных сценариях выкупа\n`);
console.log(`${pad('линейка', 12)}${padL('поз.', 5)}${padL('себест.', 9)}${scenarios.map((r) => padL(`выкуп ${r}%`, 11)).join('')}`);
const byGroup = groupBy(cost.items);
for (const [label, items] of byGroup) {
  const avg = items.reduce((s, i) => s + i.cost, 0) / items.length;
  const prices = scenarios.map((r) => breakEvenPrice({ cost: avg, redemptionPct: r, targetMarginPct: e.targetMarginPct }, e));
  console.log(`${pad(label, 12)}${padL(items.length, 5)}${padL(rub(avg), 9)}${prices.map((p) => padL(rub(p), 11)).join('')}`);
}

const all = cost.items.map((i) => i.cost);
const avgAll = all.reduce((a, b) => a + b, 0) / all.length;
console.log('');
console.log(`ИТОГО ${cost.items.length} позиций, средняя себестоимость ${rub(avgAll)} ₽`);
for (const r of scenarios) {
  console.log(`  выкуп ${r} %: цель ${e.targetMarginPct} % при цене ${rub(breakEvenPrice({ cost: avgAll, redemptionPct: r, targetMarginPct: e.targetMarginPct }, e))} ₽, ` +
    `порог ${e.minMarginPct} % при ${rub(breakEvenPrice({ cost: avgAll, redemptionPct: r, targetMarginPct: e.minMarginPct }, e))} ₽, ` +
    `безубыточность при ${rub(breakEvenPrice({ cost: avgAll, redemptionPct: r, targetMarginPct: 0 }, e))} ₽`);
}

function groupBy(items) {
  const map = new Map();
  for (const it of items) {
    const label = groupOf.get(it.wb) || 'без линейки';
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(it);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}
