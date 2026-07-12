// scripts/brand-top20.mjs — максимально короткий отчёт: ТОП-20 брендов ниши по фразе.
// Метод: MPStats «Товары по поисковой фразе». Период — за месяц (30 дней).
// Колонки: бренд, выручка за месяц, доля в нише, продажи (шт), число артикулов бренда по фразе.

import { writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchSearchResults } from '../lib/mpstats.js';

const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const rub = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('ru-RU'));
const pct = (n) => `${n.toFixed(1)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Агрегат по брендам за 30 дней: выручка, продажи, число артикулов; доля в нише — по выручке.
async function brandsForPhrase(query, target, days = 30) {
  const d2 = iso(Date.now() - day);
  const d1 = iso(Date.now() - (days + 1) * day);
  const { rows, total } = await fetchSearchResults(query, { d1, d2, pageSize: 100 });

  const byBrand = new Map();
  let nicheRev = 0, nicheSales = 0;
  for (const r of rows) {
    const brand = r.brand || '—';
    const sales = num(r.sales), revenue = num(r.revenue);
    nicheRev += revenue; nicheSales += sales;
    const b = byBrand.get(brand) || { brand, revenue: 0, sales: 0, items: 0 };
    b.revenue += revenue; b.sales += sales; b.items += 1;
    byBrand.set(brand, b);
  }
  const ranked = [...byBrand.values()]
    .map((b) => ({ ...b, shareRev: nicheRev ? (100 * b.revenue) / nicheRev : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  return { query, target, days, d1, d2, total, nicheRev, nicheSales,
    totalBrands: byBrand.size, top: ranked.slice(0, 20) };
}

const isTarget = (brand, target) => String(brand || '').toUpperCase().includes(target.toUpperCase());

function table(a) {
  const rows = a.top.map((b, i) => {
    const mine = isTarget(b.brand, a.target);
    return `<tr class="${mine ? 'mine' : ''}">
      <td class="num">${i + 1}</td>
      <td>${esc(b.brand)}${mine ? ' <span class="tag">ваш</span>' : ''}</td>
      <td class="num money">${rub(b.revenue)}</td>
      <td class="num">${pct(b.shareRev)}</td>
      <td class="num">${rub(b.sales)}</td>
      <td class="num">${b.items}</td>
    </tr>`;
  }).join('\n');
  return `<section class="blk">
    <h2>«<span class="phrase">${esc(a.query)}</span>» <span class="muted">· ТОП-20 брендов · за месяц (${a.d1} … ${a.d2})</span></h2>
    <table><thead><tr>
      <th>#</th><th>Бренд</th><th>Выручка за месяц ₽</th><th>Доля в нише</th><th>Продажи, шт</th><th>Артикулов по фразе</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="muted note">Ниша (вся выдача по фразе): <b>${rub(a.nicheRev)} ₽</b> · <b>${rub(a.nicheSales)}</b> шт · ${a.total} карточек · ${a.totalBrands} брендов. Доля в нише — по выручке.</div>
  </section>`;
}

function buildHtml(blocks, date) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ТОП-20 брендов ниши · MPStats</title>
<style>
  :root{ color-scheme:light dark; --line:rgba(128,128,128,.22); }
  *{ box-sizing:border-box; }
  body{ font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:22px; background:#f6f7f9; color:#1a1a1a; }
  @media (prefers-color-scheme:dark){ body{ background:#141414; color:#e8e8e8 } th{ background:#242424!important } tr.mine td{ background:#123d1e!important } }
  h1{ font-size:18px; margin:0 0 2px; }
  h2{ font-size:14px; margin:20px 0 6px; font-weight:600; }
  .sub{ color:#777; margin-bottom:6px; font-size:12px; }
  .muted{ color:#888; font-weight:400; }
  .phrase{ font-size:1.2em; font-weight:800; color:#c026d3; }
  @media (prefers-color-scheme:dark){ .phrase{ color:#e879f9 } }
  table{ border-collapse:collapse; width:100%; font-size:12.5px; margin:2px 0 4px; }
  th,td{ padding:5px 8px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
  th{ background:#eef0f2; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
  td.num{ text-align:right; font-variant-numeric:tabular-nums; }
  td.money{ font-weight:600; }
  tr.mine td{ background:#bfe6c9; font-weight:600; }
  .tag{ display:inline-block; padding:0 6px; border-radius:8px; font-size:10px; font-weight:700; background:#cbeed4; color:#155c31; }
  .note{ font-size:11px; margin-bottom:8px; }
  @page{ size:A4; margin:10mm 9mm; }
  @media print{
    body{ background:#fff; color:#111; padding:0; font-size:10px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    h1{ font-size:15px; } h2{ font-size:12px; margin:12px 0 5px; }
    table{ font-size:9.5px; } th,td{ padding:3px 6px; }
    thead{ display:table-header-group; } tr,thead,.blk{ break-inside:avoid; page-break-inside:avoid; }
    h2{ break-after:avoid; page-break-after:avoid; }
    .blk + .blk{ break-before:page; page-break-before:always; }  /* мужская фраза — с новой страницы */
    a{ color:#111; }
  }
</style></head><body>
<h1>ТОП-20 брендов ниши по фразе</h1>
<div class="sub">Источник: <b>MPStats</b> · метод «Товары по поисковой фразе» · период — за месяц (30 дней) · сформировано ${esc(date)}</div>
${blocks.join('\n')}
</body></html>`;
}

async function renderPdf(htmlPath, pdfPath) {
  const { chromium } = await import('playwright');
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    .concat([chromium.executablePath()]).find((p) => p && existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '9mm', right: '9mm' } });
  } finally { await browser.close(); }
}

// ── main ──
const targets = [
  { target: 'AIDEMIKO', query: 'Рубашка муслиновая женская' },
  { target: 'AIZEK', query: 'Рубашка муслиновая мужская' },
];
const outDir = process.argv[2] || 'reports-output';

const blocks = [];
for (const t of targets) {
  process.stderr.write(`→ ${t.target} / «${t.query}» …\n`);
  const a = await brandsForPhrase(t.query, t.target, 30);
  blocks.push(table(a));
  const yourRank = a.top.findIndex((b) => isTarget(b.brand, t.target)) + 1;
  const you = a.top.find((b) => isTarget(b.brand, t.target));
  console.log(`${t.target}: ранг ${yourRank || '>20'} · выручка ${rub(you?.revenue)} ₽ · доля ${pct(you?.shareRev || 0)} · ${you?.sales || 0} шт · ${you?.items || 0} арт.`);
}

const html = buildHtml(blocks, iso(Date.now()));
const htmlOut = `${outDir}/top20-brands.html`;
writeFileSync(htmlOut, html);
const pdfOut = `${outDir}/top20-brands.pdf`;
await renderPdf(htmlOut, pdfOut);
process.stderr.write(`✓ ${htmlOut}\n✓ ${pdfOut}\n`);
