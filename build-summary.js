// build-summary.js — сводный мини-отчёт по всем женским типам рубашек/блузок.
// Читает агрегаты (жёстко заданы ниже из моих же отчётов) → самодостаточный HTML
// с SVG-диаграммами. Работает и как Artifact, и как источник для PDF (статичный SVG).
import fs from 'fs';

// ---- Данные (из моих отчётов, период 2025-08-22…2026-08-21, MPStats + публичные API WB) ----
const T = [
  { k: 'Жабо · гипюр/кружево', rev: 739, perCard: 3.42, lost: 45, top10: 24, price: 3146, cards: 216, score: 65,
    top: 'Vashbrend 37,9М · LOOKBALANCE 25,8М · ADM store 17,4М', color: 'чёрный 45%, белый 31%' },
  { k: 'Жабо · шёлк/атлас', rev: 794, perCard: 3.63, lost: 25, top10: 15, price: 2284, cards: 219, score: 54,
    top: 'Интересные рубашки 31,0М · Alesta Bis 17,5М', color: 'белый 20%, чёрный 20%' },
  { k: 'Жабо · хлопок', rev: 422, perCard: 1.90, lost: 46, top10: 9, price: 2314, cards: 222, score: 55,
    top: 'AnyMalls 16,1М · YAYMO 6,7М', color: 'белый 40%, серый 20%' },
  { k: 'Рубашки с корсетом/шнуровкой', rev: 1143, perCard: 3.59, lost: 43, top10: 24, price: 1981, cards: 318, score: 46,
    top: 'Trendy Halo 92,1М · DENKA 38,3М · Chronoloque 27,4М', color: 'белый 39%, чёрный 13%' },
  { k: 'На запах · в полоску', rev: 559, perCard: 2.21, lost: 56, top10: 12, price: 1758, cards: 253, score: 55,
    top: 'PREMIUM B 18,7М · ТЫСЯЧА СТОЛИЦ 15,4М · Flouze 9,9М', color: 'коричневый 20%, голубой 18%' },
  { k: 'На запах · однотонные', rev: 344, perCard: 2.08, lost: 48, top10: 24, price: 2190, cards: 165, score: 41,
    top: 'С девяти до пяти 13,1М · Vashbrend 12,3М · Divastore 11,3М', color: 'чёрный 28%, белый 24%' },
  { k: 'Асимметричные', rev: 278, perCard: 1.49, lost: 48, top10: 20, price: 2641, cards: 187, score: 42,
    top: 'BONTA LOVE 10,0М · L&K store 6,8М · UNICA club 6,1М', color: 'белый 30%, коричневый 14%' },
];
const JABO_UMBRELLA = 1173; // жабо (нарядные) дедуп по всем тканям
const COMBINED = 3497;      // жабо 1173 + корсет 1143 + полоска 559 + однотон 344 + асимметрия 278

const fmt = (n) => n.toLocaleString('ru-RU');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- Горизонтальная столбчатая диаграмма (SVG, статичная) ----
function hBar(rows, valKey, { unit = '', hi = null, w = 640, rowH = 34, pad = 8, fmtVal = (v) => fmt(v), color = 'var(--accent)' } = {}) {
  const labelW = 210, barX = labelW + 12, barMax = w - barX - 78;
  const max = Math.max(...rows.map((r) => r[valKey]));
  const H = rows.length * rowH + pad * 2;
  let s = `<svg viewBox="0 0 ${w} ${H}" width="100%" role="img" class="chart">`;
  // сетка
  for (let g = 0; g <= 4; g++) {
    const x = barX + (barMax * g) / 4;
    s += `<line x1="${x.toFixed(1)}" y1="${pad}" x2="${x.toFixed(1)}" y2="${H - pad}" class="grid"/>`;
  }
  rows.forEach((r, i) => {
    const y = pad + i * rowH;
    const bw = Math.max(2, (r[valKey] / max) * barMax);
    const isHi = hi ? hi(r) : false;
    const fill = isHi ? color : 'var(--bar)';
    s += `<text x="${labelW}" y="${y + rowH / 2}" class="blab" text-anchor="end" dominant-baseline="middle">${esc(r.k)}</text>`;
    s += `<rect x="${barX}" y="${y + 6}" width="${bw.toFixed(1)}" height="${rowH - 14}" rx="3" fill="${fill}"/>`;
    s += `<text x="${barX + bw + 8}" y="${y + rowH / 2}" class="bval" dominant-baseline="middle">${fmtVal(r[valKey])}${unit}</text>`;
  });
  s += `</svg>`;
  return s;
}

// ---- Диаграмма «место для входа»: упущенный спрос + раздробленность рядом ----
function gapChart(rows, { w = 640, rowH = 40, pad = 8 } = {}) {
  const labelW = 210, barX = labelW + 12, barMax = w - barX - 120;
  const H = rows.length * rowH + pad * 2;
  let s = `<svg viewBox="0 0 ${w} ${H}" width="100%" role="img" class="chart">`;
  rows.forEach((r, i) => {
    const y = pad + i * rowH;
    const frag = 100 - r.top10; // раздробленность
    const w1 = (r.lost / 100) * barMax, w2 = (frag / 100) * barMax;
    s += `<text x="${labelW}" y="${y + rowH / 2}" class="blab" text-anchor="end" dominant-baseline="middle">${esc(r.k)}</text>`;
    s += `<rect x="${barX}" y="${y + 4}" width="${w1.toFixed(1)}" height="12" rx="2" fill="var(--accent)"/>`;
    s += `<text x="${barX + w1 + 6}" y="${y + 10}" class="bval sm" dominant-baseline="middle">${r.lost}%</text>`;
    s += `<rect x="${barX}" y="${y + 20}" width="${w2.toFixed(1)}" height="12" rx="2" fill="var(--teal)"/>`;
    s += `<text x="${barX + w2 + 6}" y="${y + 26}" class="bval sm" dominant-baseline="middle">${frag}%</text>`;
  });
  s += `</svg>`;
  return s;
}

// ---- Матрица «деньги × лёгкость входа» ----
function matrix(rows, { w = 640, h = 420, pad = 46 } = {}) {
  const xMax = Math.max(...rows.map((r) => r.perCard)) * 1.1;   // ось X: денежность карточки
  const easeOf = (r) => (r.lost + (100 - r.top10)) / 2;         // ось Y: лёгкость входа (упущ + раздробл)/2
  const yMax = 80, yMin = 20;
  const px = (v) => pad + (v / xMax) * (w - pad * 1.5);
  const py = (v) => (h - pad) - ((v - yMin) / (yMax - yMin)) * (h - pad * 1.8);
  let s = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" class="chart matrix">`;
  // квадранты
  const midX = px(xMax / 2), midY = py((yMax + yMin) / 2);
  s += `<line x1="${midX}" y1="${pad / 2}" x2="${midX}" y2="${h - pad}" class="grid"/>`;
  s += `<line x1="${pad}" y1="${midY}" x2="${w - pad / 2}" y2="${midY}" class="grid"/>`;
  s += `<text x="${w - pad / 2}" y="${h - pad + 22}" class="axis" text-anchor="end">денежность карточки, млн ₽/год →</text>`;
  s += `<text x="${pad - 34}" y="${pad}" class="axis" transform="rotate(-90 ${pad - 34} ${pad})">лёгкость входа →</text>`;
  s += `<text x="${midX + 6}" y="${pad}" class="quad">💰 много денег + легко</text>`;
  rows.forEach((r) => {
    const cx = px(r.perCard), cy = py(easeOf(r));
    const rad = 7 + (r.rev / COMBINED) * 60;
    const hi = r.score >= 54;
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${hi ? 'var(--accent)' : 'var(--teal)'}" fill-opacity="0.30" stroke="${hi ? 'var(--accent)' : 'var(--teal)'}" stroke-width="1.5"/>`;
    s += `<text x="${cx.toFixed(1)}" y="${(cy - rad - 5).toFixed(1)}" class="mlab" text-anchor="middle">${esc(r.k.replace('Рубашки ', '').replace(' · ', ' '))}</text>`;
  });
  s += `</svg>`;
  return s;
}

const byScore = [...T].sort((a, b) => b.score - a.score);
const byRev = [...T].sort((a, b) => b.rev - a.rev);
const byPerCard = [...T].sort((a, b) => b.perCard - a.perCard);
const byPrice = [...T].sort((a, b) => b.price - a.price);
const byGap = [...T].sort((a, b) => (b.lost + (100 - b.top10)) - (a.lost + (100 - a.top10)));

function scoreRow(r, i) {
  const bw = (r.score / 70) * 100;
  const medal = i === 0 ? '①' : i === 1 ? '②' : i === 2 ? '③' : (i + 1);
  return `<tr${i === 0 ? ' class="win"' : ''}>
    <td class="rk">${medal}</td>
    <td class="nm">${esc(r.k)}</td>
    <td class="num">${fmt(r.rev)}</td>
    <td class="num">${r.perCard.toFixed(2)}</td>
    <td class="num">${r.lost}%</td>
    <td class="num">${r.top10}%</td>
    <td class="num">${fmt(r.price)} ₽</td>
    <td class="sc"><span class="scbar" style="width:${bw.toFixed(0)}%"></span><b>${r.score}</b></td>
  </tr>`;
}

const html = `<title>Что шить на Wildberries</title>
<style>
:root{
  --ground:#F5F6F8; --card:#FFFFFF; --ink:#151A21; --muted:#5B6470; --line:#E4E7EC;
  --accent:#C2185B; --accent-soft:#FBE7EF; --teal:#00897B; --teal-soft:#E1F1EF;
  --bar:#CDD3DB; --grid:#EAEDF1;
  --good:#2E9E6B; --warn:#E8A33D; --crit:#D2453B;
  --shadow:0 1px 2px rgba(20,26,33,.04),0 8px 24px rgba(20,26,33,.06);
}
:root:not([data-theme="light"]){ }
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#16131C; --card:#201B29; --ink:#F2EEF4; --muted:#A69EB2; --line:#332B40;
  --accent:#F0619B; --accent-soft:#3A1E2E; --teal:#3FB8A8; --teal-soft:#12332E;
  --bar:#463C55; --grid:#2A2335; --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --ground:#16131C; --card:#201B29; --ink:#F2EEF4; --muted:#A69EB2; --line:#332B40;
  --accent:#F0619B; --accent-soft:#3A1E2E; --teal:#3FB8A8; --teal-soft:#12332E;
  --bar:#463C55; --grid:#2A2335; --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);
}
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:'Instrument Sans',system-ui,-apple-system,sans-serif;line-height:1.55;
  -webkit-font-smoothing:antialiased;font-size:15px}
.wrap{max-width:860px;margin:0 auto;padding:40px 26px 72px}
.eyebrow{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-family:'Fraunces',Georgia,serif;font-weight:900;font-size:clamp(30px,5.5vw,46px);line-height:1.04;margin:0 0 12px;text-wrap:balance;letter-spacing:-.01em}
.lead{font-size:17px;color:var(--muted);max-width:62ch;margin:0}
.meta{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);margin-top:14px;letter-spacing:.02em}
h2{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:24px;margin:52px 0 6px;letter-spacing:-.01em}
h2 .n{font-family:'IBM Plex Mono',monospace;font-size:13px;color:var(--accent);font-weight:500;margin-right:10px;vertical-align:middle}
.sub{color:var(--muted);font-size:14px;margin:0 0 20px;max-width:64ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;box-shadow:var(--shadow)}
/* verdict */
.verdict{background:linear-gradient(135deg,var(--accent-soft),var(--card));border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:14px;padding:24px 26px;margin-top:30px;box-shadow:var(--shadow)}
.verdict .vlabel{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:8px}
.verdict p{margin:0;font-size:18px;font-weight:500;text-wrap:pretty}
.verdict b{color:var(--accent)}
.lanes{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}
.lane{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 15px}
.lane .pct{font-family:'Fraunces',serif;font-weight:900;font-size:26px;line-height:1}
.lane .pct.a{color:var(--accent)} .lane .pct.b{color:var(--teal)} .lane .pct.c{color:var(--muted)}
.lane h4{margin:6px 0 4px;font-size:14px}
.lane p{margin:0;font-size:12.5px;color:var(--muted);line-height:1.4}
/* kpi */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:22px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 16px 15px;box-shadow:var(--shadow)}
.kpi .kv{font-family:'Fraunces',serif;font-weight:900;font-size:27px;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .kl{font-size:12px;color:var(--muted);margin-top:7px;line-height:1.35}
.kpi .kt{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:9px}
/* chart */
.chart{display:block;margin-top:6px;font-family:'Instrument Sans',sans-serif}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .blab{font-size:12.5px;fill:var(--ink)}
.chart .bval{font-size:12px;fill:var(--muted);font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.chart .bval.sm{font-size:10.5px}
.chart .axis{font-size:11px;fill:var(--muted);font-family:'IBM Plex Mono',monospace}
.chart .quad{font-size:11px;fill:var(--accent);font-family:'IBM Plex Mono',monospace}
.chart .mlab{font-size:11px;fill:var(--ink);font-weight:500}
.legend{display:flex;gap:18px;margin:2px 0 4px;font-size:12px;color:var(--muted);font-family:'IBM Plex Mono',monospace}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:-1px}
/* table */
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:4px}
th,td{text-align:right;padding:9px 8px;border-bottom:1px solid var(--line)}
th{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:500}
th:nth-child(2),td.nm{text-align:left}
td.rk{font-family:'Fraunces',serif;font-weight:900;color:var(--accent);font-size:16px;text-align:center;width:34px}
td.nm{font-weight:500}
td.num{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums;color:var(--ink)}
td.sc{position:relative;width:110px}
td.sc .scbar{position:absolute;left:8px;top:50%;transform:translateY(-50%);height:20px;background:var(--accent-soft);border-radius:4px;z-index:0}
td.sc b{position:relative;z-index:1;font-family:'IBM Plex Mono',monospace}
tr.win td{background:var(--accent-soft)}
tr.win td.nm{font-weight:600}
/* prose lists */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:6px}
.finding{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}
.finding h4{margin:0 0 6px;font-size:14px;display:flex;align-items:center;gap:8px}
.finding h4 .dot{width:9px;height:9px;border-radius:50%;flex:none}
.finding p{margin:0;font-size:13px;color:var(--muted);line-height:1.5}
.finding p b{color:var(--ink)}
ul.clean{margin:8px 0 0;padding:0;list-style:none}
ul.clean li{padding:7px 0 7px 22px;position:relative;font-size:14px;border-bottom:1px solid var(--line)}
ul.clean li:last-child{border-bottom:0}
ul.clean li::before{content:"→";position:absolute;left:0;color:var(--accent);font-weight:700}
ul.clean b{font-weight:600}
/* evidence */
.ev{font-size:13px;margin-top:4px}
.ev tr td{padding:10px 8px}
.ev .tname{font-weight:600;text-align:left}
.ev .models{text-align:left;color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:11.5px}
.ev .col{text-align:left;font-size:12px;color:var(--muted)}
.foot{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.6}
.foot b{color:var(--ink)}
.tag{display:inline-block;background:var(--accent-soft);color:var(--accent);font-family:'IBM Plex Mono',monospace;font-size:11px;padding:2px 8px;border-radius:20px;margin:0 4px 4px 0}
@media (max-width:680px){.kpis,.lanes,.grid2{grid-template-columns:1fr 1fr}.wrap{padding:28px 16px 56px}}
@media print{body{background:#fff}.card,.kpi,.finding,.lane,.verdict{box-shadow:none}.wrap{max-width:100%}h2{break-after:avoid}.card,.finding,.verdict,table{break-inside:avoid}}
</style>

<div class="wrap">
  <p class="eyebrow">Wildberries · аналитика ассортимента · синтез 8 отчётов</p>
  <h1>Что шить и продавать: женские рубашки и блузки</h1>
  <p class="lead">Сравнение семи типов женских рубашек и блузок по деньгам, спросу, конкуренции и марже — с выводом, во что вкладывать пошив и почему.</p>
  <p class="meta">Период данных: 22.08.2025 – 21.08.2026 · Источник: MPStats + публичные API WB · Выкуп ≈ 42% (оценка категории)</p>

  <div class="verdict">
    <div class="vlabel">Вывод</div>
    <p>Ядро прибыли — <b>нарядные блузки с жабо (гипюр и шёлк)</b>: там сходятся объём, высокий чек и маржа. Второй двигатель — <b>рубашки на запах</b> (полоска + базовые цвета): тренд 2026, самый неудовлетворённый спрос и низкая конкуренция — легче всего зайти. <b>Корсет/шнуровку</b> берём как большой, но тесный рынок — только с сильным отличием.</p>
    <div class="lanes">
      <div class="lane"><div class="pct a">50%</div><h4>Жабо: гипюр + шёлк</h4><p>Деньги и маржа. Чек 2 300–3 150 ₽, проверенные лидеры до 38 млн/год.</p></div>
      <div class="lane"><div class="pct b">30%</div><h4>На запах: полоска + база</h4><p>Тренд 2026, спрос не закрыт на 48–56%, простой пошив (поплин/хлопок).</p></div>
      <div class="lane"><div class="pct c">20%</div><h4>Тест: корсет / асимметрия</h4><p>Премиум-эксперимент с отличием: высокий чек, ранний тренд.</p></div>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="kt">Рынок ниш</div><div class="kv">~3,5<span style="font-size:15px"> млрд ₽</span></div><div class="kl">суммарная ёмкость 5 типов за год</div></div>
    <div class="kpi"><div class="kt">Больше всего денег</div><div class="kv">Жабо</div><div class="kl">1 173 млн ₽/год (все ткани)</div></div>
    <div class="kpi"><div class="kt">Выше маржа</div><div class="kv">3 146 ₽</div><div class="kl">ср. чек — гипюровые с жабо</div></div>
    <div class="kpi"><div class="kt">Легче зайти</div><div class="kv">56%</div><div class="kl">упущ. спрос — полоска на запах</div></div>
  </div>

  <h2><span class="n">01</span>Где больше денег</h2>
  <p class="sub">Ёмкость рынка за год по типам, млн ₽. Жабо и корсет — тяжеловесы: вдвоём ≈ 2,3 млрд ₽/год. Жабо «все ткани» (${fmt(JABO_UMBRELLA)} млн, дедуп) показано разбивкой по тканям ниже.</p>
  <div class="card">${hBar(byRev, 'rev', { unit: ' млн', hi: (r) => r.rev >= 700 })}</div>

  <h2><span class="n">02</span>Насколько «жирная» одна карточка</h2>
  <p class="sub">Выручка на одну карточку в нише (ёмкость ÷ число карточек), млн ₽/год. Показывает, сколько реально может заработать один SKU — ключевой ориентир окупаемости пошива.</p>
  <div class="card">${hBar(byPerCard, 'perCard', { unit: ' млн', fmtVal: (v) => v.toFixed(2), hi: (r) => r.perCard >= 3.4 })}</div>

  <h2><span class="n">03</span>Где есть место для входа</h2>
  <p class="sub">Две метрики «лёгкости»: <b>упущенный спрос</b> (какую долю потенциала рынок не закрывает из-за нехватки остатков — прямая незанятая выручка) и <b>раздробленность</b> (100 − доля топ-10; чем выше, тем меньше монополия лидеров и легче попасть в топ).</p>
  <div class="legend"><span><i style="background:var(--accent)"></i>упущенный спрос</span><span><i style="background:var(--teal)"></i>раздробленность (не топ-10)</span></div>
  <div class="card">${gapChart(byGap)}</div>

  <h2><span class="n">04</span>Маржа: средний чек</h2>
  <p class="sub">Средняя цена продажи, ₽. Выше чек — больше абсолютная маржа с изделия при сопоставимой себестоимости. Гипюр и асимметрия — самые «дорогие» сегменты; полоска и корсет — объёмные, но с тонкой маржой.</p>
  <div class="card">${hBar(byPrice, 'price', { unit: ' ₽', hi: (r) => r.price >= 2600, color: 'var(--teal)' })}</div>

  <h2><span class="n">05</span>Рейтинг привлекательности для запуска</h2>
  <p class="sub">Композитный балл 0–100: денежность карточки 30% · упущенный спрос 25% · раздробленность 20% · чек/маржа 15% · низкая насыщенность 10%.</p>
  <div class="card" style="overflow-x:auto">
    <table>
      <thead><tr><th></th><th>Тип</th><th>Ёмкость, млн</th><th>Выр/карт</th><th>Упущ.</th><th>Топ-10</th><th>Ср. чек</th><th>Балл</th></tr></thead>
      <tbody>${byScore.map(scoreRow).join('')}</tbody>
    </table>
  </div>

  <h2><span class="n">06</span>Карта «деньги × лёгкость входа»</h2>
  <p class="sub">По горизонтали — денежность карточки; по вертикали — лёгкость входа (упущенный спрос + раздробленность). Размер круга = ёмкость рынка. Правый верхний угол — идеал: много денег и легко зайти. Розовые круги — приоритет (балл ≥ 54).</p>
  <div class="card">${matrix(T)}</div>

  <h2><span class="n">07</span>Ответы на три вопроса</h2>
  <div class="grid2">
    <div class="finding"><h4><span class="dot" style="background:var(--accent)"></span>Где больше денег?</h4><p><b>Жабо (1 173 млн) и корсет (1 143 млн)</b> — вдвоём ≈ 2,3 млрд ₽/год. По деньгам на карточку впереди <b>шёлк-жабо (3,63 млн)</b>, корсет (3,59) и гипюр-жабо (3,42).</p></div>
    <div class="finding"><h4><span class="dot" style="background:var(--teal)"></span>Кто легче/лучше продаётся?</h4><p><b>Легче зайти</b> — полоска на запах (упущ. 56%, топ-10 всего 12%) и хлопок-жабо (топ-10 9% — рынок раздроблен). <b>Больше продаётся деньгами</b> — корсет и жабо.</p></div>
    <div class="finding"><h4><span class="dot" style="background:var(--good)"></span>Что шить в первую очередь?</h4><p><b>Гипюровые блузки с жабо</b> — №1 по привлекательности (балл 65): высокий чек 3 146 ₽ + большой рынок + спрос закрыт лишь на 55%. Ставка «деньги + маржа».</p></div>
    <div class="finding"><h4><span class="dot" style="background:var(--warn)"></span>Чем добрать объём?</h4><p><b>Рубашки на запах</b> (полоска + база). Простой пошив (поплин/хлопок), тренд 2026, максимальный незакрытый спрос — быстрый оборот при тонкой, но объёмной марже.</p></div>
  </div>

  <h2><span class="n">08</span>Что именно шить — портфель</h2>
  <ul class="clean">
    <li><b>50% — нарядные блузки с жабо, гипюр и шёлк.</b> Чек 2 300–3 150 ₽. Цвета-бестселлеры: <b>чёрный и белый</b> (гипюр 45%/31%). Длинный рукав, приталенные. Здесь и деньги, и маржа, и проверенные лидеры (Vashbrend 37,9 млн, Интересные рубашки 31 млн).</li>
    <li><b>30% — рубашки на запах, полоска + базовые цвета.</b> Поплин/хлопок, завязка на талии, классический воротник. Цвета: <b>коричневый, голубой, белый, чёрный</b>. Дешевле в пошиве, тренд 2026, спрос не закрыт на 48–56% — сюда легче всего войти новичку.</li>
    <li><b>20% — тест-партия: корсет/шнуровка или асимметрия.</b> Корсет — огромный рынок (1 143 млн), но 318 карточек: заходить только с отличием (крой, ткань, посадка). Асимметрия — маленькая, но с высоким чеком (2 641 ₽) и ранним трендом — премиум-эксперимент.</li>
    <li><b>Единые правила для всех:</b> длинный рукав (короткий/без рукава проседает), приталенный силуэт, размеры <b>44–50</b> (закрывают ядро спроса; 42–52 общий ряд), белый/чёрный как базовые расцветки, упор на качество ткани и посадку (главные темы негатива в отзывах — «маломерит» и «отличие от фото»).</li>
  </ul>

  <h2><span class="n">09</span>Доказательная база — проверенные лидеры</h2>
  <p class="sub">Реальные топ-карточки в каждой нише за год (годовая выручка). Это не единичные всплески, а стабильные лидеры выдачи — подтверждают, что спрос конвертируется в деньги.</p>
  <div class="card" style="overflow-x:auto">
    <table class="ev">
      <thead><tr><th class="tname" style="text-align:left">Тип</th><th style="text-align:left">Топ-модели (₽/год)</th><th style="text-align:left">Ходовые цвета</th></tr></thead>
      <tbody>${byScore.map((r) => `<tr><td class="tname">${esc(r.k)}</td><td class="models">${esc(r.top)}</td><td class="col">${esc(r.color)}</td></tr>`).join('')}</tbody>
    </table>
  </div>

  <h2><span class="n">10</span>Риски и как их закрыть</h2>
  <div class="grid2">
    <div class="finding"><h4><span class="dot" style="background:var(--crit)"></span>Корсет — тесно</h4><p>318 карточек, топ-10 держит 24%, лидер Trendy Halo 92 млн. Заходить только с чётким отличием, иначе утонете в середине выдачи.</p></div>
    <div class="finding"><h4><span class="dot" style="background:var(--crit)"></span>Полоска — тонкая маржа</h4><p>Чек 1 758 ₽ — самый низкий. Берём объёмом и оборотом, экономим на себестоимости (поплин), не на посадке.</p></div>
    <div class="finding"><h4><span class="dot" style="background:var(--warn)"></span>Шёлк-жабо — спрос закрыт</h4><p>Упущено лишь 25% — рынок уже хорошо снабжён. Денег много, но входить сложнее: нужен сильный контент и цена.</p></div>
    <div class="finding"><h4><span class="dot" style="background:var(--warn)"></span>«Маломерит» и фото</h4><p>Сквозные темы негатива во всех нишах. Точная размерная сетка и честные фото «как в жизни» = меньше возвратов, выше выкуп.</p></div>
  </div>

  <div class="foot">
    <p><b>Методология.</b> Данные собраны через MPStats (выдача по фразам, карточка/статистика товара) и публичные API WB (card.json — характеристики, feedbacks — отзывы, search.wb.ru — размеры/конкуренты) за 12 месяцев. По каждому типу: объединение выдачи по 4 фразам → дедуп → фильтр по названию и card.json (рукав/ткань/крой) → визуальная проверка фото → рынок, топ-10, расцветки, размеры, разбор 3 артикулов. «Выручка на карточку» = ёмкость ÷ число карточек с продажами. «Упущенный спрос» = доля неудовлетворённого спроса из-за нехватки остатков. «Раздробленность» = 100 − доля топ-10 в выручке ниши.</p>
    <p><b>Оговорки.</b> Выкуп ≈ 42% — оценка на уровне категории, «заработал» = выручка × выкуп — ориентир, не бухгалтерия. Ёмкости тканевых под-ниш жабо собраны разными пулами фраз и частично пересекаются — для суммы рынка использована дедуп-оценка жабо «все ткани» (1 173 млн). Композитный балл — приоритизация под запуск с нуля, а не прогноз выручки.</p>
    <p style="margin-top:10px">${['жабо гипюр','жабо шёлк','жабо хлопок','корсет/шнуровка','на запах полоска','на запах однотон','асимметрия'].map((t) => `<span class="tag">${t}</span>`).join('')}</p>
  </div>
</div>`;

fs.writeFileSync('reports-output/summary-women-shirts.html', html);
console.log('written reports-output/summary-women-shirts.html', html.length, 'bytes');
