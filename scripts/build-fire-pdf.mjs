// scripts/build-fire-pdf.mjs — цветная PDF-инфографика по убыткам от пожаров WB.
//
// Читает свежий reports-output/fire-losses-*.json (результат report-fire-losses.mjs),
// строит HTML-инфографику и рендерит её в PDF через предустановленный Chromium.
//
// Запуск:  node scripts/build-fire-pdf.mjs [путь_к_json] [выходной.pdf]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function latestJson() {
  const dir = path.join(ROOT, 'reports-output');
  const files = fs.readdirSync(dir)
    .filter((f) => /^fire-losses-.*\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error('Не найден reports-output/fire-losses-*.json — сначала запустите report:fire');
  return files[0];
}

const rub = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
const num = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function build(json) {
  const cost = json.costRub;
  const pats = json.patterns.map((p) => p.toLowerCase());
  const burned = Object.entries(json.warehousesSeen)
    .filter(([n]) => pats.some((p) => n.toLowerCase().includes(p)))
    .map(([name, qty]) => ({ name, qty, rub: qty * cost }))
    .sort((a, b) => b.qty - a.qty);

  const totalQty = json.totalQtyLost;
  const totalRub = json.totalLossRub;
  const maxWh = burned[0]?.qty || 1;

  // Агрегация по брендам и предметам.
  const byBrand = {}, bySubj = {};
  for (const a of json.articles) {
    byBrand[a.brand || '—'] = (byBrand[a.brand || '—'] || 0) + a.qtyLost;
    bySubj[a.subjectName || '—'] = (bySubj[a.subjectName || '—'] || 0) + a.qtyLost;
  }
  const brands = Object.entries(byBrand).sort((a, b) => b[1] - a[1]);
  const subjects = Object.entries(bySubj).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topArt = json.articles.slice(0, 10);

  const dateStr = new Date(json.snapshotAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

  const barRows = burned.map((w) => {
    const pct = Math.max(2, (w.qty / maxWh) * 100);
    return `<div class="bar-row">
      <div class="bar-name">${esc(w.name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-val">${num(w.qty)}<span class="bar-rub">${rub(w.rub)}</span></div>
    </div>`;
  }).join('');

  const subjMax = subjects[0]?.[1] || 1;
  const subjRows = subjects.map(([s, q]) => {
    const pct = Math.max(3, (q / subjMax) * 100);
    return `<div class="bar-row">
      <div class="bar-name sm">${esc(s)}</div>
      <div class="bar-track"><div class="bar-fill teal" style="width:${pct}%"></div></div>
      <div class="bar-val sm">${num(q)}</div>
    </div>`;
  }).join('');

  const brandTotal = brands.reduce((s, [, q]) => s + q, 0) || 1;
  const brandChips = brands.map(([b, q], i) => {
    const share = ((q / brandTotal) * 100).toFixed(1);
    return `<div class="chip">
      <span class="dot d${i % 4}"></span>
      <span class="chip-b">${esc(b)}</span>
      <span class="chip-q">${num(q)} ед · ${share}%</span>
    </div>`;
  }).join('');

  const artRows = topArt.map((a, i) => `<tr>
    <td class="rank">${i + 1}</td>
    <td>${esc(a.brand)}</td>
    <td>${esc(a.subjectName)}</td>
    <td class="mono">${esc(a.vendorCode)}</td>
    <td class="num">${num(a.qtyLost)}</td>
    <td class="num strong">${rub(a.lossRub)}</td>
  </tr>`).join('');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root{
    --wb1:#481173; --wb2:#7B2CBF; --wb3:#9D4EDD;
    --fire1:#FFD166; --fire2:#FF7A00; --fire3:#E63946;
    --ink:#F4EEFB; --muted:#C9B8E4; --card:rgba(255,255,255,.06); --line:rgba(255,255,255,.14);
  }
  html,body{ font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; color:var(--ink); }
  body{ width:210mm; background:linear-gradient(155deg,#2A0A47 0%,#481173 45%,#5A1A8A 100%); }
  .page{ padding:14mm 13mm; }
  .top{ display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid var(--line); padding-bottom:9px; }
  .brand{ font-size:12px; letter-spacing:3px; color:var(--fire1); font-weight:700; text-transform:uppercase; }
  h1{ font-size:27px; line-height:1.1; margin-top:4px; font-weight:800; }
  h1 .flame{ background:linear-gradient(90deg,var(--fire1),var(--fire2),var(--fire3)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .sub{ color:var(--muted); font-size:11.5px; margin-top:5px; }
  .snap{ text-align:right; font-size:10px; color:var(--muted); line-height:1.5; }

  .kpis{ display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin-top:14px; }
  .kpi{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 13px; position:relative; overflow:hidden; }
  .kpi::before{ content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:linear-gradient(var(--fire2),var(--fire3)); }
  .kpi .k{ font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .kpi .v{ font-size:25px; font-weight:800; margin-top:4px; }
  .kpi .v.big{ background:linear-gradient(90deg,var(--fire1),var(--fire2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .kpi .u{ font-size:10px; color:var(--muted); margin-top:2px; }

  .grid{ display:grid; grid-template-columns:1.55fr 1fr; gap:12px; margin-top:14px; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:13px 14px; }
  .card h2{ font-size:13px; font-weight:700; margin-bottom:11px; display:flex; align-items:center; gap:7px; }
  .card h2 .ic{ font-size:15px; }

  .bar-row{ display:grid; grid-template-columns:96px 1fr auto; align-items:center; gap:9px; margin-bottom:6.5px; }
  .bar-name{ font-size:10px; color:var(--ink); text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar-name.sm{ font-size:9.5px; }
  .bar-track{ height:15px; background:rgba(255,255,255,.07); border-radius:8px; overflow:hidden; }
  .bar-fill{ height:100%; border-radius:8px; background:linear-gradient(90deg,var(--fire2),var(--fire3)); }
  .bar-fill.teal{ background:linear-gradient(90deg,#48CAE4,#7B2CBF); }
  .bar-val{ font-size:10px; font-weight:700; text-align:right; white-space:nowrap; min-width:52px; }
  .bar-val.sm{ min-width:auto; }
  .bar-rub{ display:block; font-size:8.5px; color:var(--muted); font-weight:500; }

  .chip{ display:flex; align-items:center; gap:8px; padding:8px 6px; border-bottom:1px solid var(--line); }
  .chip:last-child{ border-bottom:none; }
  .dot{ width:11px; height:11px; border-radius:50%; flex:none; }
  .d0{ background:var(--fire2); } .d1{ background:#48CAE4; } .d2{ background:var(--wb3); } .d3{ background:var(--fire1); }
  .chip-b{ font-size:12px; font-weight:700; } .chip-q{ margin-left:auto; font-size:10px; color:var(--muted); }

  table{ width:100%; border-collapse:collapse; margin-top:2px; }
  th{ font-size:9px; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); text-align:left; padding:5px 7px; border-bottom:1px solid var(--line); }
  td{ font-size:10px; padding:5px 7px; border-bottom:1px solid rgba(255,255,255,.06); }
  td.num,th.num{ text-align:right; } td.strong{ font-weight:800; color:var(--fire1); }
  td.rank{ color:var(--muted); width:18px; } td.mono{ font-family:'SFMono-Regular',Consolas,monospace; font-size:9px; color:var(--muted); }

  .note{ margin-top:12px; background:rgba(230,57,70,.12); border:1px solid rgba(230,57,70,.35); border-radius:10px; padding:10px 13px; font-size:9.5px; color:#FFE1E4; line-height:1.5; }
  .note b{ color:#fff; }
  .foot{ margin-top:10px; display:flex; justify-content:space-between; font-size:8.5px; color:var(--muted); border-top:1px solid var(--line); padding-top:7px; }
</style></head>
<body><div class="page">
  <div class="top">
    <div>
      <div class="brand">Wildberries · потери от пожаров</div>
      <h1>Убытки от <span class="flame">пожаров на складах</span></h1>
      <div class="sub">Атаки БПЛА 18.07–07.08.2026 · оценка по остаткам товара на сгоревших складах</div>
    </div>
    <div class="snap">снимок остатков<br><b style="color:#fff">${esc(dateStr)} МСК</b><br>себестоимость ${cost} ₽/ед</div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="k">Сумма убытков</div><div class="v big">${num(totalRub)}</div><div class="u">рублей</div></div>
    <div class="kpi"><div class="k">Утрачено товара</div><div class="v">${num(totalQty)}</div><div class="u">единиц</div></div>
    <div class="kpi"><div class="k">Складов задето</div><div class="v">${burned.length}</div><div class="u">с остатками продавца</div></div>
    <div class="kpi"><div class="k">Артикулов</div><div class="v">${num(json.articlesWithLosses)}</div><div class="u">затронуто</div></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2><span class="ic">🔥</span> Потери по складам (единиц / ₽)</h2>
      ${barRows}
    </div>
    <div class="card">
      <h2><span class="ic">🏷️</span> По брендам</h2>
      ${brandChips}
      <h2 style="margin-top:14px"><span class="ic">👕</span> По категориям</h2>
      ${subjRows}
    </div>
  </div>

  <div class="card" style="margin-top:12px">
    <h2><span class="ic">📉</span> Топ‑10 артикулов по сумме убытка</h2>
    <table>
      <thead><tr><th class="rank">#</th><th>Бренд</th><th>Категория</th><th>Артикул</th><th class="num">Ед.</th><th class="num">Убыток</th></tr></thead>
      <tbody>${artRows}</tbody>
    </table>
  </div>

  <div class="note">
    <b>Методика.</b> Количество потерь = остатки товара, лежавшие на атакованных складах,
    по данным WB API <b>warehouse_remains</b> (детализация по артикулам). Сумма = количество × ${cost} ₽ (средняя себестоимость).
    Это снимок остатков <b>на дату отчёта</b>; после списания сгоревшего товара WB остатки обнулятся — тогда оценка занижается.
    Атаки БПЛА признаны WB форс‑мажором (оферта №98 от 07.07.2026) и <b>не компенсируются</b>, поэтому расчёт — для собственного учёта и актов списания.
  </div>

  <div class="foot">
    <span>Источник данных: Wildberries Seller API · warehouse_remains · аккаунт продавца</span>
    <span>Список складов сверён: Meduza · MP Manager · Lenta · АиФ · Фонтанка</span>
  </div>
</div></body></html>`;
}

async function main() {
  const jsonPath = process.argv[2] || latestJson();
  const outPdf = process.argv[3] || path.join(ROOT, 'reports-output',
    `fire-losses-infographic-${path.basename(jsonPath).replace(/^fire-losses-|\.json$/g, '')}.pdf`);
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  log(`  данные: ${path.basename(jsonPath)} · ${num(json.totalQtyLost)} ед · ${rub(json.totalLossRub)}`);

  const html = build(json);
  const htmlPath = outPdf.replace(/\.pdf$/, '.html');
  fs.writeFileSync(htmlPath, html);

  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: outPdf, format: 'A4', printBackground: true });
  await browser.close();
  log(`  ✓ PDF: ${outPdf}`);
  log(`  ✓ HTML: ${htmlPath}`);
  process.stdout.write(outPdf + '\n');
}

main().catch((e) => { log('✗ ' + e.message); process.exit(1); });
