// report-fines.js — CLI-раннер отчёта «Штрафы и затраты на Wildberries».
//
// Запуск (токен WB категории «Финансы» — в WB_API_TOKEN или Wildberries_API):
//   node report-fines.js                       # последние REPORT_DAYS дней
//   node report-fines.js 2026-07-01 2026-07-31 # явный период
//   REPORT_GROUP=РМП node report-fines.js      # только линейка РМП
//   node report-fines.js "" "" "РМП"           # точечный фильтр
//
// Результат: reports-output/fines-<d1>_<d2>.csv (по товарам),
//            fines-<d1>_<d2>-reasons.csv (по причинам) и .json + сводка в консоль.
//
// ВНИМАНИЕ: WB держит на финансовых методах лимит 1 запрос в минуту, поэтому
// выгрузка идёт неспешно (клиент сам выдерживает паузы). Это нормально —
// запускать отчёт стоит по расписанию, а не в цикле.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildFinesReport, finesReportToCSV, finesByReasonToCSV } from './lib/finesReport.js';
import { defaultPeriod, loadItems, selectItems, selectByGroup } from './report-stock.js';
import { resolveWbToken } from './lib/wbToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_LABELS = new Set(['', 'все', 'all', 'всё']);
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

/**
 * Выбирает товары так же, как отчёт по наличию: точечный фильтр перебивает
 * группу, пусто = все товары кабинета (тогда отчёт не фильтруется вовсе).
 * @returns {{items: Array|null, how: string}} items=null → без фильтра
 */
export function selectScope({ filter, group } = {}) {
  const f = filter ?? process.env.REPORT_FILTER;
  const g = group ?? process.env.REPORT_GROUP;

  if (f && String(f).trim()) {
    const items = selectItems(loadItems(), f);
    return { items, how: `фильтр «${String(f).trim()}»` };
  }
  if (g && !ALL_LABELS.has(String(g).trim().toLowerCase())) {
    const items = selectByGroup(loadItems(), g);
    return { items, how: `группа «${String(g).trim()}»` };
  }
  // Без фильтра берём ВЕСЬ кабинет: штрафы и удержания часто приходят
  // строками без артикула, и по подмножеству SKU их просто не увидеть.
  return { items: null, how: 'весь кабинет' };
}

export async function runFinesReport({ d1, d2, filter, group, granularity } = {}) {
  const period = d1 && d2 ? { d1, d2 } : defaultPeriod(Number(process.env.REPORT_DAYS) || 30);
  const { items, how } = selectScope({ filter, group });
  const gran = granularity || process.env.FINES_PERIOD || 'weekly';

  const { source } = resolveWbToken();
  process.stderr.write(
    `Отчёт по штрафам и затратам: ${how}, период ${period.d1} … ${period.d2} (${gran})\n` +
    `Токен WB: ${source || 'НЕ НАЙДЕН'}${source ? '' : ' — задайте WB_API_TOKEN или Wildberries_API'}\n`
  );
  if (items && items.length === 0) {
    process.stderr.write('⚠ Фильтр не выбрал ни одного товара — проверьте значение фильтра.\n');
  }

  return buildFinesReport({
    d1: period.d1,
    d2: period.d2,
    period: gran,
    items,
    control: process.env.FINES_CONTROL !== '0',
    onPage: ({ page, received, total }) =>
      process.stderr.write(`  страница ${page}: получено ${received} строк (всего ${total})\n`),
  });
}

export function writeFinesOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `fines-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const reasonsPath = path.join(dir, `${base}-reasons.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, finesReportToCSV(report));
  fs.writeFileSync(reasonsPath, finesByReasonToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { csvPath, reasonsPath, jsonPath };
}

export function printFinesSummary(report) {
  const t = report.totals;

  console.log('\n=== Штрафы и затраты на Wildberries ===');
  console.log(`Период:             ${report.period.d1} … ${report.period.d2}`);
  console.log(`Строк детализации:  ${report.source.rowsUsed} из ${report.source.rowsTotal}`);
  if (report.source.reports.length) {
    const w = report.source.reports.map((r) => `${r.dateFrom}…${r.dateTo}`).join(', ');
    console.log(`Отчёты о реализации: ${report.source.reports.length} (${w})`);
  }

  console.log(`\nВыручка (реализовано):  ${fmt(t.revenue)} ₽  за ${fmt(t.units)} шт`);
  console.log('\nУдержания площадки:');
  // share === null → строка справочная (доля не считается).
  const line = (name, amount, share) =>
    console.log(
      `  ${name.padEnd(22, '.')} ${String(fmt(amount)).padStart(12)} ₽   ` +
      (share == null ? '' : `${share}%`)
    );
  line('Комиссия WB', t.commission, t.commissionPct);
  line('  в т.ч. эквайринг', t.acquiring, null);
  line('Логистика', t.logistics, t.logisticsPct);
  line('Хранение', t.storage, t.storagePct);
  line('Платная приёмка', t.acceptance, t.acceptancePct);
  line('Штрафы', t.penalty, t.penaltyPct);
  line('Прочие удержания', t.deduction, t.deductionPct);
  if (t.additionalPayment) line('Доплаты (минус)', -t.additionalPayment, null);
  line('ИТОГО затрат', t.totalCosts, t.costSharePct);
  console.log(`  Остаётся продавцу...... ${String(fmt(t.netPayout)).padStart(12)} ₽`);
  if (t.deliveries) {
    console.log(
      `\nДоставок ${fmt(t.deliveries)}, возвратов ${fmt(t.returns)}` +
      (t.buyoutPct != null ? `, выкуп ${t.buyoutPct}%` : '') +
      `, логистика ≈ ${fmt(t.logisticsPerDelivery)} ₽ за доставку`
    );
  }

  if (report.fines.length) {
    console.log('\nШтрафы по причинам:');
    for (const f of report.fines.slice(0, 10)) {
      console.log(`  ${f.reason} — ${fmt(f.amount)} ₽ (${f.sharePct}%, строк ${f.rows})`);
      if (f.topSkus.length) {
        console.log(`     топ: ${f.topSkus.map((s) => `${s.seller || s.nmId || '—'} ${fmt(s.amount)} ₽`).join(', ')}`);
      }
    }
  } else {
    console.log('\nШтрафов за период нет ✓');
  }

  const deductions = report.deductions.filter((d) => Math.abs(d.amount) > 0).slice(0, 5);
  if (deductions.length) {
    console.log('\nПрочие удержания по видам:');
    for (const d of deductions) console.log(`  ${d.reason} — ${fmt(d.amount)} ₽ (строк ${d.rows})`);
  }

  const topSku = report.bySku.filter((r) => r.totalCosts > 0).slice(0, 10);
  if (topSku.length) {
    console.log('\nТоп товаров по затратам:');
    for (const r of topSku) {
      console.log(
        `  ${(r.seller || r.sku || '—')}\t${fmt(r.totalCosts)} ₽ (${r.costSharePct}% выручки)` +
        (r.penalty ? `\tштрафы ${fmt(r.penalty)} ₽` : '')
      );
    }
  }

  if (report.control) {
    const c = report.control;
    const verdict = c.matches === null ? 'сверка по кабинету целиком недоступна при фильтре'
      : c.matches ? 'сходится с кабинетом ✓' : 'РАСХОЖДЕНИЕ';
    console.log(`\nСверка с итогами WB (${c.reports} отч.): ${verdict}`);
    if (c.matches === false) {
      for (const [k, v] of Object.entries(c.diff)) {
        if (Math.abs(v) > 1) console.log(`  ${k}: у нас ${fmt(v > 0 ? v : -v)} ₽ ${v > 0 ? 'больше' : 'меньше'} (WB: ${fmt(c.wb[k])} ₽)`);
      }
    }
  }

  if (report.insights.length) {
    console.log('\nВыводы:');
    for (const i of report.insights) console.log(`  • ${i}`);
  }
  for (const w of report.warnings) console.log(`\n⚠ ${w}`);
}

// Запуск как самостоятельного скрипта: node report-fines.js [d1] [d2] [фильтр]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argD1, argD2, argFilter] = process.argv;
  runFinesReport({ d1: argD1 || undefined, d2: argD2 || undefined, filter: argFilter })
    .then((report) => {
      const { csvPath, reasonsPath, jsonPath } = writeFinesOutputs(report);
      printFinesSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${reasonsPath}\n  ${jsonPath}`);
    })
    .catch((err) => {
      console.error('Ошибка отчёта:', err?.message || err);
      process.exit(1);
    });
}
