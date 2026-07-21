// lib/reportExport.js — выгрузка плана продаж в два файла (Правило 4):
//   1) .xlsx — таблица по дням (продажи/цены) с раскраской по этапам сезона;
//   2) HTML-артефакт — визуальный отчёт: кривая сезона, фазы, план в штуках и цены.

import { writeXlsx } from './xlsxWriter.js';

// Характерные цвета этапов сезона.
export const STAGE_COLORS = {
  'вход': '#DCEBFF',
  'разгон': '#CDECCB',
  'старт сезона': '#FFF3B0',
  'пик сезона': '#F4A261',
  'начало распродажи': '#F6C6D0',
  'конец распродажи': '#E7E1F0',
  'межсезонье': '#F0F0F0',
};
const stageColor = (s) => STAGE_COLORS[s] || '#F0F0F0';

const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

// ── XLSX ─────────────────────────────────────────────────────────────────────

/** Пишет .xlsx с дневной таблицей плана (продажи, цены, этапы). */
export function seasonPlanXlsx(report, filePath) {
  const daily = report.plan?.daily || [];
  const columns = [
    { header: 'Дата (история)', width: 14 },
    { header: 'Дата (план)', width: 14 },
    { header: 'Этап', width: 20 },
    { header: 'Продажи план, шт', width: 16 },
    { header: 'Цена, ₽', width: 12 },
    { header: 'k продаж', width: 10 },
    { header: 'k остатков', width: 11 },
    { header: 'k дня недели', width: 12 },
  ];
  const rows = daily.map((r) => ({
    fill: stageColor(r.stage),
    cells: [
      r.date,
      r.dateNext,
      r.stage || '',
      Math.round(r.plannedOrders || 0),
      Math.round(r.price || 0),
      r.kSales ?? '',
      r.kStock ?? '',
      r.weekdayFactor ?? '',
    ],
  }));
  const palette = Object.values(STAGE_COLORS);
  writeXlsx(filePath, { name: 'План по дням', columns, rows }, palette);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

/** Группирует подряд идущие дни одного этапа в полосы для фона графика. */
function stageBands(daily) {
  const bands = [];
  let cur = null;
  daily.forEach((r, i) => {
    if (!cur || cur.stage !== r.stage) {
      cur = { stage: r.stage, from: i, to: i };
      bands.push(cur);
    } else cur.to = i;
  });
  return bands;
}

/** Строит self-contained HTML-артефакт с кривой сезона, фазами и планом. */
export function seasonPlanHtml(report) {
  const p = report.plan;
  const daily = p?.daily || [];
  const n = daily.length || 1;

  // Геометрия графика.
  const W = 1000, H = 380, padL = 56, padR = 56, padT = 20, padB = 44;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (plotW * i) / Math.max(1, n - 1);
  const maxOrders = Math.max(1, ...daily.map((r) => r.plannedOrders || 0));
  const prices = daily.map((r) => r.price || 0).filter((v) => v > 0);
  const minP = prices.length ? Math.min(...prices) : 0;
  const maxP = prices.length ? Math.max(...prices) : 1;
  const yO = (v) => padT + plotH - (plotH * v) / maxOrders;
  const yP = (v) => padT + plotH - (plotH * (v - minP)) / Math.max(1, maxP - minP);

  const bands = stageBands(daily).map((b) => {
    const x0 = x(b.from), x1 = x(Math.min(b.to + 1, n - 1));
    return `<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(0.5, x1 - x0).toFixed(1)}" height="${plotH}" fill="${stageColor(b.stage)}" opacity="0.55"/>`;
  }).join('');

  const ordersArea = (() => {
    const pts = daily.map((r, i) => `${x(i).toFixed(1)},${yO(r.plannedOrders || 0).toFixed(1)}`).join(' ');
    return `<polyline points="${padL},${padT + plotH} ${pts} ${padL + plotW},${padT + plotH}" fill="rgba(38,70,160,0.18)" stroke="none"/>
<polyline points="${pts}" fill="none" stroke="#2646A0" stroke-width="2"/>`;
  })();
  const priceLine = (() => {
    const pts = daily.map((r, i) => (r.price > 0 ? `${x(i).toFixed(1)},${yP(r.price).toFixed(1)}` : null)).filter(Boolean).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="#C1121F" stroke-width="1.6" stroke-dasharray="4 3"/>`;
  })();

  // Оси/тики по месяцам.
  const ticks = [];
  let lastYm = '';
  daily.forEach((r, i) => {
    const ym = r.date.slice(0, 7);
    if (ym !== lastYm) { lastYm = ym; ticks.push({ i, label: r.date.slice(0, 7) }); }
  });
  const tickEls = ticks.filter((_, k) => k % 2 === 0).map((t) =>
    `<line x1="${x(t.i).toFixed(1)}" y1="${padT + plotH}" x2="${x(t.i).toFixed(1)}" y2="${padT + plotH + 4}" stroke="var(--axis)"/>
<text x="${x(t.i).toFixed(1)}" y="${padT + plotH + 18}" font-size="9" text-anchor="middle" fill="var(--muted)">${t.label}</text>`).join('');

  const ph = p?.phases;
  const phaseRow = (o) => o ? `<tr><td>${o.label}</td><td>${o.dateNext || o.date || '—'}</td><td>${o.index != null ? o.index : '—'}</td></tr>` : '';
  const phasesTable = ph ? `
<table class="phases"><thead><tr><th>Фаза</th><th>Дата (предстоящий сезон)</th><th>Индекс</th></tr></thead><tbody>
${phaseRow(ph.entry)}${phaseRow(ph.ramp)}${phaseRow(ph.hotStart)}${phaseRow(ph.peak)}${phaseRow(ph.hotEnd)}${phaseRow(ph.sale)}
</tbody></table>` : '';

  const pricing = p?.pricing ? `
<div class="cards">
  <div class="card"><div class="k">Вход/разгон</div><div class="v">${fmt(p.pricing.entry)} ₽</div></div>
  <div class="card hot"><div class="k">Пик</div><div class="v">${fmt(p.pricing.peak)} ₽</div></div>
  <div class="card"><div class="k">Распродажа</div><div class="v">${fmt(p.pricing.sale)} ₽</div></div>
  <div class="card"><div class="k">База, зак/день</div><div class="v">${fmt(p.baseDaily)}</div></div>
</div>` : '';

  const legend = Object.entries(STAGE_COLORS).map(([s, c]) =>
    `<span class="lg"><i style="background:${c}"></i>${s}</span>`).join('');

  const rankLine = p ? `${p.rank.rank} · амплитуда p90/p50 ${p.rank.amplitude}` : '';

  return `<style>
  :root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--axis:#bbb;--card:#f6f7f9;--line:#e5e7eb}
  @media (prefers-color-scheme:dark){:root{--bg:#15171c;--fg:#e8e8ea;--muted:#9aa0aa;--axis:#444;--card:#1e2129;--line:#2a2e37}}
  :root[data-theme=dark]{--bg:#15171c;--fg:#e8e8ea;--muted:#9aa0aa;--axis:#444;--card:#1e2129;--line:#2a2e37}
  :root[data-theme=light]{--bg:#fff;--fg:#1a1a1a;--muted:#666;--axis:#bbb;--card:#f6f7f9;--line:#e5e7eb}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  .wrap{max-width:1040px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 2px} .sub{color:var(--muted);margin:0 0 16px}
  .chart{width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
  svg{display:block;min-width:720px;width:100%;height:auto}
  .legend{display:flex;flex-wrap:wrap;gap:12px;margin:10px 0 20px;font-size:12px;color:var(--muted)}
  .lg{display:inline-flex;align-items:center;gap:6px} .lg i{width:12px;height:12px;border-radius:3px;display:inline-block}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin:6px 0 20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:130px}
  .card.hot{outline:2px solid #F4A261}
  .card .k{font-size:12px;color:var(--muted)} .card .v{font-size:20px;font-weight:600}
  table{border-collapse:collapse;width:100%;margin:0 0 20px;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:600}
  .key{display:flex;gap:18px;font-size:12px;color:var(--muted);margin:8px 0 4px}
  .key b{color:var(--fg)}
</style>
<div class="wrap">
  <h1>План продаж на сезон — ${esc(report.label || '')}</h1>
  <p class="sub">Период истории ${report.period?.d1} … ${report.period?.d2} · ${rankLine}</p>
  ${pricing}
  <div class="key"><span>— <b style="color:#2646A0">план заказов, шт</b></span><span>· · <b style="color:#C1121F">цена, ₽</b></span><span>фон — этап сезона</span></div>
  <div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${bands}
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)"/>
    ${ordersArea}
    ${priceLine}
    ${tickEls}
    <text x="${padL}" y="${padT - 6}" font-size="10" fill="var(--muted)">заказы, шт (макс ${fmt(maxOrders)})</text>
    <text x="${padL + plotW}" y="${padT - 6}" font-size="10" text-anchor="end" fill="var(--muted)">цена ${fmt(minP)}–${fmt(maxP)} ₽</text>
  </svg></div>
  <div class="legend">${legend}</div>
  ${phasesTable}
</div>`;
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
