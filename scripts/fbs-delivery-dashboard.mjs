// scripts/fbs-delivery-dashboard.mjs — дашборд «Передано в доставку по дням» (FBS).
//
// По аналогии со сторонним примером «Выберите день»: плитки по дням (сегодня —
// «заданий в плане», прошедшие — «фактически передано в доставку»), плюс
// суточный график и разбивка по нашим фулфилментам.
//
//   npm run fbs:delivery:dash     # из reports-output/fbs-delivery-daily.json
//
// Выход: reports-output/fbs-delivery-dashboard.html и .artifact.html

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);
const snap = JSON.parse(fs.readFileSync(R('fbs-delivery-daily.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');
const pct = (n, d) => (d ? (n / d) * 100 : 0);

const dU = (date) => new Date(date + 'T00:00:00Z');
const dayNum = (date) => dU(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const weekday = (date) => dU(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short' });

const days = snap.days;
const past = days.filter((d) => !d.isToday);
const maxTotal = Math.max(1, ...days.map((d) => d.total));
const avgPast = past.length ? Math.round(past.reduce((s, d) => s + d.total, 0) / past.length) : 0;

// Плитки по дням.
const tiles = days.map((d) => {
  const h = pct(d.total, maxTotal);
  return `<article class="tile ${d.isToday ? 'today' : ''}">
    <div class="tile-head">
      <span class="tile-day">${d.isToday ? 'Сегодня' : esc(dayNum(d.date))}</span>
      <span class="tile-dow">${d.isToday ? esc(dayNum(d.date)) : esc(weekday(d.date))}</span>
    </div>
    <div class="tile-num">${nf(d.total)}</div>
    <div class="tile-spark"><span style="height:${Math.max(6, h).toFixed(0)}%"></span></div>
    <div class="tile-lab">${d.isToday ? 'заданий в плане' : 'передано в доставку'}</div>
  </article>`;
}).join('');

// Разбивка по фулфилментам: строки — склады, столбцы — дни.
const fulfillments = snap.fulfillments;
const cellMax = Math.max(1, ...days.flatMap((d) => Object.values(d.byFulfillment)));
const headDays = days.map((d) => `<th class="ta-c ${d.isToday ? 'col-today' : ''}">${d.isToday ? 'Сег.' : esc(dU(d.date).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }))}</th>`).join('');
const fRows = fulfillments.map((name) => {
  const sum7 = past.reduce((s, d) => s + (d.byFulfillment[name] || 0), 0);
  const cells = days.map((d) => {
    const v = d.byFulfillment[name] || 0;
    const a = v ? (0.14 + 0.86 * pct(v, cellMax) / 100).toFixed(3) : 0;
    return `<td class="ta-c heat ${d.isToday ? 'col-today' : ''}" style="${v ? `background:rgba(27,150,90,${a});color:${a > 0.55 ? '#fff' : 'inherit'}` : ''}">${v || '·'}</td>`;
  }).join('');
  return `<tr><td class="f-name">${esc(name)}</td>${cells}<td class="ta-r num strong">${nf(sum7)}</td></tr>`;
}).join('');
const totalRow = (() => {
  const cells = days.map((d) => `<td class="ta-c num ${d.isToday ? 'col-today' : ''}">${nf(d.total)}</td>`).join('');
  return `<tr class="tr-total"><td class="f-name">Всего</td>${cells}<td class="ta-r num strong">${nf(snap.factTotal7d)}</td></tr>`;
})();

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · передано в доставку</p>
      <h1>Количество переданных в доставку товаров</h1>
      <p class="sub">В прошедших днях показано фактически переданное в доставку количество заданий по нашим фулфилментам. Сегодня — задания в плане (созданные сегодня).</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b><br><span class="muted">пояс: МСК (${esc(snap.tz)})</span></div>
  </header>

  <section class="kpis">
    <div class="kpi kpi-accent"><div class="kpi-num">${nf(snap.factTotal7d)}</div><div class="kpi-lab">передано в доставку за ${snap.pastDays} дн.</div></div>
    <div class="kpi"><div class="kpi-num">${nf(avgPast)}</div><div class="kpi-lab">в среднем в день</div></div>
    <div class="kpi"><div class="kpi-num">${nf(snap.planToday)}</div><div class="kpi-lab">в плане сегодня</div></div>
    <div class="kpi"><div class="kpi-num">${fulfillments.length}</div><div class="kpi-lab">активных фулфилментов</div></div>
  </section>

  <section class="tiles">${tiles}</section>

  <section class="panel">
    <div class="panel-head"><h2>По фулфилментам · передано в доставку по дням</h2><span class="muted">насыщенность = объём; последний столбец — сумма за ${snap.pastDays} дн.</span></div>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th class="tl">Фулфилмент</th>${headDays}<th class="ta-r">Σ ${snap.pastDays}дн</th></tr></thead>
      <tbody>${fRows}${totalRow}</tbody>
    </table></div>
    <p class="note">«Сег.» — план (создано сегодня), остальные столбцы — факт передачи в доставку (supply.closedAt). Точка «·» — ноль.</p>
  </section>

  <footer class="foot">Источник: WB API marketplace /api/v3/orders + /api/v3/supplies. Обновление: npm run fbs:delivery &amp;&amp; npm run fbs:delivery:dash</footer>
</div>`;

const css = `
:root{
  --ground:#EEF3EF; --surface:#FFFFFF; --surface-2:#F5F9F6;
  --ink:#12211A; --muted:#54695D; --faint:#8098; --faint:#88998F;
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
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}
.num,.kpi-num,.tile-num{font-variant-numeric:tabular-nums;}
.muted{color:var(--muted);} .strong{font-weight:700;}
.ta-c{text-align:center;} .ta-r{text-align:right;} .tl{text-align:left;}
.wrap{max-width:1120px;margin:0 auto;padding:36px 24px 56px;}

.head{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line);}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700;}
.head h1{margin:0;font-size:27px;font-weight:750;letter-spacing:-.02em;}
.sub{margin:8px 0 0;color:var(--muted);max-width:74ch;font-size:14px;}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5;}
.stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:var(--shadow);}
.kpi-accent{background:linear-gradient(165deg,var(--accent-soft),var(--surface));border-color:var(--line-2);}
.kpi-num{font-size:28px;font-weight:750;letter-spacing:-.02em;line-height:1;}
.kpi-lab{margin-top:6px;font-size:12px;color:var(--muted);}

.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px 13px;box-shadow:var(--shadow);
  display:grid;grid-template-columns:1fr auto;grid-template-areas:"head head" "num spark" "lab lab";align-items:center;gap:6px 10px;}
.tile.today{border:2px solid var(--accent);background:linear-gradient(165deg,var(--accent-soft),var(--surface));}
.tile-head{grid-area:head;display:flex;justify-content:space-between;align-items:baseline;gap:8px;}
.tile-day{font-size:14px;font-weight:700;}
.tile-dow{font-size:11.5px;color:var(--muted);text-transform:capitalize;}
.tile-num{grid-area:num;font-size:34px;font-weight:780;letter-spacing:-.03em;color:var(--accent-d);line-height:1;}
.tile.today .tile-num{color:var(--accent-d);}
.tile-spark{grid-area:spark;width:34px;height:34px;display:flex;align-items:flex-end;justify-content:center;}
.tile-spark span{display:block;width:14px;background:var(--accent);border-radius:3px;opacity:.85;}
.tile-lab{grid-area:lab;font-size:11.5px;color:var(--muted);margin-top:2px;}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;}
.panel-head h2{margin:0;font-size:15.5px;font-weight:700;}
.panel-head .muted{font-size:12px;}
.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 8px 8px;border-bottom:1.5px solid var(--line-2);white-space:nowrap;}
thead th.tl{text-align:left;} thead th.ta-r{text-align:right;}
.col-today{background:var(--accent-soft);}
tbody td{padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;}
tbody tr:last-child td{border-bottom:none;}
.f-name{font-weight:600;}
.heat{font-variant-numeric:tabular-nums;border-radius:4px;}
.tr-total td{border-top:2px solid var(--line-2);font-weight:700;background:var(--surface-2);}
.note{margin:12px 0 0;font-size:12px;color:var(--muted);}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}

@media (max-width:820px){ .kpis,.tiles{grid-template-columns:repeat(2,1fr);} }
@media (max-width:520px){ .wrap{padding:24px 14px;} .head h1{font-size:22px;} }
`;

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Передано в доставку — по дням</title><style>${css}</style></head><body>${body}</body></html>`;
const artifact = `<title>Передано в доставку — по дням (FBS)</title>\n<style>${css}</style>\n${body}`;
fs.writeFileSync(R('fbs-delivery-dashboard.html'), page);
fs.writeFileSync(R('fbs-delivery-dashboard.artifact.html'), artifact);
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-delivery-dashboard.html'))} (${(page.length / 1024).toFixed(1)} КБ)\n`);
