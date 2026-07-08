// report-abc.js — CLI-раннер ABC(-XYZ) анализа товарной матрицы.
//
// Запуск:
//   MPSTATS_TOKEN=xxx node report-abc.js                      # период = последние 30 дней, ABC по выручке
//   MPSTATS_TOKEN=xxx node report-abc.js 2026-06-01 2026-06-30
//   MPSTATS_TOKEN=xxx node report-abc.js "" "" "РМП"          # только РМП за период по умолчанию
//   MPSTATS_TOKEN=xxx ABC_METRIC=units node report-abc.js     # ранжировать ABC по штукам
//
// Результат: reports-output/abc-<d1>_<d2>.csv и .json + матрица в консоль.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAbcReport, abcReportToCSV } from './lib/abcReport.js';
import {
  defaultPeriod,
  loadItems,
  selectItems,
  selectByGroup,
} from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALL_LABELS = new Set(['', 'все', 'all', 'всё']);

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

export async function runAbcReport({ d1, d2, items, filter, group, metric } = {}) {
  const period = d1 && d2 ? { d1, d2 } : defaultPeriod(Number(process.env.REPORT_DAYS) || 30);
  const all = items || loadItems();

  // Приоритет выбора: текстовый фильтр → группа из выпадающего списка → все.
  const f = filter ?? process.env.REPORT_FILTER;
  const g = group ?? process.env.REPORT_GROUP;
  const selected = f && String(f).trim() ? selectItems(all, f) : selectByGroup(all, g);
  const m = metric ?? process.env.ABC_METRIC ?? 'revenue';

  const how = f && String(f).trim()
    ? `фильтр «${String(f).trim()}»`
    : g && !ALL_LABELS.has(String(g).trim().toLowerCase())
      ? `группа «${String(g).trim()}»`
      : 'все';
  process.stderr.write(
    `ABC-анализ (${m === 'units' ? 'по штукам' : 'по выручке'}): ` +
      `${selected.length} из ${all.length} товаров (${how}), период ${period.d1} … ${period.d2}\n`
  );
  if (selected.length === 0) {
    process.stderr.write('⚠ Фильтр не выбрал ни одного товара — проверьте значение фильтра.\n');
  }

  return buildAbcReport({
    items: selected,
    d1: period.d1,
    d2: period.d2,
    metric: m,
    concurrency: Number(process.env.REPORT_CONCURRENCY) || 5,
    onProgress: (doneN, total) => {
      if (doneN % 10 === 0 || doneN === total) {
        process.stderr.write(`  обработано ${doneN}/${total}\n`);
      }
    },
  });
}

export function writeAbcOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `abc-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, abcReportToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { csvPath, jsonPath };
}

export function printAbcSummary(report) {
  const t = report.totals;

  if (report.dailyLimit) {
    console.log('\n' + '═'.repeat(60));
    console.log('⛔ ОСТАНОВЛЕНО: превышен дневной лимит запросов MPSTATS.');
    console.log(`   Ответ MPSTATS: ${report.dailyLimit}`);
    console.log(`   Обработать успели: ${t.skuCount} из ${t.skusRequested} SKU`);
    console.log('   Матрица построена по частичным данным — не считайте её полной.');
    console.log('═'.repeat(60));
  }

  console.log('\n=== ABC-XYZ анализ товарной матрицы ===');
  console.log(`Период:            ${report.period.d1} … ${report.period.d2}`);
  console.log(`Ранжирование ABC:  по ${report.metric === 'units' ? 'штукам' : 'выручке'}`);
  console.log(`SKU с данными:      ${t.skuCount} из ${t.skusRequested}`);
  if (t.skusNoData) console.log(`SKU без данных:     ${t.skusNoData}`);
  console.log(`Продано всего:      ${fmt(t.units)} шт на ${fmt(t.revenue)} ₽`);

  const th = report.thresholds;
  console.log(
    `\nПороги: A ≤ ${th.aPct}% · B ≤ ${th.bPct}% накопл. выручки | ` +
      `X ≤ ${th.xCv}% · Y ≤ ${th.yCv}% вариации спроса`
  );

  // Матрица 3×3: SKU и доля выручки в каждой ячейке.
  const XYZ = ['X', 'Y', 'Z'];
  const ABC = ['A', 'B', 'C'];
  const pad = (s, n) => String(s).padStart(n);
  console.log('\nМатрица (SKU / доля выручки):');
  console.log('        ' + XYZ.map((x) => pad(x, 14)).join('') + pad('Σ ABC', 14));
  for (const a of ABC) {
    let row = `  ${a}   `;
    for (const x of XYZ) {
      const c = report.matrix[a][x];
      row += pad(`${c.skuCount} / ${c.revenueSharePct}%`, 14);
    }
    const g = report.classTotals.abc[a];
    row += pad(`${g.skuCount} / ${g.revenueSharePct}%`, 14);
    console.log(row);
  }
  let foot = '  Σ XYZ';
  for (const x of XYZ) {
    const g = report.classTotals.xyz[x];
    foot += pad(`${g.skuCount} / ${g.revenueSharePct}%`, 14);
  }
  console.log(foot);

  // Кандидаты на вывод из матрицы: класс CZ (мало денег + рваный спрос).
  const cz = report.rows.filter((r) => r.class === 'CZ');
  if (cz.length) {
    console.log(`\nCZ (кандидаты на вывод из матрицы): ${cz.length} SKU`);
    for (const r of cz.slice(0, 10)) {
      console.log(`  ${r.seller || r.sku}\t${fmt(r.revenue)} ₽\tвариация ${r.cvPct}%`);
    }
    if (cz.length > 10) console.log(`  … и ещё ${cz.length - 10}`);
  }

  if (report.errors.length) {
    console.log(`\n⚠ Ошибок при запросах: ${report.errors.length} (см. .json)`);
    const uniq = [...new Set(report.errors.map((e) => e.error))].slice(0, 3);
    for (const msg of uniq) {
      const sku = report.errors.find((e) => e.error === msg)?.sku;
      console.log(`   • [${sku}] ${msg}`);
    }
  }
}

// Запуск как самостоятельного скрипта: node report-abc.js [d1] [d2] [фильтр]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argD1, argD2, argFilter] = process.argv;
  runAbcReport({ d1: argD1 || undefined, d2: argD2 || undefined, filter: argFilter })
    .then((report) => {
      const { csvPath, jsonPath } = writeAbcOutputs(report);
      printAbcSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}`);
      if (report.dailyLimit) process.exit(2);
    })
    .catch((err) => {
      console.error('Ошибка ABC-отчёта:', err?.message || err);
      process.exit(1);
    });
}
