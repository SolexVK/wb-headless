// build-sellers-pdf.mjs — компактный PDF: топ-10 продавцов, топ-10 артикулов,
// новинки топ-продавцов за 2 месяца (с инфографикой запусков).
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'reports/sellers/2026-07-14';
const data = JSON.parse(readFileSync(`${DIR}/data.json`, 'utf8'));
const rub = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s, n = 30) => (s && s.length > n ? esc(s.slice(0, n - 1)) + '…' : esc(s || ''));
const A_ = (href, txt) => (href ? `<a href="${esc(href)}">${txt}</a>` : txt);
const clsTag = (c) => `${c.sleeve === 'long' ? 'длин.' : c.sleeve === 'short' ? 'кор.' : '—'}/${c.season === 'winter' ? 'ос-зима' : c.season === 'summer' ? 'лето' : '—'}`;
const META = { 0: { label: 'Женская', color: '#A6385A', cls: 'w' }, 1: { label: 'Мужская', color: '#34568B', cls: 'm' } };

// инфографика: новинки по продавцам (клетка + прочее)
function launchBars(a, m) {
  const rows = a.sellerNews.map((s) => ({ name: s.seller, url: s.url, plaid: s.newPlaidCount, other: s.newCount - s.newPlaidCount, total: s.newCount }));
  const max = Math.max(...rows.map((r) => r.total), 1);
  return `<div class="launch">${rows.map((r) => `
    <div class="lrw ${r.total ? '' : 'zero'}">
      <span class="ln">${A_(r.url, short(r.name, 20))}</span>
      <div class="lbarwrap">
        <i class="plaid" style="width:${(r.plaid / max) * 100}%"></i>
        <i class="other" style="width:${(r.other / max) * 100}%"></i>
      </div>
      <em>${r.total || '—'}</em>
    </div>`).join('')}</div>
    <div class="blegend"><span><i style="background:${m.color}"></i>в клетку</span><span><i style="background:#C9C3BA"></i>прочие рубашки</span></div>`;
}

function sellersTable(a) {
  return `<table class="wt"><thead><tr>
    <th>#</th><th>Продавец (витрина)</th><th>Бренд</th><th class="r">в топе</th><th class="r">выручка ₽</th><th class="r">доля</th><th class="r">рубашек</th><th class="r">новинок (клетка)</th></tr></thead><tbody>
    ${a.topSellers.map((s, i) => {
      const sn = a.sellerNews[i];
      const pill = sn.newCount ? `<span class="newpill">${sn.newCount} (${sn.newPlaidCount})</span>` : `<span class="zeropill">0</span>`;
      return `<tr><td class="r">${i + 1}</td><td>${A_(s.url, short(s.seller, 24))}</td><td>${short(s.brand || '—', 14)}</td>
        <td class="r">${s.cardsInTop}</td><td class="r">${rub(s.revenue)}</td><td class="r">${s.sharePct}%</td>
        <td class="r">${sn.totalShirtsInCategory ?? '—'}</td><td class="r">${pill}</td></tr>`;
    }).join('')}</tbody></table>`;
}

function articlesTable(a) {
  return `<table class="wt"><thead><tr>
    <th>#</th><th>SKU / название</th><th>продавец</th><th class="r">цена</th><th class="r">продаж</th><th class="r">выручка ₽</th><th>вышла</th></tr></thead><tbody>
    ${a.topArticles.map((c) => `<tr>
      <td class="r">${c.rank}</td>
      <td>${A_(c.cardUrl, `<b>${c.sku}</b>`)}<div class="nn">${short(c.name, 26)}</div></td>
      <td>${A_(c.sellerUrl, short(c.seller, 16))}</td>
      <td class="r">${rub(c.price)}</td><td class="r">${rub(c.sales)}</td><td class="r">${rub(c.revenue)}</td>
      <td>${c.firstDate && c.firstDate >= a.cutoff ? '🆕 ' : ''}${esc(c.firstDate || '—')}</td></tr>`).join('')}</tbody></table>`;
}

// таблица «в клетку» новинок топ-продавцов (релевантно нише)
function plaidNewTable(a) {
  const rows = [];
  for (const s of a.sellerNews) for (const c of s.news) if (c.isPlaid) rows.push({ ...c, seller: s.seller, url: s.url });
  rows.sort((x, y) => y.revenue - x.revenue);
  if (!rows.length) return '<p class="note">За период топ-10 не завели новинок «в клетку» — клетка это осень/зима, запуски ещё впереди.</p>';
  return `<table class="wt"><thead><tr>
    <th>SKU / название</th><th>продавец</th><th>вышла</th><th>рукав/сезон</th><th class="r">цена</th><th class="r">продаж</th><th class="r">выручка ₽</th></tr></thead><tbody>
    ${rows.map((c) => `<tr>
      <td>${A_(c.cardUrl, `<b>${c.sku}</b>`)}<div class="nn">${short(c.name, 28)}</div></td>
      <td>${A_(c.url, short(c.seller, 16))}</td><td>${esc(c.firstDate)}</td><td>${clsTag(c.cls)}</td>
      <td class="r">${rub(c.price)}</td><td class="r">${rub(c.sales)}</td><td class="r">${rub(c.revenue)}</td></tr>`).join('')}</tbody></table>`;
}

const AA = data.map((a, i) => ({ a, m: META[i] }));

const cover = `
<section class="page">
  <header class="cover">
    <div class="eyebrow">MPStats · Wildberries · снимок ${esc(data[0].period.d2)} · окно новинок 60 дней</div>
    <h1>Топ-продавцы и их <span class="hl">новинки</span></h1>
    <p class="lead">По запросам «рубашка в клетку женская / мужская»: топ-10 продавцов, топ-10 артикулов и всё, что топ-10 продавцов <b>завели на WB за 2 месяца</b> (из полной категории рубашек — ловим новинки до попадания в топ). Артикулы и продавцы кликабельны.</p>
  </header>
  ${AA.map(({ a, m }) => `
  <div class="qcard ${m.cls}">
    <div class="qtitle"><span class="qdot" style="background:${m.color}"></span>«${esc(a.query)}»</div>
    <div class="kpis">
      <div class="kpi"><div class="kv" style="color:${m.color}">${a.totals.newProducts}</div><div class="kl">новинок у топ-10</div></div>
      <div class="kpi"><div class="kv" style="color:${m.color}">${a.totals.newPlaid}</div><div class="kl">из них «в клетку»</div></div>
      <div class="kpi"><div class="kv" style="color:${m.color}">${rub(a.totals.newRevenue)}</div><div class="kl">выручка новинок, ₽</div></div>
      <div class="kpi"><div class="kv" style="color:${m.color}">${a.sellerNews.filter((s) => s.newCount === 0).length}</div><div class="kl">топов без новинок</div></div>
    </div>
  </div>`).join('')}
  <div class="takeaways">
    <div class="tk"><div class="tki">🧭</div><div><b>Клетку сейчас почти не заводят.</b> Из ${data[0].totals.newProducts + data[1].totals.newProducts} новинок топ-продавцов лишь ${data[0].totals.newPlaid + data[1].totals.newPlaid} — «в клетку». Клетка = осень/зима, массовые запуски ещё впереди → окно для входа до пика.</div></div>
    <div class="tk"><div class="tki">🏭</div><div><b>Мужской рынок активнее.</b> ООО Твое завёл 23 новинки, ИП Никитко — 13 (премиум-полоска), Alvybrand — 6 (лён). Но в клетку — единицы: крупные тестируют полоску/лён/однотон.</div></div>
    <div class="tk"><div class="tki">🛡️</div><div><b>Половина топов «спит».</b> Многие лидеры (Ниидл, Жумакадыров, Веселовская, Третьяков, Чубаков…) за 2 месяца не завели ни одной новой рубашки — держат позиции старыми хитами.</div></div>
  </div>
</section>`;

const launchPages = AA.map(({ a, m }) => `
<section class="page">
  <h2 class="ph"><span class="qdot" style="background:${m.color}"></span>${m.label} · кто сколько завёл новинок</h2>
  <div class="panel"><div class="pt">Новинки топ-10 продавцов за 60 дней (категория рубашек)</div>${launchBars(a, m)}</div>
  <div class="panel"><div class="pt">Топ-10 продавцов по выручке в выдаче запроса</div>${sellersTable(a)}</div>
  <div class="panel"><div class="pt">Топ-10 артикулов по выручке</div>${articlesTable(a)}</div>
</section>`).join('');

const plaidPage = `
<section class="page">
  <h2 class="ph">Новинки «в клетку» топ-продавцов · крупным планом</h2>
  <p class="sub">Только карточки в клетку (релевантно нише), заведённые топ-10 продавцами за 2 месяца — отсортированы по выручке. Клик — на карточку/витрину.</p>
  ${AA.map(({ a, m }) => `<div class="panel"><div class="pt"><span class="qdot" style="background:${m.color};width:8px;height:8px;border-radius:2px;display:inline-block"></span> ${m.label}</div>${plaidNewTable(a)}</div>`).join('')}
  <footer class="foot">
    <div class="fh">Метод и ссылки</div>
    <p>Топ-10 продавцов/артикулов — из топ-100 выдачи MPStats по запросу (выручка за 60 дн.). Новинки продавца — из базовой категории рубашек (<span class="mono">${esc(data[0].categoryPath)}</span> / <span class="mono">${esc(data[1].categoryPath)}</span>) с фильтром по <span class="mono">supplier_id</span>, отбор по дате появления ≥ ${esc(data[0].cutoff)}. Данные MPStats — оценочные. «Выручка в выдаче» и «выручка новинок» — разные базы. Артикул → <span class="mono">catalog/{sku}/detail.aspx</span>, продавец → <span class="mono">seller/{supplierId}</span>.</p>
  </footer>
</section>`;

const css = readFileSync('pdf-style.css', 'utf8');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Топ-продавцы и новинки — рубашка в клетку</title><style>${css}</style></head>
<body>${cover}${launchPages}${plaidPage}</body></html>`;
writeFileSync(`${DIR}/report.html`, html);
console.log('report.html:', (html.length / 1024).toFixed(0), 'KB');
