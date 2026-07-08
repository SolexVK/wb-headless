// scripts/wb-unit-calc.mjs — CLI Юнит-калькулятора [4] для товаров на Wildberries.
// Логика — в lib/wbUnitCalc.js (то же ядро юнит-экономики, что в блоке C движка [3]).
//
// Модель (подтверждена пользователем): S — цена продавца без СПП, P — витрина с СПП,
// P = S·(1−СПП). Комиссия от S; эквайринг/налог/ДРР от P; брак от себестоимости;
// логистика+хранение — индивидуальны (0 по умолчанию). Маржа = опер. прибыль / S.
//
// Параметры:
//   --cost 536               себестоимость C, ₽ (ОБЯЗАТЕЛЬНО)
//   --price 2400             витринная цена P (с СПП). Либо --seller-price S (без СПП).
//   --seller-price 2500      цена продавца без СПП (альтернатива --price)
//   --nm 167477208           подтянуть витринную цену по артикулу (MPStats, нужен MPSTATS_TOKEN)
//   --period 30              период для --nm (дней; берём последнюю известную цену)
//
//   # переопределение ставок (в ПРОЦЕНТАХ; дефолты — подтверждённая модель):
//   --commission 35.7  --spp 4  --acquiring 4.7  --tax 2
//   --drr 8            текущий ДРР для основной раскладки (дефолт — «выход» 8%)
//   --drr-launch 30    ДРР фазы запуска
//   --defect 2.5       брак, % от себестоимости
//   --m-min 25 --m-max 30      целевой коридор маржи, %
//   --logistics 0 --storage 0  ₽/ед (если условия не индивидуальные)
//
//   # обратный расчёт (опционально):
//   --target-margin 28         → витринная цена под маржу 28%
//   --target-profit 400        → витринная цена под опер. прибыль 400 ₽/ед
//
//   --units 300                прогноз заработка на N проданных единиц
//
//   # вывод:
//   --json                     JSON вместо текста
//   --html [path]              HTML-отчёт (авто-имя, если без пути)
//   --pdf  [path]              PDF-отчёт (Chromium; авто-имя, если без пути)
//
// Примеры:
//   node scripts/wb-unit-calc.mjs --cost 536 --price 2400
//   node scripts/wb-unit-calc.mjs --cost 536 --price 2400 --target-margin 28 --units 300 --html
//   MPSTATS_TOKEN=xxx node scripts/wb-unit-calc.mjs --cost 536 --nm 167477208

import { analyze, econParams, formatText, formatHtml } from '../lib/wbUnitCalc.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const n = argv[i + 1];
  opt[k] = n && !n.startsWith('--') ? (i++, n) : true;
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const num = (v) => (v == null || v === true ? undefined : Number(String(v).replace(',', '.')));
const pct = (v) => { const n = num(v); return n == null ? undefined : n / 100; }; // % → доля

if (opt.help || opt.h) {
  log('Юнит-калькулятор WB. Обязателен --cost. Цена: --price (витрина с СПП) или --seller-price или --nm.');
  log('Пример: node scripts/wb-unit-calc.mjs --cost 536 --price 2400 --target-margin 28 --units 300 --html');
  process.exit(0);
}

const cost = num(opt.cost);
if (cost == null || !(cost > 0)) {
  log('Не задана себестоимость. Пример:');
  log('  node scripts/wb-unit-calc.mjs --cost 536 --price 2400');
  process.exit(2);
}

// Параметры модели: дефолты + переопределения (проценты → доли).
const pr = econParams({
  commission: pct(opt.commission),
  spp: pct(opt.spp),
  acquiring: pct(opt.acquiring),
  tax: pct(opt.tax),
  drr_launch: pct(opt['drr-launch']),
  defect: pct(opt.defect),
  m_min: pct(opt['m-min']),
  m_max: pct(opt['m-max']),
  logistics: num(opt.logistics),
  storage: num(opt.storage),
});

// Витринная цена: --price | --seller-price | --nm (MPStats).
let price = num(opt.price);
let sellerPrice = num(opt['seller-price']);
let subtitle = '';

if (price == null && sellerPrice == null && opt.nm) {
  const nm = String(opt.nm);
  try {
    const { fetchItemDailySales } = await import('../lib/mpstats.js');
    const days = Number(opt.period) || 30;
    const day = 86400000;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const d2 = iso(Date.now() - day);
    const d1 = iso(Date.now() - (days + 1) * day);
    log(`Тяну цену по артикулу ${nm} из MPStats (${d1}…${d2})…`);
    const rows = await fetchItemDailySales(nm, d1, d2);
    const withPrice = rows.filter((r) => r.price > 0);
    if (!withPrice.length) throw new Error('MPStats не отдал цену по этому артикулу за период');
    price = withPrice[withPrice.length - 1].price; // последняя известная цена — это витрина (с СПП)
    subtitle = `Артикул ${nm} · витринная цена из MPStats ${Math.round(price)} ₽`;
    log(`  цена: ${Math.round(price)} ₽ (последняя из ${withPrice.length} дней с ценой)`);
  } catch (err) {
    log(`Не удалось подтянуть цену по --nm: ${err?.message || err}`);
    if (/MPSTATS_TOKEN/.test(String(err?.message))) log('Задай MPSTATS_TOKEN (заголовок X-Mpstats-TOKEN).');
    process.exit(1);
  }
}

const res = analyze({
  price,
  sellerPrice,
  cost,
  pr,
  drr: pct(opt.drr),
  targetMargin: pct(opt['target-margin']),
  targetProfit: num(opt['target-profit']),
  units: num(opt.units),
});

const meta = { subtitle };

// Вывод.
if (opt.json) {
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
} else {
  process.stdout.write(formatText(res, meta) + '\n');
}

if (opt.html) {
  const path = typeof opt.html === 'string' ? opt.html : reportPath('html');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatHtml(res, meta));
  log(`HTML-отчёт: ${path}`);
}

if (opt.pdf) {
  const path = typeof opt.pdf === 'string' ? opt.pdf : reportPath('pdf');
  try {
    const { htmlToPdf } = await import('../lib/htmlToPdf.js');
    mkdirSync(dirname(path), { recursive: true });
    log('Рендерю PDF (Chromium)…');
    await htmlToPdf(formatHtml(res, meta), path);
    log(`[pdf] отчёт → ${path}`);
  } catch (err) {
    log(`PDF не собран: ${err?.message || err}`);
    log('Нужен Playwright/Chromium (npm install). HTML-версия доступна через --html.');
    process.exit(1);
  }
}

// reports-output/unit-calc_<цена>x<C>_<дата>.<ext>
function reportPath(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const tag = `${Math.round(res.input.price || 0)}x${Math.round(res.input.cost)}`;
  return `reports-output/unit-calc_${tag}_${date}.${ext}`;
}
