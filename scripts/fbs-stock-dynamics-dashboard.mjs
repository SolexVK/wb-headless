// scripts/fbs-stock-dynamics-dashboard.mjs — HTML/PDF-дашборд «Динамика остатков».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-stock-series.json (ряд по дням, а не один снимок).
// Выход: fbs-stock-dynamics.html + .artifact.html
// Ряд: { from, to, count, dates:[...], warehouses:[{name, values:[...]}], grand:[...] }.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, kpi, panelHead, legend, lineChart, seriesColor, AC, page, artifact } from './lib/dashboard-kit.mjs';
import { stockMetrics, oosLabel } from './lib/agg/stock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-stock-series.json'), 'utf8'));

const last = (a) => (a && a.length ? a[a.length - 1] : 0);
const wh = s.warehouses || [];
const grandNow = last(s.grand);

const M = stockMetrics(s);
const kpisTop = [
  kpi(nf(grandNow), 'сейчас всего, шт', { icon: '📦', accent: AC.green }),
  M.grow ? kpi(`+${nf(M.grow.delta)}`, `вырос: ${esc(M.grow.name)}`, { icon: '📈', accent: AC.green }) : kpi('—', 'роста за период нет', { icon: '📈', accent: AC.teal }),
  M.drop ? kpi(nf(M.drop.delta), `просел: ${esc(M.drop.name)}`, { icon: '📉', accent: AC.red }) : kpi('—', 'падения за период нет', { icon: '📉', accent: AC.teal }),
].join('');
// Плашка на каждый ФФ: текущий остаток + оценка «дней до нуля».
const kpisFF = M.per.map((p) => kpi(nf(p.now), `${esc(p.name)} · ${esc(oosLabel(p.daysToZero))}`, { icon: '🏭', accent: p.daysToZero != null && p.daysToZero <= 14 ? AC.red : AC.blue })).join('');

let body;
if (!s.count || s.count < 2) {
  body = `<div class="wrap"><header class="head"><div><p class="eyebrow">Wildberries · FBS · остатки</p>
    <h1>Динамика остатков по фулфилментам</h1></div></header>
    <section class="panel"><p class="note">Недостаточно снимков для графика: сейчас ${nf(s.count || 0)}, нужно минимум 2. Ежедневные снимки остатков копятся автоматически — загляните позже.</p></section></div>`;
} else {
  const labels = s.dates.map((d) => String(d).slice(5)); // MM-DD
  const lines = [
    { name: 'Итого', color: AC.indigo, bold: true, values: s.grand },
    ...wh.map((w, i) => ({ name: w.name, color: seriesColor(i), values: w.values })),
  ];
  const leg = legend(lines.map((l) => ({ label: l.name, color: l.color })));
  const rows = M.per.map((p) => {
    const oos = p.daysToZero == null ? 'растёт/стаб.' : nf(p.daysToZero) + ' дн';
    return `<tr><td class="tl">${esc(p.name)}</td>
      <td class="cellnum" data-v="${p.first}">${nf(p.first)}</td>
      <td class="cellnum" data-v="${p.now}">${nf(p.now)}</td>
      <td class="cellnum" data-v="${p.delta}">${p.delta > 0 ? '+' : ''}${nf(p.delta)}</td>
      <td class="cellnum" data-v="${p.daysToZero == null ? 999999 : p.daysToZero}">${oos}</td>
      <td class="cellnum" data-v="${p.min}">${nf(p.min)}</td>
      <td class="cellnum" data-v="${p.max}">${nf(p.max)}</td></tr>`;
  }).join('');
  // Книжная ориентация именно для этого дашборда (переопределяет @page из dashboard-kit).
  const portrait = '<style>@page{size:A4 portrait;margin:12mm}</style>';
  body = `${portrait}<div class="wrap">
    <header class="head">
      <div>
        <p class="eyebrow">Wildberries · FBS · остатки</p>
        <h1>Динамика остатков по фулфилментам</h1>
        <p class="sub">Как менялось количество товара на каждом фулфилменте по накопленным ежедневным снимкам. Период ${esc(String(s.from))} → ${esc(String(s.to))}. «Дней до нуля» — оценка по тренду периода.</p>
      </div>
      <div class="stamp">Период<br><b>${esc(String(s.from))} → ${esc(String(s.to))}</b></div>
    </header>
    <section class="kpis">${kpisTop}</section>
    <section class="panel">
      ${panelHead('🏭', 'Остаток по каждому фулфилменту сейчас', 'текущий остаток + оценка «дней до нуля»', AC.blue)}
      <section class="kpis" style="margin:0">${kpisFF}</section>
    </section>
    <section class="panel">
      ${panelHead('📈', 'Остаток по фулфилментам во времени', 'жирная линия — суммарный остаток', AC.blue)}
      <div class="chart-wrap">${lineChart(lines, labels, { fmtY: nf })}</div>
      ${leg}
    </section>
    <section class="panel">
      ${panelHead('📊', 'Изменение за период по ФФ', 'старт → текущий · дни до нуля', AC.violet)}
      <div class="table-scroll"><table class="sortable"><thead><tr><th class="tl">Фулфилмент</th><th class="ta-r">Старт</th><th class="ta-r">Сейчас</th><th class="ta-r">Δ</th><th class="ta-r">Дней до 0</th><th class="ta-r">Мин</th><th class="ta-r">Макс</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    <footer class="foot">Источник: накопленные ежедневные снимки отчёта «Остатки» (report_runs, report=stock). По каждому дню взят последний снимок; остаток фулфилмента — totalQuantity.</footer>
  </div>`;
}

fs.writeFileSync(R('fbs-stock-dynamics.html'), page('Динамика остатков FBS — дашборд', body));
fs.writeFileSync(R('fbs-stock-dynamics.artifact.html'), artifact('Динамика остатков FBS — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-stock-dynamics.html'))}\n`);
