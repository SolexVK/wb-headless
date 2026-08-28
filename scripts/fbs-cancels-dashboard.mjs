// scripts/fbs-cancels-dashboard.mjs — HTML/PDF-дашборд «Отказы по фулфилментам».
// Вход:  <REPORTS_OUTPUT_DIR>/fbs-cancels-service.json (снимок сервиса)
// Выход: fbs-cancels-dashboard.html + .artifact.html
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc, nf, kpi, hbars, panelHead, insights, AC, page, artifact } from './lib/dashboard-kit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = process.env.REPORTS_OUTPUT_DIR ? path.resolve(process.env.REPORTS_OUTPUT_DIR) : path.join(REPO, 'reports-output');
const R = (p) => path.join(OUT_DIR, p);
const s = JSON.parse(fs.readFileSync(R('fbs-cancels-service.json'), 'utf8'));
const stamp = (s.generatedAt || new Date().toISOString()).slice(0, 16).replace('T', ' ') + ' UTC';

const t = s.totals || {};
const byFF = s.byFF || [];
const reasons = s.reasons || [];
const rub = (v) => nf(Math.round(Number(v) || 0)) + ' ₽';

// ── KPI-шапка ────────────────────────────────────────────────────────────────
const kpis = [
  kpi(rub(t.lostRub), 'потери по вине ФФ', { icon: '💸', accent: AC.red }),
  kpi(`${t.sellerCancelPct || 0}%`, 'отказов ФФ (от решённых)', { icon: '⛔', accent: AC.amber }),
  kpi(nf(t.sellerCancel || 0), 'заказов отменил ФФ', { icon: '🏭', accent: AC.violet }),
  kpi(rub(t.clientRefusalRub), 'отказы клиента при получении', { icon: '↩️', accent: AC.teal }),
  kpi(nf(t.made || 0), 'заданий за период', { icon: '📦', accent: AC.blue }),
].join('');

const worst = s.worst;
const worstPct = [...byFF].filter((r) => r.decided >= 5).sort((a, b) => b.sellerCancelPct - a.sellerCancelPct)[0];
const topInsights = insights([
  worst ? { icon: '💸', accent: AC.red, text: `Больше всего теряем на ФФ: <b>${esc(worst.ff)}</b> — ${rub(worst.lostRub)} (${nf(worst.sellerCancel)} отказов)` } : { icon: '✅', accent: AC.green, text: 'Отказов по вине ФФ за период нет' },
  worstPct ? { icon: '⛔', accent: AC.amber, text: `Наибольшая доля отказов ФФ: <b>${esc(worstPct.ff)}</b> — ${worstPct.sellerCancelPct}%` } : null,
  t.unknown ? { icon: 'ℹ️', accent: AC.teal, text: `Без статуса (вне окна ретеншена WB): <b>${nf(t.unknown)}</b> из ${nf(t.made)} — не учтены в % отказов` } : null,
].filter(Boolean));

// ── Потери по ФФ (столбики) + причины ────────────────────────────────────────
const lostBars = hbars(byFF.filter((r) => r.lostRub > 0).map((r) => ({ label: r.ff, value: r.lostRub, sub: `${nf(r.sellerCancel)} отказов`, color: 'var(--c-red)' })), { fmt: (v) => rub(v) });
const reasonBars = hbars(reasons.map((r) => ({ label: r.ru, value: r.rub, sub: `${nf(r.count)} шт`, color: r.blame === 'ff' ? 'var(--c-violet)' : 'var(--s1)' })), { fmt: (v) => rub(v) });

// ── Таблица по ФФ ─────────────────────────────────────────────────────────────
const rows = byFF.map((r) => `<tr>
  <td class="tl">${esc(r.ff)}</td>
  <td class="cellnum" data-v="${r.made}">${nf(r.made)}</td>
  <td class="cellnum" data-v="${r.sold}">${nf(r.sold)}</td>
  <td class="cellnum" data-v="${r.sellerCancel}">${nf(r.sellerCancel)}</td>
  <td class="cellnum" data-v="${r.sellerCancelPct}">${r.sellerCancelPct}%</td>
  <td class="cellnum" data-v="${r.defect}">${nf(r.defect)}</td>
  <td class="cellnum" data-v="${r.clientRefusal}">${nf(r.clientRefusal)}</td>
  <td class="cellnum" data-v="${r.inWork}">${nf(r.inWork)}</td>
  <td class="cellnum" data-v="${r.lostRub}">${rub(r.lostRub)}</td></tr>`).join('');

const body = `<div class="wrap">
  <header class="head">
    <div>
      <p class="eyebrow">Wildberries · FBS · потери</p>
      <h1>Отказы по фулфилментам</h1>
      <p class="sub">Где ФФ проваливает заказы и во что это обходится: по каждому складу-фулфилменту — сколько сборочных заданий создано, выкуплено, отменено продавцом (отказ ФФ), клиентом и браком, за ${s.days} дней с ${esc(s.from || '')}. «Потери по вине ФФ» = упущенная выручка по отказам продавца и браку. Статус — текущий (WB хранит FBS-заказы ~90 дней).</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${topInsights}
  <section class="panel">
    ${panelHead('💸', 'Где теряем деньги', `упущенная выручка по вине ФФ и разбивка по причинам · за ${s.days} дн`, AC.red)}
    <div class="cols cols-2">
      <div><div class="panel-sub" style="margin-bottom:8px">Потери по ФФ</div><div class="chart-wrap">${lostBars || '<p class="note">Потерь по вине ФФ за период нет.</p>'}</div></div>
      <div><div class="panel-sub" style="margin-bottom:8px">Потери и отмены по причинам</div><div class="chart-wrap">${reasonBars || '<p class="note">Отмен за период нет.</p>'}</div></div>
    </div>
  </section>
  <section class="panel">
    ${panelHead('🏭', 'Разбор по фулфилментам', 'задания, выкупы, отказы и потери по каждому ФФ', AC.violet)}
    <div class="table-scroll"><table class="sortable"><thead><tr><th class="tl">Фулфилмент</th><th class="ta-r">Заданий</th><th class="ta-r">Выкуплено</th><th class="ta-r">Отказ ФФ</th><th class="ta-r">% ФФ</th><th class="ta-r">Брак</th><th class="ta-r">Отказ клиента</th><th class="ta-r">В работе</th><th class="ta-r">Потери</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>
  <footer class="foot">Источник: marketplace /api/v3/orders (создание задания, warehouseId = ФФ, цена) + /api/v3/orders/status (supplierStatus/wbStatus). «Отказ ФФ» = supplierStatus cancel (отменено продавцом). Упущенная выручка — по цене заказа; штрафы и обратная логистика в деньгах — из детализации отчёта реализации (следующая итерация).</footer>
</div>`;

fs.writeFileSync(R('fbs-cancels-dashboard.html'), page('Отказы по фулфилментам — дашборд', body));
fs.writeFileSync(R('fbs-cancels-dashboard.artifact.html'), artifact('Отказы по фулфилментам — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-cancels-dashboard.html'))}\n`);
