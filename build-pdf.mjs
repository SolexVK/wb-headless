// build-pdf.mjs — компактный печатный HTML-отчёт (→ PDF через chrome --print-to-pdf).
// Инфографика: KPI-карточки, воронка, SVG-спарклайны продаж, бенчмарк-бары,
// ценовые сегменты, концентрация продавцов, галерея первых слайдов с вердиктами.

import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'reports/new-products/2026-07-14';
const data = JSON.parse(readFileSync(`${DIR}/data.json`, 'utf8'));
const slides = JSON.parse(readFileSync(`${DIR}/slides/manifest.json`, 'utf8'));

const rub = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 34) => (s && s.length > n ? esc(s.slice(0, n - 1)) + '…' : esc(s || ''));
const b64 = (p) => `data:image/webp;base64,${readFileSync(p).toString('base64')}`;
const med = (arr) => { const a = arr.filter((x) => x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

const META = {
  0: { label: 'Женская', color: '#A6385A', soft: '#F3E1E7', cls: 'w' },
  1: { label: 'Мужская', color: '#34568B', soft: '#DDE6F2', cls: 'm' },
};

// ---------- SVG helpers ----------
function areaSpark(vals, color, w = 150, h = 34) {
  if (!vals.length) return '';
  const max = Math.max(...vals, 1);
  const step = w / (vals.length - 1 || 1);
  const pts = vals.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `M0,${h} ${pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} L${w},${h} Z`;
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="spark">
    <path d="${area}" fill="${color}" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${color}"/>
  </svg>`;
}

function gauge(pct, color, label) {
  // полукруглая шкала-«пончик» для доли
  const r = 26, c = Math.PI * r;
  const off = c * (1 - Math.min(100, pct) / 100);
  return `<svg viewBox="0 0 64 40" width="64" height="40" class="gauge">
    <path d="M6,34 A26,26 0 0 1 58,34" fill="none" stroke="#EBE8E2" stroke-width="7" stroke-linecap="round"/>
    <path d="M6,34 A26,26 0 0 1 58,34" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    <text x="32" y="30" text-anchor="middle" class="gval">${label}</text>
  </svg>`;
}

// ---------- funnel ----------
function funnel(a, m) {
  const news = a.news;
  const stages = [
    { ic: '👁', n: 'Показы / видимость', w: 'вход', metric: `вид. ≈ ${med(news.map((c) => c.searchVisibility))}`, width: 100, tone: 'n' },
    { ic: '🖱', n: 'Клик · CTR', w: '+25%', metric: `позиция ≈ ${med(news.map((c) => c.searchPosAvg))}`, width: 80, tone: 'a' },
    { ic: '🛒', n: 'Корзина', w: '0%', metric: 'фактор убран', width: 62, tone: 'muted' },
    { ic: '📦', n: 'Заказ', w: '+25%', metric: `${med(news.map((c) => c.salesPerDay)).toFixed(1)} шт/день`, width: 46, tone: 'a' },
    { ic: '✅', n: 'Выкуп', w: '+50%', metric: `≈ ${a.niche.medianBuyout}%`, width: 32, tone: 'good' },
  ];
  return `<div class="funnel">${stages.map((s) => `
    <div class="fstage tone-${s.tone}" style="--fw:${s.width}%;--fc:${m.color}">
      <div class="fbar"><span>${s.ic}</span><b>${s.n}</b><i>${s.w}</i></div>
      <div class="fm">${esc(s.metric)}</div>
    </div>`).join('')}</div>`;
}

// ---------- listing benchmark ----------
function benchmark(a, m) {
  const b = a.benchmark, nb = a.newsBenchmark || {};
  const rows = [
    ['Фото', b.pics, nb.pics, ''],
    ['Видео %', b.hasVideoShare, nb.hasVideoShare, '%'],
    ['SEO-слов', b.searchWords, nb.searchWords, ''],
    ['Отзывов', b.comments, nb.comments, ''],
  ];
  return `<div class="bench">${rows.map(([k, top, nw, u]) => {
    const max = Math.max(top, nw, 1);
    return `<div class="brow"><span class="bk">${k}</span>
      <div class="bb"><i style="width:${(top / max) * 100}%;background:#B9B4AC"></i><em>${rub(top)}${u}</em></div>
      <div class="bb"><i style="width:${(nw / max) * 100}%;background:${m.color}"></i><em>${rub(nw)}${u}</em></div>
    </div>`;
  }).join('')}</div>`;
}

// ---------- price segments ----------
function segments(a, m) {
  const segs = a.competition.segments;
  const max = Math.max(...segs.map((s) => s.revenue), 1);
  return `<div class="segs">${segs.map((s) => `
    <div class="seg">
      <div class="segbar" style="height:${Math.max(4, (s.revenue / max) * 70)}px;background:${m.color}"></div>
      <div class="segrev">${(s.revenue / 1e6).toFixed(1)}М</div>
      <div class="seglbl">${rub(s.from)}–${rub(s.to)}</div>
      <div class="segn">${s.cards} шт</div>
    </div>`).join('')}</div>`;
}

// ---------- sellers ----------
function sellers(a, m) {
  const top = a.competition.topSellers.slice(0, 5);
  return `<div class="sellers">${top.map((s) => {
    const share = a.niche.revenue ? (s.revenue / a.niche.revenue) * 100 : 0;
    return `<div class="srow"><span>${short(s.key, 26)}</span>
      <div class="sbar"><i style="width:${Math.min(100, share * 4)}%;background:${m.color}"></i></div>
      <em>${share.toFixed(1)}%</em></div>`;
  }).join('')}</div>`;
}

// ---------- news table ----------
function newsTable(a, m) {
  const rows = a.news.filter((c) => c.sales > 0).slice(0, 8);
  const maxRev = Math.max(...rows.map((c) => c.revenue), 1);
  const trajBy = Object.fromEntries((a.trajectories || []).map((t) => [t.sku, t.daily || []]));
  return `<table class="nt"><thead><tr>
    <th>SKU / название</th><th>вышла</th><th class="r">цена</th><th class="r">продаж</th><th class="r">выручка</th><th>динамика</th></tr></thead><tbody>
    ${rows.map((c) => {
      const daily = (trajBy[c.sku] || []).map((d) => d.sales);
      return `<tr>
        <td><b>${c.sku}</b><div class="nn">${short(c.name, 30)}</div></td>
        <td class="mono">${esc(c.firstDate.slice(5))}</td>
        <td class="r mono">${rub(c.price)}</td>
        <td class="r mono">${rub(c.sales)}</td>
        <td class="r mono">${rub(c.revenue)}</td>
        <td>${daily.length ? areaSpark(daily, m.color, 90, 26) : '—'}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

// ---------- slide gallery (визуальная воронка) ----------
const SLIDE_VERDICTS = {
  1016184515: ['Чистое студийное фото', 'Молодой модель, бирюзовый фон, короткий рукав. Без текста — ставка на цену (643 ₽) и объём. Бюджетный лидер-прорыв.', 'good'],
  804912364: ['Editorial / стритвир', 'Ночь у заправки, гранж-настроение. Премиум через мудборд, не через текст. Younger streetwear.', 'a'],
  1013899289: ['Классика, студия', 'Зрелый модель 40+, синяя клетка, вотермарка бренда. Консервативный покупатель, цена 2 243 ₽.', 'a'],
  1095824553: ['Флэтлей + текст-хук', '«TREND 2027» на разложенной рубашке, драматичный свет. На рекламе. НО характеристик всего 2 — слабая органика.', 'warn'],
  1052000593: ['Инфографика', '«РУБАШКА · ХЛОПОК · 40-56» + инсет полного образа. Материал и размерный ряд — на 1-м слайде. Масс-маркет 990 ₽.', 'good'],
  1128812446: ['Стрит-стайл / UGC', 'Кадр без головы, образ с сумкой Coach, беж-клетка. Pinterest-эстетика, fashion-forward аудитория.', 'a'],
};
function gallery(items) {
  return `<div class="gal">${items.map((it) => {
    const v = SLIDE_VERDICTS[it.sku] || ['', '', 'n'];
    const first = it.files.find((f) => /_1\.webp$/.test(f)) || it.files[0];
    return `<figure class="card tone-${v[2]}">
      <img src="${b64(first)}" alt=""/>
      <figcaption>
        <div class="ctag">${esc(v[0])}</div>
        <div class="cmeta"><b>${it.sku}</b> · ${rub(it.price)} ₽ · ${rub(it.sales)} шт · фото ${it.photoCount ?? '—'}</div>
        <p>${esc(v[1])}</p>
      </figcaption>
    </figure>`;
  }).join('')}</div>`;
}

// ---------- assemble ----------
const A = data.map((a, i) => ({ a, m: META[i] }));
const galW = slides.filter((s) => s.query.includes('женская') && SLIDE_VERDICTS[s.sku]);
const galM = slides.filter((s) => s.query.includes('мужская') && SLIDE_VERDICTS[s.sku]);

function kpis(a, m) {
  return `<div class="kpis">
    <div class="kpi"><div class="kv" style="color:${m.color}">${a.counts.news}</div><div class="kl">новинок · ${a.counts.newsWithSales} с продажами</div></div>
    <div class="kpi"><div class="kv" style="color:${m.color}">${a.newsShare.revenuePct}%</div><div class="kl">доля выручки ниши</div></div>
    <div class="kpi"><div class="kv" style="color:${m.color}">${rub(a.niche.medianPrice)}</div><div class="kl">медианная цена, ₽</div></div>
    <div class="kpi"><div class="kv" style="color:${m.color}">${a.niche.hhiSellers}</div><div class="kl">HHI · раздроблена</div></div>
  </div>`;
}

const page1 = `
<section class="page">
  <header class="cover">
    <div class="eyebrow">MPStats · Wildberries · снимок ${esc(data[0].period.d2)} · окно 60 дней</div>
    <h1>Товары-новинки:<br><span class="hl">«рубашка в клетку»</span></h1>
    <p class="lead">Карточки, вышедшие на WB за последние 2 месяца, по двум запросам. Продажи · листинг · воронка ранжирования · визуальный разбор · конкуренты.</p>
  </header>
  ${A.map(({ a, m }) => `
  <div class="qcard ${m.cls}">
    <div class="qtitle"><span class="qdot" style="background:${m.color}"></span>«${esc(a.query)}»</div>
    ${kpis(a, m)}
    <div class="qfoot">Выручка новинок за 60 дн.: <b>${rub(a.newsShare.revenue)} ₽</b> из ${rub(a.niche.revenue)} ₽ · продавцов в топе: ${a.niche.sellers} · медианный выкуп ${a.niche.medianBuyout}%</div>
  </div>`).join('')}
  <div class="takeaways">
    <div class="tk"><div class="tki">🎯</div><div><b>Мужская ниша — точка входа.</b> Новинки берут 5,0% выручки и 12% продаж против 1,0% у женской; планка листинга ниже (16 фото vs 23).</div></div>
    <div class="tk"><div class="tki">🚀</div><div><b>Прорыв реален.</b> Мужской SKU 1016184515 (643 ₽, короткий рукав) за 2 мес. вошёл в топ-7 ниши по выручке, обгоняя карточки 2023–24 гг.</div></div>
    <div class="tk"><div class="tki">🧩</div><div><b>Ниши раздроблены</b> (HHI 0,07–0,08): нет доминатора &gt;20%, вход открыт при сильной карточке.</div></div>
  </div>
</section>`;

const funnelPages = A.map(({ a, m }) => `
<section class="page">
  <h2 class="ph"><span class="qdot" style="background:${m.color}"></span>${m.label} · воронка и продажи</h2>
  <div class="grid2">
    <div class="panel">
      <div class="pt">Визуальная воронка · модель ранжирования WB</div>
      ${funnel(a, m)}
      <p class="note">Вклад в органику (KB 01): клик <b>+25%</b>, корзина <b>0%</b>, заказ <b>+25%</b>, <b style="color:#2E7D5B">выкуп +50%</b> — главный фактор. Метрики — медиана по новинкам.</p>
    </div>
    <div class="panel">
      <div class="pt">Листинг: планка топ-20 (серый) vs новинки (цвет)</div>
      ${benchmark(a, m)}
      <div class="pt" style="margin-top:12px">Ценовые сегменты · выручка</div>
      ${segments(a, m)}
    </div>
  </div>
  <div class="panel">
    <div class="pt">Продажи новинок за 60 дней · динамика по дням</div>
    ${newsTable(a, m)}
  </div>
  <div class="panel">
    <div class="pt">Конкуренция · доля продавцов в топе-100</div>
    ${sellers(a, m)}
  </div>
</section>`).join('');

const galleryPage = `
<section class="page">
  <h2 class="ph">Визуальный разбор первого слайда · драйвер CTR</h2>
  <p class="sub">Первый слайд решает клик. У новинок «рубашки в клетку» — пять разных стратегий обложки. Ниже — лидеры обоих запросов и вердикт по каждому.</p>
  <div class="galwrap">
    <div class="galtitle w">Женская</div>
    ${gallery(galW)}
    <div class="galtitle m">Мужская</div>
    ${gallery(galM)}
  </div>
  <div class="legend">
    <span><i class="lg good"></i>сильная обложка</span>
    <span><i class="lg a"></i>рабочая / нишевая</span>
    <span><i class="lg warn"></i>есть риск / пробел</span>
  </div>
  <footer class="foot">Данные MPStats — оценочные (восстановление по остаткам/выкупам), для сравнения и ранжирования. «Ниша» = топ-100 выдачи по запросу; выкуп % — оценка на уровне ниши. Слайды — публичные карточки WB (basket CDN). Полный отчёт и данные: reports/new-products/${esc(data[0].period.d2.slice(0, 4))}-07-14/.</footer>
</section>`;

const css = readFileSync('pdf-style.css', 'utf8');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Новинки WB — рубашка в клетку</title><style>${css}</style></head>
<body>${page1}${funnelPages}${galleryPage}</body></html>`;
writeFileSync(`${DIR}/report.html`, html);
console.log('report.html:', html.length, 'bytes');
