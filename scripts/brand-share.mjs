// scripts/brand-share.mjs — доля продаж бренда от всего рынка по поисковой фразе (MPStats).
// «Рынок» = вся поисковая выдача WB по фразе за период (MPStats, потолок ~100 карточек).
// Считаем долю бренда в штуках и в выручке, ранг бренда, ТОП рынка и ТОП артикулов бренда.
// Периоды: 30 и 90 дней. Выход — самодостаточный HTML-отчёт.

import { writeFileSync } from 'node:fs';
import { fetchSearchResults } from '../lib/mpstats.js';

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

  const brandItems = items.filter((r) => hasBrand(r, brand)).sort((a, b) => b.sales - a.sales);
  const brandSales = brandItems.reduce((s, r) => s + r.sales, 0);
  const brandRev = brandItems.reduce((s, r) => s + r.revenue, 0);
  const brandAvgPrice = brandSales ? brandRev / brandSales : 0;

  const marketTop = [...items].sort((a, b) => b.sales - a.sales).slice(0, 10);

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
      <td class="num money">${rub(r.sales)}</td>
      <td class="num money">${rub(r.revenue)}</td>
      <td class="num">${rub(r.price)}</td>
    </tr>`;
  }).join('\n');
  return `<table><thead><tr>
      <th>#</th><th>Артикул</th><th>Бренд</th><th>Название</th><th>Продажи, шт</th><th>Выручка ₽</th><th>Ср. цена</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function brandTopTable(a) {
  if (!a.brandItems.length) return '<p class="muted">Карточек бренда в выдаче не найдено.</p>';
  const rows = a.brandItems.slice(0, 15).map((r, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><a href="${wbUrl(r.nmId)}" target="_blank" rel="noopener">${esc(r.nmId)}</a></td>
      <td class="name">${esc(r.name)}</td>
      <td>${esc(r.color || '—')}</td>
      <td class="num money">${rub(r.sales)}</td>
      <td class="num money">${rub(r.revenue)}</td>
      <td class="num">${rub(r.price)}</td>
      <td class="num">${a.marketSales ? pct(100 * r.sales / a.marketSales) : '—'}</td>
    </tr>`).join('\n');
  return `<table><thead><tr>
      <th>#</th><th>Артикул</th><th>Название</th><th>Цвет</th><th>Продажи, шт</th><th>Выручка ₽</th><th>Ср. цена</th><th>Доля рынка</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function brandBlock(brand, query, a30, a90) {
  return `<section class="brand">
    <h2>${esc(brand)} <span class="q">· «${esc(query)}»</span></h2>

    <h3>Общая информация по бренду</h3>
    <div class="ov-row">${overviewCard(a30)}${overviewCard(a90)}</div>

    <h3>ТОП рынка по фразе — 30 дней <span class="muted">(строки бренда подсвечены)</span></h3>
    ${marketTopTable(a30)}
    <h3>ТОП рынка по фразе — 90 дней</h3>
    ${marketTopTable(a90)}

    <h3>Артикулы бренда с наибольшими продажами — 30 дней</h3>
    ${brandTopTable(a30)}
    <h3>Артикулы бренда с наибольшими продажами — 90 дней</h3>
    ${brandTopTable(a90)}
  </section>`;
}

function buildHtml(blocks, meta) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Доля рынка по брендам · MPStats</title>
<style>
  :root{ color-scheme: light dark; --line:rgba(128,128,128,.22); }
  *{ box-sizing:border-box; }
  body{ font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:28px; background:#f6f7f9; color:#1a1a1a; }
  @media (prefers-color-scheme: dark){ body{ background:#141414; color:#e8e8e8 } .ov,.tag{ background:#1e1e1e!important } th{ background:#242424!important } tr.mine td{ background:#1d2a1f!important } .brand{ border-color:#2a2a2a } }
  h1{ font-size:22px; margin:0 0 2px; }
  h2{ font-size:19px; margin:26px 0 6px; }
  h3{ font-size:14px; margin:20px 0 8px; text-transform:uppercase; letter-spacing:.04em; color:#666; }
  .sub{ color:#777; margin-bottom:18px; }
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
  tr.mine td{ background:#eafaef; }
  .tag{ display:inline-block; padding:0 7px; border-radius:9px; font-size:10px; font-weight:700; background:#e6f4ea; color:#1f6f3f; vertical-align:middle; }
  a{ color:#2563eb; text-decoration:none; } a:hover{ text-decoration:underline; }
  .foot{ color:#999; font-size:12px; margin-top:26px; border-top:1px solid var(--line); padding-top:12px; }
</style></head><body>
<h1>Доля продаж от всего рынка по брендам</h1>
<div class="sub">Источник: <b>MPStats</b> · метод «Товары по поисковой фразе» · сформировано ${esc(meta.date)}</div>
${blocks.join('\n')}
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
const targets = [
  { brand: 'AIDEMIKO', query: 'Рубашка муслиновая женская' },
  { brand: 'AIZEK', query: 'Рубашка муслиновая мужская' },
];

const blocks = [];
const summary = [];
for (const t of targets) {
  process.stderr.write(`→ ${t.brand} / «${t.query}» …\n`);
  const a30 = await analyze(t.query, t.brand, 30);
  const a90 = await analyze(t.query, t.brand, 90);
  blocks.push(brandBlock(t.brand, t.query, a30, a90));
  summary.push({ brand: t.brand, query: t.query, a30, a90 });
}

const html = buildHtml(blocks, { date: iso(Date.now()) });
const out = process.argv[2] || 'reports-output/brand-market-share.html';
writeFileSync(out, html);
process.stderr.write(`\n✓ HTML: ${out}\n`);

// Короткая сводка в stdout (для чата).
for (const s of summary) {
  console.log(`\n### ${s.brand} · «${s.query}»`);
  for (const a of [s.a30, s.a90]) {
    console.log(`  ${a.days}d: доля ${pct(a.shareSales)} шт / ${pct(a.shareRev)} выручка · ` +
      `бренд ${rub(a.brandSales)} шт, ${rub(a.brandRev)} ₽ · ${a.brandCount} карт. · ранг #${a.rankBySales}/${a.totalBrands} · ` +
      `рынок ${rub(a.marketSales)} шт / ${rub(a.marketRev)} ₽`);
  }
}
