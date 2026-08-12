// scripts/fbs-replenishment-dashboard.mjs — дашборд подсорта FBS (по каждому складу).
//
// Читает reports-output/fbs-replenishment.json (npm run fbs:replenish).
// По каждому FF-складу отдельно: остаток, скорость, дни до нуля и подсорт с
// учётом лид-тайма (12–18 дн). Сортировка: артикул → цвет → количество.
// Плюс блок «Новинки» (номенклатура, ни разу не заводившаяся на FF) на завоз.
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
const P = snap.params, t = snap.totals;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString('ru-RU');

const STATUS = {
  'нет остатка': 'crit', 'разрыв до поставки': 'crit', 'риск разрыва': 'warn',
  'ок': 'ok', 'неликвид': 'dead', 'нет данных': 'mute',
};
const STATUS_ORDER = ['разрыв до поставки', 'нет остатка', 'риск разрыва', 'ок', 'неликвид', 'нет данных'];
const dtzClass = (d) => (d == null ? 'ok' : d < P.leadMin ? 'crit' : d < P.leadMax ? 'warn' : 'ok');

// Разбивка статусов по цветам (по всем строкам всех складов).
const statusAgg = {};
for (const w of snap.warehouses) for (const r of w.rows) {
  const a = statusAgg[r.status] || { count: 0, reorder: 0 };
  a.count += 1; a.reorder += r.reorderQty || 0; statusAgg[r.status] = a;
}
const statusList = STATUS_ORDER.filter((s) => statusAgg[s]);
const statusTotalRows = Object.values(statusAgg).reduce((s, a) => s + a.count, 0) || 1;
const statusBar = statusList.map((s) => `<span class="seg seg-${STATUS[s]}" style="width:${(statusAgg[s].count / statusTotalRows * 100).toFixed(2)}%" title="${s}: ${statusAgg[s].count}"></span>`).join('');
const statusLegend = statusList.map((s) => `<div class="lg"><span class="dot dot-${STATUS[s]}"></span><span class="lg-lab">${s}</span><span class="lg-num">${nf(statusAgg[s].count)}</span><span class="lg-sub">${statusAgg[s].reorder ? '+' + nf(statusAgg[s].reorder) + ' шт' : ''}</span></div>`).join('');

// Секция склада.
const whSection = (w) => {
  const rows = w.rows.map((r) => `<tr class="row-${STATUS[r.status] || 'mute'}">
      <td class="art">${esc(r.articleNum || '—')}</td>
      <td class="a-name">${esc(r.variant)}</td>
      <td class="mono muted">${esc(r.nmID)}</td>
      <td class="ta-r num">${nf(r.stock)}</td>
      <td class="ta-r num">${r.perDay.toLocaleString('ru-RU')}</td>
      <td class="ta-r num dtz ${dtzClass(r.daysToZero)}">${r.daysToZero == null ? '∞' : r.daysToZero}</td>
      <td class="ta-r num reorder">${r.reorderQty ? nf(r.reorderQty) : '·'}</td>
      <td><span class="pill pill-${STATUS[r.status] || 'mute'}">${esc(r.status)}</span></td>
    </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head">
      <h2>${esc(w.name)}</h2>
      <span class="wh-tot">остаток <b>${nf(w.stockUnits)}</b> · к подсорту <b class="accent">${nf(w.reorderUnits)}</b> шт · в риске <b class="crit">${nf(w.riskCount)}</b></span>
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th class="ta-r">Арт</th><th class="tl">Цвет / вариант</th><th class="tl">nmID</th><th class="ta-r">Остаток</th><th class="ta-r">Спрос/дн</th><th class="ta-r">Дни до 0</th><th class="ta-r">Подсорт</th><th class="tl">Статус</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
};
const whSections = snap.warehouses.map(whSection).join('');

// Новинки — матрица артикул × склад (завоз seed на каждый фулфилмент).
const seedWh = (snap.newProducts?.[0] && Object.keys(snap.newProducts[0].seedByWarehouse)) || snap.warehouses.map((w) => w.name);
const newHeadWh = seedWh.map((n) => `<th class="ta-r">${esc(n)}</th>`).join('');
const newRows = (snap.newProducts || []).map((n) => `<tr>
    <td class="art">${esc(n.articleNum || '—')}</td>
    <td class="a-name">${esc(n.variant)}</td>
    <td class="mono muted">${esc(n.nmID)}</td>
    ${seedWh.map((w) => `<td class="ta-r num">${nf(n.seedByWarehouse[w] || 0)}</td>`).join('')}
    <td class="ta-r num reorder">${nf(n.seedTotal)}</td>
  </tr>`).join('');
const newSection = (snap.newProducts || []).length ? `<section class="panel">
    <div class="panel-head"><h2>Новинки — завезти для старта</h2><span class="wh-tot">${nf(t.newProducts)} позиций · по ${nf(P.seedMin)} шт на каждый из ${nf(t.seedWarehouses)} складов · итого ${nf(t.seedUnits)} шт</span></div>
    <p class="note">Товары из номенклатуры, которые ни разу не заводились ни на один FF-склад (нет остатка и нет заказов за ${P.historyDays} дн). Заводим по ${nf(P.seedMin)} шт на КАЖДЫЙ действующий фулфилмент, чтобы начать мерить скорость продаж отдельно по складу, а дальше считать подсорт как обычно.</p>
    <div class="table-scroll"><table>
      <thead><tr><th class="ta-r">Арт</th><th class="tl">Цвет / вариант</th><th class="tl">nmID</th>${newHeadWh}<th class="ta-r">Итого</th></tr></thead>
      <tbody>${newRows}</tbody>
    </table></div>
  </section>` : '';

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · подсорт по складам</p>
      <h1>Подсорт по фулфилмент-складам</h1>
      <p class="sub">Расчёт для КАЖДОГО склада отдельно (только FF/FBS): остаток, скорость продаж за ${P.velocityDays} дн., дни до нуля и рекомендация к подсорту. Заказ рассчитан на горизонт <b>${P.horizonDays} дн</b> = лид-тайм до ${P.leadMax} дн (сборка + доставка на FF) + запас ${P.coverDays} дн. Строки отсортированы: артикул → цвет → количество.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>

  <section class="kpis">
    <div class="kpi kpi-accent"><div class="kpi-num">${nf(t.reorderUnits)}</div><div class="kpi-lab">штук к подсорту (всего)</div></div>
    <div class="kpi kpi-crit"><div class="kpi-num">${nf(t.riskRows)}</div><div class="kpi-lab">строк в риске разрыва</div></div>
    <div class="kpi"><div class="kpi-num">${nf(t.newProducts)}</div><div class="kpi-lab">новинок к заводу</div></div>
    <div class="kpi"><div class="kpi-num">${nf(t.seedUnits)}</div><div class="kpi-lab">штук на завоз новинок</div></div>
    <div class="kpi"><div class="kpi-num">${nf(t.warehouses)}</div><div class="kpi-lab">складов в расчёте</div></div>
  </section>

  <section class="statusbar">
    <div class="statusbar-head"><h2>Статусы товаров</h2><span class="muted">${nf(statusTotalRows)} строк (склад×артикул) · цвета как в таблицах</span></div>
    <div class="sbar">${statusBar}</div>
    <div class="legend">${statusLegend}</div>
    <p class="note">«разрыв до поставки» = закончится раньше, чем за ${P.leadMin} дн — подсорт не успеет доехать; «риск разрыва» = может не дожить до ${P.leadMax} дн.</p>
  </section>

  ${whSections}
  ${newSection}

  <footer class="foot">Источник: WB API marketplace /api/v3/orders (спрос по складу) + /api/v3/stocks/{id} (остаток) + content/v2/get/cards/list (номенклатура). Обновление: npm run fbs:stock &amp;&amp; npm run fbs:replenish &amp;&amp; npm run fbs:replenish:dash</footer>
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
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B; --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038; --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --crit:#F0708A; --crit-soft:#2E1620; --warn:#E7B24C; --warn-soft:#2C2410; --ok:#3FBE86; --ok-soft:#12271C; --dead:#6B7686;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}}
:root[data-theme="dark"]{
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B; --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038; --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --crit:#F0708A; --crit-soft:#2E1620; --warn:#E7B24C; --warn-soft:#2C2410; --ok:#3FBE86; --ok-soft:#12271C; --dead:#6B7686;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em;}
.num{font-variant-numeric:tabular-nums;} .muted{color:var(--muted);} .accent{color:var(--accent-d);} .crit{color:var(--crit);}
.ta-r{text-align:right;} .tl{text-align:left;}
.wrap{max-width:1180px;margin:0 auto;padding:36px 24px 56px;}

.head{padding-bottom:18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:22px;flex-wrap:wrap;align-items:flex-start;}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700;}
.head h1{margin:0;font-size:26px;font-weight:750;letter-spacing:-.02em;}
.sub{margin:8px 0 0;color:var(--muted);max-width:92ch;font-size:13.5px;}
.sub b{color:var(--ink);}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5;} .stamp b{color:var(--ink);font-variant-numeric:tabular-nums;}

.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:22px 0;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 16px;box-shadow:var(--shadow);}
.kpi-accent{background:linear-gradient(165deg,var(--accent-soft),var(--surface));border-color:var(--line-2);}
.kpi-crit{background:linear-gradient(165deg,var(--crit-soft),var(--surface));}
.kpi-num{font-size:25px;font-weight:750;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums;}
.kpi-accent .kpi-num{color:var(--accent-d);} .kpi-crit .kpi-num{color:var(--crit);}
.kpi-lab{margin-top:6px;font-size:11.5px;color:var(--muted);}

.statusbar{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 20px;box-shadow:var(--shadow);margin-bottom:18px;}
.statusbar-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:11px;flex-wrap:wrap;}
.statusbar-head h2{margin:0;font-size:14px;font-weight:700;} .statusbar-head .muted{font-size:11.5px;}
.sbar{display:flex;height:16px;border-radius:6px;overflow:hidden;background:var(--surface-2);}
.sbar .seg{display:block;height:100%;}
.seg-crit{background:var(--crit);} .seg-warn{background:var(--warn);} .seg-ok{background:var(--ok);} .seg-dead{background:var(--dead);} .seg-mute{background:var(--line-2);}
.legend{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:12px;}
.lg{display:flex;align-items:center;gap:8px;font-size:12.5px;}
.lg .dot{width:10px;height:10px;border-radius:3px;flex:none;}
.dot-crit{background:var(--crit);} .dot-warn{background:var(--warn);} .dot-ok{background:var(--ok);} .dot-dead{background:var(--dead);} .dot-mute{background:var(--line-2);}
.lg-lab{color:var(--muted);} .lg-num{font-weight:700;font-variant-numeric:tabular-nums;} .lg-sub{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums;}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:var(--shadow);margin-bottom:16px;}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px;flex-wrap:wrap;border-left:3px solid var(--accent);padding-left:10px;}
.panel-head h2{margin:0;font-size:16px;font-weight:750;}
.wh-tot{font-size:12.5px;color:var(--muted);} .wh-tot b{color:var(--ink);font-variant-numeric:tabular-nums;}
.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 9px 8px;border-bottom:1.5px solid var(--line-2);white-space:nowrap;}
thead th.ta-r{text-align:right;}
tbody td{padding:6px 9px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle;}
tbody tr:last-child td{border-bottom:none;}
.art{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--muted);}
.a-name{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;}
.row-crit .art{box-shadow:inset 3px 0 0 var(--crit);}
.row-warn .art{box-shadow:inset 3px 0 0 var(--warn);}
.dtz.crit{color:var(--crit);font-weight:700;} .dtz.warn{color:var(--warn);font-weight:700;} .dtz.ok{color:var(--muted);}
.reorder{font-weight:700;}
.pill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;}
.pill-crit{background:var(--crit-soft);color:var(--crit);} .pill-warn{background:var(--warn-soft);color:var(--warn);}
.pill-ok{background:var(--ok-soft);color:var(--ok);} .pill-dead{background:var(--surface-2);color:var(--dead);} .pill-mute{background:var(--surface-2);color:var(--muted);}
.note{margin:10px 0 0;font-size:12px;color:var(--muted);}
.foot{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);}

@media (max-width:1000px){ .kpis{grid-template-columns:repeat(3,1fr);} }
@media (max-width:560px){ .wrap{padding:24px 14px;} .kpis{grid-template-columns:repeat(2,1fr);} .head h1{font-size:21px;} }
`;

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Подсорт по складам FBS</title><style>${css}</style></head><body>${body}</body></html>`;
const artifact = `<title>Подсорт по складам FBS</title>\n<style>${css}</style>\n${body}`;
fs.writeFileSync(R('fbs-replenishment-dashboard.html'), page);
fs.writeFileSync(R('fbs-replenishment-dashboard.artifact.html'), artifact);
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-replenishment-dashboard.html'))} (${(page.length / 1024).toFixed(1)} КБ)\n`);
