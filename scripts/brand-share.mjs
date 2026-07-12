// scripts/brand-share.mjs — доля продаж бренда от всего рынка по поисковой фразе (MPStats).
// «Рынок» = вся поисковая выдача WB по фразе за период (MPStats, потолок ~100 карточек).
// Считаем долю бренда в штуках и в выручке, ранг бренда, ТОП рынка и ТОП артикулов бренда.
// Периоды: 30 и 90 дней. Выход — самодостаточный HTML-отчёт.

import { writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchSearchResults } from '../lib/mpstats.js';

// Печать HTML → PDF (A4) через Chromium (Playwright). Возвращает путь к PDF.
async function renderPdf(htmlPath, pdfPath) {
  const { chromium } = await import('playwright');
  // На этом контейнере установлен chromium-1194; executablePath() по умолчанию
  // может указывать на другую ревизию — подставляем реальный бинарь, если есть.
  const candidates = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', chromium.executablePath()];
  const exe = candidates.find((p) => p && existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '9mm', right: '9mm' } });
  } finally {
    await browser.close();
  }
  return pdfPath;
}

const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const rub = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('ru-RU'));
const pct = (n) => `${n.toFixed(1)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Периоды: d2 = вчера (эндпоинт не принимает сегодня), d1 = d2 - (days-1) → ровно `days` дней.
function period(days) {
  const d2 = iso(Date.now() - day);
  const d1 = iso(Date.now() - (days + 1) * day);
  return { d1, d2, days };
}

const hasBrand = (row, needle) => String(row.brand || '').toUpperCase().includes(needle.toUpperCase());

// Собирает полную аналитику по (фраза, бренд, период).
async function analyze(query, brand, days) {
  const p = period(days);
  const { rows, total } = await fetchSearchResults(query, { d1: p.d1, d2: p.d2, pageSize: 100 });

  const items = rows.map((r) => ({
    nmId: String(r.id ?? r.nmId ?? ''),
    brand: r.brand || '—',
    name: r.name || '',
    color: r.color || '',
    sales: num(r.sales),
    revenue: num(r.revenue),
    price: num(r.final_price_average ?? r.final_price),
    rating: num(r.rating),
    reviews: num(r.comments ?? r.reviews),
    position: num(r.position),
  }));

  const marketSales = items.reduce((s, r) => s + r.sales, 0);
  const marketRev = items.reduce((s, r) => s + r.revenue, 0);
  const marketCount = items.length;

  // Агрегат по брендам → ранг нашего бренда.
  const byBrand = new Map();
  for (const r of items) {
    const b = byBrand.get(r.brand) || { brand: r.brand, sales: 0, revenue: 0, count: 0 };
    b.sales += r.sales; b.revenue += r.revenue; b.count += 1;
    byBrand.set(r.brand, b);
  }
  const brandRank = [...byBrand.values()].sort((a, b) => b.sales - a.sales);
  const rankBySales = brandRank.findIndex((b) => b.brand.toUpperCase().includes(brand.toUpperCase())) + 1;
  const brandRankRev = [...byBrand.values()].sort((a, b) => b.revenue - a.revenue);
  const rankByRev = brandRankRev.findIndex((b) => b.brand.toUpperCase().includes(brand.toUpperCase())) + 1;

  const brandItems = items.filter((r) => hasBrand(r, brand)).sort((a, b) => b.revenue - a.revenue);
  const brandSales = brandItems.reduce((s, r) => s + r.sales, 0);
  const brandRev = brandItems.reduce((s, r) => s + r.revenue, 0);
  const brandAvgPrice = brandSales ? brandRev / brandSales : 0;

  const marketTop = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  return {
    query, brand, days, period: p, total, marketCount,
    marketSales, marketRev,
    brandCount: brandItems.length,
    brandSales, brandRev, brandAvgPrice,
    shareSales: marketSales ? (100 * brandSales) / marketSales : 0,
    shareRev: marketRev ? (100 * brandRev) / marketRev : 0,
    rankBySales, rankByRev, totalBrands: byBrand.size,
    marketTop, brandItems,
    topBrands: brandRank.slice(0, 5),
  };
}

// ── HTML-рендер ───────────────────────────────────────────────────────────────
const wbUrl = (nm) => `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;

function overviewCard(a) {
  return `<div class="ov">
    <div class="ov-h">Период: <b>${a.days} дней</b> <span class="muted">(${a.period.d1} … ${a.period.d2})</span></div>
    <div class="kpis">
      <div class="kpi big"><div class="kv">${pct(a.shareSales)}</div><div class="kl">доля рынка<br>в штуках</div></div>
      <div class="kpi big"><div class="kv">${pct(a.shareRev)}</div><div class="kl">доля рынка<br>в выручке</div></div>
      <div class="kpi"><div class="kv">${rub(a.brandSales)}</div><div class="kl">продажи бренда, шт</div></div>
      <div class="kpi"><div class="kv">${rub(a.brandRev)} ₽</div><div class="kl">выручка бренда</div></div>
      <div class="kpi"><div class="kv">${a.brandCount}</div><div class="kl">карточек бренда в выдаче</div></div>
      <div class="kpi"><div class="kv">${rub(a.brandAvgPrice)} ₽</div><div class="kl">ср. цена продажи</div></div>
      <div class="kpi"><div class="kv">#${a.rankBySales}<span class="of">/${a.totalBrands}</span></div><div class="kl">ранг бренда<br>(по штукам)</div></div>
      <div class="kpi"><div class="kv">#${a.rankByRev}<span class="of">/${a.totalBrands}</span></div><div class="kl">ранг бренда<br>(по выручке)</div></div>
    </div>
    <div class="ctx muted">Рынок фразы за период: <b>${rub(a.marketSales)}</b> шт · <b>${rub(a.marketRev)} ₽</b> · ${a.marketCount} карточек в выдаче (всего по фразе ${a.total}).</div>
  </div>`;
}

function marketTopTable(a) {
  const rows = a.marketTop.map((r, i) => {
    const mine = hasBrand(r, a.brand);
    return `<tr class="${mine ? 'mine' : ''}">
      <td class="num">${i + 1}</td>
      <td><a href="${wbUrl(r.nmId)}" target="_blank" rel="noopener">${esc(r.nmId)}</a></td>
      <td>${esc(r.brand)}${mine ? ' <span class="tag">бренд</span>' : ''}</td>
      <td class="name">${esc(r.name)}</td>
      <td class="num money">${rub(r.revenue)}</td>
      <td class="num money">${rub(r.sales)}</td>
      <td class="num">${rub(r.price)}</td>
    </tr>`;
  }).join('\n');
  return `<table><thead><tr>
      <th>#</th><th>Артикул</th><th>Бренд</th><th>Название</th><th>Выручка ₽</th><th>Продажи, шт</th><th>Ср. цена</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function brandTopTable(a) {
  if (!a.brandItems.length) return '<p class="muted">Карточек бренда в выдаче не найдено.</p>';
  const rows = a.brandItems.slice(0, 15).map((r, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><a href="${wbUrl(r.nmId)}" target="_blank" rel="noopener">${esc(r.nmId)}</a></td>
      <td class="name">${esc(r.name)}</td>
      <td>${esc(r.color || '—')}</td>
      <td class="num money">${rub(r.revenue)}</td>
      <td class="num money">${rub(r.sales)}</td>
      <td class="num">${rub(r.price)}</td>
      <td class="num">${a.marketRev ? pct(100 * r.revenue / a.marketRev) : '—'}</td>
    </tr>`).join('\n');
  return `<table><thead><tr>
      <th>#</th><th>Артикул</th><th>Название</th><th>Цвет</th><th>Выручка ₽</th><th>Продажи, шт</th><th>Ср. цена</th><th>Доля рынка (выручка)</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

// Полный блок за один период: общая инфо → ТОП рынка → артикулы бренда.
function periodBlock(a) {
  return `<section class="period">
    <h3>Общая информация по бренду — ${a.days} дней</h3>
    ${overviewCard(a)}

    <h3>ТОП рынка по фразе — ${a.days} дней <span class="muted">(строки бренда подсвечены)</span></h3>
    ${marketTopTable(a)}

    <h3>Артикулы бренда с наибольшими продажами — ${a.days} дней</h3>
    ${brandTopTable(a)}
  </section>`;
}

function buildHtml(brand, query, a30, a90, meta) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(brand)} · доля рынка · MPStats</title>
<style>
  :root{ color-scheme: light dark; --line:rgba(128,128,128,.22); }
  *{ box-sizing:border-box; }
  body{ font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:28px; background:#f6f7f9; color:#1a1a1a; }
  @media (prefers-color-scheme: dark){ body{ background:#141414; color:#e8e8e8 } .ov{ background:#1e1e1e!important } th{ background:#242424!important } tr.mine td{ background:#123d1e!important } .brand{ border-color:#2a2a2a } }
  h1{ font-size:22px; margin:0 0 2px; }
  h2{ font-size:19px; margin:26px 0 6px; }
  h3{ font-size:14px; margin:20px 0 8px; text-transform:uppercase; letter-spacing:.04em; color:#666; }
  .sub{ color:#777; margin-bottom:18px; }
  .phrase{ font-size:1.25em; font-weight:800; color:#c026d3; }
  @media (prefers-color-scheme: dark){ .phrase{ color:#e879f9; } }
  .muted{ color:#888; font-weight:400; }
  .brand{ background:transparent; border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin:22px 0; }
  .brand h2 .q{ color:#888; font-size:15px; font-weight:400; }
  .ov-row{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:760px){ .ov-row{ grid-template-columns:1fr; } }
  .ov{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .ov-h{ font-size:14px; margin-bottom:12px; }
  .kpis{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px 10px; }
  @media (max-width:520px){ .kpis{ grid-template-columns:repeat(2,1fr); } }
  .kpi{ }
  .kpi .kv{ font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
  .kpi.big .kv{ font-size:26px; color:#1f6f3f; }
  @media (prefers-color-scheme: dark){ .kpi.big .kv{ color:#5fd08a } }
  .kpi .kl{ font-size:11px; color:#888; line-height:1.3; margin-top:2px; }
  .kpi .of{ font-size:13px; color:#aaa; font-weight:400; }
  .ctx{ margin-top:12px; font-size:12.5px; border-top:1px dashed var(--line); padding-top:10px; }
  table{ border-collapse:collapse; width:100%; margin:2px 0 6px; font-size:13px; }
  th,td{ padding:7px 9px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th{ background:#eef0f2; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
  td.num{ text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.money{ font-weight:600; }
  td.name{ max-width:340px; }
  tr.mine td{ background:#bfe6c9; font-weight:600; }
  .tag{ display:inline-block; padding:0 7px; border-radius:9px; font-size:10px; font-weight:700; background:#cbeed4; color:#155c31; vertical-align:middle; }
  .divider{ border:0; height:4px; background:linear-gradient(90deg,#1f6f3f,#5fd08a); border-radius:3px; margin:34px 0 26px; width:100%; }
  .period-tag{ display:inline-block; font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#1f6f3f; background:#eafaef; padding:3px 12px; border-radius:20px; margin:0 0 4px; }
  @media (prefers-color-scheme: dark){ .period-tag{ background:#173322; color:#7bdca0 } }
  a{ color:#2563eb; text-decoration:none; } a:hover{ text-decoration:underline; }
  .foot{ color:#999; font-size:12px; margin-top:26px; border-top:1px solid var(--line); padding-top:12px; }

  /* ── Печать / PDF: компактная A4-вёрстка, блоки не рвутся ── */
  @page{ size:A4; margin:10mm 9mm; }
  @media print{
    :root{ color-scheme:light; }
    body{ background:#fff; color:#111; padding:0; font-size:10.5px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    h1{ font-size:17px; margin:0 0 2px; }
    .sub{ font-size:10px; margin-bottom:8px; }
    h3{ font-size:10px; margin:8px 0 4px; }
    .period-tag{ display:block; margin:0 0 8px; padding:6px 12px; font-size:11px;
      color:#fff!important; background:#1f6f3f; border-radius:6px; letter-spacing:.06em; }
    /* убираем большие разрывы */
    .ov{ padding:8px 10px; }
    .ov-h{ margin-bottom:7px; font-size:10.5px; }
    .kpis{ gap:6px 8px; }
    .kpi .kv{ font-size:13px; } .kpi.big .kv{ font-size:17px; } .kpi .kl{ font-size:9px; }
    .ctx{ margin-top:7px; padding-top:6px; font-size:9.5px; }
    table{ font-size:9.5px; margin:1px 0 4px; }
    th,td{ padding:3px 6px; }
    td.name{ max-width:none; }
    .divider{ height:3px; margin:10px 0 8px; }
    .foot{ font-size:9px; margin-top:12px; padding-top:8px; }
    /* логика блоков: заголовок держим с таблицей/карточкой, строки не режем */
    h1,h3,.period-tag{ break-after:avoid; page-break-after:avoid; }
    .ov,tr,thead{ break-inside:avoid; page-break-inside:avoid; }
    .period{ break-inside:auto; }
    thead{ display:table-header-group; }  /* шапка повторяется при переносе таблицы */
    a{ color:#111; }
    /* Явный разрыв между периодами: 90 дней — с новой страницы */
    .divider{ display:none; }
    .p2{ break-before:page; page-break-before:always; }
  }
</style></head><body>
<h1>${esc(brand)} — доля продаж от всего рынка</h1>
<div class="sub">Поисковая фраза: <span class="phrase">«${esc(query)}»</span> · источник: <b>MPStats</b> · метод «Товары по поисковой фразе» · сформировано ${esc(meta.date)}</div>
<div class="period-tag">Период 1 · 30 дней</div>
${periodBlock(a30)}
<hr class="divider">
<div class="p2">
<div class="period-tag">Период 2 · 90 дней</div>
${periodBlock(a90)}
</div>
<div class="foot">
  <b>Методика.</b> «Весь рынок» = вся поисковая выдача Wildberries по указанной фразе за период (MPStats
  отдаёт до ~100 карточек на фразу — это верхняя граница метода, топ-500 недостижим). Доля бренда =
  сумма по карточкам бренда ÷ сумма по всей выдаче, отдельно в штуках и в выручке. Данные MPStats —
  <b>оценочные</b> (восстановлены по остаткам/выкупам), пригодны для сравнения и ранжирования, но это
  не отчёт из кабинета продавца. Периоды: последние 30 и 90 дней (d2 = вчера).
</div>
</body></html>`;
}

// ── main ────────────────────────────────────────────────────────────────────
// Транслитерация кириллицы в латиницу — для безопасных имён файлов.
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slug = (s) => String(s).toLowerCase().split('').map((c) => (TRANSLIT[c] ?? c)).join('')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Аргументы: --out <dir> и повторяемый --target "БРЕНД|фраза".
// Без --target берём дефолтную пару (обратная совместимость).
function parseArgs(argv) {
  let outDir = 'reports-output';
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { outDir = argv[++i]; }
    else if (a === '--target') {
      const [brand, ...rest] = String(argv[++i]).split('|');
      targets.push({ brand: brand.trim(), query: rest.join('|').trim() });
    } else if (!a.startsWith('--') && outDir === 'reports-output' && !targets.length) {
      outDir = a; // позиционный первый аргумент = каталог (как раньше)
    }
  }
  if (!targets.length) {
    targets.push({ brand: 'AIDEMIKO', query: 'Рубашка муслиновая женская' });
    targets.push({ brand: 'AIZEK', query: 'Рубашка муслиновая мужская' });
  }
  return { outDir, targets };
}

const { outDir, targets } = parseArgs(process.argv.slice(2));

for (const t of targets) {
  process.stderr.write(`→ ${t.brand} / «${t.query}» …\n`);
  const a30 = await analyze(t.query, t.brand, 30);
  const a90 = await analyze(t.query, t.brand, 90);
  const html = buildHtml(t.brand, t.query, a30, a90, { date: iso(Date.now()) });
  const base = `brand-share-${slug(t.brand)}-${slug(t.query)}`;
  const out = `${outDir}/${base}.html`;
  writeFileSync(out, html);
  process.stderr.write(`  ✓ ${out}\n`);
  const pdf = `${outDir}/${base}.pdf`;
  await renderPdf(out, pdf);
  process.stderr.write(`  ✓ ${pdf}\n`);

  console.log(`\n### ${t.brand} · «${t.query}» → ${base}.pdf`);
  for (const a of [a30, a90]) {
    console.log(`  ${a.days}d: доля ${pct(a.shareSales)} шт / ${pct(a.shareRev)} выручка · ` +
      `бренд ${rub(a.brandSales)} шт, ${rub(a.brandRev)} ₽ · ${a.brandCount} карт. · ранг #${a.rankBySales}/${a.totalBrands} · ` +
      `рынок ${rub(a.marketSales)} шт / ${rub(a.marketRev)} ₽`);
  }
}
