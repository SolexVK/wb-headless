// build-sales-plan.js — план продаж + заработок по женским блузкам (жабо).
// Вход: агрегаты из моих отчётов (цена, топ-цвета, ходовые размеры). Логика:
//  · топ-цвет 1000 шт, два других по 500 шт (2000 шт/блузка);
//  · разбивка по размерам — по долям ходовых размеров (метод наибольших остатков → сумма точная);
//  · помесячно сен/окт/ноя 2026 по сезонной кривой;
//  · заработок = маржа 15–17% × выручка (чистая маржа от цены); себестоимость 750 ₽ — справочно.
import fs from 'fs';

const CC = 750;            // себестоимость, ₽
const MARGIN = [0.15, 0.17];
const MONTHS = ['Сентябрь', 'Октябрь', 'Ноябрь'];

// сезонные веса (нарядные растут к НГ; хлопок — базовее, к поздней осени слабее)
const SEASON_DRESS = [0.30, 0.33, 0.37];
const SEASON_COTTON = [0.36, 0.33, 0.31];

const S1 = { 48: 14, 46: 12, 44: 12, 50: 10, 42: 10, 52: 8, 54: 4 };            // гипюр/шёлк
const S2 = { 44: 14, 48: 13, 46: 13, 42: 10, 50: 9, 52: 7 };                    // хлопок/жабо/нарядные

const BLOUSES = [
  { id: 'gipur', name: 'Гипюр', material: 'гипюр/кружево', produce: true, price: 3146, season: SEASON_DRESS,
    colors: ['чёрный', 'белый', 'коричневый'], sizes: S1 },
  { id: 'silk', name: 'Шёлк/атлас', material: 'шёлк/атлас', produce: true, price: 2284, season: SEASON_DRESS,
    colors: ['белый', 'чёрный', 'коричневый'], sizes: S1 },
  { id: 'cotton', name: 'Хлопок', material: 'хлопок', produce: true, price: 2314, season: SEASON_COTTON,
    colors: ['белый', 'серый', 'жёлтый'], sizes: S2 },
  { id: 'jabo_all', name: 'Жабо — все ткани (агрегат)', material: 'смешанные', produce: false, price: 2809, season: SEASON_DRESS,
    colors: ['белый', 'чёрный', 'коричневый'], sizes: S2 },
  { id: 'jabo_dress', name: 'Нарядные жабо (агрегат)', material: 'смешанные', produce: false, price: 3007, season: SEASON_DRESS,
    colors: ['белый', 'чёрный', 'коричневый'], sizes: S2 },
];

// целочисленное распределение total по долям (наибольшие остатки → сумма == total)
function allocate(shares, total) {
  const keys = Object.keys(shares);
  const sum = keys.reduce((s, k) => s + shares[k], 0);
  const raw = keys.map((k) => ({ k, exact: (shares[k] / sum) * total }));
  const out = raw.map((r) => ({ k: r.k, n: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let rem = total - out.reduce((s, r) => s + r.n, 0);
  out.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < rem; i++) out[i % out.length].n++;
  const map = {}; out.forEach((r) => { map[r.k] = r.n; });
  return keys.reduce((m, k) => { m[k] = map[k]; return m; }, {});
}

const COLOR_HEX = { 'чёрный': '#23262B', 'белый': '#E9EAEC', 'коричневый': '#6B4A2B', 'серый': '#9AA0A6', 'жёлтый': '#E3B93B', 'бежевый': '#D8C4A0', 'молочный': '#EDE6D6' };
const fmt = (n) => Math.round(n).toLocaleString('ru-RU');
const fmtK = (n) => Math.round(n / 1000).toLocaleString('ru-RU') + ' тыс';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// собрать план по блузке
function planBlouse(b) {
  const variants = b.colors.map((color, i) => {
    const units = i === 0 ? 1000 : 500;
    const sizeAlloc = allocate(b.sizes, units);
    const monthAlloc = allocate({ 0: b.season[0], 1: b.season[1], 2: b.season[2] }, units);
    const revenue = units * b.price;
    return {
      color, units, sizeAlloc,
      months: [monthAlloc['0'], monthAlloc['1'], monthAlloc['2']],
      revenue, profit: MARGIN.map((m) => revenue * m),
    };
  });
  const totUnits = variants.reduce((s, v) => s + v.units, 0);
  const totRev = variants.reduce((s, v) => s + v.revenue, 0);
  const totProfit = MARGIN.map((_, mi) => variants.reduce((s, v) => s + v.profit[mi], 0));
  return { ...b, variants, totUnits, totRev, totProfit };
}

const plans = BLOUSES.map(planBlouse);
const sizeKeysOf = (b) => Object.keys(b.sizes).sort((a, c) => Number(a) - Number(c));

// ---------- вёрстка ----------
function chip(color) {
  const hex = COLOR_HEX[color] || '#bbb';
  const bord = color === 'белый' || color === 'молочный' ? 'border:1px solid #cbd0d6' : '';
  return `<span class="sw" style="background:${hex};${bord}"></span>${esc(color)}`;
}

function variantTables(p) {
  const sizes = sizeKeysOf(p);
  // таблица размеров: строки размер × колонки цвета
  let sz = `<div class="tbl-wrap"><table class="pt"><thead><tr><th class="l">Размер</th>${p.variants.map((v) => `<th>${chip(v.color)}<br><small>${fmt(v.units)} шт</small></th>`).join('')}<th>Σ</th></tr></thead><tbody>`;
  for (const s of sizes) {
    const row = p.variants.map((v) => v.sizeAlloc[s] || 0);
    sz += `<tr><td class="l">${s}</td>${row.map((n) => `<td>${fmt(n)}</td>`).join('')}<td class="sum">${fmt(row.reduce((a, c) => a + c, 0))}</td></tr>`;
  }
  sz += `<tr class="tot"><td class="l">Итого</td>${p.variants.map((v) => `<td>${fmt(v.units)}</td>`).join('')}<td class="sum">${fmt(p.totUnits)}</td></tr>`;
  sz += `</tbody></table></div>`;

  // помесячно: строки цвет × месяцы + деньги
  let mo = `<div class="tbl-wrap"><table class="pt"><thead><tr><th class="l">Цвет</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}<th>Σ шт</th><th>Выручка</th><th>Приб. 15–17%</th></tr></thead><tbody>`;
  for (const v of p.variants) {
    mo += `<tr><td class="l">${chip(v.color)}</td>${v.months.map((n) => `<td>${fmt(n)}</td>`).join('')}<td class="sum">${fmt(v.units)}</td><td class="mon">${fmtK(v.revenue)}</td><td class="prof">${fmtK(v.profit[0])}–${fmtK(v.profit[1])}</td></tr>`;
  }
  const mTot = [0, 1, 2].map((mi) => p.variants.reduce((s, v) => s + v.months[mi], 0));
  mo += `<tr class="tot"><td class="l">Итого</td>${mTot.map((n) => `<td>${fmt(n)}</td>`).join('')}<td class="sum">${fmt(p.totUnits)}</td><td class="mon">${fmtK(p.totRev)}</td><td class="prof">${fmtK(p.totProfit[0])}–${fmtK(p.totProfit[1])}</td></tr>`;
  mo += `</tbody></table></div>`;
  return { sz, mo };
}

function blouseSection(p, idx) {
  const t = variantTables(p);
  const badge = p.produce ? `<span class="badge prod">к пошиву</span>` : `<span class="badge ref">агрегат · справочно</span>`;
  return `<section class="blouse">
    <div class="bhead">
      <h3><span class="bn">${String(idx + 1).padStart(2, '0')}</span>${esc(p.name)} ${badge}</h3>
      <div class="bmeta">Цена продажи <b>${fmt(p.price)} ₽</b> · себестоимость ${fmt(CC)} ₽ · маржа ${(MARGIN[0] * 100)}–${(MARGIN[1] * 100)}% · топ-цвет <b>${esc(p.variants[0].color)}</b> — 1000 шт, остальные — по 500</div>
    </div>
    <div class="cols">
      <div><div class="cap">Разбивка по размерам (за квартал), шт</div>${t.sz}</div>
      <div><div class="cap">Помесячно (сен–ноя 2026) и деньги</div>${t.mo}</div>
    </div>
    <div class="earn">
      <div class="ep"><span>Объём</span><b>${fmt(p.totUnits)} шт</b></div>
      <div class="ep"><span>Выручка</span><b>${fmt(p.totRev)} ₽</b></div>
      <div class="ep hi"><span>Заработок @15%</span><b>${fmt(p.totProfit[0])} ₽</b></div>
      <div class="ep hi"><span>Заработок @17%</span><b>${fmt(p.totProfit[1])} ₽</b></div>
    </div>
  </section>`;
}

// производственный итог — только тканевые (материалы не пересекаем)
const prod = plans.filter((p) => p.produce);
const prodUnits = prod.reduce((s, p) => s + p.totUnits, 0);
const prodRev = prod.reduce((s, p) => s + p.totRev, 0);
const prodProfit = MARGIN.map((_, mi) => prod.reduce((s, p) => s + p.totProfit[mi], 0));

// бар-чарт заработка по блузкам
function profitBars() {
  const rows = plans.map((p) => ({ k: p.name, v: p.totProfit[1], produce: p.produce }));
  const max = Math.max(...rows.map((r) => r.v));
  const w = 640, rowH = 34, pad = 8, labelW = 210, barX = labelW + 12, barMax = w - barX - 96;
  const H = rows.length * rowH + pad * 2;
  let s = `<svg viewBox="0 0 ${w} ${H}" width="100%" class="chart">`;
  for (let g = 0; g <= 4; g++) { const x = barX + barMax * g / 4; s += `<line x1="${x}" y1="${pad}" x2="${x}" y2="${H - pad}" class="grid"/>`; }
  rows.forEach((r, i) => {
    const y = pad + i * rowH, bw = Math.max(2, r.v / max * barMax);
    s += `<text x="${labelW}" y="${y + rowH / 2}" class="blab" text-anchor="end" dominant-baseline="middle">${esc(r.k)}</text>`;
    s += `<rect x="${barX}" y="${y + 6}" width="${bw.toFixed(1)}" height="${rowH - 14}" rx="3" fill="${r.produce ? 'var(--accent)' : 'var(--bar)'}"/>`;
    s += `<text x="${barX + bw + 8}" y="${y + rowH / 2}" class="bval" dominant-baseline="middle">${fmt(r.v)} ₽</text>`;
  });
  s += `</svg>`; return s;
}

const html = `<title>План продаж — блузки жабо</title>
<style>
:root{--ground:#F5F6F8;--card:#FFFFFF;--ink:#151A21;--muted:#5B6470;--line:#E4E7EC;--accent:#C2185B;--accent-soft:#FBE7EF;--teal:#00897B;--bar:#CDD3DB;--grid:#EAEDF1;--good:#2E9E6B;--shadow:0 1px 2px rgba(20,26,33,.04),0 8px 24px rgba(20,26,33,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#16131C;--card:#201B29;--ink:#F2EEF4;--muted:#A69EB2;--line:#332B40;--accent:#F0619B;--accent-soft:#3A1E2E;--teal:#3FB8A8;--bar:#463C55;--grid:#2A2335;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35)}}
:root[data-theme="dark"]{--ground:#16131C;--card:#201B29;--ink:#F2EEF4;--muted:#A69EB2;--line:#332B40;--accent:#F0619B;--accent-soft:#3A1E2E;--teal:#3FB8A8;--bar:#463C55;--grid:#2A2335;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35)}
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:'Instrument Sans',system-ui,sans-serif;line-height:1.5;font-size:14px;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:38px 24px 70px}
.eyebrow{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:clamp(28px,5vw,42px);line-height:1.05;margin:0 0 10px;letter-spacing:-.01em;text-wrap:balance}
.lead{font-size:16px;color:var(--muted);max-width:64ch;margin:0}
.assump{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.assump span{font-family:'IBM Plex Mono',monospace;font-size:12px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:5px 12px;color:var(--ink)}
.assump b{color:var(--accent)}
.total{background:linear-gradient(135deg,var(--accent-soft),var(--card));border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:20px 24px;margin-top:24px;box-shadow:var(--shadow)}
.total .tl{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
.total .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.total .g{}
.total .g span{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
.total .g b{font-family:'Fraunces',serif;font-weight:900;font-size:24px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.note{font-size:12.5px;color:var(--muted);margin-top:12px;line-height:1.5}
h2{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:22px;margin:44px 0 14px}
.chartcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:var(--shadow)}
.chart .grid{stroke:var(--grid)}.chart .blab{font-size:12.5px;fill:var(--ink)}.chart .bval{font-size:12px;fill:var(--muted);font-family:'IBM Plex Mono',monospace}
.blouse{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-top:16px;box-shadow:var(--shadow)}
.bhead h3{font-family:'Fraunces',serif;font-weight:600;font-size:19px;margin:0 0 4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bhead .bn{font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--accent);font-weight:500}
.badge{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:20px}
.badge.prod{background:var(--accent-soft);color:var(--accent)}
.badge.ref{background:var(--grid);color:var(--muted)}
.bmeta{font-size:12.5px;color:var(--muted);margin-bottom:14px}.bmeta b{color:var(--ink)}
.cols{display:grid;grid-template-columns:1fr 1.25fr;gap:16px}
.cap{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.tbl-wrap{overflow-x:auto}
table.pt{width:100%;border-collapse:collapse;font-size:12.5px}
table.pt th,table.pt td{padding:6px 8px;text-align:right;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
table.pt th{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:500}
table.pt th.l,table.pt td.l{text-align:left}
table.pt td.sum{font-weight:600}
table.pt td.mon{font-family:'IBM Plex Mono',monospace;color:var(--ink)}
table.pt td.prof{font-family:'IBM Plex Mono',monospace;color:var(--good);font-weight:500}
table.pt tr.tot td{border-top:2px solid var(--line);border-bottom:none;font-weight:700;background:var(--accent-soft)}
.sw{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.earn{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
.ep{background:var(--ground);border:1px solid var(--line);border-radius:10px;padding:11px 13px}
.ep span{display:block;font-size:11px;color:var(--muted);margin-bottom:3px}
.ep b{font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600}
.ep.hi{background:var(--accent-soft);border-color:transparent}.ep.hi b{color:var(--accent)}
.foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.6}
.foot b{color:var(--ink)}
@media (max-width:720px){.cols{grid-template-columns:1fr}.total .grid4,.earn{grid-template-columns:1fr 1fr}.wrap{padding:26px 14px 54px}}
@media print{body{background:#fff}.blouse,.chartcard,.total{box-shadow:none;break-inside:avoid}.wrap{max-width:100%}h2{break-after:avoid}}
</style>
<div class="wrap">
  <p class="eyebrow">Wildberries · план продаж и заработок · нарядные блузки с жабо</p>
  <h1>План продаж: блузки жабо на сен–ноя 2026</h1>
  <p class="lead">По каждой блузке — количество к пошиву по размерам, помесячный план продаж по трём топ-цветам и заработок при чистой марже 15–17%.</p>
  <div class="assump">
    <span>Топ-цвет <b>1000 шт</b> · два других <b>× 500 шт</b></span>
    <span>Себестоимость <b>750 ₽</b></span>
    <span>Чистая маржа <b>15–17%</b> от цены</span>
    <span>Период <b>сен–ноя 2026</b></span>
    <span>Материалы <b>не суммируются</b></span>
  </div>

  <div class="total">
    <div class="tl">Итог к пошиву — 3 материала (гипюр + шёлк + хлопок)</div>
    <div class="grid4">
      <div class="g"><span>Объём</span><b>${fmt(prodUnits)} шт</b></div>
      <div class="g"><span>Выручка</span><b>${fmt(prodRev)} ₽</b></div>
      <div class="g"><span>Заработок @15%</span><b style="color:var(--accent)">${fmt(prodProfit[0])} ₽</b></div>
      <div class="g"><span>Заработок @17%</span><b style="color:var(--accent)">${fmt(prodProfit[1])} ₽</b></div>
    </div>
    <p class="note">Суммированы только тканевые SKU (разные материалы). «Жабо — все ткани» и «Нарядные жабо» — агрегатные срезы тех же блузок: показаны ниже отдельно как справочные сценарии и <b>не входят</b> в этот итог, чтобы не задвоить объём.</p>
  </div>

  <h2>Заработок по блузкам (при 17%)</h2>
  <div class="chartcard">${profitBars()}</div>

  <h2>Планы по блузкам</h2>
  ${plans.map((p, i) => blouseSection(p, i)).join('')}

  <div class="foot">
    <p><b>Методика.</b> Цены, топ-цвета и ходовые размеры — из отчётов по нишам (MPStats + публичные API WB, период 22.08.2025–21.08.2026). Разбивка по размерам — по долям ходовых размеров ниши (метод наибольших остатков, сумма точная). Помесячная кривая: нарядные ткани растут к новогоднему сезону (30/33/37%), хлопок — базовее (36/33/31%). Заработок = <b>маржа × выручка</b>; маржа задана 15–17% чистыми от цены продажи, себестоимость 750 ₽ — справочно (при цене 2 284–3 146 ₽ маржа 15–17% реалистична после комиссии WB, логистики, налога и рекламы).</p>
    <p><b>Важно.</b> План рассчитан на 100% реализацию заявленных объёмов за квартал. Фактические продажи зависят от выкупа (в нише ≈42%), рекламы и наличия остатков; при выкупе ниже планового часть объёма перейдёт на следующий период. Разные материалы не суммируются между собой.</p>
  </div>
</div>`;

fs.writeFileSync('reports-output/sales-plan-jabo.html', html);
// консоль-сводка
console.log('План к пошиву (3 материала):', fmt(prodUnits), 'шт · выручка', fmt(prodRev), '₽ · заработок', fmt(prodProfit[0]), '–', fmt(prodProfit[1]), '₽');
for (const p of plans) console.log(`  ${p.produce ? '[пошив]' : '[справ]'} ${p.name}: ${fmt(p.totUnits)} шт · ${fmt(p.totRev)} ₽ · заработок ${fmt(p.totProfit[0])}–${fmt(p.totProfit[1])} ₽`);
console.log('written reports-output/sales-plan-jabo.html', html.length, 'bytes');
