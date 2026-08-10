// scripts/fbs-pdf.mjs — печатный PDF-отчёт FBS (A4 альбомная).
//
// Собирает print-вёрстку из снимков и рендерит в PDF встроенным Chromium.
//   reports-output/fbs-stock.json + fbs-orders-retro.json  →  reports-output/fbs-report.pdf
//
//   npm run fbs:pdf
//
// Верстка заточена под печать: светлая тема, фиксированные ширины колонок
// (table-layout:fixed), контроль разрывов страниц (page-break-inside:avoid),
// чтобы столбцы/поля/блоки не налезали на свои и соседние границы.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);

const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const retro = JSON.parse(fs.readFileSync(R('fbs-orders-retro.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const fmtH = (h) => (h >= 24 ? (h / 24).toFixed(1) + ' сут' : (+h).toFixed(1) + ' ч');

// Свести склады (остатки + поток) по warehouseId.
const wh = new Map();
for (const s of stock.warehouses || []) wh.set(s.id, { id: s.id, name: s.name, stockQty: s.totalQuantity, positions: s.skuInStock, made: 0, processed: 0, avg: 0, median: 0, max: 0, crit: 0, status: { new: 0, confirm: 0, complete: 0, cancel: 0 } });
for (const r of retro.byFulfillment || []) {
  const e = wh.get(r.warehouseId) || { id: r.warehouseId, name: r.name, stockQty: 0, positions: 0 };
  Object.assign(e, { name: e.name || r.name, made: r.made, processed: r.processed, median: r.medianHours, max: r.maxHours, crit: r.criticalCount, status: r.status });
  wh.set(r.warehouseId, e);
}
const whRows = [...wh.values()].sort((a, b) => (b.made - a.made) || (b.stockQty - a.stockQty));

const grandStock = stock.grandTotalQuantity || 0;
const maxStock = Math.max(1, ...whRows.map((w) => w.stockQty));
const st = retro.statusTotals || { new: 0, confirm: 0, complete: 0, cancel: 0 };
const processedPct = pct(retro.processedTotal, retro.ordersTotal);

const STATUS_META = [
  ['complete', 'в доставке', '#0E9E77'],
  ['confirm', 'на сборке', '#C67A08'],
  ['new', 'новые', '#6B7688'],
  ['cancel', 'отменено', '#D6455A'],
];
function stackBar(status, h = 9) {
  const total = STATUS_META.reduce((s, [k]) => s + (status[k] || 0), 0) || 1;
  const segs = STATUS_META.filter(([k]) => status[k] > 0).map(([k, , color]) =>
    `<span style="width:${pct(status[k], total).toFixed(2)}%;background:${color}"></span>`).join('');
  return `<span class="sbar" style="height:${h}px">${segs}</span>`;
}

const kpis = [
  ['штук на FBS', nf(grandStock), 'accent'],
  [`заказов / ${retro.periodDays} дн.`, nf(retro.ordersTotal), ''],
  ['обработано', processedPct.toFixed(0) + '%', ''],
  ['медиана обработки', fmtH(retro.overallMedianHours), ''],
  ['среднее обработки', fmtH(retro.overallAvgHours), ''],
  [`крит. > ${retro.criticalThresholdHours} ч`, nf(retro.critical.length), 'warn'],
].map(([lab, num, cls]) => `<div class="kpi ${cls}"><div class="kpi-num">${num}</div><div class="kpi-lab">${lab}</div></div>`).join('');

const stockRows = (stock.warehouses || []).slice().sort((a, b) => b.totalQuantity - a.totalQuantity).map((s) => `
  <tr>
    <td class="tl">${esc(s.name)}</td>
    <td class="tr num">${nf(s.totalQuantity)}</td>
    <td class="tr num">${nf(s.skuInStock)}</td>
    <td class="tr num">${pct(s.totalQuantity, grandStock).toFixed(1)}%</td>
    <td class="bar-cell"><span class="hbar"><span style="width:${pct(s.totalQuantity, maxStock).toFixed(1)}%"></span></span></td>
  </tr>`).join('');

const flowRows = whRows.map((w) => `
  <tr class="${w.crit > 0 ? 'warn-row' : ''}">
    <td class="tl">${esc(w.name)}</td>
    <td class="tr num">${nf(w.stockQty)}</td>
    <td class="tr num">${nf(w.made)}</td>
    <td class="tr num b">${nf(w.processed)}</td>
    <td class="tr num">${nf(w.status.confirm)}</td>
    <td class="tr num">${nf(w.status.new)}</td>
    <td class="tr num">${nf(w.status.cancel)}</td>
    <td class="bar-cell">${stackBar(w.status)}</td>
    <td class="tr num">${w.median ? fmtH(w.median) : '—'}</td>
    <td class="tr num">${w.max ? fmtH(w.max) : '—'}</td>
    <td class="tr num ${w.crit ? 'crit' : ''}">${w.crit || '—'}</td>
  </tr>`).join('');

const statusTotal = STATUS_META.reduce((s, [k]) => s + st[k], 0) || 1;
const statusLegend = STATUS_META.map(([k, label, color]) =>
  `<div class="lg"><span class="dot" style="background:${color}"></span><span class="lg-lab">${label}</span><span class="lg-num">${nf(st[k])}</span><span class="lg-pct">${pct(st[k], statusTotal).toFixed(1)}%</span></div>`).join('');

const tb = retro.timingBuckets || {};
const tbMeta = [['<6ч', '#0E9E77'], ['6-24ч', '#5A57E6'], ['24-48ч', '#C67A08'], ['>48ч', '#D6455A']];
const tbTotal = Object.values(tb).reduce((a, b) => a + b, 0) || 1;
const timingRows = tbMeta.map(([k, color]) => `
  <div class="crow">
    <div class="clab">${k}</div>
    <div class="ctrack"><div class="cbar" style="width:${pct(tb[k] || 0, tbTotal).toFixed(1)}%;background:${color}"></div></div>
    <div class="cval">${nf(tb[k] || 0)}</div>
  </div>`).join('');

const critRows = (retro.critical || []).slice(0, 16).map((c) => `
  <tr>
    <td class="tr b crit">${fmtH(c.hours)}</td>
    <td class="tl">${esc(c.warehouse)}</td>
    <td class="tl">${esc(c.article)}</td>
    <td class="mono">${esc(c.orderId)}</td>
    <td class="mono">${esc(c.createdAt.slice(0, 16).replace('T', ' '))}</td>
    <td class="mono">${esc(c.closedAt.slice(0, 16).replace('T', ' '))}</td>
  </tr>`).join('');

const topPos = [];
for (const s of stock.warehouses || []) for (const p of (s.positions || []).slice(0, 5)) topPos.push({ wh: s.name, ...p });
topPos.sort((a, b) => b.amount - a.amount);
const topRows = topPos.slice(0, 14).map((p) => `<tr><td class="tl">${esc(p.wh)}</td><td class="tl">${esc(p.vendorCode || p.nmID)}</td><td class="mono">${esc(p.nmID)}</td><td class="tr num b">${nf(p.amount)}</td></tr>`).join('');

const css = `
@page{ size:A4 landscape; margin:9mm; }
*{ box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
html,body{ margin:0; padding:0; }
body{ font-family:"DejaVu Sans","Liberation Sans",Arial,sans-serif; color:#151B26; font-size:9.6pt; line-height:1.4; }
.mono{ font-family:"DejaVu Sans Mono","Liberation Mono",monospace; font-size:8.6pt; color:#3A4353; white-space:nowrap; }
.num{ font-variant-numeric:tabular-nums; } .b{ font-weight:700; } .crit{ color:#C22A40; }
.tl{ text-align:left; } .tr{ text-align:right; }

.page{ page-break-after:always; }
.page:last-child{ page-break-after:auto; }
section, .kpis, table, .card, .row, .crow{ page-break-inside:avoid; }

.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
  border-bottom:2px solid #5A57E6; padding-bottom:9px; margin-bottom:12px; }
.eyebrow{ margin:0 0 3px; font-size:8pt; letter-spacing:.12em; text-transform:uppercase; color:#5A57E6; font-weight:700; }
h1{ margin:0; font-size:16pt; letter-spacing:-.01em; font-weight:700; }
.sub{ margin:4px 0 0; color:#5A6478; font-size:9pt; max-width:180mm; }
.stamp{ text-align:right; font-size:8.6pt; color:#5A6478; white-space:nowrap; line-height:1.5; }
.stamp b{ color:#151B26; }

.kpis{ display:grid; grid-template-columns:repeat(6,1fr); gap:7px; margin-bottom:13px; }
.kpi{ border:1px solid #DCE2EC; border-radius:7px; padding:8px 10px; background:#F7F9FC; }
.kpi.accent{ background:#ECECFB; border-color:#C9C8F2; }
.kpi.warn{ background:#FBE7EB; border-color:#F0C4CD; }
.kpi-num{ font-size:16pt; font-weight:700; letter-spacing:-.02em; line-height:1; font-variant-numeric:tabular-nums; }
.kpi-lab{ margin-top:4px; font-size:8pt; color:#5A6478; }

h2{ margin:0 0 8px; font-size:11pt; font-weight:700; padding-left:8px; border-left:3px solid #5A57E6; }
h2 .muted{ font-weight:400; color:#5A6478; font-size:9pt; }
.section{ margin-bottom:14px; }
.two{ display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start; }

table{ width:100%; border-collapse:collapse; table-layout:fixed; }
thead th{ text-align:left; font-size:7.6pt; text-transform:uppercase; letter-spacing:.03em; color:#6B7488;
  font-weight:700; padding:0 6px 5px; border-bottom:1.5px solid #C6CEDB; }
thead th.tr{ text-align:right; }
tbody td{ padding:5px 6px; border-bottom:1px solid #E6EAF1; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; }
tbody tr:nth-child(even){ background:#F8FAFD; }
.tl{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.warn-row td{ box-shadow:none; }
.warn-row .tl{ border-left:3px solid #D6455A; padding-left:8px; }

/* Ширины колонок сводной таблицы заказов (сумма 100%) */
.flow col.c-name{ width:15%; } .flow col.c-n{ width:8%; } .flow col.c-nn{ width:7%; }
.flow col.c-bar{ width:15%; }
.bar-cell{ padding-top:5px; padding-bottom:5px; }
.sbar{ display:flex; width:100%; border-radius:4px; overflow:hidden; background:#EDEFF4; }
.sbar span{ display:block; }
.hbar{ display:block; width:100%; height:9px; background:#EDEFF4; border-radius:4px; overflow:hidden; }
.hbar span{ display:block; height:100%; background:#5A57E6; border-radius:4px; }

.legend{ display:grid; grid-template-columns:1fr 1fr; gap:7px 16px; margin-top:8px; }
.lg{ display:flex; align-items:center; gap:7px; font-size:9pt; }
.lg .dot{ width:9px; height:9px; border-radius:2px; flex:none; }
.lg-lab{ flex:1; color:#5A6478; }
.lg-num{ font-weight:700; font-variant-numeric:tabular-nums; }
.lg-pct{ color:#8B94A6; font-size:8pt; width:38px; text-align:right; }
.stack-lg{ height:20px; }

.crow{ display:grid; grid-template-columns:52px 1fr 46px; align-items:center; gap:9px; margin-bottom:7px; }
.clab{ font-size:9pt; color:#5A6478; }
.ctrack{ height:18px; background:#EDEFF4; border-radius:5px; overflow:hidden; }
.cbar{ height:100%; border-radius:5px; }
.cval{ text-align:right; font-size:9pt; font-weight:700; font-variant-numeric:tabular-nums; }

.card-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
.note{ margin:8px 0 0; font-size:8.4pt; color:#5A6478; }
.foot{ margin-top:6px; padding-top:7px; border-top:1px solid #DCE2EC; font-size:8pt; color:#6B7488; }
.panel{ border:1px solid #DCE2EC; border-radius:8px; padding:12px 14px; background:#FFFFFF; }
`;

// Колонки сводной таблицы (fixed layout — гарантирует, что не налезут).
const flowCols = `<colgroup>
  <col class="c-name"><col class="c-n"><col class="c-n"><col class="c-n"><col class="c-nn"><col class="c-nn"><col class="c-nn">
  <col class="c-bar"><col class="c-n"><col class="c-n"><col class="c-nn"></colgroup>`;

const body = `
<div class="page">
  <div class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · операционный отчёт</p>
      <h1>FBS: остатки и обработка заказов по фулфилментам</h1>
      <p class="sub">Что лежит на складах продавца сейчас и как за последние ${retro.periodDays} дней обрабатывались заказы каждым фулфилментом.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b><br>период: ${retro.periodDays} дн.</div>
  </div>

  <div class="kpis">${kpis}</div>

  <section class="section">
    <h2>1 · Остатки на складах FBS <span class="muted">— ${nf(stock.barcodeCount)} штрихкодов опрошено</span></h2>
    <table>
      <colgroup><col style="width:26%"><col style="width:14%"><col style="width:14%"><col style="width:12%"><col style="width:34%"></colgroup>
      <thead><tr><th class="tl">Склад</th><th class="tr">Остаток, шт</th><th class="tr">Позиций</th><th class="tr">Доля</th><th class="tl">Заполнение</th></tr></thead>
      <tbody>${stockRows}</tbody>
    </table>
  </section>

  <section class="section">
    <h2>2 · Заказы по фулфилменту за ${retro.periodDays} дн. <span class="muted">— ${nf(retro.ordersTotal)} заказов, обработано ${processedPct.toFixed(0)}%</span></h2>
    <table class="flow">
      ${flowCols}
      <thead><tr>
        <th class="tl">Фулфилмент</th><th class="tr">Остаток</th><th class="tr">Заказов</th><th class="tr">Обраб.</th>
        <th class="tr">Сборка</th><th class="tr">Новые</th><th class="tr">Отмен</th><th class="tl">Статусы</th>
        <th class="tr">Медиана</th><th class="tr">Макс</th><th class="tr">Крит.</th>
      </tr></thead>
      <tbody>${flowRows}</tbody>
    </table>
    <p class="note">«Обработано» = поставка передана в доставку (supplierStatus=complete). Время обработки = момент передачи − создание заказа. Красная риска — есть критически долгие.</p>
  </section>
</div>

<div class="page">
  <div class="two">
    <section class="panel">
      <h2>3 · Статусы заказов <span class="muted">— в работе / не отгружено</span></h2>
      ${stackBar(st, 20)}
      <div class="legend">${statusLegend}</div>
    </section>
    <section class="panel">
      <h2>4 · Время обработки <span class="muted">— медиана ${fmtH(retro.overallMedianHours)}</span></h2>
      ${timingRows}
    </section>
  </div>

  <section class="section" style="margin-top:14px">
    <h2>5 · Критически долгие заказы <span class="muted">— > ${retro.criticalThresholdHours} ч, топ-16 из ${retro.critical.length}</span></h2>
    <table>
      <colgroup><col style="width:9%"><col style="width:17%"><col style="width:30%"><col style="width:14%"><col style="width:15%"><col style="width:15%"></colgroup>
      <thead><tr><th class="tr">Время</th><th class="tl">Фулфилмент</th><th class="tl">Артикул</th><th class="tl">Заказ</th><th class="tl">Создан</th><th class="tl">Передан в доставку</th></tr></thead>
      <tbody>${critRows}</tbody>
    </table>
  </section>

  <section class="section">
    <h2>6 · Топ-позиции по остаткам</h2>
    <table>
      <colgroup><col style="width:30%"><col style="width:40%"><col style="width:15%"><col style="width:15%"></colgroup>
      <thead><tr><th class="tl">Склад</th><th class="tl">Артикул продавца</th><th class="tl">nmID</th><th class="tr">Кол-во, шт</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table>
  </section>

  <div class="foot">Источник: WB API (marketplace warehouses/orders/supplies/status + content cards). Обновление: npm run fbs:stock &amp;&amp; npm run fbs:retro &amp;&amp; npm run fbs:pdf</div>
</div>`;

const htmlDoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>FBS отчёт</title><style>${css}</style></head><body>${body}</body></html>`;

// Записываем print-HTML (на случай отладки) и рендерим в PDF.
const HTML_OUT = R('fbs-report.print.html');
fs.writeFileSync(HTML_OUT, htmlDoc);

const { chromium } = await import('playwright');
function resolveBrowser() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base) { const link = path.join(base, 'chromium'); if (fs.existsSync(link)) return link; }
  try { const ep = chromium.executablePath(); if (ep && fs.existsSync(ep)) return ep; } catch { /* */ }
  return undefined;
}
const browser = await chromium.launch({ headless: true, executablePath: resolveBrowser(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setContent(htmlDoc, { waitUntil: 'networkidle' });
  const PDF_OUT = R('fbs-report.pdf');
  await page.pdf({
    path: PDF_OUT,
    format: 'A4',
    landscape: true,
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '9mm', bottom: '9mm', left: '9mm', right: '9mm' },
  });
  const kb = (fs.statSync(PDF_OUT).size / 1024).toFixed(1);
  process.stderr.write(`→ PDF: ${path.relative(process.cwd(), PDF_OUT)} (${kb} КБ)\n`);
} finally {
  await browser.close();
}
