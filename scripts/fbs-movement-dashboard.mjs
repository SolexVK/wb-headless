// scripts/fbs-movement-dashboard.mjs — HTML/PDF-дашборд «Движение заказов FBS».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-movement-service.json (снимок сервиса)
// Выход: fbs-movement-dashboard.html + .artifact.html
// COST_PER_UNIT (env) — себестоимость ₽/шт для оценки (по умолчанию 620).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, kpi, legend, hbars, lineChart, groupedBars, seriesColor, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-movement-service.json'), 'utf8'));
const stamp = (s.generatedAt || new Date().toISOString()).slice(0, 16).replace('T', ' ') + ' UTC';
const COST = Number(process.env.COST_PER_UNIT || 620) || 620;

const N = s.days || 14;
const ff = s.fulfillments || [];
const display = (s.series || []).slice(-N);
const labels = display.map((d) => d.date.slice(5));
const money = (v) => nf(v) + ' ₽';

// Итоги за период.
const sumC = (k) => display.reduce((a, d) => a + (d[k]?.count || 0), 0);
const sumF = (k, f) => display.reduce((a, d) => a + (d[k]?.[f] || 0), 0);
const accC = sumC('accepted'), delC = sumC('delivered');

const kpis = [
  kpi(nf(accC), `принято за ${N} дн`, 'kpi-accent'),
  kpi(nf(delC), `передано за ${N} дн`, 'kpi-accent'),
  kpi(`${delC - accC >= 0 ? '+' : ''}${nf(delC - accC)}`, 'разница (передано−принято)', delC - accC < 0 ? 'kpi-crit' : ''),
  kpi(nf(delC * COST), `себест. передано, ₽ (${nf(COST)}/шт)`),
  kpi(nf(sumF('delivered', 'moneyAvg')), 'ср. цена продажи, ₽'),
].join('');

// Тренд «передано по дням» по фулфилментам + Итого.
const lines = ff.map((n, i) => ({ name: n, color: seriesColor(i), values: display.map((d) => (d.delivered?.byFulfillment?.[n] || {}).count || 0) }));
const totalLine = { name: 'Итого', color: 'var(--ink)', bold: true, values: display.map((d) => d.delivered?.count || 0) };
const trendLines = ff.length > 1 ? [...lines, totalLine] : lines;
const trendLegend = legend(trendLines.map((l) => ({ label: l.name, color: l.color })));
const trendPanel = `<section class="panel">
  <div class="panel-head"><h2>Передано в доставку — по дням</h2><span class="panel-sub">${nf(delC)} шт за ${N} дн · по каждому фулфилменту</span></div>
  <div class="chart-wrap">${lineChart(trendLines, labels)}</div>
  ${trendLegend}
</section>`;

// Принято vs передано (по дням) + передано по фулфилментам (за период).
const groups = [
  { name: 'Принято', color: 'var(--s1)', values: display.map((d) => d.accepted?.count || 0) },
  { name: 'Передано', color: 'var(--accent)', values: display.map((d) => d.delivered?.count || 0) },
];
const gbLegend = legend(groups.map((g) => ({ label: g.name, color: g.color })));
const ffTotals = ff.map((n, i) => ({ label: n, value: display.reduce((a, d) => a + ((d.delivered?.byFulfillment?.[n] || {}).count || 0), 0), color: seriesColor(i) }))
  .sort((a, b) => b.value - a.value);
const midPanel = `<section class="panel">
  <div class="panel-head"><h2>Принято и передано · распределение по складам</h2></div>
  <div class="cols cols-2">
    <div><div class="chart-wrap">${groupedBars(labels, groups)}</div>${gbLegend}</div>
    <div class="chart-wrap">${hbars(ffTotals)}</div>
  </div>
</section>`;

// Оценка «передано» в деньгах — три базы.
const valItems = [
  { label: 'Себестоимость', value: delC * COST, sub: `${nf(COST)} ₽/шт` },
  { label: 'Ср. цена продажи 7д', value: sumF('delivered', 'moneyAvg') },
  { label: 'Цена заказа', value: sumF('delivered', 'money') },
];
const valPanel = `<section class="panel">
  <div class="panel-head"><h2>Оценка переданного объёма</h2><span class="panel-sub">${nf(delC)} шт за ${N} дн в трёх базах</span></div>
  <div class="chart-wrap">${hbars(valItems, { fmt: money })}</div>
</section>`;

// Таблица день × фулфилмент (передано).
const head = `<tr><th class="tl">День</th>${ff.map((n) => `<th class="ta-r">${esc(n)}</th>`).join('')}<th class="ta-r">Итого</th></tr>`;
const rows = display.map((d) => `<tr><td class="tl mono">${esc(d.date)}</td>${ff.map((n) => { const v = (d.delivered?.byFulfillment?.[n] || {}).count || 0; return `<td class="cellnum">${v ? nf(v) : ''}</td>`; }).join('')}<td class="cellnum"><b>${nf(d.delivered?.count || 0)}</b></td></tr>`).join('');
const colTot = ff.map((n) => display.reduce((a, d) => a + ((d.delivered?.byFulfillment?.[n] || {}).count || 0), 0));
const foot = `<tr><td class="tl">Итого</td>${colTot.map((v) => `<td class="cellnum">${nf(v)}</td>`).join('')}<td class="cellnum">${nf(delC)}</td></tr>`;
const tablePanel = `<section class="panel">
  <div class="panel-head"><h2>Передано по дням и складам</h2><span class="panel-sub">штук, за ${N} дн</span></div>
  <div class="table-scroll"><table><thead>${head}</thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div>
</section>`;

const artLine = (s.articles && s.articles.length) ? ` Только артикулы: ${esc(s.articles.join(', '))}.` : '';
const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · движение заказов</p>
      <h1>Движение заказов по фулфилментам</h1>
      <p class="sub">Принято на фулфилмент (создано сборочных заданий) и передано в доставку (закрыто поставок) за ${N} дней по каждому складу. Деловой день по МСК (${esc(s.tz || '+03:00')}).${artLine}${s.avgSalePrice ? ` Ср. цена продажи 7д: <b>${nf(s.avgSalePrice)} ₽</b>.` : ''}</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${trendPanel}
  ${midPanel}
  ${valPanel}
  ${tablePanel}
  <footer class="foot">Источник: WB API marketplace /api/v3/orders + /api/v3/supplies · statistics /api/v1/supplier/sales (ср. цена продажи). Себестоимость — оценка ${nf(COST)} ₽/шт.</footer>
</div>`;

fs.writeFileSync(R('fbs-movement-dashboard.html'), page('Движение заказов FBS — дашборд', body));
fs.writeFileSync(R('fbs-movement-dashboard.artifact.html'), artifact('Движение заказов FBS — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-movement-dashboard.html'))}\n`);
