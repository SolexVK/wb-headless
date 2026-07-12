// report-niche.js — CLI-раннер отчёта «Анализ ниши» (категории WB).
//
// Запуск:
//   MPSTATS_TOKEN=xxx NICHE_PATH="Женщинам/Одежда/Платья" node report-niche.js
//   MPSTATS_TOKEN=xxx node report-niche.js "Женщинам/Одежда/Платья"
//   MPSTATS_TOKEN=xxx node report-niche.js "Женщинам/Одежда/Платья" 2026-06-01 2026-06-30
//
// Путь категории берётся из аргумента №1 или из NICHE_PATH.
// Результат: reports-output/niche-<категория>-<d1>_<d2>.csv (товары) и .json
// (полный анализ: 5 блоков + скоринг) + сводка в консоль.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildNicheAnalysis } from './lib/nicheAnalysis.js';
import { nicheReportToCSV } from './lib/nicheReport.js';
import { defaultPeriod } from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

/** Безопасное имя файла из пути категории: "Женщинам/Одежда" → "Женщинам_Одежда". */
function slugCategory(categoryPath) {
  return (
    String(categoryPath)
      .trim()
      .replace(/[\\/]+/g, '_')
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'niche'
  );
}

/** Адаптер: анализ → форма для nicheReportToCSV (товары + минимальные итоги). */
function toCsvReport(analysis) {
  return {
    items: analysis.items,
    totals: {
      totalUnits: analysis.capacity.totalUnits,
      totalRevenue: analysis.capacity.totalRevenue,
    },
  };
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

  process.stderr.write(`Анализ ниши: «${cat}», период ${period.d1} … ${period.d2}\n`);

  return buildNicheAnalysis({
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

export function writeOutputs(analysis) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `niche-${slugCategory(analysis.categoryPath)}-${analysis.period.d1}_${analysis.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, nicheReportToCSV(toCsvReport(analysis)));
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2));
  return { csvPath, jsonPath };
}

export function printSummary(analysis) {
  const { score, capacity: c, competition: comp, saturation: sat, trend, seasonality: seas } = analysis;

  console.log('\n' + '═'.repeat(64));
  console.log(`АНАЛИЗ НИШИ: ${analysis.categoryPath}`);
  console.log(`Период: ${analysis.period.d1} … ${analysis.period.d2} (${analysis.period.days} дн)`);
  console.log('═'.repeat(64));
  console.log(
    `\n🏁 ВЕРДИКТ: ${score.verdict.toUpperCase()}  —  ${score.total}/100 баллов` +
      `\n   Узкое место: ${score.bottleneck}`
  );

  console.log('\nОценка по измерениям:');
  const rows = [
    ['Ёмкость', score.blocks.capacity],
    ['Сезонность', score.blocks.seasonality],
    ['Тренд', score.blocks.trend],
    ['Конкуренция', score.blocks.competition],
    ['Насыщенность', score.blocks.saturation],
  ];
  for (const [title, b] of rows) {
    const bar = '█'.repeat(Math.round(b.score / 2)) + '░'.repeat(10 - Math.round(b.score / 2));
    console.log(`  ${title.padEnd(13)} ${bar} ${String(b.score).padStart(2)}/20  ${b.label}`);
    console.log(`  ${''.padEnd(13)} ${b.detail}`);
  }

  console.log('\nЦифры ниши:');
  console.log(`  Товаров: ${fmt(c.productsInNiche)}` + (c.truncated ? ` (анализ по ${fmt(c.productsAnalyzed)} топ по выручке)` : ''));
  console.log(`  Выручка: ${fmt(c.totalRevenue)} ₽ (${fmt(c.totalUnits)} шт) за период`);
  console.log(`  Упущенная выручка (дефицит спроса): ${fmt(c.lostRevenue)} ₽`);
  console.log(`  Цена сред./медиана: ${fmt(c.avgPrice)} / ${fmt(c.medianPrice)} ₽`);
  console.log(`  Продавцов: ${fmt(comp.sellersCount)} · брендов: ${fmt(comp.brandsCount)}`);
  console.log(`  Монополизация (топ-10 товаров): ${comp.monopolyPct}% · лидер: ${comp.topSeller} (${comp.topSellerSharePct}%)`);
  if (trend) console.log(`  Тренд выручки: ${trend.deltaPct}% (${trend.direction})`);
  if (seas?.sufficient) console.log(`  Сезонность: ${seas.level}, пик — месяц ${seas.peakMonth}`);

  if (analysis.sellers?.length) {
    console.log('\nТоп-продавцы ниши:');
    for (const s of analysis.sellers.slice(0, 7)) {
      console.log(`  ${s.seller}\t${s.products} карт.\t${fmt(s.revenue)} ₽\t${s.revenueSharePct}%`);
    }
  }

  if (analysis.notes?.length) {
    console.log('\n⚠ Примечания:');
    for (const n of analysis.notes) console.log(`  • ${n}`);
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
    .then((analysis) => {
      const { csvPath, jsonPath } = writeOutputs(analysis);
      printSummary(analysis);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}`);
    })
    .catch((err) => {
      console.error('Ошибка анализа ниши:', err?.message || err);
      process.exit(1);
    });
}
