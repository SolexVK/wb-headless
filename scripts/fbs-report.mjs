// scripts/fbs-report.mjs — единый дашборд FBS: остатки + ретроспектива заказов.
//
// Объединяет два снимка в одну удобочитаемую HTML-панель:
//   reports-output/fbs-stock.json         (npm run fbs:stock)
//   reports-output/fbs-orders-retro.json  (npm run fbs:retro)
//
//   npm run fbs:report
//
// Выход: reports-output/fbs-report.html (самодостаточный) и
//        reports-output/fbs-report.artifact.html (для публикации артефактом).
//
// Секции: KPI-обзор → Остатки по складам → Заказы по фулфилменту (сводная) →
// Статусы (в работе/не отгружено) → Время обработки → Критически долгие.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);

const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const retro = JSON.parse(fs.readFileSync(R('fbs-orders-retro.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const periodLabel = retro.periodLabel || `последние ${retro.periodDays} дн.`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const fmtH = (h) => (h >= 24 ? (h / 24).toFixed(1) + ' сут' : (+h).toFixed(1) + ' ч');

// ── Свести склады: объединяем остатки и поток по warehouseId ────────────────
const wh = new Map(); // id → {name, stockQty, positions, made, processed, pending, avg, median, max, crit, status}
for (const s of stock.warehouses || []) {
  wh.set(s.id, { id: s.id, name: s.name, stockQty: s.totalQuantity, positions: s.skuInStock,
    made: 0, processed: 0, pending: 0, avg: 0, median: 0, max: 0, crit: 0, status: { new: 0, confirm: 0, complete: 0, cancel: 0 } });
}
for (const r of retro.byFulfillment || []) {
  const e = wh.get(r.warehouseId) || { id: r.warehouseId, name: r.name, stockQty: 0, positions: 0 };
  Object.assign(e, {
    name: e.name || r.name, made: r.made, processed: r.processed, pending: r.pending,
    avg: r.avgHours, median: r.medianHours, max: r.maxHours, crit: r.criticalCount, status: r.status,
  });
  wh.set(r.warehouseId, e);
}
const whRows = [...wh.values()].sort((a, b) => (b.made - a.made) || (b.stockQty - a.stockQty));

const grandStock = stock.grandTotalQuantity || 0;
const maxStock = Math.max(1, ...whRows.map((w) => w.stockQty));
const maxMade = Math.max(1, ...whRows.map((w) => w.made));
const st = retro.statusTotals || { new: 0, confirm: 0, complete: 0, cancel: 0 };
const processedPct = pct(retro.processedTotal, retro.ordersTotal);

// ── Компоненты ──────────────────────────────────────────────────────────────
const STATUS_META = [
  ['complete', 'в доставке', 'var(--s-done)'],
  ['confirm', 'на сборке', 'var(--s-work)'],
  ['new', 'новые', 'var(--s-new)'],
  ['cancel', 'отменено', 'var(--s-cancel)'],
];

function stackBar(status, className = 'sbar') {
  const total = STATUS_META.reduce((s, [k]) => s + (status[k] || 0), 0) || 1;
  const segs = STATUS_META.filter(([k]) => status[k] > 0).map(([k, , color]) =>
    `<span class="seg" style="width:${pct(status[k], total).toFixed(2)}%;background:${color}" title="${k}: ${status[k]}"></span>`).join('');
  return `<span class="${className}">${segs}</span>`;
}

// KPI-обзор
const kpis = `
  <div class="kpi kpi-accent"><div class="kpi-num">${nf(grandStock)}</div><div class="kpi-lab">штук на FBS-складах</div></div>
  <div class="kpi"><div class="kpi-num">${nf(retro.ordersTotal)}</div><div class="kpi-lab">заказов · ${periodLabel}</div></div>
  <div class="kpi"><div class="kpi-num">${processedPct.toFixed(0)}<span class="kpi-of">%</span></div><div class="kpi-lab">обработано (${nf(retro.processedTotal)})</div></div>
  <div class="kpi"><div class="kpi-num">${fmtH(retro.overallMedianHours)}</div><div class="kpi-lab">медиана обработки</div></div>
  <div class="kpi"><div class="kpi-num">${fmtH(retro.overallAvgHours)}</div><div class="kpi-lab">среднее обработки</div></div>
  <div class="kpi kpi-warn"><div class="kpi-num">${nf(retro.critical.length)}</div><div class="kpi-lab">крит. долгих &gt; ${retro.criticalThresholdHours} ч</div></div>`;

// Секция ОСТАТКИ — карточки складов + распределение
const stockCards = (stock.warehouses || []).slice().sort((a, b) => b.totalQuantity - a.totalQuantity).map((s) => {
  const empty = s.totalQuantity === 0;
  return `<article class="card ${empty ? 'is-empty' : ''}">
    <div class="card-head"><h3>${esc(s.name)}</h3><span class="pill ${empty ? 'pill-off' : 'pill-on'}">${empty ? 'пусто' : 'в наличии'}</span></div>
    <div class="card-qty"><span class="num">${nf(s.totalQuantity)}</span><span class="unit">шт</span></div>
    <div class="bar"><div class="bar-fill" style="width:${pct(s.totalQuantity, maxStock).toFixed(1)}%"></div></div>
    <div class="card-foot"><span>${nf(s.skuInStock)} позиций</span><span>${pct(s.totalQuantity, grandStock).toFixed(1)}% остатка</span></div>
  </article>`;
}).join('');

// Топ-позиции остатков (свод, топ-12 по всем складам)
const topPos = [];
for (const s of stock.warehouses || []) for (const p of (s.positions || []).slice(0, 5)) topPos.push({ wh: s.name, ...p });
topPos.sort((a, b) => b.amount - a.amount);
const stockTopRows = topPos.slice(0, 12).map((p) => `<tr><td>${esc(p.wh)}</td><td>${esc(p.vendorCode || p.nmID)}</td><td class="mono muted">${esc(p.nmID)}</td><td class="ta-r num">${nf(p.amount)}</td></tr>`).join('');

// Секция ЗАКАЗЫ — сводная таблица по фулфилменту
const flowRows = whRows.map((w) => {
  const health = w.crit > 0 ? 'row-warn' : '';
  return `<tr class="${health}">
    <td class="w-name">${esc(w.name)}</td>
    <td class="ta-r num">${nf(w.stockQty)}</td>
    <td class="ta-r num">${nf(w.made)}</td>
    <td class="ta-r num strong">${nf(w.processed)}</td>
    <td class="ta-r num">${nf(w.status.confirm)}</td>
    <td class="ta-r num">${nf(w.status.new)}</td>
    <td class="ta-r num muted">${nf(w.status.cancel)}</td>
    <td class="cell-bar">${stackBar(w.status)}</td>
    <td class="ta-r num">${w.median ? fmtH(w.median) : '—'}</td>
    <td class="ta-r num">${w.max ? fmtH(w.max) : '—'}</td>
    <td class="ta-r num ${w.crit ? 'crit' : 'muted'}">${w.crit || '—'}</td>
  </tr>`;
}).join('');

// Секция СТАТУСЫ — общий стек + легенда
const statusTotal = STATUS_META.reduce((s, [k]) => s + st[k], 0) || 1;
const statusLegend = STATUS_META.map(([k, label, color]) =>
  `<div class="lg"><span class="dot" style="background:${color}"></span><span class="lg-lab">${label}</span><span class="lg-num">${nf(st[k])}</span><span class="lg-pct">${pct(st[k], statusTotal).toFixed(1)}%</span></div>`).join('');

// Секция ВРЕМЯ — распределение по корзинам
const tb = retro.timingBuckets || {};
const tbMeta = [['<6ч', 'var(--s-done)'], ['6-24ч', 'var(--accent)'], ['24-48ч', 'var(--s-work)'], ['>48ч', 'var(--s-cancel)']];
const tbTotal = Object.values(tb).reduce((a, b) => a + b, 0) || 1;
const timingRows = tbMeta.map(([k, color]) => `
  <div class="chart-row">
    <div class="chart-label">${k}</div>
    <div class="chart-track"><div class="chart-bar" style="width:${pct(tb[k] || 0, tbTotal).toFixed(1)}%;background:${color}"></div></div>
    <div class="chart-val">${nf(tb[k] || 0)}</div>
  </div>`).join('');

// Секция КРИТИЧЕСКИЕ — таблица худших
const critRows = (retro.critical || []).slice(0, 15).map((c) => `<tr>
    <td class="ta-r crit strong">${fmtH(c.hours)}</td>
    <td>${esc(c.warehouse)}</td>
    <td>${esc(c.article)}</td>
    <td class="mono muted">${esc(c.orderId)}</td>
    <td class="mono muted">${esc(c.createdAt.slice(0, 16).replace('T', ' '))}</td>
    <td class="mono muted">${esc(c.closedAt.slice(0, 16).replace('T', ' '))}</td>
  </tr>`).join('');

// ── HTML ──────────────────────────────────────────────────────────────────
const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · операционная панель</p>
      <h1>FBS: остатки и обработка заказов по фулфилментам</h1>
      <p class="sub">Единый обзор по нашим складам продавца: что лежит на складе сейчас и как ${periodLabel} обрабатывались заказы каждым фулфилментом.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b><br><span class="muted">период: ${periodLabel}</span></div>
  </header>

  <section class="kpis">${kpis}</section>

  <section class="block">
    <div class="block-head"><h2>1 · Остатки на складах FBS</h2><span class="muted">${nf(stock.barcodeCount)} штрихкодов опрошено</span></div>
    <div class="grid">${stockCards}</div>
    <details class="details"><summary>Топ-позиции по остаткам</summary>
      <div class="table-scroll"><table>
        <thead><tr><th>Склад</th><th>Артикул</th><th>nmID</th><th class="ta-r">Кол-во</th></tr></thead>
        <tbody>${stockTopRows}</tbody></table></div>
    </details>
  </section>

  <section class="block">
    <div class="block-head"><h2>2 · Заказы по фулфилменту — ${periodLabel}</h2><span class="muted">${nf(retro.ordersTotal)} заказов · обработано ${processedPct.toFixed(0)}%</span></div>
    <div class="table-scroll"><table class="flow">
      <thead><tr>
        <th>Фулфилмент</th><th class="ta-r">Остаток</th><th class="ta-r">Заказов</th>
        <th class="ta-r">Обраб.</th><th class="ta-r">Сборка</th><th class="ta-r">Новые</th><th class="ta-r">Отмен</th>
        <th>Статусы</th><th class="ta-r">Медиана</th><th class="ta-r">Макс</th><th class="ta-r">Крит.</th>
      </tr></thead>
      <tbody>${flowRows}</tbody>
    </table></div>
    <p class="note">«Обработано» = поставка передана в доставку (<span class="mono">supplierStatus=complete</span>). Время обработки = момент передачи − создание заказа.</p>
  </section>

  <section class="split">
    <div class="block">
      <div class="block-head"><h2>3 · Статусы заказов</h2><span class="muted">в работе / не отгружено</span></div>
      <div class="stack-big">${stackBar(st, 'sbar sbar-lg')}</div>
      <div class="legend">${statusLegend}</div>
    </div>
    <div class="block">
      <div class="block-head"><h2>4 · Время обработки</h2><span class="muted">медиана ${fmtH(retro.overallMedianHours)}</span></div>
      <div class="chart">${timingRows}</div>
    </div>
  </section>

  <section class="block">
    <div class="block-head"><h2>5 · Критически долгие заказы <span class="muted">(&gt; ${retro.criticalThresholdHours} ч, топ-15 из ${retro.critical.length})</span></h2></div>
    <div class="table-scroll"><table>
      <thead><tr><th class="ta-r">Время</th><th>Фулфилмент</th><th>Артикул</th><th>Заказ</th><th>Создан</th><th>Передан в доставку</th></tr></thead>
      <tbody>${critRows}</tbody>
    </table></div>
  </section>

  <footer class="foot">Источник: WB API (marketplace warehouses/orders/supplies/status + content cards). Обновление: <span class="mono">npm run fbs:stock &amp;&amp; npm run fbs:retro &amp;&amp; npm run fbs:report</span></footer>
</div>`;

const css = `
:root{
  --ground:#EDF0F6; --surface:#FFFFFF; --surface-2:#F6F8FC;
  --ink:#111725; --muted:#5A6478; --faint:#8B94A6;
  --line:#E1E6F0; --line-2:#CFD6E4;
  --accent:#5A57E6; --accent-soft:#E9E9FC;
  --s-done:#0E9E77; --s-done-soft:#E1F4EE;
  --s-work:#C67A08; --s-work-soft:#FaeEDA;
  --s-new:#6B7688; --s-new-soft:#EDEFF4;
  --s-cancel:#D6455A; --s-cancel-soft:#FBE6EA;
  --shadow:0 1px 2px rgba(16,22,38,.04),0 4px 18px rgba(16,22,38,.06);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0A0D14; --surface:#111621; --surface-2:#161C28;
  --ink:#E9EDF6; --muted:#98A2B6; --faint:#626C80;
  --line:#212836; --line-2:#303A4C;
  --accent:#8E8CFF; --accent-soft:#1E2140;
  --s-done:#34D6A0; --s-done-soft:#0E2A22;
  --s-work:#F2B44C; --s-work-soft:#2E2410;
  --s-new:#8A94A8; --s-new-soft:#1B2130;
  --s-cancel:#F2708A; --s-cancel-soft:#2E1620;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.4);
}}
:root[data-theme="dark"]{
  --ground:#0A0D14; --surface:#111621; --surface-2:#161C28;
  --ink:#E9EDF6; --muted:#98A2B6; --faint:#626C80;
  --line:#212836; --line-2:#303A4C;
  --accent:#8E8CFF; --accent-soft:#1E2140;
  --s-done:#34D6A0; --s-done-soft:#0E2A22;
  --s-work:#F2B44C; --s-work-soft:#2E2410;
  --s-new:#8A94A8; --s-new-soft:#1B2130;
  --s-cancel:#F2708A; --s-cancel-soft:#2E1620;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.4);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  line-height:1.5;-webkit-font-smoothing:antialiased;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.9em;}
.num,.kpi-num,.chart-val{font-variant-numeric:tabular-nums;}
.muted{color:var(--muted);} .strong{font-weight:680;} .crit{color:var(--s-cancel);}
.ta-r{text-align:right;}
.wrap{max-width:1180px;margin:0 auto;padding:40px 26px 60px;}

.head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;
  padding-bottom:22px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.eyebrow{margin:0 0 8px;font-size:11.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--accent);font-weight:700;}
.head h1{margin:0;font-size:27px;line-height:1.15;letter-spacing:-.02em;font-weight:700;text-wrap:balance;}
.sub{margin:9px 0 0;color:var(--muted);max-width:70ch;font-size:14px;}
.stamp{font-size:12.5px;color:var(--muted);text-align:right;white-space:nowrap;line-height:1.5;}
.stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:24px 0 8px;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 16px;box-shadow:var(--shadow);}
.kpi-accent{background:linear-gradient(165deg,var(--accent-soft),var(--surface));border-color:var(--line-2);}
.kpi-warn{background:linear-gradient(165deg,var(--s-cancel-soft),var(--surface));}
.kpi-num{font-size:26px;font-weight:720;letter-spacing:-.02em;line-height:1;}
.kpi-of{font-size:16px;color:var(--muted);font-weight:600;}
.kpi-lab{margin-top:6px;font-size:11.5px;color:var(--muted);line-height:1.35;}

.block{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);margin-top:18px;}
.block-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px;flex-wrap:wrap;}
.block-head h2{margin:0;font-size:15.5px;font-weight:680;letter-spacing:-.01em;}
.block-head .muted{font-size:12.5px;}
.split{display:grid;grid-template-columns:1.15fr 1fr;gap:18px;align-items:start;}
.split .block{margin-top:18px;}

.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
.card{background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:14px;display:flex;flex-direction:column;gap:10px;}
.card.is-empty{opacity:.7;}
.card-head{display:flex;justify-content:space-between;align-items:center;gap:8px;}
.card-head h3{margin:0;font-size:13.5px;font-weight:620;}
.pill{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;}
.pill-on{background:var(--s-done-soft);color:var(--s-done);}
.pill-off{background:var(--s-new-soft);color:var(--s-new);}
.card-qty{display:flex;align-items:baseline;gap:5px;}
.card-qty .num{font-size:26px;font-weight:720;letter-spacing:-.02em;}
.card-qty .unit{font-size:12px;color:var(--muted);}
.is-empty .card-qty .num{color:var(--s-new);}
.bar{height:5px;background:var(--s-new-soft);border-radius:999px;overflow:hidden;}
.bar-fill{height:100%;background:var(--accent);border-radius:999px;}
.card-foot{display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);}

.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);
  font-weight:700;padding:0 10px 9px;border-bottom:1px solid var(--line-2);white-space:nowrap;}
thead th.ta-r{text-align:right;}
tbody td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover{background:var(--surface-2);}
.flow .w-name{font-weight:600;}
.flow .row-warn .w-name{box-shadow:inset 3px 0 0 var(--s-cancel);padding-left:12px;}
.cell-bar{width:130px;min-width:110px;}

.sbar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:var(--s-new-soft);min-width:100px;}
.sbar .seg{display:block;height:100%;}
.sbar-lg{height:20px;border-radius:7px;}
.stack-big{margin:4px 0 16px;}
.legend{display:grid;grid-template-columns:1fr 1fr;gap:9px 18px;}
.lg{display:flex;align-items:center;gap:8px;font-size:13px;}
.lg .dot{width:10px;height:10px;border-radius:3px;flex:none;}
.lg-lab{flex:1;color:var(--muted);}
.lg-num{font-weight:680;font-variant-numeric:tabular-nums;}
.lg-pct{color:var(--faint);font-size:11.5px;width:44px;text-align:right;font-variant-numeric:tabular-nums;}

.chart{display:flex;flex-direction:column;gap:10px;}
.chart-row{display:grid;grid-template-columns:60px 1fr 54px;align-items:center;gap:12px;}
.chart-label{font-size:12.5px;color:var(--muted);}
.chart-track{height:20px;background:var(--s-new-soft);border-radius:6px;overflow:hidden;}
.chart-bar{height:100%;border-radius:6px;min-width:2px;}
.chart-val{text-align:right;font-size:13px;font-weight:640;}

.details{margin-top:14px;border-top:1px solid var(--line);padding-top:6px;}
.details summary{cursor:pointer;font-size:13px;color:var(--accent);font-weight:600;padding:6px 0;}
.note{margin:12px 0 0;font-size:12px;color:var(--muted);}
.foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}

@media (max-width:1000px){
  .kpis{grid-template-columns:repeat(3,1fr);}
  .split{grid-template-columns:1fr;}
  .grid{grid-template-columns:repeat(2,1fr);}
}
@media (max-width:560px){
  .wrap{padding:26px 14px 44px;}
  .kpis{grid-template-columns:repeat(2,1fr);}
  .head h1{font-size:22px;}
}
`;

const OUT = R('fbs-report.html');
const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>FBS — остатки и заказы</title>
<style>${css}</style></head><body>${body}</body></html>`;
const artifact = `<title>FBS — остатки и заказы по фулфилментам</title>\n<style>${css}</style>\n${body}`;

fs.writeFileSync(OUT, page);
fs.writeFileSync(R('fbs-report.artifact.html'), artifact);
process.stderr.write(`→ ${path.relative(process.cwd(), OUT)} (${(page.length / 1024).toFixed(1)} КБ)\n`);
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-report.artifact.html'))}\n`);
