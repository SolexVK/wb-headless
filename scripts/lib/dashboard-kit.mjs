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

// Семантические акценты для KPI/инсайтов (тёмные, читаемые на светлом).
export const AC = { green: '#127045', indigo: '#4338ca', amber: '#b45309', teal: '#0f766e', blue: '#1d4ed8', red: '#be2b41', violet: '#6d28d9' };

// ── KPI-карточка (акцентная рамка, лёгкий градиент, иконка) ──────────────────
export function kpi(num, label, { icon = '', accent = AC.green } = {}) {
  return `<div class="kpi" style="--kc:${accent}">
    ${icon ? `<span class="kpi-ic">${icon}</span>` : ''}
    <div class="kpi-num">${esc(String(num))}</div>
    <div class="kpi-lab">${label}</div>
  </div>`;
}

// ── Шапка панели с иконкой ───────────────────────────────────────────────────
export function panelHead(icon, title, sub = '', accent = 'var(--accent)') {
  return `<div class="panel-head" style="--pc:${accent}"><div class="ph-l"><span class="ph-ic">${icon}</span><h2>${esc(title)}</h2></div>${sub ? `<span class="panel-sub">${sub}</span>` : ''}</div>`;
}

// ── Строка «инсайтов»/выводов (карточки с иконкой и акцентом) ────────────────
export function insights(items) {
  if (!items || !items.length) return '';
  return `<section class="insights">${items.map((i) => `<div class="insight" style="--kc:${i.accent || AC.green}"><span class="ins-ic">${i.icon || '•'}</span><span class="ins-tx">${i.text}</span></div>`).join('')}</section>`;
}

// ── Сегментированная статус-полоса (доли по статусам) ────────────────────────
// segs: [{label, count, cls, extra}] где cls ∈ st-crit/st-warn/st-ok/st-dead/st-mute
export function statusBar(segs) {
  const total = segs.reduce((s, x) => s + x.count, 0) || 1;
  const bar = segs.filter((x) => x.count > 0).map((x) => `<span class="seg ${x.cls}" style="width:${(x.count / total * 100).toFixed(2)}%" title="${esc(x.label)}: ${x.count}"></span>`).join('');
  const leg = segs.map((x) => `<div class="lg"><span class="dot ${x.cls}"></span><span class="lg-lab">${esc(x.label)}</span><span class="lg-num">${nf(x.count)}</span>${x.extra ? `<span class="lg-sub">${esc(x.extra)}</span>` : ''}</div>`).join('');
  return `<div class="sbar">${bar}</div><div class="legend">${leg}</div>`;
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
    paths += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.bold ? 3.6 : 2}" stroke-linejoin="round" stroke-linecap="round"${s.bold ? '' : ' opacity="0.95"'}/>`;
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
  // data-theme="light" — дашборд всегда в светлой теме (независимо от ОС).
  return `<!doctype html><html lang="ru" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
export function artifact(title, body) {
  return `<title>${esc(title)}</title>\n<style>${CSS}</style>\n${body}`;
}

// ── Дизайн-система (CSS) ──────────────────────────────────────────────────────
const LIGHT = `
  --ground:#EBF0F5; --ground-2:#E3EAF2; --surface:#FFFFFF; --surface-2:#F3F7FB;
  --ink:#101826; --muted:#5A6B7E; --faint:#8695A6;
  --line:#E1E8F0; --line-2:#CDD9E6;
  --accent:#1B965A; --accent-d:#127045; --accent-soft:#E1F3E9;
  --total:#4338ca;
  --crit:#C43A50; --crit-soft:#FBE7EA; --warn:#B7791F; --warn-soft:#FAF0DA; --ok:#16875A; --ok-soft:#E4F3EC;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
  --shadow:0 1px 2px rgba(16,24,38,.05),0 6px 20px rgba(16,24,38,.07);`;
const DARK = `
  --ground:#0A0F0C; --ground-2:#0A0F0C; --surface:#121A15; --surface-2:#16211B; --ink:#E7F0EA; --muted:#93A79B; --faint:#63776B;
  --line:#20302A; --line-2:#2C4038; --accent:#35C77E; --accent-d:#2AA268; --accent-soft:#12271C;
  --total:#a5b4fc;
  --crit:#F0708A; --crit-soft:#2E1620; --warn:#E7B24C; --warn-soft:#2C2410; --ok:#3FBE86; --ok-soft:#12271C;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#2f9e2f; --s7:#9085e9; --s8:#e66767;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 6px 22px rgba(0,0,0,.42);`;

export const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(180deg,var(--ground),var(--ground-2));min-height:100vh;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.86em}
.num{font-variant-numeric:tabular-nums} .muted{color:var(--muted)} .accent{color:var(--accent-d)} .crit{color:var(--crit)} .ok{color:var(--ok)}
.ta-r{text-align:right} .tl{text-align:left}
.wrap{max-width:1180px;margin:0 auto;padding:34px 24px 56px}

.head{position:relative;padding:20px 22px 20px 26px;margin-bottom:20px;background:linear-gradient(120deg,var(--surface),color-mix(in srgb,var(--accent) 6%,var(--surface)));border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);display:flex;justify-content:space-between;gap:22px;flex-wrap:wrap;align-items:flex-start;overflow:hidden}
.head::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,var(--accent),var(--total))}
.eyebrow{margin:0 0 6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-d);font-weight:700}
.head h1{margin:0;font-size:26px;font-weight:780;letter-spacing:-.02em}
.sub{margin:8px 0 0;color:var(--muted);max-width:92ch;font-size:13.5px} .sub b{color:var(--ink)}
.stamp{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap;line-height:1.5;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 12px} .stamp b{color:var(--ink);font-variant-numeric:tabular-nums}

.insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin:0 0 18px}
.insight{display:flex;align-items:center;gap:11px;background:linear-gradient(180deg,color-mix(in srgb,var(--kc) 9%,var(--surface)),var(--surface));border:1px solid var(--line);border-left:4px solid var(--kc);border-radius:12px;padding:12px 15px;font-size:13px;box-shadow:var(--shadow)}
.ins-ic{font-size:20px;flex:none;line-height:1} .ins-tx{color:var(--muted)} .ins-tx b{color:var(--kc);font-weight:750}

.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:13px;margin:0 0 20px}
.kpi{position:relative;background:linear-gradient(180deg,color-mix(in srgb,var(--kc) 8%,var(--surface)),var(--surface));border:1px solid var(--line);border-top:3px solid var(--kc);border-radius:14px;padding:16px 16px 15px;box-shadow:var(--shadow);overflow:hidden}
.kpi-ic{position:absolute;top:13px;right:13px;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;background:color-mix(in srgb,var(--kc) 15%,var(--surface))}
.kpi-num{font-size:25px;font-weight:780;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:tabular-nums;word-break:break-word;color:var(--kc);padding-right:34px}
.kpi-lab{margin-top:6px;font-size:11.5px;color:var(--muted)}

.panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:var(--shadow);margin-bottom:16px}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:-2px 0 15px;padding-bottom:13px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.ph-l{display:flex;align-items:center;gap:11px;min-width:0}
.ph-ic{width:32px;height:32px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1;background:color-mix(in srgb,var(--pc) 14%,var(--surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pc) 22%,transparent)}
.panel-head h2{margin:0;font-size:16px;font-weight:750}
.panel-sub{font-size:12.5px;color:var(--muted);white-space:nowrap} .panel-sub b{color:var(--ink);font-variant-numeric:tabular-nums}
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
  @page{ size:A4 landscape; margin:8mm; }
  html,body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wrap{max-width:none;padding:0}
  .panel,.kpi,.kpis,.insights,.insight,.hbar{ page-break-inside:avoid }
  .kpis{grid-template-columns:repeat(5,1fr)}
  .panel{box-shadow:none;border-color:#D0D8D2}
  /* Широкие таблицы ЦЕЛИКОМ в ширину листа: тянем на 100%, переносим текст,
     мелкий кегль — ничего не уезжает за границу страницы. */
  .table-scroll{overflow:visible}
  table{width:100%!important;table-layout:auto;font-size:8.5px;border-collapse:collapse}
  thead th,tbody td,tfoot td{padding:2.5px 4px;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
  .a-name{max-width:none;white-space:normal}
  thead{display:table-header-group} tr{page-break-inside:avoid}
}

/* ── Статусные утилиты (подсорт: сегментированная полоса, пилюли, точки) ── */
.sbar{display:flex;height:16px;border-radius:6px;overflow:hidden;background:var(--surface-2);border:1px solid var(--line)}
.sbar .seg{height:100%}
.st-crit{background:var(--crit)} .st-warn{background:var(--warn)} .st-ok{background:var(--ok)} .st-dead{background:var(--faint)} .st-mute{background:var(--line-2)}
.pill.crit{background:var(--crit-soft);color:var(--crit)} .pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.ok{background:var(--ok-soft);color:var(--ok)} .pill.dead{background:var(--surface-2);color:var(--faint)} .pill.mute{background:var(--surface-2);color:var(--muted)}
.pill.newx{background:var(--accent-soft);color:var(--accent-d)} .pill.refill{background:var(--warn-soft);color:var(--warn)}
.reorder{font-weight:750;color:var(--accent-d)} .dtz-crit{color:var(--crit);font-weight:700} .dtz-warn{color:var(--warn);font-weight:700}
tbody tr.row-crit td.art{box-shadow:inset 3px 0 0 var(--crit)} tbody tr.row-warn td.art{box-shadow:inset 3px 0 0 var(--warn)}
`;
