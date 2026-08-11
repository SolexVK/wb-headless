// scripts/fbs-stock-pdf.mjs — PDF: остатки FBS, доступные к заказу, по фулфилментам.
//
// Читает reports-output/fbs-stock.json (npm run fbs:stock) и рендерит PDF
// (A4 альбомная) через встроенный Chromium. Показывает по каждому нашему
// складу-фулфилменту количество товара, доступного к заказу (amount из
// marketplace POST /api/v3/stocks/{warehouseId}), плюс детализацию позиций.
//
//   npm run fbs:stock:pdf
//
// Выход: reports-output/fbs-stock-report.pdf
// Верстка под печать: table-layout:fixed, контроль разрывов — столбцы и блоки
// не налезают на границы.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);

const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const dateLabel = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (n, d) => (d ? (n / d) * 100 : 0);

const warehouses = (stock.warehouses || []).slice().sort((a, b) => b.totalQuantity - a.totalQuantity);
const grand = stock.grandTotalQuantity || warehouses.reduce((s, w) => s + w.totalQuantity, 0);
const maxQty = Math.max(1, ...warehouses.map((w) => w.totalQuantity));
const active = warehouses.filter((w) => w.totalQuantity > 0);
const totalPositions = warehouses.reduce((s, w) => s + w.skuInStock, 0);

const kpis = [
  ['штук доступно к заказу', nf(grand), 'accent'],
  ['складов с товаром', `${active.length}<span class="of"> / ${warehouses.length}</span>`, ''],
  ['позиций в наличии', nf(totalPositions), ''],
  ['штрихкодов опрошено', nf(stock.barcodeCount), ''],
].map(([lab, num, cls]) => `<div class="kpi ${cls}"><div class="kpi-num">${num}</div><div class="kpi-lab">${lab}</div></div>`).join('');

// Сводная таблица по фулфилментам.
const summaryRows = warehouses.map((w) => {
  const empty = w.totalQuantity === 0;
  return `<tr>
    <td class="tl">${esc(w.name)}</td>
    <td class="tr num b">${nf(w.totalQuantity)}</td>
    <td class="tr num">${nf(w.skuInStock)}</td>
    <td class="tr num">${pct(w.totalQuantity, grand).toFixed(1)}%</td>
    <td class="tr mono">${w.id}</td>
    <td class="bar-cell"><span class="hbar"><span style="width:${pct(w.totalQuantity, maxQty).toFixed(1)}%;background:${empty ? '#B8C0CD' : '#5A57E6'}"></span></span></td>
  </tr>`;
}).join('');

// Детализация позиций по активным складам (доступно к заказу).
const detailSections = active.map((w) => {
  const rows = (w.positions || []).map((p) => `<tr>
      <td class="tl">${esc(p.vendorCode || p.nmID)}</td>
      <td class="mono">${esc(p.nmID)}</td>
      <td class="mono">${esc(p.sku)}</td>
      <td class="tr num b">${nf(p.amount)}</td>
    </tr>`).join('');
  return `<section class="wh-block">
    <h3>${esc(w.name)} <span class="muted">— ${nf(w.totalQuantity)} шт, ${nf(w.skuInStock)} позиций</span></h3>
    <table class="detail">
      <colgroup><col style="width:46%"><col style="width:20%"><col style="width:20%"><col style="width:14%"></colgroup>
      <thead><tr><th class="tl">Артикул продавца</th><th class="tl">nmID</th><th class="tl">Штрихкод</th><th class="tr">Доступно, шт</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}).join('');

const css = `
@page{ size:A4 landscape; margin:9mm; }
*{ box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
html,body{ margin:0; padding:0; }
body{ font-family:"DejaVu Sans","Liberation Sans",Arial,sans-serif; color:#151B26; font-size:9.6pt; line-height:1.4; }
.mono{ font-family:"DejaVu Sans Mono","Liberation Mono",monospace; font-size:8.6pt; color:#3A4353; white-space:nowrap; }
.num{ font-variant-numeric:tabular-nums; } .b{ font-weight:700; } .muted{ color:#5A6478; font-weight:400; }
.tl{ text-align:left; } .tr{ text-align:right; }

.head{ display:flex; justify-content:space-between; align-items:flex-start; gap:16px;
  border-bottom:2px solid #5A57E6; padding-bottom:9px; margin-bottom:12px; }
.eyebrow{ margin:0 0 3px; font-size:8pt; letter-spacing:.12em; text-transform:uppercase; color:#5A57E6; font-weight:700; }
h1{ margin:0; font-size:16pt; letter-spacing:-.01em; font-weight:700; }
.sub{ margin:4px 0 0; color:#5A6478; font-size:9pt; }
.stamp{ text-align:right; font-size:8.6pt; color:#5A6478; white-space:nowrap; line-height:1.5; }
.stamp b{ color:#151B26; }

.kpis{ display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin-bottom:14px; }
.kpi{ border:1px solid #DCE2EC; border-radius:7px; padding:10px 12px; background:#F7F9FC; }
.kpi.accent{ background:#ECECFB; border-color:#C9C8F2; }
.kpi-num{ font-size:18pt; font-weight:700; letter-spacing:-.02em; line-height:1; font-variant-numeric:tabular-nums; }
.kpi-num .of{ font-size:12pt; color:#5A6478; font-weight:600; }
.kpi-lab{ margin-top:5px; font-size:8.4pt; color:#5A6478; }

h2{ margin:0 0 8px; font-size:11.5pt; font-weight:700; padding-left:8px; border-left:3px solid #5A57E6; }
h3{ margin:0 0 6px; font-size:10pt; font-weight:700; padding-left:7px; border-left:3px solid #0E9E77; }
.section{ margin-bottom:16px; }
.wh-block{ margin-bottom:13px; page-break-inside:avoid; }

table{ width:100%; border-collapse:collapse; table-layout:fixed; }
thead th{ text-align:left; font-size:7.6pt; text-transform:uppercase; letter-spacing:.03em; color:#6B7488;
  font-weight:700; padding:0 6px 5px; border-bottom:1.5px solid #C6CEDB; }
thead th.tr{ text-align:right; }
tbody td{ padding:4.5px 6px; border-bottom:1px solid #E6EAF1; overflow:hidden; text-overflow:ellipsis; }
tbody tr:nth-child(even){ background:#F8FAFD; }
tbody tr{ page-break-inside:avoid; }
.tl{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.summary col.c-name{ width:22%; }
.bar-cell{ padding-top:4px; padding-bottom:4px; }
.hbar{ display:block; width:100%; height:9px; background:#EDEFF4; border-radius:4px; overflow:hidden; }
.hbar span{ display:block; height:100%; border-radius:4px; }

.two{ display:grid; grid-template-columns:1fr 1fr; gap:12px 18px; align-items:start; }
.note{ margin:6px 0 0; font-size:8.4pt; color:#5A6478; }
.foot{ margin-top:10px; padding-top:7px; border-top:1px solid #DCE2EC; font-size:8pt; color:#6B7488; }
`;

const body = `
<div class="head">
  <div>
    <p class="eyebrow">Wildberries · FBS · остатки к заказу</p>
    <h1>FBS: остатки, доступные к заказу — на ${dateLabel}</h1>
    <p class="sub">Количество товара, доступного к заказу, по каждому нашему складу-фулфилменту. Источник: WB API POST /api/v3/stocks/{warehouseId}.</p>
  </div>
  <div class="stamp">Снимок<br><b>${stamp}</b></div>
</div>

<div class="kpis">${kpis}</div>

<section class="section">
  <h2>Остатки по фулфилментам</h2>
  <table class="summary">
    <colgroup><col class="c-name"><col style="width:15%"><col style="width:13%"><col style="width:10%"><col style="width:13%"><col style="width:27%"></colgroup>
    <thead><tr><th class="tl">Склад</th><th class="tr">Доступно, шт</th><th class="tr">Позиций</th><th class="tr">Доля</th><th class="tr">warehouseId</th><th class="tl">Заполнение</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>
  <p class="note">«Доступно, шт» = текущий остаток FBS на складе продавца, который можно заказать. Пустые склады показаны для полноты.</p>
</section>

<section class="section">
  <h2>Детализация по позициям (доступно к заказу)</h2>
  ${detailSections || '<p class="note">Нет позиций с остатком.</p>'}
</section>

<div class="foot">Источник: WB API — marketplace /api/v3/warehouses + /api/v3/stocks/{warehouseId}, штрихкоды из content/v2/get/cards/list. Обновление: npm run fbs:stock &amp;&amp; npm run fbs:stock:pdf</div>`;

const htmlDoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>FBS остатки — ${dateLabel}</title><style>${css}</style></head><body>${body}</body></html>`;
fs.writeFileSync(R('fbs-stock-report.print.html'), htmlDoc);

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
  const PDF_OUT = R('fbs-stock-report.pdf');
  await page.pdf({ path: PDF_OUT, format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true,
    margin: { top: '9mm', bottom: '9mm', left: '9mm', right: '9mm' } });
  process.stderr.write(`→ PDF: ${path.relative(process.cwd(), PDF_OUT)} (${(fs.statSync(PDF_OUT).size / 1024).toFixed(1)} КБ)\n`);
} finally {
  await browser.close();
}
