// scripts/fbs-geo-dashboard.mjs — HTML/PDF-дашборд «География продаж и возвратов».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-geo-service.json (снимок сервиса)
// Выход: fbs-geo-dashboard.html + .artifact.html
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, kpi, hbars, panelHead, insights, AC, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-geo-service.json'), 'utf8'));
const stamp = (s.generatedAt || new Date().toISOString()).slice(0, 16).replace('T', ' ') + ' UTC';

const A = s.scopes?.all || { totals: {}, byRegion: [], byOkrug: [] };
const M = s.scopes?.moscow || { totals: {}, byRegion: [], byOkrug: [] };
const lbl = (r) => r.region || r.okrug || '—';

const kpis = [
  kpi(nf(A.totals.salesCount), `продаж за ${s.days} дн`, { icon: '🛒', accent: AC.green }),
  kpi(nf(A.totals.returnCount), `возвратов за ${s.days} дн`, { icon: '↩️', accent: AC.red }),
  kpi(`${(A.totals.returnPct || 0).toFixed(1)}%`, 'возвратов, %', { icon: '📉', accent: AC.amber }),
  kpi(nf(A.totals.regions), 'регионов', { icon: '🗺️', accent: AC.blue }),
  kpi(nf(A.totals.salesRub), 'сумма продаж, ₽', { icon: '💰', accent: AC.violet }),
].join('');

const bySales = [...A.byRegion].sort((a, b) => b.salesCount - a.salesCount);
const byRet = [...A.byRegion].sort((a, b) => b.returnCount - a.returnCount);
const worst = [...A.byRegion].filter((r) => r.salesCount >= 20).sort((a, b) => b.returnPct - a.returnPct)[0];
const insightRow = insights([
  bySales[0] ? { icon: '🏆', accent: AC.green, text: `Больше всего продаж: <b>${esc(lbl(bySales[0]))}</b> — ${nf(bySales[0].salesCount)} шт` } : null,
  byRet[0] && byRet[0].returnCount ? { icon: '↩️', accent: AC.red, text: `Больше всего возвратов: <b>${esc(lbl(byRet[0]))}</b> — ${nf(byRet[0].returnCount)} шт` } : null,
  worst ? { icon: '🚩', accent: AC.amber, text: `Худший % возврата: <b>${esc(lbl(worst))}</b> — ${worst.returnPct}% (из ${nf(worst.salesCount)})` } : null,
].filter(Boolean));

const bars = (arr, key, color, fmt) => hbars(arr.slice(0, 12).map((r) => ({ label: lbl(r), value: r[key], color })), { fmt });
const retPanel = `<section class="panel">
  ${panelHead('↩️', 'Топ регионов по возвратам', `вся РФ · ${nf(A.totals.returnCount)} возвратов`, AC.red)}
  <div class="chart-wrap">${bars(byRet, 'returnCount', 'var(--crit)', nf)}</div>
</section>`;
const salesPanel = `<section class="panel">
  ${panelHead('🛒', 'Топ регионов по продажам · по округам', 'вся РФ', AC.green)}
  <div class="cols cols-2">
    <div class="chart-wrap">${bars(bySales, 'salesCount', 'var(--accent)', nf)}</div>
    <div class="chart-wrap">${hbars([...A.byOkrug].sort((a, b) => b.salesCount - a.salesCount).map((o) => ({ label: o.okrug, value: o.salesCount, sub: `↩ ${nf(o.returnCount)}`, color: 'var(--s1)' })), { fmt: nf })}</div>
  </div>
</section>`;

const tRows = A.byRegion.map((r) => `<tr>
  <td class="tl">${esc(r.okrug)}</td><td class="tl a-name">${esc(lbl(r))}</td>
  <td class="cellnum" data-v="${r.salesCount}">${nf(r.salesCount)}</td>
  <td class="cellnum" data-v="${r.returnCount}">${nf(r.returnCount)}</td>
  <td class="cellnum" data-v="${r.returnPct}">${r.returnPct}%</td>
  <td class="cellnum" data-v="${r.salesRub}">${nf(r.salesRub)}</td></tr>`).join('');
const tablePanel = `<section class="panel">
  ${panelHead('📋', 'По регионам (вся РФ)', `${nf(A.byRegion.length)} регионов · клик по заголовку — сортировка`, AC.violet)}
  <div class="table-scroll"><table class="sortable"><thead><tr><th class="tl">Округ</th><th class="tl">Регион</th><th class="ta-r">Продано</th><th class="ta-r">Возвращено</th><th class="ta-r">% возв.</th><th class="ta-r">Сумма ₽</th></tr></thead><tbody>${tRows}</tbody></table></div>
</section>`;

// Блок «Товары московских FF».
const mBySales = [...M.byRegion].sort((a, b) => b.salesCount - a.salesCount);
const mByRet = [...M.byRegion].sort((a, b) => b.returnCount - a.returnCount);
const mosPanel = `<section class="panel">
  ${panelHead('🏙️', 'Товары московских FF — география', `${nf(s.moscowNmCount)} nmID · ${esc((s.moscowWarehouses || []).join(', '))}`, AC.teal)}
  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
    ${kpi(nf(M.totals.salesCount), 'продаж', { icon: '🛒', accent: AC.green })}
    ${kpi(nf(M.totals.returnCount), 'возвратов', { icon: '↩️', accent: AC.red })}
    ${kpi(`${(M.totals.returnPct || 0).toFixed(1)}%`, 'возвратов, %', { icon: '📉', accent: AC.amber })}
    ${kpi(nf(M.totals.salesRub), 'сумма, ₽', { icon: '💰', accent: AC.violet })}
  </div>
  <div class="cols cols-2" style="margin-top:14px">
    <div><div class="panel-sub" style="margin-bottom:8px">Топ по продажам</div><div class="chart-wrap">${bars(mBySales, 'salesCount', 'var(--accent)', nf)}</div></div>
    <div><div class="panel-sub" style="margin-bottom:8px">Топ по возвратам</div><div class="chart-wrap">${bars(mByRet, 'returnCount', 'var(--crit)', nf)}</div></div>
  </div>
</section>`;

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · география</p>
      <h1>География продаж и возвратов</h1>
      <p class="sub">Регион покупателя из статистики WB (продажи + возвраты) за ${s.days} дней, с ${esc(s.from || '')}. «Вся РФ» — по всем товарам; отдельный блок — только по товарам, отгружаемым с московских FF-складов.</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${insightRow}
  ${retPanel}
  ${salesPanel}
  ${mosPanel}
  ${tablePanel}
  <footer class="foot">Источник: WB API statistics /api/v1/supplier/sales (регион покупателя, продажи+возвраты) + marketplace /api/v3/orders (привязка nmID к московским FF). Данные ~90 дней, обновление ~30 мин.</footer>
</div>`;

fs.writeFileSync(R('fbs-geo-dashboard.html'), page('География FBS — дашборд', body));
fs.writeFileSync(R('fbs-geo-dashboard.artifact.html'), artifact('География FBS — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-geo-dashboard.html'))}\n`);
