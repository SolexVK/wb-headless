/* ============================================================
   Калькулятор юнит-экономики WB — Китай (FBS / трансграница)
   Модель затрат по оферте WB (RU-версия приоритетна, п. 2.5).
   Все денежные значения — в юанях (CNY), валюта договора (п. 5.12).
   ============================================================ */

'use strict';

/* -------- Конфигурация полей ввода (структура формы) --------
   type: 'num' | 'pct' | 'select' | 'check'
   pct-поля вводятся в процентах (20), в модель идут как доля (0.20).      */
const FIELDS = [
  // --- Валюта ---
  { id: 'cbrRate',   group: 'Валюта',            label: 'Курс ЦБ, CNY→RUB',            unit: '₽/¥',  type: 'num', def: 12.0,  step: 0.01, hint: 'Официальный курс ЦБ РФ' },
  { id: 'wbMarkup',  group: 'Валюта',            label: 'Наценка «Курс ВБ» (≤10%)',    unit: '%',    type: 'pct', def: 8,     step: 0.5,  hint: 'п. 5.1.1 — не выше курса ЦБ +10%' },

  // --- Цена и себестоимость ---
  { id: 'price',     group: 'Цена и себестоимость', label: 'Розничная цена Рц',        unit: 'CNY',  type: 'num', def: 150,   step: 1,    hint: 'п. 5.1 — задаётся в юанях' },
  { id: 'cogs',      group: 'Цена и себестоимость', label: 'Себестоимость закупки',    unit: 'CNY',  type: 'num', def: 45,    step: 1,    hint: 'Ваши данные: закупка/производство' },

  // --- Комиссия и сборы ---
  { id: 'kvv',       group: 'Комиссия и сборы',  label: 'Ставка комиссии кВВ',         unit: '%',    type: 'pct', def: 20,    step: 0.5,  hint: 'п. 6.6 / 12.2 — из тарифов; если <1%, считается 1%' },
  { id: 'finRate',   group: 'Комиссия и сборы',  label: 'Эквайринг + конвертация',     unit: '%',    type: 'pct', def: 3,     step: 0.5,  hint: 'п. 12.2.1 — берётся СВЕРХ комиссии' },

  // --- Габариты и вес ---
  { id: 'len',       group: 'Габариты и вес',    label: 'Длина',                       unit: 'см',   type: 'num', def: 30,    step: 1,    hint: 'С упаковкой' },
  { id: 'wid',       group: 'Габариты и вес',    label: 'Ширина',                      unit: 'см',   type: 'num', def: 25,    step: 1,    hint: 'С упаковкой' },
  { id: 'hei',       group: 'Габариты и вес',    label: 'Высота',                      unit: 'см',   type: 'num', def: 5,     step: 1,    hint: 'С упаковкой' },
  { id: 'weight',    group: 'Габариты и вес',    label: 'Вес брутто',                  unit: 'кг',   type: 'num', def: 0.4,   step: 0.05, hint: 'Макс. 20 кг для международки (п. 13.1.4)' },
  { id: 'noDims',    group: 'Габариты и вес',    label: 'Габариты в карточке НЕ указаны', unit: '', type: 'check', def: false, hint: 'п. 13.3.15 — тогда коэффициент = 25' },

  // --- Точность габаритов (Клх) ---
  { id: 'soa',       group: 'Точность габаритов (Клх)', label: 'Отклонение габаритов СоА', unit: '%', type: 'pct', def: 8, step: 1, hint: 'Факт vs карточка. п. 13.3.7: ≤10%→1; ≤25%→1,5; ≤50%→2; ≤100%→3; >100%→4' },

  // --- Логистика ---
  { id: 'logMethod', group: 'Логистика',         label: 'Метод расчёта логистики',     unit: '',     type: 'select', def: 'rf',
    options: [ { v: 'rf', t: 'Формула РФ: 8 + (Б−1)×2' }, { v: 'weight', t: 'Весовая / тариф Китая' } ],
    hint: 'п. 13.1.11.1 (РФ) или п. 13.1.12 (весовая)' },
  { id: 'tariffOrder',  group: 'Логистика',      label: 'Тариф за заказ (Тз)',         unit: 'CNY',    type: 'num', def: 5,  step: 0.5, hint: 'Для весового метода. п. 13.1.12 / таблица складов КНР' },
  { id: 'tariffWeight', group: 'Логистика',      label: 'Тариф за вес (ТФВз), за 100 г', unit: 'CNY',  type: 'num', def: 1,  step: 0.1, hint: 'Для весового метода. п. 13.1.12' },

  // --- Хранение ---
  { id: 'storagePerDay', group: 'Хранение',      label: 'Тариф хранения за день',      unit: 'CNY/дн', type: 'num', def: 0.1, step: 0.01, hint: 'п. 13.2, тарифы п. 6.6' },
  { id: 'storageDays',   group: 'Хранение',      label: 'Дней хранения (среднее)',     unit: 'дн',     type: 'num', def: 20,  step: 1,    hint: 'Оценка оборачиваемости' },

  // --- Выкуп и возвраты ---
  { id: 'buyback',        group: 'Выкуп и возвраты', label: 'Доля выкупа (sell-through)', unit: '%',   type: 'pct', def: 70, step: 1, hint: 'Доля заказов, ставших продажей' },
  { id: 'returnMult',     group: 'Выкуп и возвраты', label: 'Множитель обратной логистики', unit: '×', type: 'select', def: '1',
    options: [ { v: '1', t: '1× — возврат покупателем / не вывезен из КНР' }, { v: '2', t: '2× — не прошёл таможню РФ' } ],
    hint: 'п. 13.1.14' },
  { id: 'returnUtilShare',group: 'Выкуп и возвраты', label: 'Доля возвратов в утиль',    unit: '%',   type: 'pct', def: 50, step: 5, hint: 'Часть возвратов теряется (утилизируется в РФ)' },

  // --- Прочее ---
  { id: 'utilFee',   group: 'Прочее',            label: 'Тариф утилизации за единицу', unit: 'CNY',  type: 'num', def: 3, step: 0.5, hint: 'п. 13.4.4' },
  { id: 'drr',       group: 'Прочее',            label: 'ДРР (реклама, % от выручки)',  unit: '%',    type: 'pct', def: 8, step: 1,   hint: 'п. 14 — WB.Продвижение (CPM/CPO/CPC)' },
  { id: 'vatPayer',  group: 'Прочее',            label: 'Продавец — плательщик НДС в РФ', unit: '',   type: 'check', def: false, hint: 'п. 6.8 — если нет, НДС не начисляется' },
  { id: 'vatRate',   group: 'Прочее',            label: 'Ставка НДС',                  unit: '%',    type: 'pct', def: 22, step: 1,   hint: 'п. 9.2.3 — до 22%' },
  { id: 'fineReserve',group: 'Прочее',           label: 'Резерв на штрафы (на ед.)',   unit: 'CNY',  type: 'num', def: 1, step: 0.5, hint: 'п. 9.9.6 — лимит по обороту' },
];

/* -------- Ядро расчёта: чистая функция --------
   Принимает объект значений (доли для процентов), возвращает разбивку. */
function computeUnit(v) {
  const wbRate   = v.cbrRate * (1 + v.wbMarkup);
  const priceRub = v.price * wbRate;

  const kvvApplied = Math.max(v.kvv, 0.01);          // мин. 1% (п. 12.2)
  const commission = v.price * kvvApplied;
  const fin        = v.price * v.finRate;

  const volumeL = Math.max(1, Math.ceil((v.len * v.wid * v.hei) / 1000));
  const klh = v.noDims ? 25 : klhFromSoa(v.soa);

  const logRF     = 8 + (volumeL - 1) * 2;            // п. 13.1.11.1
  const w100units = Math.ceil(v.weight * 10);         // вес округл. до 100 г
  const logWeight = w100units * v.tariffWeight + v.tariffOrder; // п. 13.1.12
  const logBase   = v.logMethod === 'rf' ? logRF : logWeight;
  const logDirect = logBase * klh;                    // Клх множит логистику (п. 13.3.6)

  const storage   = v.storagePerDay * v.storageDays * klh;

  const buyback   = v.buyback;
  const returnsPerSale = buyback > 0 ? (1 - buyback) / buyback : 0;
  const returnMult = parseFloat(v.returnMult);

  const vat = v.vatPayer ? v.price - v.price / (1 + v.vatRate) : 0;

  // Затраты на 1 ВЫКУПЛЕННУЮ единицу (с аллокацией возвратов)
  const costs = {
    cogs:      v.cogs,
    commission,
    fin,
    logFwd:    buyback > 0 ? logDirect / buyback : 0,           // прямая логистика на ВСЕ заказы
    logBack:   logDirect * returnMult * returnsPerSale,          // обратная логистика на возвраты
    lossGoods: v.cogs * returnsPerSale * v.returnUtilShare,      // потеря товара на утиль
    utilFee:   v.utilFee * returnsPerSale * v.returnUtilShare,   // услуга утилизации
    storage,
    promo:     v.price * v.drr,
    vat,
    fine:      v.fineReserve,
  };

  const totalCost = Object.values(costs).reduce((a, b) => a + b, 0);
  const profit    = v.price - totalCost;

  return {
    wbRate, priceRub, kvvApplied, volumeL, klh,
    logRF, logWeight, logBase, logDirect, storage,
    returnsPerSale, costs, totalCost,
    revenue: v.price,
    profit,
    margin: v.price > 0 ? profit / v.price : 0,
    markupOnCogs: v.cogs > 0 ? profit / v.cogs : 0,
    profitRub: profit * wbRate,
  };
}

function klhFromSoa(soa) {
  if (soa <= 0.10) return 1;
  if (soa <= 0.25) return 1.5;
  if (soa <= 0.50) return 2;
  if (soa <= 1.00) return 3;
  return 4;
}

/* Расчёт маржи для сценарной сетки (buyback × kvv), прочее — из базовых v */
function marginFor(v, buyback, kvv) {
  const clone = Object.assign({}, v, { buyback, kvv });
  return computeUnit(clone).margin;
}

/* ---------------- Слой рендера / UI ---------------- */

const COST_LABELS = {
  cogs:      'Себестоимость товара',
  commission:'Комиссия ВБ (п. 12.2)',
  fin:       'Эквайринг + конвертация (п. 12.2.1)',
  logFwd:    'Логистика прямая, на все заказы (п. 13.1)',
  logBack:   'Логистика обратная, возвраты (п. 13.1.14)',
  lossGoods: 'Потеря товара на утиль (возвраты)',
  utilFee:   'Утилизация — услуга (п. 13.4)',
  storage:   'Хранение (п. 13.2)',
  promo:     'Продвижение / ДРР (п. 14)',
  vat:       'НДС (п. 9.2.3)',
  fine:      'Резерв на штрафы (п. 9.9.6)',
};

const fmt = (x, d = 2) =>
  (isFinite(x) ? x : 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x) => (isFinite(x) ? x * 100 : 0).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';

/* Прочитать все значения из формы (проценты → доли) */
function readInputs() {
  const v = {};
  for (const f of FIELDS) {
    const el = document.getElementById(f.id);
    if (f.type === 'check') { v[f.id] = el.checked; continue; }
    if (f.type === 'select') { v[f.id] = el.value; continue; }
    let n = parseFloat(String(el.value).replace(',', '.'));
    if (!isFinite(n)) n = 0;
    v[f.id] = f.type === 'pct' ? n / 100 : n;
  }
  return v;
}

/* Построить форму из FIELDS */
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

function buildField(f) {
  const wrap = document.createElement('label');
  wrap.className = 'field' + (f.type === 'check' ? ' field-check' : '');
  wrap.setAttribute('title', f.hint || '');

  if (f.type === 'check') {
    wrap.innerHTML =
      `<input type="checkbox" id="${f.id}" ${f.def ? 'checked' : ''}>
       <span class="field-label">${f.label}</span>
       <span class="field-hint">${f.hint || ''}</span>`;
    return wrap;
  }

  let control;
  if (f.type === 'select') {
    control = `<select id="${f.id}">` +
      f.options.map(o => `<option value="${o.v}" ${o.v === f.def ? 'selected' : ''}>${o.t}</option>`).join('') +
      `</select>`;
  } else {
    control = `<div class="input-wrap">
        <input type="number" id="${f.id}" value="${f.def}" step="${f.step || 'any'}" inputmode="decimal">
        <span class="unit">${f.unit || ''}</span>
      </div>`;
  }
  wrap.innerHTML =
    `<span class="field-label">${f.label}</span>
     ${control}
     <span class="field-hint">${f.hint || ''}</span>`;
  return wrap;
}

/* Отрисовать результаты */
function render() {
  const v = readInputs();
  const r = computeUnit(v);

  // KPI
  const kpi = document.getElementById('kpi');
  const profitCls = r.profit >= 0 ? 'pos' : 'neg';
  kpi.innerHTML = `
    <div class="kpi-main ${profitCls}">
      <div class="kpi-label">Прибыль на выкупленную единицу</div>
      <div class="kpi-value">${fmt(r.profit)} <span class="cny">CNY</span></div>
      <div class="kpi-sub">${fmt(r.profitRub)} ₽ · по Курсу ВБ ${fmt(r.wbRate, 2)} ₽/¥</div>
    </div>
    <div class="kpi-row">
      <div class="kpi-cell ${profitCls}"><span>Маржинальность</span><b>${pct(r.margin)}</b></div>
      <div class="kpi-cell"><span>Наценка к с/с</span><b>${pct(r.markupOnCogs)}</b></div>
    </div>
    <div class="kpi-row">
      <div class="kpi-cell"><span>Выручка</span><b>${fmt(r.revenue)} ¥</b></div>
      <div class="kpi-cell"><span>Затраты</span><b>${fmt(r.totalCost)} ¥</b></div>
    </div>
    <div class="kpi-row">
      <div class="kpi-cell"><span>Витрина</span><b>${fmt(r.priceRub)} ₽</b></div>
      <div class="kpi-cell"><span>Клх</span><b>${fmt(r.klh, 1)}× · ${fmt(r.volumeL,0)} л</b></div>
    </div>`;

  // Разбивка затрат (бары)
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
    <div class="bar-row bar-head">
      <div class="bar-name">Статья затрат</div><div class="bar-track"></div><div class="bar-val">CNY · % от Рц</div>
    </div>
    ${rows}
    <div class="bar-row bar-total">
      <div class="bar-name">ИТОГО затраты</div>
      <div class="bar-track"></div>
      <div class="bar-val">${fmt(r.totalCost)} ¥<small>${pct(r.revenue>0?r.totalCost/r.revenue:0)}</small></div>
    </div>`;

  renderSensitivity(v);
}

/* Сетка чувствительности: выкуп (строки) × кВВ (столбцы) */
function renderSensitivity(v) {
  const buybacks = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const kvvs = [0.10, 0.15, 0.20, 0.25, 0.30];
  let html = '<table class="sens"><thead><tr><th>выкуп ↓ / кВВ →</th>';
  for (const k of kvvs) html += `<th>${(k*100).toFixed(0)}%</th>`;
  html += '</tr></thead><tbody>';
  for (const b of buybacks) {
    html += `<tr><th>${(b*100).toFixed(0)}%</th>`;
    for (const k of kvvs) {
      const m = marginFor(v, b, k);
      html += `<td class="${heatClass(m)}">${(m*100).toFixed(1)}%</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('sensitivity').innerHTML = html;
}

function heatClass(m) {
  if (m < 0)     return 'h-neg';
  if (m < 0.05)  return 'h-low';
  if (m < 0.15)  return 'h-mid';
  return 'h-hi';
}

/* Сброс к примеру */
function resetDefaults() {
  for (const f of FIELDS) {
    const el = document.getElementById(f.id);
    if (f.type === 'check') el.checked = f.def;
    else el.value = f.def;
  }
  render();
}

document.addEventListener('DOMContentLoaded', () => {
  buildForm();
  document.getElementById('form').addEventListener('input', render);
  document.getElementById('reset').addEventListener('click', resetDefaults);
  document.getElementById('theme').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
  });
  render();
});
