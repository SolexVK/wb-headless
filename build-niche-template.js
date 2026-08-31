// build-niche-template.js — ШАБЛОН отчёта по анализу ниши WB (12 разделов).
// Данные — ОБРАЗЕЦ (для демонстрации структуры и инфографики). Реальные цифры
// подставляются позже из MPStats + публичных API WB. Самодостаточный HTML → PDF.
import fs from 'fs';

const S = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => Math.round(n).toLocaleString('ru-RU');
const mln = (n) => (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const mlrd = (n) => (n / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

// ---------- SVG-помощники ----------
function donut(segs, { size = 150, thick = 26, cx = null, cy = null } = {}) {
  const r = (size - thick) / 2, CX = cx ?? size / 2, CY = cy ?? size / 2, C = 2 * Math.PI * r;
  const tot = segs.reduce((s, x) => s + x.v, 0) || 1;
  let off = 0, arcs = '';
  segs.forEach((s) => {
    const frac = s.v / tot, len = frac * C;
    arcs += `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${s.c}" stroke-width="${thick}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})"/>`;
    off += len;
  });
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="chart">${arcs}</svg>`;
}
function hbars(rows, { w = 560, rowH = 30, pad = 6, unit = '', fmt = money, hiTop = 3, color = 'var(--accent)' } = {}) {
  const labelW = 168, barX = labelW + 10, barMax = w - barX - 92;
  const max = Math.max(...rows.map((r) => r.v));
  const H = rows.length * rowH + pad * 2;
  let s = `<svg viewBox="0 0 ${w} ${H}" width="100%" class="chart">`;
  for (let g = 0; g <= 4; g++) { const x = barX + barMax * g / 4; s += `<line x1="${x}" y1="${pad}" x2="${x}" y2="${H - pad}" class="grid"/>`; }
  rows.forEach((r, i) => {
    const y = pad + i * rowH, bw = Math.max(2, r.v / max * barMax);
    s += `<text x="${labelW}" y="${y + rowH / 2}" class="blab" text-anchor="end" dominant-baseline="middle">${S(r.k)}</text>`;
    s += `<rect x="${barX}" y="${y + 5}" width="${bw.toFixed(1)}" height="${rowH - 12}" rx="3" fill="${i < hiTop ? color : 'var(--bar)'}"/>`;
    s += `<text x="${barX + bw + 7}" y="${y + rowH / 2}" class="bval" dominant-baseline="middle">${fmt(r.v)}${unit}</text>`;
  });
  return s + `</svg>`;
}
function combo(months, vals, line, { w = 560, h = 150, pad = 24 } = {}) {
  const max = Math.max(...vals), lmax = Math.max(...line);
  const bw = (w - pad * 2) / vals.length * 0.6, gap = (w - pad * 2) / vals.length;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" class="chart">`;
  for (let g = 0; g <= 3; g++) { const y = pad + (h - pad * 1.6) * g / 3; s += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" class="grid"/>`; }
  vals.forEach((v, i) => {
    const x = pad + gap * i + gap / 2, bh = (v / max) * (h - pad * 1.8);
    s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(h - pad - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="var(--accent)" opacity="0.85"/>`;
    s += `<text x="${x.toFixed(1)}" y="${h - pad + 11}" class="axis" text-anchor="middle">${S(months[i])}</text>`;
  });
  const pts = line.map((v, i) => `${(pad + gap * i + gap / 2).toFixed(1)},${(pad + (1 - v / lmax) * (h - pad * 1.8)).toFixed(1)}`).join(' ');
  s += `<polyline points="${pts}" fill="none" stroke="var(--teal)" stroke-width="2.5"/>`;
  line.forEach((v, i) => { const x = pad + gap * i + gap / 2, y = pad + (1 - v / lmax) * (h - pad * 1.8); s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="var(--teal)"/>`; });
  return s + `</svg>`;
}
function rangeBar(sizes, coreFrom, coreTo, { w = 560, h = 64, pad = 20 } = {}) {
  const n = sizes.length, gap = (w - pad * 2) / (n - 1);
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" class="chart">`;
  const y = h / 2 - 4;
  const xi = (i) => pad + gap * i;
  const ci = sizes.indexOf(coreFrom), cj = sizes.indexOf(coreTo);
  s += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="var(--bar)" stroke-width="6" stroke-linecap="round"/>`;
  s += `<line x1="${xi(ci)}" y1="${y}" x2="${xi(cj)}" y2="${y}" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/>`;
  sizes.forEach((sz, i) => {
    const core = i >= ci && i <= cj;
    s += `<circle cx="${xi(i)}" cy="${y}" r="${core ? 5 : 4}" fill="${core ? 'var(--accent)' : 'var(--card)'}" stroke="${core ? 'var(--accent)' : 'var(--bar)'}" stroke-width="2"/>`;
    s += `<text x="${xi(i)}" y="${y + 22}" class="axis" text-anchor="middle" ${core ? 'style="fill:var(--ink);font-weight:600"' : ''}>${sz}</text>`;
  });
  return s + `</svg>`;
}
function groupedBars(groups, series, { w = 560, h = 168, pad = 26 } = {}) {
  // groups: ['Осень',...]; series: [{name,color,vals[]}]
  const all = series.flatMap((s) => s.vals), max = Math.max(...all);
  const gW = (w - pad * 2) / groups.length, bw = gW / (series.length + 1);
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" class="chart">`;
  for (let g = 0; g <= 3; g++) { const y = pad + (h - pad * 1.8) * g / 3; s += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" class="grid"/>`; }
  groups.forEach((g, gi) => {
    series.forEach((se, si) => {
      const v = se.vals[gi], bh = (v / max) * (h - pad * 2);
      const x = pad + gW * gi + bw * (si + 0.5);
      s += `<rect x="${x.toFixed(1)}" y="${(h - pad - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${se.color}"/>`;
    });
    s += `<text x="${(pad + gW * gi + gW / 2).toFixed(1)}" y="${h - pad + 12}" class="axis" text-anchor="middle">${S(g)}</text>`;
  });
  return s + `</svg>`;
}

// ---------- ОБРАЗЕЦ ДАННЫХ (демонстрация структуры) ----------
const D = {
  subject: 'Блузка женская', period: '12 месяцев', priceQ: '3 месяца',
  s1_revYear: 4.24e9, s1_unitsYear: 1_820_000,
  s2_lost: 1.58e9, s2_lostShare: 0.28,
  s3_top10: 12, s3_top30: 24, s3_rest: 76,
  s4_suppliers: 3450, s4_brands: 2980,
  s5_buyout: 41,
  s6_segments: [
    { k: 'до 1 000 ₽', v: 14 }, { k: '1 000–1 800 ₽', v: 31 }, { k: '1 800–2 700 ₽', v: 28 },
    { k: '2 700–4 000 ₽', v: 18 }, { k: '4 000 ₽ +', v: 9 },
  ],
  s7_brands: [
    { k: 'Бренд A', v: 96e6 }, { k: 'Бренд B', v: 78e6 }, { k: 'Бренд C', v: 64e6 }, { k: 'Бренд D', v: 55e6 }, { k: 'Бренд E', v: 47e6 },
    { k: 'Бренд F', v: 41e6 }, { k: 'Бренд G', v: 37e6 }, { k: 'Бренд H', v: 33e6 }, { k: 'Бренд I', v: 29e6 }, { k: 'Бренд J', v: 25e6 },
  ],
  s8_queries: [
    { q: 'блузка женская', f: '210 тыс/мес' }, { q: 'блузка нарядная', f: '96 тыс/мес' },
    { q: 'блузка белая', f: '74 тыс/мес' }, { q: 'блузка офисная', f: '58 тыс/мес' }, { q: 'блузка с длинным рукавом', f: '41 тыс/мес' },
  ],
  s10_colors: [
    { k: 'белый', v: 34, c: '#E9EAEC' }, { k: 'чёрный', v: 22, c: '#23262B' }, { k: 'бежевый', v: 11, c: '#D8C4A0' },
    { k: 'синий', v: 9, c: '#3B5BA5' }, { k: 'красный', v: 7, c: '#C0392B' }, { k: 'зелёный', v: 6, c: '#4E8D6E' }, { k: 'прочие', v: 11, c: '#9AA0A6' },
  ],
  s11_sizes: ['40', '42', '44', '46', '48', '50', '52', '54', '56'], s11_core: ['44', '50'],
  s12_seasons: ['Осень', 'Зима', 'Весна', 'Лето'],
  s12_mid: [2.1e6, 2.4e6, 2.0e6, 1.7e6], s12_high: [3.6e6, 4.2e6, 3.4e6, 2.9e6],
};
const MONTHS = ['сен', 'окт', 'ноя', 'дек', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг'];
const competitors = [1, 2, 3, 4, 5].map((i) => ({
  rank: i, name: `Конкурент №${i} — «Название модели»`, brand: `Бренд ${['A', 'B', 'C', 'D', 'E'][i - 1]}`, sku: `1000000${i}`,
  ordRub: [96, 78, 64, 55, 47][i - 1] * 1e6, ordPcs: [40, 33, 27, 23, 20][i - 1] * 1000,
  buyRub: [40, 33, 27, 23, 20][i - 1] * 1e6, buyPcs: [17, 14, 11, 10, 8][i - 1] * 1000,
  lost: [24, 19, 16, 14, 12][i - 1] * 1e6,
  seasons: { 'осень': 2350 - i * 40, 'зима': 2480 - i * 40, 'весна': 2300 - i * 40, 'лето': 2190 - i * 40 },
  monthly: MONTHS.map((_, m) => 5 + Math.round(4 * Math.sin(m / 2) + i)), stock: MONTHS.map((_, m) => 8 + Math.round(3 * Math.cos(m / 2))),
  reviews: [5340, 3120, 2680, 1940, 1510][i - 1], rating: [4.8, 4.7, 4.9, 4.6, 4.8][i - 1],
  negThemes: [{ k: 'маломерит', v: 32, c: 'var(--accent)' }, { k: 'отличие от фото', v: 24, c: '#D98324' }, { k: 'качество ткани', v: 18, c: '#B5179E' }, { k: 'швы/пошив', v: 14, c: '#5B6470' }, { k: 'доставка', v: 12, c: '#3B5BA5' }],
  negs: ['«Пришло на размер меньше, берите на размер больше»', '«Цвет отличается от фото — на деле темнее»', '«Ткань просвечивает, дешевит вид»', '«Кривые швы на рукаве»', '«Долго шёл, помятый в упаковке»', '«Нитки торчат, брак фурнитуры»'],
  patterns: ['Инфографика на 1–2 фото (состав, посадка, размерная сетка)', 'Видео-обзор на карточке → выше конверсия', 'Заголовок с 3–4 ключами («блузка нарядная белая офисная»)', 'Отработка «маломерит» в описании и ответах на отзывы', 'Реклама в пик сезона (окт–дек), цена в среднем сегменте'],
}));

// ---------- РЕНДЕР ----------
const kpi = (kt, kv, kl) => `<div class="kpi"><div class="kt">${kt}</div><div class="kv">${kv}</div><div class="kl">${kl}</div></div>`;
const secH = (n, t) => `<h2><span class="n">${n}</span>${t}</h2>`;

function competitorCard(c) {
  return `<div class="comp">
    <div class="chead"><span class="crk">#${c.rank}</span><b>${S(c.name)}</b><span class="cbrand">${S(c.brand)} · арт. ${c.sku}</span></div>
    <div class="cgrid">
      <div class="cmoney">
        <div class="mrow"><span>Выручка/год (заказы)</span><b>${mln(c.ordRub)} млн ₽ · ${money(c.ordPcs)} шт</b></div>
        <div class="mrow"><span>Выручка/год (выкупы)</span><b>${mln(c.buyRub)} млн ₽ · ${money(c.buyPcs)} шт</b></div>
        <div class="mrow"><span>Упущенная выручка</span><b>${mln(c.lost)} млн ₽</b></div>
        <div class="mrow"><span>Отзывы · рейтинг</span><b>${money(c.reviews)} · ★ ${c.rating}</b></div>
        <div class="seasons">${Object.entries(c.seasons).map(([k, v]) => `<div class="sea"><span>${k}</span><b>${money(v)} ₽</b></div>`).join('')}</div>
      </div>
      <div class="cchart">
        <div class="cap">Выручка по месяцам (столбцы) + остаток (линия)</div>
        ${combo(MONTHS, c.monthly, c.stock, { w: 380, h: 130 })}
      </div>
    </div>
    <div class="cgrid2">
      <div class="cneg">
        <div class="cap">Негатив в отзывах — по смыслам</div>
        <div class="stack">${c.negThemes.map((t) => `<span style="width:${t.v}%;background:${t.c}" title="${t.k}"></span>`).join('')}</div>
        <div class="stleg">${c.negThemes.map((t) => `<span><i style="background:${t.c}"></i>${t.k} ${t.v}%</span>`).join('')}</div>
        <ul class="negs">${c.negs.map((n) => `<li>${S(n)}</li>`).join('')}</ul>
      </div>
      <div class="cpat">
        <div class="cap">Диагональное сканирование — успешные паттерны</div>
        <ul class="pat">${c.patterns.map((p) => `<li>${S(p)}</li>`).join('')}</ul>
      </div>
    </div>
  </div>`;
}

const html = `<title>Шаблон анализа ниши WB</title>
<style>
:root{--ground:#F5F6F8;--card:#FFFFFF;--ink:#151A21;--muted:#5B6470;--line:#E4E7EC;--accent:#C2185B;--accent-soft:#FBE7EF;--teal:#00897B;--teal-soft:#E1F1EF;--bar:#CDD3DB;--grid:#EAEDF1;--good:#2E9E6B;--warn:#E8A33D;--shadow:0 1px 2px rgba(20,26,33,.04),0 8px 22px rgba(20,26,33,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#16131C;--card:#201B29;--ink:#F2EEF4;--muted:#A69EB2;--line:#332B40;--accent:#F0619B;--accent-soft:#3A1E2E;--teal:#3FB8A8;--teal-soft:#12332E;--bar:#463C55;--grid:#2A2335;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px rgba(0,0,0,.35)}}
:root[data-theme="dark"]{--ground:#16131C;--card:#201B29;--ink:#F2EEF4;--muted:#A69EB2;--line:#332B40;--accent:#F0619B;--accent-soft:#3A1E2E;--teal:#3FB8A8;--teal-soft:#12332E;--bar:#463C55;--grid:#2A2335;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px rgba(0,0,0,.35)}
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:'Instrument Sans',system-ui,sans-serif;line-height:1.5;font-size:13.5px;-webkit-font-smoothing:antialiased}
.wrap{max-width:840px;margin:0 auto;padding:34px 22px 64px}
.ribbon{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;background:var(--accent);color:#fff;padding:4px 12px;border-radius:6px;margin-bottom:14px}
.eyebrow{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
h1{font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:clamp(28px,5vw,40px);line-height:1.05;margin:0 0 8px;letter-spacing:-.01em}
.lead{font-size:15px;color:var(--muted);max-width:64ch;margin:0}
.tnote{background:var(--teal-soft);border:1px solid var(--line);border-left:4px solid var(--teal);border-radius:10px;padding:12px 16px;margin-top:16px;font-size:12.5px;color:var(--ink)}
h2{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:20px;margin:34px 0 12px;letter-spacing:-.01em;display:flex;align-items:baseline;gap:10px}
h2 .n{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#fff;background:var(--accent);border-radius:5px;padding:2px 7px;font-weight:500}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:18px 20px;box-shadow:var(--shadow)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:11px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 14px;box-shadow:var(--shadow)}
.kpi .kt{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;line-height:1.3}
.kpi .kv{font-family:'Fraunces',serif;font-weight:900;font-size:22px;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .kl{font-size:11px;color:var(--muted);margin-top:6px;line-height:1.3}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.row2b{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:center}
.chart .grid{stroke:var(--grid)}
.chart .blab{font-size:12px;fill:var(--ink)}.chart .bval{font-size:11.5px;fill:var(--muted);font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.chart .axis{font-size:10px;fill:var(--muted);font-family:'IBM Plex Mono',monospace}
.cap{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
.dlegend{display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.dlegend span{display:flex;align-items:center;gap:8px}.dlegend i{width:11px;height:11px;border-radius:3px;flex:none}
.dlegend b{margin-left:auto;font-family:'IBM Plex Mono',monospace}
.segbars .seg{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12.5px}
.segbars .seg .lbl{width:120px;color:var(--ink)}
.segbars .seg .track{flex:1;height:16px;background:var(--grid);border-radius:5px;overflow:hidden}
.segbars .seg .fill{height:100%;background:var(--accent);border-radius:5px}
.segbars .seg .pc{width:40px;text-align:right;font-family:'IBM Plex Mono',monospace}
.chips{display:flex;flex-wrap:wrap;gap:9px}
.chip{background:var(--accent-soft);border:1px solid var(--line);border-radius:22px;padding:8px 14px;font-size:13px}
.chip b{color:var(--accent)}.chip span{color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:11px;margin-left:6px}
/* competitor */
.comp{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:16px 18px;box-shadow:var(--shadow);margin-top:13px}
.chead{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--line);margin-bottom:12px}
.chead .crk{font-family:'Fraunces',serif;font-weight:900;color:var(--accent);font-size:17px}
.chead b{font-size:14px}.chead .cbrand{font-size:11.5px;color:var(--muted);font-family:'IBM Plex Mono',monospace;margin-left:auto}
.cgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.mrow{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:4px 0;border-bottom:1px dashed var(--line)}
.mrow span{color:var(--muted)}.mrow b{font-family:'IBM Plex Mono',monospace;text-align:right}
.seasons{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:9px}
.sea{background:var(--ground);border:1px solid var(--line);border-radius:8px;padding:6px 4px;text-align:center}
.sea span{display:block;font-size:9.5px;color:var(--muted);text-transform:capitalize}.sea b{font-family:'IBM Plex Mono',monospace;font-size:11.5px}
.cgrid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px}
.stack{display:flex;height:16px;border-radius:5px;overflow:hidden;margin-bottom:8px}.stack span{display:block;height:100%}
.stleg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--muted);margin-bottom:8px}.stleg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
ul.negs,ul.pat{margin:0;padding-left:16px;font-size:12px;line-height:1.5}ul.negs li{color:var(--ink);margin:2px 0}ul.pat li{margin:3px 0}
ul.pat li::marker{color:var(--accent)}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);line-height:1.6}.foot b{color:var(--ink)}
@media (max-width:720px){.kpis{grid-template-columns:1fr 1fr 1fr}.row2,.cgrid,.cgrid2{grid-template-columns:1fr}.wrap{padding:24px 13px 50px}}
@media print{body{background:#fff}.card,.kpi,.comp{box-shadow:none}.wrap{max-width:100%}h2{break-after:avoid}.comp,.card,.kpi{break-inside:avoid}}
</style>
<div class="wrap">
  <span class="ribbon">Шаблон · данные — образец</span>
  <p class="eyebrow">Анализ ниши Wildberries · MPStats + публичные API WB</p>
  <h1>Анализ ниши: ${S(D.subject)}</h1>
  <p class="lead">Шаблон отчёта из 12 разделов. Ниже — структура и виды диаграмм на образцовых числах; в реальном отчёте всё подставляется из данных за выбранный период.</p>
  <div class="tnote"><b>Как читать:</b> это макет. Все значения условны и служат для демонстрации вёрстки, инфографики и типов диаграмм. Реальные цифры и подписи заполняются автоматически.</div>

  ${secH('01–05', 'Рынок ниши в цифрах')}
  <div class="kpis">
    ${kpi('01 · Объём продаж (год)', mlrd(D.s1_revYear) + ' млрд ₽', money(D.s1_unitsYear) + ' шт')}
    ${kpi('02 · Упущенная выручка', mlrd(D.s2_lost) + ' млрд ₽', Math.round(D.s2_lostShare * 100) + '% от потенциала')}
    ${kpi('03 · Монополизация', D.s3_top10 + '%', 'доля топ-10 в выручке')}
    ${kpi('04 · Продавцы / бренды', money(D.s4_suppliers), 'поставщиков · ' + money(D.s4_brands) + ' брендов с продажами')}
    ${kpi('05 · Ср. выкуп', D.s5_buyout + '%', 'с учётом возвратов')}
  </div>

  ${secH('03', 'Доля монополизации рынка топами')}
  <div class="card row2b">
    ${donut([{ v: D.s3_top10, c: 'var(--accent)' }, { v: D.s3_top30 - D.s3_top10, c: 'var(--teal)' }, { v: D.s3_rest, c: 'var(--bar)' }], { size: 150 })}
    <div class="dlegend">
      <span><i style="background:var(--accent)"></i>Топ-10 брендов<b>${D.s3_top10}%</b></span>
      <span><i style="background:var(--teal)"></i>Топ-11…30<b>${D.s3_top30 - D.s3_top10}%</b></span>
      <span><i style="background:var(--bar)"></i>Остальные (${money(D.s4_brands)} брендов)<b>${D.s3_rest}%</b></span>
      <span style="color:var(--muted);font-size:11.5px;margin-top:4px">Низкая доля топов = раздробленный рынок, легче зайти новичку.</span>
    </div>
  </div>

  ${secH('06', 'Распределение по ценовым сегментам (за 3 мес)')}
  <div class="card segbars">
    ${D.s6_segments.map((s) => `<div class="seg"><span class="lbl">${S(s.k)}</span><span class="track"><span class="fill" style="width:${s.v * 2.6}%"></span></span><span class="pc">${s.v}%</span></div>`).join('')}
  </div>

  ${secH('07', 'Топ-10 брендов по выручке за год')}
  <div class="card">${hbars(D.s7_brands, { unit: '', fmt: (v) => mln(v) + ' млн', hiTop: 3 })}</div>

  ${secH('08', 'Топ-5 ключевых запросов ниши')}
  <div class="card"><div class="chips">${D.s8_queries.map((q) => `<span class="chip"><b>${S(q.q)}</b><span>${S(q.f)}</span></span>`).join('')}</div></div>

  ${secH('09', 'Разбор Топ-5 конкурентов (по убыванию выручки)')}
  <p class="lead" style="margin:-4px 0 4px;font-size:13px">По каждому: выручка (заказы/выкупы) ₽ и шт, упущенная, средняя цена по сезонам, помесячная динамика, отзывы+рейтинг, сгруппированный негатив (5–10 примеров) и паттерны из диагонального сканирования.</p>
  ${competitors.map(competitorCard).join('')}

  ${secH('10', 'Доли расцветок (по 100–200 топ-артикулам)')}
  <div class="card row2b">
    ${donut(D.s10_colors.map((c) => ({ v: c.v, c: c.c })), { size: 150 })}
    <div class="dlegend">${D.s10_colors.map((c) => `<span><i style="background:${c.c};${c.k === 'белый' ? 'border:1px solid #cbd0d6' : ''}"></i>${S(c.k)}<b>${c.v}%</b></span>`).join('')}</div>
  </div>

  ${secH('11', 'Размерный ряд (по топ-10)')}
  <div class="card"><div class="cap">Ядро спроса — выделено акцентом (${D.s11_core[0]}–${D.s11_core[1]})</div>${rangeBar(D.s11_sizes, D.s11_core[0], D.s11_core[1])}</div>

  ${secH('12', 'Средняя выручка по сегментам · средний / высокий (по сезонам)')}
  <div class="card">
    <div class="cap" style="display:flex;gap:16px"><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--teal);vertical-align:-1px;margin-right:5px"></i>средний сегмент</span><span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--accent);vertical-align:-1px;margin-right:5px"></i>высокий сегмент</span></div>
    ${groupedBars(D.s12_seasons, [{ name: 'средний', color: 'var(--teal)', vals: D.s12_mid }, { name: 'высокий', color: 'var(--accent)', vals: D.s12_high }])}
    <div class="cap" style="margin-top:6px;text-transform:none;letter-spacing:0">Значения — средняя годовая выручка на 1 артикул в сегменте, млн ₽ (образец).</div>
  </div>

  <div class="foot">
    <p><b>Источники.</b> MPStats: объём/выручка/упущенная/выкуп/бренды/поставщики/цены/сезонность (category, item/full, search); публичные API WB: card.json (характеристики, ключевые запросы), feedbacks (отзывы → группировка негатива), search.wb.ru (диагональное сканирование, размеры, конкуренты). Период выручки — год; ценовые сегменты — 3 мес.</p>
    <p><b>Оговорки (для реального отчёта).</b> Выкуп — оценка на уровне категории. «Выручка заказов» ≠ «выручка выкупов» (разница = возвраты/невыкуп). Сезонные средние цены — по месяцам сезона. Все диаграммы масштабируются под реальные данные.</p>
  </div>
</div>`;

fs.writeFileSync('reports-output/niche-template.html', html);
console.log('written reports-output/niche-template.html', html.length, 'bytes');
