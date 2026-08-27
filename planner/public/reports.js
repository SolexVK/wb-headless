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
// дата+время сохранения (для имени/шапки архивного отчёта). ISO → «ДД.ММ.ГГГГ ЧЧ:ММ» в локальном времени.
const dmyhm = (iso) => { const dt = new Date(iso); if (isNaN(dt)) return '—'; const p = (n) => String(n).padStart(2, '0'); return `${p(dt.getDate())}.${p(dt.getMonth() + 1)}.${dt.getFullYear()} ${p(dt.getHours())}:${p(dt.getMinutes())}`; };

// ── ПАЛИТРА отчётов (единая для экрана, PDF, Excel) ──
const C = {
  ink: '#1a2434', head: '#1f3a5f', month: '#2b6cb0', monthSummer: '#c05621',
  th: '#e7edf5', thSummer: '#fbe8d8', zebra: '#f6f9fc', border: '#c9d4e2',
  total: '#eaf1fb', totalSummer: '#fdeede', chip: '#334e68', accent: '#2b6cb0', summer: '#c05621',
};
// Пастельные оттенки для блоков цехов (уникальный на цех, мягкие, в тон синей схемы отчёта).
const WS_TINTS = ['#EAF1FB', '#E7F5EC', '#FCF0E2', '#F1ECFA', '#FCE9E9', '#E6F5F7', '#F5F3E6', '#ECEFF4', '#FBEDF4', '#E9F9F0', '#F0F4FB', '#F7EEE6'];

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

  // ── цвет-оттенок для каждого цеха (стабильный, уникальный, гармонирует со схемой отчёта) ──
  // Порядок цехов — как в state.workshops, затем прочие. Каждый цех получает свой пастельный оттенок.
  const seenWs = [];
  for (const m of workshopMonthly) for (const w of m.workshops) if (!seenWs.includes(w.workshopId)) seenWs.push(w.workshopId);
  const wsOrder = (state.workshops || []).map((w) => w.id);
  const orderedWs = [...wsOrder.filter((id) => seenWs.includes(id)), ...seenWs.filter((id) => !wsOrder.includes(id))];
  const workshopColors = {};
  orderedWs.forEach((id, i) => { workshopColors[id] = WS_TINTS[i % WS_TINTS.length]; });

  return {
    workshopMonthly, fabricMonthly, workshopColors,
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
  const wc = data.workshopColors || {};
  let h = '';
  for (const m of data.workshopMonthly) {
    h += `<div style="margin:0 0 22px">
      <div style="background:${C.month};color:#fff;font-weight:700;font-size:15px;padding:8px 14px;border-radius:8px 8px 0 0">${esc(m.label)} <span style="opacity:.85;font-weight:600">· ${fmtNum(m.total)} шт</span></div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:${C.th}">
          <th style="text-align:left;padding:7px 12px;border:1px solid ${C.border};width:190px">Цех</th>
          <th style="text-align:left;padding:7px 12px;border:1px solid ${C.border}">Артикул</th>
          <th style="text-align:right;padding:7px 12px;border:1px solid ${C.border};width:120px">Штук</th>
        </tr></thead><tbody>`;
    for (const w of m.workshops) {
      const bg = wc[w.workshopId] || '#fff';
      w.arts.forEach((a, idx) => {
        // каждая строка блока — оттенком цеха; у первой строки блока — усиленная верхняя граница (рамка блока)
        const topBorder = idx === 0 ? `border-top:2px solid ${C.chip}` : '';
        h += `<tr style="background:${bg}">
          <td style="padding:6px 12px;border:1px solid ${C.border};${topBorder};font-weight:600">${esc(w.name)}${w.own ? ' <span style="font-size:11px;color:#7a8">свой</span>' : ''}</td>
          <td style="padding:6px 12px;border:1px solid ${C.border};${topBorder}">${artChip(a.art)}</td>
          <td style="padding:6px 12px;border:1px solid ${C.border};${topBorder};text-align:right;font-weight:600">${fmtNum(a.units)}</td>
        </tr>`;
      });
    }
    h += `<tr style="background:${C.total};font-weight:800"><td style="padding:6px 12px;border:1px solid ${C.border}" colspan="2">Итого за ${esc(m.label)}</td><td style="padding:6px 12px;border:1px solid ${C.border};text-align:right">${fmtNum(m.total)}</td></tr>`;
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

function report1Excel(data, fname) {
  const XLSX = window.XLSX;
  const aoa = [['Отчёт — Производство помесячно: цеха × артикулы']];
  aoa.push(['Месяц', 'Цех', 'Артикул', 'Штук']);
  const styleMap = {};
  const HEAD = { font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } }, alignment: { vertical: 'center' } };
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const MONTH = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.month) } } };
  const MONTHNUM = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.month) } }, alignment: { horizontal: 'right' } };
  const GRAND = { font: { bold: true, sz: 13, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const GRANDNUM = { ...GRAND, alignment: { horizontal: 'right' } };
  const wc = data.workshopColors || {};
  let r = 2;
  for (const m of data.workshopMonthly) {
    // строка месяца: название в A, ИТОГ МЕСЯЦА — в столбце D (без промежуточных подытогов)
    aoa.push([m.label, '', '', m.total]);
    for (let c = 0; c < 3; c++) styleMap[XLSX.utils.encode_cell({ r, c })] = MONTH;
    styleMap[XLSX.utils.encode_cell({ r, c: 3 })] = MONTHNUM;
    r++;
    for (const w of m.workshops) {
      const fill = { patternType: 'solid', fgColor: { rgb: hx(wc[w.workshopId] || '#FFFFFF') } }; // уникальный оттенок цеха
      w.arts.forEach((a, i) => {
        aoa.push(['', w.name, a.art, a.units]); // название цеха — в КАЖДОЙ строке артикула
        const bd = XLSX_BORDER();
        if (i === 0) bd.top = { style: 'medium', color: { rgb: hx(C.chip) } }; // рамка сверху блока цеха
        styleMap[XLSX.utils.encode_cell({ r, c: 0 })] = { fill, border: bd };
        styleMap[XLSX.utils.encode_cell({ r, c: 1 })] = { font: { bold: true }, fill, border: bd };
        styleMap[XLSX.utils.encode_cell({ r, c: 2 })] = { font: { bold: true, color: { rgb: hx(C.accent) } }, fill, border: bd };
        styleMap[XLSX.utils.encode_cell({ r, c: 3 })] = { alignment: { horizontal: 'right' }, fill, border: bd };
        r++;
      });
    }
  }
  // ОБЩИЙ ИТОГ в самом конце (в столбце D)
  aoa.push(['ИТОГО', '', '', data.grand.units]);
  for (let c = 0; c < 3; c++) styleMap[XLSX.utils.encode_cell({ r, c })] = GRAND;
  styleMap[XLSX.utils.encode_cell({ r, c: 3 })] = GRANDNUM;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  ws['!cols'] = [{ wch: 20 }, { wch: 26 }, { wch: 12 }, { wch: 14 }];
  styleMap['A1'] = HEAD; styleMap['A2'] = TH; styleMap['B2'] = TH; styleMap['C2'] = TH; styleMap['D2'] = TH;
  styleSheet(ws, styleMap);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Цеха×Артикулы');
  XLSX.writeFile(wb, fname || 'Отчёт_производство_помесячно.xlsx');
}

// лист «Ткань помесячно» (детализация) → worksheet
function fabricMonthlySheet(data) {
  const XLSX = window.XLSX;
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const MONTH = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.month) } } };
  const TOT = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const border = () => ({ border: XLSX_BORDER() });
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
  styleSheet(ws, sm); return ws;
}
// лист «Закупка ткани» (деми + лето) → worksheet
function fabricPurchaseSheet(data) {
  const XLSX = window.XLSX;
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const TOT = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const border = () => ({ border: XLSX_BORDER() });
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
  styleSheet(ws, sm); return ws;
}
function report2aExcel(data, fname) { const X = window.XLSX; const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, fabricMonthlySheet(data), 'Ткань помесячно'); X.writeFile(wb, fname || 'Отчёт_ткань_помесячно.xlsx'); }
function report2bExcel(data, fname) { const X = window.XLSX; const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, fabricPurchaseSheet(data), 'Закупка ткани'); X.writeFile(wb, fname || 'Отчёт_закупка_ткани.xlsx'); }

// ============================ РЕЕСТР ОТЧЁТОВ ============================
// Каждый отчёт: id, имя (для списка/архива), html(data), excel(data,fname), pdfTitle, имя файла.
const REPORTS = [
  { id: 'r1', name: 'Производство помесячно (цеха × артикулы)', html: report1Html, excel: report1Excel, pdfTitle: 'Производство помесячно: цеха × артикулы', file: 'Отчёт_производство.xlsx' },
  { id: 'r2a', name: 'Ткань помесячно (планшет / цвет / метраж)', html: report2aHtml, excel: report2aExcel, pdfTitle: 'Ткань помесячно', file: 'Отчёт_ткань_помесячно.xlsx' },
  { id: 'r2b', name: 'Закупка ткани (консолидация цветов)', html: report2bHtml, excel: report2bExcel, pdfTitle: 'Закупка ткани — консолидация', file: 'Отчёт_закупка_ткани.xlsx' },
];
const reportById = (id) => REPORTS.find((r) => r.id === id) || REPORTS[0];

// заголовок отчёта с датой/временем сохранения (для экрана и печати)
function reportHeaderHtml(rep, savedAtIso) {
  return `<div style="margin:0 0 14px;padding:10px 14px;border-left:4px solid ${C.accent};background:${C.zebra};border-radius:0 8px 8px 0">
    <div style="font-size:17px;font-weight:800;color:${C.head}">${esc(rep.name)}</div>
    <div style="font-size:12px;color:#556">Сформировано на данных системы · <b>${esc(dmyhm(savedAtIso))}</b></div></div>`;
}
function reportExcel(rep, data, savedAtIso) {
  const stamp = dmyhm(savedAtIso).replace(/[.: ]/g, '-');
  const base = rep.file.replace(/\.xlsx$/, '');
  rep.excel(data, `${base}_${stamp}.xlsx`);
}

// ============================ СТРАНИЦА (2 под-вкладки: Отчёты / Архив) ============================
let reportsSubTab = 'build'; // 'build' | 'archive' — сохраняется между перерисовками

export function renderReportsPage(container, state, schedule, ctx = {}) {
  const toast = ctx.toast || (() => {});
  const api = ctx.api;
  let data;
  try { data = buildReportsData(state, schedule); }
  catch (e) { container.innerHTML = `<div style="padding:20px;color:#c0392b">Ошибка сбора отчёта: ${esc(e.message)}</div>`; return; }

  const tabBtn = (id, label) => `<button data-subtab="${id}" style="padding:8px 16px;border:1px solid ${C.border};border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;font-weight:700;font-size:13px;background:${reportsSubTab === id ? '#fff' : C.zebra};color:${reportsSubTab === id ? C.head : '#667'}">${label}</button>`;

  container.innerHTML = `
    <div style="margin:0 0 4px"><div style="font-size:20px;font-weight:800;color:${C.head}">Отчёты</div>
      <div style="color:#667;font-size:13px">Текущие данные: ${fmtNum(data.grand.units)} шт производства · ${fmtNum(data.grand.fabricMeters)} м ткани.</div></div>
    <div style="display:flex;gap:4px;margin:14px 0 0">${tabBtn('build', '📄 Получить отчёт')}${tabBtn('archive', '🗄 Архив')}</div>
    <div id="rep-panel" style="border:1px solid ${C.border};border-radius:0 12px 12px 12px;background:#fff;padding:18px;min-height:200px"></div>`;

  container.querySelectorAll('[data-subtab]').forEach((b) => b.addEventListener('click', () => { reportsSubTab = b.dataset.subtab; renderReportsPage(container, state, schedule, ctx); }));

  const panel = container.querySelector('#rep-panel');
  if (reportsSubTab === 'archive') renderArchive(panel, ctx);
  else renderBuild(panel, data, ctx);
}

// ── под-вкладка «Получить отчёт»: выпадающий список + кнопка ──
function renderBuild(panel, data, ctx) {
  const toast = ctx.toast || (() => {});
  const api = ctx.api;
  panel.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:0 0 6px">
      <div><label style="display:block;font-size:12px;color:#667;margin-bottom:4px">Отчёт</label>
        <select id="rep-sel" style="min-width:340px;padding:7px 10px;border:1px solid ${C.border};border-radius:8px;font-size:13px">
          ${REPORTS.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
        </select></div>
      <button id="rep-get" class="btn btn-accent">Получить отчёт</button>
    </div>
    <div style="color:#889;font-size:12px;margin:0 0 14px">Отчёт строится на текущих данных и автоматически сохраняется в архив с датой и временем.</div>
    <div id="rep-result"></div>`;

  const result = panel.querySelector('#rep-result');
  panel.querySelector('#rep-get').addEventListener('click', async () => {
    const rep = reportById(panel.querySelector('#rep-sel').value);
    let savedAt = new Date().toISOString();
    // авто-сохранение в архив (не блокирует показ, если БД недоступна)
    if (api) {
      try {
        const r = await api('/api/reports/archive', { method: 'POST', body: JSON.stringify({ reportKind: rep.id, label: rep.name, data }) });
        if (r && r.savedAt) savedAt = r.savedAt;
        toast('Отчёт сформирован и сохранён в архив');
      } catch (e) { toast('Отчёт сформирован (в архив не сохранён: ' + e.message + ')', true); }
    }
    showReport(result, rep, data, savedAt, ctx);
  });
}

// показать отчёт (шапка с датой + тело) + кнопки Excel/PDF
function showReport(result, rep, data, savedAtIso, ctx) {
  const toast = (ctx && ctx.toast) || (() => {});
  const body = rep.html(data);
  result.innerHTML = `
    <div style="display:flex;gap:8px;justify-content:flex-end;margin:0 0 10px">
      <button class="btn" id="rep-xlsx">⤓ Excel</button>
      <button class="btn" id="rep-pdf">⤓ PDF</button>
    </div>
    ${reportHeaderHtml(rep, savedAtIso)}
    ${body}`;
  result.querySelector('#rep-xlsx').addEventListener('click', () => {
    if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу', true); return; }
    try { reportExcel(rep, data, savedAtIso); toast('Excel сформирован'); } catch (e) { toast('Ошибка Excel: ' + e.message, true); }
  });
  result.querySelector('#rep-pdf').addEventListener('click', () => printReport(`${rep.pdfTitle} — ${dmyhm(savedAtIso)}`, reportHeaderHtml(rep, savedAtIso) + body));
}

// ── под-вкладка «Архив» ──
async function renderArchive(panel, ctx) {
  const toast = ctx.toast || (() => {});
  const api = ctx.api;
  panel.innerHTML = `<div style="color:#667">Загрузка архива…</div>`;
  if (!api) { panel.innerHTML = `<div style="color:#c0392b">Архив недоступен.</div>`; return; }
  let items = [];
  try { const r = await api('/api/reports/archive'); items = (r && r.items) || []; }
  catch (e) { panel.innerHTML = `<div style="color:#c0392b">Ошибка загрузки архива: ${esc(e.message)}</div>`; return; }

  if (!items.length) { panel.innerHTML = `<div style="color:#889;padding:8px 0">Архив пуст. Сформируйте отчёт во вкладке «Получить отчёт» — он сохранится сюда с датой и временем.</div>`; return; }

  panel.innerHTML = `
    <div style="font-size:13px;color:#667;margin:0 0 12px">Сохранённые отчёты (${items.length}). Данные системы могли меняться — здесь снимок на момент сохранения.</div>
    <div id="arch-view"></div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:${C.th}">
        <th style="text-align:left;padding:8px 12px;border:1px solid ${C.border}">Отчёт</th>
        <th style="text-align:left;padding:8px 12px;border:1px solid ${C.border};width:180px">Дата и время</th>
        <th style="text-align:right;padding:8px 12px;border:1px solid ${C.border};width:280px">Действия</th>
      </tr></thead><tbody>
      ${items.map((it, i) => `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
        <td style="padding:7px 12px;border:1px solid ${C.border};font-weight:600">${esc(reportById(it.reportKind).name)}</td>
        <td style="padding:7px 12px;border:1px solid ${C.border}">${esc(dmyhm(it.savedAt))}</td>
        <td style="padding:7px 12px;border:1px solid ${C.border};text-align:right;white-space:nowrap">
          <button class="btn" data-view="${it.id}">Просмотр</button>
          <button class="btn" data-xlsx="${it.id}">Excel</button>
          <button class="btn" data-pdf="${it.id}">PDF</button>
          <button class="btn btn-subtle" data-del="${it.id}" title="Удалить из архива">✕</button>
        </td></tr>`).join('')}
    </tbody></table>`;

  const viewBox = panel.querySelector('#arch-view');
  const fetchEntry = async (id) => { const r = await api('/api/reports/archive/' + id); return r; };

  panel.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', async () => {
    try { const e = await fetchEntry(b.dataset.view); const rep = reportById(e.reportKind);
      viewBox.innerHTML = `<div style="border:1px solid ${C.border};border-radius:10px;padding:16px;margin:0 0 16px;background:#fff">
        <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 8px"><div style="font-weight:800;color:${C.head}">Просмотр из архива</div><button class="btn btn-subtle" id="arch-close">Закрыть</button></div>
        ${reportHeaderHtml(rep, e.savedAt)}${rep.html(e.data)}</div>`;
      viewBox.querySelector('#arch-close').addEventListener('click', () => { viewBox.innerHTML = ''; });
      viewBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { toast('Ошибка: ' + err.message, true); }
  }));
  panel.querySelectorAll('[data-xlsx]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу', true); return; }
    try { const e = await fetchEntry(b.dataset.xlsx); reportExcel(reportById(e.reportKind), e.data, e.savedAt); toast('Excel сформирован'); }
    catch (err) { toast('Ошибка: ' + err.message, true); }
  }));
  panel.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', async () => {
    try { const e = await fetchEntry(b.dataset.pdf); const rep = reportById(e.reportKind); printReport(`${rep.pdfTitle} — ${dmyhm(e.savedAt)}`, reportHeaderHtml(rep, e.savedAt) + rep.html(e.data)); }
    catch (err) { toast('Ошибка: ' + err.message, true); }
  }));
  panel.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить этот отчёт из архива?')) return;
    try { await api('/api/reports/archive/' + b.dataset.del, { method: 'DELETE' }); toast('Удалено'); renderArchive(panel, ctx); }
    catch (err) { toast('Ошибка: ' + err.message, true); }
  }));
}
