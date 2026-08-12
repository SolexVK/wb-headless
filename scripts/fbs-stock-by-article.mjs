// scripts/fbs-stock-by-article.mjs — дашборд остатков по складам с группировкой
// по артикулу+цвету (карточка nmID); количество по размерам объединяется.
//
// Читает reports-output/fbs-stock.json (npm run fbs:stock).
// Каждая карточка WB (nmID) = один артикул+цвет с несколькими размерами
// (штрихкодами) — размеры суммируем в одну цифру.
//
//   npm run fbs:stock:articles
// Выход: reports-output/fbs-stock-articles.html и .artifact.html

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);
const stock = JSON.parse(fs.readFileSync(R('fbs-stock.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (n, d) => (d ? (n / d) * 100 : 0);

const warehouses = (stock.warehouses || []).slice().sort((a, b) => b.totalQuantity - a.totalQuantity);
const active = warehouses.filter((w) => w.totalQuantity > 0);
const grand = stock.grandTotalQuantity || warehouses.reduce((s, w) => s + w.totalQuantity, 0);
const maxWh = Math.max(1, ...warehouses.map((w) => w.totalQuantity));

// Агрегация: nmID → { vendorCode, nmID, byWh:{whName:qty}, total, skus:Set }
const artMap = new Map();
for (const w of warehouses) {
  for (const p of w.positions || []) {
    if (!artMap.has(p.nmID)) artMap.set(p.nmID, { vendorCode: p.vendorCode, nmID: p.nmID, byWh: {}, total: 0, skus: new Set() });
    const a = artMap.get(p.nmID);
    a.byWh[w.name] = (a.byWh[w.name] || 0) + p.amount;
    a.total += p.amount;
    a.skus.add(p.sku);
  }
}
const articles = [...artMap.values()].sort((a, b) => b.total - a.total);
const cellMax = Math.max(1, ...articles.flatMap((a) => Object.values(a.byWh)));

// Плитки по складам (все 8).
const tiles = warehouses.map((w) => {
  const empty = w.totalQuantity === 0;
  const arts = new Set((w.positions || []).map((p) => p.nmID)).size;
  return `<article class="tile ${empty ? 'is-empty' : ''}">
    <div class="tile-head"><span class="tile-day">${esc(w.name)}</span></div>
    <div class="tile-num">${nf(w.totalQuantity)}</div>
    <div class="tile-spark"><span style="height:${Math.max(6, pct(w.totalQuantity, maxWh)).toFixed(0)}%"></span></div>
    <div class="tile-lab">${empty ? 'пусто' : `${nf(arts)} арт.+цвет · ${pct(w.totalQuantity, grand).toFixed(1)}%`}</div>
  </article>`;
}).join('');

// Матрица: строки — артикул+цвет, столбцы — активные склады.
const headWh = active.map((w) => `<th class="ta-c">${esc(w.name)}</th>`).join('');
const rows = articles.map((a) => {
  const cells = active.map((w) => {
    const v = a.byWh[w.name] || 0;
    const al = v ? (0.14 + 0.86 * pct(v, cellMax) / 100).toFixed(3) : 0;
    return `<td class="ta-c heat" style="${v ? `background:rgba(27,150,90,${al});color:${al > 0.55 ? '#fff' : 'inherit'}` : ''}">${v || '·'}</td>`;
  }).join('');
  return `<tr>
    <td class="a-name" title="размеров объединено: ${a.skus.size}">${esc(a.vendorCode || a.nmID)}</td>
    <td class="mono muted">${esc(a.nmID)}</td>
    ${cells}
    <td class="ta-r num strong">${nf(a.total)}</td>
  </tr>`;
}).join('');
const totalRow = `<tr class="tr-total"><td class="a-name">Всего</td><td></td>${active.map((w) => `<td class="ta-c num">${nf(w.totalQuantity)}</td>`).join('')}<td class="ta-r num strong">${nf(grand)}</td></tr>`;

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · остатки по артикулам</p>
      <h1>Количество товара на складах — по артикулам и цветам</h1>
      <p class="sub">Текущий остаток на каждом нашем фулфилменте, сгруппированный по артикулу и цвету (карточка nmID). Количество по размерам объединено в одну цифру.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>

  <section class="kpis">
    <div class="kpi kpi-accent"><div class="kpi-num">${nf(grand)}</div><div class="kpi-lab">штук на всех складах</div></div>
    <div class="kpi"><div class="kpi-num">${nf(articles.length)}</div><div class="kpi-lab">артикул+цвет (карточек)</div></div>
    <div class="kpi"><div class="kpi-num">${active.length}<span class="of"> / ${warehouses.length}</span></div><div class="kpi-lab">складов с товаром</div></div>
    <div class="kpi"><div class="kpi-num">${nf(stock.barcodeCount)}</div><div class="kpi-lab">штрихкодов опрошено</div></div>
  </section>

  <section class="tiles">${tiles}</section>

  <section class="panel">
    <div class="panel-head"><h2>Остаток по артикул+цвет × склад</h2><span class="muted">размеры объединены · насыщенность = объём · последний столбец — всего по всем складам</span></div>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th class="tl">Артикул + цвет</th><th class="tl">nmID</th>${headWh}<th class="ta-r">Σ всего</th></tr></thead>
      <tbody>${rows}${totalRow}</tbody>
    </table></div>
    <p class="note">Строка = карточка WB (nmID) — один артикул и цвет; количество по размерам просуммировано. Наведите на артикул, чтобы увидеть, сколько размеров объединено. Точка «·» — нет на складе.</p>
  </section>

  <footer class="foot">Источник: WB API marketplace /api/v3/stocks/{warehouseId} + content/v2/get/cards/list. Обновление: npm run fbs:stock &amp;&amp; npm run fbs:stock:articles</footer>
</div>`;

const css = `
:root{
  --ground:#EEF3EF; --surface:#FFFFFF; --surface-2:#F5F9F6;
  --ink:#12211A; --muted:#54695D; --faint:#88998F;
  --line:#DDE7E0; --line-2:#C7D6CC;
  --accent:#1B965A; --accent-d:#127045; --accent-soft:#E1F3E9;
  --shadow:0 1px 2px rgba(18,33,26,.04),0 4px 16px rgba(18,33,26,.06);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B;
  --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038;
  --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}}
:root[data-theme="dark"]{
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B;
  --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038;
  --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.88em;}
.num,.kpi-num,.tile-num{font-variant-numeric:tabular-nums;}
.muted{color:var(--muted);} .strong{font-weight:700;}
.ta-c{text-align:center;} .ta-r{text-align:right;} .tl{text-align:left;}
.wrap{max-width:1120px;margin:0 auto;padding:36px 24px 56px;}

.head{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line);}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700;}
.head h1{margin:0;font-size:25px;font-weight:750;letter-spacing:-.02em;text-wrap:balance;}
.sub{margin:8px 0 0;color:var(--muted);max-width:78ch;font-size:14px;}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5;}
.stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:var(--shadow);}
.kpi-accent{background:linear-gradient(165deg,var(--accent-soft),var(--surface));border-color:var(--line-2);}
.kpi-num{font-size:28px;font-weight:750;letter-spacing:-.02em;line-height:1;}
.kpi-num .of{font-size:16px;color:var(--muted);font-weight:600;}
.kpi-lab{margin-top:6px;font-size:12px;color:var(--muted);}

.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow);
  display:grid;grid-template-columns:1fr auto;grid-template-areas:"head head" "num spark" "lab lab";align-items:center;gap:5px 10px;}
.tile.is-empty{opacity:.6;}
.tile-head{grid-area:head;} .tile-day{font-size:13.5px;font-weight:700;}
.tile-num{grid-area:num;font-size:30px;font-weight:780;letter-spacing:-.03em;color:var(--accent-d);line-height:1;}
.tile.is-empty .tile-num{color:var(--muted);}
.tile-spark{grid-area:spark;width:30px;height:30px;display:flex;align-items:flex-end;justify-content:center;}
.tile-spark span{display:block;width:12px;background:var(--accent);border-radius:3px;opacity:.85;}
.tile-lab{grid-area:lab;font-size:11px;color:var(--muted);}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;}
.panel-head h2{margin:0;font-size:15.5px;font-weight:700;} .panel-head .muted{font-size:11.5px;}
.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 9px 8px;border-bottom:1.5px solid var(--line-2);white-space:nowrap;}
thead th.tl{text-align:left;} thead th.ta-r{text-align:right;}
tbody td{padding:6px 9px;border-bottom:1px solid var(--line);white-space:nowrap;}
tbody tr:last-child td{border-bottom:none;}
.a-name{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;}
.heat{font-variant-numeric:tabular-nums;border-radius:4px;}
.tr-total td{border-top:2px solid var(--line-2);font-weight:700;background:var(--surface-2);}
.note{margin:12px 0 0;font-size:12px;color:var(--muted);}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}

@media (max-width:820px){ .kpis,.tiles{grid-template-columns:repeat(2,1fr);} }
@media (max-width:520px){ .wrap{padding:24px 14px;} .head h1{font-size:20px;} }
`;

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Остатки по артикулам и цветам</title><style>${css}</style></head><body>${body}</body></html>`;
const artifact = `<title>Остатки по артикулам и цветам (FBS)</title>\n<style>${css}</style>\n${body}`;
fs.writeFileSync(R('fbs-stock-articles.html'), page);
fs.writeFileSync(R('fbs-stock-articles.artifact.html'), artifact);
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-stock-articles.html'))} (${(page.length / 1024).toFixed(1)} КБ) · строк ${articles.length}\n`);
