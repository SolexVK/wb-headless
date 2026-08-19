// scripts/wb-fines-attribution.mjs — привязка строк штрафов из Excel к фулфилменту.
//
// Вход: выгрузка «Детализация к отчёту о реализации» из ЛК WB (xlsx), отфильтрованная
// по строкам штрафов («Обоснование для оплаты» = «Штраф»).
//
// Что делает:
//   1. Читает книгу, распознаёт колонки по названиям шапки (не по номерам —
//      WB меняет порядок колонок между версиями выгрузки).
//   2. Классифицирует каждую строку: FBS-штраф (есть «Номер сборочного задания»)
//      или FBW-штраф (есть «Номер поставки»).
//   3. FBS: GET /api/v3/orders за окно дат заказов → warehouseId → имя нашего
//      склада-фулфилмента из GET /api/v3/warehouses. Это точная атрибуция.
//   4. FBW: GET /api/v1/supplies/{ID} (supplies-api) → склад приёмки WB,
//      supplierAssignName (кто отгружал), даты и объём поставки.
//   5. Печатает разбор по строкам и сводку по фулфилментам, кладёт результат
//      в JSON и (опционально) в xlsx.
//
// Лимиты соблюдаются через lib/wbClient.js:
//   /api/v3/orders, /api/v3/warehouses — категория Маркетплейс, 300/мин, всплеск 20,
//     окно ≤30 дней одним запросом, глубина ≤3 месяцев;
//   /api/v1/supplies/{ID}  — категория Поставки, 30/мин, интервал 2 с, всплеск 10.
//
// Запуск:
//   node scripts/wb-fines-attribution.mjs <файл.xlsx> [--out каталог]
//   npm run fines:attr -- <файл.xlsx>

import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { WbClient } from '../lib/wbClient.js';

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--'));
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : 'reports-output';
// На сколько дней назад от самой ранней даты заказа тянуть сборочные задания.
// «Дата заказа покупателем» в детализации не всегда равна дате создания задания:
// встречаются штрафы по заданиям, созданным на 1–2 недели раньше. Глубина метода
// /api/v3/orders — 3 месяца, дальше он данные не отдаёт.
const lbIdx = argv.indexOf('--lookback');
const LOOKBACK_DAYS = Math.min(85, Math.max(2, lbIdx >= 0 ? Number(argv[lbIdx + 1]) || 45 : 45));

if (!src) {
  console.error('Укажите путь к xlsx: node scripts/wb-fines-attribution.mjs <файл.xlsx>');
  process.exit(1);
}

// ── Колонки выгрузки WB. Ищем по названию шапки, чтобы не зависеть от порядка. ──
const COLS = {
  num: '№',
  supply: 'Номер поставки',
  subject: 'Предмет',
  nmId: 'Код номенклатуры',
  brand: 'Бренд',
  vendorCode: 'Артикул поставщика',
  title: 'Название',
  size: 'Размер',
  barcode: 'Баркод',
  reason: 'Обоснование для оплаты',
  orderDate: 'Дата заказа покупателем',
  saleDate: 'Дата продажи',
  penalty: 'Общая сумма штрафов',
  type: 'Виды логистики, штрафов и корректировок ВВ',
  sticker: 'Стикер МП',
  officeId: 'Номер офиса',
  officeName: 'Наименование офиса доставки',
  warehouse: 'Склад',
  country: 'Страна',
  assemblyId: 'Номер сборочного задания',
  shkId: 'ШК',
  srid: 'Srid',
};

function readFines(file) {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const head = grid[0].map((h) => (h == null ? '' : String(h).trim()));
  const idx = {};
  for (const [key, title] of Object.entries(COLS)) {
    const i = head.indexOf(title);
    if (i >= 0) idx[key] = i;
  }
  const missing = ['type', 'penalty'].filter((k) => idx[k] == null);
  if (missing.length) throw new Error(`В книге нет колонок: ${missing.map((k) => COLS[k]).join(', ')}`);

  const rows = [];
  for (const r of grid.slice(1)) {
    if (!r || !r.some((v) => v !== null && v !== '')) continue;
    const o = {};
    for (const [key, i] of Object.entries(idx)) o[key] = r[i];
    // Штрафами считаем строки с ненулевой суммой штрафа либо помеченные «Штраф».
    const pen = Number(o.penalty) || 0;
    if (!pen && String(o.reason || '').toLowerCase() !== 'штраф') continue;
    o.penalty = pen;
    rows.push(o);
  }
  return rows;
}

const dayUTC = (s) => {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 : null;
};
const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;

// ── Сборочные задания FBS за окно (чанки ≤30 дней, пагинация next). ────────────
async function fetchOrders(wb, fromSec, toSec) {
  const CHUNK = 28 * 86400;
  const byId = new Map();
  for (let end = toSec; end > fromSec; ) {
    const start = Math.max(fromSec, end - CHUNK);
    let next = 0;
    for (let p = 1; ; p++) {
      const { data } = await wb.get('marketplace', '/api/v3/orders', {
        query: { limit: 1000, next, dateFrom: start, dateTo: end },
      });
      const batch = data.orders || [];
      for (const o of batch) {
        byId.set(String(o.id), o);
        if (o.rid) byId.set('rid:' + String(o.rid), o);   // запасной ключ: srid из отчёта
      }
      process.stderr.write(`  orders ${iso(start)}..${iso(end)} стр.${p}: +${batch.length} (всего ${byId.size})\n`);
      if (batch.length < 1000 || data.next == null || data.next === next) break;
      next = data.next;
    }
    end = start;
  }
  return byId;
}

// ── Детали поставок FBW. Лимит метода — 30/мин с интервалом 2 с; на практике
// сервер отдаёт 429 уже при всплеске 10, поэтому идём без всплеска — строго по интервалу 2 с (клиент всё
// равно отработает 429 по X-Ratelimit-Retry, но лучше до него не доводить).
// Ответы кэшируются на диск: поставка неизменна, повторно её дёргать незачем.
const CACHE_DIR = path.join('.cache', 'wb-supplies');
async function fetchSupplies(wb, ids) {
  const map = new Map();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const id of ids) {
    const cached = path.join(CACHE_DIR, `${id}.json`);
    if (fs.existsSync(cached)) {
      const data = JSON.parse(fs.readFileSync(cached, 'utf8'));
      map.set(String(id), data);
      process.stderr.write(`  поставка ${id}: ${data.warehouseName || '—'} (из кэша)\n`);
      continue;
    }
    try {
      const { data } = await wb.get('supplies', `/api/v1/supplies/${id}`, {
        methodLimit: { limit: 30, periodSec: 60, burst: 1 },
      });
      map.set(String(id), data);
      fs.writeFileSync(cached, JSON.stringify(data, null, 2));
      process.stderr.write(`  поставка ${id}: ${data.warehouseName || '—'} · ${data.supplierAssignName || '—'}\n`);
    } catch (e) {
      process.stderr.write(`  поставка ${id}: ! ${e.status || ''} ${e.message}\n`);
      map.set(String(id), { _error: e.message, _status: e.status || null });
    }
  }
  return map;
}

// ── main ──────────────────────────────────────────────────────────────────────
const fines = readFines(src);
console.log(`Файл: ${path.basename(src)}`);
console.log(`Строк штрафов: ${fines.length} · сумма: ${r2(fines.reduce((s, f) => s + f.penalty, 0))} ₽\n`);

const wb = new WbClient({ tokenType: 'personal' });

// Наши склады-фулфилменты.
const { data: whList } = await wb.get('marketplace', '/api/v3/warehouses');
const ffName = new Map((whList || []).map((w) => [String(w.id), w.name]));
// Закрытые склады продавца в живом ответе не приходят, но встречаются в старых
// сборочных заданиях — без справочника они выглядели бы как «склад 1897513».
try {
  const retired = JSON.parse(fs.readFileSync(new URL('../config/warehouses-retired.json', import.meta.url), 'utf8'));
  for (const [id, name] of Object.entries(retired.warehouses || {})) if (!ffName.has(id)) ffName.set(id, name);
} catch { /* справочника нет — не критично */ }
console.log(`Наши фулфилменты (${whList.length}): ${whList.map((w) => w.name).join(', ')}\n`);

// Что нужно добрать.
const needOrders = fines.filter((f) => f.assemblyId);
const supplyIds = [...new Set(fines.filter((f) => Number(f.supply) > 0).map((f) => String(f.supply)))];

let orders = new Map();
if (needOrders.length) {
  const days = needOrders.map((f) => dayUTC(f.orderDate)).filter(Boolean);
  const from = Math.min(...days) - LOOKBACK_DAYS * 86400;
  const to = Math.max(...days) + 2 * 86400;
  console.log(`Сборочные задания FBS за ${iso(from)}..${iso(to)}:`);
  orders = await fetchOrders(wb, from, to);
  console.log();
}

// Реестр «поставка → фулфилмент» (наш, WB его не знает).
let supplyFf = new Map();
try {
  const reg = JSON.parse(fs.readFileSync(new URL('../config/supply-fulfilment.json', import.meta.url), 'utf8'));
  supplyFf = new Map(Object.entries(reg.map || {}));
  if (supplyFf.size) console.log(`Реестр поставка→ФФ: ${supplyFf.size} записей\n`);
} catch { /* реестра нет */ }

let supplies = new Map();
if (supplyIds.length) {
  console.log(`Поставки FBW (${supplyIds.length}):`);
  supplies = await fetchSupplies(wb, supplyIds);
  console.log();
}

// ── Атрибуция ────────────────────────────────────────────────────────────────
const out = fines.map((f) => {
  const res = {
    ...f,
    channel: null,        // FBS | FBW | ?
    ff: null,             // наш фулфилмент
    ffId: null,
    sender: null,         // юрлицо-отправитель поставки (не фулфилмент!)
    wbWarehouse: null,    // склад/СЦ WB из строки отчёта (где произошла операция)
    supplyDropOff: null,  // куда физически сдавали поставку (транзит/факт приёмки)
    supplyDest: null,     // склад назначения поставки
    supplyInfo: null,
    method: null,         // как определили
    confidence: null,     // точно | вероятностно | не определено
  };

  if (f.assemblyId) {
    const byAssembly = orders.get(String(f.assemblyId));
    const bySrid = f.srid ? orders.get('rid:' + String(f.srid)) : null;
    const o = byAssembly || bySrid;
    res.channel = 'FBS';
    res.wbWarehouse = f.warehouse || null;
    if (o) {
      res.ffId = o.warehouseId;
      res.ff = ffName.get(String(o.warehouseId)) || `склад ${o.warehouseId}`;
      res.method = byAssembly
        ? 'Номер сборочного задания → GET /api/v3/orders → warehouseId'
        : 'Srid → rid сборочного задания → GET /api/v3/orders → warehouseId';
      res.confidence = 'точно';
      res.orderCreatedAt = o.createdAt;
      res.orderSupplyId = o.supplyId;
      res.orderOffices = (o.offices || []).join(', ');
    } else {
      res.method = `Сборочное задание не найдено в /api/v3/orders (искали за ${LOOKBACK_DAYS} дн. до даты заказа; глубина метода ≤3 мес)`;
      res.confidence = 'не определено';
    }
    return res;
  }

  if (Number(f.supply) > 0) {
    const s = supplies.get(String(f.supply));
    res.channel = 'FBW';
    if (s && !s._error) {
      res.wbWarehouse = f.warehouse || null;                       // из строки отчёта
      // У транзитных поставок склад сдачи и склад назначения различаются:
      // warehouseName — назначение, transit/actualWarehouseName — куда сдавали.
      res.supplyDropOff = s.transitWarehouseName || s.actualWarehouseName || s.warehouseName || null;
      res.supplyDest = s.warehouseName || null;
      // supplierAssignName — юрлицо-отправитель поставки, а НЕ фулфилмент: у всех
      // поставок продавца оно, как правило, одно. Кто физически собрал поставку,
      // WB не хранит — это наши данные (см. docs/wb-api/penalties-to-fulfillment.md).
      res.sender = s.supplierAssignName || null;
      const fromReg = supplyFf.get(String(f.supply));
      res.ff = fromReg || null;
      res.method = fromReg
        ? 'Номер поставки → реестр config/supply-fulfilment.json; склад приёмки — GET /api/v1/supplies/{ID}'
        : 'Номер поставки → GET /api/v1/supplies/{ID} → склад приёмки WB; ФФ отгрузки в API нет';
      res.confidence = fromReg ? 'точно (по реестру)' : 'ФФ не определён (нужен реестр поставка→ФФ)';
      res.supplyInfo = {
        warehouseID: s.warehouseID,
        warehouseName: s.warehouseName,
        actualWarehouseName: s.actualWarehouseName,
        supplierAssignName: s.supplierAssignName,
        createDate: s.createDate,
        supplyDate: s.supplyDate,
        factDate: s.factDate,
        quantity: s.quantity,
        acceptedQuantity: s.acceptedQuantity,
        boxTypeID: s.boxTypeID,
      };
    } else {
      res.method = `Поставка не получена из API${s?._status ? ` (${s._status})` : ''}`;
      res.confidence = 'не определено';
    }
    return res;
  }

  res.channel = '?';
  res.method = 'В строке нет ни номера сборочного задания, ни номера поставки';
  res.confidence = 'не определено';
  return res;
});

// ── Вывод ────────────────────────────────────────────────────────────────────
const money = (x) => r2(x).toFixed(2).padStart(9);

console.log('== Разбор по строкам ==');
for (const r of out) {
  console.log(
    `#${String(r.num ?? '').padEnd(6)} ${String(r.channel).padEnd(4)} ${money(r.penalty)} ₽  ` +
    `${String(r.ff ?? '—').padEnd(22)} ${String(r.wbWarehouse ?? '—').padEnd(28)} ` +
    `${String(r.type ?? '').slice(0, 52)}`
  );
}

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const v = m.get(k) || { n: 0, sum: 0 };
    v.n += 1; v.sum += r.penalty;
    m.set(k, v);
  }
  return [...m.entries()].sort((a, b) => b[1].sum - a[1].sum);
}

console.log('\n== Сводка: по фулфилментам (FBS — точная атрибуция) ==');
for (const [k, v] of group(out.filter((r) => r.channel === 'FBS'), (r) => r.ff || '— не определён —'))
  console.log(`  ${String(k).padEnd(26)} ${String(v.n).padStart(3)} шт  ${money(v.sum)} ₽`);

const fbw = out.filter((r) => r.channel === 'FBW');
if (fbw.length) {
  console.log('\n== FBW: фулфилмент отгрузки в API отсутствует ==');
  console.log('   WB хранит только склад приёмки и юрлицо-отправителя. Чтобы закрыть');
  console.log('   атрибуцию, нужен реестр «номер поставки → фулфилмент». Поставки из выгрузки:');
  const bySupply = new Map();
  for (const r of fbw) {
    const k = String(r.supply);
    const v = bySupply.get(k) || { n: 0, sum: 0, wh: r.supplyDropOff, dest: r.supplyDest, sender: r.sender, fact: r.supplyInfo?.factDate, qty: r.supplyInfo?.acceptedQuantity };
    v.n += 1; v.sum += r.penalty;
    bySupply.set(k, v);
  }
  for (const [k, v] of [...bySupply.entries()].sort((a, b) => b[1].sum - a[1].sum))
    console.log(`   поставка ${k.padEnd(10)} ${String(v.n).padStart(2)} шт  ${money(v.sum)} ₽  сдана: ${String(v.wh || '—').padEnd(26)} назначение: ${String(v.dest || '—').padEnd(26)} принята ${String(v.fact || '—').slice(0, 10)}  ${String(v.qty ?? '—').padStart(5)} шт`);
  console.log('\n== Сводка FBW: по складу сдачи поставки ==');
  for (const [k, v] of group(fbw, (r) => r.supplyDropOff || '—'))
    console.log(`  ${String(k).padEnd(32)} ${String(v.n).padStart(3)} шт  ${money(v.sum)} ₽`);
}

console.log('\n== Сводка: по типам штрафа ==');
for (const [k, v] of group(out, (r) => r.type || '—'))
  console.log(`  ${String(k).slice(0, 56).padEnd(58)} ${String(v.n).padStart(3)} шт  ${money(v.sum)} ₽`);

console.log('\n== Сводка: по каналу ==');
for (const [k, v] of group(out, (r) => r.channel))
  console.log(`  ${String(k).padEnd(6)} ${String(v.n).padStart(3)} шт  ${money(v.sum)} ₽`);

console.log('\n== Сводка: по уверенности атрибуции ==');
for (const [k, v] of group(out, (r) => r.confidence))
  console.log(`  ${String(k).padEnd(16)} ${String(v.n).padStart(3)} шт  ${money(v.sum)} ₽`);

// ── Файлы ────────────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, 'fines-attribution');
fs.writeFileSync(base + '.json', JSON.stringify(out, null, 2));

const sheet = out.map((r) => ({
  '№': r.num,
  'Канал': r.channel,
  'Фулфилмент (наш склад)': r.ff ?? '',
  'Отправитель поставки': r.sender ?? '',
  'Склад WB (из отчёта)': r.wbWarehouse ?? '',
  'Поставка: сдана на склад': r.supplyDropOff ?? '',
  'Поставка: склад назначения': r.supplyDest ?? '',
  'Тип штрафа': r.type ?? '',
  'Сумма штрафа, ₽': r.penalty,
  'Дата продажи': r.saleDate ?? '',
  'Дата заказа': r.orderDate ?? '',
  'Код номенклатуры': r.nmId ?? '',
  'Артикул поставщика': r.vendorCode ?? '',
  'Размер': r.size ?? '',
  'Баркод': r.barcode ?? '',
  'ШК': r.shkId ?? '',
  'Srid': r.srid ?? '',
  'Номер сборочного задания': r.assemblyId ?? '',
  'Номер поставки': Number(r.supply) > 0 ? r.supply : '',
  'Поставка: принята': r.supplyInfo?.factDate ?? '',
  'Поставка: кол-во': r.supplyInfo?.acceptedQuantity ?? '',
  'Как определён ФФ': r.method ?? '',
  'Уверенность': r.confidence ?? '',
}));
// Шаблон реестра для поставок, у которых ФФ ещё не проставлен.
const needReg = [...new Set(out.filter((r) => r.channel === 'FBW' && !r.ff).map((r) => String(r.supply)))];
if (needReg.length) {
  const tpl = { _comment: 'Проставьте название фулфилмента напротив каждой поставки и перенесите блок map в config/supply-fulfilment.json', map: {} };
  for (const id of needReg) {
    const s2 = supplies.get(id) || {};
    tpl.map[id] = '';
    tpl[`_${id}`] = `приёмка: ${s2.actualWarehouseName || s2.warehouseName || '—'}, принята ${String(s2.factDate || '—').slice(0, 10)}, ${s2.acceptedQuantity ?? '—'} шт`;
  }
  fs.writeFileSync(path.join(outDir, 'supply-fulfilment.template.json'), JSON.stringify(tpl, null, 2));
  console.log(`\nШаблон реестра для ${needReg.length} поставок → ${path.join(outDir, 'supply-fulfilment.template.json')}`);
}

const bookOut = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(bookOut, XLSX.utils.json_to_sheet(sheet), 'Штрафы по ФФ');
XLSX.writeFile(bookOut, base + '.xlsx');

console.log(`\nРезультат: ${base}.xlsx · ${base}.json`);
