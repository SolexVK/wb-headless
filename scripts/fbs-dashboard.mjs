// scripts/fbs-dashboard.mjs — собрать HTML-дашборд остатков FBS из снимка.
//
// Вход:  reports-output/fbs-stock.json (создаётся `npm run fbs:stock`)
//        либо путь к JSON первым аргументом.
// Выход: reports-output/fbs-stock-dashboard.html (самодостаточный HTML).
//
//   npm run fbs:dashboard
//
// Дашборд показывает по каждому складу FBS текущее количество товара (штук),
// число позиций и долю в общем остатке, плюс таблицу топ-позиций.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const IN = process.argv[2] || path.join(REPO, 'reports-output', 'fbs-stock.json');
const OUT = process.argv[3] || path.join(REPO, 'reports-output', 'fbs-stock-dashboard.html');

const snap = JSON.parse(fs.readFileSync(IN, 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n).toLocaleString('ru-RU');

const warehouses = [...snap.warehouses].sort((a, b) => b.totalQuantity - a.totalQuantity);
const grand = snap.grandTotalQuantity || warehouses.reduce((s, w) => s + w.totalQuantity, 0);
const activeCount = warehouses.filter((w) => w.totalQuantity > 0).length;
const totalPositions = warehouses.reduce((s, w) => s + w.skuInStock, 0);
const maxQty = Math.max(1, ...warehouses.map((w) => w.totalQuantity));

// Топ-позиции по всем складам (свод): группируем по vendorCode внутри склада уже есть;
// для таблицы берём топ-8 позиций каждого активного склада.
const topRows = [];
for (const w of warehouses) {
  for (const p of w.positions.slice(0, 8)) {
    topRows.push({ wh: w.name, code: p.vendorCode || p.nmID, nmID: p.nmID, amount: p.amount });
  }
}

const warehouseCards = warehouses.map((w) => {
  const share = grand ? (w.totalQuantity / grand) * 100 : 0;
  const barW = (w.totalQuantity / maxQty) * 100;
  const empty = w.totalQuantity === 0;
  return `
    <article class="card ${empty ? 'is-empty' : ''}">
      <div class="card-head">
        <h3 class="card-name">${esc(w.name)}</h3>
        <span class="pill ${empty ? 'pill-empty' : 'pill-active'}">${empty ? 'пусто' : 'в наличии'}</span>
      </div>
      <div class="card-qty"><span class="num">${nf(w.totalQuantity)}</span><span class="unit">шт</span></div>
      <div class="bar"><div class="bar-fill" style="width:${barW.toFixed(1)}%"></div></div>
      <dl class="card-meta">
        <div><dt>Позиций</dt><dd>${nf(w.skuInStock)}</dd></div>
        <div><dt>Доля FBS</dt><dd>${share.toFixed(1)}%</dd></div>
        <div><dt>warehouseId</dt><dd class="mono">${w.id}</dd></div>
        <div><dt>officeId</dt><dd class="mono">${w.officeId}</dd></div>
      </dl>
    </article>`;
}).join('');

const chartRows = warehouses.map((w) => {
  const pct = (w.totalQuantity / maxQty) * 100;
  const empty = w.totalQuantity === 0;
  return `
      <div class="chart-row ${empty ? 'is-empty' : ''}">
        <div class="chart-label">${esc(w.name)}</div>
        <div class="chart-track"><div class="chart-bar" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="chart-val">${nf(w.totalQuantity)}</div>
      </div>`;
}).join('');

const tableRows = topRows.map((r) => `
        <tr>
          <td>${esc(r.wh)}</td>
          <td>${esc(r.code)}</td>
          <td class="mono muted">${esc(r.nmID)}</td>
          <td class="ta-right num">${nf(r.amount)}</td>
        </tr>`).join('');

const html = `<div class="wrap">
  <header class="head">
    <div class="head-main">
      <p class="eyebrow">Wildberries · FBS · остатки на складах продавца</p>
      <h1>Остатки по фулфилмент-складам FBS</h1>
      <p class="sub">Текущее количество товара на каждом нашем складе FBS. Источник — WB API: <span class="mono">GET /api/v3/warehouses</span> + <span class="mono">POST /api/v3/stocks/{warehouseId}</span>.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>

  <section class="kpis">
    <div class="kpi kpi-accent">
      <div class="kpi-num">${nf(grand)}</div>
      <div class="kpi-lab">штук всего на FBS</div>
    </div>
    <div class="kpi">
      <div class="kpi-num">${activeCount}<span class="kpi-of"> / ${warehouses.length}</span></div>
      <div class="kpi-lab">складов с товаром</div>
    </div>
    <div class="kpi">
      <div class="kpi-num">${nf(totalPositions)}</div>
      <div class="kpi-lab">позиций в наличии</div>
    </div>
    <div class="kpi">
      <div class="kpi-num">${nf(snap.barcodeCount)}</div>
      <div class="kpi-lab">штрихкодов опрошено</div>
    </div>
  </section>

  <section class="grid">
    ${warehouseCards}
  </section>

  <section class="panel">
    <h2>Распределение остатка по складам</h2>
    <div class="chart">${chartRows}</div>
  </section>

  <section class="panel">
    <h2>Топ-позиции по складам <span class="muted">(до 8 на склад)</span></h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Склад</th><th>Артикул продавца</th><th>nmID</th><th class="ta-right">Кол-во, шт</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </section>

  <footer class="foot">
    <span>Обновить данные: <span class="mono">npm run fbs:stock</span> → <span class="mono">npm run fbs:dashboard</span></span>
  </footer>
</div>`;

const css = `
:root{
  --ground:#F5F7FA; --surface:#FFFFFF; --surface-2:#FBFCFE;
  --ink:#161B22; --muted:#5C6672; --faint:#8A93A0;
  --line:#E4E8EF; --line-strong:#D2D8E2;
  --accent:#4B57C6; --accent-soft:#EAECFB;
  --good:#178A5B; --good-soft:#E3F3EC; --good-ink:#0F6B45;
  --empty:#9AA3B0; --empty-soft:#EEF1F5;
  --shadow:0 1px 2px rgba(20,27,42,.04),0 4px 16px rgba(20,27,42,.05);
}
:root:not([data-theme="light"]){}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ground:#0D1117; --surface:#161B24; --surface-2:#1B212C;
    --ink:#E8ECF3; --muted:#9AA5B4; --faint:#6B7480;
    --line:#262D39; --line-strong:#333C4B;
    --accent:#8C97F5; --accent-soft:#20263D;
    --good:#3FBE86; --good-soft:#132A22; --good-ink:#67D6A2;
    --empty:#5B6572; --empty-soft:#1C222C;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --ground:#0D1117; --surface:#161B24; --surface-2:#1B212C;
  --ink:#E8ECF3; --muted:#9AA5B4; --faint:#6B7480;
  --line:#262D39; --line-strong:#333C4B;
  --accent:#8C97F5; --accent-soft:#20263D;
  --good:#3FBE86; --good-soft:#132A22; --good-ink:#67D6A2;
  --empty:#5B6572; --empty-soft:#1C222C;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  line-height:1.5;-webkit-font-smoothing:antialiased;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.92em;}
.num,.chart-val,.card-qty .num{font-variant-numeric:tabular-nums;}
.muted{color:var(--muted);} .faint{color:var(--faint);}
.ta-right{text-align:right;}
.wrap{max-width:1120px;margin:0 auto;padding:40px 28px 64px;}

.head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding-bottom:24px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.eyebrow{margin:0 0 8px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--accent);font-weight:600;}
.head h1{margin:0;font-size:29px;line-height:1.15;letter-spacing:-.02em;text-wrap:balance;font-weight:680;}
.sub{margin:10px 0 0;color:var(--muted);max-width:64ch;font-size:14.5px;}
.stamp{font-size:12.5px;color:var(--muted);text-align:right;line-height:1.45;white-space:nowrap;}
.stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 18px 16px;box-shadow:var(--shadow);}
.kpi-accent{background:linear-gradient(180deg,var(--accent-soft),var(--surface));border-color:var(--line-strong);}
.kpi-num{font-size:32px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1;}
.kpi-of{font-size:18px;color:var(--muted);font-weight:500;}
.kpi-lab{margin-top:7px;font-size:12.5px;color:var(--muted);}

.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px;}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;
  box-shadow:var(--shadow);display:flex;flex-direction:column;gap:12px;}
.card.is-empty{background:var(--surface-2);}
.card-head{display:flex;justify-content:space-between;align-items:center;gap:8px;}
.card-name{margin:0;font-size:14.5px;font-weight:620;letter-spacing:-.01em;}
.pill{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;letter-spacing:.01em;}
.pill-active{background:var(--good-soft);color:var(--good-ink);}
.pill-empty{background:var(--empty-soft);color:var(--empty);}
.card-qty{display:flex;align-items:baseline;gap:6px;}
.card-qty .num{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1;}
.card-qty .unit{font-size:13px;color:var(--muted);}
.is-empty .card-qty .num{color:var(--empty);}
.bar{height:6px;background:var(--empty-soft);border-radius:999px;overflow:hidden;}
.bar-fill{height:100%;background:var(--accent);border-radius:999px;}
.is-empty .bar-fill{background:var(--empty);}
.card-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin:2px 0 0;}
.card-meta div{display:flex;flex-direction:column;gap:1px;}
.card-meta dt{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;}
.card-meta dd{margin:0;font-size:13.5px;font-weight:560;font-variant-numeric:tabular-nums;}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px 22px 20px;
  box-shadow:var(--shadow);margin-bottom:22px;}
.panel h2{margin:0 0 16px;font-size:16px;font-weight:640;letter-spacing:-.01em;}
.panel h2 .muted{font-weight:400;font-size:13px;}

.chart{display:flex;flex-direction:column;gap:9px;}
.chart-row{display:grid;grid-template-columns:150px 1fr 64px;align-items:center;gap:14px;}
.chart-label{font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chart-row.is-empty .chart-label{color:var(--muted);}
.chart-track{height:22px;background:var(--empty-soft);border-radius:6px;overflow:hidden;}
.chart-bar{height:100%;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 78%,#fff));
  border-radius:6px;min-width:2px;}
.chart-val{text-align:right;font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums;}
.chart-row.is-empty .chart-val{color:var(--muted);}

.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13.5px;}
thead th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);
  font-weight:600;padding:0 12px 10px;border-bottom:1px solid var(--line-strong);white-space:nowrap;}
thead th.ta-right{text-align:right;}
tbody td{padding:9px 12px;border-bottom:1px solid var(--line);}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover{background:var(--surface-2);}

.foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted);}

@media (max-width:900px){
  .kpis{grid-template-columns:repeat(2,1fr);}
  .grid{grid-template-columns:repeat(2,1fr);}
}
@media (max-width:560px){
  .wrap{padding:28px 16px 48px;}
  .kpis,.grid{grid-template-columns:1fr 1fr;}
  .chart-row{grid-template-columns:110px 1fr 52px;gap:10px;}
  .head h1{font-size:24px;}
}
`;

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Остатки FBS по складам</title>
<style>${css}</style></head><body>${html}</body></html>`;

// Версия для публикации как Artifact: без doctype/html/head/body — только
// <title>, <style> и содержимое (обёртку добавляет платформа при публикации).
const artifactBody = `<title>Остатки FBS по складам</title>\n<style>${css}</style>\n${html}`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);
const OUT_ART = OUT.replace(/\.html$/, '.artifact.html');
fs.writeFileSync(OUT_ART, artifactBody);
process.stderr.write(`→ дашборд: ${path.relative(process.cwd(), OUT)} (${(page.length / 1024).toFixed(1)} КБ)\n`);
process.stderr.write(`→ для артефакта: ${path.relative(process.cwd(), OUT_ART)}\n`);
