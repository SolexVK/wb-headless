// scripts/build-cabinet-pdf.mjs — цветной PDF-дашборд по кабинету WB.
// Читает свежий reports-output/cabinet-*.json (результат report:cabinet) и рендерит
// A4-дашборд: потери на сгоревших складах, остатки FBO/FBS, «в пути», «где товар».
//
// Запуск:  node scripts/build-cabinet-pdf.mjs [cabinet.json] [out.pdf]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const num = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
const rub = (n) => num(n) + ' ₽';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function latest() {
  const dir = path.join(ROOT, 'reports-output');
  const f = fs.readdirSync(dir).filter((x) => /^cabinet-.*\.json$/.test(x))
    .map((x) => path.join(dir, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!f.length) throw new Error('нет cabinet-*.json — сначала npm run report:cabinet');
  return f[0];
}

function bars(rows, maxV, opts = {}) {
  const { valKey = 'qty', nameKey = 'name', color = 'fire', showRub = false } = opts;
  return rows.map((r) => {
    const v = r[valKey] || 0;
    const pct = Math.max(1.5, (v / maxV) * 100);
    const gone = r.gone;
    const cls = gone ? 'gone' : color;
    return `<div class="bar-row">
      <div class="bar-name">${esc(r[nameKey])}${gone ? ' <span class="tag">обнулён</span>' : ''}</div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="bar-val">${num(v)}${showRub ? `<span class="bar-sub">${rub(r.rub || v * 620)}</span>` : ''}</div>
    </div>`;
  }).join('');
}

function build(j) {
  const cost = j.cost;
  const f = j.fbo, fbs = j.fbs;
  const dateStr = new Date(j.snapshotAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

  const est = f.burnedEstimate.slice().sort((a, b) => b.est - a.est);
  const maxEst = est[0]?.est || 1;
  const lossRows = est.map((w) => {
    const pct = Math.max(1.5, (w.est / maxEst) * 100);
    const nowPct = Math.max(0, (w.now / maxEst) * 100);
    return `<div class="bar-row">
      <div class="bar-name">${esc(w.name)}${w.gone ? ' <span class="tag">обнулён</span>' : ''}</div>
      <div class="bar-track">
        <div class="bar-fill ${w.gone ? 'gone' : 'fire'}" style="width:${pct}%"></div>
        ${w.now > 0 && !w.gone ? `<div class="bar-now" style="width:${nowPct}%"></div>` : ''}
      </div>
      <div class="bar-val">${num(w.est)}<span class="bar-sub">${rub(w.rub)}</span></div>
    </div>`;
  }).join('');

  // «Где товар сейчас» — распределение (утрачено считаем по оценке).
  const disposition = [
    { name: 'Утрачено (сгоревшие склады)', qty: f.burnedEstTotalQty, c: '#E63946' },
    { name: 'В пути до покупателей', qty: f.transitToClient, c: '#FF7A00' },
    { name: 'Возвраты в пути на WB', qty: f.transitReturns, c: '#FFD166' },
    { name: 'FBS (свои склады)', qty: fbs.total, c: '#48CAE4' },
    { name: 'FBO (живые склады WB)', qty: f.remainingTotalQty, c: '#9D4EDD' },
  ];
  const dispTotal = disposition.reduce((s, d) => s + d.qty, 0) || 1;
  const dispSeg = disposition.map((d) => `<div class="seg" style="width:${(d.qty / dispTotal) * 100}%;background:${d.c}"></div>`).join('');
  const dispLeg = disposition.map((d) => `<div class="dleg">
    <span class="ddot" style="background:${d.c}"></span>
    <span class="dname">${esc(d.name)}</span>
    <span class="dval">${num(d.qty)} <span class="dpct">${((d.qty / dispTotal) * 100).toFixed(1)}%</span></span>
  </div>`).join('');

  const fbsRows = bars(fbs.perWh, fbs.perWh[0]?.qty || 1, { color: 'teal' });
  const fboRemRows = bars(f.remaining, f.remaining[0]?.qty || 1, { color: 'violet' });

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root{ --wb1:#481173; --wb3:#9D4EDD; --fire1:#FFD166; --fire2:#FF7A00; --fire3:#E63946;
    --ink:#F4EEFB; --muted:#C9B8E4; --card:rgba(255,255,255,.06); --line:rgba(255,255,255,.14); }
  body{ font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; color:var(--ink);
    width:210mm; background:linear-gradient(155deg,#2A0A47 0%,#481173 45%,#5A1A8A 100%); }
  .page{ padding:13mm 12mm; } .page-break{ page-break-before:always; }
  .top{ display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid var(--line); padding-bottom:8px; }
  .brand{ font-size:11px; letter-spacing:3px; color:var(--fire1); font-weight:700; text-transform:uppercase; }
  h1{ font-size:25px; font-weight:800; margin-top:3px; }
  h1 .fl{ background:linear-gradient(90deg,var(--fire1),var(--fire2),var(--fire3)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .sub{ color:var(--muted); font-size:11px; margin-top:4px; }
  .snap{ text-align:right; font-size:10px; color:var(--muted); line-height:1.5; }
  .kpis{ display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-top:13px; }
  .kpi{ background:var(--card); border:1px solid var(--line); border-radius:11px; padding:11px; position:relative; overflow:hidden; }
  .kpi::before{ content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--grad,linear-gradient(var(--fire2),var(--fire3))); }
  .kpi .k{ font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.3px; }
  .kpi .v{ font-size:20px; font-weight:800; margin-top:3px; }
  .kpi .u{ font-size:9px; color:var(--muted); margin-top:1px; }
  .kpi.big .v{ background:linear-gradient(90deg,var(--fire1),var(--fire2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .card{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-top:12px; }
  .card h2{ font-size:13px; font-weight:700; margin-bottom:11px; display:flex; align-items:center; gap:7px; }
  .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; }
  .grid2 .card{ margin-top:0; }
  .bar-row{ display:grid; grid-template-columns:150px 1fr auto; align-items:center; gap:9px; margin-bottom:5.5px; }
  .bar-name{ font-size:9.5px; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar-track{ position:relative; height:14px; background:rgba(255,255,255,.07); border-radius:7px; overflow:hidden; }
  .bar-fill{ height:100%; border-radius:7px; }
  .bar-fill.fire{ background:linear-gradient(90deg,var(--fire2),var(--fire3)); }
  .bar-fill.teal{ background:linear-gradient(90deg,#48CAE4,#7B2CBF); }
  .bar-fill.violet{ background:linear-gradient(90deg,#9D4EDD,#7B2CBF); }
  .bar-fill.gone{ background:repeating-linear-gradient(45deg,rgba(230,57,70,.55),rgba(230,57,70,.55) 4px,rgba(230,57,70,.28) 4px,rgba(230,57,70,.28) 8px); }
  .bar-now{ position:absolute; top:0; left:0; height:100%; border-right:2px solid #fff; box-shadow:0 0 0 9999px rgba(0,0,0,0) ; }
  .bar-val{ font-size:9.5px; font-weight:700; text-align:right; white-space:nowrap; min-width:56px; }
  .bar-sub{ display:block; font-size:8px; color:var(--muted); font-weight:500; }
  .tag{ font-size:7.5px; color:#FFB3B8; border:1px solid rgba(230,57,70,.5); border-radius:4px; padding:0 3px; font-weight:600; }
  .total{ display:flex; justify-content:space-between; margin-top:8px; padding-top:8px; border-top:1px solid var(--line); font-size:11px; }
  .total b{ font-size:15px; } .lo{ color:var(--muted); font-size:9.5px; margin-top:3px; }
  .segbar{ display:flex; height:26px; border-radius:8px; overflow:hidden; margin-bottom:11px; }
  .seg{ height:100%; }
  .dleg{ display:flex; align-items:center; gap:8px; font-size:10.5px; padding:4px 0; }
  .ddot{ width:11px; height:11px; border-radius:3px; flex:none; }
  .dval{ margin-left:auto; font-weight:700; } .dpct{ color:var(--muted); font-weight:500; font-size:9px; }
  .note{ margin-top:12px; background:rgba(230,57,70,.12); border:1px solid rgba(230,57,70,.35); border-radius:10px; padding:9px 13px; font-size:9px; color:#FFE1E4; line-height:1.5; }
  .note b{ color:#fff; }
  .foot{ margin-top:10px; display:flex; justify-content:space-between; font-size:8.5px; color:var(--muted); border-top:1px solid var(--line); padding-top:6px; }
  </style></head><body>

  <div class="page">
    <div class="top">
      <div>
        <div class="brand">Wildberries · сводка по кабинету</div>
        <h1>Кабинет: <span class="fl">потери и остатки</span></h1>
        <div class="sub">Пожары/атаки БПЛА · оценка по остаткам · себестоимость ${cost} ₽/ед</div>
      </div>
      <div class="snap">снимок<br><b style="color:#fff">${esc(dateStr)} МСК</b></div>
    </div>

    <div class="kpis">
      <div class="kpi big" style="--grad:linear-gradient(#E63946,#7a1620)"><div class="k">Потери (оценка)</div><div class="v">${num(f.burnedEstTotalRub)}</div><div class="u">₽ · ${num(f.burnedEstTotalQty)} ед</div></div>
      <div class="kpi" style="--grad:linear-gradient(#9D4EDD,#7B2CBF)"><div class="k">FBO живые</div><div class="v">${num(f.remainingTotalQty)}</div><div class="u">единиц</div></div>
      <div class="kpi" style="--grad:linear-gradient(#48CAE4,#2b7a99)"><div class="k">FBS свои</div><div class="v">${num(fbs.total)}</div><div class="u">единиц</div></div>
      <div class="kpi" style="--grad:linear-gradient(#FF7A00,#b35500)"><div class="k">В пути к клиенту</div><div class="v">${num(f.transitToClient)}</div><div class="u">единиц</div></div>
      <div class="kpi" style="--grad:linear-gradient(#FFD166,#b3902f)"><div class="k">Возвраты в пути</div><div class="v">${num(f.transitReturns)}</div><div class="u">единиц</div></div>
    </div>

    <div class="card">
      <h2><span>🔥</span> Потери по сгоревшим складам <span style="font-weight:400;color:var(--muted);font-size:10px">(полоса — оценка/пик; ▏ белая метка — сколько ещё видно сейчас)</span></h2>
      ${lossRows}
      <div class="total">
        <div>Оценка потерь (пик остатков)<div class="lo">нижняя граница (видно сейчас): ${num(f.burnedNowTotalQty)} ед · ${rub(f.burnedNowTotalRub)}</div></div>
        <div style="text-align:right"><b>${rub(f.burnedEstTotalRub)}</b><div class="lo">${num(f.burnedEstTotalQty)} единиц</div></div>
      </div>
    </div>

    <div class="note">
      <b>Как считаем.</b> Количество потерь = остатки товара, лежавшие на атакованных складах (WB API warehouse_remains) × ${cost} ₽.
      WB постепенно <b>списывает</b> сгоревшее — по обнулённым складам (штриховка) берётся последнее известное количество из предыдущего снимка (${esc((j.fbo.estimateBasis || '').match(/snapshot ([\d.]+)/)?.[1] || '—')}). «Оценка» — верхняя граница (возможен перенос товара между складами), «сейчас» — нижняя.
    </div>
    <div class="foot"><span>Wildberries Seller API · warehouse_remains · marketplace v3 · content v2</span><span>стр. 1/2 · потери</span></div>
  </div>

  <div class="page page-break">
    <div class="top">
      <div>
        <div class="brand">Wildberries · остатки и логистика</div>
        <h1>Где <span class="fl">мой товар сейчас</span></h1>
        <div class="sub">Распределение по статусам · FBO / FBS / в пути</div>
      </div>
      <div class="snap">снимок<br><b style="color:#fff">${esc(dateStr)} МСК</b></div>
    </div>

    <div class="card">
      <h2><span>📦</span> Распределение товара по статусам</h2>
      <div class="segbar">${dispSeg}</div>
      ${dispLeg}
    </div>

    <div class="grid2">
      <div class="card">
        <h2><span>🏬</span> Остатки FBS (свои склады) — ${num(fbs.total)} ед</h2>
        ${fbsRows}
      </div>
      <div class="card">
        <h2><span>🏭</span> FBO на живых складах — ${num(f.remainingTotalQty)} ед</h2>
        ${fboRemRows}
        <h2 style="margin-top:14px"><span>🚚</span> В пути</h2>
        <div class="dleg"><span class="ddot" style="background:#FF7A00"></span><span class="dname">До покупателей</span><span class="dval">${num(f.transitToClient)}</span></div>
        <div class="dleg"><span class="ddot" style="background:#FFD166"></span><span class="dname">Возвраты на склад WB</span><span class="dval">${num(f.transitReturns)}</span></div>
      </div>
    </div>

    <div class="foot"><span>FBS: marketplace /api/v3/stocks · ${fbs.skuCount} баркодов · ${fbs.perWh.length} складов</span><span>стр. 2/2 · остатки</span></div>
  </div>
  </body></html>`;
}

async function main() {
  const jsonPath = process.argv[2] || latest();
  const outPdf = process.argv[3] || path.join(ROOT, 'reports-output',
    `cabinet-dashboard-${path.basename(jsonPath).replace(/^cabinet-|\.json$/g, '')}.pdf`);
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  log(`  данные: ${path.basename(jsonPath)}`);
  const html = build(j);
  fs.writeFileSync(outPdf.replace(/\.pdf$/, '.html'), html);
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: outPdf, format: 'A4', printBackground: true });
  await browser.close();
  log(`  ✓ PDF: ${outPdf}`);
  process.stdout.write(outPdf + '\n');
}
main().catch((e) => { log('✗ ' + e.message); process.exit(1); });
