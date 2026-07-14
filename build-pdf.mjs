// build-pdf.mjs — компактный печатный HTML-отчёт (→ PDF через chrome --print-to-pdf).
// Инфографика: KPI, воронка, SVG-спарклайны продаж, бенчмарк, ценовые сегменты,
// концентрация, галерея обложек + ЛЕНТА ИЗ 10 СЛАЙДОВ на каждую новинку.
// Все артикулы/бренды — кликабельные ссылки (сохраняются в PDF).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DIR = 'reports/new-products/2026-07-14';
const data = JSON.parse(readFileSync(`${DIR}/data.json`, 'utf8'));
const slides = JSON.parse(readFileSync(`${DIR}/slides/manifest.json`, 'utf8'));
const slideBy = Object.fromEntries(slides.map((s) => [s.sku, s]));

const rub = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 34) => (s && s.length > n ? esc(s.slice(0, n - 1)) + '…' : esc(s || ''));
const b64 = (p) => (p && existsSync(p) ? `data:image/webp;base64,${readFileSync(p).toString('base64')}` : '');
const med = (arr) => { const a = arr.filter((x) => x > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const A_ = (href, txt) => (href ? `<a href="${esc(href)}">${txt}</a>` : txt);

const META = {
  0: { label: 'Женская', color: '#A6385A', cls: 'w' },
  1: { label: 'Мужская', color: '#34568B', cls: 'm' },
};

// ---------- SVG helpers ----------
function areaSpark(vals, color, w = 90, h = 26) {
  if (!vals.length) return '—';
  const max = Math.max(...vals, 1);
  const step = w / (vals.length - 1 || 1);
  const pts = vals.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `M0,${h} ${pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} L${w},${h} Z`;
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="spark">
    <path d="${area}" fill="${color}" opacity="0.12"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${color}"/></svg>`;
}

function funnel(a, m) {
  const news = a.news;
  const st = [
    { ic: '👁', n: 'Показы / видимость', w: 'вход', metric: `вид. ≈ ${med(news.map((c) => c.searchVisibility))}`, width: 100, tone: 'n' },
    { ic: '🖱', n: 'Клик · CTR', w: '+25%', metric: `позиция ≈ ${med(news.map((c) => c.searchPosAvg))}`, width: 80, tone: 'a' },
    { ic: '🛒', n: 'Корзина', w: '0%', metric: 'фактор убран', width: 62, tone: 'muted' },
    { ic: '📦', n: 'Заказ', w: '+25%', metric: `${med(news.map((c) => c.salesPerDay)).toFixed(1)} шт/день`, width: 46, tone: 'a' },
    { ic: '✅', n: 'Выкуп', w: '+50%', metric: `≈ ${a.niche.medianBuyout}%`, width: 32, tone: 'good' },
  ];
  return `<div class="funnel">${st.map((s) => `
    <div class="fstage tone-${s.tone}" style="--fw:${s.width}%;--fc:${m.color}">
      <div class="fbar"><span>${s.ic}</span><b>${s.n}</b><i>${s.w}</i></div><div class="fm">${esc(s.metric)}</div></div>`).join('')}</div>`;
}

function benchmark(a, m) {
  const b = a.benchmark, nb = a.newsBenchmark || {};
  const rows = [['Фото', b.pics, nb.pics, ''], ['Видео %', b.hasVideoShare, nb.hasVideoShare, '%'], ['SEO-слов', b.searchWords, nb.searchWords, ''], ['Отзывов', b.comments, nb.comments, '']];
  return `<div class="bench">${rows.map(([k, top, nw, u]) => {
    const max = Math.max(top, nw, 1);
    return `<div class="brow"><span class="bk">${k}</span>
      <div class="bb"><i style="width:${(top / max) * 100}%;background:#B9B4AC"></i><em>${rub(top)}${u}</em></div>
      <div class="bb"><i style="width:${(nw / max) * 100}%;background:${m.color}"></i><em>${rub(nw)}${u}</em></div></div>`;
  }).join('')}</div>`;
}

function segments(a, m) {
  const segs = a.competition.segments, max = Math.max(...segs.map((s) => s.revenue), 1);
  return `<div class="segs">${segs.map((s) => `
    <div class="seg"><div class="segbar" style="height:${Math.max(4, (s.revenue / max) * 70)}px;background:${m.color}"></div>
      <div class="segrev">${(s.revenue / 1e6).toFixed(1)}М</div><div class="seglbl">${rub(s.from)}–${rub(s.to)}</div><div class="segn">${s.cards} шт</div></div>`).join('')}</div>`;
}

function sellers(a, m) {
  return `<div class="sellers">${a.competition.topSellers.slice(0, 5).map((s) => {
    const share = a.niche.revenue ? (s.revenue / a.niche.revenue) * 100 : 0;
    return `<div class="srow"><span>${A_(s.url, short(s.key, 26))}</span>
      <div class="sbar"><i style="width:${Math.min(100, share * 4)}%;background:${m.color}"></i></div><em>${share.toFixed(1)}%</em></div>`;
  }).join('')}</div>`;
}

function newsTable(a, m) {
  const rows = a.news.filter((c) => c.sales > 0).slice(0, 8);
  const trajBy = Object.fromEntries((a.trajectories || []).map((t) => [t.sku, t.daily || []]));
  return `<table class="nt"><thead><tr>
    <th>SKU / название</th><th>бренд</th><th>вышла</th><th class="r">цена</th><th class="r">продаж</th><th class="r">выручка</th><th>динамика</th></tr></thead><tbody>
    ${rows.map((c) => {
      const daily = (trajBy[c.sku] || []).map((d) => d.sales);
      return `<tr>
        <td>${A_(c.cardUrl, `<b>${c.sku}</b>`)}<div class="nn">${short(c.name, 28)}</div></td>
        <td>${A_(c.sellerUrl || c.brandUrl, short(c.brand || '—', 12))}</td>
        <td class="mono">${esc(c.firstDate.slice(5))}</td>
        <td class="r mono">${rub(c.price)}</td><td class="r mono">${rub(c.sales)}</td><td class="r mono">${rub(c.revenue)}</td>
        <td>${daily.length ? areaSpark(daily, m.color) : '—'}</td></tr>`;
    }).join('')}</tbody></table>`;
}

// ---------- обложки-вердикты (только по просмотренным карточкам после фильтра) ----------
const VERDICTS = {
  1095824553: ['Флэтлей + текст «TREND 2027»', 'На рекламе, лидер жен. новинок. НО заполнено 2 характеристики — слабая органическая база.', 'warn'],
  1128812446: ['Стрит-стайл / UGC', 'Кадр без головы, образ с сумкой, беж-клетка. Pinterest-эстетика, оверсайз (=длинный рукав).', 'a'],
  993491957: ['Осенний lifestyle', 'Тёплая красно-коричневая фланель, зрелый модель, парк. Точное осень/зима-позиционирование.', 'good'],
  1073678723: ['Премиум-editorial', 'Серия «классическая» (1073678721–24, один продавец): яхта + Кремль, фланель. Сильный контент при ~1100 ₽.', 'good'],
};
function verdictGallery(items) {
  return `<div class="gal">${items.map((it) => {
    const s = slideBy[it.sku]; if (!s) return '';
    const v = VERDICTS[it.sku] || ['', '', 'n'];
    return `<figure class="card tone-${v[2]}"><img src="${b64(s.heroFile)}" alt=""/>
      <figcaption><div class="ctag">${esc(v[0])}</div>
      <div class="cmeta">${A_(it.cardUrl, `<b>${it.sku}</b>`)} · ${rub(it.price)} ₽ · ${rub(it.sales)} шт · фото ${s.photoCount ?? '—'}</div>
      <p>${esc(v[1])}</p></figcaption></figure>`;
  }).join('')}</div>`;
}

// ---------- ЛЕНТА 10 СЛАЙДОВ на новинку ----------
function stripRow(sku, m) {
  const s = slideBy[sku]; if (!s || !s.stripFiles?.length) return '';
  const thumbs = s.stripFiles.slice(0, 10).map((p, i) =>
    `<div class="th"><img src="${b64(p)}" alt=""/><span>${i + 1}</span></div>`).join('');
  const cls = `${s.cls?.sleeve === 'long' ? 'длин.рукав' : s.cls?.sleeve === 'short' ? 'кор.рукав' : 'оверсайз'}`;
  return `<div class="striprow">
    <div class="striphd">
      <div class="stitle">${A_(s.cardUrl, `<b>${s.sku}</b>`)} · ${short(s.name, 30)}</div>
      <div class="smeta">${A_(s.sellerUrl, esc(short(s.brand || '—', 16)))} · ${rub(s.price)} ₽ · ${rub(s.sales)} шт · ${cls} · слайдов ${s.photoCount ?? s.stripFiles.length}</div>
    </div>
    <div class="strip">${thumbs}</div>
  </div>`;
}

// ---------- сборка ----------
function kpis(a, m) {
  return `<div class="kpis">
    <div class="kpi"><div class="kv" style="color:${m.color}">${a.counts.news}</div><div class="kl">новинок · ${a.counts.newsWithSales} с прод.</div></div>
    <div class="kpi"><div class="kv" style="color:${m.color}">${a.newsShare.revenuePct}%</div><div class="kl">доля выручки ниши</div></div>
    <div class="kpi"><div class="kv" style="color:${m.color}">${rub(a.niche.medianPrice)}</div><div class="kl">медианная цена, ₽</div></div>
    <div class="kpi"><div class="kv" style="color:${m.color}">${a.counts.fetched}/${a.counts.fetchedRaw}</div><div class="kl">после фильтра</div></div>
  </div>`;
}

const AA = data.map((a, i) => ({ a, m: META[i] }));

const page1 = `
<section class="page">
  <header class="cover">
    <div class="eyebrow">MPStats · Wildberries · снимок ${esc(data[0].period.d2)} · окно 60 дней</div>
    <h1>Новинки: <span class="hl">«рубашка в клетку»</span></h1>
    <div class="filterbar">🧣 Фильтр: <b>длинный рукав · осень / зима</b> — короткий рукав и «летние» карточки убраны (классификация по названию)</div>
    <p class="lead">Карточки, вышедшие на WB за 2 месяца по двум запросам, после фильтра. Продажи · листинг · воронка · 10 слайдов на новинку · конкуренты. Все артикулы и бренды кликабельны.</p>
  </header>
  ${AA.map(({ a, m }) => `
  <div class="qcard ${m.cls}">
    <div class="qtitle"><span class="qdot" style="background:${m.color}"></span>«${esc(a.query)}»</div>
    ${kpis(a, m)}
    <div class="qfoot">Выручка новинок за 60 дн.: <b>${rub(a.newsShare.revenue)} ₽</b> из ${rub(a.niche.revenue)} ₽ · продавцов ${a.niche.sellers} · медианный выкуп ${a.niche.medianBuyout}%</div>
  </div>`).join('')}
  <div class="takeaways">
    <div class="tk"><div class="tki">🍂</div><div><b>Сезон впереди.</b> В сегменте «длинный рукав · осень/зима» доля новинок пока мала (жен. ${data[0].newsShare.revenuePct}%, муж. ${data[1].newsShare.revenuePct}%): в июле осенний спрос ещё не раскрылся — <b>окно для входа сейчас</b>, до пика.</div></div>
    <div class="tk"><div class="tki">👗</div><div><b>Женские — оверсайз.</b> Все ${data[0].counts.news} новинок — оверсайз (=длинный рукав); лидер 1095824553 (MONSAMI) на рекламе, но с 2 характеристиками — слабая органика, догоняемо.</div></div>
    <div class="tk"><div class="tki">🧵</div><div><b>Мужские — фланель + editorial.</b> Заходит серия «классическая с длинным рукавом» (один продавец, 1073678721–24) с премиум-съёмкой при цене ~1100 ₽ — контент выше цены.</div></div>
  </div>
</section>`;

const funnelPages = AA.map(({ a, m }) => `
<section class="page">
  <h2 class="ph"><span class="qdot" style="background:${m.color}"></span>${m.label} · воронка и продажи</h2>
  <div class="grid2">
    <div class="panel"><div class="pt">Визуальная воронка · модель ранжирования WB</div>${funnel(a, m)}
      <p class="note">Вклад в органику (KB 01): клик <b>+25%</b>, корзина <b>0%</b>, заказ <b>+25%</b>, <b style="color:#2E7D5B">выкуп +50%</b>. Медиана по новинкам.</p></div>
    <div class="panel"><div class="pt">Листинг: планка топ-20 (серый) vs новинки (цвет)</div>${benchmark(a, m)}
      <div class="pt" style="margin-top:12px">Ценовые сегменты · выручка</div>${segments(a, m)}</div>
  </div>
  <div class="panel"><div class="pt">Продажи новинок за 60 дней · динамика по дням</div>${newsTable(a, m)}</div>
  <div class="panel"><div class="pt">Конкуренция · доля продавцов (ссылки на витрины)</div>${sellers(a, m)}</div>
</section>`).join('');

const galleryPage = `
<section class="page">
  <h2 class="ph">Обложки-лидеры · драйвер CTR (разбор)</h2>
  <p class="sub">Первый слайд решает клик. Четыре характерные обложки новинок после фильтра — с вердиктом.</p>
  ${verdictGallery([data[0].news.find((c) => c.sku === 1095824553), data[0].news.find((c) => c.sku === 1128812446), data[1].news.find((c) => c.sku === 993491957), data[1].news.find((c) => c.sku === 1073678723)].filter(Boolean))}
  <div class="legend"><span><i class="lg good"></i>сильная обложка</span><span><i class="lg a"></i>рабочая / нишевая</span><span><i class="lg warn"></i>есть пробел</span></div>
</section>`;

const stripPages = AA.map(({ a, m }) => {
  const skus = a.news.filter((c) => c.sales > 0 && slideBy[c.sku]?.stripFiles?.length).map((c) => c.sku);
  return `
<section class="page">
  <h2 class="ph"><span class="qdot" style="background:${m.color}"></span>${m.label} · первые 10 слайдов новинок</h2>
  <p class="sub">Полная визуальная воронка каждой новинки: слайды 1–10 (обложка → инфографика → детали → образы). Артикул кликабелен.</p>
  ${skus.map((sku) => stripRow(sku, m)).join('')}
</section>`;
}).join('');

const foot = `
<section class="page">
  <footer class="foot">
    <div class="fh">Оговорки и метод</div>
    <p>Данные MPStats — оценочные (восстановление по остаткам/выкупам), для сравнения и ранжирования, не бухгалтерия. «Ниша» = топ-100 выдачи по запросу, после фильтра «длинный рукав · осень/зима» (классификация по названию карточки — card.json «Сезон/Рукав» WB не отдаёт). Выкуп % — оценка на уровне ниши. Корзина / конверсия по слайду / принадлежность — не в этом API (слой Wildbox/Gem). Веса воронки — KB 01, не официальная формула WB. Слайды — публичные карточки WB (basket CDN), миниатюры c246×328.</p>
    <div class="fh">Ссылки</div>
    <p>Каждый артикул → <span class="mono">wildberries.ru/catalog/{sku}/detail.aspx</span> · каждый бренд/продавец → витрина <span class="mono">wildberries.ru/seller/{supplierId}</span>. Полный отчёт, данные и слайды: <span class="mono">reports/new-products/${esc(data[0].period.d2.slice(0, 4))}-07-14/</span>.</p>
  </footer>
</section>`;

const css = readFileSync('pdf-style.css', 'utf8');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Новинки WB — рубашка в клетку (длинный рукав, осень/зима)</title><style>${css}</style></head>
<body>${page1}${funnelPages}${galleryPage}${stripPages}${foot}</body></html>`;
writeFileSync(`${DIR}/report.html`, html);
console.log('report.html:', (html.length / 1024).toFixed(0), 'KB');
