// lib/reportExport.js — выгрузка плана/прогноза в два файла (Правило 4/5):
//   .xlsx — таблица по дням запрошенного периода (продажи-план и цены);
//   .html — визуальный отчёт: диаграмма 2 лет истории + прогноз, с подсветкой
//           этапов и БЛАГОПРИЯТНЫХ периодов (спрос > предложения).

import { writeXlsx } from './xlsxWriter.js';

export const STAGE_COLORS = {
  'вход': '#DCEBFF',
  'разгон': '#CDECCB',
  'старт сезона': '#FFF3B0',
  'пик сезона': '#F4A261',
  'начало распродажи': '#F6C6D0',
  'конец распродажи': '#E7E1F0',
  'межсезонье': '#F0F0F0',
};
const FAVORABLE = '#FFD54A'; // подсветка благоприятного периода
const stageColor = (s) => STAGE_COLORS[s] || '#F0F0F0';
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Дневной ряд для таблиц: прогноз → forecastDaily, иначе исторический daily. */
function planRows(report) {
  const p = report.plan || {};
  return report.mode === 'forecast' ? (p.forecastDaily || []) : (p.daily || []);
}

// ── XLSX (Правило 5: только план продаж и цен по дням запрошенного периода) ──
export function seasonPlanXlsx(report, filePath) {
  const rows0 = planRows(report);
  const columns = [
    { header: 'Дата', width: 12 },
    { header: 'Этап', width: 20 },
    { header: 'Продажи план, шт', width: 16 },
    { header: 'Цена, ₽', width: 12 },
    { header: 'Благоприятно', width: 13 },
  ];
  const rows = rows0.map((r) => ({
    fill: r.favorable ? FAVORABLE : stageColor(r.stage),
    cells: [r.date, r.stage || '', Math.round(r.plannedOrders || 0), Math.round(r.price || 0), r.favorable ? 'да' : ''],
  }));
  writeXlsx(filePath, { name: 'План по дням', columns, rows }, [...Object.values(STAGE_COLORS), FAVORABLE]);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function stageBands(daily) {
  const bands = [];
  let cur = null;
  daily.forEach((r, i) => {
    if (!cur || cur.stage !== r.stage) { cur = { stage: r.stage, from: i, to: i }; bands.push(cur); }
    else cur.to = i;
  });
  return bands;
}
function favBands(daily) {
  const bands = [];
  let cur = null;
  daily.forEach((r, i) => {
    if (r.favorable) { if (!cur) { cur = { from: i, to: i }; bands.push(cur); } else cur.to = i; }
    else cur = null;
  });
  return bands;
}

/**
 * SVG-диаграмма. primary — площадь+линия (левая ось), secondary — пунктир (правая).
 * Плотная шкала дат: помесячные тики (+ поддней для коротких периодов).
 */
function svgChart(daily, { primaryKey, primaryLabel, primaryColor, secondaryKey, secondaryLabel, secondaryColor }) {
  const n = daily.length || 1;
  const W = 1000, H = 340, padL = 54, padR = 54, padT = 24, padB = 52;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (plotW * i) / Math.max(1, n - 1);
  const pv = daily.map((r) => Number(r[primaryKey]) || 0);
  const maxP = Math.max(1, ...pv);
  const sv = daily.map((r) => Number(r[secondaryKey]) || 0).filter((v) => v > 0);
  const minS = sv.length ? Math.min(...sv) : 0, maxS = sv.length ? Math.max(...sv) : 1;
  const yP = (v) => padT + plotH - (plotH * v) / maxP;
  const yS = (v) => padT + plotH - (plotH * (v - minS)) / Math.max(1, maxS - minS);

  const bands = stageBands(daily).map((b) => {
    const x0 = x(b.from), x1 = x(Math.min(b.to + 1, n - 1));
    return `<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(0.4, x1 - x0).toFixed(1)}" height="${plotH}" fill="${stageColor(b.stage)}" opacity="0.5"/>`;
  }).join('');
  const favs = favBands(daily).map((b) => {
    const x0 = x(b.from), x1 = x(Math.min(b.to + 1, n - 1));
    return `<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(0.6, x1 - x0).toFixed(1)}" height="6" fill="${FAVORABLE}"/>
<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(0.6, x1 - x0).toFixed(1)}" height="${plotH}" fill="${FAVORABLE}" opacity="0.14"/>`;
  }).join('');

  const areaPts = daily.map((r, i) => `${x(i).toFixed(1)},${yP(pv[i]).toFixed(1)}`).join(' ');
  const area = `<polyline points="${padL},${padT + plotH} ${areaPts} ${padL + plotW},${padT + plotH}" fill="${primaryColor}22" stroke="none"/><polyline points="${areaPts}" fill="none" stroke="${primaryColor}" stroke-width="2"/>`;
  const linePts = daily.map((r, i) => (Number(r[secondaryKey]) > 0 ? `${x(i).toFixed(1)},${yS(Number(r[secondaryKey])).toFixed(1)}` : null)).filter(Boolean).join(' ');
  const line = `<polyline points="${linePts}" fill="none" stroke="${secondaryColor}" stroke-width="1.6" stroke-dasharray="4 3"/>`;

  // Тики: начало каждого месяца; для коротких периодов добавляем середину месяца.
  const dense = n <= 130;
  const ticks = [];
  let lastYm = '';
  daily.forEach((r, i) => {
    const ym = r.date.slice(0, 7), dd = r.date.slice(8, 10);
    if (ym !== lastYm) { lastYm = ym; ticks.push({ i, label: r.date.slice(2, 7) }); }
    else if (dense && dd === '15') ticks.push({ i, label: '·15' });
  });
  const tickEls = ticks.map((t) =>
    `<line x1="${x(t.i).toFixed(1)}" y1="${padT + plotH}" x2="${x(t.i).toFixed(1)}" y2="${padT + plotH + 4}" stroke="var(--axis)"/>
<text x="${x(t.i).toFixed(1)}" y="${padT + plotH + 16}" font-size="8.5" text-anchor="middle" fill="var(--muted)" transform="rotate(-40 ${x(t.i).toFixed(1)} ${padT + plotH + 16})">${t.label}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${bands}${favs}
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)"/>
    ${area}${line}${tickEls}
    <text x="${padL}" y="${padT - 8}" font-size="10" fill="${primaryColor}">${primaryLabel} (макс ${fmt(maxP)})</text>
    <text x="${padL + plotW}" y="${padT - 8}" font-size="10" text-anchor="end" fill="${secondaryColor}">${secondaryLabel} ${fmt(minS)}–${fmt(maxS)} ₽</text>
  </svg>`;
}

export function seasonPlanHtml(report) {
  const p = report.plan || {};
  const isForecast = report.mode === 'forecast';
  const rank = p.rank ? `${p.rank.rank} · амплитуда ${p.rank.amplitude}` : '';

  const pricing = p.pricing ? `
<div class="cards">
  <div class="card"><div class="k">Вход/разгон</div><div class="v">${fmt(p.pricing.entry)} ₽</div></div>
  <div class="card hot"><div class="k">Пик</div><div class="v">${fmt(p.pricing.peak)} ₽</div></div>
  <div class="card"><div class="k">Распродажа</div><div class="v">${fmt(p.pricing.sale)} ₽</div></div>
  <div class="card"><div class="k">База, зак/день</div><div class="v">${fmt(p.baseDaily)}</div></div>
</div>` : '';

  const adj = isForecast && p.adjustments ? `
<div class="cards">
  <div class="card"><div class="k">База, зак/день</div><div class="v">${fmt(p.baseDaily)}</div></div>
  <div class="card"><div class="k">Цена: дрейф года ×</div><div class="v">${p.adjustments.priceAdj}</div></div>
  <div class="card"><div class="k">Объём: дрейф года ×</div><div class="v">${p.adjustments.volumeAdj}</div></div>
  <div class="card"><div class="k">Благопр. дней</div><div class="v">${Math.round((p.favorable?.share || 0) * 100)}%</div></div>
</div>
<p class="sub">Корректировка по конкурентам за ${p.adjustments.windowDays} дн.: цена ${fmt(p.adjustments.priorPrice)}→${fmt(p.adjustments.recentPrice)} ₽, продажи ${p.adjustments.priorAvgDaily}→${p.adjustments.recentAvgDaily} шт/день.</p>` : '';

  const charts = isForecast ? `
<h2>Прогноз на ${p.forecastPeriod.from} … ${p.forecastPeriod.to}</h2>
<div class="chart">${svgChart(p.forecastDaily || [], { primaryKey: 'plannedOrders', primaryLabel: 'план заказов, шт', primaryColor: '#2646A0', secondaryKey: 'price', secondaryLabel: 'цена', secondaryColor: '#C1121F' })}</div>
<h2>История спроса за 2 года (форма сезона)</h2>
<div class="chart">${svgChart(p.historyDaily || [], { primaryKey: 'sales', primaryLabel: 'продажи аналогов, шт', primaryColor: '#2E7D5B', secondaryKey: 'price', secondaryLabel: 'цена', secondaryColor: '#C1121F' })}</div>`
    : `<div class="chart">${svgChart(p.daily || [], { primaryKey: 'plannedOrders', primaryLabel: 'план заказов, шт', primaryColor: '#2646A0', secondaryKey: 'price', secondaryLabel: 'цена', secondaryColor: '#C1121F' })}</div>`;

  const legend = [...Object.entries(STAGE_COLORS), ['благоприятный период (спрос > предложения)', FAVORABLE]]
    .map(([s, c]) => `<span class="lg"><i style="background:${c}"></i>${s}</span>`).join('');

  const ph = p.phases;
  const phaseRow = (o) => o ? `<tr><td>${o.label}</td><td>${o.dateNext || o.date || '—'}</td><td>${o.index != null ? o.index : '—'}</td></tr>` : '';
  const phasesTable = ph ? `<h2>Фазы предстоящего сезона</h2>
<table><thead><tr><th>Фаза</th><th>Дата (проекция)</th><th>Индекс</th></tr></thead><tbody>
${phaseRow(ph.entry)}${phaseRow(ph.ramp)}${phaseRow(ph.hotStart)}${phaseRow(ph.peak)}${phaseRow(ph.hotEnd)}${phaseRow(ph.sale)}</tbody></table>` : '';

  const periodLine = isForecast
    ? `Прогноз ${p.forecastPeriod.from} … ${p.forecastPeriod.to} · история ${report.historyPeriod?.d1} … ${report.historyPeriod?.d2}`
    : `Период ${report.period?.d1} … ${report.period?.d2}`;

  return `<style>
  :root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--axis:#bbb;--card:#f6f7f9;--line:#e5e7eb}
  @media (prefers-color-scheme:dark){:root{--bg:#15171c;--fg:#e8e8ea;--muted:#9aa0aa;--axis:#555;--card:#1e2129;--line:#2a2e37}}
  :root[data-theme=dark]{--bg:#15171c;--fg:#e8e8ea;--muted:#9aa0aa;--axis:#555;--card:#1e2129;--line:#2a2e37}
  :root[data-theme=light]{--bg:#fff;--fg:#1a1a1a;--muted:#666;--axis:#bbb;--card:#f6f7f9;--line:#e5e7eb}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  .wrap{max-width:1040px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 2px} h2{font-size:15px;margin:22px 0 8px} .sub{color:var(--muted);margin:0 0 14px;font-size:13px}
  .chart{width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
  svg{display:block;min-width:760px;width:100%;height:auto}
  .legend{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0 6px;font-size:12px;color:var(--muted)}
  .lg{display:inline-flex;align-items:center;gap:6px} .lg i{width:12px;height:12px;border-radius:3px;display:inline-block}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:6px 0 12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:130px}
  .card.hot{outline:2px solid #F4A261}
  .card .k{font-size:12px;color:var(--muted)} .card .v{font-size:20px;font-weight:600}
  table{border-collapse:collapse;width:100%;margin:0 0 20px;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:600}
</style>
<div class="wrap">
  <h1>План продаж на сезон — ${esc(report.label || '')}</h1>
  <p class="sub">${periodLine} · ${rank}</p>
  ${adj || pricing}
  ${charts}
  <div class="legend">${legend}</div>
  ${phasesTable}
</div>`;
}
