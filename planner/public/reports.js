// reports.js — страница «Отчёты»: сбор данных из state+schedule, красивый HTML,
// экспорт в Excel (xlsx-js-style) и PDF (печать оформленной страницы).

// Летние (сезонные) артикулы — для отдельной логики закупки ткани (≤1 мес до производства).
export const SUMMER_ARTICLE_IDS = ['005', '006', '007', '014', '022', '032', '033', '034'];

const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const ym = (iso) => String(iso || '').slice(0, 7);
const ymLabel = (m) => { const [y, mo] = String(m).split('-'); return mo ? `${MONTHS_RU[+mo - 1]} ${y}` : m; };
const sumRow = (row) => { let s = 0; for (const k in (row || {})) s += +row[k] || 0; return Math.round(s); };
const fmtNum = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const artNum = (id) => { const n = parseInt(String(id).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : Infinity; };
const addMonthsISO = (iso, k) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 10); };
const dmy = (iso) => { const s = String(iso || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—'; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };

// ── ПАЛИТРА отчётов (единая для экрана, PDF, Excel) ──
const C = {
  ink: '#1a2434', head: '#1f3a5f', month: '#2b6cb0', monthSummer: '#c05621',
  th: '#e7edf5', thSummer: '#fbe8d8', zebra: '#f6f9fc', border: '#c9d4e2',
  total: '#eaf1fb', totalSummer: '#fdeede', chip: '#334e68', accent: '#2b6cb0', summer: '#c05621',
};

// ============================ СБОР ДАННЫХ ============================
export function buildReportsData(state, schedule, opts = {}) {
  const summer = new Set((opts.summerIds && opts.summerIds.length ? opts.summerIds : SUMMER_ARTICLE_IDS).map((s) => String(s).trim()));
  const cycles = (schedule && schedule.cycles ? schedule.cycles : []).filter((c) => !c.historical);
  const artById = Object.fromEntries((state.articles || []).map((a) => [a.id, a]));
  const wastageMul = 1 + (((state.settings || {}).fabric || {}).wastagePct || 0) / 100;
  const prodMonthOf = (c) => ym(c.cutStart || (c.ops && c.ops.cut && c.ops.cut.start));

  // ── Отчёт 1: месяц → цех → артикул → штук (месяц = старт производства, крой) ──
  const r1 = {};
  for (const c of cycles) {
    const m = prodMonthOf(c);
    const wsMap = (r1[m] || (r1[m] = {}));
    const w = (wsMap[c.workshopId] || (wsMap[c.workshopId] = { name: c.workshopName, own: c.own, arts: {} }));
    w.arts[c.articleId] = (w.arts[c.articleId] || 0) + c.units;
  }
  const workshopMonthly = Object.keys(r1).sort().map((m) => {
    const workshops = Object.entries(r1[m]).map(([wid, w]) => {
      const arts = Object.entries(w.arts).sort((a, b) => artNum(a[0]) - artNum(b[0])).map(([art, units]) => ({ art, units }));
      return { workshopId: wid, name: w.name, own: w.own, arts, total: arts.reduce((s, a) => s + a.units, 0) };
    }).sort((a, b) => (b.own - a.own) || String(a.name).localeCompare(String(b.name), 'ru'));
    return { ym: m, label: ymLabel(m), workshops, total: workshops.reduce((s, w) => s + w.total, 0) };
  });

  // ── потребности в ткани из циклов (по цвету), с планшет/№цвета и датами ──
  const dem = [];
  for (const c of cycles) {
    const a = artById[c.articleId]; if (!a) continue;
    const M = c.batchMatrix || {};
    for (const color of Object.keys(M)) {
      const units = sumRow(M[color]); if (units <= 0) continue;
      const fi = (a.fabricInfo && a.fabricInfo[color]) || {};
      dem.push({
        articleId: c.articleId, articleName: a.name || '', color,
        plansheet: (fi.plansheet || '').trim(), colorNo: (fi.colorNo || '').trim(),
        meters: units * (+a.fabricPerUnit || 0) * wastageMul, units,
        prodMonth: prodMonthOf(c), cutStart: c.cutStart || (c.ops && c.ops.cut && c.ops.cut.start),
        orderBy: (c.fabric && c.fabric.orderDate) || c.cutStart,
        isSummer: summer.has(String(c.articleId).trim()),
      });
    }
  }

  // ── Отчёт 2a: помесячная детализация ткани (месяц × артикул × планшет × №цвета × метраж) ──
  const r2 = {};
  for (const d of dem) {
    const mm = (r2[d.prodMonth] || (r2[d.prodMonth] = {}));
    const k = `${d.articleId}|${d.plansheet}|${d.colorNo}|${d.color}`;
    const row = (mm[k] || (mm[k] = { articleId: d.articleId, articleName: d.articleName, color: d.color, plansheet: d.plansheet, colorNo: d.colorNo, meters: 0, units: 0, isSummer: d.isSummer }));
    row.meters += d.meters; row.units += d.units;
  }
  const fabricMonthly = Object.keys(r2).sort().map((m) => {
    const rows = Object.values(r2[m]).map((x) => ({ ...x, meters: Math.ceil(x.meters) }))
      .sort((a, b) => artNum(a.articleId) - artNum(b.articleId) || String(a.plansheet).localeCompare(String(b.plansheet)) || String(a.colorNo).localeCompare(String(b.colorNo)));
    return { ym: m, label: ymLabel(m), rows, total: rows.reduce((s, r) => s + r.meters, 0) };
  });

  // ── Отчёт 2b: КОНСОЛИДАЦИЯ ЗАКУПКИ ──
  // Ключ ткани = «планшет + № цвета» (одна и та же ткань в РАЗНЫХ артикулах складывается вместе).
  // Если планшет/№ не заданы — консолидируем по НАЗВАНИЮ цвета (тоже через артикулы). Только для закупа;
  // в детализации (2a) остаётся разбивка по артикулам.
  const skuKey = (d) => (d.plansheet || d.colorNo) ? `ps:${d.plansheet || '—'}|cn:${d.colorNo || '—'}` : `col:${String(d.color || '').trim().toLowerCase()}`;

  // ДЕМИ: по периоду (месяц производства) — вся ткань периода закупается в САМУЮ РАННЮЮ дату периода
  const demiByMonth = {};
  for (const d of dem) if (!d.isSummer) (demiByMonth[d.prodMonth] || (demiByMonth[d.prodMonth] = [])).push(d);
  const demi = Object.keys(demiByMonth).sort().map((m) => {
    const list = demiByMonth[m];
    const purchaseDate = list.reduce((mn, d) => (d.orderBy < mn ? d.orderBy : mn), list[0].orderBy);
    const bySku = {};
    for (const d of list) {
      const k = skuKey(d);
      const it = (bySku[k] || (bySku[k] = { plansheet: d.plansheet, colorNo: d.colorNo, color: d.color, arts: new Set(), meters: 0 }));
      it.meters += d.meters; it.arts.add(d.articleId);
    }
    const items = Object.values(bySku).map((x) => ({ plansheet: x.plansheet, colorNo: x.colorNo, color: x.color, arts: [...x.arts].sort((a, b) => artNum(a) - artNum(b)), meters: Math.ceil(x.meters) }))
      .sort((a, b) => String(a.plansheet).localeCompare(String(b.plansheet)) || String(a.colorNo).localeCompare(String(b.colorNo)) || String(a.color).localeCompare(String(b.color)));
    return { ym: m, label: ymLabel(m), purchaseDate, items, totalMeters: items.reduce((s, i) => s + i.meters, 0) };
  });

  // ЛЕТО: по SKU и месяцу производства — дата закупки = самый ранний крой − 1 месяц
  const summerBy = {};
  for (const d of dem) if (d.isSummer) {
    const k = `${d.prodMonth}|${skuKey(d)}`;
    const it = (summerBy[k] || (summerBy[k] = { ym: d.prodMonth, plansheet: d.plansheet, colorNo: d.colorNo, color: d.color, arts: new Set(), meters: 0, earliestCut: d.cutStart }));
    it.meters += d.meters; it.arts.add(d.articleId);
    if (d.cutStart < it.earliestCut) it.earliestCut = d.cutStart;
  }
  const summerP = Object.values(summerBy).map((x) => ({
    ym: x.ym, monthLabel: ymLabel(x.ym), plansheet: x.plansheet, colorNo: x.colorNo, color: x.color,
    arts: [...x.arts].sort((a, b) => artNum(a) - artNum(b)), meters: Math.ceil(x.meters),
    productionStart: x.earliestCut, purchaseBy: addMonthsISO(x.earliestCut, -1),
  })).sort((a, b) => String(a.purchaseBy).localeCompare(String(b.purchaseBy)) || String(a.plansheet).localeCompare(String(b.plansheet)));

  return {
    workshopMonthly, fabricMonthly,
    fabricPurchase: { demi, summer: summerP },
    summerIds: [...summer],
    grand: {
      units: workshopMonthly.reduce((s, m) => s + m.total, 0),
      fabricMeters: fabricMonthly.reduce((s, m) => s + m.total, 0),
    },
  };
}

// ============================ HTML (экран + PDF) ============================
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const artChip = (id) => `<span style="display:inline-block;font-weight:700;color:${C.accent}">${esc(id)}</span>`;

function report1Html(data) {
  if (!data.workshopMonthly.length) return `<div style="padding:20px;color:#667">Нет данных для отчёта. Заполните план и раскладку на Ганте.</div>`;
  let h = '';
  for (const m of data.workshopMonthly) {
    h += `<div style="margin:0 0 22px">
      <div style="background:${C.month};color:#fff;font-weight:700;font-size:15px;padding:8px 14px;border-radius:8px 8px 0 0">${esc(m.label)} <span style="opacity:.85;font-weight:600">· ${fmtNum(m.total)} шт</span></div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:${C.th}">
          <th style="text-align:left;padding:7px 12px;border:1px solid ${C.border};width:170px">Цех</th>
          <th style="text-align:left;padding:7px 12px;border:1px solid ${C.border}">Артикулы (штук)</th>
          <th style="text-align:right;padding:7px 12px;border:1px solid ${C.border};width:110px">Итого цех</th>
        </tr></thead><tbody>`;
    m.workshops.forEach((w, i) => {
      const arts = w.arts.map((a) => `${artChip(a.art)}&nbsp;<span style="color:#556">${fmtNum(a.units)}</span>`).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
      h += `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
        <td style="padding:6px 12px;border:1px solid ${C.border};font-weight:600">${esc(w.name)}${w.own ? ' <span style="font-size:11px;color:#7a8">свой</span>' : ''}</td>
        <td style="padding:6px 12px;border:1px solid ${C.border}">${arts}</td>
        <td style="padding:6px 12px;border:1px solid ${C.border};text-align:right;font-weight:700">${fmtNum(w.total)}</td>
      </tr>`;
    });
    h += `<tr style="background:${C.total};font-weight:700"><td style="padding:6px 12px;border:1px solid ${C.border}" colspan="2">Итого за ${esc(m.label)}</td><td style="padding:6px 12px;border:1px solid ${C.border};text-align:right">${fmtNum(m.total)}</td></tr>`;
    h += `</tbody></table></div>`;
  }
  return h;
}

function fabricTableHtml(rows, summerFlag) {
  const thBg = summerFlag ? C.thSummer : C.th;
  let h = `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
    <thead><tr style="background:${thBg}">
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:70px">Артикул</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">Планшет</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">№ цвета</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Цвет</th>
      <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:120px">Метраж, м</th>
    </tr></thead><tbody>`;
  rows.forEach((r, i) => {
    h += `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
      <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:700;color:${r.isSummer ? C.summer : C.accent}">${esc(r.articleId)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.plansheet || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.colorNo || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.color)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(r.meters)}</td>
    </tr>`;
  });
  return h + `</tbody></table>`;
}

function report2aHtml(data) {
  if (!data.fabricMonthly.length) return `<div style="padding:20px;color:#667">Нет данных по ткани.</div>`;
  let h = '';
  for (const m of data.fabricMonthly) {
    h += `<div style="margin:0 0 22px">
      <div style="background:${C.month};color:#fff;font-weight:700;font-size:15px;padding:8px 14px;border-radius:8px 8px 0 0">${esc(m.label)} <span style="opacity:.85;font-weight:600">· ${fmtNum(m.total)} м</span></div>
      ${fabricTableHtml(m.rows, false)}
      <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody><tr style="background:${C.total};font-weight:700"><td style="padding:6px 10px;border:1px solid ${C.border}">Итого за ${esc(m.label)}</td><td style="padding:6px 10px;border:1px solid ${C.border};text-align:right;width:120px">${fmtNum(m.total)} м</td></tr></tbody></table>
    </div>`;
  }
  return h;
}

function report2bHtml(data) {
  const P = data.fabricPurchase;
  let h = `<div style="margin:0 0 10px;color:#556;font-size:13px">Ткань одного <b>планшета и цвета</b> из разных артикулов сложена вместе. Демисезон: вся ткань периода закупается в <b>самую раннюю</b> дату этого периода. Лето: закупка <b>не позже, чем за месяц</b> до старта производства.</div>`;
  // ДЕМИ
  h += `<div style="font-weight:800;color:${C.head};font-size:15px;margin:14px 0 8px">🧵 Демисезон — консолидация по периодам</div>`;
  if (!P.demi.length) h += `<div style="color:#889;padding:6px 0">нет демисезонной ткани</div>`;
  for (const m of P.demi) {
    h += `<div style="margin:0 0 18px">
      <div style="background:${C.month};color:#fff;font-weight:700;padding:7px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between">
        <span>${esc(m.label)}</span><span>заказать: <b>${dmy(m.purchaseDate)}</b> · ${fmtNum(m.totalMeters)} м</span></div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr style="background:${C.th}">
          <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:100px">Планшет</th>
          <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">№ цвета</th>
          <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:120px">Цвет</th>
          <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Артикулы</th>
          <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:120px">Метраж, м</th>
        </tr></thead><tbody>`;
    m.items.forEach((it, i) => {
      h += `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
        <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:600">${esc(it.plansheet || '—')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(it.colorNo || '—')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(it.color || '—')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${it.arts.map(artChip).join(', ')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(it.meters)}</td>
      </tr>`;
    });
    h += `<tr style="background:${C.total};font-weight:700"><td colspan="4" style="padding:5px 10px;border:1px solid ${C.border}">Итого закупка ${esc(m.label)} · заказать ${dmy(m.purchaseDate)}</td><td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(m.totalMeters)}</td></tr>`;
    h += `</tbody></table></div>`;
  }
  // ЛЕТО
  h += `<div style="font-weight:800;color:${C.summer};font-size:15px;margin:22px 0 8px">☀️ Летние (сезонные) — закупка ≤ 1 мес до производства</div>`;
  if (!P.summer.length) h += `<div style="color:#889;padding:6px 0">нет летней ткани</div>`;
  else {
    h += `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:${C.thSummer}">
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:110px">Заказать не позже</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:100px">Старт произв.</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:80px">Планшет</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:80px">№ цвета</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:110px">Цвет</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Артикулы</th>
        <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:100px">Метраж, м</th>
      </tr></thead><tbody>`;
    P.summer.forEach((it, i) => {
      h += `<tr style="background:${i % 2 ? C.totalSummer : '#fff'}">
        <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:700;color:${C.summer}">${dmy(it.purchaseBy)}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${dmy(it.productionStart)}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:600">${esc(it.plansheet || '—')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(it.colorNo || '—')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(it.color || '—')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${it.arts.map(artChip).join(', ')}</td>
        <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(it.meters)}</td>
      </tr>`;
    });
    const stot = P.summer.reduce((s, i) => s + i.meters, 0);
    h += `<tr style="background:${C.totalSummer};font-weight:700"><td colspan="6" style="padding:5px 10px;border:1px solid ${C.border}">Итого летняя ткань</td><td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(stot)}</td></tr>`;
    h += `</tbody></table>`;
  }
  return h;
}

// ============================ PDF (печать) ============================
function printReport(title, innerHtml) {
  const w = window.open('', '_blank');
  if (!w) { alert('Разрешите всплывающие окна для печати в PDF'); return; }
  w.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:${C.ink};margin:0;padding:24px 28px;background:#fff}
      h1{font-size:20px;margin:0 0 4px;color:${C.head}}
      .sub{color:#667;font-size:12px;margin:0 0 18px}
      table{page-break-inside:auto}
      tr{page-break-inside:avoid}
      @media print{ @page{ margin:14mm } body{padding:0} }
    </style></head><body>
    <h1>${esc(title)}</h1>
    <div class="sub">Сформировано ${dmy(new Date().toISOString())}</div>
    ${innerHtml}
    <script>window.onload=function(){setTimeout(function(){window.print();},250)}<\/script>
    </body></html>`);
  w.document.close();
}

// ============================ EXCEL (xlsx-js-style) ============================
const XLSX_BORDER = () => ({ top: { style: 'thin', color: { rgb: 'C9D4E2' } }, bottom: { style: 'thin', color: { rgb: 'C9D4E2' } }, left: { style: 'thin', color: { rgb: 'C9D4E2' } }, right: { style: 'thin', color: { rgb: 'C9D4E2' } } });
const hx = (c) => String(c).replace('#', '').toUpperCase();
function styleSheet(ws, styles) { for (const [addr, s] of Object.entries(styles)) { if (ws[addr]) ws[addr].s = s; } }

function report1Excel(data) {
  const XLSX = window.XLSX;
  const aoa = [['Отчёт 1 — Производство помесячно: цеха × артикулы']];
  aoa.push(['Месяц', 'Цех', 'Артикул', 'Штук']);
  const styleMap = {}; const merges = [];
  const HEAD = { font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } }, alignment: { vertical: 'center' } };
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const MONTH = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.month) } } };
  const TOT = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  let r = 2;
  for (const m of data.workshopMonthly) {
    const mr = r;
    aoa.push([`${m.label}  ·  ${m.total} шт`, '', '', '']);
    merges.push({ s: { r: mr, c: 0 }, e: { r: mr, c: 3 } });
    for (let c = 0; c < 4; c++) styleMap[XLSX.utils.encode_cell({ r: mr, c })] = MONTH;
    r++;
    for (const w of m.workshops) {
      w.arts.forEach((a, i) => {
        aoa.push([i === 0 ? '' : '', i === 0 ? w.name : '', a.art, a.units]);
        const rr = r;
        styleMap[XLSX.utils.encode_cell({ r: rr, c: 1 })] = { font: { bold: i === 0 }, border: XLSX_BORDER() };
        styleMap[XLSX.utils.encode_cell({ r: rr, c: 2 })] = { font: { bold: true, color: { rgb: hx(C.accent) } }, border: XLSX_BORDER() };
        styleMap[XLSX.utils.encode_cell({ r: rr, c: 3 })] = { alignment: { horizontal: 'right' }, border: XLSX_BORDER() };
        r++;
      });
      // подытог цеха
      aoa.push(['', `Итого ${w.name}`, '', w.total]);
      for (let c = 0; c < 4; c++) styleMap[XLSX.utils.encode_cell({ r, c })] = TOT;
      r++;
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, ...merges];
  ws['!cols'] = [{ wch: 22 }, { wch: 26 }, { wch: 12 }, { wch: 12 }];
  styleMap['A1'] = HEAD; styleMap['A2'] = TH; styleMap['B2'] = TH; styleMap['C2'] = TH; styleMap['D2'] = TH;
  styleSheet(ws, styleMap);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Цеха×Артикулы');
  XLSX.writeFile(wb, 'Отчёт_производство_помесячно.xlsx');
}

function report2Excel(data) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const MONTH = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.month) } } };
  const TOT = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const border = () => ({ border: XLSX_BORDER() });

  // Лист 1: детализация по месяцам
  {
    const aoa = [['Месяц', 'Артикул', 'Планшет', '№ цвета', 'Цвет', 'Метраж, м']];
    const sm = {}; let r = 1;
    for (let c = 0; c < 6; c++) sm[XLSX.utils.encode_cell({ r: 0, c })] = TH;
    for (const m of data.fabricMonthly) {
      aoa.push([`${m.label}  ·  ${m.total} м`, '', '', '', '', '']);
      for (let c = 0; c < 6; c++) sm[XLSX.utils.encode_cell({ r, c })] = MONTH; r++;
      for (const row of m.rows) {
        aoa.push(['', row.articleId, row.plansheet || '—', row.colorNo || '—', row.color, row.meters]);
        sm[XLSX.utils.encode_cell({ r, c: 1 })] = { font: { bold: true, color: { rgb: hx(row.isSummer ? C.summer : C.accent) } }, ...border() };
        for (const c of [2, 3, 4]) sm[XLSX.utils.encode_cell({ r, c })] = border();
        sm[XLSX.utils.encode_cell({ r, c: 5 })] = { alignment: { horizontal: 'right' }, ...border() };
        r++;
      }
      aoa.push(['', '', '', '', `Итого ${m.label}`, m.total]);
      for (let c = 0; c < 6; c++) sm[XLSX.utils.encode_cell({ r, c })] = TOT; r++;
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
    styleSheet(ws, sm); XLSX.utils.book_append_sheet(wb, ws, 'Ткань помесячно');
  }
  // Лист 2: закупка (деми + лето)
  {
    const aoa = [['ЗАКУПКА ТКАНИ — консолидация']];
    const sm = {}; let r = 1;
    sm.A1 = { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } } };
    aoa.push(['Демисезон — вся ткань периода закупается в самую раннюю дату периода (цвета одного планшета консолидированы через артикулы)']); r++;
    aoa.push(['Период', 'Заказать', 'Планшет', '№ цвета', 'Цвет', 'Артикулы', 'Метраж, м']);
    for (let c = 0; c < 7; c++) sm[XLSX.utils.encode_cell({ r, c })] = TH; r++;
    for (const m of data.fabricPurchase.demi) {
      for (const it of m.items) {
        aoa.push([m.label, dmy(m.purchaseDate), it.plansheet || '—', it.colorNo || '—', it.color || '—', it.arts.join(', '), it.meters]);
        for (const c of [0, 1, 2, 3, 4, 5]) sm[XLSX.utils.encode_cell({ r, c })] = border();
        sm[XLSX.utils.encode_cell({ r, c: 6 })] = { alignment: { horizontal: 'right' }, ...border() };
        r++;
      }
      aoa.push([`Итого ${m.label}`, dmy(m.purchaseDate), '', '', '', '', m.totalMeters]);
      for (let c = 0; c < 7; c++) sm[XLSX.utils.encode_cell({ r, c })] = TOT; r++;
    }
    aoa.push([]); r++;
    aoa.push(['Летние — закупка не позже чем за месяц до старта производства']);
    sm[XLSX.utils.encode_cell({ r, c: 0 })] = { font: { bold: true, color: { rgb: hx(C.summer) } } }; r++;
    aoa.push(['Заказать не позже', 'Старт произв.', 'Планшет', '№ цвета', 'Цвет', 'Артикулы', 'Метраж, м']);
    const THS = { ...TH, fill: { patternType: 'solid', fgColor: { rgb: hx(C.thSummer) } } };
    for (let c = 0; c < 7; c++) sm[XLSX.utils.encode_cell({ r, c })] = THS; r++;
    for (const it of data.fabricPurchase.summer) {
      aoa.push([dmy(it.purchaseBy), dmy(it.productionStart), it.plansheet || '—', it.colorNo || '—', it.color || '—', it.arts.join(', '), it.meters]);
      sm[XLSX.utils.encode_cell({ r, c: 0 })] = { font: { bold: true, color: { rgb: hx(C.summer) } }, ...border() };
      for (const c of [1, 2, 3, 4, 5]) sm[XLSX.utils.encode_cell({ r, c })] = border();
      sm[XLSX.utils.encode_cell({ r, c: 6 })] = { alignment: { horizontal: 'right' }, ...border() };
      r++;
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
    ws['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 20 }, { wch: 12 }];
    styleSheet(ws, sm); XLSX.utils.book_append_sheet(wb, ws, 'Закупка ткани');
  }
  XLSX.writeFile(wb, 'Отчёт_ткань_закупка.xlsx');
}

// ============================ СТРАНИЦА ============================
export function renderReportsPage(container, state, schedule, ctx = {}) {
  const toast = ctx.toast || (() => {});
  let data;
  try { data = buildReportsData(state, schedule); }
  catch (e) { container.innerHTML = `<div style="padding:20px;color:#c0392b">Ошибка сбора отчёта: ${esc(e.message)}</div>`; return; }

  const card = (title, subtitle, id, bodyHtml) => `
    <section style="background:#fff;border:1px solid ${C.border};border-radius:12px;margin:0 0 20px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid ${C.border};background:linear-gradient(90deg,${C.head},${C.month})">
        <div style="flex:1"><div style="font-size:16px;font-weight:800;color:#fff">${esc(title)}</div><div style="font-size:12px;color:#dbe6f5">${esc(subtitle)}</div></div>
        <button class="btn" data-xlsx="${id}" style="background:#fff">⤓ Excel</button>
        <button class="btn" data-pdf="${id}" style="background:#fff">⤓ PDF</button>
      </div>
      <div style="padding:16px">${bodyHtml}</div>
    </section>`;

  const h1 = report1Html(data);
  const h2a = report2aHtml(data);
  const h2b = report2bHtml(data);

  container.innerHTML = `
    <div style="margin:0 0 16px">
      <div style="font-size:20px;font-weight:800;color:${C.head}">Отчёты</div>
      <div style="color:#667;font-size:13px">Снимок настроенной системы: ${fmtNum(data.grand.units)} шт производства · ${fmtNum(data.grand.fabricMeters)} м ткани. Экспорт в Excel и PDF.</div>
    </div>
    ${card('1 · Производство помесячно', 'Какие цеха какие артикулы отшивают и сколько (по месяцу старта производства)', 'r1', h1)}
    ${card('2 · Ткань помесячно', 'Метраж по артикулам, планшетам и номерам цвета (по месяцу производства)', 'r2a', h2a)}
    ${card('2 · Закупка ткани (консолидация)', 'Демисезон — по самой ранней дате периода; лето — ≤ 1 мес до производства', 'r2b', h2b)}
  `;

  container.querySelectorAll('[data-xlsx]').forEach((b) => b.addEventListener('click', () => {
    if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу', true); return; }
    try {
      if (b.dataset.xlsx === 'r1') report1Excel(data); else report2Excel(data);
      toast('Excel сформирован');
    } catch (e) { toast('Ошибка Excel: ' + e.message, true); }
  }));
  container.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.pdf === 'r1') printReport('Производство помесячно: цеха × артикулы', h1);
    else if (b.dataset.pdf === 'r2a') printReport('Ткань помесячно', h2a);
    else printReport('Закупка ткани — консолидация', h2b);
  }));
}
