// scripts/fbs-stock-dashboard.mjs — HTML/PDF-дашборд «Остатки FBS».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-stock-service.json (снимок сервиса)
// Выход: fbs-stock-dashboard.html (страница) + .artifact.html (для встраивания)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, kpi, legend, hbars, donut, heatBg, seriesColor, panelHead, insights, AC, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-stock-service.json'), 'utf8'));
const stamp = (s.generatedAt || new Date().toISOString()).slice(0, 16).replace('T', ' ') + ' UTC';
const t = s.totals || {};

const warehouses = [...(s.warehouses || [])].filter((w) => w.totalQuantity > 0).sort((a, b) => b.totalQuantity - a.totalQuantity);
const cols = s.warehouseList || warehouses.map((w) => w.name);
const articles = s.articles || [];
const grand = t.grandTotal || warehouses.reduce((a, w) => a + w.totalQuantity, 0);
const topWh = warehouses[0];

// KPI.
const activeN = t.activeWarehouses ?? warehouses.length;
const avgPerWh = activeN ? Math.round(grand / activeN) : 0;
const kpis = [
  kpi(nf(grand), 'штук на FBS (всего)', { icon: '📦', accent: AC.green }),
  kpi(nf(activeN), 'активных складов', { icon: '🏭', accent: AC.blue }),
  kpi(nf(t.articleCount ?? articles.length), 'артикул + цвет', { icon: '🎨', accent: AC.violet }),
  kpi(topWh ? esc(topWh.name) : '—', 'крупнейший склад', { icon: '🏆', accent: AC.amber }),
  kpi(nf(avgPerWh), 'в среднем на склад, шт', { icon: '⚖️', accent: AC.teal }),
].join('');

// Выводы/инсайты.
const topShare = topWh && grand ? (topWh.totalQuantity / grand * 100) : 0;
const topArt = articles[0];
const insightRow = insights([
  topWh ? { icon: '🏆', accent: AC.green, text: `Больше всего остатков: <b>${esc(topWh.name)}</b> — ${nf(topWh.totalQuantity)} шт (${topShare.toFixed(1)}%)` } : null,
  topArt ? { icon: '🎨', accent: AC.violet, text: `Топ-артикул: <b>${esc(topArt.articleNum)} ${esc(topArt.variant)}</b> — ${nf(topArt.total)} шт` } : null,
  { icon: '🏭', accent: AC.blue, text: `Остаток распределён по <b>${nf(activeN)}</b> складам, ${nf(articles.length)} позиций` },
].filter(Boolean));

// Бары по складам (магнитуда) + пончик (доля).
const barItems = warehouses.map((w) => ({ label: w.name, value: w.totalQuantity, sub: `${nf(w.skuInStock)} SKU` }));
const donutTop = warehouses.slice(0, 6).map((w, i) => ({ label: w.name, value: w.totalQuantity, color: seriesColor(i) }));
const rest = warehouses.slice(6).reduce((a, w) => a + w.totalQuantity, 0);
if (rest > 0) donutTop.push({ label: 'Прочие', value: rest, color: 'var(--line-2)' });
const donutLegend = legend(donutTop.map((d) => ({ label: d.label, color: d.color, value: nf(d.value), sub: `${(d.value / (grand || 1) * 100).toFixed(1)}%` })));

const whPanel = `<section class="panel">
  ${panelHead('🏭', 'Остаток по фулфилментам', `всего <b>${nf(grand)}</b> шт · ${nf(warehouses.length)} активных складов`, AC.blue)}
  <div class="cols cols-2">
    <div class="chart-wrap">${hbars(barItems)}</div>
    <div><div class="chart-wrap">${donut(donutTop, { centerTop: nf(grand), centerSub: 'шт всего' })}</div>${donutLegend}</div>
  </div>
</section>`;

// Матрица артикул+цвет × склад (тепловая), топ по остатку.
const TOP = 40;
const shown = articles.slice(0, TOP);
const maxCell = Math.max(1, ...shown.flatMap((a) => cols.map((c) => a.byWarehouse?.[c] || 0)));
const head = `<tr><th class="ta-r">Арт</th><th class="tl">Цвет / вариант</th>${cols.map((c) => `<th class="ta-r">${esc(c)}</th>`).join('')}<th class="ta-r">Итого</th></tr>`;
const rows = shown.map((a) => `<tr>
  <td class="art">${esc(a.articleNum || '—')}</td>
  <td class="a-name">${esc(a.variant)}</td>
  ${cols.map((c) => { const v = a.byWarehouse?.[c] || 0; return `<td class="cellnum" style="background:${heatBg(v, maxCell)}">${v ? nf(v) : ''}</td>`; }).join('')}
  <td class="cellnum"><b>${nf(a.total)}</b></td>
</tr>`).join('');
const colTot = cols.map((c) => shown.reduce((acc, a) => acc + (a.byWarehouse?.[c] || 0), 0));
const foot = `<tr><td></td><td class="tl">Итого (показано)</td>${colTot.map((v) => `<td class="cellnum">${nf(v)}</td>`).join('')}<td class="cellnum">${nf(shown.reduce((acc, a) => acc + a.total, 0))}</td></tr>`;
const matrixPanel = `<section class="panel">
  ${panelHead('🎨', 'Остаток: артикул + цвет × склад', `${articles.length > TOP ? `топ ${TOP} из ${nf(articles.length)}` : `${nf(articles.length)} позиций`} · интенсивность цвета = величина остатка`, AC.violet)}
  <div class="table-scroll"><table><thead>${head}</thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div>
  <p class="note">Размеры внутри карточки (nmID) объединены в одну цифру. Пустая ячейка — на складе нет остатка по этому артикулу.</p>
</section>`;

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · остатки</p>
      <h1>Остатки по фулфилмент-складам</h1>
      <p class="sub">Текущий остаток товара на складах продавца (FBS): сколько единиц лежит на каждом фулфилменте и как распределено по артикулам и цветам. Снимок на момент сборки.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${insightRow}
  ${whPanel}
  ${matrixPanel}
  <footer class="foot">Источник: WB API marketplace /api/v3/warehouses + /api/v3/stocks/{id}. Значения — на момент снимка.</footer>
</div>`;

fs.writeFileSync(R('fbs-stock-dashboard.html'), page('Остатки FBS — дашборд', body));
fs.writeFileSync(R('fbs-stock-dashboard.artifact.html'), artifact('Остатки FBS — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-stock-dashboard.html'))}\n`);
