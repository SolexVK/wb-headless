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
import {
  openDb,
  closeDb,
  syncProducts,
  syncGroups,
  saveSkuDaily,
  saveReport,
  stats as dbStats,
} from './lib/db.js';

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

/**
 * Загружает пары {wb, seller} из config/skus.json.
 * Поддерживает и новый формат (items), и старый (skus — просто числа).
 */
export function loadItems() {
  const file = path.join(__dirname, 'config', 'skus.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed.items)) return parsed.items;
  return (parsed.skus || []).map((wb) => ({ wb, seller: '' }));
}

/** Загружает группы (линейки) товаров: метка → список WB-артикулов. */
export function loadGroups() {
  const file = path.join(__dirname, 'config', 'groups.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.groups || {};
  } catch (_) {
    return {};
  }
}

const ALL_LABELS = new Set(['', 'все', 'all', 'всё']);

/**
 * Выбирает товары по группе (метке из выпадающего списка).
 * «Все»/пусто → все товары. Неизвестная метка → все (с предупреждением).
 */
export function selectByGroup(items, group) {
  const g = String(group || '').trim();
  if (ALL_LABELS.has(g.toLowerCase())) return items;
  const list = loadGroups()[g];
  if (!list) {
    process.stderr.write(`⚠ Неизвестная группа «${g}» — беру все товары.\n`);
    return items;
  }
  const set = new Set(list.map(String));
  return items.filter((it) => set.has(String(it.wb)));
}

/**
 * Выбирает подмножество товаров по строке-фильтру.
 * Фильтр — список токенов через запятую. Товар попадает в выборку, если
 * ЛЮБОЙ токен: совпал с WB-артикулом (если токен из цифр) ИЛИ содержится
 * в артикуле продавца (без учёта регистра). Пустой фильтр = все товары.
 *
 * Примеры: "РМП"  |  "002_РМП_белый, 016 МС голубой"  |  "535397255"
 */
export function selectItems(items, filter) {
  const tokens = String(filter || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return items;

  const lc = (s) => String(s).toLowerCase();
  return items.filter((it) =>
    tokens.some((tok) => {
      if (/^\d+$/.test(tok)) return String(it.wb) === tok; // чисто числовой = WB
      return lc(it.seller).includes(lc(tok)); // иначе поиск по артикулу продавца
    })
  );
}

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

export async function runReport({ d1, d2, items, filter, group, persist = true } = {}) {
  const period = d1 && d2 ? { d1, d2 } : defaultPeriod(Number(process.env.REPORT_DAYS) || 30);
  const all = items || loadItems();

  // БД: справочник + накопление дневного сырья + снимок отчёта.
  // Отключается через persist:false или DB_DISABLE=1 (например, для дампов).
  const useDb = persist && process.env.DB_DISABLE !== '1';
  let db = null;
  if (useDb) {
    try {
      db = openDb();
      syncProducts(db, all);
      syncGroups(db, loadGroups());
    } catch (err) {
      // БД не должна ломать отчёт — деградируем к режиму «только файлы».
      process.stderr.write(`⚠ БД недоступна, продолжаю без неё: ${err?.message || err}\n`);
      db = null;
    }
  }

  // Приоритет: текстовый фильтр (для точечного выбора) → группа из
  // выпадающего списка → все товары.
  const f = filter ?? process.env.REPORT_FILTER;
  const g = group ?? process.env.REPORT_GROUP;
  const selected = f && String(f).trim() ? selectItems(all, f) : selectByGroup(all, g);

  const how = f && String(f).trim()
    ? `фильтр «${String(f).trim()}»`
    : g && !ALL_LABELS.has(String(g).trim().toLowerCase())
      ? `группа «${String(g).trim()}»`
      : 'все';
  process.stderr.write(
    `Отчёт по наличию: ${selected.length} из ${all.length} товаров (${how}), период ${period.d1} … ${period.d2}\n`
  );
  if (selected.length === 0) {
    process.stderr.write('⚠ Фильтр не выбрал ни одного товара — проверьте значение фильтра.\n');
  }

  const report = await buildStockAvailabilityReport({
    items: selected,
    d1: period.d1,
    d2: period.d2,
    concurrency: Number(process.env.REPORT_CONCURRENCY) || 5,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stderr.write(`  обработано ${done}/${total}\n`);
      }
    },
    // Дневное сырьё пишем в БД по мере получения — накапливается между запусками.
    onSkuDaily: db ? (sku, daily) => saveSkuDaily(db, sku, daily) : undefined,
  });

  if (db) {
    try {
      const runId = saveReport(db, report);
      const s = dbStats(db);
      process.stderr.write(
        `БД: сохранён снимок #${runId}; накоплено ${s.skuDailyRows} дневных строк по ${s.skuDailyDistinct} SKU` +
          (s.skuDailyRange ? ` (${s.skuDailyRange.from} … ${s.skuDailyRange.to})` : '') + '\n'
      );
    } catch (err) {
      process.stderr.write(`⚠ Не удалось сохранить в БД: ${err?.message || err}\n`);
    } finally {
      closeDb(db);
    }
  }

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

  if (report.dailyLimit) {
    console.log('\n' + '═'.repeat(60));
    console.log('⛔ ОСТАНОВЛЕНО: превышен дневной лимит запросов MPSTATS.');
    console.log(`   Ответ MPSTATS: ${report.dailyLimit}`);
    console.log(`   Обработать успели: ${report.totals.skuCount} из ${report.totals.skusRequested} SKU`);
    console.log('   Что делать: подождать сброса лимита (обычно на след. сутки)');
    console.log('   и запускать отчёт РЕЖЕ — 1 раз в день, а не многократно.');
    console.log('═'.repeat(60));
  }

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
      const label = r.seller ? r.seller : r.sku;
      console.log(
        `  ${label}\t${r.daysOutOfStock} дн. без остатка\t≈ ${fmt(r.lostRevenue)} ₽`
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
//   node report-stock.js [d1] [d2] [фильтр]
//   node report-stock.js "" "" "РМП"        # только РМП за период по умолчанию
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argD1, argD2, argFilter] = process.argv;
  runReport({ d1: argD1 || undefined, d2: argD2 || undefined, filter: argFilter })
    .then((report) => {
      const { csvPath, jsonPath } = writeOutputs(report);
      printSummary(report);
      console.log(`\nФайлы:\n  ${csvPath}\n  ${jsonPath}`);
      // Дневной лимит MPSTATS — помечаем запуск как неуспешный (красный ❌),
      // но файлы с частичными данными всё равно сохранены и приложены.
      if (report.dailyLimit) process.exit(2);
    })
    .catch((err) => {
      console.error('Ошибка отчёта:', err?.message || err);
      process.exit(1);
    });
}

export { writeOutputs, printSummary };
