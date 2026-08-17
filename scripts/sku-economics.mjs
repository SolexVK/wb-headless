#!/usr/bin/env node
/**
 * Связывает отчёт о наличии (report-stock.js) с себестоимостью и юнит-экономикой.
 *
 * Отвечает на вопрос, на который до сих пор не отвечал ни один инструмент:
 * сколько мы заработали и сколько потеряли по каждому артикулу.
 *
 * Запуск:
 *   node scripts/sku-economics.mjs                            # последний отчёт из reports-output
 *   node scripts/sku-economics.mjs reports-output/stock-....json
 *   node scripts/sku-economics.mjs --redemption 35 --top 20
 *   node scripts/sku-economics.mjs --json out.json
 *
 * ДОПУЩЕНИЯ, которые надо держать в голове (печатаются в шапке отчёта):
 *  1. unitsSold из MPStats — это ЗАКАЗЫ, а не выкупы. Выкупы = заказы × процент выкупа.
 *  2. avgPrice — средняя цена из MPStats. Наша экономика считается от цены со скидкой
 *     продавца БЕЗ СПП. Если MPStats отдаёт витринную цену (с СПП), маржа занижена.
 *     Проверяется сверкой одной карточки с кабинетом.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEconomics, unitMargin } from '../lib/ownEconomics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
// Индексы, занятые флагами и их значениями, чтобы значение --json не приняли за входной файл.
const consumed = new Set();
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  consumed.add(i).add(i + 1);
  return argv[i + 1];
};

const e = loadEconomics();
const redemption = Number(flag('redemption') || e.redemptionPct.default);
const topN = Number(flag('top') || 25);
const jsonOut = flag('json');

// ---- источник ----
let reportPath = argv.find((a, i) => !consumed.has(i) && !a.startsWith('--') && a.endsWith('.json'));
if (!reportPath) {
  const dir = path.join(ROOT, 'reports-output');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^stock-.*\.json$/.test(f)).sort()
    : [];
  if (!files.length) {
    console.error('нет отчётов в reports-output/. Сначала: node report-stock.js');
    process.exit(1);
  }
  reportPath = path.join(dir, files[files.length - 1]);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const costItems = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'cost.json'), 'utf8')).items;
const costOf = new Map(costItems.map((i) => [String(i.wb), i.cost]));

// Цена берётся из кабинета (со скидкой продавца, без СПП). Цена MPStats витринная,
// то есть уже с СПП, и в среднем на четверть ниже — считать по ней нельзя.
const pricesFile = path.join(ROOT, 'data', 'catalog', 'prices.json');
const priceOf = fs.existsSync(pricesFile)
  ? new Map(JSON.parse(fs.readFileSync(pricesFile, 'utf8')).cards.map((c) => [String(c.nmID), c.discountedPrice]))
  : new Map();
const noPrice = [];

// ---- расчёт ----
const rows = [];
const noCost = [];
for (const r of report.rows) {
  if (!r.hasData) continue;
  const cost = costOf.get(String(r.sku));
  if (cost == null) { noCost.push(r); continue; }

  const orders = r.unitsSold;
  const cabinetPrice = priceOf.get(String(r.sku));
  if (cabinetPrice == null) noPrice.push(r);
  const price = cabinetPrice ?? r.avgPrice;
  const priceSource = cabinetPrice != null ? 'кабинет' : 'MPStats';
  const redeemed = orders * (redemption / 100);
  const m = unitMargin({ price, cost, redemptionPct: redemption }, e);

  const marginTotal = redeemed * m.margin;
  const lostRedeemed = r.lostUnits * (redemption / 100);
  const marginLost = lostRedeemed * m.margin;

  rows.push({
    seller: r.seller,
    sku: r.sku,
    orders,
    price,
    priceSource,
    priceMpstats: r.avgPrice,
    cost,
    marginPerUnit: m.margin,
    marginPct: m.marginPct,
    redeemed: Math.round(redeemed),
    revenueRealized: Math.round(redeemed * price),
    marginTotal: Math.round(marginTotal),
    daysOutOfStock: r.daysOutOfStock,
    lostUnits: r.lostUnits,
    marginLost: Math.round(marginLost),
    status:
      m.marginPct < e.lossMarginPct ? 'УБЫТОК'
      : m.marginPct < e.minMarginPct ? 'нет смысла'
      : m.marginPct < e.targetMarginPct ? 'ниже цели'
      : 'цель',
  });
}

rows.sort((a, b) => b.marginTotal - a.marginTotal);

// ---- вывод ----
const rub = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const totals = rows.reduce(
  (a, r) => ({
    orders: a.orders + r.orders,
    redeemed: a.redeemed + r.redeemed,
    revenue: a.revenue + r.revenueRealized,
    margin: a.margin + r.marginTotal,
    lost: a.lost + r.marginLost,
    lostUnits: a.lostUnits + r.lostUnits,
  }),
  { orders: 0, redeemed: 0, revenue: 0, margin: 0, lost: 0, lostUnits: 0 },
);

console.log(`Период ${report.period?.d1 ?? '?'} … ${report.period?.d2 ?? '?'}   ·   ${rows.length} SKU   ·   выкуп ${redemption} %`);
const fromCabinet = rows.filter((r) => r.priceSource === 'кабинет').length;
console.log(`ЦЕНА: со скидкой продавца из кабинета WB (без СПП) — ${fromCabinet} из ${rows.length} SKU`);
console.log('ЗАКАЗЫ: unitsSold из MPStats трактуется как заказы; выкупы = заказы × процент выкупа');
console.log('');
console.log(
  `${pad('артикул', 22)}${padL('заказы', 8)}${padL('цена', 7)}${padL('себест', 7)}` +
  `${padL('маржа/шт', 9)}${padL('%', 6)}${padL('маржа всего', 13)}${padL('упущено', 12)}  статус`,
);
for (const r of rows.slice(0, topN)) {
  console.log(
    `${pad(r.seller.slice(0, 21), 22)}${padL(rub(r.orders), 8)}${padL(rub(r.price), 7)}${padL(rub(r.cost), 7)}` +
    `${padL(rub(r.marginPerUnit), 9)}${padL(r.marginPct.toFixed(1), 6)}${padL(rub(r.marginTotal), 13)}` +
    `${padL(rub(r.marginLost), 12)}  ${r.status}`,
  );
}

console.log('');
console.log(`ИТОГО за период (${rows.length} SKU):`);
console.log(`  заказов                 ${rub(totals.orders)}`);
console.log(`  выкуплено (× ${redemption} %)      ${rub(totals.redeemed)}`);
console.log(`  выручка выкупленная     ${rub(totals.revenue)} ₽`);
console.log(`  МАРЖА                   ${rub(totals.margin)} ₽  (${((totals.margin / totals.revenue) * 100).toFixed(1)} % от выкупленной выручки)`);
console.log(`  упущено маржи           ${rub(totals.lost)} ₽  (${rub(totals.lostUnits)} заказов не состоялось из-за простоев)`);
console.log(`  потенциал               ${rub(totals.margin + totals.lost)} ₽  — столько было бы без аутстоков`);

const bad = rows.filter((r) => r.status === 'УБЫТОК' || r.status === 'нет смысла');
if (bad.length) {
  console.log('');
  console.log(`ТРЕБУЕТ РЕШЕНИЯ — ${bad.length} SKU ниже порога ${e.minMarginPct} %:`);
  bad.forEach((r) => console.log(`  ${pad(r.seller.slice(0, 24), 25)} маржа ${padL(r.marginPct.toFixed(1), 5)} %  ${padL(rub(r.marginTotal), 11)} ₽  ${r.status}`));
}

if (noCost.length) {
  console.log('');
  console.log(`Без себестоимости — в расчёт не вошли (${noCost.length}):`);
  noCost.slice(0, 10).forEach((r) => console.log(`  ${r.sku} ${r.seller}`));
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ period: report.period, redemptionPct: redemption, totals, rows }, null, 2) + '\n');
  console.log(`\n→ ${jsonOut}`);
}
