// report-wb-stocks.js — история остатков WB и «оверлей наличия» для ABC.
//
// Что делает: заказывает у WB дневную историю остатков (STOCK_HISTORY_DAILY_CSV),
// считает по каждому товару долю дней в наличии за период и джойнит к артикулам
// продавца через config/skus.json. Результат — таблица «наличие по товару»,
// которой ABC-анализ поправляется: товар с низкими продажами И низким наличием
// нельзя списывать в C — он не «плохой», его просто не было на складе.
//
// Запуск:
//   WB_TOKEN=xxx node report-wb-stocks.js                    # период = 90 дней (макс. для дневного отчёта)
//   WB_TOKEN=xxx node report-wb-stocks.js 2026-04-01 2026-06-30
//   WB_TOKEN=xxx node report-wb-stocks.js --current          # быстрый текущий снимок остатков
//
// ⚠ Лимиты WB соблюдаются автоматически (см. lib/wbApi.js). Не запускай отчёт
// многократно подряд — дневная история меняется раз в сутки, чаще нет смысла.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchDailyStockHistory, fetchCurrentStocks, computeStockAvailability } from './lib/wbStocks.js';
import { loadItems, defaultPeriod } from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

// WB отдаёт дневную историю максимум за 3 месяца — не даём заказать больше.
function clampPeriod(d1, d2) {
  const maxBack = new Date();
  maxBack.setUTCDate(maxBack.getUTCDate() - 92);
  const minAllowed = maxBack.toISOString().slice(0, 10);
  if (d1 < minAllowed) {
    process.stderr.write(`⚠ ${d1} дальше 3 месяцев — WB не отдаст. Беру с ${minAllowed}.\n`);
    return { d1: minAllowed, d2 };
  }
  return { d1, d2 };
}

function writeOutputs(rows, period) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `wb-stocks-${period.d1}_${period.d2}`;
  const cols = [
    ['seller', 'Артикул продавца'],
    ['wb', 'SKU'],
    ['daysTotal', 'Дней в периоде'],
    ['daysInStock', 'Дней в наличии'],
    ['daysOutOfStock', 'Дней без остатка'],
    ['inStockRatePct', 'Наличие, %'],
    ['flag', 'Метка'],
  ];
  const cell = (v) => (typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? ''));
  const csv = '﻿' + [
    cols.map(([, t]) => t).join(';'),
    ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(';')),
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(dir, `${base}.csv`), csv);
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify({ period, rows }, null, 2));
  return path.join(dir, `${base}.csv`);
}

async function runHistory(d1, d2) {
  const period = clampPeriod(d1, d2);
  const items = loadItems();
  process.stderr.write(`WB история остатков ${period.d1} … ${period.d2}, товаров в связке: ${items.length}\n`);

  const parsed = await fetchDailyStockHistory({ d1: period.d1, d2: period.d2 });
  const avail = computeStockAvailability(parsed);

  const rows = items.map((it) => {
    const a = avail.get(Number(it.wb));
    const inStockRatePct = a ? a.inStockRatePct : 0;
    // Метка для ABC: мало дней в наличии → низкие продажи могут быть из-за OOS.
    const flag = !a
      ? 'нет данных'
      : inStockRatePct < 50
        ? 'ДЕФИЦИТ (низкие продажи ≠ низкий спрос)'
        : inStockRatePct < 85
          ? 'частичный дефицит'
          : 'в наличии';
    return {
      seller: it.seller || '',
      wb: it.wb,
      daysTotal: a?.daysTotal ?? 0,
      daysInStock: a?.daysInStock ?? 0,
      daysOutOfStock: a?.daysOutOfStock ?? 0,
      inStockRatePct,
      flag,
    };
  });
  rows.sort((x, y) => x.inStockRatePct - y.inStockRatePct);

  const deficit = rows.filter((r) => r.flag.startsWith('ДЕФИЦИТ'));
  const csvPath = writeOutputs(rows, period);
  console.log('\n=== Наличие товара на складах WB (для поправки ABC) ===');
  console.log(`Период:            ${period.d1} … ${period.d2}`);
  console.log(`Товаров:           ${rows.length}`);
  console.log(`В остром дефиците: ${deficit.length} (наличие < 50% дней)`);
  if (deficit.length) {
    console.log('\nКандидаты «не сливать — это дефицит, а не спрос»:');
    for (const r of deficit.slice(0, 15)) {
      console.log(`  ${(r.seller || r.wb).toString().padEnd(34)} наличие ${r.inStockRatePct}% (${r.daysInStock}/${r.daysTotal} дн.)`);
    }
  }
  console.log(`\nФайл: ${csvPath}`);
}

async function runCurrent() {
  const stocks = await fetchCurrentStocks();
  const byNm = new Map();
  for (const s of stocks) byNm.set(s.nmId, (byNm.get(s.nmId) || 0) + s.quantity);
  console.log(`Текущий снимок остатков WB: ${byNm.size} SKU, суммарно ${fmt([...byNm.values()].reduce((a, b) => a + b, 0))} шт.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const run = args.includes('--current')
    ? runCurrent()
    : (() => {
        const [d1, d2] = args.filter((a) => !a.startsWith('--'));
        const p = d1 && d2 ? { d1, d2 } : defaultPeriod(90);
        return runHistory(p.d1, p.d2);
      })();
  run.catch((err) => {
    console.error('Ошибка WB-отчёта:', err?.message || err);
    process.exit(1);
  });
}

export { runHistory, runCurrent };
