// scripts/fbs-accepted-dashboard.mjs — дашборд «Количество принятых на фулфилмент
// товаров» (#2), плюс баланс «передано − принято» по дням и складам.
//
// Читает reports-output/fbs-delivery-daily.json (npm run fbs:delivery).
//   принято  = сборочные задания, поступившие в работу (созданы в этот день);
//   передано = переданы в доставку (supply.closedAt);
//   разница  = передано − принято (нетто-поток за день).
//
//   npm run fbs:accepted:dash
// Выход: reports-output/fbs-accepted-dashboard.html и .artifact.html

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
const sgn = (n) => (n > 0 ? '+' : '') + nf(n);
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const dU = (date) => new Date(date + 'T00:00:00Z');
const dayNum = (date) => dU(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const weekday = (date) => dU(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short' });
const dm = (date) => dU(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });

const days = snap.days;
const past = days.filter((d) => !d.isToday);
const maxAccepted = Math.max(1, ...days.map((d) => d.accepted.total));
const avgAccepted = past.length ? Math.round(past.reduce((s, d) => s + d.accepted.total, 0) / past.length) : 0;

// Плитки: принято за день + бейдж разницы (только для закрытых дней).
const tiles = days.map((d) => {
  const h = pct(d.accepted.total, maxAccepted);
  const badge = d.isToday
    ? `<span class="delta muted">день не закрыт</span>`
    : `<span class="delta ${d.diff.total >= 0 ? 'pos' : 'neg'}">${sgn(d.diff.total)} к передаче</span>`;
  return `<article class="tile ${d.isToday ? 'today' : ''}">
    <div class="tile-head"><span class="tile-day">${d.isToday ? 'Сегодня' : esc(dayNum(d.date))}</span><span class="tile-dow">${d.isToday ? esc(dayNum(d.date)) : esc(weekday(d.date))}</span></div>
    <div class="tile-num">${nf(d.accepted.total)}</div>
    <div class="tile-spark"><span style="height:${Math.max(6, h).toFixed(0)}%"></span></div>
    <div class="tile-lab">${d.isToday ? 'принято сегодня' : 'принято на ФФ'}</div>
    <div class="tile-badge">${badge}</div>
  </article>`;
}).join('');

const fulfillments = snap.fulfillments;
const headDays = days.map((d) => `<th class="ta-c ${d.isToday ? 'col-today' : ''}">${d.isToday ? 'Сег.' : esc(dm(d.date))}</th>`).join('');

// Матрица «принято» (зелёная насыщенность).
const accMax = Math.max(1, ...days.flatMap((d) => Object.values(d.accepted.byFulfillment)));
const accRows = fulfillments.map((name) => {
  const sum7 = past.reduce((s, d) => s + (d.accepted.byFulfillment[name] || 0), 0);
  const cells = days.map((d) => {
    const v = d.accepted.byFulfillment[name] || 0;
    const a = v ? (0.14 + 0.86 * pct(v, accMax) / 100).toFixed(3) : 0;
    return `<td class="ta-c heat ${d.isToday ? 'col-today' : ''}" style="${v ? `background:rgba(27,150,90,${a});color:${a > 0.55 ? '#fff' : 'inherit'}` : ''}">${v || '·'}</td>`;
  }).join('');
  return `<tr><td class="f-name">${esc(name)}</td>${cells}<td class="ta-r num strong">${nf(sum7)}</td></tr>`;
}).join('');
const accTotalRow = `<tr class="tr-total"><td class="f-name">Всего</td>${days.map((d) => `<td class="ta-c num ${d.isToday ? 'col-today' : ''}">${nf(d.accepted.total)}</td>`).join('')}<td class="ta-r num strong">${nf(snap.acceptedTotal7d)}</td></tr>`;

// Матрица «разница передано − принято» (расходящаяся: + зелёный, − красный).
const diffMax = Math.max(1, ...days.flatMap((d) => Object.values(d.diff.byFulfillment).map(Math.abs)));
const diffCell = (v, today) => {
  if (!v) return `<td class="ta-c heat ${today ? 'col-today' : ''}">·</td>`;
  const a = (0.16 + 0.84 * Math.abs(v) / diffMax).toFixed(3);
  const color = v > 0 ? `39,150,90` : `210,69,90`;
  return `<td class="ta-c heat ${today ? 'col-today' : ''}" style="background:rgba(${color},${a});color:${a > 0.5 ? '#fff' : 'inherit'}">${sgn(v)}</td>`;
};
const diffRows = fulfillments.map((name) => {
  const sum7 = past.reduce((s, d) => s + (d.diff.byFulfillment[name] || 0), 0);
  const cells = days.map((d) => diffCell(d.diff.byFulfillment[name] || 0, d.isToday)).join('');
  return `<tr><td class="f-name">${esc(name)}</td>${cells}<td class="ta-r num strong ${sum7 >= 0 ? 'pos' : 'neg'}">${sgn(sum7)}</td></tr>`;
}).join('');
const diffTotalRow = `<tr class="tr-total"><td class="f-name">Всего</td>${days.map((d) => `<td class="ta-c num ${d.isToday ? 'col-today' : ''} ${d.diff.total >= 0 ? 'pos' : 'neg'}">${sgn(d.diff.total)}</td>`).join('')}<td class="ta-r num strong ${snap.diffTotal7d >= 0 ? 'pos' : 'neg'}">${sgn(snap.diffTotal7d)}</td></tr>`;

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · принято на фулфилмент</p>
      <h1>Количество принятых на фулфилмент товаров</h1>
      <p class="sub">Сколько заданий поступило в работу на наши фулфилменты по дням (создано за день), и баланс «передано в доставку − принято» — нетто-поток через фулфилмент.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b><br><span class="muted">пояс: МСК (${esc(snap.tz)})</span></div>
  </header>

  <section class="kpis">
    <div class="kpi kpi-accent"><div class="kpi-num">${nf(snap.acceptedTotal7d)}</div><div class="kpi-lab">принято за ${snap.pastDays} дн.</div></div>
    <div class="kpi"><div class="kpi-num">${nf(snap.factTotal7d)}</div><div class="kpi-lab">передано за ${snap.pastDays} дн.</div></div>
    <div class="kpi kpi-diff ${snap.diffTotal7d >= 0 ? 'pos' : 'neg'}"><div class="kpi-num">${sgn(snap.diffTotal7d)}</div><div class="kpi-lab">разница (передано − принято)</div></div>
    <div class="kpi"><div class="kpi-num">${nf(avgAccepted)}</div><div class="kpi-lab">в среднем принято / день</div></div>
  </section>

  <section class="tiles">${tiles}</section>

  <section class="panel">
    <div class="panel-head"><h2>Разница: передано − принято</h2><span class="muted">+ зелёный = отгрузили больше, чем приняли · − красный = приняли больше (растёт backlog)</span></div>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th class="tl">Фулфилмент</th>${headDays}<th class="ta-r">Σ ${snap.pastDays}дн</th></tr></thead>
      <tbody>${diffRows}${diffTotalRow}</tbody>
    </table></div>
    <p class="note">«Сег.» день не закрыт — передача ещё идёт, поэтому разница за сегодня не показательна.</p>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Принято на фулфилмент по дням</h2><span class="muted">насыщенность = объём; последний столбец — сумма за ${snap.pastDays} дн.</span></div>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th class="tl">Фулфилмент</th>${headDays}<th class="ta-r">Σ ${snap.pastDays}дн</th></tr></thead>
      <tbody>${accRows}${accTotalRow}</tbody>
    </table></div>
  </section>

  <footer class="foot">Источник: WB API marketplace /api/v3/orders (принято = создано) + /api/v3/supplies (передано = closedAt). Обновление: npm run fbs:delivery &amp;&amp; npm run fbs:accepted:dash</footer>
</div>`;

const css = `
:root{
  --ground:#EEF3EF; --surface:#FFFFFF; --surface-2:#F5F9F6;
  --ink:#12211A; --muted:#54695D; --faint:#88998F;
  --line:#DDE7E0; --line-2:#C7D6CC;
  --accent:#1B965A; --accent-d:#127045; --accent-soft:#E1F3E9;
  --pos:#16875A; --neg:#C43A50;
  --shadow:0 1px 2px rgba(18,33,26,.04),0 4px 16px rgba(18,33,26,.06);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B;
  --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038;
  --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --pos:#3FBE86; --neg:#F0708A;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}}
:root[data-theme="dark"]{
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B;
  --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038;
  --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --pos:#3FBE86; --neg:#F0708A;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}
.num,.kpi-num,.tile-num{font-variant-numeric:tabular-nums;}
.muted{color:var(--muted);} .strong{font-weight:700;}
.pos{color:var(--pos);} .neg{color:var(--neg);}
.ta-c{text-align:center;} .ta-r{text-align:right;} .tl{text-align:left;}
.wrap{max-width:1120px;margin:0 auto;padding:36px 24px 56px;}

.head{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line);}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700;}
.head h1{margin:0;font-size:26px;font-weight:750;letter-spacing:-.02em;text-wrap:balance;}
.sub{margin:8px 0 0;color:var(--muted);max-width:76ch;font-size:14px;}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5;}
.stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:var(--shadow);}
.kpi-accent{background:linear-gradient(165deg,var(--accent-soft),var(--surface));border-color:var(--line-2);}
.kpi-diff.pos{background:linear-gradient(165deg,rgba(22,135,90,.12),var(--surface));}
.kpi-diff.neg{background:linear-gradient(165deg,rgba(196,58,80,.12),var(--surface));}
.kpi-diff .kpi-num{color:inherit;}
.kpi-num{font-size:28px;font-weight:750;letter-spacing:-.02em;line-height:1;}
.kpi-diff.pos .kpi-num{color:var(--pos);} .kpi-diff.neg .kpi-num{color:var(--neg);}
.kpi-lab{margin-top:6px;font-size:12px;color:var(--muted);}

.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px 13px;box-shadow:var(--shadow);
  display:grid;grid-template-columns:1fr auto;grid-template-areas:"head head" "num spark" "lab lab" "badge badge";align-items:center;gap:5px 10px;}
.tile.today{border:2px solid var(--accent);background:linear-gradient(165deg,var(--accent-soft),var(--surface));}
.tile-head{grid-area:head;display:flex;justify-content:space-between;align-items:baseline;gap:8px;}
.tile-day{font-size:14px;font-weight:700;} .tile-dow{font-size:11.5px;color:var(--muted);text-transform:capitalize;}
.tile-num{grid-area:num;font-size:33px;font-weight:780;letter-spacing:-.03em;color:var(--accent-d);line-height:1;}
.tile-spark{grid-area:spark;width:32px;height:32px;display:flex;align-items:flex-end;justify-content:center;}
.tile-spark span{display:block;width:13px;background:var(--accent);border-radius:3px;opacity:.85;}
.tile-lab{grid-area:lab;font-size:11.5px;color:var(--muted);}
.tile-badge{grid-area:badge;margin-top:4px;}
.delta{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;display:inline-block;}
.delta.pos{background:rgba(22,135,90,.14);color:var(--pos);} .delta.neg{background:rgba(196,58,80,.14);color:var(--neg);}
.delta.muted{background:var(--surface-2);color:var(--muted);font-weight:600;}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);margin-bottom:18px;}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;}
.panel-head h2{margin:0;font-size:15.5px;font-weight:700;} .panel-head .muted{font-size:11.5px;}
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
@media (max-width:520px){ .wrap{padding:24px 14px;} .head h1{font-size:21px;} }
`;

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Принято на фулфилмент — по дням</title><style>${css}</style></head><body>${body}</body></html>`;
const artifact = `<title>Принято на фулфилмент — по дням (FBS)</title>\n<style>${css}</style>\n${body}`;
fs.writeFileSync(R('fbs-accepted-dashboard.html'), page);
fs.writeFileSync(R('fbs-accepted-dashboard.artifact.html'), artifact);
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-accepted-dashboard.html'))} (${(page.length / 1024).toFixed(1)} КБ)\n`);
