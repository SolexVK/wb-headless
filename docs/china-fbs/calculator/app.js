/* ============================================================
   Калькулятор юнит-экономики WB — Китай (FBS / трансграница)
   Данные тарифов логистики — из официального тарифа WB для Китая
   (warehouse_and_tarrifs, действ. с 22.07.2026). Расчёты в юанях (¥),
   цены и прибыль дублируются в рублях.
   ============================================================ */

'use strict';

/* -------- Категории и ориентировочные комиссии кВВ (%) --------
   China POP: по факту 5–16%, у большинства категорий ~10%.
   ТОЧНЫЕ ставки смотрите в кабинете WB — их можно поправить вручную. */
const CATEGORIES = [
  { name: 'Одежда',            kvv: 10 },
  { name: 'Обувь',             kvv: 10 },
  { name: 'Аксессуары',        kvv: 13 },
  { name: 'Сумки',             kvv: 13 },
  { name: 'Красота и уход',    kvv: 12 },
  { name: 'Здоровье',          kvv: 10 },
  { name: 'Товары для дома',   kvv: 12 },
  { name: 'Кухня и посуда',    kvv: 12 },
  { name: 'Детские товары',    kvv: 10 },
  { name: 'Игрушки',           kvv: 13 },
  { name: 'Спорт и отдых',     kvv: 12 },
  { name: 'Электроника',       kvv: 10 },
  { name: 'Бытовая техника',   kvv: 8  },
  { name: 'Автотовары',        kvv: 12 },
  { name: 'Ювелирные изделия', kvv: 16 },
  { name: 'Прочее',            kvv: 12 },
];

/* -------- Логистические продукты WB (реальные тарифы, ¥) --------
   Тариф = ставка_за_кг × вес(округл. до 100 г) + фикс_за_заказ.
   Тариф ВКЛЮЧАЕТ обратную доставку на ФФ в РФ и хранение (оферта 13.1.11.2).
   light — заказы 0,1–0,3 кг; heavy — заказы 0,4–20 кг.
   limitSum / limitSide — лимиты габаритов упаковки, см. */
const LOGISTICS = {
  standard: { name: 'WB Standard — авто, 15–30 дн (большинство складов КНР)', light: { kg: 58, item: 2 }, heavy: { kg: 43, item: 8 },  limitSum: 200, limitSide: 120 },
  plus:     { name: 'WB Plus — авиа+авто, 6–7 дн (Хуньчунь/Дунгуань/Дуннин)',  light: { kg: 48, item: 9 }, heavy: { kg: 48, item: 9 },  limitSum: 200, limitSide: 120 },
  hk:       { name: 'WB Express — Гонконг, авиа, 10 дн',                        light: { kg: 89, item: 17 }, heavy: { kg: 89, item: 17 }, limitSum: 90,  limitSide: 60  },
  express:  { name: 'WB Express — Дунгуань, авиа, 10 дн',                       light: { kg: 122, item: 19 }, heavy: { kg: 122, item: 19 }, limitSum: 200, limitSide: 100 },
};

/* -------- Поля формы -------- */
const FIELDS = [
  // --- Курс валют ---
  { id: 'cbrRate',  group: 'Курс валют', label: 'Курс ЦБ, ₽ за 1 ¥', unit: '₽/¥', type: 'num', def: 12.0, step: 0.01,
    tip: 'Курс Центробанка РФ: сколько рублей стоит 1 юань. Обновите онлайн кнопкой ↻ или введите вручную. По нему считается реальная рублёвая стоимость прибыли и себестоимости.' },
  { id: 'wbMarkup', group: 'Курс валют', label: 'Надбавка «Курс ВБ»', unit: '%', type: 'pct', def: 0, step: 0.5,
    tip: 'Надбавка WB к курсу ЦБ, по которой считается рублёвая цена на витрине. WB ставит свой курс сам, до +10% к ЦБ. Точное значение видно в кабинете (рублёвая цена ÷ юаневую) — впишите фактическое. По умолчанию 0 = курс ЦБ.' },

  // --- Категория и цена ---
  { id: 'category',       group: 'Категория и цена', label: 'Категория товара', type: 'category',
    tip: 'Категория определяет ставку комиссии. При выборе ставка подставится в поле «Комиссия кВВ». Значения ориентировочные (China POP 5–16%), точные — в кабинете WB.' },
  { id: 'basePrice',      group: 'Категория и цена', label: 'Базовая цена (до скидок)', unit: '₽', type: 'num', def: 2500, step: 50,
    tip: 'Перечёркнутая цена на витрине до скидок. От неё вычитается ваша скидка → получается цена продажи (Рц).' },
  { id: 'sellerDiscount', group: 'Категория и цена', label: 'Скидка продавца', unit: '%', type: 'pct', def: 20, step: 1,
    tip: 'Ваша скидка от базовой цены. После неё получается «цена продажи без скидки WB» (Рц) — именно от неё WB считает комиссию и платит вам.' },
  { id: 'spp',            group: 'Категория и цена', label: 'Скидка WB (СПП)', unit: '%', type: 'pct', def: 5, step: 1,
    tip: 'Скидка постоянного покупателя от WB. Уменьшает цену на витрине для покупателя, но НЕ уменьшает то, что WB платит вам (оферта 5.4).' },
  { id: 'cogs',           group: 'Категория и цена', label: 'Себестоимость (закупка)', unit: 'CNY', type: 'num', def: 45, step: 1,
    tip: 'Ваши затраты на закупку/производство одной единицы, в юанях. Рядом показываем в рублях по курсу ЦБ.' },

  // --- Комиссия и сборы ---
  { id: 'kvv',     group: 'Комиссия и сборы', label: 'Комиссия кВВ', unit: '%', type: 'pct', def: 10, step: 0.5,
    tip: 'Комиссия WB за продажу, % от цены продажи (Рц, без скидки WB). Подставляется по категории. Если меньше 1%, WB считает её равной 1%.' },
  { id: 'finRate', group: 'Комиссия и сборы', label: 'Эквайринг + конвертация', unit: '%', type: 'pct', def: 3, step: 0.5,
    tip: 'Комиссия за приём оплаты и конвертацию валюты. Берётся дополнительно, сверх основной комиссии.' },

  // --- Габариты и вес ---
  { id: 'len',    group: 'Габариты и вес', label: 'Длина',  unit: 'см', type: 'num', def: 30, step: 1, tip: 'Длина упаковки, см. Габариты нужны для проверки лимитов склада и штрафа за неверные размеры. На СТОИМОСТЬ логистики влияет вес, не объём.' },
  { id: 'wid',    group: 'Габариты и вес', label: 'Ширина', unit: 'см', type: 'num', def: 25, step: 1, tip: 'Ширина упаковки, см.' },
  { id: 'hei',    group: 'Габариты и вес', label: 'Высота', unit: 'см', type: 'num', def: 5,  step: 1, tip: 'Высота упаковки, см.' },
  { id: 'weight', group: 'Габариты и вес', label: 'Вес с упаковкой', unit: 'кг', type: 'num', def: 0.4, step: 0.05,
    tip: 'Вес одной единицы с упаковкой, кг. Именно от веса считается логистика (округляется вверх до 100 г). Тариф разный для заказов 0,1–0,3 кг и 0,4–20 кг. Максимум 20 кг.' },

  // --- Логистика WB (доставка покупателю) ---
  { id: 'logisticsProduct', group: 'Логистика WB (до покупателя)', label: 'Способ доставки / склад', type: 'logistics',
    tip: 'Логистика WB — доставка от склада WB покупателю. Тариф = ставка за кг × вес + фикс за заказ. По оферте тариф УЖЕ включает обратную доставку возвратов на фулфилмент в РФ и хранение — поэтому отдельных строк «хранение» и «обратная логистика» нет. Это НЕ то же самое, что ваша доставка товара из Китая на ФФ (см. ниже).' },

  // --- Первая миля и фулфилмент (ваши расходы до передачи в WB) ---
  { id: 'chinaFreightPerKg', group: 'Доставка Китай→ФФ и фулфилмент', label: 'Доставка Китай→ФФ', unit: 'CNY/кг', type: 'num', def: 15, step: 0.5,
    tip: 'Ваша логистика: доставка товара из Китая на склад фулфилмента. Считается по весу: тариф за кг × вес 1 шт. Прибавляется к закупке и даёт «общую себестоимость до ВБ».' },
  { id: 'ffFeeRub', group: 'Доставка Китай→ФФ и фулфилмент', label: 'Услуги фулфилмента', unit: '₽/шт', type: 'num', def: 30, step: 5,
    tip: 'Стоимость услуг фулфилмента за 1 штуку: приёмка на склад ФФ с пересчётом, приёмка и обработка заказов от WB, наклейка QR-кодов, доставка и сдача в сортировочный центр WB. В рублях — пересчитывается в юани по курсу ЦБ.' },

  // --- Выкуп и возвраты ---
  { id: 'buyback', group: 'Выкуп и возвраты', label: 'Процент выкупа', unit: '%', type: 'pct', def: 65, step: 1,
    tip: 'Какая доля заказанных единиц реально выкупается (остальное — возвраты). Логистика платится за КАЖДЫЙ заказ, включая невыкупленные. На 1 продажу приходится 1/выкуп заказов — поэтому чем ниже выкуп, тем дороже логистика на проданную единицу.' },
  { id: 'returnBrakShare', group: 'Выкуп и возвраты', label: 'Доля возвратов в брак/утиль', unit: '%', type: 'pct', def: 10, step: 1,
    tip: 'Какая доля возвратов приходит негодной (брак/повреждения) и идёт в утилизацию — тогда теряется себестоимость и платится утилизация. Годные возвраты остаются на ФФ в РФ и снова продаются по FBS — их логистика уже учтена в тарифе.' },

  // --- Реклама и налоги ---
  { id: 'drr',        group: 'Реклама и налоги', label: 'ДРР (реклама, % от выручки)', unit: '%', type: 'pct', def: 8, step: 1,
    tip: 'Доля рекламных расходов от выручки (WB.Продвижение). Сколько процентов выручки уходит на продвижение.' },
  { id: 'utilFee',    group: 'Реклама и налоги', label: 'Утилизация за единицу', unit: 'CNY', type: 'num', def: 3, step: 0.5,
    tip: 'Плата WB за уничтожение негодной единицы: на складе ≈ 33 ₽ (≈ 3 ¥), на ПВЗ бесплатно. Применяется к доле возвратов, ушедших в брак.' },
  { id: 'fineReserve',group: 'Реклама и налоги', label: 'Резерв на штрафы (на ед.)', unit: 'CNY', type: 'num', def: 1, step: 0.5,
    tip: 'Запас на возможные штрафы WB на единицу: за сроки, брак, неверные габариты и т.п.' },
  { id: 'vatPayer',   group: 'Реклама и налоги', label: 'Я плательщик НДС в РФ', type: 'check', def: false,
    tip: 'Включайте, только если вы зарегистрированы как плательщик НДС в России. Продавец из Китая обычно НЕ платит НДС в РФ — оставьте выключенным.' },
  { id: 'vatRate',    group: 'Реклама и налоги', label: 'Ставка НДС РФ', unit: '%', type: 'pct', def: 22, step: 1,
    tip: 'Ставка НДС в России, если вы плательщик. Учитывается только при включённой галочке выше.' },
  { id: 'sellerTax',  group: 'Реклама и налоги', label: 'Налог продавца (% от прибыли)', unit: '%', type: 'pct', def: 0, step: 1,
    tip: 'Ваш собственный налог в стране регистрации (например, налог на прибыль в Китае), % от прибыли. Если не уверены — оставьте 0.' },
];

/* -------- Ядро расчёта -------- */
function computeUnit(v) {
  const wbRate = v.cbrRate * (1 + v.wbMarkup);       // курс витрины
  const cbr    = v.cbrRate;

  // Цепочка цен (₽)
  const baseRub  = v.basePrice;
  const priceRub = baseRub * (1 - v.sellerDiscount); // цена продажи без скидки WB (Рц) — база расчётов
  const buyerRub = priceRub * (1 - v.spp);           // цена для покупателя на витрине
  const revenue  = wbRate > 0 ? priceRub / wbRate : 0; // выручка продавца, ¥ (WB платит Рц в юанях)

  const kvvApplied = Math.max(v.kvv, 0.01);
  const commission = revenue * kvvApplied;
  const fin        = revenue * v.finRate;

  const weightKg = Math.ceil(v.weight * 10) / 10;
  const lp = LOGISTICS[v.logisticsProduct] || LOGISTICS.standard;
  const br = weightKg <= 0.3 ? lp.light : lp.heavy;
  const logOrder = br.kg * weightKg + br.item;       // тариф за 1 заказ (вкл. возврат+хранение)

  const p = v.buyback;
  const ordersPerSale  = p > 0 ? 1 / p : 0;
  const returnsPerSale = p > 0 ? (1 - p) / p : 0;
  const brak = v.returnBrakShare;

  const vat = v.vatPayer ? revenue - revenue / (1 + v.vatRate) : 0;

  const firstMile = v.chinaFreightPerKg * v.weight;  // Китай→ФФ, ¥ на 1 шт (по весу)
  const ffCost    = cbr > 0 ? v.ffFeeRub / cbr : 0;  // услуги ФФ, ₽→¥
  const cogsTotal = v.cogs + firstMile;              // общая себестоимость до ВБ

  const costs = {
    cogs:      v.cogs,
    firstMile,                                       // доставка Китай→ФФ
    ff:        ffCost,                               // услуги фулфилмента
    commission,
    fin,
    logistics: logOrder * ordersPerSale,             // логистика WB на все заказы (вкл. возвраты)
    lossGoods: cogsTotal * returnsPerSale * brak,    // потеря общей себестоимости на брак-возвраты
    utilFee:   v.utilFee * returnsPerSale * brak,
    promo:     revenue * v.drr,
    vat,
    fine:      v.fineReserve,
  };

  const totalCost = Object.values(costs).reduce((a, b) => a + b, 0);
  const profitBeforeTax = revenue - totalCost;
  const sellerTaxAmt = Math.max(0, profitBeforeTax) * v.sellerTax;
  const profit = profitBeforeTax - sellerTaxAmt;

  // Проверка лимитов габаритов
  const dimSum = v.len + v.wid + v.hei;
  const maxSide = Math.max(v.len, v.wid, v.hei);
  const overLimit = dimSum > lp.limitSum || maxSide > lp.limitSide;

  return {
    wbRate, cbr,
    baseRub, priceRub, buyerRub, revenue, cogsRub: v.cogs * cbr,
    firstMile, ffCost, cogsTotal, cogsTotalRub: cogsTotal * cbr,
    kvvApplied, weightKg, logOrder, lpName: lp.name,
    ordersPerSale, returnsPerSale,
    costs, totalCost,
    profitBeforeTax, sellerTaxAmt, profit,
    margin: revenue > 0 ? profit / revenue : 0,
    markupOnCogs: v.cogs > 0 ? profit / v.cogs : 0,
    profitRub: profit * cbr,
    dimSum, maxSide, overLimit, limitSum: lp.limitSum, limitSide: lp.limitSide,
  };
}

function marginFor(v, buyback, drr) {
  return computeUnit(Object.assign({}, v, { buyback, drr })).margin;
}

/* ---------------- UI ---------------- */
const COST_LABELS = {
  cogs:      'Себестоимость закупки',
  firstMile: 'Логистика Китай→ФФ',
  ff:        'Услуги фулфилмента',
  commission:'Комиссия WB',
  fin:       'Эквайринг + конвертация',
  logistics: 'Логистика (вкл. возвраты и хранение)',
  lossGoods: 'Потеря себестоимости (брак-возвраты)',
  utilFee:   'Утилизация брака',
  promo:     'Реклама (ДРР)',
  vat:       'НДС',
  fine:      'Резерв на штрафы',
};

const fmt = (x, d = 2) => (isFinite(x) ? x : 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x) => (isFinite(x) ? x * 100 : 0).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';

function readInputs() {
  const v = {};
  for (const f of FIELDS) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    if (f.type === 'check') { v[f.id] = el.checked; continue; }
    if (f.type === 'category' || f.type === 'logistics') { v[f.id] = el.value; continue; }
    let n = parseFloat(String(el.value).replace(',', '.'));
    if (!isFinite(n)) n = 0;
    v[f.id] = f.type === 'pct' ? n / 100 : n;
  }
  return v;
}

function buildForm() {
  const form = document.getElementById('form');
  const groups = [];
  const byGroup = {};
  for (const f of FIELDS) {
    if (!byGroup[f.group]) { byGroup[f.group] = []; groups.push(f.group); }
    byGroup[f.group].push(f);
  }
  for (const g of groups) {
    const sec = document.createElement('section');
    sec.className = 'card';
    sec.innerHTML = `<h3 class="card-title">${g}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'field-grid';
    for (const f of byGroup[g]) grid.appendChild(buildField(f));
    sec.appendChild(grid);
    form.appendChild(sec);
  }
}

function tipIcon(tip) {
  return tip ? `<span class="tip" tabindex="0" data-tip="${tip.replace(/"/g, '&quot;')}">ⓘ</span>` : '';
}

function buildField(f) {
  const wrap = document.createElement('label');
  wrap.className = 'field' + (f.type === 'check' ? ' field-check' : '');
  const wide = (f.type === 'category' || f.type === 'logistics');
  if (wide) wrap.style.gridColumn = '1 / -1';

  if (f.type === 'check') {
    wrap.innerHTML = `<input type="checkbox" id="${f.id}" ${f.def ? 'checked' : ''}><span class="field-label">${f.label} ${tipIcon(f.tip)}</span>`;
    return wrap;
  }

  let control;
  if (f.type === 'category') {
    control = `<select id="${f.id}">` + CATEGORIES.map(c => `<option value="${c.name}">${c.name} · ${c.kvv}%</option>`).join('') + `</select>`;
  } else if (f.type === 'logistics') {
    control = `<select id="${f.id}">` + Object.keys(LOGISTICS).map(k => `<option value="${k}">${LOGISTICS[k].name}</option>`).join('') + `</select>`;
  } else {
    control = `<div class="input-wrap"><input type="number" id="${f.id}" value="${f.def}" step="${f.step || 'any'}" inputmode="decimal"><span class="unit">${f.unit || ''}</span></div>`;
  }
  wrap.innerHTML =
    `<span class="field-label">${f.label} ${tipIcon(f.tip)}</span>
     ${control}
     ${f.id === 'cbrRate' ? '<button type="button" id="fetchRate" class="mini-btn">↻ Обновить курс онлайн</button><span id="rateStatus" class="rate-status"></span>' : ''}`;
  return wrap;
}

function render() {
  const v = readInputs();
  const r = computeUnit(v);
  const cls = r.profit >= 0 ? 'pos' : 'neg';

  document.getElementById('kpi').innerHTML = `
    <div class="kpi-main ${cls}">
      <div class="kpi-label">Чистая прибыль на выкупленную единицу</div>
      <div class="kpi-value">${fmt(r.profit)} <span class="cny">¥</span></div>
      <div class="kpi-sub">≈ ${fmt(r.profitRub)} ₽ <span class="muted">· по курсу ЦБ ${fmt(r.cbr, 2)} ₽/¥</span></div>
    </div>
    <div class="kpi-row">
      <div class="kpi-cell ${cls}"><span>Маржинальность</span><b>${pct(r.margin)}</b></div>
      <div class="kpi-cell"><span>Наценка к с/с</span><b>${pct(r.markupOnCogs)}</b></div>
    </div>
    <div class="kpi-row">
      <div class="kpi-cell"><span>Выручка (платят вам)</span><b>${fmt(r.revenue)} ¥</b></div>
      <div class="kpi-cell"><span>Затраты</span><b>${fmt(r.totalCost)} ¥</b></div>
    </div>
    ${r.sellerTaxAmt > 0 ? `<div class="kpi-row"><div class="kpi-cell"><span>До налога продавца</span><b>${fmt(r.profitBeforeTax)} ¥</b></div><div class="kpi-cell"><span>Налог продавца</span><b>−${fmt(r.sellerTaxAmt)} ¥</b></div></div>` : ''}`;

  document.getElementById('prices').innerHTML = `
    <div class="price-row"><span>Базовая цена (до скидок)</span><b>${fmt(r.baseRub, 0)} ₽</b></div>
    <div class="price-row"><span>Цена продажи Рц (без скидки WB)</span><b>${fmt(r.priceRub, 0)} ₽</b><small>${fmt(r.revenue, 2)} ¥ — от неё считается комиссия и выплата</small></div>
    <div class="price-row hl"><span>Цена для покупателя (со скидкой WB)</span><b>${fmt(r.buyerRub, 0)} ₽</b></div>
    <div class="price-row"><span>Общая себестоимость до ВБ (закупка + Китай→ФФ)</span><b>${fmt(r.cogsTotal, 2)} ¥</b><small>≈ ${fmt(r.cogsTotalRub, 0)} ₽ · закупка ${fmt(v.cogs, 0)} ¥ + доставка ${fmt(r.firstMile, 2)} ¥</small></div>
    <div class="price-note">Витрина — по Курсу ВБ ${fmt(r.wbRate, 2)} ₽/¥ (ЦБ ${fmt(r.cbr, 2)} + надбавка). Прибыль в ₽ — по курсу ЦБ (реальная стоимость юаней). Услуги ФФ ${fmt(v.ffFeeRub, 0)} ₽ ≈ ${fmt(r.ffCost, 2)} ¥.</div>`;

  const maxCost = Math.max(r.revenue, ...Object.values(r.costs));
  const rows = Object.keys(COST_LABELS).map(k => {
    const val = r.costs[k];
    const w = maxCost > 0 ? (val / maxCost) * 100 : 0;
    const share = r.revenue > 0 ? val / r.revenue : 0;
    return `<div class="bar-row"><div class="bar-name">${COST_LABELS[k]}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><div class="bar-val">${fmt(val)} ¥<small>${pct(share)}</small></div></div>`;
  }).join('');
  document.getElementById('breakdown').innerHTML = `
    <div class="bar-row bar-head"><div class="bar-name">Статья затрат</div><div class="bar-track"></div><div class="bar-val">¥ · % от Рц</div></div>
    ${rows}
    <div class="bar-row bar-total"><div class="bar-name">ИТОГО затраты</div><div class="bar-track"></div><div class="bar-val">${fmt(r.totalCost)} ¥<small>${pct(r.revenue > 0 ? r.totalCost / r.revenue : 0)}</small></div></div>
    <div class="logistics-explain">
      Логистика: <b>${fmt(r.logOrder, 2)} ¥</b> за заказ (${r.lpName.split('—')[0].trim()}, вес ${fmt(r.weightKg, 1)} кг).
      На 1 продажу — <b>${fmt(r.ordersPerSale, 2)}</b> заказов (выкуп ${pct(v.buyback)}), поэтому логистика на единицу = ${fmt(r.costs.logistics, 2)} ¥.
      Тариф уже включает возврат на ФФ в РФ и хранение.
      ${r.overLimit ? `<div class="warn">⚠ Габариты превышают лимит склада (сумма сторон ${fmt(r.dimSum,0)}/${r.limitSum} см, макс. сторона ${fmt(r.maxSide,0)}/${r.limitSide} см) — товар могут не принять.</div>` : ''}
    </div>`;

  renderSensitivity(v);
}

function renderSensitivity(v) {
  const buybacks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const drrs = [0, 0.05, 0.08, 0.10, 0.15, 0.20];
  let html = '<table class="sens"><thead><tr><th>выкуп ↓ / ДРР →</th>';
  for (const d of drrs) html += `<th>${(d * 100).toFixed(0)}%</th>`;
  html += '</tr></thead><tbody>';
  for (const b of buybacks) {
    html += `<tr><th>${(b * 100).toFixed(0)}%</th>`;
    for (const d of drrs) {
      const m = marginFor(v, b, d);
      html += `<td class="${heatClass(m)}">${(m * 100).toFixed(0)}%</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('sensitivity').innerHTML = html;
}

function heatClass(m) {
  if (m < 0)    return 'h-neg';
  if (m < 0.05) return 'h-low';
  if (m < 0.15) return 'h-mid';
  return 'h-hi';
}

function applyCategory() {
  const sel = document.getElementById('category');
  const cat = CATEGORIES.find(c => c.name === sel.value);
  if (cat) document.getElementById('kvv').value = cat.kvv;
  render();
}

async function fetchRate() {
  const status = document.getElementById('rateStatus');
  status.textContent = 'загрузка…';
  status.className = 'rate-status';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    const cny = data.Valute.CNY;
    const rate = cny.Value / cny.Nominal;
    document.getElementById('cbrRate').value = rate.toFixed(2);
    const d = data.Date ? new Date(data.Date).toLocaleDateString('ru-RU') : '';
    status.textContent = `курс ЦБ на ${d}: ${rate.toFixed(2)} ₽/¥`;
    status.className = 'rate-status ok';
    render();
  } catch (e) {
    status.textContent = 'не удалось загрузить (введите вручную)';
    status.className = 'rate-status err';
  }
}

function resetDefaults() {
  for (const f of FIELDS) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    if (f.type === 'check') el.checked = f.def;
    else if (f.type === 'category' || f.type === 'logistics') el.selectedIndex = 0;
    else el.value = f.def;
  }
  render();
}

document.addEventListener('DOMContentLoaded', () => {
  buildForm();
  document.getElementById('form').addEventListener('input', render);
  document.getElementById('form').addEventListener('change', render);
  document.getElementById('category').addEventListener('change', applyCategory);
  document.getElementById('fetchRate').addEventListener('click', fetchRate);
  document.getElementById('reset').addEventListener('click', resetDefaults);
  document.getElementById('theme').addEventListener('click', () => {
    const root = document.documentElement;
    root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  render();
  fetchRate();
});
