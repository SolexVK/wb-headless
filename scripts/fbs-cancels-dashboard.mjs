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

// ── Деньги из реализации (штрафы/удержания/обратная логистика) ────────────────
const money = s.money || { available: false };
const mt = money.totals || {};
let moneyPanel;
if (!money.available) {
  moneyPanel = `<section class="panel">${panelHead('🧾', 'Деньги из реализации', 'штрафы, удержания, обратная логистика', AC.red)}
    <p class="note">Недоступно: ${esc(money.reason || 'нет данных')}. Нужна категория «Финансы» в токене WB.</p></section>`;
} else {
  const mBars = hbars((money.reasons || []).slice(0, 12).map((r) => ({ label: r.reason, value: r.rub, sub: `${nf(r.count)} шт`, color: 'var(--c-red)' })), { fmt: (v) => rub(v) });
  const mRows = (money.byFF || []).map((r) => `<tr><td class="tl">${esc(r.ff)}</td><td class="cellnum" data-v="${r.penalty}">${rub(r.penalty)}</td><td class="cellnum" data-v="${r.returnLogistics}">${rub(r.returnLogistics)}</td><td class="cellnum" data-v="${r.ffLossRub}">${rub(r.ffLossRub)}</td><td class="cellnum" data-v="${r.deduction}">${rub(r.deduction)}</td></tr>`).join('');
  moneyPanel = `<section class="panel">
    ${panelHead('🧾', 'Деньги из реализации', `штрафы + обратная логистика по вине ФФ · удержания отдельно · за ${s.days} дн`, AC.red)}
    <section class="kpis" style="margin:0 0 12px">${[
      kpi(rub(mt.penalty), 'штрафы', { icon: '⚖️', accent: AC.red }),
      kpi(rub(mt.returnLogistics), 'обратная логистика', { icon: '🚚', accent: AC.amber }),
      kpi(rub(mt.ffLossRub), 'деньги по вине ФФ', { icon: '💸', accent: AC.violet }),
      kpi(rub(mt.deduction), 'удержания (подписки/хранение)', { icon: '📉', accent: AC.teal }),
    ].join('')}</section>
    <div class="panel-sub" style="margin-bottom:8px">Штрафы и удержания по причинам (bonusTypeName)</div>
    <div class="chart-wrap">${mBars || '<p class="note">Нет штрафов/удержаний по нашим ФФ за период.</p>'}</div>
    <div class="table-scroll" style="margin-top:14px"><table class="sortable"><thead><tr><th class="tl">Фулфилмент</th><th class="ta-r">Штрафы</th><th class="ta-r">Обр. логистика</th><th class="ta-r">По вине ФФ</th><th class="ta-r">Удержания</th></tr></thead><tbody>${mRows}</tbody></table></div>
  </section>`;
}

// ── Сводка ФФ: скорость ↔ отказы ↔ деньги ─────────────────────────────────────
const sc = s.scorecard || [];
const fmtH = (v) => (v == null ? '—' : (Number(v) >= 24 ? nf(Number(v) / 24) + ' сут' : nf(v) + ' ч'));
const scRows = sc.map((r) => `<tr><td class="tl">${esc(r.ff)}</td><td class="cellnum" data-v="${r.asmMedianHours ?? -1}">${fmtH(r.asmMedianHours)}</td><td class="cellnum" data-v="${r.sellerCancel}">${nf(r.sellerCancel)}</td><td class="cellnum" data-v="${r.sellerCancelPct}">${r.sellerCancelPct}%</td><td class="cellnum" data-v="${r.cancelLostRub}">${rub(r.cancelLostRub)}</td><td class="cellnum" data-v="${r.penaltyRub}">${rub(r.penaltyRub)}</td><td class="cellnum" data-v="${r.returnLogRub}">${rub(r.returnLogRub)}</td><td class="cellnum" data-v="${r.totalLossRub}">${rub(r.totalLossRub)}</td></tr>`).join('');
const scorePanel = sc.length ? `<section class="panel">
  ${panelHead('🎯', 'Сводка по фулфилментам', 'скорость сборки ↔ отказы ↔ деньги · ИТОГО потерь', AC.blue)}
  <div class="table-scroll"><table class="sortable"><thead><tr><th class="tl">Фулфилмент</th><th class="ta-r">Сборка (медиана)</th><th class="ta-r">Отказ ФФ</th><th class="ta-r">% ФФ</th><th class="ta-r">Упущ. выручка</th><th class="ta-r">Штрафы</th><th class="ta-r">Обр. логистика</th><th class="ta-r">ИТОГО потерь</th></tr></thead><tbody>${scRows}</tbody></table></div>
</section>` : '';

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
      <h1>Потери по фулфилментам</h1>
      <p class="sub">Где ФФ теряет деньги: отказы (упущенная выручка), штрафы/удержания/обратная логистика из отчёта реализации и сводка «скорость сборки ↔ отказы ↔ деньги» по каждому фулфилменту, за ${s.days} дней с ${esc(s.from || '')}. Деньги привязаны к ФФ по srid = rid. Реализация формируется по неделям (запаздывает на 1–2 недели).</p>
    </div>
    <div class="stamp">Снимок<br><b>${stamp}</b></div>
  </header>
  <section class="kpis">${kpis}</section>
  ${topInsights}
  <section class="panel">
    ${panelHead('💸', 'Где теряем деньги', `упущенная выручка по вине ФФ и разбивка по причинам · за ${s.days} дн`, AC.red)}
    <div class="cols cols-2">
      <div><div class="panel-sub" style="margin-bottom:8px">Потери по ФФ</div><div class="chart-wrap">${lostBars || '<p class="note">Потерь по вине ФФ за период нет.</p>'}</div></div>
      <div><div class="panel-sub" style="margin-bottom:8px">Стоимость заказов по причине (упущенная выручка, не расход)</div>
        <p class="note" style="margin:0 0 8px">Розничная цена заказов по причине — не штрафы и не расход. Реальные удержания — в отчёте реализации.</p>
        <div class="chart-wrap">${reasonBars || '<p class="note">Отмен за период нет.</p>'}</div>
        ${t.clientDecline ? `<p class="note" style="margin:8px 0 0">ℹ️ Справочно (не потеря): отмена клиентом в 1-й час — ${nf(t.clientDecline)} заказов на ${rub(t.clientDeclineRub)}. Отменено до сборки, реальных денег нет — в график не включено.</p>` : ''}</div>
    </div>
  </section>
  ${scorePanel}
  ${moneyPanel}
  <section class="panel">
    ${panelHead('🏭', 'Разбор отказов по фулфилментам', 'задания, выкупы, отказы и упущенная выручка по каждому ФФ', AC.violet)}
    <div class="table-scroll"><table class="sortable"><thead><tr><th class="tl">Фулфилмент</th><th class="ta-r">Заданий</th><th class="ta-r">Выкуплено</th><th class="ta-r">Отказ ФФ</th><th class="ta-r">% ФФ</th><th class="ta-r">Брак</th><th class="ta-r">Отказ клиента</th><th class="ta-r">В работе</th><th class="ta-r">Упущено</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>
  <footer class="foot">Источник: marketplace /api/v3/orders + /api/v3/orders/status (отказы, warehouseId = ФФ) и finance /api/finance/v1/sales-reports/detailed (штрафы, удержания, обратная логистика по srid). «Отказ ФФ» = supplierStatus cancel. Упущенная выручка — по цене заказа; денежные потери — из детализации отчёта реализации (по неделям, с задержкой).</footer>
</div>`;

fs.writeFileSync(R('fbs-cancels-dashboard.html'), page('Потери по фулфилментам — дашборд', body));
fs.writeFileSync(R('fbs-cancels-dashboard.artifact.html'), artifact('Потери по фулфилментам — дашборд', body));
process.stderr.write(`→ ${path.relative(process.cwd(), R('fbs-cancels-dashboard.html'))}\n`);
