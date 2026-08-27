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
  // локальная закупка (рынок Мадина, Бишкек) — зелёный акцент
  bishkek: '#2f855a', thBishkek: '#e2f3ea', totalBishkek: '#eaf7ef',
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

  // ЛОКАЛЬНАЯ ЗАКУПКА: ткань для пошива в АВГУСТЕ и СЕНТЯБРЕ покупаем не в Китае, а на рынке Мадина
  // (Бишкек) — не успеваем заказать в Китае. Цена в Бишкеке ВЫШЕ на $0.40/м.
  const BISHKEK_MONTHS = new Set((opts.bishkekMonths && opts.bishkekMonths.length) ? opts.bishkekMonths.map(String) : ['08', '09']);
  const BISHKEK_MARKUP = (opts.bishkekMarkup != null && isFinite(+opts.bishkekMarkup)) ? +opts.bishkekMarkup : 0.40;

  // ── потребности в ткани из циклов (по цвету), с планшет/№цвета и датами ──
  let dem = [];
  for (const c of cycles) {
    const a = artById[c.articleId]; if (!a) continue;
    const M = c.batchMatrix || {};
    for (const color of Object.keys(M)) {
      const units = sumRow(M[color]); if (units <= 0) continue;
      const fi = (a.fabricInfo && a.fabricInfo[color]) || {};
      const prodMonth = prodMonthOf(c);
      const isBishkek = BISHKEK_MONTHS.has(prodMonth.slice(5, 7)); // пошив в авг/сен → локальная закупка
      dem.push({
        articleId: c.articleId, articleName: a.name || '', color,
        plansheet: (fi.plansheet || '').trim(), colorNo: (fi.colorNo || '').trim(),
        image: (fi.image || ''), // образец ткани (изображение) из карточки артикула
        meters: units * (+a.fabricPerUnit || 0) * wastageMul, units,
        price: (+a.fabricPricePerMeter || 0) + (isBishkek ? BISHKEK_MARKUP : 0), // Бишкек: +$0.40/м
        source: isBishkek ? 'bishkek' : 'china',
        prodMonth, cutStart: c.cutStart || (c.ops && c.ops.cut && c.ops.cut.start),
        orderBy: (c.fabric && c.fabric.orderDate) || c.cutStart,
        isSummer: summer.has(String(c.articleId).trim()),
      });
    }
  }

  // ── ОБРАЗЦЫ ТКАНИ и КОНФЛИКТЫ: ключ ткани = «планшет + № цвета» (иначе — по названию цвета).
  // Если для одного и того же ключа заведены РАЗНЫЕ изображения — это конфликт (подсветим красным). ──
  const skuKey = (d) => (d.plansheet || d.colorNo) ? `ps:${d.plansheet || '—'}|cn:${d.colorNo || '—'}` : `col:${String(d.color || '').trim().toLowerCase()}`;
  const skuImages = {};
  for (const d of dem) { const k = skuKey(d); (skuImages[k] || (skuImages[k] = new Set())); if (d.image) skuImages[k].add(d.image); }
  const skuImageList = (k) => (skuImages[k] ? [...skuImages[k]] : []);
  const skuConflict = (k) => (skuImages[k] ? skuImages[k].size > 1 : false);

  // ── ФИЛЬТРЫ отчётов по ткани (планшет / артикул / месяц). Списки — из ПОЛНОГО набора (стабильны).
  // При активном фильтре отчёты по ткани показывают КОНСОЛИДИРОВАННЫЙ вид. Конфликты образцов —
  // глобальные (skuImages выше построен до фильтрации), чтобы предупреждение не пропадало. ──
  const fabricFilters = {
    plansheets: [...new Set(dem.map((d) => d.plansheet).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')),
    articles: [...new Map(dem.map((d) => [d.articleId, d.articleName])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => artNum(a.id) - artNum(b.id)),
    months: [...new Set(dem.map((d) => d.prodMonth))].sort().map((m) => ({ ym: m, label: ymLabel(m) })),
  };
  // фильтры — МНОЖЕСТВЕННЫЙ выбор (массивы). Пустой набор = «все».
  const F = opts.filters || {};
  const asArr = (a, single) => Array.isArray(a) ? a.filter(Boolean) : (single ? [single] : []);
  const fPlans = asArr(F.plansheets, F.plansheet);
  const fArts = asArr(F.articleIds, F.articleId);
  const fMonths = asArr(F.months, F.month);
  const filtered = !!(fPlans.length || fArts.length || fMonths.length);
  if (filtered) dem = dem.filter((d) => (!fPlans.length || fPlans.includes(d.plansheet)) && (!fArts.length || fArts.includes(d.articleId)) && (!fMonths.length || fMonths.includes(d.prodMonth)));

  // ── Отчёт 2a: помесячная детализация ткани (месяц × артикул × планшет × №цвета × метраж) ──
  const r2 = {};
  for (const d of dem) {
    const mm = (r2[d.prodMonth] || (r2[d.prodMonth] = {}));
    const k = `${d.articleId}|${d.plansheet}|${d.colorNo}|${d.color}`;
    const row = (mm[k] || (mm[k] = { articleId: d.articleId, articleName: d.articleName, color: d.color, plansheet: d.plansheet, colorNo: d.colorNo, image: d.image, meters: 0, units: 0, isSummer: d.isSummer }));
    row.meters += d.meters; row.units += d.units;
  }
  const fabricMonthly = Object.keys(r2).sort().map((m) => {
    const rows = Object.values(r2[m]).map((x) => ({ ...x, meters: Math.ceil(x.meters), imageConflict: skuConflict(skuKey(x)) }))
      .sort((a, b) => artNum(a.articleId) - artNum(b.articleId) || String(a.plansheet).localeCompare(String(b.plansheet)) || String(a.colorNo).localeCompare(String(b.colorNo)));
    return { ym: m, label: ymLabel(m), rows, total: rows.reduce((s, r) => s + r.meters, 0) };
  });

  // ── Отчёт 2b: КОНСОЛИДАЦИЯ ЗАКУПКИ ──
  // Ключ ткани = «планшет + № цвета» (одна и та же ткань в РАЗНЫХ артикулах складывается вместе).
  // Если планшет/№ не заданы — консолидируем по НАЗВАНИЮ цвета. Только для закупа; в детализации (2a)
  // остаётся разбивка по артикулам.
  // Свернуть список потребностей в позиции по ткани (планшет+цвет), суммируя метраж и стоимость.
  // К каждой позиции прикладываем образцы ткани (все уникальные) и флаг конфликта (разные образцы).
  const mergeSku = (list) => {
    const by = {};
    for (const d of list) {
      const k = skuKey(d);
      const it = (by[k] || (by[k] = { plansheet: d.plansheet, colorNo: d.colorNo, color: d.color, arts: new Set(), meters: 0, cost: 0 }));
      it.meters += d.meters; it.cost += d.meters * d.price; it.arts.add(d.articleId);
    }
    return Object.values(by).map((x) => { const k = skuKey(x); return { plansheet: x.plansheet, colorNo: x.colorNo, color: x.color, arts: [...x.arts].sort((a, b) => artNum(a) - artNum(b)), meters: Math.ceil(x.meters), cost: Math.round(x.cost), price: x.meters ? x.cost / x.meters : 0, images: skuImageList(k), imageConflict: skuConflict(k) }; })
      .sort((a, b) => String(a.plansheet).localeCompare(String(b.plansheet)) || String(a.colorNo).localeCompare(String(b.colorNo)) || String(a.color).localeCompare(String(b.color)));
  };
  const sumMeters = (items) => items.reduce((s, i) => s + i.meters, 0);
  const sumCost = (items) => items.reduce((s, i) => s + i.cost, 0);

  // КИТАЙСКИЙ НОВЫЙ ГОД: весь февраль фабрики закрыты — заказать/произвести нельзя. Крайний безопасный
  // заказ перед CNY — начало января. Ткань, которую пришлось бы заказывать в январе–середине марта,
  // заказываем ОДНОЙ партией в начале января (раньше и крупнее). cnyClamp сдвигает дату заказа в мёртвой
  // зоне на 5 января того же года.
  const cnyClamp = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); const dead = (m === 1 && d > 5) || m === 2 || (m === 3 && d <= 15); return dead ? `${y}-01-05` : String(iso).slice(0, 10); };
  const isCnyBlocked = (iso) => cnyClamp(iso) !== String(iso).slice(0, 10); // дата заказа упала в мёртвую зону (фев/CNY)
  const subDaysISO = (iso, n) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const CHINA_LEAD_DAYS = 30; // Китай: полный месяц до старта пошива
  const BISHKEK_LEAD_DAYS = 7; // Мадина (Бишкек): местный рынок — закупаем в течение недели

  // ПЕРИОД закупа: помесячно ('month') или раз в два месяца ('2month', календарные пары: янв–фев, мар–апр…)
  const periodMode = opts.periodMode === '2month' ? '2month' : 'month';
  const periodKey = (m) => { if (periodMode === 'month') return m; const [y, mo] = m.split('-').map(Number); return `${y}-P${Math.floor((mo - 1) / 2)}`; };
  const periodLabel = (key) => { if (periodMode === 'month') return ymLabel(key); const [y, p] = key.split('-P'); const m0 = (+p) * 2 + 1; return `${MONTHS_RU[m0 - 1]}–${MONTHS_RU[m0]} ${y}`; };

  // ДЕМИ: заказ периода = по самому раннему артикулу периода, за МЕСЯЦ до старта; затем CNY-сдвиг.
  // Периоды, чья дата заказа из-за CNY совпала (сдвинулась к 5 января), СЛИВАЮТСЯ в один крупный заказ.
  const demiByPeriod = {};
  for (const d of dem) if (!d.isSummer && d.source !== 'bishkek') (demiByPeriod[periodKey(d.prodMonth)] || (demiByPeriod[periodKey(d.prodMonth)] = [])).push(d);
  const rawDemi = Object.keys(demiByPeriod).sort().map((pk) => {
    const list = demiByPeriod[pk];
    const earliestCut = list.reduce((mn, d) => (d.cutStart < mn ? d.cutStart : mn), list[0].cutStart);
    return { label: periodLabel(pk), purchaseDate: cnyClamp(subDaysISO(earliestCut, CHINA_LEAD_DAYS)), list, earliestCut }; // полный месяц до старта пошива
  });
  const demiByDate = {};
  for (const o of rawDemi) (demiByDate[o.purchaseDate] || (demiByDate[o.purchaseDate] = [])).push(o);
  const demi = Object.keys(demiByDate).sort().map((date) => {
    const grp = demiByDate[date];
    const items = mergeSku(grp.flatMap((o) => o.list));
    const labels = grp.map((o) => o.label);
    const cny = grp.length > 1; // несколько периодов слиты из-за китайского НГ
    const arrival = grp.reduce((mn, o) => (o.earliestCut < mn ? o.earliestCut : mn), grp[0].earliestCut); // когда ткань нужна на производстве
    return { purchaseDate: date, arrival, label: labels.length > 1 ? `${labels[0]} … ${labels[labels.length - 1]}` : labels[0], coversPeriods: labels, cny, items, totalMeters: sumMeters(items), totalCost: sumCost(items) };
  });

  // ЛЕТО: в ДВА этапа. Этап 1 — ранний (по дате первого пошива, за месяц до него) — вся ткань, которую
  // можно заказать в Китае ДО новогодней мёртвой зоны. Этап 2 — в начале января (5 янв), вся остальная
  // летняя ткань (её заказ иначе упал бы на закрытый февраль). Авг/сен-лето уходит в блок Бишкека.
  const summerDem = dem.filter((d) => d.isSummer && d.source !== 'bishkek');
  const mkSummerOrder = (list, date, label) => { const ec = list.reduce((mn, d) => (d.cutStart < mn ? d.cutStart : mn), list[0].cutStart); const items = mergeSku(list); return { purchaseDate: date(ec), productionStart: ec, arrival: ec, label, items, totalMeters: sumMeters(items), totalCost: sumCost(items) }; };
  const summerStage1 = summerDem.filter((d) => !isCnyBlocked(subDaysISO(d.cutStart, CHINA_LEAD_DAYS))); // заказ до CNY — ранний этап
  const summerStage2 = summerDem.filter((d) => isCnyBlocked(subDaysISO(d.cutStart, CHINA_LEAD_DAYS)));  // заказ упёрся бы в февраль → начало января
  const summerOrders = [];
  if (summerStage1.length) summerOrders.push(mkSummerOrder(summerStage1, (ec) => subDaysISO(ec, CHINA_LEAD_DAYS), 'Летний заказ — этап 1 (ранний, по первому пошиву)'));
  if (summerStage2.length) summerOrders.push(mkSummerOrder(summerStage2, (ec) => cnyClamp(subDaysISO(ec, CHINA_LEAD_DAYS)), 'Летний заказ — этап 2 (начало января, перед китайским НГ)'));

  // БИШКЕК (рынок Мадина): ткань для пошива в авг/сен — местная закупка (+$0.40/м). Заказ по месяцу
  // производства, покупаем к началу месяца пошива (местный рынок — довоз быстрый).
  const bishkekByMonth = {};
  for (const d of dem) if (d.source === 'bishkek') (bishkekByMonth[d.prodMonth] || (bishkekByMonth[d.prodMonth] = [])).push(d);
  const bishkek = Object.keys(bishkekByMonth).sort().map((m) => {
    const list = bishkekByMonth[m];
    const earliestCut = list.reduce((mn, d) => (d.cutStart < mn ? d.cutStart : mn), list[0].cutStart);
    const items = mergeSku(list);
    return { purchaseDate: subDaysISO(earliestCut, BISHKEK_LEAD_DAYS), arrival: earliestCut, label: `Пошив ${ymLabel(m)}`, items, totalMeters: sumMeters(items), totalCost: sumCost(items) }; // за неделю до пошива
  });

  // ── цвет-оттенок для каждого цеха (стабильный, уникальный, гармонирует со схемой отчёта) ──
  // Порядок цехов — как в state.workshops, затем прочие. Каждый цех получает свой пастельный оттенок.
  const seenWs = [];
  for (const m of workshopMonthly) for (const w of m.workshops) if (!seenWs.includes(w.workshopId)) seenWs.push(w.workshopId);
  const wsOrder = (state.workshops || []).map((w) => w.id);
  const orderedWs = [...wsOrder.filter((id) => seenWs.includes(id)), ...seenWs.filter((id) => !wsOrder.includes(id))];
  const workshopColors = {};
  orderedWs.forEach((id, i) => { workshopColors[id] = WS_TINTS[i % WS_TINTS.length]; });

  const fabricCost = demi.reduce((s, m) => s + m.totalCost, 0) + summerOrders.reduce((s, o) => s + o.totalCost, 0) + bishkek.reduce((s, o) => s + o.totalCost, 0);

  // ── ПРОВЕРКА ПОЛНОТЫ: сверяем план (по партиям) с тем, что реально вошло в производство (циклы) ──
  // Показывает артикулы, которые НЕ попали в отчёт (не размещены планировщиком / в архиве / покрыты
  // остатками / нет партий) и где нетто заметно меньше плана.
  const sumMat = (M) => { let s = 0; for (const c of Object.keys(M || {})) s += sumRow(M[c]); return s; };
  const plannedByArt = {};
  for (const p of state.partias || []) { if (p.historical) continue; const u = sumMat(p.planMatrix); if (u > 0) plannedByArt[p.articleId] = (plannedByArt[p.articleId] || 0) + u; }
  const producedByArt = {};
  for (const c of cycles) producedByArt[c.articleId] = (producedByArt[c.articleId] || 0) + c.units;
  const unschedArts = new Set(((schedule && schedule.warnings) || []).filter((w) => w.kind === 'unscheduled').map((w) => w.article));
  const coverage = [];
  for (const id of new Set([...Object.keys(plannedByArt), ...Object.keys(producedByArt)])) {
    const plan = plannedByArt[id] || 0, prod = producedByArt[id] || 0;
    if (plan === 0 && prod === 0) continue;
    const a = artById[id];
    let status = 'ok', note = '';
    if (prod === 0 && plan > 0) {
      status = 'missing';
      note = unschedArts.has(id) ? 'НЕ размещён планировщиком (закреплён за цехом, который его не шьёт — проверь «кто шьёт»)'
        : (a && a.archived) ? 'артикул в архиве' : 'нет партий с планом или всё покрыто остатками/поставками';
    } else if (plan > 0 && prod < plan - Math.max(2, plan * 0.02)) {
      status = 'partial'; note = `в производство вошло ${fmtNum(prod)} из ${fmtNum(plan)} шт (остальное покрыто остатками/поставками)`;
    }
    coverage.push({ articleId: id, name: (a && a.name) || '', plan, prod, status, note });
  }
  // артикулы БЕЗ плана вообще (не архивные) — их нет ни в пошиве, ни в закупке; чаще всего это и есть «пропажа»
  for (const a of state.articles || []) {
    if (a.archived) continue;
    if ((plannedByArt[a.id] || 0) > 0 || (producedByArt[a.id] || 0) > 0) continue;
    coverage.push({ articleId: a.id, name: a.name || '', plan: 0, prod: 0, status: 'noplan', note: 'нет партий/плана — задайте план на листе «План по размерам»' });
  }
  coverage.sort((x, y) => artNum(x.articleId) - artNum(y.articleId));

  // ── КОНСОЛИДАЦИЯ: ткань ОДНОГО планшета + № цвета + цвета из РАЗНЫХ артикулов складывается вместе
  // (суммируем метраж, стоимость, количество; перечисляем артикулы). Красным — если образцы разные. ──
  const consKey = (d) => `${(d.plansheet || '').trim().toLowerCase()}|${(d.colorNo || '').trim().toLowerCase()}|${String(d.color || '').trim().toLowerCase()}`;
  const consBy = {};
  for (const d of dem) {
    const k = consKey(d);
    const it = (consBy[k] || (consBy[k] = { plansheet: d.plansheet, colorNo: d.colorNo, color: d.color, arts: new Set(), images: new Set(), meters: 0, cost: 0, units: 0, months: new Set() }));
    it.meters += d.meters; it.cost += d.meters * d.price; it.units += d.units; it.arts.add(d.articleId); if (d.image) it.images.add(d.image); it.months.add(d.prodMonth);
  }
  const fabricConsolidated = Object.values(consBy).map((x) => ({ plansheet: x.plansheet, colorNo: x.colorNo, color: x.color, arts: [...x.arts].sort((a, b) => artNum(a) - artNum(b)), images: [...x.images], imageConflict: x.images.size > 1, meters: Math.ceil(x.meters), cost: Math.round(x.cost), price: x.meters ? x.cost / x.meters : 0, units: x.units, months: [...x.months].sort() }))
    .sort((a, b) => String(a.plansheet).localeCompare(String(b.plansheet)) || String(a.colorNo).localeCompare(String(b.colorNo)) || String(a.color).localeCompare(String(b.color)));
  const consTotals = { meters: fabricConsolidated.reduce((s, x) => s + x.meters, 0), cost: fabricConsolidated.reduce((s, x) => s + x.cost, 0), units: fabricConsolidated.reduce((s, x) => s + x.units, 0) };

  return {
    workshopMonthly, fabricMonthly, workshopColors, coverage,
    fabricPurchase: { bishkek, demi, summer: summerOrders },
    bishkekMarkup: BISHKEK_MARKUP,
    summerIds: [...summer],
    rates: (opts.rates && typeof opts.rates === 'object') ? opts.rates : null, // курсы валют на момент отчёта
    periodMode,
    fabricFilters, filters: { plansheets: fPlans, articleIds: fArts, months: fMonths }, filtered, // фильтры отчётов по ткани (множественные)
    fabricConsolidated, consTotals, // консолидированный вид при активном фильтре
    grand: {
      units: workshopMonthly.reduce((s, m) => s + m.total, 0),
      fabricMeters: fabricMonthly.reduce((s, m) => s + m.total, 0),
      fabricCost, // $ — суммарная стоимость ткани к закупке
      planUnits: Object.values(plannedByArt).reduce((s, u) => s + u, 0),
    },
  };
}

// ============================ HTML (экран + PDF) ============================
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const artChip = (id) => `<span style="display:inline-block;font-weight:700;color:${C.accent}">${esc(id)}</span>`;

// ── ячейка с образцом(-ами) ткани. images — строка URL или массив URL. При конфликте (разные образцы
// для одного планшета+цвета) — красная рамка/фон + пометка. Показываем все уникальные образцы. ──
const CONF = { bg: '#fdecea', line: '#e02424' };
function fabricSwatchCell(border, images, conflict) {
  const list = (Array.isArray(images) ? images : [images]).filter(Boolean);
  const w = conflict ? 46 : 54, hh = conflict ? 24 : 28;
  const body = list.length
    ? list.map((s) => `<img src="${esc(s)}" alt="" style="width:${w}px;height:${hh}px;object-fit:cover;border-radius:4px;border:1px solid ${conflict ? CONF.line : '#0002'};vertical-align:middle">`).join('<span style="display:inline-block;width:4px"></span>')
    : '<span style="color:#c0c6cf">—</span>';
  const warn = conflict ? `<div style="font-size:10px;line-height:1.1;color:${CONF.line};font-weight:700;margin-top:2px">⚠ разные образцы</div>` : '';
  const cs = conflict ? `background:${CONF.bg};box-shadow:inset 0 0 0 2px ${CONF.line}` : '';
  return `<td style="padding:4px 8px;border:1px solid ${border};text-align:center;white-space:nowrap;${cs}">${body}${warn}</td>`;
}

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

// подпись активных фильтров (для шапки консолидированного вида) — множественный выбор
function activeFilterChips(data) {
  const f = data.filters || {}, ff = data.fabricFilters || {}; const parts = [];
  if (f.plansheets && f.plansheets.length) parts.push(`Планшет: <b>${f.plansheets.map(esc).join(', ')}</b>`);
  if (f.articleIds && f.articleIds.length) parts.push(`Артикул: <b>${f.articleIds.map((id) => { const a = (ff.articles || []).find((x) => x.id === id); return esc(id) + (a && a.name ? ' · ' + esc(a.name) : ''); }).join(', ')}</b>`);
  if (f.months && f.months.length) parts.push(`Месяц: <b>${f.months.map((m) => { const mm = (ff.months || []).find((x) => x.ym === m); return esc(mm ? mm.label : m); }).join(', ')}</b>`);
  return parts.join(' · ');
}
// КОНСОЛИДИРОВАННЫЙ вид отчёта по ткани (при активном фильтре): плоская сводка по фильтру.
function fabricConsolidatedHtml(data) {
  const rows = data.fabricConsolidated || [], R = data.rates, T = data.consTotals || { meters: 0, cost: 0 };
  const chips = activeFilterChips(data);
  let h = `<div style="margin:0 0 12px;padding:10px 14px;border-left:4px solid ${C.accent};background:${C.zebra};border-radius:0 8px 8px 0">
    <div style="font-weight:800;color:${C.head};font-size:15px">Консолидированные данные по ткани</div>
    <div style="font-size:12.5px;color:#556;margin-top:2px">Фильтр: ${chips || '—'} · позиций: <b>${rows.length}</b> · <b>${fmtNum(T.meters)} м</b> · <b>${usdSum(T.cost)}</b>${convStr(T.cost, R)}</div></div>`;
  if (!rows.length) return h + `<div style="padding:16px;color:#889">Нет данных под выбранные фильтры.</div>`;
  h += `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
    <thead><tr style="background:${C.th}">
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">Планшет</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:80px">№ цвета</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Цвет</th>
      <th style="text-align:center;padding:6px 10px;border:1px solid ${C.border};width:120px">Образец</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:150px">Артикулы</th>
      <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:100px">Метраж, м</th>
      <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:80px">Цена, $/м</th>
      <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:110px">Сумма, $</th>
    </tr></thead><tbody>`;
  rows.forEach((r, i) => {
    h += `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
      <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:600">${esc(r.plansheet || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.colorNo || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.color)}</td>
      ${fabricSwatchCell(C.border, r.images, r.imageConflict)}
      <td style="padding:5px 10px;border:1px solid ${C.border}">${r.arts.map(artChip).join(', ')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(r.meters)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${price2(r.price)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right;font-weight:600">${usdSum(r.cost)}</td>
    </tr>`;
  });
  h += `<tr style="background:${C.total};font-weight:800;color:${C.head}"><td colspan="5" style="padding:6px 10px;border:1px solid ${C.border}">Итого по фильтру</td><td style="padding:6px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(T.meters)}</td><td style="padding:6px 10px;border:1px solid ${C.border}"></td><td style="padding:6px 10px;border:1px solid ${C.border};text-align:right">${usdSum(T.cost)}${convStr(T.cost, R)}</td></tr>`;
  return h + `</tbody></table>`;
}

function fabricTableHtml(rows, summerFlag) {
  const thBg = summerFlag ? C.thSummer : C.th;
  let h = `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
    <thead><tr style="background:${thBg}">
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:70px">Артикул</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">Планшет</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">№ цвета</th>
      <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Цвет</th>
      <th style="text-align:center;padding:6px 10px;border:1px solid ${C.border};width:120px">Образец</th>
      <th style="text-align:right;padding:6px 10px;border:1px solid ${C.border};width:120px">Метраж, м</th>
    </tr></thead><tbody>`;
  rows.forEach((r, i) => {
    h += `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
      <td style="padding:5px 10px;border:1px solid ${C.border};font-weight:700;color:${r.isSummer ? C.summer : C.accent}">${esc(r.articleId)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.plansheet || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.colorNo || '—')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(r.color)}</td>
      ${fabricSwatchCell(C.border, r.image, r.imageConflict)}
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(r.meters)}</td>
    </tr>`;
  });
  return h + `</tbody></table>`;
}

function report2aHtml(data) {
  if (data.filtered) return fabricConsolidatedHtml(data); // активен фильтр — консолидированный вид
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

// одна карточка-заказ (шапка «когда/сколько» + таблица позиций по ткани) — общая для деми/лета/Бишкека
function orderCardHtml(order, R, kind) {
  const head = kind === 'summer' ? C.summer : kind === 'bishkek' ? C.bishkek : C.month;
  const th = kind === 'summer' ? C.thSummer : kind === 'bishkek' ? C.thBishkek : C.th;
  const zebra = kind === 'summer' ? C.totalSummer : kind === 'bishkek' ? C.totalBishkek : C.zebra;
  const totalBg = kind === 'summer' ? C.totalSummer : kind === 'bishkek' ? C.totalBishkek : C.total;
  const arrival = order.arrival ? ` · приход ткани: <b>${esc(ymLabel(String(order.arrival).slice(0, 7)))}</b>` : '';
  const cnyNote = order.cny ? ` <span style="background:#fff3;padding:1px 6px;border-radius:10px;font-size:11px">↤ перенесено под кит. Новый год</span>` : '';
  let h = `<div style="margin:0 0 18px">
    <div style="background:${head};color:#fff;font-weight:700;padding:7px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <span>${esc(order.label)}${cnyNote}</span><span>заказать: <b>${dmy(order.purchaseDate)}</b>${arrival} · ${fmtNum(order.totalMeters)} м · <b>${usdSum(order.totalCost)}</b>${convStr(order.totalCost, R)}</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:${th}">
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:90px">Планшет</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:80px">№ цвета</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border};width:110px">Цвет</th>
        <th style="text-align:center;padding:6px 10px;border:1px solid ${C.border};width:120px">Образец</th>
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
      ${fabricSwatchCell(C.border, it.images, it.imageConflict)}
      <td style="padding:5px 10px;border:1px solid ${C.border}">${it.arts.map(artChip).join(', ')}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(it.meters)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${price2(it.price)}</td>
      <td style="padding:5px 10px;border:1px solid ${C.border};text-align:right;font-weight:600">${usdSum(it.cost)}</td>
    </tr>`;
  });
  h += `<tr style="background:${totalBg};font-weight:700"><td colspan="5" style="padding:5px 10px;border:1px solid ${C.border}">Итого заказ · ${dmy(order.purchaseDate)}</td><td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(order.totalMeters)}</td><td style="padding:5px 10px;border:1px solid ${C.border}"></td><td style="padding:5px 10px;border:1px solid ${C.border};text-align:right">${usdSum(order.totalCost)}${convStr(order.totalCost, R)}</td></tr>`;
  return h + `</tbody></table></div>`;
}

function report2bHtml(data) {
  if (data.filtered) return fabricConsolidatedHtml(data); // активен фильтр — консолидированный вид
  const P = data.fabricPurchase; const R = data.rates;
  const noRate = R ? '' : ` <span style="color:${C.summer}">(курс не загружен — суммы только в $)</span>`;
  let h = `<div style="margin:0 0 10px;color:#556;font-size:13px">Ткань одного <b>планшета и цвета</b> из разных артикулов сложена вместе. Сроки заказа: <b>Китай — за месяц</b> до старта пошива (по самому раннему артикулу периода), <b>Мадина (Бишкек) — за неделю</b>. Лето — в <b>два этапа</b> (ранний по первому пошиву + начало января). Учтён <b>китайский Новый год</b>: февраль закрыт, заказы перенесены на начало января и объединены. Стоимость ткани — из «Данных» ($/м). Столбец <b>«Образец»</b> — картинки ткани из карточек; <span style="color:${CONF.line};font-weight:700">красным</span> выделены цвета, где на один планшет+№ заведены <b>разные образцы</b>.${noRate}</div>`;
  // БИШКЕК (рынок Мадина) — местная закупка под пошив авг/сен, выделена отдельным блоком
  if (P.bishkek && P.bishkek.length) {
    const bTot = P.bishkek.reduce((s, o) => s + o.totalCost, 0);
    h += `<div style="margin:14px 0 8px;padding:10px 14px;border:2px solid ${C.bishkek};border-radius:10px;background:${C.totalBishkek}">
      <div style="font-weight:800;color:${C.bishkek};font-size:15px">🏪 Бишкек · рынок Мадина — местная закупка (пошив авг/сен)</div>
      <div style="font-size:12px;color:#556;margin-top:2px">Ткань для августа/сентября заказываем локально (в Китае не успеваем). Цена <b>+$${(data.bishkekMarkup || 0.4).toFixed(2)}/м</b> к китайской. Итого местной ткани: <b>${usdSum(bTot)}</b>${convStr(bTot, R)}</div></div>`;
    for (const o of P.bishkek) h += orderCardHtml(o, R, 'bishkek');
  }
  // ДЕМИ
  h += `<div style="font-weight:800;color:${C.head};font-size:15px;margin:20px 0 8px">🧵 Демисезон (Китай) — консолидация по периодам${data.periodMode === '2month' ? ' (раз в 2 месяца)' : ' (помесячно)'}</div>`;
  if (!P.demi.length) h += `<div style="color:#889;padding:6px 0">нет демисезонной ткани</div>`;
  for (const m of P.demi) h += orderCardHtml(m, R, 'demi');
  // ЛЕТО
  h += `<div style="font-weight:800;color:${C.summer};font-size:15px;margin:22px 0 8px">☀️ Летние (сезонные, Китай) — в два этапа: ранний (по первому пошиву) + начало января</div>`;
  if (!P.summer.length) h += `<div style="color:#889;padding:6px 0">нет летней ткани</div>`;
  for (const o of P.summer) h += orderCardHtml(o, R, 'summer');
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
  // «Образец» — Excel не умеет вставлять картинки этой библиотекой, поэтому отмечаем наличие/конфликт
  const CONFXL = { font: { bold: true, color: { rgb: 'E02424' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FDECEA' } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const SAMPXL = { border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const NC = 7;
  const aoa = [['Месяц', 'Артикул', 'Планшет', '№ цвета', 'Цвет', 'Образец', 'Метраж, м']];
  const sm = {}; let r = 1;
  for (let c = 0; c < NC; c++) sm[XLSX.utils.encode_cell({ r: 0, c })] = TH;
  for (const m of data.fabricMonthly) {
    aoa.push([`${m.label}  ·  ${m.total} м`, '', '', '', '', '', '']);
    for (let c = 0; c < NC; c++) sm[XLSX.utils.encode_cell({ r, c })] = MONTH; r++;
    for (const row of m.rows) {
      const samp = row.imageConflict ? '⚠ разные' : (row.image ? '✓ есть' : '—');
      aoa.push(['', row.articleId, row.plansheet || '—', row.colorNo || '—', row.color, samp, row.meters]);
      sm[XLSX.utils.encode_cell({ r, c: 1 })] = { font: { bold: true, color: { rgb: hx(row.isSummer ? C.summer : C.accent) } }, ...border() };
      for (const c of [2, 3, 4]) sm[XLSX.utils.encode_cell({ r, c })] = border();
      sm[XLSX.utils.encode_cell({ r, c: 5 })] = row.imageConflict ? CONFXL : SAMPXL;
      sm[XLSX.utils.encode_cell({ r, c: 6 })] = { alignment: { horizontal: 'right' }, ...border() };
      r++;
    }
    aoa.push(['', '', '', '', `Итого ${m.label}`, '', m.total]);
    for (let c = 0; c < NC; c++) sm[XLSX.utils.encode_cell({ r, c })] = TOT; r++;
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];
  styleSheet(ws, sm); return ws;
}
// лист закупки для набора заказов (демисезон ИЛИ лето) → worksheet. 9 колонок (+ Образец).
function ordersSheet(orders, opts) {
  const XLSX = window.XLSX;
  const R = opts.rates; const kind = opts.kind || 'demi';
  const cc = (rr, c) => XLSX.utils.encode_cell({ r: rr, c });
  const NCOL = 9; // Планшет, №цвета, Цвет, Образец, Артикулы, Метраж, Цена $/м, Сумма $, Сумма сом
  const som = (usd) => R ? Math.round(usd * R.usdKgs) : ''; // пересчёт в сомы по курсу
  const bannerBg = kind === 'summer' ? hx(C.summer) : kind === 'bishkek' ? hx(C.bishkek) : hx(C.month);
  const thBg = kind === 'summer' ? C.thSummer : kind === 'bishkek' ? C.thBishkek : C.th;
  const totBg = kind === 'summer' ? C.totalSummer : kind === 'bishkek' ? C.totalBishkek : C.total;
  const kindLabel = kind === 'summer' ? 'лето' : kind === 'bishkek' ? 'Бишкек (Мадина)' : 'демисезон';
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(thBg) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const BANNER = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: bannerBg } } };
  const TOT = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: hx(totBg) } }, border: XLSX_BORDER() };
  const RIGHT = () => ({ alignment: { horizontal: 'right' }, border: XLSX_BORDER() });
  const border = () => ({ border: XLSX_BORDER() });
  const CONFXL = { font: { bold: true, color: { rgb: 'E02424' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FDECEA' } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const SAMPXL = { border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const aoa = [[opts.title]]; const sm = {}; const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NCOL - 1 } }];
  sm.A1 = { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } } };
  let r = 1;
  let allCost = 0, allMeters = 0;
  for (const o of orders) {
    const arrival = o.arrival ? ` · приход ткани ${ymLabel(String(o.arrival).slice(0, 7))}` : '';
    aoa.push([`${o.label} · заказать ${dmy(o.purchaseDate)}${arrival} · ${o.totalMeters} м · $${o.totalCost}${o.cny ? ' · перенесено под кит. Новый год' : ''}`]);
    for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = BANNER; merges.push({ s: { r, c: 0 }, e: { r, c: NCOL - 1 } }); r++;
    aoa.push(['Планшет', '№ цвета', 'Цвет', 'Образец', 'Артикулы', 'Метраж, м', 'Цена, $/м', 'Сумма, $', 'Сумма, сом']);
    for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = TH; r++;
    for (const it of o.items) {
      const samp = it.imageConflict ? '⚠ разные' : ((it.images && it.images.length) ? '✓ есть' : '—');
      aoa.push([it.plansheet || '—', it.colorNo || '—', it.color || '—', samp, it.arts.join(', '), it.meters, Math.round(it.price * 100) / 100, it.cost, som(it.cost)]);
      for (const c of [0, 1, 2, 4]) sm[cc(r, c)] = border();
      sm[cc(r, 3)] = it.imageConflict ? CONFXL : SAMPXL;
      for (const c of [5, 6, 7, 8]) sm[cc(r, c)] = RIGHT();
      r++;
    }
    aoa.push(['Итого заказ', '', '', '', '', o.totalMeters, '', o.totalCost, som(o.totalCost)]);
    for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = TOT;
    for (const c of [5, 7, 8]) sm[cc(r, c)] = { ...TOT, alignment: { horizontal: 'right' } };
    r++; aoa.push([]); r++;
    allCost += o.totalCost; allMeters += o.totalMeters;
  }
  // итог листа + пересчёт по курсу
  const conv = R ? `  ≈ ${Math.round(allCost * R.usdRub)} ₽` : '';
  aoa.push([`ИТОГО ${kindLabel}:${conv}`, '', '', '', '', allMeters, '', allCost, som(allCost)]);
  const GT = { font: { bold: true, sz: 12, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  for (let c = 0; c < NCOL; c++) sm[cc(r, c)] = GT;
  for (const c of [5, 7, 8]) sm[cc(r, c)] = { ...GT, alignment: { horizontal: 'right' } };
  merges.push({ s: { r, c: 0 }, e: { r, c: 4 } });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 15 }];
  styleSheet(ws, sm); return ws;
}
// лист КОНСОЛИДАЦИИ по фильтру (артикул × планшет × №цвета × цвет) → worksheet
function fabricConsolidatedSheet(data) {
  const XLSX = window.XLSX, R = data.rates;
  const cc = (rr, c) => XLSX.utils.encode_cell({ r: rr, c });
  const NC = 8; // Планшет, №цвета, Цвет, Образец, Артикулы, Метраж, Цена $/м, Сумма $
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const TOT = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const CONFXL = { font: { bold: true, color: { rgb: 'E02424' } }, fill: { patternType: 'solid', fgColor: { rgb: 'FDECEA' } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const SAMPXL = { border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const RIGHT = () => ({ alignment: { horizontal: 'right' }, border: XLSX_BORDER() });
  const border = () => ({ border: XLSX_BORDER() });
  const chips = (activeFilterChips(data) || '—').replace(/<[^>]+>/g, ''); // без html-тегов
  const aoa = [[`Консолидация по ткани · фильтр: ${chips}`]]; const sm = { A1: { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } } } };
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: NC - 1 } }];
  aoa.push(['Планшет', '№ цвета', 'Цвет', 'Образец', 'Артикулы', 'Метраж, м', 'Цена, $/м', 'Сумма, $']);
  let r = 1; for (let c = 0; c < NC; c++) sm[cc(r, c)] = TH; r++;
  for (const x of (data.fabricConsolidated || [])) {
    const samp = x.imageConflict ? '⚠ разные' : ((x.images && x.images.length) ? '✓ есть' : '—');
    aoa.push([x.plansheet || '—', x.colorNo || '—', x.color, samp, x.arts.join(', '), x.meters, Math.round(x.price * 100) / 100, x.cost]);
    sm[cc(r, 0)] = { font: { bold: true }, ...border() };
    for (const c of [1, 2, 4]) sm[cc(r, c)] = border();
    sm[cc(r, 3)] = x.imageConflict ? CONFXL : SAMPXL;
    for (const c of [5, 6, 7]) sm[cc(r, c)] = RIGHT();
    r++;
  }
  const T = data.consTotals || { meters: 0, cost: 0 };
  aoa.push(['Итого по фильтру', '', '', '', '', T.meters, '', T.cost]);
  for (let c = 0; c < NC; c++) sm[cc(r, c)] = c >= 5 ? { ...TOT, alignment: { horizontal: 'right' } } : TOT;
  merges.push({ s: { r, c: 0 }, e: { r, c: 4 } });
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 11 }, { wch: 13 }];
  styleSheet(ws, sm); return ws;
}
function report2aExcel(data, fname) {
  const X = window.XLSX; const wb = X.utils.book_new();
  if (data.filtered) { X.utils.book_append_sheet(wb, fabricConsolidatedSheet(data), 'Ткань (фильтр)'); X.writeFile(wb, fname || 'Отчёт_ткань_фильтр.xlsx'); return; }
  X.utils.book_append_sheet(wb, fabricMonthlySheet(data), 'Ткань помесячно'); X.writeFile(wb, fname || 'Отчёт_ткань_помесячно.xlsx');
}
function report2bExcel(data, fname) {
  const X = window.XLSX; const wb = X.utils.book_new();
  if (data.filtered) { X.utils.book_append_sheet(wb, fabricConsolidatedSheet(data), 'Закупка (фильтр)'); X.writeFile(wb, fname || 'Отчёт_закупка_фильтр.xlsx'); return; }
  // Бишкек (местная закупка), демисезон и лето — на РАЗНЫХ листах
  if (data.fabricPurchase.bishkek && data.fabricPurchase.bishkek.length) {
    X.utils.book_append_sheet(wb, ordersSheet(data.fabricPurchase.bishkek, { title: `БИШКЕК · рынок Мадина — местная закупка (пошив авг/сен, +$${(data.bishkekMarkup || 0.4).toFixed(2)}/м)`, rates: data.rates, kind: 'bishkek' }), 'Бишкек (Мадина)');
  }
  X.utils.book_append_sheet(wb, ordersSheet(data.fabricPurchase.demi, { title: `ДЕМИСЕЗОН (Китай) — закупка ткани${data.periodMode === '2month' ? ' (раз в 2 месяца)' : ' (помесячно)'}`, rates: data.rates, kind: 'demi' }), 'Демисезон');
  X.utils.book_append_sheet(wb, ordersSheet(data.fabricPurchase.summer, { title: 'ЛЕТО (Китай) — закупка ткани в два этапа (ранний + начало января)', rates: data.rates, kind: 'summer' }), 'Лето');
  X.writeFile(wb, fname || 'Отчёт_закупка_ткани.xlsx');
}

// ============================ ОТЧЁТ ДЛЯ СОБСТВЕННИКА (r3): СВОДКА + ГРАФИКИ ============================
// Инлайн-SVG диаграммы (без внешних библиотек — работают на экране и в печати/PDF).
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ymShort = (m) => { const [y, mo] = String(m).split('-'); return mo ? `${MON_SHORT[+mo - 1]} ${String(y).slice(2)}` : m; };
const dmyShort = (iso) => { const s = String(iso || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : '—'; };
// «красивый» верх шкалы: округляем максимум вверх до 1/2/5×10ⁿ, чтобы сетка была ровной
const niceMax = (v) => { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return n * p; };

// столбчатая диаграмма с накоплением сегментов (по цехам): months=[{label,total,segments:[{name,value,color}]}]
function svgStacked(months, opts = {}) {
  if (!months.length) return '';
  const W = opts.width || Math.max(520, months.length * 76 + 70);
  const H = opts.height || 300;
  const padL = 48, padR = 14, padT = 18, padB = 46, plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = niceMax(Math.max(...months.map((m) => m.total), 1));
  const gap = plotW / months.length, bw = Math.min(54, gap * 0.62);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = maxV * i / 4, yy = y(v); g += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#e3e9f2"/><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#889">${fmtNum(v)}</text>`; }
  months.forEach((m, i) => {
    const x = padL + gap * i + (gap - bw) / 2; let acc = 0;
    for (const s of m.segments) { if (!(s.value > 0)) continue; const yTop = y(acc + s.value), hh = (s.value / maxV) * plotH; g += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, hh).toFixed(1)}" fill="${s.color}" stroke="#fff" stroke-width="0.6"><title>${esc(s.name)}: ${fmtNum(s.value)}</title></rect>`; acc += s.value; }
    g += `<text x="${(x + bw / 2).toFixed(1)}" y="${(y(m.total) - 5).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${C.head}">${fmtNum(m.total)}</text>`;
    g += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 16}" text-anchor="middle" font-size="10.5" fill="#556">${esc(m.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;font-family:inherit" preserveAspectRatio="xMinYMin meet">${g}</svg>`;
}
// простая столбчатая диаграмма: items=[{label,value,color?}]
function svgBars(items, opts = {}) {
  if (!items.length) return '';
  const W = opts.width || Math.max(480, items.length * 68 + 70);
  const H = opts.height || 260;
  const padL = 52, padR = 14, padT = opts.padT || 18, padB = 46, plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = niceMax(Math.max(...items.map((it) => it.value), 1));
  const gap = plotW / items.length, bw = Math.min(50, gap * 0.6);
  const y = (v) => padT + plotH - (v / maxV) * plotH;
  const color = opts.color || C.accent, fmt = opts.fmt || fmtNum;
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = maxV * i / 4, yy = y(v); g += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#e3e9f2"/><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#889">${fmtNum(v)}</text>`; }
  const fmt2 = opts.fmt2; // необязательная вторая строка подписи (напр. сумма в сомах)
  items.forEach((it, i) => {
    const x = padL + gap * i + (gap - bw) / 2, yy = y(it.value), hh = padT + plotH - yy;
    const cx = (x + bw / 2).toFixed(1);
    g += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, hh).toFixed(1)}" rx="3" fill="${it.color || color}"><title>${esc(it.label)}: ${fmt(it.value)}${fmt2 ? ' (' + fmt2(it.value) + ')' : ''}</title></rect>`;
    const s2 = fmt2 ? fmt2(it.value) : '';
    g += `<text x="${cx}" y="${(yy - (s2 ? 16 : 5)).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${C.head}">${fmt(it.value)}</text>`;
    if (s2) g += `<text x="${cx}" y="${(yy - 5).toFixed(1)}" text-anchor="middle" font-size="9" fill="#667">${s2}</text>`;
    g += `<text x="${cx}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="#556">${esc(it.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;font-family:inherit" preserveAspectRatio="xMinYMin meet">${g}</svg>`;
}
function legendHtml(entries) {
  return `<div style="display:flex;flex-wrap:wrap;gap:8px 16px;margin:10px 0 0">` +
    entries.map((e) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#445"><span style="width:12px;height:12px;border-radius:3px;background:${e.color};display:inline-block;border:1px solid #0001"></span>${esc(e.name)}</span>`).join('') + `</div>`;
}
function kpiCard(label, value, sub, accent) {
  return `<div style="flex:1 1 180px;min-width:168px;background:linear-gradient(135deg,${accent}12,${accent}22);border:1px solid ${accent}55;border-left:4px solid ${accent};border-radius:12px;padding:14px 16px">
    <div style="font-size:11.5px;color:#667;font-weight:700;text-transform:uppercase;letter-spacing:.4px">${esc(label)}</div>
    <div style="font-size:23px;font-weight:800;color:${C.head};margin:4px 0 0;line-height:1.1">${value}</div>
    ${sub ? `<div style="font-size:12px;color:#778;margin-top:3px">${esc(sub)}</div>` : ''}</div>`;
}
function sectionTitle(title, sub) {
  return `<div style="margin:24px 0 10px"><div style="font-size:16px;font-weight:800;color:${C.head}">${title}</div>${sub ? `<div style="font-size:12px;color:#778;margin-top:1px">${esc(sub)}</div>` : ''}</div>`;
}
const cardWrap = (inner) => `<div style="border:1px solid ${C.border};border-radius:12px;padding:14px 16px;background:#fff">${inner}</div>`;

function report3Html(data) {
  const R = data.rates, wc = data.workshopColors || {};
  const wm = data.workshopMonthly || [], fm = data.fabricMonthly || [];
  const P = data.fabricPurchase || {}; const bK = P.bishkek || [], dK = P.demi || [], sK = P.summer || [];
  const orders = [...bK.map((o) => ({ ...o, kind: 'bishkek' })), ...dK.map((o) => ({ ...o, kind: 'demi' })), ...sK.map((o) => ({ ...o, kind: 'summer' }))]
    .sort((a, b) => String(a.purchaseDate).localeCompare(String(b.purchaseDate)));
  if (!wm.length && !fm.length && !orders.length) return `<div style="padding:20px;color:#667">Нет данных для сводки. Заполните план и раскладку.</div>`;
  const somRub = (usd) => R ? `${fmtNum(Math.round(usd * R.usdKgs))} сом · ${fmtNum(Math.round(usd * R.usdRub))} ₽` : '';
  const kindColor = (k) => k === 'summer' ? C.summer : k === 'bishkek' ? C.bishkek : C.month;
  const kindName = (k) => k === 'summer' ? 'Лето' : k === 'bishkek' ? 'Бишкек' : 'Демисезон';

  // === KPI ===
  const ordSub = `${bK.length ? bK.length + ' Бишкек · ' : ''}${dK.length} деми · ${sK.length} лето`;
  let h = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 6px">
    ${kpiCard('Изделий всего', fmtNum(data.grand.units) + ' шт', `${wm.length} мес · план ${fmtNum(data.grand.planUnits)} шт`, C.accent)}
    ${kpiCard('Ткань к расходу', fmtNum(data.grand.fabricMeters) + ' м', `${fm.length} мес производства`, '#2f855a')}
    ${kpiCard('Стоимость ткани', usdSum(data.grand.fabricCost), somRub(data.grand.fabricCost), C.summer)}
    ${kpiCard('Заказов на ткань', String(orders.length), ordSub, C.chip)}
  </div>`;

  // === БЛОК A: пошив помесячно, с разбивкой по цехам ===
  const wsNames = {}; for (const m of wm) for (const w of m.workshops) wsNames[w.workshopId] = w.name;
  const wsOrder = Object.keys(wc).filter((id) => wsNames[id]); for (const id of Object.keys(wsNames)) if (!wsOrder.includes(id)) wsOrder.push(id);
  const months = wm.map((m) => ({ label: ymShort(m.ym), total: m.total, segments: wsOrder.map((id) => ({ name: wsNames[id], color: wc[id] || C.accent, value: (m.workshops.find((w) => w.workshopId === id) || {}).total || 0 })) }));
  h += sectionTitle('🧵 Пошив изделий помесячно', 'штук в производство, с разбивкой по цехам');
  h += cardWrap(svgStacked(months) + legendHtml(wsOrder.map((id) => ({ name: wsNames[id], color: wc[id] || C.accent }))));
  // матрица месяц × цех
  const thc = `text-align:right;padding:6px 10px;border:1px solid ${C.border}`;
  const wsTotals = {};
  let mtx = `<div style="overflow-x:auto;margin:10px 0 0"><table style="border-collapse:collapse;font-size:12.5px;min-width:100%">
    <thead><tr style="background:${C.th}"><th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Месяц</th>${wsOrder.map((id) => `<th style="${thc}">${esc(wsNames[id])}</th>`).join('')}<th style="${thc};background:${C.total}">Итого</th></tr></thead><tbody>`;
  wm.forEach((m, i) => {
    mtx += `<tr style="background:${i % 2 ? C.zebra : '#fff'}"><td style="padding:5px 10px;border:1px solid ${C.border};font-weight:600">${esc(m.label)}</td>`;
    for (const id of wsOrder) { const v = (m.workshops.find((w) => w.workshopId === id) || {}).total || 0; wsTotals[id] = (wsTotals[id] || 0) + v; mtx += `<td style="${thc}">${v ? fmtNum(v) : '·'}</td>`; }
    mtx += `<td style="${thc};background:${C.total};font-weight:800;color:${C.head}">${fmtNum(m.total)}</td></tr>`;
  });
  mtx += `<tr style="background:${C.total};font-weight:800;color:${C.head}"><td style="padding:6px 10px;border:1px solid ${C.border}">Итого</td>${wsOrder.map((id) => `<td style="${thc}">${fmtNum(wsTotals[id] || 0)}</td>`).join('')}<td style="${thc}">${fmtNum(data.grand.units)}</td></tr>`;
  h += mtx + `</tbody></table></div>`;

  // === БЛОК B: расход ткани помесячно ===
  h += sectionTitle('🧶 Расход ткани помесячно', 'метров ткани по месяцам производства');
  h += cardWrap(svgBars(fm.map((m) => ({ label: ymShort(m.ym), value: m.total })), { color: '#2f855a' }));
  let ft = `<div style="overflow-x:auto;margin:10px 0 0"><table style="border-collapse:collapse;font-size:12.5px;min-width:100%">
    <thead><tr style="background:${C.th}"><th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Месяц</th><th style="${thc}">Метраж, м</th></tr></thead><tbody>`;
  fm.forEach((m, i) => { ft += `<tr style="background:${i % 2 ? C.zebra : '#fff'}"><td style="padding:5px 10px;border:1px solid ${C.border};font-weight:600">${esc(m.label)}</td><td style="${thc}">${fmtNum(m.total)}</td></tr>`; });
  ft += `<tr style="background:${C.total};font-weight:800;color:${C.head}"><td style="padding:6px 10px;border:1px solid ${C.border}">Итого</td><td style="${thc}">${fmtNum(data.grand.fabricMeters)}</td></tr>`;
  h += ft + `</tbody></table></div>`;

  // === БЛОК C: закупка ткани по периодам (объёмы + суммы) ===
  h += sectionTitle('💰 Закупка ткани по периодам', 'стоимость и объём заказов ткани по датам заказа');
  if (!orders.length) h += cardWrap(`<div style="color:#889">Нет заказов на ткань.</div>`);
  else {
    const somFmt = R ? (usd) => fmtNum(Math.round(usd * R.usdKgs)) + ' сом' : null;
    h += cardWrap(svgBars(orders.map((o) => ({ label: dmyShort(o.purchaseDate), value: o.totalCost, color: kindColor(o.kind) })), { fmt: usdSum, fmt2: somFmt, padT: 32, height: 280 })
      + legendHtml([{ name: 'Демисезон (Китай)', color: C.month }, { name: 'Лето (Китай)', color: C.summer }, { name: 'Бишкек (Мадина)', color: C.bishkek }]));
    const totM = orders.reduce((s, o) => s + o.totalMeters, 0), totC = orders.reduce((s, o) => s + o.totalCost, 0);
    let ot = `<div style="overflow-x:auto;margin:10px 0 0"><table style="border-collapse:collapse;font-size:12.5px;min-width:100%">
      <thead><tr style="background:${C.th}">
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Тип</th>
        <th style="text-align:left;padding:6px 10px;border:1px solid ${C.border}">Заказ</th>
        <th style="${thc}">Заказать</th><th style="${thc}">Приход</th>
        <th style="${thc}">Метраж, м</th><th style="${thc}">Сумма, $</th>${R ? `<th style="${thc}">Сумма, сом</th>` : ''}
      </tr></thead><tbody>`;
    orders.forEach((o, i) => {
      ot += `<tr style="background:${i % 2 ? C.zebra : '#fff'}">
        <td style="padding:5px 10px;border:1px solid ${C.border}"><span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;color:#fff;background:${kindColor(o.kind)}">${kindName(o.kind)}</span></td>
        <td style="padding:5px 10px;border:1px solid ${C.border}">${esc(o.label)}${o.cny ? ' <span style="font-size:10.5px;color:' + C.summer + '">↤ кит. НГ</span>' : ''}</td>
        <td style="${thc}">${dmy(o.purchaseDate)}</td>
        <td style="${thc}">${o.arrival ? esc(ymShort(String(o.arrival).slice(0, 7))) : '—'}</td>
        <td style="${thc}">${fmtNum(o.totalMeters)}</td>
        <td style="${thc};font-weight:600">${usdSum(o.totalCost)}</td>${R ? `<td style="${thc}">${fmtNum(Math.round(o.totalCost * R.usdKgs))}</td>` : ''}</tr>`;
    });
    ot += `<tr style="background:${C.total};font-weight:800;color:${C.head}"><td style="padding:6px 10px;border:1px solid ${C.border}" colspan="4">Итого закупка</td><td style="${thc}">${fmtNum(totM)}</td><td style="${thc}">${usdSum(totC)}</td>${R ? `<td style="${thc}">${fmtNum(Math.round(totC * R.usdKgs))}</td>` : ''}</tr>`;
    h += ot + `</tbody></table></div>`;
    if (R) h += `<div style="margin:8px 2px 0;font-size:12px;color:#778">Пересчёт по курсу НБ КР: $1 = ${cur2(R.usdKgs)} сом · $1 = ${cur2(R.usdRub)} ₽${R.rateDate ? ' (на ' + dmy(R.rateDate) + ')' : ''}.</div>`;
  }
  return h;
}

// Excel «Сводка для собственника»: числовые таблицы на 3 листах (пошив / ткань / закупка)
function report3Excel(data, fname) {
  const X = window.XLSX, wb = X.utils.book_new();
  const cc = (r, c) => X.utils.encode_cell({ r, c });
  const HEAD = { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.head) } } };
  const TH = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.th) } }, border: XLSX_BORDER(), alignment: { horizontal: 'center' } };
  const TOT = { font: { bold: true, color: { rgb: hx(C.head) } }, fill: { patternType: 'solid', fgColor: { rgb: hx(C.total) } }, border: XLSX_BORDER() };
  const RIGHT = () => ({ alignment: { horizontal: 'right' }, border: XLSX_BORDER() });
  const bd = () => ({ border: XLSX_BORDER() });
  const R = data.rates;

  // Лист 1 — Пошив по цехам (матрица месяц × цех)
  const wm = data.workshopMonthly || [], wc = data.workshopColors || {};
  const wsNames = {}; for (const m of wm) for (const w of m.workshops) wsNames[w.workshopId] = w.name;
  const wsOrder = Object.keys(wc).filter((id) => wsNames[id]); for (const id of Object.keys(wsNames)) if (!wsOrder.includes(id)) wsOrder.push(id);
  {
    const ncol = wsOrder.length + 2;
    const aoa = [['Сводка для собственника — пошив изделий помесячно']]; const sm = {}; const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(1, ncol - 1) } }];
    sm.A1 = HEAD;
    aoa.push(['Месяц', ...wsOrder.map((id) => wsNames[id]), 'Итого']); let r = 1;
    for (let c = 0; c < ncol; c++) sm[cc(r, c)] = TH; r++;
    const wsTot = {};
    for (const m of wm) {
      const row = [m.label]; for (const id of wsOrder) { const v = (m.workshops.find((w) => w.workshopId === id) || {}).total || 0; wsTot[id] = (wsTot[id] || 0) + v; row.push(v || ''); } row.push(m.total);
      aoa.push(row); sm[cc(r, 0)] = { font: { bold: true }, ...bd() }; for (let c = 1; c < ncol; c++) sm[cc(r, c)] = RIGHT(); sm[cc(r, ncol - 1)] = { ...RIGHT(), font: { bold: true } }; r++;
    }
    const totRow = ['Итого', ...wsOrder.map((id) => wsTot[id] || 0), data.grand.units]; aoa.push(totRow);
    for (let c = 0; c < ncol; c++) sm[cc(r, c)] = c === 0 ? TOT : { ...TOT, alignment: { horizontal: 'right' } };
    const ws = X.utils.aoa_to_sheet(aoa); ws['!merges'] = merges; ws['!cols'] = [{ wch: 16 }, ...wsOrder.map(() => ({ wch: 14 })), { wch: 12 }];
    styleSheet(ws, sm); X.utils.book_append_sheet(wb, ws, 'Пошив по цехам');
  }
  // Лист 2 — Расход ткани помесячно
  {
    const fm = data.fabricMonthly || [];
    const aoa = [['Расход ткани помесячно, м']]; const sm = { A1: HEAD }; const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    aoa.push(['Месяц', 'Метраж, м']); let r = 1; for (let c = 0; c < 2; c++) sm[cc(r, c)] = TH; r++;
    for (const m of fm) { aoa.push([m.label, m.total]); sm[cc(r, 0)] = { font: { bold: true }, ...bd() }; sm[cc(r, 1)] = RIGHT(); r++; }
    aoa.push(['Итого', data.grand.fabricMeters]); sm[cc(r, 0)] = TOT; sm[cc(r, 1)] = { ...TOT, alignment: { horizontal: 'right' } };
    const ws = X.utils.aoa_to_sheet(aoa); ws['!merges'] = merges; ws['!cols'] = [{ wch: 18 }, { wch: 14 }];
    styleSheet(ws, sm); X.utils.book_append_sheet(wb, ws, 'Расход ткани');
  }
  // Лист 3 — Закупка ткани по периодам
  {
    const P = data.fabricPurchase || {};
    const orders = [...(P.bishkek || []).map((o) => ({ ...o, kind: 'Бишкек' })), ...(P.demi || []).map((o) => ({ ...o, kind: 'Демисезон' })), ...(P.summer || []).map((o) => ({ ...o, kind: 'Лето' }))]
      .sort((a, b) => String(a.purchaseDate).localeCompare(String(b.purchaseDate)));
    const som = (usd) => R ? Math.round(usd * R.usdKgs) : '';
    const cols = ['Тип', 'Заказ', 'Заказать', 'Приход ткани', 'Метраж, м', 'Сумма, $', 'Сумма, сом'];
    const ncol = cols.length;
    const aoa = [['Закупка ткани по периодам — объёмы и суммы']]; const sm = { A1: HEAD }; const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: ncol - 1 } }];
    aoa.push(cols); let r = 1; for (let c = 0; c < ncol; c++) sm[cc(r, c)] = TH; r++;
    let tm = 0, tc = 0;
    for (const o of orders) {
      aoa.push([o.kind, o.label + (o.cny ? ' (перенос под кит. НГ)' : ''), dmy(o.purchaseDate), o.arrival ? ymLabel(String(o.arrival).slice(0, 7)) : '—', o.totalMeters, o.totalCost, som(o.totalCost)]);
      for (const c of [0, 1, 2, 3]) sm[cc(r, c)] = bd(); for (const c of [4, 5, 6]) sm[cc(r, c)] = RIGHT(); r++; tm += o.totalMeters; tc += o.totalCost;
    }
    aoa.push(['Итого', '', '', '', tm, tc, som(tc)]); for (let c = 0; c < ncol; c++) sm[cc(r, c)] = c >= 4 ? { ...TOT, alignment: { horizontal: 'right' } } : TOT;
    merges.push({ s: { r, c: 0 }, e: { r, c: 3 } });
    const ws = X.utils.aoa_to_sheet(aoa); ws['!merges'] = merges; ws['!cols'] = [{ wch: 12 }, { wch: 30 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    styleSheet(ws, sm); X.utils.book_append_sheet(wb, ws, 'Закупка по периодам');
  }
  X.writeFile(wb, fname || 'Отчёт_сводка_собственника.xlsx');
}

// ============================ РЕЕСТР ОТЧЁТОВ ============================
// Каждый отчёт: id, имя (для списка/архива), html(data), excel(data,fname), pdfTitle, имя файла.
const REPORTS = [
  { id: 'r3', name: 'Сводка для собственника (объёмы · периоды · суммы)', html: report3Html, excel: report3Excel, pdfTitle: 'Сводка для собственника', file: 'Отчёт_сводка.xlsx' },
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

// ── панель «проверка полноты» (свёрнута по умолчанию): что и почему не вошло в отчёт ──
function coveragePanelHtml(data) {
  const cov = data.coverage || [];
  const issues = cov.filter((c) => c.status !== 'ok');
  const planU = (data.grand && data.grand.planUnits) || 0, prodU = (data.grand && data.grand.units) || 0;
  const okAll = !issues.length;
  const nMissing = issues.filter((c) => c.status === 'missing' || c.status === 'partial').length;
  const nNoPlan = issues.filter((c) => c.status === 'noplan').length;
  const border = okAll ? '#b7dfc6' : C.summer;
  const bg = okAll ? '#e9f5ee' : '#fdf3e6';
  const col = okAll ? '#256b45' : C.summer;
  const summary = okAll
    ? `✓ Проверка полноты: все артикулы вошли (план ${fmtNum(planU)} = произв. ${fmtNum(prodU)} шт)`
    : `⚠ Проверка полноты: ${nMissing ? `${nMissing} не/частично вошли` : 'все запланированные вошли'}${nNoPlan ? `, ${nNoPlan} без плана` : ''} · план ${fmtNum(planU)} → произв. ${fmtNum(prodU)} шт`;
  const colOf = (s) => s === 'missing' ? C.summer : s === 'partial' ? '#8a6d3b' : s === 'noplan' ? '#6b7280' : '#256b45';
  let rows = '';
  for (const c of cov) {
    const cc = colOf(c.status);
    rows += `<tr style="background:${c.status === 'ok' ? '#fff' : bg}">
      <td style="padding:4px 10px;border:1px solid ${C.border};font-weight:700;color:${cc}">${esc(c.articleId)}</td>
      <td style="padding:4px 10px;border:1px solid ${C.border}">${esc(c.name)}</td>
      <td style="padding:4px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(c.plan)}</td>
      <td style="padding:4px 10px;border:1px solid ${C.border};text-align:right">${fmtNum(c.prod)}</td>
      <td style="padding:4px 10px;border:1px solid ${C.border};color:${cc}">${c.status === 'ok' ? '<span style="color:#256b45">✓ вошёл</span>' : esc(c.note)}</td>
    </tr>`;
  }
  return `<details style="margin:10px 0 0;border:1px solid ${border};border-radius:10px;background:${bg};overflow:hidden">
    <summary style="cursor:pointer;padding:8px 12px;font-size:13px;font-weight:700;color:${col}">${summary} <span style="font-weight:500;color:#889;font-size:12px">— нажмите, чтобы раскрыть</span></summary>
    <div style="padding:4px 12px 12px;background:#fff">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr style="background:${C.th}">
          <th style="text-align:left;padding:5px 10px;border:1px solid ${C.border};width:80px">Артикул</th>
          <th style="text-align:left;padding:5px 10px;border:1px solid ${C.border}">Название</th>
          <th style="text-align:right;padding:5px 10px;border:1px solid ${C.border};width:90px">План, шт</th>
          <th style="text-align:right;padding:5px 10px;border:1px solid ${C.border};width:100px">В произв., шт</th>
          <th style="text-align:left;padding:5px 10px;border:1px solid ${C.border}">Статус / причина</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
  </details>`;
}

// ============================ СТРАНИЦА (2 под-вкладки: Отчёты / Архив) ============================
let reportsSubTab = 'build';       // 'build' | 'archive' — сохраняется между перерисовками
let reportPeriodMode = 'month';    // 'month' | '2month' — период закупа ткани
let reportFabricFilters = { plansheets: [], articleIds: [], months: [] }; // фильтры отчётов по ткани (множественные)

export function renderReportsPage(container, state, schedule, ctx = {}) {
  const toast = ctx.toast || (() => {});
  const api = ctx.api;
  const rerender = () => renderReportsPage(container, state, schedule, ctx);
  const buildWith = (extra) => buildReportsData(state, schedule, { rates: (currencyRates && typeof currencyRates === 'object') ? currencyRates : null, periodMode: reportPeriodMode, ...(extra || {}) });
  const ctx2 = { ...ctx, rerender, rebuild: buildWith };
  let data;
  try { data = buildWith(); }
  catch (e) { container.innerHTML = `<div style="padding:20px;color:#c0392b">Ошибка сбора отчёта: ${esc(e.message)}</div>`; return; }

  const tabBtn = (id, label) => `<button data-subtab="${id}" style="padding:8px 16px;border:1px solid ${C.border};border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;font-weight:700;font-size:13px;background:${reportsSubTab === id ? '#fff' : C.zebra};color:${reportsSubTab === id ? C.head : '#667'}">${label}</button>`;

  container.innerHTML = `
    <div style="margin:0 0 4px"><div style="font-size:20px;font-weight:800;color:${C.head}">Отчёты</div>
      <div style="color:#667;font-size:13px">Текущие данные: ${fmtNum(data.grand.units)} шт производства · ${fmtNum(data.grand.fabricMeters)} м ткани.</div></div>
    ${currencyBarHtml()}
    ${coveragePanelHtml(data)}
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
  const isFabric = rep.id === 'r2a' || rep.id === 'r2b'; // отчёты по ткани — с фильтрами
  // для отчётов по ткани пересобираем данные с текущими фильтрами (влияет только на этот отчёт)
  const view = (isFabric && ctx && ctx.rebuild) ? ctx.rebuild({ filters: { ...reportFabricFilters } }) : data;
  const body = rep.html(view);

  // панель фильтров (планшет / артикул / месяц) — только для отчётов по ткани
  let filterBar = '';
  if (isFabric) {
    const ff = view.fabricFilters || { plansheets: [], articles: [], months: [] };
    const cur = reportFabricFilters;
    // множественный выбор: наборами (Ctrl/Cmd-клик), пустой набор = все
    const optM = (v, label, arr) => `<option value="${esc(v)}"${arr.includes(v) ? ' selected' : ''}>${esc(label)}</option>`;
    const selBox = (id, label, inner) => `<label style="display:flex;flex-direction:column;font-size:11px;color:#667;gap:3px">${label}<select id="${id}" multiple size="5" style="padding:4px 6px;border:1px solid ${C.border};border-radius:8px;font-size:12.5px;min-width:150px;max-width:220px">${inner}</select></label>`;
    const plan = selBox('f-plan', 'Планшет', ff.plansheets.map((p) => optM(p, p, cur.plansheets)).join('') || '<option disabled>нет планшетов</option>');
    const art = selBox('f-art', 'Артикул', ff.articles.map((a) => optM(a.id, a.id + (a.name ? ' · ' + a.name : ''), cur.articleIds)).join('') || '<option disabled>нет артикулов</option>');
    const mon = selBox('f-month', 'Месяц', ff.months.map((m) => optM(m.ym, m.label, cur.months)).join('') || '<option disabled>нет месяцев</option>');
    const reset = `<button class="btn btn-subtle" id="f-reset"${view.filtered ? '' : ' disabled'} style="align-self:flex-end">Сбросить</button>`;
    filterBar = `<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:0 0 12px;padding:10px 12px;background:${C.zebra};border:1px solid ${C.border};border-radius:10px">
      <span style="font-weight:700;color:${C.head};font-size:13px;align-self:flex-end">🔎 Фильтр ткани:</span>${plan}${art}${mon}${reset}
      <span style="align-self:flex-end;font-size:11px;color:#889">выбор наборами: Ctrl/Cmd-клик · пусто = все</span>
      ${view.filtered ? `<span style="align-self:flex-end;font-size:12px;color:${C.accent};font-weight:700">консолидированный вид</span>` : ''}</div>`;
  }

  // период закупа — только для «Закупка ткани» и только БЕЗ активного фильтра (иначе вид консолидированный)
  const periodCtl = (rep.id === 'r2b' && !view.filtered)
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
    ${filterBar}
    ${reportHeaderHtml(rep, genAtIso)}
    ${body}`;

  const rerender = () => showReport(result, rep, data, genAtIso, ctx); // пересобирает view с текущими фильтрами/периодом
  result.querySelector('#rep-period')?.addEventListener('change', (e) => { reportPeriodMode = e.target.value === '2month' ? '2month' : 'month'; rerender(); });
  const readSel = (id) => [...(result.querySelector('#' + id)?.selectedOptions || [])].map((o) => o.value).filter(Boolean);
  result.querySelector('#f-plan')?.addEventListener('change', () => { reportFabricFilters.plansheets = readSel('f-plan'); rerender(); });
  result.querySelector('#f-art')?.addEventListener('change', () => { reportFabricFilters.articleIds = readSel('f-art'); rerender(); });
  result.querySelector('#f-month')?.addEventListener('change', () => { reportFabricFilters.months = readSel('f-month'); rerender(); });
  result.querySelector('#f-reset')?.addEventListener('click', () => { reportFabricFilters = { plansheets: [], articleIds: [], months: [] }; rerender(); });

  const saveBtn = result.querySelector('#rep-save');
  saveBtn.addEventListener('click', async () => {
    if (!api) { toast('Сохранение недоступно', true); return; }
    saveBtn.disabled = true;
    try {
      const r = await api('/api/reports/archive', { method: 'POST', body: JSON.stringify({ reportKind: rep.id, label: rep.name, data: view }) });
      saveBtn.textContent = `✓ Сохранено ${dmyhm((r && r.savedAt) || genAtIso)}`;
      saveBtn.classList.remove('btn-accent');
      toast('Отчёт сохранён в архив');
    } catch (e) { saveBtn.disabled = false; toast('Не удалось сохранить: ' + e.message, true); }
  });
  result.querySelector('#rep-xlsx').addEventListener('click', () => {
    if (!window.XLSX) { toast('Библиотека xlsx не загрузилась — обнови страницу', true); return; }
    try { reportExcel(rep, view, genAtIso); toast('Excel сформирован'); } catch (e) { toast('Ошибка Excel: ' + e.message, true); }
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
