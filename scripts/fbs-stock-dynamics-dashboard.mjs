// scripts/fbs-stock-dynamics-dashboard.mjs — HTML/PDF-дашборд «Динамика остатков».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-stock-series.json (ряд по дням, а не один снимок).
// Выход: fbs-stock-dynamics.html + .artifact.html
// Ряд: { from, to, count, dates:[...], warehouses:[{name, values:[...]}], grand:[...] }.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, kpi, panelHead, legend, lineChart, seriesColor, AC, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-stock-series.json'), 'utf8'));

const last = (a) => (a && a.length ? a[a.length - 1] : 0);
const wh = s.warehouses || [];
const grandNow = last(s.grand);

const kpis = [
  kpi(`${esc(String(s.from))} → ${esc(String(s.to))}`, 'период (по снимкам)', { icon: '📅', accent: AC.blue }),
  kpi(nf(s.count), 'снимков в графике', { icon: '🗂️', accent: AC.teal }),
  kpi(nf(wh.length), 'фулфилментов', { icon: '🏭', accent: AC.violet }),
  kpi(nf(grandNow), 'сейчас всего, шт', { icon: '📦', accent: AC.green }),
].join('');

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
  const rows = wh.map((w) => {
    const first = w.values[0] || 0; const now = last(w.values); const delta = now - first;
    const mn = Math.min(...w.values); const mx = Math.max(...w.values);
    return `<tr><td class="tl">${esc(w.name)}</td>
      <td class="cellnum" data-v="${first}">${nf(first)}</td>
      <td class="cellnum" data-v="${now}">${nf(now)}</td>
      <td class="cellnum" data-v="${delta}">${delta > 0 ? '+' : ''}${nf(delta)}</td>
      <td class="cellnum" data-v="${mn}">${nf(mn)}</td>
      <td class="cellnum" data-v="${mx}">${nf(mx)}</td></tr>`;
  }).join('');
  body = `<div class="wrap">
    <header class="head">
      <div>
        <p class="eyebrow">Wildberries · FBS · остатки</p>
        <h1>Динамика остатков по фулфилментам</h1>
        <p class="sub">Как менялось количество товара на каждом фулфилменте по накопленным ежедневным снимкам. Период ${esc(String(s.from))} → ${esc(String(s.to))}, снимков: ${nf(s.count)}.</p>
      </div>
      <div class="stamp">Период<br><b>${esc(String(s.from))} → ${esc(String(s.to))}</b></div>
    </header>
    <section class="kpis">${kpis}</section>
    <section class="panel">
      ${panelHead('📈', 'Остаток по фулфилментам во времени', 'жирная линия — суммарный остаток', AC.blue)}
      <div class="chart-wrap">${lineChart(lines, labels, { fmtY: nf })}</div>
      ${leg}
    </section>
    <section class="panel">
      ${panelHead('📊', 'Изменение за период по ФФ', 'старт → текущий', AC.violet)}
      <div class="table-scroll"><table class="sortable"><thead><tr><th class="tl">Фулфилмент</th><th class="ta-r">Старт</th><th class="ta-r">Сейчас</th><th class="ta-r">Δ</th><th class="ta-r">Мин</th><th class="ta-r">Макс</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    <footer class="foot">Источник: накопленные ежедневные снимки отчёта «Остатки» (report_runs, report=stock). По каждому дню взят последний снимок; остаток фулфилмента — totalQuantity.</footer>
  </div>`;
}

fs.writeFileSync(R('fbs-stock-dynamics.html'), page('Динамика остатков FBS — дашборд', body));
fs.writeFileSync(R('fbs-stock-dynamics.artifact.html'), artifact('Динамика остатков FBS — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-stock-dynamics.html'))}\n`);
