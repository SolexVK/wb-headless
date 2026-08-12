/* ============================================================
   Калькулятор юнит-экономики WB — Китай (FBS / трансграница)
   Расчёты в юанях (CNY, валюта договора). Цены и итоги дублируются в рублях.
   ============================================================ */

'use strict';

/* -------- Категории и ориентировочные комиссии (кВВ, %) --------
   ВНИМАНИЕ: значения — ориентир. Реальную ставку по вашей категории
   смотрите в кабинете WB (тарифы меняются). Ставку можно поправить вручную. */
const CATEGORIES = [
  { name: 'Одежда',                kvv: 25 },
  { name: 'Обувь',                 kvv: 25 },
  { name: 'Аксессуары',            kvv: 22 },
  { name: 'Сумки',                 kvv: 22 },
  { name: 'Красота и уход',        kvv: 20 },
  { name: 'Здоровье',              kvv: 18 },
  { name: 'Товары для дома',       kvv: 20 },
  { name: 'Кухня и посуда',        kvv: 20 },
  { name: 'Детские товары',        kvv: 20 },
  { name: 'Игрушки',               kvv: 22 },
  { name: 'Спорт и отдых',         kvv: 22 },
  { name: 'Электроника',           kvv: 15 },
  { name: 'Бытовая техника',       kvv: 15 },
  { name: 'Автотовары',            kvv: 18 },
  { name: 'Ювелирные изделия',     kvv: 20 },
  { name: 'Прочее',                kvv: 20 },
];

/* -------- Конфигурация полей (структура формы) --------
   type: 'num' | 'pct' | 'select' | 'check' | 'category'
   cur: 'cny' | 'rub' — валюта денежного поля (для подписи/пересчёта)
   pct-поля вводятся в процентах (20), в модель идут долей (0.20).
   tip — подсказка простым языком (по наведению на ⓘ).                      */
const FIELDS = [
  // --- Курс валют ---
  { id: 'cbrRate',  group: 'Курс валют', label: 'Курс ЦБ, ₽ за 1 ¥', unit: '₽/¥', type: 'num', def: 12.0, step: 0.01,
    tip: 'Курс Центробанка РФ: сколько рублей стоит 1 юань. Обновите онлайн кнопкой ↻ или введите вручную. По этому курсу считается реальная рублёвая стоимость вашей выручки, прибыли и себестоимости.' },
  { id: 'wbMarkup', group: 'Курс валют', label: 'Надбавка «Курс ВБ»', unit: '%', type: 'pct', def: 8, step: 0.5,
    tip: 'Надбавка WB к курсу ЦБ для показа цены покупателю в рублях. WB вправе завышать курс, но не более чем на 10%. На вашу выручку в юанях не влияет — влияет только на рублёвую цену для покупателя.' },

  // --- Товар и категория ---
  { id: 'category', group: 'Товар и цена', label: 'Категория товара', type: 'category',
    tip: 'Категория на WB определяет ставку комиссии. При выборе ставка подставится в поле «Комиссия кВВ» — её можно поправить вручную. Значения ориентировочные, уточняйте в кабинете WB.' },
  { id: 'price',    group: 'Товар и цена', label: 'Цена продажи (Рц)', unit: 'CNY', type: 'num', def: 150, step: 1,
    tip: 'Цена продажи в юанях, которую вы устанавливаете. Именно её (в юанях) WB перечисляет вам за проданный товар. Скидка WB покупателю эту сумму НЕ уменьшает. Рублёвые цены на витрине считаются от неё по Курсу ВБ.' },
  { id: 'cogs',     group: 'Товар и цена', label: 'Себестоимость (закупка)', unit: 'CNY', type: 'num', def: 45, step: 1,
    tip: 'Ваши затраты на закупку или производство одной единицы товара, в юанях. Рядом показываем в рублях по курсу ЦБ.' },
  { id: 'sellerDiscount', group: 'Товар и цена', label: 'Ваша скидка (от базовой)', unit: '%', type: 'pct', def: 0, step: 1,
    tip: 'Скидка от базовой (перечёркнутой) цены. Нужна только чтобы показать зачёркнутую цену выше на витрине. На выручку не влияет — цену продажи вы уже задали выше.' },
  { id: 'wbDiscount', group: 'Товар и цена', label: 'Скидка WB покупателю', unit: '%', type: 'pct', def: 0, step: 1,
    tip: 'Скидка, которую сам WB даёт покупателю от вашей цены. Уменьшает цену на витрине для покупателя, но НЕ уменьшает сумму, которую WB платит вам.' },

  // --- Комиссия и сборы ---
  { id: 'kvv',     group: 'Комиссия и сборы', label: 'Комиссия кВВ', unit: '%', type: 'pct', def: 20, step: 0.5,
    tip: 'Комиссия WB за продажу, % от цены. Зависит от категории. Если получается меньше 1%, WB считает её равной 1%.' },
  { id: 'finRate', group: 'Комиссия и сборы', label: 'Эквайринг + конвертация', unit: '%', type: 'pct', def: 3, step: 0.5,
    tip: 'Комиссия за приём оплаты от покупателя и конвертацию валюты. Берётся дополнительно, СВЕРХ основной комиссии.' },

  // --- Габариты и вес ---
  { id: 'len',    group: 'Габариты и вес', label: 'Длина',  unit: 'см', type: 'num', def: 30, step: 1, tip: 'Длина упаковки, см. Нужна для объёма и логистики. Указывайте честно — за занижение размеров WB штрафует.' },
  { id: 'wid',    group: 'Габариты и вес', label: 'Ширина', unit: 'см', type: 'num', def: 25, step: 1, tip: 'Ширина упаковки, см.' },
  { id: 'hei',    group: 'Габариты и вес', label: 'Высота', unit: 'см', type: 'num', def: 5,  step: 1, tip: 'Высота упаковки, см.' },
  { id: 'weight', group: 'Габариты и вес', label: 'Вес с упаковкой', unit: 'кг', type: 'num', def: 0.4, step: 0.05,
    tip: 'Вес одной единицы вместе с упаковкой, кг. Для международной доставки максимум 20 кг. При расчёте логистики вес округляется вверх до 100 г.' },
  { id: 'noDims', group: 'Габариты и вес', label: 'Габариты в карточке НЕ указаны', type: 'check', def: false,
    tip: 'Если не заполнить размеры в карточке товара, WB берёт логистику и хранение по максимальному коэффициенту (×25). Держите выключенным, если размеры указаны.' },
  { id: 'soa',    group: 'Габариты и вес', label: 'Расхождение размеров (факт vs карточка)', unit: '%', type: 'pct', def: 8, step: 1,
    tip: 'Насколько фактические размеры отличаются от указанных в карточке. Чем больше расхождение — тем выше коэффициент к логистике и хранению: ≤10%→1; ≤25%→1,5; ≤50%→2; ≤100%→3; больше→4.' },

  // --- Логистика ---
  { id: 'logPerKg',    group: 'Логистика', label: 'Тариф логистики за 1 кг', unit: 'CNY/кг', type: 'num', def: 20, step: 0.5,
    tip: 'Тариф доставки до покупателя за 1 кг веса. Вес округляется вверх до 100 г. Итоговая логистика заказа = тариф за кг × вес + фикс за заказ, всё умножается на коэффициент габаритов.' },
  { id: 'logPerOrder', group: 'Логистика', label: 'Фикс. часть за заказ',    unit: 'CNY',    type: 'num', def: 5,  step: 0.5,
    tip: 'Фиксированная часть тарифа логистики за один заказ, не зависящая от веса.' },
  { id: 'returnLog',   group: 'Логистика', label: 'Обратная логистика за возврат', unit: 'CNY', type: 'num', def: 12, step: 0.5,
    tip: 'Стоимость возврата одного невыкупленного товара от покупателя обратно на фулфилмент WB в России. Товар остаётся в РФ и снова продаётся по FBS — обратно в Китай он НЕ едет. Платится за каждый возврат.' },

  // --- Хранение ---
  { id: 'storagePerDay', group: 'Хранение', label: 'Хранение за 1 день',  unit: 'CNY/дн', type: 'num', def: 0.1, step: 0.01,
    tip: 'Стоимость хранения одной единицы на складе WB за один день. Умножается на коэффициент габаритов.' },
  { id: 'storageDays',   group: 'Хранение', label: 'Дней хранения (среднее)', unit: 'дн', type: 'num', def: 20, step: 1,
    tip: 'Сколько в среднем дней товар лежит на складе до продажи. Зависит от оборачиваемости.' },

  // --- Выкуп и возвраты ---
  { id: 'buyback', group: 'Выкуп и возвраты', label: 'Процент выкупа', unit: '%', type: 'pct', def: 70, step: 1,
    tip: 'Какая доля заказанных единиц реально выкупается покупателями (остальное — возвраты). Чем ниже выкуп, тем больше логистики вы платите на каждую проданную единицу: на 1 продажу приходится 1/выкуп заказов.' },
  { id: 'returnUtilShare', group: 'Выкуп и возвраты', label: 'Доля возвратов в брак/утиль', unit: '%', type: 'pct', def: 5, step: 1,
    tip: 'Какая доля возвратов приходит негодной (брак, повреждения) и идёт в утилизацию — тогда теряется себестоимость и платится утилизация. Годные возвраты снова продаются и здесь не учитываются.' },

  // --- Прочее и налоги ---
  { id: 'utilFee',    group: 'Прочее и налоги', label: 'Тариф утилизации за единицу', unit: 'CNY', type: 'num', def: 3, step: 0.5,
    tip: 'Плата WB за уничтожение единицы товара, который нельзя продать: брак, повреждённый или невостребованный. Применяется к доле возвратов, ушедших в брак.' },
  { id: 'drr',        group: 'Прочее и налоги', label: 'ДРР (реклама, % от выручки)', unit: '%', type: 'pct', def: 8, step: 1,
    tip: 'Доля рекламных расходов от выручки (WB.Продвижение). Сколько процентов от выручки вы тратите на продвижение.' },
  { id: 'fineReserve', group: 'Прочее и налоги', label: 'Резерв на штрафы (на ед.)', unit: 'CNY', type: 'num', def: 1, step: 0.5,
    tip: 'Запас на возможные штрафы WB в расчёте на единицу товара: за сроки поставки, брак, неверные габариты и т.п.' },
  { id: 'vatPayer',   group: 'Прочее и налоги', label: 'Я плательщик НДС в РФ', type: 'check', def: false,
    tip: 'Включайте, только если вы зарегистрированы как плательщик НДС в России. Продавец из Китая обычно НЕ платит НДС в РФ — тогда оставьте выключенным.' },
  { id: 'vatRate',    group: 'Прочее и налоги', label: 'Ставка НДС РФ', unit: '%', type: 'pct', def: 22, step: 1,
    tip: 'Ставка НДС в России, если вы плательщик. Учитывается только при включённой галочке выше.' },
  { id: 'sellerTax',  group: 'Прочее и налоги', label: 'Налог продавца (% от прибыли)', unit: '%', type: 'pct', def: 0, step: 1,
    tip: 'Ваш собственный налог в стране регистрации (например, налог на прибыль в Китае). Считается от прибыли. Если не уверены — оставьте 0 и посчитаете отдельно.' },
];

/* -------- Ядро расчёта: чистая функция -------- */
function computeUnit(v) {
  const wbRate = v.cbrRate * (1 + v.wbMarkup);       // курс для витрины (руб. цена покупателю)
  const cbr    = v.cbrRate;                          // реальный курс (руб. стоимость денег)

  // Цены (₽) — витрина
  const price       = v.price;                       // Рц, CNY (выручка продавца)
  const priceRub    = price * wbRate;                // цена продажи без скидки WB, ₽
  const baseRub     = v.sellerDiscount < 1 ? priceRub / (1 - v.sellerDiscount) : priceRub; // базовая (перечёркнутая), ₽
  const buyerRub    = priceRub * (1 - v.wbDiscount); // цена для покупателя, ₽

  const kvvApplied = Math.max(v.kvv, 0.01);          // мин. 1%
  const commission = price * kvvApplied;
  const fin        = price * v.finRate;

  const volumeL  = Math.max(1, Math.ceil((v.len * v.wid * v.hei) / 1000));
  const klh      = v.noDims ? 25 : klhFromSoa(v.soa);
  const weightKg = Math.ceil(v.weight * 10) / 10;    // округление вверх до 100 г

  const logOrder  = (v.logPerKg * weightKg + v.logPerOrder) * klh; // логистика доставки за 1 заказ
  const logReturn = v.returnLog;                                    // обратная логистика за 1 возврат
  const storage   = v.storagePerDay * v.storageDays * klh;

  const p = v.buyback;                               // процент выкупа (доля)
  const ordersPerSale  = p > 0 ? 1 / p : 0;          // заказов на 1 продажу
  const returnsPerSale = p > 0 ? (1 - p) / p : 0;    // возвратов на 1 продажу
  const utilShare = v.returnUtilShare;

  const vat = v.vatPayer ? price - price / (1 + v.vatRate) : 0;

  // Затраты на 1 ВЫКУПЛЕННУЮ единицу
  const costs = {
    cogs:      v.cogs,                                            // себестоимость проданной единицы
    commission,
    fin,
    logFwd:    logOrder * ordersPerSale,                          // прямая логистика на ВСЕ заказы
    logBack:   logReturn * returnsPerSale,                        // обратная логистика на возвраты
    lossGoods: v.cogs * returnsPerSale * utilShare,               // потеря себестоимости на брак-возвраты
    utilFee:   v.utilFee * returnsPerSale * utilShare,            // утилизация брака
    storage,
    promo:     price * v.drr,
    vat,
    fine:      v.fineReserve,
  };

  const totalCost = Object.values(costs).reduce((a, b) => a + b, 0);
  const profitBeforeTax = price - totalCost;
  const sellerTaxAmt = Math.max(0, profitBeforeTax) * v.sellerTax;
  const profit = profitBeforeTax - sellerTaxAmt;

  return {
    wbRate, cbr,
    priceRub, baseRub, buyerRub,
    cogsRub: v.cogs * cbr,
    kvvApplied, volumeL, klh, weightKg,
    logOrder, logReturn, storage, ordersPerSale, returnsPerSale,
    costs, totalCost,
    revenue: price,
    profitBeforeTax, sellerTaxAmt,
    profit,
    margin: price > 0 ? profit / price : 0,
    markupOnCogs: v.cogs > 0 ? profit / v.cogs : 0,
    profitRub: profit * cbr,          // реальная рублёвая стоимость прибыли (по курсу ЦБ)
  };
}

function klhFromSoa(soa) {
  if (soa <= 0.10) return 1;
  if (soa <= 0.25) return 1.5;
  if (soa <= 0.50) return 2;
  if (soa <= 1.00) return 3;
  return 4;
}

function marginFor(v, buyback, kvv) {
  return computeUnit(Object.assign({}, v, { buyback, kvv })).margin;
}

/* ---------------- UI ---------------- */
const COST_LABELS = {
  cogs:      'Себестоимость товара',
  commission:'Комиссия WB',
  fin:       'Эквайринг + конвертация',
  logFwd:    'Логистика прямая (на все заказы)',
  logBack:   'Логистика обратная (возвраты)',
  lossGoods: 'Потеря себестоимости (брак-возвраты)',
  utilFee:   'Утилизация брака',
  storage:   'Хранение',
  promo:     'Продвижение / реклама',
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
    if (f.type === 'category') { v[f.id] = el.value; continue; }
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
  if (!tip) return '';
  return `<span class="tip" tabindex="0" data-tip="${tip.replace(/"/g, '&quot;')}">ⓘ</span>`;
}

function buildField(f) {
  const wrap = document.createElement('label');
  wrap.className = 'field' + (f.type === 'check' ? ' field-check' : '');

  if (f.type === 'check') {
    wrap.innerHTML =
      `<input type="checkbox" id="${f.id}" ${f.def ? 'checked' : ''}>
       <span class="field-label">${f.label} ${tipIcon(f.tip)}</span>`;
    return wrap;
  }

  let control;
  if (f.type === 'category') {
    control = `<select id="${f.id}">` +
      CATEGORIES.map(c => `<option value="${c.name}">${c.name} · ${c.kvv}%</option>`).join('') +
      `</select>`;
  } else {
    control = `<div class="input-wrap">
        <input type="number" id="${f.id}" value="${f.def}" step="${f.step || 'any'}" inputmode="decimal">
        <span class="unit">${f.unit || ''}</span>
      </div>`;
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

  // KPI
  const kpi = document.getElementById('kpi');
  const cls = r.profit >= 0 ? 'pos' : 'neg';
  kpi.innerHTML = `
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
      <div class="kpi-cell"><span>Выручка</span><b>${fmt(r.revenue)} ¥</b></div>
      <div class="kpi-cell"><span>Затраты</span><b>${fmt(r.totalCost)} ¥</b></div>
    </div>
    ${r.sellerTaxAmt > 0 ? `<div class="kpi-row"><div class="kpi-cell"><span>До налога продавца</span><b>${fmt(r.profitBeforeTax)} ¥</b></div><div class="kpi-cell"><span>Налог продавца</span><b>−${fmt(r.sellerTaxAmt)} ¥</b></div></div>` : ''}`;

  // Цены на витрине (₽)
  document.getElementById('prices').innerHTML = `
    <div class="price-row"><span>Базовая цена (перечёркнутая)</span><b>${fmt(r.baseRub, 0)} ₽</b></div>
    <div class="price-row"><span>Цена продажи (без скидки WB)</span><b>${fmt(r.priceRub, 0)} ₽</b><small>${fmt(r.revenue, 2)} ¥ — платят вам</small></div>
    <div class="price-row hl"><span>Цена для покупателя</span><b>${fmt(r.buyerRub, 0)} ₽</b></div>
    <div class="price-note">Курс ВБ ${fmt(r.wbRate, 2)} ₽/¥ (ЦБ ${fmt(r.cbr, 2)} + надбавка). Себестоимость: ${fmt(readInputs().cogs, 2)} ¥ ≈ ${fmt(r.cogsRub, 2)} ₽.</div>`;

  // Разбивка затрат
  const maxCost = Math.max(r.revenue, ...Object.values(r.costs));
  const rows = Object.keys(COST_LABELS).map(k => {
    const val = r.costs[k];
    const w = maxCost > 0 ? (val / maxCost) * 100 : 0;
    const share = r.revenue > 0 ? val / r.revenue : 0;
    return `<div class="bar-row">
        <div class="bar-name">${COST_LABELS[k]}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
        <div class="bar-val">${fmt(val)} ¥<small>${pct(share)}</small></div>
      </div>`;
  }).join('');
  document.getElementById('breakdown').innerHTML = `
    <div class="bar-row bar-head"><div class="bar-name">Статья затрат</div><div class="bar-track"></div><div class="bar-val">¥ · % от Рц</div></div>
    ${rows}
    <div class="bar-row bar-total"><div class="bar-name">ИТОГО затраты</div><div class="bar-track"></div>
      <div class="bar-val">${fmt(r.totalCost)} ¥<small>${pct(r.revenue > 0 ? r.totalCost / r.revenue : 0)}</small></div></div>
    <div class="logistics-explain">
      На 1 продажу приходится <b>${fmt(r.ordersPerSale, 2)}</b> заказов и <b>${fmt(r.returnsPerSale, 2)}</b> возвратов
      (выкуп ${pct(v.buyback)}). Прямая логистика — ${fmt(r.logOrder, 2)} ¥ за заказ, обратная — ${fmt(r.logReturn, 2)} ¥ за возврат.
    </div>`;

  renderSensitivity(v);
}

function renderSensitivity(v) {
  const buybacks = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const kvvs = [0.10, 0.15, 0.20, 0.25, 0.30];
  let html = '<table class="sens"><thead><tr><th>выкуп ↓ / кВВ →</th>';
  for (const k of kvvs) html += `<th>${(k * 100).toFixed(0)}%</th>`;
  html += '</tr></thead><tbody>';
  for (const b of buybacks) {
    html += `<tr><th>${(b * 100).toFixed(0)}%</th>`;
    for (const k of kvvs) {
      const m = marginFor(v, b, k);
      html += `<td class="${heatClass(m)}">${(m * 100).toFixed(1)}%</td>`;
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
    else if (f.type === 'category') el.selectedIndex = 0;
    else el.value = f.def;
  }
  render();
}

document.addEventListener('DOMContentLoaded', () => {
  buildForm();
  document.getElementById('form').addEventListener('input', render);
  document.getElementById('category').addEventListener('change', applyCategory);
  document.getElementById('fetchRate').addEventListener('click', fetchRate);
  document.getElementById('reset').addEventListener('click', resetDefaults);
  document.getElementById('theme').addEventListener('click', () => {
    const root = document.documentElement;
    root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  render();
  fetchRate();   // попытка подтянуть курс онлайн (в песочнице артефакта может быть заблокировано)
});
