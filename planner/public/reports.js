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
        price: +a.fabricPricePerMeter || 0, // цена ткани, $/м (задаётся на листе «Данные»)
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
  // Если планшет/№ не заданы — консолидируем по НАЗВАНИЮ цвета. Только для закупа; в детализации (2a)
  // остаётся разбивка по артикулам.
  const skuKey = (d) => (d.plansheet || d.colorNo) ? `ps:${d.plansheet || '—'}|cn:${d.colorNo || '—'}` : `col:${String(d.color || '').trim().toLowerCase()}`;
  // Свернуть список потребностей в позиции по ткани (планшет+цвет), суммируя метраж и стоимость.
  const mergeSku = (list) => {
    const by = {};
    for (const d of list) {
      const k = skuKey(d);
      const it = (by[k] || (by[k] = { plansheet: d.plansheet, colorNo: d.colorNo, color: d.color, arts: new Set(), meters: 0, cost: 0 }));
      it.meters += d.meters; it.cost += d.meters * d.price; it.arts.add(d.articleId);
    }
    return Object.values(by).map((x) => ({ plansheet: x.plansheet, colorNo: x.colorNo, color: x.color, arts: [...x.arts].sort((a, b) => artNum(a) - artNum(b)), meters: Math.ceil(x.meters), cost: Math.round(x.cost), price: x.meters ? x.cost / x.meters : 0 }))
      .sort((a, b) => String(a.plansheet).localeCompare(String(b.plansheet)) || String(a.colorNo).localeCompare(String(b.colorNo)) || String(a.color).localeCompare(String(b.color)));
  };
  const sumMeters = (items) => items.reduce((s, i) => s + i.meters, 0);
  const sumCost = (items) => items.reduce((s, i) => s + i.cost, 0);

  // КИТАЙСКИЙ НОВЫЙ ГОД: весь февраль фабрики закрыты — заказать/произвести нельзя. Крайний безопасный
  // заказ перед CNY — начало января. Ткань, которую пришлось бы заказывать в январе–середине марта,
  // заказываем ОДНОЙ партией в начале января (раньше и крупнее). cnyClamp сдвигает дату заказа в мёртвой
  // зоне на 5 января того же года.
  const cnyClamp = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); const dead = (m === 1 && d > 5) || m === 2 || (m === 3 && d <= 15); return dead ? `${y}-01-05` : String(iso).slice(0, 10); };

  // ПЕРИОД закупа: помесячно ('month') или раз в два месяца ('2month', календарные пары: янв–фев, мар–апр…)
  const periodMode = opts.periodMode === '2month' ? '2month' : 'month';
  const periodKey = (m) => { if (periodMode === 'month') return m; const [y, mo] = m.split('-').map(Number); return `${y}-P${Math.floor((mo - 1) / 2)}`; };
  const periodLabel = (key) => { if (periodMode === 'month') return ymLabel(key); const [y, p] = key.split('-P'); const m0 = (+p) * 2 + 1; return `${MONTHS_RU[m0 - 1]}–${MONTHS_RU[m0]} ${y}`; };

  // ДЕМИ: заказ периода = по самому раннему артикулу периода, за МЕСЯЦ до старта; затем CNY-сдвиг.
  // Периоды, чья дата заказа из-за CNY совпала (сдвинулась к 5 января), СЛИВАЮТСЯ в один крупный заказ.
  const demiByPeriod = {};
  for (const d of dem) if (!d.isSummer) (demiByPeriod[periodKey(d.prodMonth)] || (demiByPeriod[periodKey(d.prodMonth)] = [])).push(d);
  const rawDemi = Object.keys(demiByPeriod).sort().map((pk) => {
    const list = demiByPeriod[pk];
    const earliestCut = list.reduce((mn, d) => (d.cutStart < mn ? d.cutStart : mn), list[0].cutStart);
    return { label: periodLabel(pk), purchaseDate: cnyClamp(addMonthsISO(earliestCut, -1)), list, earliestCut };
  });
  const demiByDate = {};
  for (const o of rawDemi) (demiByDate[o.purchaseDate] || (demiByDate[o.purchaseDate] = [])).push(o);
  const demi = Object.keys(demiByDate).sort().map((date) => {
    const grp = demiByDate[date];
    const items = mergeSku(grp.flatMap((o) => o.list));
    const labels = grp.map((o) => o.label);
    const cny = grp.length > 1; // несколько периодов слиты из-за китайского НГ
    return { purchaseDate: date, label: labels.length > 1 ? `${labels[0]} … ${labels[labels.length - 1]}` : labels[0], coversPeriods: labels, cny, items, totalMeters: sumMeters(items), totalCost: sumCost(items) };
  });

  // ЛЕТО: ВСЮ летнюю ткань — ОДНИМ заказом. Размещаем к первому месяцу пошива (самый ранний крой − месяц),
  // но НЕ ПОЗЖЕ начала января (из-за CNY фабрики закрыты весь февраль).
  const summerDem = dem.filter((d) => d.isSummer);
  let summerOrders = [];
  if (summerDem.length) {
    const earliestCut = summerDem.reduce((mn, d) => (d.cutStart < mn ? d.cutStart : mn), summerDem[0].cutStart);
    const items = mergeSku(summerDem);
    summerOrders = [{ purchaseDate: cnyClamp(addMonthsISO(earliestCut, -1)), productionStart: earliestCut, label: 'Летний заказ — весь объём одним этапом', items, totalMeters: sumMeters(items), totalCost: sumCost(items) }];
  }

  // ── цвет-оттенок для каждого цеха (стабильный, уникальный, гармонирует со схемой отчёта) ──
  // Порядок цехов — как в state.workshops, затем прочие. Каждый цех получает свой пастельный оттенок.
  const seenWs = [];
  for (const m of workshopMonthly) for (const w of m.workshops) if (!seenWs.includes(w.workshopId)) seenWs.push(w.workshopId);
  const wsOrder = (state.workshops || []).map((w) => w.id);
  const orderedWs = [...wsOrder.filter((id) => seenWs.includes(id)), ...seenWs.filter((id) => !wsOrder.includes(id))];
  const workshopColors = {};
  orderedWs.forEach((id, i) => { workshopColors[id] = WS_TINTS[i % WS_TINTS.length]; });

  const fabricCost = demi.reduce((s, m) => s + m.totalCost, 0) + summerOrders.reduce((s, o) => s + o.totalCost, 0);
  return {
    workshopMonthly, fabricMonthly, workshopColors,
    fabricPurchase: { demi, summer: summerOrders },
    summerIds: [...summer],
    rates: (opts.rates && typeof opts.rates === 'object') ? opts.rates : null, // курсы валют на момент отчёта
    periodMode,
    grand: {
      units: workshopMonthly.reduce((s, m) => s + m.total, 0),
      fabricMeters: fabricMonthly.reduce((s, m) => s + m.total, 0),
      fabricCost, // $ — суммарная стоимость ткани к закупке
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
          <th style="text-align:right;padding:7px 12px;border:1px solid ${C.border};width:110px">Штук</th>
          <th style="text-align:right;padding:7px 12px;border:1px solid ${C.border};width:120px">Итого</th>
        </tr></thead><tbody>`;
    for (const w of m.workshops) {
      const bg = wc[w.workshopId] || '#fff';
      const n = w.arts.length;
      w.arts.forEach((a, idx) => {
        // рамка блока цеха: сверху у первой строки, снизу у последней
        const tb = idx === 0 ? `border-top:2px solid ${C.chip};` : '';
        const bb = idx === n - 1 ? `border-bottom:2px solid ${C.chip};` : '';
        h += `<tr style="background:${bg}">
          <td style="padding:6px 12px;border:1px solid ${C.border};${tb}${bb}font-weight:600">${esc(w.name)}${w.own ? ' <span style="font-size:11px;color:#7a8">свой</span>' : ''}</td>
          <td style="padding:6px 12px;border:1px solid ${C.border};${tb}${bb}">${artChip(a.art)}</td>
          <td style="padding:6px 12px;border:1px solid ${C.border};${tb}${bb}text-align:right;font-weight:600">${fmtNum(a.units)}</td>
          ${idx === 0 ? `<td rowspan="${n}" style="padding:6px 12px;border:1px solid ${C.border};border-top:2px solid ${C.chip};border-bottom:2px solid ${C.chip};text-align:right;vertical-align:middle;font-weight:800;font-size:14px;color:${C.head}">${fmtNum(w.total)}</td>` : ''}
        </tr>`;
      });
    }
    h += `<tr style="background:${C.total};font-weight:800"><td style="padding:6px 12px;border:1px solid ${C.border}" colspan="3">Итого за ${esc(m.label)}</td><td style="padding:6px 12px;border:1px solid ${C.border};text-align:right">${fmtNum(m.total)}</td></tr>`;
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

const usdSum = (n) => '$' + fmtNum(Math.round(n || 0));
const price2 = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const convStr = (costUsd, rates) => rates ? `<span style="color:#667;font-weight:500"> · ${fmtNum(Math.round(costUsd * rates.usdKgs))} сом · ${fmtNum(Math.round(costUsd * rates.usdRub))} ₽</span>` : '';

// одна карточка-заказ (шапка «когда/сколько» + таблица позиций по ткани) — общая для деми и лета
function orderCardHtml(order, R, summer) {
  const head = summer ? C.summer : C.month;
  const th = summer ? C.thSummer : C.th;
  const zebra = summer ? C.totalSummer : C.zebra;
  const extra = summer && order.productionStart ? ` · старт пошива ${dmy(order.productionStart)}` : '';
  const cnyNote = order.cny ? ` <span style="background:#fff3;padding:1px 6px;border-radius:10px;font-size:11px">↤ перенесено под кит. Новый год</span>` : '';
  let h = `<div style="margin:0 0 18px">
    <div style="background:${head};color:#fff;font-weight:700;padding:7px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <span>${esc(order.label)}${cnyNote}</span><span>заказать: <b>${dmy(order.purchaseDate)}</b>${extra} · ${fmtNum(order.totalMeters)} м · <b>${usdSum(order.totalCost)}</b>${convStr(order.totalCost, R)}</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:${th}">
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">Планшет</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:80px">№ цвета</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:110px">Цвет</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Артикулы</th>
        <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:100px">Метраж, м</th>
        <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:90px">Цена, $/м</th>
        <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:120px">Сумма, $</th>
      </tr></thead><tbody>`;
  order.items.forEach((it, i) => {
    h += `<tr style="background:${i % 2 ? zebra : '#fff'}">
      <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:600">${esc(it.plansheet || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(it.colorNo || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(it.color || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${it.arts.map(artChip).join(', ')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(it.meters)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${price2(it.price)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right;font-weight:600">${usdSum(it.cost)}</td>
    </tr>`;
  });
  h += `<tr style="background:${summer ? C.totalSummer : C.total};font-weight:700"><td colspan="4" style="padding:5px 10px;border:1px solid ${C.border}">Итого заказ · ${dmy(order.purchaseDate)}</td><td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(order.totalMeters)}</td><td style="padding:5px 10px;border:1px solid ${C.border}"></td><td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${usdSum(order.totalCost)}${convStr(order.totalCost, R)}</td></tr>`;
  return h + `</tbody></table></div>`;
}

function report2bHtml(data) {
  const P = data.fabricPurchase; const R = data.rates;
  const noRate = R ? '' : ` <span style="color:${C.summer}">(курс не загружен — суммы только в $)</span>`;
  let h = `<div style="margin:0 0 10px;color:#556;font-size:13px">Ткань одного <b>планшета и цвета</b> из разных артикулов сложена вместе. Демисезон: закупка по <b>самому раннему артикулу периода — за месяц</b> до старта. Лето: <b>весь объём одним заказом</b>. Учтён <b>китайский Новый год</b> — в феврале фабрики закрыты, такие заказы перенесены на начало января. Стоимость ткани — из «Данных» ($/м).${noRate}</div>`;
  // ДЕМИ
  h += `<div style="font-weight:800;color:${C.head};font-size:15px;margin:14px 0 8px">🧵 Демисезон — консолидация по периодам${data.periodMode === '2month' ? ' (раз в 2 месяца)' : ' (помесячно)'}</div>`;
  if (!P.demi.length) h += `<div style="color:#889;padding:6px 0">нет демисезонной ткани</div>`;
  for (const m of P.demi) h += orderCardHtml(m, R, false);
  // ЛЕТО
  h += `<div style="font-weight:800;color:${C.summer};font-size:15px;margin:22px 0 8px">☀️ Летние (сезонные) — весь объём одним заказом (≤ начало января)</div>`;
  if (!P.summer.length) h += `<div style="color:#889;padding:6px 0">нет летней ткани</div>`;
  for (const o of P.summer) h += orderCardHtml(o, R, true);
  // ОБЩИЙ ИТОГ по стоимости ткани
  h += `<div style="margin:18px 0 0;padding:12px 16px;background:${C.total};border:1px solid ${C.border};border-radius:10px;font-size:15px;font-weight:800;color:${C.head}">
    Итого стоимость ткани к закупке: ${usdSum(data.grand.fabricCost)}${R ? ` <span style="font-weight:600;color:#556">≈ ${fmtNum(Math.round(data.grand.fabricCost * R.usdKgs))} сом · ${fmtNum(Math.round(data.grand.fabricCost * R.usdRub))} ₽</span>` : ''}</div>`;
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
  aoa.push(['Месяц', 'Цех', 'Артикул', 'Штук', 'Итого']); // все итоги — в столбце E
  const styleMap = {};
  const cell = (rr, c) => XLSX.utils.encode_cell({ r: rr, c });
  const HEAD = { font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } }, alignment: { vertical: 'center' } };
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const MONTH = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.month) } } };
  const MONTHNUM = { ...MONTH, alignment: { horizontal: 'right' } };
  const GRAND = { font: { bold: true, sz: 13, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const GRANDNUM = { ...GRAND, alignment: { horizontal: 'right' } };
  const wc = data.workshopColors || {};
  const merges = []; // объединения ячеек столбца E (итог цеха) по блокам
  let r = 2;
  for (const m of data.workshopMonthly) {
    // строка месяца: название в A, ИТОГ МЕСЯЦА — в столбце E
    aoa.push([m.label, '', '', '', m.total]);
    for (let c = 0; c < 4; c++) styleMap[cell(r, c)] = MONTH;
    styleMap[cell(r, 4)] = MONTHNUM;
    r++;
    for (const w of m.workshops) {
      const fill = { patternType: 'solid', fgColor: { rgb: hx(wc[w.workshopId] || '#FFFFFF') } }; // уникальный оттенок цеха
      const startR = r;
      const n = w.arts.length;
      w.arts.forEach((a, i) => {
        // итог цеха — ОДНОЙ цифрой в столбце E, объединённой на все строки артикулов цеха (без строки «Итого»)
        aoa.push(['', w.name, a.art, a.units, i === 0 ? w.total : '']);
        const bd = XLSX_BORDER();
        if (i === 0) bd.top = { style: 'medium', color: { rgb: hx(C.chip) } };      // рамка сверху блока цеха
        if (i === n - 1) bd.bottom = { style: 'medium', color: { rgb: hx(C.chip) } }; // и снизу — закрыть блок
        styleMap[cell(r, 0)] = { fill, border: bd };
        styleMap[cell(r, 1)] = { font: { bold: true }, fill, border: bd };
        styleMap[cell(r, 2)] = { font: { bold: true, color: { rgb: hx(C.accent) } }, fill, border: bd };
        styleMap[cell(r, 3)] = { alignment: { horizontal: 'right' }, fill, border: bd };
        // объединённая E: рамка блока по всей высоте (сверху/снизу — medium), цифра итога по центру
        const ebd = { ...XLSX_BORDER(), top: { style: 'medium', color: { rgb: hx(C.chip) } }, bottom: { style: 'medium', color: { rgb: hx(C.chip) } } };
        styleMap[cell(r, 4)] = { fill, border: ebd, font: { bold: true, sz: 12, color: { rgb: hx(C.head) } }, alignment: { horizontal: 'right', vertical: 'center' } };
        r++;
      });
      if (n > 1) merges.push({ s: { r: startR, c: 4 }, e: { r: startR + n - 1, c: 4 } }); // объединяем E на весь блок цеха
    }
  }
  // ОБЩИЙ ИТОГ в самом конце (в столбце E)
  aoa.push(['ИТОГО', '', '', '', data.grand.units]);
  for (let c = 0; c < 4; c++) styleMap[cell(r, c)] = GRAND;
  styleMap[cell(r, 4)] = GRANDNUM;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, ...merges];
  ws['!cols'] = [{ wch: 20 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
  for (let c = 0; c < 5; c++) styleMap[cell(1, c)] = TH;
  styleMap['A1'] = HEAD;
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
// лист закупки для набора заказов (демисезон ИЛИ лето) → worksheet. 7 колонок.
function ordersSheet(orders, opts) {
  const XLSX = window.XLSX;
  const R = opts.rates; const isSummer = !!opts.summer;
  const cc = (rr, c) => XLSX.utils.encode_cell({ r: rr, c });
  const NCOL = 7; // Планшет, №цвета, Цвет, Артикулы, Метраж, Цена $/м, Сумма $
  const bannerBg = isSummer ? hx(C.summer) : hx(C.month);
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(isSummer ? C.thSummer : C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const BANNER = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: bannerBg } } };
  const TOT = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: hx(isSummer ? C.totalSummer : C.total) } }, border: XLSX_BORDER() };
  const RIGHT = () => ({ alignment: { horizontal: 'right' }, border: XLSX_BORDER() });
  const border = () => ({ border: XLSX_BORDER() });
  const aoa = [[opts.title]]; const sm = {}; const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NCOL - 1 } }];
  sm.A1 = { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } } };
  let r = 1;
  let allCost = 0, allMeters = 0;
  for (const o of orders) {
    const extra = isSummer && o.productionStart ? ` · старт пошива ${dmy(o.productionStart)}` : '';
    aoa.push([`${o.label} · заказать ${dmy(o.purchaseDate)}${extra} · ${o.totalMeters} м · $${o.totalCost}${o.cny ? ' · перенесено под кит. Новый год' : ''}`]);
    for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = BANNER; merges.push({ s: { r, c: 0 }, e: { r, c: NCOL - 1 } }); r++;
    aoa.push(['Планшет', '№ цвета', 'Цвет', 'Артикулы', 'Метраж, м', 'Цена, $/м', 'Сумма, $']);
    for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = TH; r++;
    for (const it of o.items) {
      aoa.push([it.plansheet || '—', it.colorNo || '—', it.color || '—', it.arts.join(', '), it.meters, Math.round(it.price * 100) / 100, it.cost]);
      for (const c of [0, 1, 2, 3]) sm[cc(r, c)] = border();
      for (const c of [4, 5, 6]) sm[cc(r, c)] = RIGHT();
      r++;
    }
    aoa.push(['Итого заказ', '', '', '', o.totalMeters, '', o.totalCost]);
    for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = TOT;
    sm[cc(r, 4)] = { ...TOT, alignment: { horizontal: 'right' } }; sm[cc(r, 6)] = { ...TOT, alignment: { horizontal: 'right' } };
    r++; aoa.push([]); r++;
    allCost += o.totalCost; allMeters += o.totalMeters;
  }
  // итог листа + пересчёт по курсу
  const conv = R ? `  ≈ ${Math.round(allCost * R.usdKgs)} сом · ${Math.round(allCost * R.usdRub)} ₽` : '';
  aoa.push([`ИТОГО ${isSummer ? 'лето' : 'демисезон'}:${conv}`, '', '', '', allMeters, '', allCost]);
  const GT = { font: { bold: true, sz: 12, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = GT;
  sm[cc(r, 4)] = { ...GT, alignment: { horizontal: 'right' } }; sm[cc(r, 6)] = { ...GT, alignment: { horizontal: 'right' } };
  merges.push({ s: { r, c: 0 }, e: { r, c: 3 } });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 11 }, { wch: 13 }];
  styleSheet(ws, sm); return ws;
}
function report2aExcel(data, fname) { const X = window.XLSX; const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, fabricMonthlySheet(data), 'Ткань помесячно'); X.writeFile(wb, fname || 'Отчёт_ткань_помесячно.xlsx'); }
function report2bExcel(data, fname) {
  const X = window.XLSX; const wb = X.utils.book_new();
  // сезон (демисезон) и лето — на РАЗНЫХ листах
  X.utils.book_append_sheet(wb, ordersSheet(data.fabricPurchase.demi, { title: `ДЕМИСЕЗОН — закупка ткани${data.periodMode === '2month' ? ' (раз в 2 месяца)' : ' (помесячно)'}`, rates: data.rates, summer: false }), 'Демисезон');
  X.utils.book_append_sheet(wb, ordersSheet(data.fabricPurchase.summer, { title: 'ЛЕТО — закупка ткани (весь объём одним заказом)', rates: data.rates, summer: true }), 'Лето');
  X.writeFile(wb, fname || 'Отчёт_закупка_ткани.xlsx');
}

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

// ============================ КУРСЫ ВАЛЮТ ============================
let currencyRates = null; // null — не загружено; объект — курсы; false — ошибка загрузки
const cur2 = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cur4 = (n) => (Math.round((+n || 0) * 10000) / 10000).toLocaleString('ru', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function currencyBarHtml() {
  const r = currencyRates;
  const chip = (txt) => `<span style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid ${C.border};border-radius:20px;padding:5px 12px;font-size:13px;font-weight:600;color:${C.head}">${txt}</span>`;
  let body;
  if (r && typeof r === 'object') {
    body = `${chip(`$1 = <b>${cur2(r.usdKgs)}</b> сом`)}${chip(`₽1 = <b>${cur4(r.rubKgs)}</b> сом`)}${chip(`$1 = <b>${cur2(r.usdRub)}</b> ₽`)}
      <span style="font-size:11px;color:#889">${esc(r.source || '')}${r.rateDate ? ' · курс на ' + dmy(r.rateDate) : ''}</span>`;
  } else if (r === false) {
    body = `<span style="color:${C.summer};font-size:13px">Курс не загружен — нажмите «Обновить курс»</span>`;
  } else {
    body = `<span style="color:#889;font-size:13px">Загрузка курса…</span>`;
  }
  return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 0;padding:10px 12px;background:${C.zebra};border:1px solid ${C.border};border-radius:10px">
    <span style="font-weight:700;color:${C.head};font-size:13px">💱 Курсы валют:</span>${body}
    <button id="cur-refresh" class="btn btn-subtle" style="margin-left:auto">↻ Обновить курс</button></div>`;
}

// ============================ СТРАНИЦА (2 под-вкладки: Отчёты / Архив) ============================
let reportsSubTab = 'build';       // 'build' | 'archive' — сохраняется между перерисовками
let reportPeriodMode = 'month';    // 'month' | '2month' — период закупа ткани

export function renderReportsPage(container, state, schedule, ctx = {}) {
  const toast = ctx.toast || (() => {});
  const api = ctx.api;
  const rerender = () => renderReportsPage(container, state, schedule, ctx);
  const buildWith = () => buildReportsData(state, schedule, { rates: (currencyRates && typeof currencyRates === 'object') ? currencyRates : null, periodMode: reportPeriodMode });
  const ctx2 = { ...ctx, rerender, rebuild: buildWith };
  let data;
  try { data = buildWith(); }
  catch (e) { container.innerHTML = `<div style="padding:20px;color:#c0392b">Ошибка сбора отчёта: ${esc(e.message)}</div>`; return; }

  const tabBtn = (id, label) => `<button data-subtab="${id}" style="padding:8px 16px;border:1px solid ${C.border};border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;font-weight:700;font-size:13px;background:${reportsSubTab === id ? '#fff' : C.zebra};color:${reportsSubTab === id ? C.head : '#667'}">${label}</button>`;

  container.innerHTML = `
    <div style="margin:0 0 4px"><div style="font-size:20px;font-weight:800;color:${C.head}">Отчёты</div>
      <div style="color:#667;font-size:13px">Текущие данные: ${fmtNum(data.grand.units)} шт производства · ${fmtNum(data.grand.fabricMeters)} м ткани.</div></div>
    ${currencyBarHtml()}
    <div style="display:flex;gap:4px;margin:14px 0 0">${tabBtn('build', '📄 Получить отчёт')}${tabBtn('archive', '🗄 Архив')}</div>
    <div id="rep-panel" style="border:1px solid ${C.border};border-radius:0 12px 12px 12px;background:#fff;padding:18px;min-height:200px"></div>`;

  container.querySelectorAll('[data-subtab]').forEach((b) => b.addEventListener('click', () => { reportsSubTab = b.dataset.subtab; rerender(); }));
  container.querySelector('#cur-refresh')?.addEventListener('click', async () => {
    if (!api) return;
    try { const r = await api('/api/currency/refresh', { method: 'POST' }); currencyRates = (r && r.rates) || false; toast('Курс обновлён'); }
    catch (e) { currencyRates = currencyRates || false; toast('Не удалось обновить курс: ' + e.message, true); }
    rerender();
  });

  // первичная загрузка курса (один раз): подтягиваем закэшированный, затем перерисовываем
  if (currencyRates === null && api) {
    currencyRates = undefined; // помечаем «загрузка идёт», чтобы не дёргать повторно
    api('/api/currency').then((r) => { currencyRates = (r && r.rates) || false; rerender(); })
      .catch(() => { currencyRates = false; rerender(); });
  }

  const panel = container.querySelector('#rep-panel');
  if (reportsSubTab === 'archive') renderArchive(panel, ctx2);
  else renderBuild(panel, data, ctx2);
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
    <div style="color:#889;font-size:12px;margin:0 0 14px">Отчёт строится на текущих данных. В архив он попадёт только после нажатия «Сохранить отчёт».</div>
    <div id="rep-result"></div>`;

  const result = panel.querySelector('#rep-result');
  panel.querySelector('#rep-get').addEventListener('click', () => {
    const rep = reportById(panel.querySelector('#rep-sel').value);
    showReport(result, rep, ctx.rebuild ? ctx.rebuild() : data, new Date().toISOString(), ctx); // текущие данные, БЕЗ авто-сохранения
  });
}

// показать отчёт (шапка с датой + тело) + кнопки Сохранить/Excel/PDF
function showReport(result, rep, data, genAtIso, ctx) {
  const toast = (ctx && ctx.toast) || (() => {});
  const api = ctx && ctx.api;
  const body = rep.html(data);
  // период закупа — ТОЛЬКО для отчёта «Закупка ткани», выбирается прямо в открытом отчёте
  const periodCtl = rep.id === 'r2b'
    ? `<div style="display:flex;align-items:center;gap:8px;margin-right:auto;font-size:13px;color:#556">Период закупа:
        <select id="rep-period" style="padding:6px 10px;border:1px solid ${C.border};border-radius:8px;font-size:13px">
          <option value="month"${reportPeriodMode === 'month' ? ' selected' : ''}>Помесячно</option>
          <option value="2month"${reportPeriodMode === '2month' ? ' selected' : ''}>Раз в 2 месяца</option>
        </select></div>` : '';
  result.innerHTML = `
    <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin:0 0 10px">
      ${periodCtl}
      <button class="btn btn-accent" id="rep-save">💾 Сохранить отчёт</button>
      <button class="btn" id="rep-xlsx">⤓ Excel</button>
      <button class="btn" id="rep-pdf">⤓ PDF</button>
    </div>
    ${reportHeaderHtml(rep, genAtIso)}
    ${body}`;
  result.querySelector('#rep-period')?.addEventListener('change', (e) => {
    reportPeriodMode = e.target.value === '2month' ? '2month' : 'month';
    showReport(result, rep, ctx.rebuild ? ctx.rebuild() : data, genAtIso, ctx); // пересобрать этот отчёт с новым периодом
  });
  const saveBtn = result.querySelector('#rep-save');
  saveBtn.addEventListener('click', async () => {
    if (!api) { toast('Сохранение недоступно', true); return; }
    saveBtn.disabled = true;
    try {
      const r = await api('/api/reports/archive', { method: 'POST', body: JSON.stringify({ reportKind: rep.id, label: rep.name, data }) });
      saveBtn.textContent = `✓ Сохранено ${dmyhm((r && r.savedAt) || genAtIso)}`;
      saveBtn.classList.remove('btn-accent');
      toast('Отчёт сохранён в архив');
    } catch (e) { saveBtn.disabled = false; toast('Не удалось сохранить: ' + e.message, true); }
  });
  result.querySelector('#rep-xlsx').addEventListener('click', () => {
    if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу', true); return; }
    try { reportExcel(rep, data, genAtIso); toast('Excel сформирован'); } catch (e) { toast('Ошибка Excel: ' + e.message, true); }
  });
  result.querySelector('#rep-pdf').addEventListener('click', () => printReport(`${rep.pdfTitle} — ${dmyhm(genAtIso)}`, reportHeaderHtml(rep, genAtIso) + body));
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
