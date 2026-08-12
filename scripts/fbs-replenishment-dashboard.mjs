// scripts/fbs-replenishment-dashboard.mjs — дашборд «Дни до нуля и дозаказ» (FBS).
//
// Читает reports-output/fbs-replenishment.json (npm run fbs:replenish).
// Показывает по каждому артикул+цвету: остаток, скорость расхода, на сколько
// дней хватит, сколько дозаказать до целевого покрытия, и где лежит остаток.
//
//   npm run fbs:replenish:dash
// Выход: reports-output/fbs-replenishment-dashboard.html и .artifact.html

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const R = (p) => path.join(REPO, 'reports-output', p);
const snap = JSON.parse(fs.readFileSync(R('fbs-replenishment.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');
const t = snap.totals;

const STATUS = {
  'нет остатка': 'crit', 'риск': 'warn', 'ок': 'ok', 'неликвид': 'dead', 'нет спроса': 'mute',
};
const dtzClass = (d) => (d == null ? 'ok' : d <= snap.lowThresholdDays ? 'crit' : d <= snap.targetDays ? 'warn' : 'ok');

const rows = snap.rows.map((r) => {
  const where = Object.entries(r.stockByWarehouse || {}).sort((a, b) => b[1] - a[1])
    .map(([n, q]) => `<span class="chip">${esc(n)}<b>${nf(q)}</b></span>`).join('') || '<span class="muted">—</span>';
  return `<tr class="row-${STATUS[r.status] || 'mute'}">
    <td class="a-name">${esc(r.vendorCode)}</td>
    <td class="mono muted">${esc(r.nmID)}</td>
    <td class="ta-r num">${nf(r.stock)}</td>
    <td class="ta-r num">${r.perDay.toLocaleString('ru-RU')}</td>
    <td class="ta-r num dtz ${dtzClass(r.daysToZero)}">${r.daysToZero == null ? '∞' : r.daysToZero}</td>
    <td class="ta-r num reorder">${r.reorderQty ? nf(r.reorderQty) : '·'}</td>
    <td class="where">${where}</td>
    <td><span class="pill pill-${STATUS[r.status] || 'mute'}">${esc(r.status)}</span></td>
  </tr>`;
}).join('');

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · пополнение</p>
      <h1>Дни до нуля и рекомендации к дозаказу</h1>
      <p class="sub">По каждому артикулу и цвету (карточка nmID) суммарно по нашим складам: текущий остаток, скорость расхода за ${snap.velocityDays} дн., на сколько дней хватит и сколько дозаказать до покрытия в ${snap.targetDays} дн. Порог риска — ≤ ${snap.lowThresholdDays} дн.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>

  <section class="kpis">
    <div class="kpi kpi-crit"><div class="kpi-num">${nf(t.reorderUnits)}</div><div class="kpi-lab">штук к дозаказу (всего)</div></div>
    <div class="kpi kpi-warn"><div class="kpi-num">${nf(t.risk)}</div><div class="kpi-lab">артикулов в риске / без остатка</div></div>
    <div class="kpi"><div class="kpi-num">${nf(t.outOfStock)}</div><div class="kpi-lab">уже 0 при наличии спроса</div></div>
    <div class="kpi"><div class="kpi-num">${nf(t.stockUnits)}</div><div class="kpi-lab">штук на складах сейчас</div></div>
    <div class="kpi"><div class="kpi-num">${t.demandPerDay.toLocaleString('ru-RU')}</div><div class="kpi-lab">спрос, шт/день</div></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>Что дозаказать</h2><span class="muted">строки отсортированы по срочности; красный — уже 0, жёлтый — заканчивается</span></div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th class="tl">Артикул + цвет</th><th class="tl">nmID</th>
        <th class="ta-r">Остаток</th><th class="ta-r">Спрос/дн</th><th class="ta-r">Дни до 0</th>
        <th class="ta-r">Дозаказать</th><th class="tl">Где остаток</th><th class="tl">Статус</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">Спрос/дн = заказы за ${snap.velocityDays} дн. ÷ ${snap.velocityDays}. Дозаказать = спрос/дн × ${snap.targetDays} − остаток. «∞» — есть остаток, но спроса за окно не было (кандидат в неликвид). Считается суммарно по всем нашим складам; «Где остаток» показывает физическое распределение (для ребаланса).</p>
  </section>

  <footer class="foot">Источник: WB API marketplace /api/v3/orders (спрос) + /api/v3/stocks/{id} (остаток). Обновление: npm run fbs:stock &amp;&amp; npm run fbs:replenish &amp;&amp; npm run fbs:replenish:dash</footer>
</div>`;

const css = `
:root{
  --ground:#EEF3EF; --surface:#FFFFFF; --surface-2:#F5F9F6;
  --ink:#12211A; --muted:#54695D; --faint:#88998F;
  --line:#DDE7E0; --line-2:#C7D6CC;
  --accent:#1B965A; --accent-d:#127045; --accent-soft:#E1F3E9;
  --crit:#C43A50; --crit-soft:#FBE7EA; --warn:#B7791F; --warn-soft:#FaF0DA; --ok:#16875A; --ok-soft:#E4F3EC; --dead:#7A8798;
  --shadow:0 1px 2px rgba(18,33,26,.04),0 4px 16px rgba(18,33,26,.06);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B;
  --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038;
  --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --crit:#F0708A; --crit-soft:#2E1620; --warn:#E7B24C; --warn-soft:#2C2410; --ok:#3FBE86; --ok-soft:#12271C; --dead:#6B7686;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}}
:root[data-theme="dark"]{
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B;
  --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038;
  --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --crit:#F0708A; --crit-soft:#2E1620; --warn:#E7B24C; --warn-soft:#2C2410; --ok:#3FBE86; --ok-soft:#12271C; --dead:#6B7686;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.88em;}
.num{font-variant-numeric:tabular-nums;} .muted{color:var(--muted);} .strong{font-weight:700;}
.ta-r{text-align:right;} .tl{text-align:left;}
.wrap{max-width:1180px;margin:0 auto;padding:36px 24px 56px;}

.head{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line);}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700;}
.head h1{margin:0;font-size:26px;font-weight:750;letter-spacing:-.02em;text-wrap:balance;}
.sub{margin:8px 0 0;color:var(--muted);max-width:82ch;font-size:14px;}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5;}
.stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:22px 0;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 16px;box-shadow:var(--shadow);}
.kpi-crit{background:linear-gradient(165deg,var(--crit-soft),var(--surface));}
.kpi-warn{background:linear-gradient(165deg,var(--warn-soft),var(--surface));}
.kpi-num{font-size:26px;font-weight:750;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums;}
.kpi-crit .kpi-num{color:var(--crit);} .kpi-warn .kpi-num{color:var(--warn);}
.kpi-lab{margin-top:6px;font-size:11.5px;color:var(--muted);}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow);}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;}
.panel-head h2{margin:0;font-size:15.5px;font-weight:700;} .panel-head .muted{font-size:11.5px;}
.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 9px 8px;border-bottom:1.5px solid var(--line-2);white-space:nowrap;}
thead th.ta-r{text-align:right;}
tbody td{padding:7px 9px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle;}
tbody tr:last-child td{border-bottom:none;}
.a-name{font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;}
.row-crit .a-name{box-shadow:inset 3px 0 0 var(--crit);padding-left:11px;}
.row-warn .a-name{box-shadow:inset 3px 0 0 var(--warn);padding-left:11px;}
.dtz.crit{color:var(--crit);font-weight:700;} .dtz.warn{color:var(--warn);font-weight:700;} .dtz.ok{color:var(--muted);}
.reorder{font-weight:700;}
.where{white-space:normal;max-width:280px;}
.chip{display:inline-flex;gap:4px;align-items:baseline;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin:1px 3px 1px 0;font-size:11.5px;color:var(--muted);}
.chip b{color:var(--ink);font-variant-numeric:tabular-nums;}
.pill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;}
.pill-crit{background:var(--crit-soft);color:var(--crit);} .pill-warn{background:var(--warn-soft);color:var(--warn);}
.pill-ok{background:var(--ok-soft);color:var(--ok);} .pill-dead{background:var(--surface-2);color:var(--dead);} .pill-mute{background:var(--surface-2);color:var(--muted);}
.note{margin:12px 0 0;font-size:12px;color:var(--muted);}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}

@media (max-width:1000px){ .kpis{grid-template-columns:repeat(3,1fr);} }
@media (max-width:560px){ .wrap{padding:24px 14px;} .kpis{grid-template-columns:repeat(2,1fr);} .head h1{font-size:21px;} }
`;

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Дни до нуля и дозаказ</title><style>${css}</style></head><body>${body}</body></html>`;
const artifact = `<title>Дни до нуля и дозаказ (FBS)</title>\n<style>${css}</style>\n${body}`;
fs.writeFileSync(R('fbs-replenishment-dashboard.html'), page);
fs.writeFileSync(R('fbs-replenishment-dashboard.artifact.html'), artifact);
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-replenishment-dashboard.html'))} (${(page.length / 1024).toFixed(1)} КБ)\n`);
