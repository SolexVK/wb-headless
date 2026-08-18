// report-wb-stock.js — сводный отчёт по остаткам WB на текущий момент.
//
// По каждому артикулу продавца: остаток FBO (склады WB), остаток FBS
// (фулфилмент-склады продавца), «в пути к клиенту» и «в пути от клиента»
// (возвраты). Плюс разрезы по складам FBO и FBS.
//
// Источник — официальное API Wildberries (см. lib/wbApi.js). Нужен WB API-токен
// с категориями «Статистика», «Маркетплейс» и «Контент» (одним токеном или
// раздельными — см. .env.example).
//
// Запуск:
//   WB_API_TOKEN=xxxxx node report-wb-stock.js
//   node report-wb-stock.js --dry-run fixtures/wb-stock.sample.json   # без сети, на фикстурах
//
// Результат: reports-output/wb-stock-<дата>.csv и .json + сводка в консоль.

import './lib/loadEnv.js'; // подхватить .env из корня (не перекрывая реальное окружение)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchFboStocks, fetchFbsWarehouses, fetchFbsStocks, fetchCardsByBarcode } from './lib/wbApi.js';
import { buildStockSummary, summaryToCSV } from './lib/wbStockSummary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
const log = (s) => process.stderr.write(s + '\n');

/**
 * Оркестрация «живых» запросов к WB и сборка отчёта.
 * FBO (статистика) — обязателен; FBS и карточки — best-effort: если токен не
 * закрывает категорию или эндпоинт недоступен, добавляем предупреждение и
 * продолжаем (FBS покажется как 0, связка баркодов возьмётся из FBO).
 */
export async function collectWbStock() {
  const warnings = [];

  // 1) Карточки (Контент) — связка баркод ↔ артикул и полный список баркодов.
  let cardsByBarcode = new Map();
  try {
    log('• Загружаю карточки (Контент)…');
    cardsByBarcode = await fetchCardsByBarcode();
    log(`  карточек-баркодов: ${cardsByBarcode.size}`);
  } catch (err) {
    warnings.push(`Карточки недоступны (${err.message}). Связка баркодов возьмётся из FBO, список баркодов для FBS может быть неполным.`);
    log('  ⚠ ' + warnings[warnings.length - 1]);
  }

  // 2) FBO (Статистика) — остатки WB + «в пути».
  log('• Загружаю остатки FBO (Статистика)…');
  const fboRows = await fetchFboStocks();
  log(`  строк FBO: ${fboRows.length}`);

  // 3) FBS (Маркетплейс) — склады продавца + остатки по баркодам.
  const fbsStocksByWh = new Map();
  let fbsWarehouses = [];
  try {
    log('• Загружаю склады FBS (Маркетплейс)…');
    fbsWarehouses = await fetchFbsWarehouses();
    log(`  складов FBS: ${fbsWarehouses.length}`);
    // Баркоды: из карточек (полнее) + всё, что видели в FBO.
    const barcodes = new Set([...cardsByBarcode.keys()]);
    for (const r of fboRows) if (r.barcode) barcodes.add(String(r.barcode));
    const list = [...barcodes];
    for (const wh of fbsWarehouses) {
      const m = await fetchFbsStocks(wh.id, list);
      fbsStocksByWh.set(wh.id, m);
      log(`  склад «${wh.name}»: позиций с остатком ${m.size}`);
    }
  } catch (err) {
    warnings.push(`FBS недоступен (${err.message}). Остатки FBS показаны как 0.`);
    log('  ⚠ ' + warnings[warnings.length - 1]);
  }

  const report = buildStockSummary({ fboRows, fbsWarehouses, fbsStocksByWh, cardsByBarcode });
  report.warnings = warnings;
  return report;
}

/** Собирает отчёт из фикстуры (для --dry-run и тестов, без сети). */
export function collectFromFixture(fixture) {
  const fbsStocksByWh = new Map(
    Object.entries(fixture.fbsStocksByWh || {}).map(([whId, obj]) => [
      Number(whId),
      new Map(Object.entries(obj).map(([bc, amt]) => [String(bc), Number(amt)])),
    ])
  );
  const cardsByBarcode = new Map(
    Object.entries(fixture.cardsByBarcode || {}).map(([bc, info]) => [String(bc), info])
  );
  const report = buildStockSummary({
    fboRows: fixture.fboRows || [],
    fbsWarehouses: fixture.fbsWarehouses || [],
    fbsStocksByWh,
    cardsByBarcode,
    generatedAt: fixture.generatedAt,
  });
  report.warnings = [];
  return report;
}

export function writeOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const date = (report.generatedAt || new Date().toISOString()).slice(0, 10);
  const base = `wb-stock-${date}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, summaryToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { csvPath, jsonPath };
}

function printSummary(report) {
  const t = report.totals;
  console.log('\n=== Сводка по остаткам WB (на текущий момент) ===');
  console.log(`Собрано:            ${report.generatedAt}`);
  console.log(`Артикулов:          ${fmt(t.articles)}`);
  console.log(`FBO доступно:        ${fmt(t.fboAvailable)} шт (всего на складах WB: ${fmt(t.fboFull)})`);
  console.log(`FBS остаток:         ${fmt(t.fbs)} шт`);
  console.log(`Итого доступно:      ${fmt(t.totalAvailable)} шт (FBO+FBS)`);
  console.log(`В пути к клиенту:    ${fmt(t.inWayToClient)} шт`);
  console.log(`В пути от клиента:   ${fmt(t.inWayFromClient)} шт (возвраты)`);

  const top = report.byArticle.slice(0, 10);
  if (top.length) {
    console.log('\nТоп артикулов по доступному остатку:');
    for (const r of top) {
      console.log(`  ${r.seller}\tFBO ${fmt(r.fboAvailable)} + FBS ${fmt(r.fbs)} = ${fmt(r.totalAvailable)}\t→клиенту ${fmt(r.inWayToClient)} / ←возврат ${fmt(r.inWayFromClient)}`);
    }
  }
  if (report.warnings?.length) {
    console.log('\n⚠ Предупреждения:');
    for (const w of report.warnings) console.log('   • ' + w);
  }
}

// Запуск как самостоятельного скрипта.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryIdx = args.indexOf('--dry-run');
  const run = dryIdx >= 0
    ? Promise.resolve(collectFromFixture(JSON.parse(fs.readFileSync(args[dryIdx + 1], 'utf8'))))
    : collectWbStock();

  run
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
