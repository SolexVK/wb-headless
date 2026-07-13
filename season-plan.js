// season-plan.js — CLI-раннер «план продаж на сезон» (метод Овчинникова).
//
// Источник группы — один из двух:
//   A. Линейка из config/groups.json (явный список WB):
//        MPSTATS_TOKEN=xxx node season-plan.js --group РМП --d1 2024-08-01 --d2 2025-01-31
//   B. Сборка из ПРЕДМЕТА (path) с детальной фильтрацией:
//        MPSTATS_TOKEN=xxx node season-plan.js \
//          --path "Женщинам/Одежда/Платья" --words платье --price-min 1500 --price-max 4000 \
//          --min-sales 3 --limit 60 --d1 2024-08-01 --d2 2025-01-31
//
// Период по умолчанию — тот же сезон год назад (последние 365 дней, сдвинутые).
// Результат: reports-output/season-<label>-<d1>_<d2>.csv и .json + сводка.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSeasonPlanReport, seasonPlanToCSV } from './lib/seasonPlanReport.js';
import { loadGroups } from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ymd = (d) => d.toISOString().slice(0, 10);

/** Период по умолчанию: последний завершённый год (год-назад-сезон). */
export function defaultYear() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCDate(start.getUTCDate() + 1);
  return { d1: ymd(start), d2: ymd(end) };
}

/** Разбор argv вида --key value / --flag в объект. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v) => (v == null || v === true ? undefined : Number(v));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

/** Собирает параметры отчёта из разобранных аргументов/окружения. */
export function buildParamsFromArgs(a = {}) {
  const period = a.d1 && a.d2 ? { d1: a.d1, d2: a.d2 } : defaultYear();

  const plan = {
    targetPeriodUnits: num(a['target-units']),
    ambition: num(a.ambition),
    minPrice: num(a['min-price']),
    hotCoeff: num(a['hot-coeff']),
    ratingLeadDays: num(a['rating-lead']),
    logisticsLeadDays: num(a['logi-lead']),
  };
  // Убираем undefined, чтобы не перетирать DEFAULTS ядра.
  for (const k of Object.keys(plan)) if (plan[k] === undefined) delete plan[k];

  // Режим A — линейка из groups.json.
  if (a.group) {
    const groups = loadGroups();
    const wbList = groups[a.group];
    if (!wbList) throw new Error(`Неизвестная группа «${a.group}». Есть: ${Object.keys(groups).join(', ')}`);
    return { ...period, label: a.group, group: wbList.map((wb) => ({ wb })), plan };
  }

  // Режим B — сборка из предмета (path) с фильтрацией.
  if (a.path) {
    const filter = {
      words: list(a.words),
      allWords: list(a['all-words']),
      exclude: list(a.exclude),
      brands: list(a.brands),
      excludeBrands: list(a['exclude-brands']),
      priceMin: num(a['price-min']),
      priceMax: num(a['price-max']),
      minSales: num(a['min-sales']),
    };
    for (const k of Object.keys(filter)) if (filter[k] === undefined) delete filter[k];
    return {
      ...period,
      label: a.label || a.path,
      subject: { path: a.path, filter, limit: num(a.limit) },
      plan,
    };
  }

  throw new Error('Укажите источник группы: --group <линейка> ИЛИ --path <предмет> [фильтры].');
}

function slug(s) {
  return String(s || 'group').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
}

function writeOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `season-${slug(report.label)}-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, seasonPlanToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { csvPath, jsonPath };
}

function printSummary(report) {
  const p = report.plan;
  console.log('\n=== План продаж на сезон ===');
  console.log(`Линейка/предмет:   ${report.label}`);
  console.log(`Период истории:    ${report.period.d1} … ${report.period.d2}`);
  if (report.groupInfo) {
    console.log(`Предмет:           ${report.groupInfo.path}`);
    console.log(`Отобрано в группу: ${report.groupInfo.kept} из ${report.groupInfo.fetched} (всего в предмете ${report.groupInfo.total})`);
  }
  console.log(`Размер группы:     ${report.groupSize}, с данными: ${report.itemsWithData}`);

  if (report.dailyLimit) {
    console.log('\n⛔ Остановлено на дневном лимите MPSTATS:', report.dailyLimit);
  }
  if (!p) {
    console.log('\n⚠ Нет данных для построения плана.');
    return;
  }

  console.log('\n— Ранг сезонности —');
  console.log(`  ${p.rank.rank} (амплитуда ${p.rank.amplitude}, p90/p10 = ${p.rank.p90}/${p.rank.p10})`);

  const ph = p.phases;
  if (ph) {
    console.log('\n— Фазы сезона (история → проекция на след. год) —');
    const line = (o) => `${o.date} → ${o.dateNext}` + (o.kSales != null ? `  (k=${o.kSales})` : '');
    console.log(`  Вход в рынок:      ${ph.entry.date} → ${ph.entry.dateNext}${ph.entry.beforeWindow ? '  (раньше окна данных)' : ''}  [−${ph.entry.leadDays} дн. на подготовку]`);
    console.log(`  Старт разгона:     ${line(ph.ramp)}`);
    console.log(`  Горячий сезон с:   ${line(ph.hotStart)}`);
    console.log(`  ПИК:               ${line(ph.peak)}`);
    console.log(`  Горячий сезон по:  ${line(ph.hotEnd)}`);
    console.log(`  Старт распродажи:  ${line(ph.sale)}`);
  }

  if (p.pricing) {
    console.log('\n— Ценовые ориентиры (₽) —');
    console.log(`  Средняя по группе: ${fmt(p.pricing.meanPrice)}`);
    console.log(`  Вход/разгон:       ${fmt(p.pricing.entry)}`);
    console.log(`  Пик:               ${fmt(p.pricing.peak)}`);
    console.log(`  Распродажа:        ${fmt(p.pricing.sale)}`);
  }

  console.log('\n— Плановые заказы —');
  console.log(`  База: ${fmt(p.baseDaily)} зак/день. Пример по фазам:`);
  const pick = (date) => p.daily.find((r) => r.date === date);
  for (const o of [ph?.ramp, ph?.peak, ph?.sale].filter(Boolean)) {
    const r = pick(o.date);
    if (r) console.log(`  ${o.label.padEnd(18)} ${o.date}: ${fmt(r.plannedOrders)} зак/день`);
  }

  if (report.errors.length) {
    console.log(`\n⚠ Ошибок при запросах: ${report.errors.length}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  let params;
  try {
    params = buildParamsFromArgs(a);
  } catch (err) {
    console.error('Ошибка параметров:', err?.message || err);
    process.exit(1);
  }
  process.stderr.write(`Строю план сезона «${params.label}» за ${params.d1}…${params.d2}\n`);
  buildSeasonPlanReport({
    ...params,
    concurrency: Number(process.env.REPORT_CONCURRENCY) || 5,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stderr.write(`  обработано ${done}/${total}\n`);
    },
  })
    .then((report) => {
      const { csvPath, jsonPath } = writeOutputs(report);
      printSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}`);
      if (report.dailyLimit) process.exit(2);
    })
    .catch((err) => {
      console.error('Ошибка отчёта:', err?.message || err);
      process.exit(1);
    });
}

export { writeOutputs, printSummary };
