// report-niche.js — CLI-раннер отчёта «Анализ ниши» (категории WB).
//
// Запуск:
//   MPSTATS_TOKEN=xxx NICHE_PATH="Женщинам/Одежда/Платья" node report-niche.js
//   MPSTATS_TOKEN=xxx node report-niche.js "Женщинам/Одежда/Платья"
//   MPSTATS_TOKEN=xxx node report-niche.js "Женщинам/Одежда/Платья" 2026-06-01 2026-06-30
//
// Путь категории берётся из аргумента №1 или из NICHE_PATH.
// Результат: reports-output/niche-<категория>-<d1>_<d2>.csv и .json + сводка в консоль.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildNicheReport, nicheReportToCSV } from './lib/nicheReport.js';
import { defaultPeriod } from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

/** Безопасное имя файла из пути категории: "Женщинам/Одежда" → "Женщинам_Одежда". */
function slugCategory(categoryPath) {
  return String(categoryPath)
    .trim()
    .replace(/[\\/]+/g, '_')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'niche';
}

export async function runNicheReport({ categoryPath, d1, d2 } = {}) {
  const cat = categoryPath || process.env.NICHE_PATH;
  if (!cat || !String(cat).trim()) {
    throw new Error(
      'Не задан путь категории. Укажите его аргументом или через NICHE_PATH, ' +
        'напр.: NICHE_PATH="Женщинам/Одежда/Платья" node report-niche.js'
    );
  }
  const period = d1 && d2 ? { d1, d2 } : defaultPeriod(Number(process.env.REPORT_DAYS) || 30);

  process.stderr.write(
    `Анализ ниши: «${cat}», период ${period.d1} … ${period.d2}\n`
  );

  return buildNicheReport({
    categoryPath: cat,
    d1: period.d1,
    d2: period.d2,
    maxRows: Number(process.env.NICHE_MAX_ROWS) || 5000,
    pageSize: Number(process.env.NICHE_PAGE_SIZE) || 500,
    onPage: (loaded, total) => {
      process.stderr.write(`  загружено ${loaded}${total ? ` из ${total}` : ''} товаров\n`);
    },
  });
}

export function writeOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `niche-${slugCategory(report.categoryPath)}-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, nicheReportToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { csvPath, jsonPath };
}

export function printSummary(report) {
  const t = report.totals;

  console.log('\n=== Анализ ниши ===');
  console.log(`Категория:            ${report.categoryPath}`);
  console.log(`Период:               ${report.period.d1} … ${report.period.d2}`);
  console.log(
    `Товаров в нише:       ${fmt(t.productsInNiche)}` +
      (t.truncated ? ` (проанализировано ${fmt(t.productsAnalyzed)} — верх по выручке)` : '')
  );
  console.log(`Продавцов / брендов:  ${fmt(t.sellersCount)} / ${fmt(t.brandsCount)}`);
  console.log(
    `С продажами:          ${fmt(t.productsWithSales)} из ${fmt(t.productsAnalyzed)} (${t.withSalesPct}%)`
  );
  console.log(`Выручка ниши:         ${fmt(t.totalRevenue)} ₽ (${fmt(t.totalUnits)} шт)`);
  console.log(`Цена сред./медиана:   ${fmt(t.avgPrice)} / ${fmt(t.medianPrice)} ₽`);
  console.log(`Выручка на карточку:  ${fmt(t.avgRevenuePerProduct)} ₽ (на «живую» ${fmt(t.avgRevenuePerActiveProduct)} ₽)`);
  console.log(`Монополизация:        топ-10 товаров = ${t.top10RevenueSharePct}% выручки`);
  if (t.topSeller) {
    console.log(`Лидер:                ${t.topSeller} — ${t.topSellerSharePct}% выручки ниши`);
  }
  console.log(`Рейтинг / отзывы:     ${t.avgRating} / ${fmt(t.avgComments)} (в среднем)`);

  if (report.sellers.length) {
    console.log('\nТоп-продавцы ниши:');
    for (const s of report.sellers.slice(0, 10)) {
      console.log(
        `  ${s.seller}\t${s.products} карт.\t${fmt(s.revenue)} ₽\t${s.revenueSharePct}%`
      );
    }
  }
}

// Запуск как самостоятельного скрипта.
//   node report-niche.js "<категория>" [d1] [d2]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argCat, argD1, argD2] = process.argv;
  runNicheReport({
    categoryPath: argCat || undefined,
    d1: argD1 || undefined,
    d2: argD2 || undefined,
  })
    .then((report) => {
      const { csvPath, jsonPath } = writeOutputs(report);
      printSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}`);
    })
    .catch((err) => {
      console.error('Ошибка анализа ниши:', err?.message || err);
      process.exit(1);
    });
}
