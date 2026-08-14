// scripts/lib/dashboard-kit.mjs — общий дизайн-кит для HTML/PDF-дашбордов FBS.
// Единая цветовая система (светлая/тёмная тема), КPI-карточки, панели, таблицы,
// SVG-графики (линии, пончик) и HTML-инфографика (горизонтальные бары, тепловые
// ячейки). Категорийная палитра прогнана валидатором dataviz (light+dark).
// Правила печати: A4, контроль разрывов, точная цветопередача — тексты не наезжают.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const nf = (n) => Number(Math.round(n) || 0).toLocaleString('ru-RU');
export const nf1 = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 });

// Категорийная палитра (var-имена; конкретные значения в CSS для обеих тем).
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const seriesColor = (i) => SERIES[i % SERIES.length];

// ── KPI-карточка ─────────────────────────────────────────────────────────────
export function kpi(num, label, variant = '') {
  return `<div class="kpi ${variant}"><div class="kpi-num">${esc(String(num))}</div><div class="kpi-lab">${label}</div></div>`;
}

// ── Легенда категорий ────────────────────────────────────────────────────────
export function legend(items) {
  return `<div class="legend">${items.map((it) => `<div class="lg"><span class="dot" style="background:${it.color}"></span><span class="lg-lab">${esc(it.label)}</span>${it.value != null ? `<span class="lg-num">${esc(String(it.value))}</span>` : ''}${it.sub ? `<span class="lg-sub">${esc(it.sub)}</span>` : ''}</div>`).join('')}</div>`;
}

// ── Горизонтальные бары (магнитуда по категориям) — чистый HTML, без наездов ──
export function hbars(items, { max, fmt = nf, accent = 'var(--accent)' } = {}) {
  const m = max || Math.max(1, ...items.map((i) => i.value));
  return `<div class="hbars">${items.map((it) => `<div class="hbar">
    <span class="hb-lab" title="${esc(it.label)}">${esc(it.label)}</span>
    <span class="hb-track"><span class="hb-fill" style="width:${(Math.max(0, it.value) / m * 100).toFixed(2)}%;background:${it.color || accent}"></span></span>
    <span class="hb-val">${fmt(it.value)}${it.sub ? `<span class="hb-sub"> ${esc(it.sub)}</span>` : ''}</span>
  </div>`).join('')}</div>`;
}

// ── Тепловая ячейка (последовательная шкала от прозрачного к акценту) ─────────
export function heatBg(value, max) {
  if (!value || value <= 0) return 'transparent';
  const t = Math.min(1, value / (max || 1));
  const a = (0.10 + 0.80 * t).toFixed(3);
  return `color-mix(in srgb, var(--accent) ${(Number(a) * 100).toFixed(0)}%, transparent)`;
}

// ── Пончик (доля целого) ─────────────────────────────────────────────────────
export function donut(items, { size = 168, thickness = 26, centerTop = '', centerSub = '' } = {}) {
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0) || 1;
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0;
  const segs = items.filter((i) => i.value > 0).map((i) => {
    const frac = i.value / total, len = frac * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${i.color}" stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
    off += len; return seg;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut" role="img">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${thickness}"></circle>
    ${segs}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-top">${esc(centerTop)}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" class="donut-sub">${esc(centerSub)}</text>
  </svg>`;
}

// ── Многолинейный график (изменение во времени) ──────────────────────────────
// series: [{name,color,values,bold?}], labels: [x-подписи]. Оси/сетка через var().
export function lineChart(series, labels, { width = 900, height = 300, fmtY = nf } = {}) {
  const pl = 54, pr = 16, pt = 14, pb = 40, iw = width - pl - pr, ih = height - pt - pb;
  const n = labels.length;
  let max = 0, min = 0;
  for (const s of series) for (const v of s.values) { if (v > max) max = v; if (v < min) min = v; }
  if (max === min) max = min + 1;
  const x = (i) => pl + (n <= 1 ? iw / 2 : iw * i / (n - 1));
  const y = (v) => pt + ih * (1 - (v - min) / (max - min));
  let grid = '';
  for (let t = 0; t <= 4; t++) { const val = min + (max - min) * t / 4, yy = y(val); grid += `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${width - pr}" y2="${yy.toFixed(1)}" stroke="var(--line)"/><text x="${pl - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="ax">${esc(fmtY(val))}</text>`; }
  const zero = min < 0 ? `<line x1="${pl}" y1="${y(0).toFixed(1)}" x2="${width - pr}" y2="${y(0).toFixed(1)}" stroke="var(--muted)" stroke-dasharray="3 3"/>` : '';
  const step = Math.max(1, Math.ceil(n / 10)); let xlab = '';
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) xlab += `<text x="${x(i).toFixed(1)}" y="${height - pb + 17}" text-anchor="middle" class="ax">${esc(l)}</text>`; });
  let paths = '';
  for (const s of series) {
    if (n === 1) { paths += `<circle cx="${x(0).toFixed(1)}" cy="${y(s.values[0]).toFixed(1)}" r="3.5" fill="${s.color}"/>`; continue; }
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.bold ? 3 : 2}" stroke-linejoin="round" stroke-linecap="round"${s.bold ? '' : ' opacity="0.95"'}/>`;
  }
  return `<svg viewBox="0 0 ${width} ${height}" class="linechart" preserveAspectRatio="xMidYMid meet" role="img">${grid}${zero}${paths}${xlab}</svg>`;
}

// ── Сгруппированные вертикальные бары (2 ряда: напр. принято/передано) ────────
export function groupedBars(labels, groups, { width = 900, height = 260, fmtY = nf } = {}) {
  const pl = 54, pr = 16, pt = 14, pb = 40, iw = width - pl - pr, ih = height - pt - pb;
  const n = labels.length;
  let max = 1; for (const g of groups) for (const v of g.values) if (v > max) max = v;
  const slot = iw / Math.max(1, n), bw = Math.min(18, slot / (groups.length + 1));
  const y = (v) => pt + ih * (1 - v / max);
  let grid = '';
  for (let t = 0; t <= 4; t++) { const val = max * t / 4, yy = y(val); grid += `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${width - pr}" y2="${yy.toFixed(1)}" stroke="var(--line)"/><text x="${pl - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="ax">${esc(fmtY(val))}</text>`; }
  let bars = '';
  labels.forEach((l, i) => {
    const cx = pl + slot * i + slot / 2;
    groups.forEach((g, gi) => {
      const v = g.values[i] || 0, bx = cx - (groups.length * bw) / 2 + gi * bw, by = y(v), bh = pt + ih - by;
      bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2.5" fill="${g.color}"></rect>`;
    });
  });
  const step = Math.max(1, Math.ceil(n / 12)); let xlab = '';
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) xlab += `<text x="${(pl + slot * i + slot / 2).toFixed(1)}" y="${height - pb + 17}" text-anchor="middle" class="ax">${esc(l)}</text>`; });
  return `<svg viewBox="0 0 ${width} ${height}" class="barchart" preserveAspectRatio="xMidYMid meet" role="img">${grid}${bars}${xlab}</svg>`;
}

// ── Обёртки страницы ─────────────────────────────────────────────────────────
export function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
export function artifact(title, body) {
  return `<title>${esc(title)}</title>\n<style>${CSS}</style>\n${body}`;
}

// ── Дизайн-система (CSS) ──────────────────────────────────────────────────────
const LIGHT = `
  --ground:#EEF3EF; --surface:#FFFFFF; --surface-2:#F5F9F6;
  --ink:#12211A; --muted:#54695D; --faint:#88998F;
  --line:#DDE7E0; --line-2:#C7D6CC;
  --accent:#1B965A; --accent-d:#127045; --accent-soft:#E1F3E9;
  --crit:#C43A50; --crit-soft:#FBE7EA; --warn:#B7791F; --warn-soft:#FAF0DA; --ok:#16875A; --ok-soft:#E4F3EC;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  --shadow:0 1px 2px rgba(18,33,26,.05),0 4px 16px rgba(18,33,26,.06);`;
const DARK = `
  --ground:#0A0F0C; --surface:#121A15; --surface-2:#16211B; --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038; --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --crit:#F0708A; --crit-soft:#2E1620; --warn:#E7B24C; --warn-soft:#2C2410; --ok:#3FBE86; --ok-soft:#12271C;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#2f9e2f; --s7:#9085e9; --s8:#e66767;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);`;

export const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em}
.num{font-variant-numeric:tabular-nums} .muted{color:var(--muted)} .accent{color:var(--accent-d)} .crit{color:var(--crit)} .ok{color:var(--ok)}
.ta-r{text-align:right} .tl{text-align:left}
.wrap{max-width:1180px;margin:0 auto;padding:36px 24px 56px}

.head{padding-bottom:18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:22px;flex-wrap:wrap;align-items:flex-start}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700}
.head h1{margin:0;font-size:26px;font-weight:750;letter-spacing:-.02em}
.sub{margin:8px 0 0;color:var(--muted);max-width:92ch;font-size:13.5px} .sub b{color:var(--ink)}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5} .stamp b{color:var(--ink);font-variant-numeric:tabular-nums}

.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:22px 0}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 16px;box-shadow:var(--shadow)}
.kpi-accent{background:linear-gradient(165deg,var(--accent-soft),var(--surface));border-color:var(--line-2)}
.kpi-crit{background:linear-gradient(165deg,var(--crit-soft),var(--surface))}
.kpi-num{font-size:24px;font-weight:750;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:tabular-nums;word-break:break-word}
.kpi-accent .kpi-num{color:var(--accent-d)} .kpi-crit .kpi-num{color:var(--crit)}
.kpi-lab{margin-top:6px;font-size:11.5px;color:var(--muted)}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px;box-shadow:var(--shadow);margin-bottom:16px}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap;border-left:3px solid var(--accent);padding-left:10px}
.panel-head h2{margin:0;font-size:16px;font-weight:750} .panel-sub{font-size:12.5px;color:var(--muted)} .panel-sub b{color:var(--ink);font-variant-numeric:tabular-nums}
.cols{display:grid;grid-template-columns:1fr;gap:20px} .cols-2{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}
.chart-wrap{width:100%;overflow:hidden}
.linechart,.barchart{width:100%;height:auto;display:block} .ax{font-size:11px;fill:var(--muted)}
.donut{display:block;margin:0 auto} .donut-top{font-size:20px;font-weight:750;fill:var(--ink)} .donut-sub{font-size:10.5px;fill:var(--muted)}

.legend{display:flex;flex-wrap:wrap;gap:7px 16px;margin-top:12px}
.lg{display:flex;align-items:center;gap:7px;font-size:12.5px} .lg .dot{width:11px;height:11px;border-radius:3px;flex:none}
.lg-lab{color:var(--muted)} .lg-num{font-weight:700;font-variant-numeric:tabular-nums} .lg-sub{color:var(--faint);font-size:11px}

.hbars{display:flex;flex-direction:column;gap:9px}
.hbar{display:grid;grid-template-columns:minmax(90px,150px) 1fr minmax(64px,auto);align-items:center;gap:12px}
.hb-lab{font-size:12.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hb-track{background:var(--surface-2);border-radius:6px;height:16px;overflow:hidden}
.hb-fill{display:block;height:100%;border-radius:6px;min-width:2px}
.hb-val{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap} .hb-sub{color:var(--faint);font-weight:400;font-size:11px}

.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--faint);font-weight:700;padding:0 9px 8px;border-bottom:1.5px solid var(--line-2);white-space:nowrap}
thead th.ta-r{text-align:right}
tbody td{padding:6px 9px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tfoot td{padding:7px 9px;border-top:2px solid var(--line-2);font-weight:750;font-variant-numeric:tabular-nums;white-space:nowrap}
.art{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--muted)}
.a-name{font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.cellnum{text-align:right;font-variant-numeric:tabular-nums}
.pill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;background:var(--accent-soft);color:var(--accent-d)}
.note{margin:11px 0 0;font-size:12px;color:var(--muted)}
.foot{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}

@media (max-width:1000px){ .kpis{grid-template-columns:repeat(3,1fr)} .cols-2{grid-template-columns:1fr} }
@media (max-width:560px){ .wrap{padding:24px 14px} .kpis{grid-template-columns:repeat(2,1fr)} .head h1{font-size:21px} }

@media print{
  @page{ size:A4 landscape; margin:10mm; }
  html,body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wrap{max-width:none;padding:0}
  .panel,.kpi,.kpis,section,.hbar{ page-break-inside:avoid }
  .kpis{grid-template-columns:repeat(5,1fr)}
  .panel{box-shadow:none;border-color:#D0D8D2}
  /* Широкие таблицы целиком на альбомный лист: без прокрутки, компактнее. */
  .table-scroll{overflow:visible}
  table{font-size:10px} thead th,tbody td,tfoot td{padding:4px 6px}
  .a-name{max-width:150px}
  thead{display:table-header-group} tr{page-break-inside:avoid}
}
`;
