// scripts/fbs-replenishment-dashboard.mjs — HTML/PDF-дашборд подсорта FBS.
// Читает <REPORTS_OUTPUT_DIR>/fbs-replenishment.json. Единый дизайн-кит
// (светлая тема, KPI-карточки, инсайты, панели) — как «Остатки»/«Движение».
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, nf1, kpi, panelHead, insights, statusBar, hbars, seriesColor, AC, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const snap = JSON.parse(fs.readFileSync(R('fbs-replenishment.json'), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const P = snap.params || {}, t = snap.totals || {};

const STATUS = { 'нет остатка': 'st-crit', 'разрыв до поставки': 'st-crit', 'риск разрыва': 'st-warn', 'ок': 'st-ok', 'неликвид': 'st-dead', 'нет данных': 'st-mute' };
const PILL = { 'нет остатка': 'crit', 'разрыв до поставки': 'crit', 'риск разрыва': 'warn', 'ок': 'ok', 'неликвид': 'dead', 'нет данных': 'mute' };
const STATUS_ORDER = ['разрыв до поставки', 'нет остатка', 'риск разрыва', 'ок', 'неликвид', 'нет данных'];
const dtz = (d) => (d == null ? '' : d < P.leadMin ? ' dtz-crit' : d < P.leadMax ? ' dtz-warn' : '');
const artList = (P.articles || []).join(', ') || 'все';

// Разбивка статусов.
const agg = {};
for (const w of snap.warehouses || []) for (const r of w.rows || []) {
  const a = agg[r.status] || { count: 0, reorder: 0 }; a.count += 1; a.reorder += r.reorderQty || 0; agg[r.status] = a;
}
const segs = STATUS_ORDER.filter((s) => agg[s]).map((s) => ({ label: s, count: agg[s].count, cls: STATUS[s], extra: agg[s].reorder ? '+' + nf(agg[s].reorder) + ' шт' : '' }));
const statusTotal = Object.values(agg).reduce((s, a) => s + a.count, 0);

// KPI + инсайты.
const kpis = [
  kpi(nf(t.reorderUnits), 'штук к подсорту (всего)', { icon: '🛒', accent: AC.green }),
  kpi(nf(t.riskRows), 'строк в риске разрыва', { icon: '⚠️', accent: AC.red }),
  kpi(nf(t.seedRows), `позиций на завоз (нов. ${nf(t.seedNovelty)} + докл. ${nf(t.seedRefill)})`, { icon: '🌱', accent: AC.violet }),
  kpi(nf(t.seedUnits), 'штук пробного завоза', { icon: '📦', accent: AC.teal }),
  kpi(nf(t.registeredWarehouses), 'складов (все зарегистр.)', { icon: '🏭', accent: AC.blue }),
].join('');
const topWh = [...(snap.warehouses || [])].sort((a, b) => (b.reorderUnits || 0) - (a.reorderUnits || 0))[0];
const insightRow = insights([
  { icon: '🛒', accent: AC.green, text: `К подсорту всего: <b>${nf(t.reorderUnits)} шт</b> по ${artList} арт.` },
  topWh && topWh.reorderUnits ? { icon: '🏭', accent: AC.blue, text: `Больше всего дозаказа: <b>${esc(topWh.name)}</b> — ${nf(topWh.reorderUnits)} шт` } : null,
  t.riskRows ? { icon: '⚠️', accent: AC.red, text: `В риске разрыва: <b>${nf(t.riskRows)}</b> строк — успеть дозаказать` } : { icon: '✅', accent: AC.green, text: 'Строк в риске разрыва нет' },
].filter(Boolean));

// Панель статусов.
const statusPanel = `<section class="panel">
  ${panelHead('🚦', 'Статусы товаров', `${nf(statusTotal)} строк (склад×артикул)`, AC.amber)}
  ${statusBar(segs)}
  <p class="note">«разрыв до поставки» — закончится раньше, чем за ${P.leadMin} дн (подсорт не успеет доехать); «риск разрыва» — может не дожить до ${P.leadMax} дн.</p>
</section>`;

// Сводная: слева Остаток по складам, справа Подсорт по складам (в PDF Остаток скрыт).
const whList = snap.warehouseList || (snap.warehouses || []).map((w) => w.name);
const pivot = snap.pivot || [];
const stockMap = {};
for (const w of (snap.warehouses || [])) for (const r of (w.rows || [])) { const k = `${r.articleNum}|${r.variant}|${r.techSize}`; (stockMap[k] = stockMap[k] || {}); stockMap[k][w.name] = (stockMap[k][w.name] || 0) + (r.stock || 0); }
const stockOf = (p) => stockMap[`${p.articleNum}|${p.variant}|${p.techSize}`] || {};
const th = (t, cls) => `<th class="${cls}">${esc(t)}</th>`;
const pivotHead = `<tr>${th('Арт', 'ta-r')}${th('Цвет', 'tl')}${th('Размер', 'tl')}${whList.map((n) => th(n, 'ta-r oscol print-hide')).join('')}${th('Ост.∑', 'ta-r oscol print-hide')}${whList.map((n) => th(n, 'ta-r')).join('')}${th('Итого', 'ta-r')}</tr>`;
const pivotRows = pivot.map((r) => {
  const st = stockOf(r); const stT = whList.reduce((a, w) => a + (st[w] || 0), 0);
  return `<tr><td class="art" data-v="${esc(r.articleNum || '')}">${esc(r.articleNum || '—')}</td><td class="a-name">${esc(r.variant)}</td><td class="tl">${esc(r.techSize)}</td>${whList.map((w) => `<td class="cellnum oscol print-hide" data-v="${st[w] || 0}">${st[w] ? nf(st[w]) : ''}</td>`).join('')}<td class="cellnum oscol print-hide" data-v="${stT}">${nf(stT)}</td>${whList.map((w) => `<td class="cellnum" data-v="${r.byWarehouse[w] || 0}">${r.byWarehouse[w] ? nf(r.byWarehouse[w]) : '·'}</td>`).join('')}<td class="cellnum reorder" data-v="${r.total}">${nf(r.total)}</td></tr>`;
}).join('');
const pivotPanel = pivot.length ? `<section class="panel">
  ${panelHead('📊', 'Сводная: остаток и подсорт по размерам × склад', `${nf(pivot.length)} строк (артикул × цвет × размер)`, AC.indigo)}
  <p class="blk-hint print-hide">Слева — <span class="os">Остаток по складам</span>, справа (после «Ост.∑») — <span class="ps">Подсорт по складам</span>. Прокрутите вправо; первые 3 столбца закреплены. Клик по заголовку — сортировка.</p>
  <div class="table-scroll"><table class="sortable frozen3"><thead>${pivotHead}</thead><tbody>${pivotRows}</tbody></table></div>
  <p class="note">«·» — подсорт не нужен. В PDF выводится только блок «Подсорт» (как раньше).</p>
</section>` : '';

// По каждому складу.
const whPanels = (snap.warehouses || []).map((w) => {
  const rows = (w.rows || []).map((r) => `<tr class="row-${PILL[r.status] || 'mute'}">
      <td class="art">${esc(r.articleNum || '—')}</td>
      <td class="a-name">${esc(r.variant)}</td>
      <td class="tl">${esc(r.techSize)}</td>
      <td class="mono muted">${esc(r.nmID)}</td>
      <td class="cellnum">${nf(r.stock)}</td>
      <td class="cellnum">${nf1(r.perDay)}</td>
      <td class="cellnum${dtz(r.daysToZero)}">${r.daysToZero == null ? '∞' : r.daysToZero}</td>
      <td class="cellnum reorder">${r.reorderQty ? nf(r.reorderQty) : '·'}</td>
      <td><span class="pill ${PILL[r.status] || 'mute'}">${esc(r.status)}</span></td>
    </tr>`).join('');
  return `<section class="panel">
    ${panelHead('🏭', w.name, `остаток <b>${nf(w.stockUnits)}</b> · к подсорту <b>${nf(w.reorderUnits)}</b> шт · в риске <b>${nf(w.riskCount)}</b>`, AC.blue)}
    <div class="table-scroll"><table>
      <thead><tr><th class="ta-r">Арт</th><th class="tl">Цвет / вариант</th><th class="tl">Размер</th><th class="tl">nmID</th><th class="ta-r">Остаток</th><th class="ta-r">Спрос/дн</th><th class="ta-r">Дни до 0</th><th class="ta-r">Подсорт</th><th class="tl">Статус</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}).join('');

// Пробный завоз.
const seed = snap.seedGrid || [];
const seedWh = whList;
const seedHead = `<tr><th class="ta-r">Арт</th><th class="tl">Цвет / вариант</th><th class="tl">Размер</th><th class="tl">nmID</th><th class="tl">Тип</th>${seedWh.map((n) => `<th class="ta-r">${esc(n)}</th>`).join('')}<th class="ta-r">Итого</th></tr>`;
const seedRows = seed.map((n) => `<tr>
    <td class="art">${esc(n.articleNum || '—')}</td>
    <td class="a-name">${esc(n.variant)}</td>
    <td class="tl">${esc(n.techSize)}</td>
    <td class="mono muted">${esc(n.nmID)}</td>
    <td><span class="pill ${n.kind === 'новинка' ? 'newx' : 'refill'}">${esc(n.kind)}</span></td>
    ${seedWh.map((w) => (n.seedByWarehouse[w] != null ? `<td class="cellnum">${nf(n.seedByWarehouse[w])}</td>` : '<td class="cellnum ok">✓</td>')).join('')}
    <td class="cellnum reorder">${nf(n.seedTotal)}</td>
  </tr>`).join('');
const seedPanel = seed.length ? `<section class="panel">
  ${panelHead('🌱', 'Пробный завоз — новинки и докладки', `${nf(t.seedRows)} позиций · итого ${nf(t.seedUnits)} шт · арт ${esc(artList)}`, AC.violet)}
  <p class="note">Seed = <b>${nf(P.seedMin)} шт</b> на каждый размер на склад, где товара ещё не было. «✓» — уже есть, завоз не нужен. «новинка» — не была ни на одном FF; «докладка» — есть на других складах.</p>
  <div class="table-scroll"><table><thead>${seedHead}</thead><tbody>${seedRows}</tbody></table></div>
</section>` : '';

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · подсорт по складам</p>
      <h1>Подсорт по фулфилмент-складам</h1>
      <p class="sub">Расчёт для каждого FF-склада: остаток, скорость продаж за ${P.velocityDays} дн, дни до нуля и рекомендация к подсорту на горизонт <b>${P.horizonDays} дн</b> (лид-тайм до ${P.leadMax} дн + запас ${P.coverDays} дн). Артикулы в работе: <b>${esc(artList)}</b>.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${insightRow}
  ${statusPanel}
  ${pivotPanel}
  ${whPanels}
  ${seedPanel}
  <footer class="foot">Источник: WB API marketplace /api/v3/orders (спрос) + /api/v3/stocks/{id} (остаток) + content/v2/get/cards/list (номенклатура).</footer>
</div>`;

fs.writeFileSync(R('fbs-replenishment-dashboard.html'), page('Подсорт по складам FBS', body));
fs.writeFileSync(R('fbs-replenishment-dashboard.artifact.html'), artifact('Подсорт по складам FBS', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-replenishment-dashboard.html'))}\n`);
