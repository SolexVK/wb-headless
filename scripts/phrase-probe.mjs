// scripts/phrase-probe.mjs — подбор связанных фраз по муслиновым рубашкам.
// Для каждой фразы-кандидата тянет выдачу MPStats за 30 дней и оценивает ёмкость
// ниши: карточек, выручка за месяц, продажи, попадание брендов AIDEMIKO/AIZEK.

import { writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchSearchResults } from '../lib/mpstats.js';

const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const rub = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('ru-RU'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CANDIDATES = [
  // женские
  ['Рубашка муслиновая женская', 'ж'],
  ['Рубашка из муслина женская', 'ж'],
  ['Муслиновая рубашка', 'ж'],
  ['Рубашка муслин', 'ж'],
  ['Рубашка муслиновая оверсайз', 'ж'],
  ['Рубашка муслиновая летняя', 'ж'],
  ['Рубашка муслиновая с длинным рукавом', 'ж'],
  ['Рубашка муслиновая удлиненная', 'ж'],
  ['Блузка муслиновая', 'ж'],
  ['Туника муслиновая', 'ж'],
  ['Сорочка муслиновая', 'ж'],
  ['Рубашка хлопковая муслиновая', 'ж'],
  // мужские
  ['Рубашка муслиновая мужская', 'м'],
  ['Рубашка из муслина мужская', 'м'],
  ['Муслиновая рубашка мужская', 'м'],
  ['Рубашка муслиновая оверсайз мужская', 'м'],
  ['Рубашка летняя мужская муслин', 'м'],
  // общие / прочее
  ['Рубашка муслиновая детская', 'дет'],
  ['Костюм муслиновый', 'общ'],
  ['Платье муслиновое', 'общ'],
];

const has = (rows, needle) => rows.filter((r) => String(r.brand || '').toUpperCase().includes(needle)).length;

async function probe(query) {
  const d2 = iso(Date.now() - day);
  const d1 = iso(Date.now() - 31 * day);
  try {
    const { rows, total } = await fetchSearchResults(query, { d1, d2, pageSize: 100 });
    const nicheRev = rows.reduce((s, r) => s + num(r.revenue), 0);
    const nicheSales = rows.reduce((s, r) => s + num(r.sales), 0);
    const brands = new Set(rows.map((r) => r.brand || '—')).size;
    return { query, ok: true, cards: rows.length, total, nicheRev, nicheSales, brands,
      aidemiko: has(rows, 'AIDEMIKO'), aizek: has(rows, 'AIZEK') };
  } catch (e) {
    return { query, ok: false, err: String(e.message || e).slice(0, 60) };
  }
}

// ── main ──
const outDir = process.argv[2] || 'reports-output';
const results = [];
for (const [q, seg] of CANDIDATES) {
  process.stderr.write(`→ «${q}» …\n`);
  const r = await probe(q);
  results.push({ ...r, seg });
}
const good = results.filter((r) => r.ok && r.cards > 0).sort((a, b) => b.nicheRev - a.nicheRev);
const empty = results.filter((r) => !r.ok || r.cards === 0);

// консоль
console.log('\n#  выручка/мес ₽     продажи   карт  бренд.  AIDE AIZE  фраза');
good.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(2)} ${rub(r.nicheRev).padStart(15)} ${rub(r.nicheSales).padStart(9)} ` +
    `${String(r.cards).padStart(5)} ${String(r.brands).padStart(6)}  ${String(r.aidemiko).padStart(4)} ${String(r.aizek).padStart(4)}  «${r.query}» [${r.seg}]`);
});
if (empty.length) console.log('\nПусто/ошибка:', empty.map((r) => `«${r.query}»${r.ok ? '' : ' (' + r.err + ')'}`).join(', '));

// HTML + PDF
const rowsHtml = good.map((r, i) => {
  const seg = { 'ж': 'жен', 'м': 'муж', 'дет': 'дет', 'общ': 'общ' }[r.seg] || r.seg;
  return `<tr>
    <td class="num">${i + 1}</td>
    <td class="phrase">${esc(r.query)}</td>
    <td>${seg}</td>
    <td class="num money">${rub(r.nicheRev)}</td>
    <td class="num">${rub(r.nicheSales)}</td>
    <td class="num">${r.cards}</td>
    <td class="num">${r.brands}</td>
    <td class="num ${r.aidemiko ? 'hit' : ''}">${r.aidemiko || '—'}</td>
    <td class="num ${r.aizek ? 'hit' : ''}">${r.aizek || '—'}</td>
  </tr>`;
}).join('\n');

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Связанные фразы · муслиновые рубашки</title>
<style>
  :root{ color-scheme:light dark; --line:rgba(128,128,128,.22); }
  *{ box-sizing:border-box; } body{ font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:22px; background:#f6f7f9; color:#1a1a1a; }
  @media (prefers-color-scheme:dark){ body{ background:#141414; color:#e8e8e8 } th{ background:#242424!important } }
  h1{ font-size:18px; margin:0 0 2px; } .sub{ color:#777; font-size:12px; margin-bottom:12px; }
  table{ border-collapse:collapse; width:100%; font-size:12.5px; } th,td{ padding:5px 8px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
  th{ background:#eef0f2; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
  td.num{ text-align:right; font-variant-numeric:tabular-nums; } td.money{ font-weight:600; }
  td.phrase{ font-weight:700; color:#c026d3; white-space:normal; } @media (prefers-color-scheme:dark){ td.phrase{ color:#e879f9 } }
  td.hit{ background:#bfe6c9; font-weight:700; } @media (prefers-color-scheme:dark){ td.hit{ background:#123d1e } }
  .note{ color:#888; font-size:11px; margin-top:10px; }
  @page{ size:A4 landscape; margin:9mm; }
  @media print{ body{ background:#fff; color:#111; padding:0; font-size:10px; -webkit-print-color-adjust:exact; print-color-adjust:exact; } td.phrase{ color:#c026d3 } tr,thead{ break-inside:avoid; } thead{ display:table-header-group; } }
</style></head><body>
<h1>Связанные фразы по муслиновым рубашкам — ёмкость ниши</h1>
<div class="sub">Источник: <b>MPStats</b> · за месяц (${iso(Date.now() - 31 * day)} … ${iso(Date.now() - day)}) · отсортировано по выручке ниши. AIDE/AIZE — сколько карточек бренда в выдаче фразы.</div>
<table><thead><tr>
  <th>#</th><th>Фраза</th><th>Сегм.</th><th>Выручка/мес ₽</th><th>Продажи, шт</th><th>Карточек</th><th>Брендов</th><th>AIDEMIKO</th><th>AIZEK</th>
</tr></thead><tbody>${rowsHtml}</tbody></table>
<div class="note">Ёмкость = сумма по всей выдаче WB по фразе (MPStats, до ~100 карточек). Данные оценочные.${empty.length ? ' Без данных: ' + esc(empty.map((r) => r.query).join(', ')) + '.' : ''}</div>
</body></html>`;

const htmlOut = `${outDir}/muslin-phrases.html`;
writeFileSync(htmlOut, html);

async function renderPdf(htmlPath, pdfPath) {
  const { chromium } = await import('playwright');
  const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].concat([chromium.executablePath()]).find((p) => p && existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: pdfPath, format: 'A4', landscape: true, printBackground: true, margin: { top: '9mm', bottom: '9mm', left: '9mm', right: '9mm' } });
  } finally { await browser.close(); }
}
const pdfOut = `${outDir}/muslin-phrases.pdf`;
await renderPdf(htmlOut, pdfOut);
process.stderr.write(`✓ ${htmlOut}\n✓ ${pdfOut}\n`);
