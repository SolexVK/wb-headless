// report-fire-losses.mjs — оценка потерь товара от пожаров/атак на складах WB.
//
// Идея (по договорённости с продавцом):
//   1. Берём список сгоревших/атакованных складов из config/fire-warehouses.json
//      (составлен по новостям об атаках БПЛА, июль 2026).
//   2. Тянем отчёт об остатках на складах WB (/api/v1/warehouse_remains) с
//      разбивкой по артикулам (groupByNm).
//   3. Суммируем остатки, лежащие ИМЕННО на сгоревших складах, по каждому
//      артикулу — это и есть количество утраченного товара.
//   4. Умножаем количество на среднюю себестоимость (по умолчанию 620 ₽) и
//      получаем сумму убытков.
//
// ⚠️ ВАЖНО ПРО МЕТОДИКУ. warehouse_remains — это СНИМОК ОСТАТКОВ НА СЕЙЧАС.
//    После пожара WB со временем обнуляет/списывает сгоревший товар, поэтому
//    запрос «сегодня» может недосчитать потери или вернуть 0 по складу. Корректно
//    считать по снимку, снятому ДО пожара. Если такого снимка нет — текущий отчёт
//    даёт нижнюю оценку, и чем позже он снят, тем сильнее занижает. Дату снимка
//    раннер фиксирует в выходных файлах.
//
// Запуск:
//   WB_API_TOKEN=xxx node report-fire-losses.mjs
//   WB_API_TOKEN=xxx node report-fire-losses.mjs --cost 700
//   WB_API_TOKEN=xxx node report-fire-losses.mjs --warehouses "Электросталь,Подольск"
//
// Результат: reports-output/fire-losses-<timestamp>.{csv,json} + сводка в консоль.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './lib/wbClient.js';
import { resolveWbToken, resolveTokenType, maskToken } from './lib/wbToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Конфиг ────────────────────────────────────────────────────────────────
function loadConfig() {
  const file = path.join(__dirname, 'config', 'fire-warehouses.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cost') out.cost = Number(argv[++i]);
    else if (a === '--warehouses') out.warehouses = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

/** Совпадение имени склада с одним из паттернов (подстрока, без регистра). */
function matchWarehouse(name, patterns) {
  const n = String(name || '').toLowerCase();
  return patterns.some((p) => n.includes(String(p).toLowerCase()));
}

// Синтетические строки отчёта — это НЕ физические склады, их не считаем.
const AGGREGATE_PREFIXES = ['всего', 'в пути'];
const isAggregateRow = (name) => {
  const n = String(name || '').toLowerCase().trim();
  return AGGREGATE_PREFIXES.some((p) => n.startsWith(p));
};

// ── Отчёт об остатках (async task: create → status → download) ──────────────
async function fetchWarehouseRemains(wb) {
  // 1) Создать задание. Лимит метода: 1 запрос/мин, всплеск 5.
  const create = await wb.get('analytics', '/api/v1/warehouse_remains', {
    query: {
      locale: 'ru',
      groupByNm: true, // разбивка по артикулам WB (nmId)
      groupBySa: true, // + артикул продавца (vendorCode)
      groupByBrand: true,
      groupBySubject: true,
    },
    methodLimit: { limit: 1, periodSec: 60, burst: 5 },
  });
  const taskId = create.data?.data?.taskId;
  if (!taskId) throw new Error('Не получили taskId при создании отчёта об остатках');
  log(`  задание создано: ${taskId}`);

  // 2) Дождаться готовности. Лимит статуса: 1 запрос/5 сек, всплеск 5.
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Таймаут ожидания готовности отчёта (5 мин)');
    await sleep(6000);
    const st = await wb.get('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/status`, {
      methodLimit: { limit: 1, periodSec: 5, burst: 5 },
    });
    const status = st.data?.data?.status;
    log(`  статус: ${status}`);
    if (status === 'done') break;
    if (status === 'canceled' || status === 'purged' || status === 'error') {
      throw new Error(`Отчёт не сформирован, статус: ${status}`);
    }
  }

  // 3) Скачать. Возвращается массив позиций.
  const dl = await wb.get('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/download`, {
    methodLimit: { limit: 1, periodSec: 5, burst: 5 },
  });
  if (!Array.isArray(dl.data)) throw new Error('Ожидали массив в ответе download');
  return dl.data;
}

// ── Основной расчёт ─────────────────────────────────────────────────────────
function computeLosses(items, patterns) {
  const seenWarehouses = new Map(); // имя склада → суммарный qty (для калибровки)
  const perArticle = [];
  let totalQty = 0;

  for (const it of items) {
    const whs = Array.isArray(it.warehouses) ? it.warehouses : [];
    let qtyOnBurned = 0;
    const hitWarehouses = [];

    for (const w of whs) {
      const name = w.warehouseName;
      if (isAggregateRow(name)) continue;
      const qty = Number(w.quantity) || 0;
      seenWarehouses.set(name, (seenWarehouses.get(name) || 0) + qty);
      if (matchWarehouse(name, patterns)) {
        qtyOnBurned += qty;
        if (qty > 0) hitWarehouses.push(`${name}:${qty}`);
      }
    }

    if (qtyOnBurned > 0) {
      perArticle.push({
        nmId: it.nmId,
        vendorCode: it.vendorCode,
        brand: it.brand,
        subjectName: it.subjectName,
        techSize: it.techSize,
        barcode: it.barcode,
        qtyLost: qtyOnBurned,
        warehouses: hitWarehouses.join('; '),
      });
      totalQty += qtyOnBurned;
    }
  }

  perArticle.sort((a, b) => b.qtyLost - a.qtyLost);
  return { perArticle, totalQty, seenWarehouses };
}

function toCSV(rows, costRub) {
  const head = ['nmId', 'vendorCode', 'brand', 'subjectName', 'techSize', 'barcode', 'qtyLost', 'costRub', 'lossRub', 'warehouses'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([
      r.nmId, r.vendorCode, r.brand, r.subjectName, r.techSize, r.barcode,
      r.qtyLost, costRub, r.qtyLost * costRub, r.warehouses,
    ].map(esc).join(';'));
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const costRub = Number(args.cost) || Number(cfg.avgCostRub) || 620;
  const patterns = args.warehouses
    ? args.warehouses.split(',').map((s) => s.trim()).filter(Boolean)
    : cfg.patterns;

  log('── Оценка потерь от пожаров на складах WB ──');
  log(`  склады (паттерны): ${patterns.join(', ')}`);
  log(`  средняя себестоимость: ${costRub} ₽`);

  const { token, source } = resolveWbToken();
  if (!token) {
    log('✗ Нет токена WB API. Задайте WB_API_TOKEN (или .env). Прерываю.');
    process.exit(2);
  }
  log(`  токен: ${maskToken(token)} (${source})`);

  if (args.dryRun) { log('  --dry-run: сеть не трогаю, выходим.'); return; }

  const wb = new WbClient({ token, tokenType: resolveTokenType() });
  log('  запрашиваю отчёт об остатках (может занять до нескольких минут)…');
  const items = await fetchWarehouseRemains(wb);
  log(`  позиций в отчёте: ${items.length}`);

  const { perArticle, totalQty, seenWarehouses } = computeLosses(items, patterns);

  // Калибровка: какие имена складов реально встретились (топ по остаткам).
  const whList = [...seenWarehouses.entries()].sort((a, b) => b[1] - a[1]);
  log('\n  Встреченные склады (warehouseName → суммарный остаток):');
  for (const [name, qty] of whList) {
    const hit = matchWarehouse(name, patterns) ? ' ← СГОРЕВШИЙ' : '';
    log(`    ${qty}\t${name}${hit}`);
  }

  const totalLoss = totalQty * costRub;
  const snapshotAt = new Date().toISOString();

  log('\n── ИТОГ ──');
  log(`  снимок остатков снят: ${snapshotAt}`);
  log(`  артикулов с потерями: ${perArticle.length}`);
  log(`  всего единиц утрачено: ${totalQty}`);
  log(`  средняя себестоимость: ${costRub} ₽`);
  log(`  СУММА УБЫТКОВ: ${totalLoss.toLocaleString('ru-RU')} ₽`);
  log('  ⚠️ Это оценка по ТЕКУЩИМ остаткам. Если товар уже списан после пожара —');
  log('     цифра занижена; корректно считать по снимку остатков ДО пожара.');

  // Файлы.
  const outDir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = snapshotAt.replace(/[:.]/g, '-');
  const base = path.join(outDir, `fire-losses-${stamp}`);
  const summary = {
    snapshotAt, costRub, patterns,
    articlesWithLosses: perArticle.length,
    totalQtyLost: totalQty,
    totalLossRub: totalLoss,
    method: 'warehouse_remains (live snapshot) × avg cost; lower-bound after write-offs',
    warehousesSeen: Object.fromEntries(whList),
    articles: perArticle.map((r) => ({ ...r, costRub, lossRub: r.qtyLost * costRub })),
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(`${base}.csv`, toCSV(perArticle, costRub));
  log(`\n  сохранено: ${base}.json / .csv`);
}

main().catch((e) => {
  log(`✗ ${e.message}`);
  process.exit(1);
});
