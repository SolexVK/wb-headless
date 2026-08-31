// build-niche-template.js — ШАБЛОН отчёта по анализу ниши WB (v2).
// Живая единая палитра, кликабельные бренд/продавец/артикул, фото топ-слайда,
// блок помесячных ВЫКУПОВ (кол-во+сумма) по топ-10 среднего и высокого сегмента.
// Данные — ОБРАЗЕЦ (фото/ссылки реальные для демонстрации). HTML → PDF.
import fs from 'fs';

let PHOTOS;
try { PHOTOS = JSON.parse(fs.readFileSync('reports-output/_tpl-photos.json', 'utf8')); }
catch { PHOTOS = [['ТЫСЯЧА СТОЛИЦ', 676439, 160987536], ['IHOMELUX', 131237, 418583488], ['ТЫСЯЧА СТОЛИЦ', 1230073, 158548855], ['Zella', 934249, 918857520], ['IHOMELUX', 131237, 59795045]].map(([brand, supplier, sku]) => ({ brand, supplier, sku, img: '' })); }
const S = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => Math.round(n).toLocaleString('ru-RU');
const mln = (n) => (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const mlrd = (n) => (n / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

// WB-ссылки
const urlCard = (sku) => `https://www.wildberries.ru/catalog/${sku}/detail.aspx`;
const urlSeller = (id) => `https://www.wildberries.ru/seller/${id}`;
const urlBrand = (b) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(b)}`;
const A = (href, text, cls = '') => `<a href="${href}" target="_blank" rel="noopener" class="lnk ${cls}">${S(text)}</a>`;

// ---------- SVG ----------
function donut(segs, { size = 148, thick = 26 } = {}) {
  const r = (size - thick) / 2, CX = size / 2, CY = size / 2, C = 2 * Math.PI * r;
  const tot = segs.reduce((s, x) => s + x.v, 0) || 1; let off = 0, arcs = '';
  segs.forEach((s) => { const len = s.v / tot * C; arcs += `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${s.c}" stroke-width="${thick}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})"/>`; off += len; });
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="chart">${arcs}<circle cx="${CX}" cy="${CY}" r="${r - thick / 2 - 1}" fill="var(--panel)"/></svg>`;
}
function combo(months, vals, line, { w = 540, h = 158, pad = 26, barC = 'var(--accent)', lineC = 'var(--teal)' } = {}) {
  const max = Math.max(...vals), lmax = Math.max(...line);
  const gap = (w - pad * 2) / vals.length, bw = gap * 0.58;
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" class="chart">`;
  for (let g = 0; g <= 3; g++) { const y = pad + (h - pad * 1.7) * g / 3; s += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" class="grid"/>`; }
  vals.forEach((v, i) => { const x = pad + gap * i + gap / 2, bh = v / max * (h - pad * 1.9); s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(h - pad - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${barC}" opacity="0.9"/>`; s += `<text x="${x.toFixed(1)}" y="${h - pad + 12}" class="axis" text-anchor="middle">${S(months[i])}</text>`; });
  const pts = line.map((v, i) => `${(pad + gap * i + gap / 2).toFixed(1)},${(pad + (1 - v / lmax) * (h - pad * 1.9)).toFixed(1)}`).join(' ');
  s += `<polyline points="${pts}" fill="none" stroke="${lineC}" stroke-width="2.5"/>`;
  line.forEach((v, i) => { const x = pad + gap * i + gap / 2, y = pad + (1 - v / lmax) * (h - pad * 1.9); s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${lineC}"/>`; });
  return s + `</svg>`;
}
function rangeBar(sizes, cFrom, cTo, { w = 540, h = 60, pad = 18 } = {}) {
  const gap = (w - pad * 2) / (sizes.length - 1), y = h / 2 - 4, xi = (i) => pad + gap * i;
  const ci = sizes.indexOf(cFrom), cj = sizes.indexOf(cTo);
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" class="chart">`;
  s += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="var(--bar)" stroke-width="6" stroke-linecap="round"/>`;
  s += `<line x1="${xi(ci)}" y1="${y}" x2="${xi(cj)}" y2="${y}" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/>`;
  sizes.forEach((sz, i) => { const core = i >= ci && i <= cj; s += `<circle cx="${xi(i)}" cy="${y}" r="${core ? 5 : 4}" fill="${core ? 'var(--accent)' : 'var(--panel)'}" stroke="${core ? 'var(--accent)' : 'var(--bar)'}" stroke-width="2"/>`; s += `<text x="${xi(i)}" y="${y + 22}" class="axis" text-anchor="middle" ${core ? 'style="fill:var(--ink);font-weight:600"' : ''}>${sz}</text>`; });
  return s + `</svg>`;
}

// ---------- ОБРАЗЕЦ ----------
const MONTHS = ['сен', 'окт', 'ноя', 'дек', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг'];
const D = {
  subject: 'Блузка женская',
  s1_revYear: 4.24e9, s1_unitsYear: 1_820_000, s2_lost: 1.58e9, s2_lostShare: 0.28,
  s3_top10: 12, s3_top30: 24, s3_rest: 76, s4_suppliers: 3450, s4_brands: 2980, s5_buyout: 41,
  midQty: [520, 560, 640, 720, 780, 700, 650, 600, 720, 860, 900, 820],
  highQty: [260, 290, 330, 380, 420, 380, 350, 320, 400, 470, 510, 460],
  s6_segments: [
    { k: 'до 1 000 ₽', v: 14 }, { k: '1 000–1 800 ₽', v: 31 }, { k: '1 800–2 700 ₽ · средний', v: 28, tag: 'mid' },
    { k: '2 700–4 000 ₽ · высокий', v: 18, tag: 'high' }, { k: '4 000 ₽ +', v: 9 },
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
};
D.midSum = D.midQty.map((q) => q * 2200);
D.highSum = D.highQty.map((q) => q * 3300);

// топ-10 брендов (первые 5 — реальные фото/ссылки, остальные — образец)
const brandRows = [
  { brand: PHOTOS[0].brand, supplier: PHOTOS[0].supplier, sku: PHOTOS[0].sku, img: PHOTOS[0].img, v: 96e6 },
  { brand: PHOTOS[1].brand, supplier: PHOTOS[1].supplier, sku: PHOTOS[1].sku, img: PHOTOS[1].img, v: 78e6 },
  { brand: PHOTOS[3].brand, supplier: PHOTOS[3].supplier, sku: PHOTOS[3].sku, img: PHOTOS[3].img, v: 64e6 },
  { brand: PHOTOS[2].brand, supplier: PHOTOS[2].supplier, sku: PHOTOS[2].sku, img: PHOTOS[2].img, v: 55e6 },
  { brand: PHOTOS[4].brand, supplier: PHOTOS[4].supplier, sku: PHOTOS[4].sku, img: PHOTOS[4].img, v: 47e6 },
  { brand: 'Бренд F', supplier: 0, sku: 0, img: '', v: 41e6 }, { brand: 'Бренд G', supplier: 0, sku: 0, img: '', v: 37e6 },
  { brand: 'Бренд H', supplier: 0, sku: 0, img: '', v: 33e6 }, { brand: 'Бренд I', supplier: 0, sku: 0, img: '', v: 29e6 }, { brand: 'Бренд J', supplier: 0, sku: 0, img: '', v: 25e6 },
];

const competitors = [0, 1, 2, 3, 4].map((i) => {
  const p = PHOTOS[i];
  return {
    rank: i + 1, sku: p.sku, brand: p.brand || '— бренд —', supplier: p.supplier, img: p.img,
    ordRub: [96, 78, 64, 55, 47][i] * 1e6, ordPcs: [40, 33, 27, 23, 20][i] * 1000,
    buyRub: [40, 33, 27, 23, 20][i] * 1e6, buyPcs: [17, 14, 11, 10, 8][i] * 1000, lost: [24, 19, 16, 14, 12][i] * 1e6,
    seasons: { 'осень': 2350 - i * 40, 'зима': 2480 - i * 40, 'весна': 2300 - i * 40, 'лето': 2190 - i * 40 },
    monthly: MONTHS.map((_, m) => 5 + Math.round(4 * Math.sin(m / 2) + i)), stock: MONTHS.map((_, m) => 8 + Math.round(3 * Math.cos(m / 2))),
    reviews: [5340, 3120, 2680, 1940, 1510][i], rating: [4.8, 4.7, 4.9, 4.6, 4.8][i],
    negThemes: [{ k: 'маломерит', v: 32, c: 'var(--accent)' }, { k: 'отличие от фото', v: 24, c: 'var(--gold)' }, { k: 'качество ткани', v: 18, c: 'var(--teal)' }, { k: 'швы/пошив', v: 14, c: '#8E7CC3' }, { k: 'доставка', v: 12, c: '#5B6470' }],
    negs: ['«Пришло на размер меньше — берите на размер больше»', '«Цвет темнее, чем на фото»', '«Ткань просвечивает, дешевит вид»', '«Кривые швы на рукаве»', '«Пришла мятая, долго шла»', '«Торчат нитки, брак пуговицы»'],
    patterns: ['Инфографика на 1–2 фото: состав, посадка, размерная сетка', 'Видео-обзор на карточке → выше конверсия', 'Заголовок с 3–4 ключами («блузка нарядная белая офисная»)', 'Отработка «маломерит» в описании и ответах на отзывы', 'Реклама в пик сезона (окт–дек), цена в среднем сегменте'],
  };
});

// ---------- вёрстка ----------
const secH = (n, t, sub = '') => `<h2><span class="n">${n}</span><span>${t}</span></h2>${sub ? `<p class="sub">${sub}</p>` : ''}`;
const kpiTile = (kt, kv, kl, tone) => `<div class="kpi ${tone}"><div class="kt">${kt}</div><div class="kv">${kv}</div><div class="kl">${kl}</div></div>`;

function segPanel(title, qty, sum, tone) {
  const avgQ = Math.round(qty.reduce((a, b) => a + b, 0) / qty.length);
  const avgS = sum.reduce((a, b) => a + b, 0) / sum.length;
  return `<div class="segpanel ${tone}">
    <div class="sphead"><b>${title}</b><span>средн. в месяц: <b>${money(avgQ)} шт</b> · <b>${mln(avgS)} млн ₽</b></span></div>
    <div class="cap">Столбцы — кол-во выкупов, шт · линия — сумма выкупов, ₽ (среднее по топ-10 сегмента)</div>
    ${combo(MONTHS, qty, sum, { barC: tone === 'mid' ? 'var(--teal)' : 'var(--accent)', lineC: tone === 'mid' ? 'var(--accent)' : 'var(--gold)', h: 150 })}
  </div>`;
}

function brandRow(r, i) {
  const max = brandRows[0].v, bw = r.v / max * 100;
  const photo = r.img ? `<img src="${r.img}" class="bthumb" alt="">` : `<span class="bthumb ph"></span>`;
  const brandCell = r.supplier ? A(urlBrand(r.brand), r.brand, 'b') : `<span class="b">${S(r.brand)}</span>`;
  const seller = r.supplier ? ` · ${A(urlSeller(r.supplier), 'продавец', 'sm')}` : '';
  const art = r.sku ? ` · ${A(urlCard(r.sku), 'арт.' + r.sku, 'sm')}` : '';
  return `<div class="brow"><span class="brk">${i + 1}</span>${photo}<div class="bmid"><div class="bname">${brandCell}${seller}${art}</div><div class="btrack"><span style="width:${bw}%"></span></div></div><div class="bval">${mln(r.v)} млн</div></div>`;
}

function competitorCard(c) {
  const photo = c.img ? `<img src="${c.img}" class="cphoto" alt="фото топового артикула">` : `<span class="cphoto ph"></span>`;
  return `<div class="comp">
    <div class="chead">
      <span class="crk">#${c.rank}</span>${photo}
      <div class="cid">
        <div class="cbrand">${A(urlBrand(c.brand), c.brand, 'b')}</div>
        <div class="cmeta">${A(urlCard(c.sku), 'арт. ' + c.sku, 'sm')} · ${A(urlSeller(c.supplier), 'карточка продавца', 'sm')}</div>
        <div class="crate">★ ${c.rating} · ${money(c.reviews)} отзывов</div>
      </div>
    </div>
    <div class="cgrid">
      <div class="cmoney">
        <div class="mrow"><span>Выручка/год · заказы</span><b>${mln(c.ordRub)} млн ₽ · ${money(c.ordPcs)} шт</b></div>
        <div class="mrow buy"><span>Выручка/год · выкупы</span><b>${mln(c.buyRub)} млн ₽ · ${money(c.buyPcs)} шт</b></div>
        <div class="mrow"><span>Упущенная выручка</span><b>${mln(c.lost)} млн ₽</b></div>
        <div class="seasons">${Object.entries(c.seasons).map(([k, v]) => `<div class="sea"><span>${k}</span><b>${money(v)} ₽</b></div>`).join('')}</div>
        <div class="cap" style="margin-top:2px">Средняя цена продажи по сезонам</div>
      </div>
      <div class="cchart">
        <div class="cap">Выручка по месяцам (столбцы) + остаток (линия)</div>
        ${combo(MONTHS, c.monthly, c.stock, { w: 360, h: 128 })}
      </div>
    </div>
    <div class="cgrid2">
      <div class="cneg">
        <div class="cap">Негатив в отзывах — по смыслам</div>
        <div class="stack">${c.negThemes.map((t) => `<span style="width:${t.v}%;background:${t.c}"></span>`).join('')}</div>
        <div class="stleg">${c.negThemes.map((t) => `<span><i style="background:${t.c}"></i>${t.k} ${t.v}%</span>`).join('')}</div>
        <ul class="negs">${c.negs.map((n) => `<li>${S(n)}</li>`).join('')}</ul>
      </div>
      <div class="cpat">
        <div class="cap">Диагональное сканирование — паттерны успеха</div>
        <ul class="pat">${c.patterns.map((p) => `<li>${S(p)}</li>`).join('')}</ul>
      </div>
    </div>
  </div>`;
}

const html = `<title>Шаблон анализа ниши WB</title>
<style>
:root{
  --ground:#F3ECE3; --panel:#FFFFFF; --panel2:#FBF4EC; --ink:#2C2431; --muted:#867A8A; --line:#E7DBCE;
  --accent:#E23E6D; --accent-soft:#FBE1EA; --teal:#12A594; --teal-soft:#DAF2EE; --gold:#D9A441; --gold-soft:#F7EBD2;
  --bar:#E2D5C8; --grid:#ECE1D5; --heroA:#3A1E38; --heroB:#5C2247; --heroInk:#F6E9DE;
  --shadow:0 1px 2px rgba(60,40,50,.05),0 10px 26px rgba(60,40,50,.09);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#1B161F; --panel:#241E2B; --panel2:#2B2333; --ink:#F3ECEF; --muted:#A99FAD; --line:#3A3040;
  --accent:#F0619B; --accent-soft:#3B1E2C; --teal:#3FB8A8; --teal-soft:#123330; --gold:#E9C06A; --gold-soft:#37301C;
  --bar:#463B52; --grid:#2E2637; --heroA:#2A1528; --heroB:#45193A; --heroInk:#F6E9DE;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 26px rgba(0,0,0,.4);
}}
:root[data-theme="dark"]{
  --ground:#1B161F; --panel:#241E2B; --panel2:#2B2333; --ink:#F3ECEF; --muted:#A99FAD; --line:#3A3040;
  --accent:#F0619B; --accent-soft:#3B1E2C; --teal:#3FB8A8; --teal-soft:#123330; --gold:#E9C06A; --gold-soft:#37301C;
  --bar:#463B52; --grid:#2E2637; --heroA:#2A1528; --heroB:#45193A; --heroInk:#F6E9DE;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 26px rgba(0,0,0,.4);
}
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--ground);color:var(--ink);font-family:'Instrument Sans',system-ui,sans-serif;line-height:1.5;font-size:13.5px;-webkit-font-smoothing:antialiased}
a.lnk{color:var(--accent);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
a.lnk:hover{border-bottom-color:var(--accent)}
a.lnk.b{font-weight:600;color:var(--ink);border-bottom:1px solid var(--accent)}
a.lnk.sm{font-size:11.5px;font-family:'IBM Plex Mono',monospace;color:var(--teal);border-bottom-color:color-mix(in srgb,var(--teal) 35%,transparent)}
.wrap{max-width:840px;margin:0 auto;padding:26px 22px 60px}
/* hero */
.hero{background:linear-gradient(120deg,var(--heroA),var(--heroB));color:var(--heroInk);border-radius:16px;padding:26px 28px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.hero::after{content:"";position:absolute;right:-40px;top:-40px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(226,62,109,.45),transparent 70%)}
.hero .ribbon{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;background:rgba(255,255,255,.16);color:var(--heroInk);padding:4px 11px;border-radius:6px;margin-bottom:12px}
.hero h1{font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:clamp(26px,4.6vw,38px);line-height:1.05;margin:0 0 8px;letter-spacing:-.01em}
.hero .lead{font-size:14px;color:var(--heroInk);opacity:.85;max-width:60ch;margin:0}
.hero .meta{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--heroInk);opacity:.7;margin-top:12px}
h2{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:20px;margin:30px 0 4px;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
h2 .n{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#fff;background:var(--accent);border-radius:6px;padding:3px 8px;font-weight:500;box-shadow:0 2px 6px color-mix(in srgb,var(--accent) 40%,transparent)}
.sub{color:var(--muted);font-size:12.5px;margin:2px 0 12px;max-width:66ch}
.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:16px 18px;box-shadow:var(--shadow)}
.card.tint{background:var(--panel2)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:11px;margin-top:8px}
.kpi{border-radius:12px;padding:14px 13px;box-shadow:var(--shadow);border:1px solid var(--line)}
.kpi.a{background:var(--accent-soft)} .kpi.t{background:var(--teal-soft)} .kpi.g{background:var(--gold-soft)} .kpi.p{background:var(--panel)}
.kpi .kt{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;line-height:1.3}
.kpi .kv{font-family:'Fraunces',serif;font-weight:900;font-size:21px;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi.a .kv{color:var(--accent)} .kpi.t .kv{color:var(--teal)} .kpi.g .kv{color:#B9832A}
.kpi .kl{font-size:10.5px;color:var(--muted);margin-top:6px;line-height:1.3}
.row2b{display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:center}
.segrow{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.segpanel{border-radius:13px;padding:14px 16px;box-shadow:var(--shadow);border:1px solid var(--line)}
.segpanel.mid{background:var(--teal-soft)} .segpanel.high{background:var(--accent-soft)}
.sphead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.sphead>b{font-size:14px} .sphead span{font-size:11.5px;color:var(--muted)} .sphead span b{color:var(--ink);font-family:'IBM Plex Mono',monospace}
.chart .grid{stroke:var(--grid)} .chart .axis{font-size:9.5px;fill:var(--muted);font-family:'IBM Plex Mono',monospace}
.cap{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;line-height:1.35}
.dlegend{display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.dlegend span{display:flex;align-items:center;gap:8px}.dlegend i{width:11px;height:11px;border-radius:3px;flex:none}.dlegend b{margin-left:auto;font-family:'IBM Plex Mono',monospace}
.segbars .seg{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:12.5px}
.segbars .lbl{width:170px;color:var(--ink)} .segbars .lbl.mid{color:var(--teal);font-weight:600} .segbars .lbl.high{color:var(--accent);font-weight:600}
.segbars .track{flex:1;height:15px;background:var(--grid);border-radius:5px;overflow:hidden}
.segbars .fill{height:100%;background:var(--accent);border-radius:5px}
.segbars .seg.mid .fill{background:var(--teal)} .segbars .seg.high .fill{background:var(--accent)}
.segbars .pc{width:38px;text-align:right;font-family:'IBM Plex Mono',monospace}
/* brand list */
.brow{display:flex;align-items:center;gap:11px;padding:7px 0;border-bottom:1px solid var(--line)}
.brow:last-child{border-bottom:none}
.brk{font-family:'Fraunces',serif;font-weight:900;color:var(--accent);width:22px;text-align:center;font-size:15px}
.bthumb{width:38px;height:50px;object-fit:cover;border-radius:6px;border:1px solid var(--line);flex:none;background:var(--panel2)}
.bthumb.ph{display:inline-block}
.bmid{flex:1;min-width:0}.bname{font-size:12.5px;margin-bottom:4px}.btrack{height:12px;background:var(--grid);border-radius:4px;overflow:hidden}.btrack span{display:block;height:100%;background:var(--accent);border-radius:4px}
.bval{font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:500;width:64px;text-align:right}
.chips{display:flex;flex-wrap:wrap;gap:9px}
.chip{background:var(--gold-soft);border:1px solid var(--line);border-radius:22px;padding:8px 14px;font-size:13px}
.chip b{color:#B9832A}.chip span{color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:11px;margin-left:6px}
/* competitor */
.comp{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:15px 17px;box-shadow:var(--shadow);margin-top:12px;border-top:3px solid var(--accent)}
.chead{display:flex;align-items:center;gap:13px;padding-bottom:11px;border-bottom:1px solid var(--line);margin-bottom:12px}
.chead .crk{font-family:'Fraunces',serif;font-weight:900;color:var(--accent);font-size:20px}
.cphoto{width:54px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line);flex:none;background:var(--panel2)}
.cphoto.ph{display:inline-block}
.cid{min-width:0}.cbrand{font-size:14px}.cmeta{font-size:11px;margin:2px 0}.crate{font-size:11.5px;color:var(--gold);font-weight:600}
.cgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.mrow{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:4px 0;border-bottom:1px dashed var(--line)}
.mrow span{color:var(--muted)}.mrow b{font-family:'IBM Plex Mono',monospace;text-align:right}
.mrow.buy b{color:var(--teal)}
.seasons{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:9px}
.sea{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:5px 4px;text-align:center}
.sea span{display:block;font-size:9px;color:var(--muted);text-transform:capitalize}.sea b{font-family:'IBM Plex Mono',monospace;font-size:11px}
.cgrid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:13px}
.stack{display:flex;height:15px;border-radius:5px;overflow:hidden;margin-bottom:8px}.stack span{display:block;height:100%}
.stleg{display:flex;flex-wrap:wrap;gap:4px 11px;font-size:10.5px;color:var(--muted);margin-bottom:8px}.stleg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
ul.negs,ul.pat{margin:0;padding-left:15px;font-size:11.5px;line-height:1.5}ul.negs li{margin:2px 0}ul.pat li{margin:3px 0}ul.pat li::marker{color:var(--accent)}
.foot{margin-top:38px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.6}.foot b{color:var(--ink)}
@media (max-width:720px){.kpis{grid-template-columns:1fr 1fr 1fr}.segrow,.row2b,.cgrid,.cgrid2{grid-template-columns:1fr}.wrap{padding:20px 13px 46px}}
@media print{.card,.kpi,.comp,.segpanel,.hero{box-shadow:none}.wrap{max-width:100%}h2{break-after:avoid}.comp,.card,.segpanel,.kpi{break-inside:avoid}}
</style>
<div class="wrap">
  <div class="hero">
    <span class="ribbon">Шаблон · данные — образец</span>
    <h1>Анализ ниши: ${S(D.subject)}</h1>
    <p class="lead">Единый визуальный стиль, кликабельные бренд / продавец / артикул, фото топ-слайда. Ниже — структура и виды диаграмм на образцовых числах.</p>
    <div class="meta">Wildberries · MPStats + публичные API WB · выручка — год · сегменты — 3 мес · фото и ссылки реальные (демо)</div>
  </div>

  ${secH('01–05', 'Рынок ниши в цифрах')}
  <div class="kpis">
    ${kpiTile('01 · Объём продаж (год)', mlrd(D.s1_revYear) + ' млрд ₽', money(D.s1_unitsYear) + ' шт', 'a')}
    ${kpiTile('02 · Упущенная выручка', mlrd(D.s2_lost) + ' млрд', Math.round(D.s2_lostShare * 100) + '% потенциала', 't')}
    ${kpiTile('03 · Монополизация', D.s3_top10 + '%', 'доля топ-10', 'g')}
    ${kpiTile('04 · Продавцы / бренды', money(D.s4_suppliers), money(D.s4_brands) + ' брендов с прод.', 'p')}
    ${kpiTile('05 · Ср. выкуп', D.s5_buyout + '%', 'с учётом возвратов', 'a')}
  </div>

  ${secH('★', 'Продажи по месяцам в выкупах — топ-10 среднего и высокого сегмента',
    'Топы сначала отсортированы по ценовым сегментам; в каждом взят свой топ-10. Показано среднее по месяцам количество и сумма продаж <b>в реальных выкупах</b> (не в заказах).')}
  <div class="segrow">
    ${segPanel('Средний сегмент · 1 800–2 700 ₽', D.midQty, D.midSum, 'mid')}
    ${segPanel('Высокий сегмент · 2 700–4 000 ₽', D.highQty, D.highSum, 'high')}
  </div>

  ${secH('03', 'Доля монополизации рынка топами')}
  <div class="card tint row2b">
    ${donut([{ v: D.s3_top10, c: 'var(--accent)' }, { v: D.s3_top30 - D.s3_top10, c: 'var(--teal)' }, { v: D.s3_rest, c: 'var(--bar)' }])}
    <div class="dlegend">
      <span><i style="background:var(--accent)"></i>Топ-10 брендов<b>${D.s3_top10}%</b></span>
      <span><i style="background:var(--teal)"></i>Топ-11…30<b>${D.s3_top30 - D.s3_top10}%</b></span>
      <span><i style="background:var(--bar)"></i>Остальные (${money(D.s4_brands)} брендов)<b>${D.s3_rest}%</b></span>
      <span style="color:var(--muted);font-size:11.5px;margin-top:4px">Низкая доля топов = раздробленный рынок, легче зайти новичку.</span>
    </div>
  </div>

  ${secH('06', 'Распределение по ценовым сегментам (за 3 мес)')}
  <div class="card segbars">
    ${D.s6_segments.map((s) => `<div class="seg ${s.tag || ''}"><span class="lbl ${s.tag || ''}">${S(s.k)}</span><span class="track"><span class="fill" style="width:${s.v * 2.6}%"></span></span><span class="pc">${s.v}%</span></div>`).join('')}
  </div>

  ${secH('07', 'Топ-10 брендов по выручке за год', 'Бренд и продавец — кликабельны; у топов — фото главного слайда лидирующего артикула.')}
  <div class="card">${brandRows.map(brandRow).join('')}</div>

  ${secH('08', 'Топ-5 ключевых запросов ниши')}
  <div class="card"><div class="chips">${D.s8_queries.map((q) => `<span class="chip"><b>${S(q.q)}</b><span>${S(q.f)}</span></span>`).join('')}</div></div>

  ${secH('09', 'Разбор Топ-5 конкурентов (по убыванию выручки)',
    'Фото топ-слайда, кликабельные артикул/бренд/продавец. По каждому: выручка заказы/выкупы (₽ и шт), упущенная, средняя цена по сезонам, помесячная динамика, отзывы+рейтинг, сгруппированный негатив (5–10 примеров), паттерны диагонального сканирования.')}
  ${competitors.map(competitorCard).join('')}

  ${secH('10', 'Доли расцветок (по 100–200 топ-артикулам)')}
  <div class="card tint row2b">
    ${donut(D.s10_colors.map((c) => ({ v: c.v, c: c.c })))}
    <div class="dlegend">${D.s10_colors.map((c) => `<span><i style="background:${c.c};${c.k === 'белый' ? 'border:1px solid #cbd0d6' : ''}"></i>${S(c.k)}<b>${c.v}%</b></span>`).join('')}</div>
  </div>

  ${secH('11', 'Размерный ряд (по топ-10)', 'Ядро спроса выделено акцентом.')}
  <div class="card">${rangeBar(D.s11_sizes, D.s11_core[0], D.s11_core[1])}</div>

  <div class="foot">
    <p><b>Источники.</b> MPStats: объём/выручка/упущенная/выкуп/бренды/поставщики/цены/сезонность (category, item/full, search); публичные API WB: card.json (характеристики, ключевые запросы), feedbacks (отзывы → группировка негатива), search.wb.ru (диагональное сканирование, размеры, конкуренты). Ссылки: артикул → карточка, продавец → страница продавца, бренд → выдача бренда.</p>
    <p><b>Блок «выкупы по месяцам».</b> Топы делятся по ценовым сегментам, в каждом берётся свой топ-10; выводится среднее по месяцам количество и сумма продаж именно в выкупах (заказы × выкуп%), а не в заказах. Выкуп — оценка на уровне категории. Все значения на макете — образец.</p>
  </div>
</div>`;

fs.writeFileSync('reports-output/niche-template.html', html);
console.log('written reports-output/niche-template.html', html.length, 'bytes · фото:', PHOTOS.filter((p) => p.img).length + '/' + PHOTOS.length);
