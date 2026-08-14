// report-category.js — CLI-раннер отчёта «Топ рубашек в полоску за сезон».
//
// Отбирает по категории(ям) WB товары «в полоску» и строит рейтинг топ-N по
// выручке за период. По умолчанию период = последний завершившийся осенний
// сезон (1 сентября … 30 ноября), категории — «Рубашки» (жен + муж).
//
// Запуск:
//   MPSTATS_TOKEN=xxx node report-category.js                       # осень, топ-10 рубашек
//   MPSTATS_TOKEN=xxx node report-category.js 2025-09-01 2025-11-30
//   MPSTATS_TOKEN=xxx node report-category.js "" "" Рубашки-муж 15  # своя группа и topN
//
// Результат: reports-output/top-striped-<d1>_<d2>.csv / .json / .md + сводка в консоль.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildTopStripedReport,
  reportToCSV,
  reportToMarkdown,
  parseKeywords,
} from './lib/categoryReport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Период последнего ЗАВЕРШИВШЕГОСЯ осеннего сезона (1 сен … 30 ноя).
 * Если сейчас декабрь и позже — берём осень текущего года, иначе прошлого
 * (текущая осень ещё не набрала полных данных).
 */
export function autumnPeriod(now = new Date()) {
  const y = now.getUTCFullYear();
  const beforeDecember = now.getUTCMonth() < 11; // 0..10 = янв..ноя
  const year = beforeDecember ? y - 1 : y;
  return { d1: `${year}-09-01`, d2: `${year}-11-30` };
}

/** Загружает категории: метка → список путей WB (config/categories.json). */
export function loadCategories() {
  const file = path.join(__dirname, 'config', 'categories.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { map: parsed.categories || {}, def: parsed.default || Object.keys(parsed.categories || {})[0] };
}

/**
 * Разворачивает выбор категорий в список путей.
 * Аргумент может быть: меткой из config («Рубашки»), несколькими метками
 * через запятую, либо явным путём WB со слэшем («Мужчинам/Рубашки»).
 */
export function resolveCategories(selector) {
  const { map, def } = loadCategories();
  const sel = String(selector || def).trim() || def;

  const out = [];
  for (const token of sel.split(',').map((t) => t.trim()).filter(Boolean)) {
    if (map[token]) out.push(...map[token]);
    else if (token.includes('/')) out.push(token); // явный путь категории
    else process.stderr.write(`⚠ Неизвестная метка категории «${token}» — пропускаю.\n`);
  }
  // Уникализируем пути, сохраняя порядок.
  return [...new Set(out)];
}

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

export async function runReport({ d1, d2, categories, topN, keywords } = {}) {
  const period = d1 && d2 ? { d1, d2 } : autumnPeriod();
  const cats =
    Array.isArray(categories) && categories.length
      ? categories
      : resolveCategories(categories ?? process.env.CATEGORY_SELECTOR);
  const n = Number(topN || process.env.CATEGORY_TOP_N) || 10;
  const kw = parseKeywords(keywords ?? process.env.STRIPE_KEYWORDS);

  process.stderr.write(
    `Топ-${n} рубашек в полоску, период ${period.d1} … ${period.d2}\n` +
      `Категории: ${cats.join(' | ')}\n`
  );

  const report = await buildTopStripedReport({
    categories: cats,
    d1: period.d1,
    d2: period.d2,
    topN: n,
    keywords: kw,
    pageSize: Number(process.env.CATEGORY_PAGE_SIZE) || 500,
    maxRows: Number(process.env.CATEGORY_MAX_ROWS) || 3000,
    onProgress: (msg) => process.stderr.write(`  ${msg}\n`),
  });

  return report;
}

export function writeOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `top-striped-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  const mdPath = path.join(dir, `${base}.md`);
  fs.writeFileSync(csvPath, reportToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, reportToMarkdown(report));
  return { csvPath, jsonPath, mdPath };
}

export function printSummary(report) {
  const t = report.totals;
  console.log('\n=== Топ рубашек в полоску за сезон ===');
  console.log(`Период:            ${report.period.d1} … ${report.period.d2}`);
  console.log(`Просмотрено карточек: ${fmt(t.scanned)}`);
  console.log(`Полосатых найдено: ${fmt(t.stripedFound)}`);
  console.log(`В топе:            ${t.topN} (∑ ${fmt(t.unitsSold)} шт на ${fmt(t.revenue)} ₽)`);

  if (report.rows.length) {
    console.log('\nРейтинг по выручке:');
    report.rows.forEach((r, i) => {
      const nm = (r.name || String(r.sku)).slice(0, 45);
      console.log(
        `  ${String(i + 1).padStart(2)}. ${nm}\t${fmt(r.revenue)} ₽\t(${fmt(r.unitsSold)} шт, ${r.brand || '—'})`
      );
    });
  } else {
    console.log('\n⚠ Полосатых товаров не найдено — проверьте пути категорий и ключевые слова.');
  }

  const capped = report.coverage.filter((c) => c.capped);
  if (capped.length) {
    console.log('\n⚠ Охват неполный (товаров в категории больше, чем просмотрено):');
    for (const c of capped) {
      console.log(`   • ${c.category}: ${fmt(c.scanned)} из ${fmt(c.total)} (лимит ${fmt(c.cappedAt)})`);
    }
    console.log('   Хвост слабых продавцов в рейтинг не попал (на ТОП не влияет).');
    console.log('   Чтобы просмотреть больше — увеличьте CATEGORY_MAX_ROWS.');
  }
  if (report.errors.length) {
    console.log(`\n⚠ Ошибок при запросах: ${report.errors.length} (см. .json)`);
    for (const e of report.errors.slice(0, 3)) console.log(`   • [${e.category}] ${e.error}`);
  }
}

// Запуск как самостоятельного скрипта.
//   node report-category.js [d1] [d2] [категории] [topN]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argD1, argD2, argCats, argTopN] = process.argv;
  runReport({
    d1: argD1 || undefined,
    d2: argD2 || undefined,
    categories: argCats || undefined,
    topN: argTopN || undefined,
  })
    .then((report) => {
      const { csvPath, jsonPath, mdPath } = writeOutputs(report);
      printSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}\n  ${mdPath}`);
    })
    .catch((err) => {
      console.error('Ошибка отчёта:', err?.message || err);
      process.exit(1);
    });
}
