// scripts/fbs-logistics-dashboard.mjs — HTML/PDF-дашборд «Логистика».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-logistics-service.json (снимок сервиса)
// Выход: fbs-logistics-dashboard.html + .artifact.html
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, nf1, kpi, hbars, panelHead, insights, AC, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-logistics-service.json'), 'utf8'));
const stamp = (s.generatedAt || new Date().toISOString()).slice(0, 16).replace('T', ' ') + ' UTC';

const fmtH = (h) => { const v = Number(h) || 0; return v >= 24 ? nf1(v / 24) + ' сут' : nf1(v) + ' ч'; };
const A = s.assembly || { totals: {}, byFF: [], buckets: {}, critical: [] };
const D = s.delivery || { available: false, totals: {}, byFF: [], byRegion: [], buckets: {}, byDay: [] };
const at = A.totals || {}; const dt = D.totals || {};

// ── KPI-шапка ────────────────────────────────────────────────────────────────
const kpis = [
  kpi(fmtH(at.medianHours), 'медиана сборки', { icon: '📊', accent: AC.teal }),
  kpi(fmtH(at.avgHours), 'среднее сборки', { icon: '⏱️', accent: AC.green }),
  kpi(nf(at.processed), 'собрано заданий', { icon: '📦', accent: AC.blue }),
  kpi(D.available ? fmtH(dt.medianHours) : '—', 'медиана доставки', { icon: '🚚', accent: AC.indigo }),
  kpi(D.available ? nf(dt.count) : '0', 'выкупов измерено', { icon: '📬', accent: AC.violet }),
].join('');

// ── Сборка ─────────────────────────────────────────────────────────────────
const asmProc = (A.byFF || []).filter((r) => r.processed >= 5);
const asmFast = [...asmProc].sort((a, b) => a.medianHours - b.medianHours)[0];
const asmSlow = [...asmProc].sort((a, b) => b.medianHours - a.medianHours)[0];
const asmInsights = insights([
  asmFast ? { icon: '⚡', accent: AC.green, text: `Быстрее всех собирает: <b>${esc(asmFast.ff)}</b> — медиана ${fmtH(asmFast.medianHours)}` } : null,
  asmSlow && asmSlow !== asmFast ? { icon: '🐢', accent: AC.amber, text: `Медленнее всех: <b>${esc(asmSlow.ff)}</b> — медиана ${fmtH(asmSlow.medianHours)}` } : null,
  at.criticalCount ? { icon: '🚨', accent: AC.red, text: `Критично долгих (> ${s.critAssemblyH || 48} ч): <b>${nf(at.criticalCount)}</b>` } : { icon: '✅', accent: AC.green, text: 'Критично долгих сборок нет' },
].filter(Boolean));

const asmByMedian = [...(A.byFF || [])].sort((a, b) => b.medianHours - a.medianHours);
const asmBars = hbars(asmByMedian.map((r) => ({ label: r.ff, value: r.medianHours, sub: `${nf(r.processed)} шт`, color: 'var(--accent)' })), { fmt: fmtH });
const asmBucketBars = hbars(Object.entries(A.buckets || {}).map(([k, v]) => ({ label: k, value: v, color: 'var(--s1)' })), { fmt: nf });
const asmRows = (A.byFF || []).map((r) => `<tr>
  <td class="tl">${esc(r.ff)}</td>
  <td class="cellnum" data-v="${r.made}">${nf(r.made)}</td>
  <td class="cellnum" data-v="${r.processed}">${nf(r.processed)}</td>
  <td class="cellnum" data-v="${r.pending}">${nf(r.pending)}</td>
  <td class="cellnum" data-v="${r.avgHours}">${fmtH(r.avgHours)}</td>
  <td class="cellnum" data-v="${r.medianHours}">${fmtH(r.medianHours)}</td>
  <td class="cellnum" data-v="${r.p90Hours}">${fmtH(r.p90Hours)}</td>
  <td class="cellnum" data-v="${r.maxHours}">${fmtH(r.maxHours)}</td>
  <td class="cellnum" data-v="${r.criticalCount}">${nf(r.criticalCount)}</td></tr>`).join('');
const asmPanel = `<section class="panel">
  ${panelHead('🏭', 'Сборка по ФФ', `среднее / медиана / p90 · за ${s.days} дн`, AC.blue)}
  <div class="cols cols-2">
    <div><div class="panel-sub" style="margin-bottom:8px">Медиана сборки по ФФ</div><div class="chart-wrap">${asmBars}</div></div>
    <div><div class="panel-sub" style="margin-bottom:8px">Распределение по времени сборки</div><div class="chart-wrap">${asmBucketBars}</div></div>
  </div>
  <div class="table-scroll" style="margin-top:14px"><table class="sortable"><thead><tr><th class="tl">ФФ отгрузки</th><th class="ta-r">Сделано</th><th class="ta-r">Обраб.</th><th class="ta-r">В работе</th><th class="ta-r">Среднее</th><th class="ta-r">Медиана</th><th class="ta-r">p90</th><th class="ta-r">Макс</th><th class="ta-r">Крит.</th></tr></thead><tbody>${asmRows}</tbody></table></div>
</section>`;

// ── Доставка ──────────────────────────────────────────────────────────────────
let delPanel;
if (!D.available) {
  delPanel = `<section class="panel">
    ${panelHead('🚚', 'Доставка ФФ → клиент', 'скорость доставки', AC.indigo)}
    <p class="note">За период нет выкупов FBS, привязанных к ФФ отгрузки. Скорость доставки появится при первых продажах (механизм srid = rid проверен, 100%).</p>
  </section>`;
} else {
  const delReg = (D.byRegion || []).filter((r) => r.count >= 5);
  const fastReg = [...delReg].sort((a, b) => a.medianHours - b.medianHours)[0];
  const slowReg = [...delReg].sort((a, b) => b.medianHours - a.medianHours)[0];
  const delFast = [...(D.byFF || [])].filter((r) => r.count >= 5).sort((a, b) => a.medianHours - b.medianHours)[0];
  const delInsights = insights([
    delFast ? { icon: '⚡', accent: AC.green, text: `Быстрее всех доставляет: <b>${esc(delFast.ff)}</b> — медиана ${fmtH(delFast.medianHours)}` } : null,
    fastReg ? { icon: '🏆', accent: AC.blue, text: `Быстрее всех регион: <b>${esc(fastReg.region)}</b> — ${fmtH(fastReg.medianHours)}` } : null,
    slowReg && slowReg !== fastReg ? { icon: '🐢', accent: AC.amber, text: `Дольше всех регион: <b>${esc(slowReg.region)}</b> — ${fmtH(slowReg.medianHours)}` } : null,
  ].filter(Boolean));
  const delFFBars = hbars([...(D.byFF || [])].sort((a, b) => b.medianHours - a.medianHours).map((r) => ({ label: r.ff, value: r.medianHours, sub: `${nf(r.count)} шт`, color: 'var(--accent)' })), { fmt: fmtH });
  const delBucketBars = hbars(Object.entries(D.buckets || {}).map(([k, v]) => ({ label: k, value: v, color: 'var(--s1)' })), { fmt: nf });
  const delRegTop = [...(D.byRegion || [])].sort((a, b) => b.count - a.count).slice(0, 12);
  const delRegBars = hbars(delRegTop.map((r) => ({ label: r.region, value: r.medianHours, sub: `${nf(r.count)} шт`, color: 'var(--s2)' })), { fmt: fmtH });
  const delRows = (D.byFF || []).map((r) => `<tr>
    <td class="tl">${esc(r.ff)}</td>
    <td class="cellnum" data-v="${r.count}">${nf(r.count)}</td>
    <td class="cellnum" data-v="${r.avgHours}">${fmtH(r.avgHours)}</td>
    <td class="cellnum" data-v="${r.medianHours}">${fmtH(r.medianHours)}</td>
    <td class="cellnum" data-v="${r.p90Hours}">${fmtH(r.p90Hours)}</td>
    <td class="cellnum" data-v="${r.minHours}">${fmtH(r.minHours)}</td>
    <td class="cellnum" data-v="${r.maxHours}">${fmtH(r.maxHours)}</td></tr>`).join('');
  const regRows = (D.byRegion || []).slice(0, 60).map((r) => `<tr>
    <td class="tl">${esc(r.okrug)}</td><td class="tl">${esc(r.region)}</td>
    <td class="cellnum" data-v="${r.count}">${nf(r.count)}</td>
    <td class="cellnum" data-v="${r.avgHours}">${fmtH(r.avgHours)}</td>
    <td class="cellnum" data-v="${r.medianHours}">${fmtH(r.medianHours)}</td></tr>`).join('');
  delPanel = `<section class="panel">
    ${panelHead('🚚', 'Доставка ФФ → конечный клиент', `от ухода с ФФ (closedAt) до выкупа · за ${s.days} дн`, AC.indigo)}
    ${delInsights}
    <div class="cols cols-2" style="margin-top:14px">
      <div><div class="panel-sub" style="margin-bottom:8px">Медиана доставки по ФФ</div><div class="chart-wrap">${delFFBars}</div></div>
      <div><div class="panel-sub" style="margin-bottom:8px">Распределение по времени доставки</div><div class="chart-wrap">${delBucketBars}</div></div>
    </div>
    <div class="table-scroll" style="margin-top:14px"><table class="sortable"><thead><tr><th class="tl">ФФ отгрузки</th><th class="ta-r">Выкупов</th><th class="ta-r">Среднее</th><th class="ta-r">Медиана</th><th class="ta-r">p90</th><th class="ta-r">Мин</th><th class="ta-r">Макс</th></tr></thead><tbody>${delRows}</tbody></table></div>
    <div class="panel-sub" style="margin:18px 0 8px">Медиана доставки по регионам (топ по числу выкупов)</div>
    <div class="chart-wrap">${delRegBars}</div>
    <div class="table-scroll" style="margin-top:14px"><table class="sortable"><thead><tr><th class="tl">Округ</th><th class="tl">Регион покупателя</th><th class="ta-r">Выкупов</th><th class="ta-r">Среднее</th><th class="ta-r">Медиана</th></tr></thead><tbody>${regRows}</tbody></table></div>
  </section>`;
}

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · логистика</p>
      <h1>Логистика — сроки сборки и доставки</h1>
      <p class="sub">Среднее время сборки по каждому фулфилменту (createdAt → передача в доставку) и скорость доставки от ФФ до конечного клиента (уход с ФФ → выкуп) за ${s.days} дней, с ${esc(s.from || '')}. Выкупы привязаны к исходному складу отгрузки (srid = rid).</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${asmInsights}
  ${asmPanel}
  ${delPanel}
  <footer class="foot">Источник: marketplace /api/v3/orders + /api/v3/supplies (createdAt, closedAt по ФФ) и statistics /api/v1/supplier/sales (дата выкупа, регион покупателя, srid). FBS-заказы хранятся ~90 дней.</footer>
</div>`;

fs.writeFileSync(R('fbs-logistics-dashboard.html'), page('Логистика FBS — дашборд', body));
fs.writeFileSync(R('fbs-logistics-dashboard.artifact.html'), artifact('Логистика FBS — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-logistics-dashboard.html'))}\n`);
