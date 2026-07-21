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

/** 7-дневное скользящее среднее (для сглаживания недельной «пилы» на графике). */
function ma7(values) {
  const n = values.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
    let s = 0; for (let j = a; j <= b; j++) s += values[j];
    out[i] = s / (b - a + 1);
  }
  return out;
}
const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil((v || 1) / p) * p; };

/**
 * SVG-диаграмма с сеткой и подписями осей. primary — площадь+линия (левая ось,
 * заказы шт), secondary — пунктир (правая ось, цена ₽). smoothPrimary — сгладить
 * недельную «пилу» линии заказов (для прогноза). Тики по неделям.
 */
function svgChart(daily, { primaryLabel, primaryColor, secondaryLabel, secondaryColor, smoothPrimary = false }) {
  const n = daily.length || 1;
  const W = 1000, H = 360, padL = 62, padR = 64, padT = 22, padB = 58;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (plotW * i) / Math.max(1, n - 1);
  let pv = daily.map((r) => Number(r.plannedOrders ?? r.sales) || 0);
  if (smoothPrimary) pv = ma7(pv);
  const maxP = niceMax(Math.max(1, ...pv));
  const sv = daily.map((r) => Number(r.price) || 0).filter((v) => v > 0);
  const minSraw = sv.length ? Math.min(...sv) : 0, maxSraw = sv.length ? Math.max(...sv) : 1;
  // Небольшой отступ ценовой оси для читаемости.
  const minS = Math.floor(minSraw / 100) * 100, maxS = Math.ceil(maxSraw / 100) * 100;
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

  // Горизонтальная сетка + подписи левой (заказы) и правой (цена) осей.
  const grid = [];
  const steps = 4;
  for (let g = 0; g <= steps; g++) {
    const yy = padT + (plotH * g) / steps;
    const ov = Math.round((maxP * (steps - g)) / steps);
    const pvp = Math.round(minS + ((maxS - minS) * (steps - g)) / steps);
    grid.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
<text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${primaryColor}">${fmt(ov)}</text>
<text x="${padL + plotW + 6}" y="${(yy + 3).toFixed(1)}" font-size="9" fill="${secondaryColor}">${fmt(pvp)}</text>`);
  }

  const areaPts = daily.map((r, i) => `${x(i).toFixed(1)},${yP(pv[i]).toFixed(1)}`).join(' ');
  const area = `<polyline points="${padL},${padT + plotH} ${areaPts} ${padL + plotW},${padT + plotH}" fill="${primaryColor}22" stroke="none"/><polyline points="${areaPts}" fill="none" stroke="${primaryColor}" stroke-width="2"/>`;
  let priceS = daily.map((r) => Number(r.price) || 0);
  if (smoothPrimary) priceS = ma7(priceS);
  const linePts = daily.map((r, i) => (priceS[i] > 0 ? `${x(i).toFixed(1)},${yS(priceS[i]).toFixed(1)}` : null)).filter(Boolean).join(' ');
  const line = `<polyline points="${linePts}" fill="none" stroke="${secondaryColor}" stroke-width="1.8" stroke-dasharray="5 3"/>`;

  // Недельные тики; подпись даты раз в ~2 недели, чтобы не слипались.
  const tickEls = [];
  let k = 0;
  daily.forEach((r, i) => {
    const dow = new Date(r.date + 'T00:00:00Z').getUTCDay();
    if (dow === 1 || i === 0) { // понедельники
      const showLabel = k % 2 === 0;
      tickEls.push(`<line x1="${x(i).toFixed(1)}" y1="${padT + plotH}" x2="${x(i).toFixed(1)}" y2="${padT + plotH + (showLabel ? 5 : 3)}" stroke="var(--axis)"/>` +
        (showLabel ? `<text x="${x(i).toFixed(1)}" y="${padT + plotH + 20}" font-size="8.5" text-anchor="middle" fill="var(--muted)" transform="rotate(-45 ${x(i).toFixed(1)} ${padT + plotH + 20})">${r.date.slice(2)}</text>` : ''));
      k++;
    }
  });

  // Легенда линий.
  const legend = `<g font-size="10">
    <line x1="${padL}" y1="${padT - 8}" x2="${padL + 18}" y2="${padT - 8}" stroke="${primaryColor}" stroke-width="2"/>
    <text x="${padL + 23}" y="${padT - 5}" fill="var(--fg)">${primaryLabel}, шт (левая ось)${smoothPrimary ? ', сглажено' : ''}</text>
    <line x1="${padL + 240}" y1="${padT - 8}" x2="${padL + 258}" y2="${padT - 8}" stroke="${secondaryColor}" stroke-width="1.8" stroke-dasharray="5 3"/>
    <text x="${padL + 263}" y="${padT - 5}" fill="var(--fg)">${secondaryLabel}, ₽ (правая ось)</text>
  </g>`;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${grid.join('')}
    ${bands}${favs}
    ${area}${line}
    ${tickEls.join('')}
    ${legend}
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
<div class="chart">${svgChart(p.forecastDaily || [], { primaryLabel: 'план заказов', primaryColor: '#2646A0', secondaryLabel: 'цена', secondaryColor: '#C1121F', smoothPrimary: true })}</div>
<h2>История спроса за 2 года (реальные данные аналогов)</h2>
<div class="chart">${svgChart(p.historyDaily || [], { primaryLabel: 'продажи аналогов', primaryColor: '#2E7D5B', secondaryLabel: 'цена', secondaryColor: '#C1121F', smoothPrimary: false })}</div>`
    : `<div class="chart">${svgChart(p.daily || [], { primaryLabel: 'план заказов', primaryColor: '#2646A0', secondaryLabel: 'цена', secondaryColor: '#C1121F', smoothPrimary: false })}</div>`;

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
