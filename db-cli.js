// db-cli.js — небольшой CLI для работы с локальной БД (data/wb.db).
//
// Команды:
//   node db-cli.js stats                     — что накоплено в БД
//   node db-cli.js sync                       — залить справочник из config/*.json
//   node db-cli.js daily <wb> [d1] [d2]       — дневной ряд по SKU (CSV в stdout)
//   node db-cli.js report                     — последний сохранённый отчёт (сводка)
//
// Путь к БД переопределяется через env DB_PATH.

import {
  openDb,
  closeDb,
  syncProducts,
  syncGroups,
  getSkuDaily,
  latestReport,
  stats as dbStats,
} from './lib/db.js';
import { loadItems, loadGroups } from './report-stock.js';

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

function cmdStats(db) {
  const s = dbStats(db);
  console.log('=== Содержимое БД ===');
  console.log(`Товаров в справочнике: ${s.products}`);
  console.log(`Групп (линеек):        ${s.groups}`);
  console.log(
    `Дневных строк:         ${fmt(s.skuDailyRows)} по ${s.skuDailyDistinct} SKU` +
      (s.skuDailyRange ? ` (${s.skuDailyRange.from} … ${s.skuDailyRange.to})` : '')
  );
  console.log(`Снимков отчётов:       ${s.reportRuns}`);
  console.log(`Выгрузок инструментов: ${s.toolExports}`);
  console.log('--- слой бота (v2) ---');
  console.log(`Пользователей:         ${s.users}`);
  console.log(`Кэш вытяжек:           ${s.sourceCache}`);
  console.log(`Файлов отчётов (BLOB): ${s.reportFiles}`);
  console.log(`Склеек (варианты):     ${s.cardVariants}`);
  console.log(`Прогонов скиллов:      ${s.skillRuns}`);
}

function cmdSync(db) {
  const items = loadItems();
  const groups = loadGroups();
  syncProducts(db, items);
  syncGroups(db, groups);
  console.log(`Синхронизировано: ${items.length} товаров, ${Object.keys(groups).length} групп.`);
}

function cmdDaily(db, [wb, d1, d2]) {
  if (!wb) {
    console.error('Укажите WB-артикул: node db-cli.js daily <wb> [d1] [d2]');
    process.exit(1);
  }
  const rows = getSkuDaily(db, wb, d1, d2);
  console.log('date;balance;sales;price;revenue');
  for (const r of rows) {
    console.log([r.date, r.balance, r.sales, r.price, r.revenue].join(';'));
  }
  console.error(`\n${rows.length} строк по SKU ${wb}.`);
}

function cmdReport(db) {
  const rep = latestReport(db);
  if (!rep) {
    console.log('Сохранённых отчётов пока нет.');
    return;
  }
  const t = rep.totals;
  console.log(`Последний отчёт #${rep.id} (${rep.kind})`);
  console.log(`Период:    ${rep.period.d1} … ${rep.period.d2}`);
  console.log(`Собран:    ${rep.createdAt}`);
  console.log(`Строк:     ${rep.rows.length}`);
  if (t && t.lostRevenue != null) {
    console.log(`Упущено:   ${fmt(t.lostUnits)} шт ≈ ${fmt(t.lostRevenue)} ₽`);
  }
}

const [, , cmd, ...rest] = process.argv;
const db = openDb();
try {
  switch (cmd) {
    case 'stats': cmdStats(db); break;
    case 'sync': cmdSync(db); break;
    case 'daily': cmdDaily(db, rest); break;
    case 'report': cmdReport(db); break;
    default:
      console.log('Команды: stats | sync | daily <wb> [d1] [d2] | report');
      process.exit(cmd ? 1 : 0);
  }
} finally {
  closeDb(db);
}
