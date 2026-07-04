// report-stock.js — CLI-раннер регулярного отчёта по наличию и упущенной выручке.
//
// Запуск:
//   MPSTATS_TOKEN=xxx node report-stock.js                 # период = последние 30 дней
//   MPSTATS_TOKEN=xxx node report-stock.js 2026-06-01 2026-06-30
//
// Результат: reports-output/stock-<d1>_<d2>.csv и .json + сводка в консоль.
// Предназначен для запуска по расписанию (cron / встроенный планировщик server.js).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildStockAvailabilityReport, reportToCSV } from './lib/stockReport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/** Период по умолчанию: последние N дней (по вчерашний день включительно). */
export function defaultPeriod(days = 30) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // вчера — последний полностью закрытый день
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { d1: ymd(start), d2: ymd(end) };
}

export function loadSkus() {
  const file = path.join(__dirname, 'config', 'skus.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.skus || [];
}

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

export async function runReport({ d1, d2, skus } = {}) {
  const period = d1 && d2 ? { d1, d2 } : defaultPeriod(Number(process.env.REPORT_DAYS) || 30);
  const skuList = skus || loadSkus();

  process.stderr.write(
    `Отчёт по наличию: ${skuList.length} SKU, период ${period.d1} … ${period.d2}\n`
  );

  const report = await buildStockAvailabilityReport({
    skus: skuList,
    d1: period.d1,
    d2: period.d2,
    concurrency: Number(process.env.REPORT_CONCURRENCY) || 5,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stderr.write(`  обработано ${done}/${total}\n`);
      }
    },
  });

  return report;
}

function writeOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `stock-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, reportToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { csvPath, jsonPath };
}

function printSummary(report) {
  const t = report.totals;
  const top = report.rows.filter((r) => r.hasData && r.lostRevenue > 0).slice(0, 10);

  console.log('\n=== Наличие товара и упущенная выручка ===');
  console.log(`Период:            ${report.period.d1} … ${report.period.d2}`);
  console.log(`SKU с данными:      ${t.skuCount} из ${t.skusRequested}`);
  if (t.skusNoData) console.log(`SKU без данных:     ${t.skusNoData}`);
  console.log(`Продано всего:      ${fmt(t.unitsSold)} шт на ${fmt(t.revenue)} ₽`);
  console.log(`Дней простоя:       ${fmt(t.daysOutOfStock)} (сумма по всем SKU)`);
  console.log(`Упущено:            ${fmt(t.lostUnits)} шт ≈ ${fmt(t.lostRevenue)} ₽`);

  if (top.length) {
    console.log('\nТоп по упущенной выручке:');
    for (const r of top) {
      console.log(
        `  ${r.sku}\t${r.daysOutOfStock} дн. без остатка\t≈ ${fmt(r.lostRevenue)} ₽`
      );
    }
  }
  if (report.errors.length) {
    console.log(`\n⚠ Ошибок при запросах: ${report.errors.length} (см. .json)`);
    // Показываем несколько РАЗНЫХ текстов ошибок — этого хватает для диагноза.
    const uniq = [...new Set(report.errors.map((e) => e.error))].slice(0, 3);
    console.log('  Примеры ошибок:');
    for (const msg of uniq) {
      const sku = report.errors.find((e) => e.error === msg)?.sku;
      console.log(`   • [${sku}] ${msg}`);
    }
  }
}

// Запуск как самостоятельного скрипта.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argD1, argD2] = process.argv;
  runReport({ d1: argD1, d2: argD2 })
    .then((report) => {
      const { csvPath, jsonPath } = writeOutputs(report);
      printSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}`);
    })
    .catch((err) => {
      console.error('Ошибка отчёта:', err?.message || err);
      process.exit(1);
    });
}

export { writeOutputs, printSummary };
