// lib/wbUnitBot.js — логика диалога Telegram-бота Юнит-калькулятора.
//
// Чистый, тестируемый слой: ничего не знает про сеть. Принимает сообщение/нажатие
// кнопки и текущую сессию чата → возвращает { session, reply }. Рендер PDF и отправку
// делает раннер (scripts/wb-unit-bot.mjs), reply лишь помечает { wantPdf:true }.
//
// Диалог: себестоимость → цена продажи (витрина, с СПП) → ДРР → результат + кнопки.
// Плюс быстрый ввод: «536 2400 8» (три числа) или «cost=536 price=2400 drr=8».

import { analyze, econParams, fmtRub, fmtPct } from './wbUnitCalc.js';

// ─────────── парсинг ввода ───────────

const SKIP = new Set(['-', '—', 'skip', 'пропустить', 'пропуск', 'нет', 'default', 'дефолт', 'по умолчанию']);

function parseNum(text) {
  if (text == null) return null;
  // «1 200 ₽», «1,5», «536р» → число. Убираем всё, кроме цифр/запятой/точки/минуса.
  const cleaned = String(text).replace(/[^\d.,-]/g, '').replace(',', '.');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Ключи для быстрого ввода key=value (рус/англ синонимы → канонический ключ).
const KEY_ALIASES = {
  cost: 'cost', c: 'cost', себес: 'cost', себестоимость: 'cost', сс: 'cost',
  price: 'price', p: 'price', цена: 'price', витрина: 'price',
  seller: 'sellerPrice', s: 'sellerPrice', продавец: 'sellerPrice',
  drr: 'drr', дрр: 'drr',
  commission: 'commission', ком: 'commission', комиссия: 'commission',
  spp: 'spp', спп: 'spp',
  acquiring: 'acquiring', эквайринг: 'acquiring',
  tax: 'tax', налог: 'tax',
  defect: 'defect', брак: 'defect',
  units: 'units', ед: 'units', штук: 'units', объём: 'units', объем: 'units',
  margin: 'targetMargin', маржа: 'targetMargin', цель: 'targetMargin',
};

// Достаёт key=value пары из строки. Возвращает {} если их нет.
function parseKeyVals(text) {
  const out = {};
  const re = /([a-zA-Zа-яА-ЯёЁ]+)\s*[=:]\s*(-?[\d.,]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const key = KEY_ALIASES[m[1].toLowerCase()];
    const val = parseNum(m[2]);
    if (key && val != null) out[key] = val;
  }
  return out;
}

// ─────────── сессия ───────────

export function newSession() {
  // data копит вводные; over — переопределения ставок (проценты → доли делаем при merge).
  return { step: 'ask_cost', data: {}, over: {} };
}

// Проценты-переопределения приходят как числа (35.7) → доли.
function applyKeyVals(session, kv) {
  const d = session.data;
  if (kv.cost != null) d.cost = kv.cost;
  if (kv.price != null) { d.price = kv.price; d.sellerPrice = undefined; }
  if (kv.sellerPrice != null) { d.sellerPrice = kv.sellerPrice; d.price = undefined; }
  if (kv.drr != null) d.drr = kv.drr;
  if (kv.units != null) d.units = kv.units;
  if (kv.targetMargin != null) d.targetMargin = kv.targetMargin;
  for (const k of ['commission', 'spp', 'acquiring', 'tax', 'defect']) {
    if (kv[k] != null) session.over[k] = kv[k] / 100;
  }
}

// ─────────── расчёт и рендер ───────────

function paramsOf(session) {
  // drr прокидываем в analyze отдельно, здесь только ставки-переопределения.
  return econParams({ ...session.over });
}

export function computeResult(session) {
  const d = session.data;
  const pr = paramsOf(session);
  return analyze({
    cost: d.cost,
    price: d.price,
    sellerPrice: d.sellerPrice,
    pr,
    drr: d.drr != null ? d.drr / 100 : undefined,
    targetMargin: d.targetMargin != null ? d.targetMargin / 100 : undefined,
    units: d.units,
  });
}

// Компактный HTML-текст для Telegram (parse_mode: HTML). Таблицы — в <pre>.
export function formatTelegram(res) {
  const { pr, unit } = res;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const pad = (s, n) => String(s).padStart(n);
  const L = [];
  L.push(`<b>📦 Юнит-калькулятор WB</b>`);
  L.push(`<i>себестоимость ${fmtRub(res.input.cost)} · ДРР ${fmtPct(res.input.drr)}</i>`);

  if (unit) {
    L.push('');
    L.push(`Витрина (с СПП): <b>${fmtRub(unit.P)}</b> · Продавец (без СПП): <b>${fmtRub(unit.S)}</b>`);
    const rows = [
      ['Комиссия ВБ', unit.commission],
      ['Эквайринг', unit.acquiring],
      ['Налог', unit.tax],
      ['Реклама (ДРР)', unit.ad],
      ['Брак', unit.defect],
      ...(unit.fixed ? [['Логистика+хран.', unit.fixed]] : []),
      ['Себестоимость', unit.cost],
    ];
    const body = rows.map(([n, v]) => `${n.padEnd(16)}−${pad(fmtRub(v), 9)}`).join('\n');
    L.push(`<pre>${esc(body)}</pre>`);
    L.push(`Опер. прибыль: <b>${fmtRub(unit.profit)}</b> · Маржа: <b>${(unit.margin * 100).toFixed(1)}%</b>`);
  }

  L.push('');
  const cor = res.corridor;
  if (cor.lo != null && cor.hi != null) {
    L.push(`🎯 Коридор маржи ${fmtPct(pr.m_min)}–${fmtPct(pr.m_max)}: <b>${fmtRub(cor.lo)}–${fmtRub(cor.hi)}</b>`);
  }
  L.push(`⚖️ Безубыточность: <b>${fmtRub(res.breakeven)}</b> <i>(в запуске ${fmtRub(res.breakevenLaunch)})</i>`);

  if (res.reverse) {
    L.push('');
    if (res.reverse.margin) {
      const r = res.reverse.margin;
      L.push(`Под маржу ${fmtPct(r.target)} → витрина <b>${fmtRub(r.price)}</b>`
        + (r.unit ? ` <i>(прибыль ${fmtRub(r.unit.profit)}/ед)</i>` : ' — недостижимо'));
    }
    if (res.reverse.profit) {
      const r = res.reverse.profit;
      L.push(`Под прибыль ${fmtRub(r.target)}/ед → витрина <b>${fmtRub(r.price)}</b>`);
    }
  }

  if (res.period) {
    L.push('');
    L.push(`📈 ${res.period.units} ед → прибыль <b>${fmtRub(res.period.profit)}</b>`);
  }
  return L.join('\n');
}

// Кнопки под результатом.
export function resultKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎯 Цена под маржу', callback_data: 'target' }, { text: '📊 Изменить ДРР', callback_data: 'drr' }],
      [{ text: '📄 PDF-отчёт', callback_data: 'pdf' }, { text: '🔄 Новый расчёт', callback_data: 'restart' }],
    ],
  };
}

// Есть ли достаточно данных, чтобы показать результат (нужна хотя бы себестоимость).
function ready(session) { return session.data.cost != null && session.data.cost > 0; }

function resultReply(session) {
  const res = computeResult(session);
  return { text: formatTelegram(res), keyboard: resultKeyboard(), parseMode: 'HTML' };
}

// ─────────── тексты подсказок ───────────

const HELP = [
  '<b>📦 Юнит-калькулятор WB</b>',
  '',
  'Считаю прибыль, маржу, точку безубыточности и цену под целевую маржу.',
  '',
  '<b>Пошагово:</b> /calc — задам вопросы по очереди (себестоимость → цена → ДРР).',
  '<b>Быстро одной строкой:</b>',
  '• <code>536 2400 8</code> — себестоимость, цена, ДРР%',
  '• <code>cost=536 price=2400 drr=8 маржа=28 ед=300</code>',
  '',
  'Цена продажи — <b>витрина с СПП</b> (как видит покупатель). Можно пропустить (—) — тогда покажу только коридор и безубыточность.',
  '',
  'Команды: /calc — начать · /reset — сброс · /help — справка',
].join('\n');

const ASK = {
  cost: '💰 Пришлите <b>себестоимость</b> товара (₽) — во сколько вам обходится единица (закупка + доставка до склада WB).',
  price: '🏷️ Пришлите <b>цену продажи</b> — витринную, с СПП (₽). Или «—», чтобы пропустить (покажу коридор и безубыточность).',
  drr: '📊 Пришлите <b>ДРР %</b> (доля рекламных расходов). Или «—» для значения по умолчанию (8%).',
  target_margin: '🎯 Введите <b>целевую маржу, %</b> — посчитаю нужную витринную цену.',
};

// ─────────── обработчики ───────────

/**
 * Обработать текстовое сообщение.
 * @returns {{session, reply:{text, keyboard?, parseMode?, wantPdf?}}}
 */
export function handleMessage(session, rawText) {
  const text = String(rawText || '').trim();
  if (!session) session = newSession();

  // Команды.
  const lower = text.toLowerCase();
  if (lower === '/start' || lower === '/help' || lower === 'старт' || lower === 'помощь') {
    return { session, reply: { text: HELP, parseMode: 'HTML' } };
  }
  if (lower === '/reset' || lower === 'сброс') {
    return { session: newSession(), reply: { text: ASK.cost, parseMode: 'HTML' } };
  }
  if (lower === '/calc' || lower === 'расчёт' || lower === 'расчет') {
    const s = newSession();
    return { session: s, reply: { text: ASK.cost, parseMode: 'HTML' } };
  }

  // Быстрый ввод key=value в любой момент.
  const kv = parseKeyVals(text);
  if (Object.keys(kv).length) {
    applyKeyVals(session, kv);
    if (ready(session)) { session.step = 'ready'; return { session, reply: resultReply(session) }; }
    session.step = 'ask_cost';
    return { session, reply: { text: ASK.cost, parseMode: 'HTML' } };
  }

  // Быстрый ввод «536 2400 8» / «536 2400» / «536» (без цены → коридор).
  const nums = text.split(/[\s,;]+/).map(parseNum).filter((n) => n != null);
  if (nums.length >= 2 && session.step !== 'ask_target_margin') {
    session.data.cost = nums[0];
    session.data.price = nums[1];
    if (nums[2] != null) session.data.drr = nums[2];
    session.step = 'ready';
    return { session, reply: resultReply(session) };
  }

  // Пошаговый диалог.
  const skip = SKIP.has(lower);
  const n = parseNum(text);

  switch (session.step) {
    case 'ask_cost': {
      if (n == null || !(n > 0)) return { session, reply: { text: '⚠️ Нужна себестоимость числом, например <code>536</code>.\n\n' + ASK.cost, parseMode: 'HTML' } };
      session.data.cost = n;
      session.step = 'ask_price';
      return { session, reply: { text: ASK.price, parseMode: 'HTML' } };
    }
    case 'ask_price': {
      if (skip) { session.data.price = undefined; }
      else if (n != null && n > 0) { session.data.price = n; }
      else return { session, reply: { text: '⚠️ Нужна цена числом или «—» чтобы пропустить.\n\n' + ASK.price, parseMode: 'HTML' } };
      session.step = 'ask_drr';
      return { session, reply: { text: ASK.drr, parseMode: 'HTML' } };
    }
    case 'ask_drr': {
      if (!skip) {
        if (n == null || n < 0) return { session, reply: { text: '⚠️ Нужен ДРР числом (%) или «—» для 8%.\n\n' + ASK.drr, parseMode: 'HTML' } };
        session.data.drr = n;
      }
      session.step = 'ready';
      return { session, reply: resultReply(session) };
    }
    case 'ask_target_margin': {
      if (n == null || n <= 0) return { session, reply: { text: '⚠️ Введите целевую маржу числом (%), например <code>28</code>.', parseMode: 'HTML' } };
      session.data.targetMargin = n;
      session.step = 'ready';
      return { session, reply: resultReply(session) };
    }
    default: {
      // idle/ready и непонятный ввод → подсказка.
      if (n != null && n > 0 && !ready(session)) {
        session.data.cost = n; session.step = 'ask_price';
        return { session, reply: { text: ASK.price, parseMode: 'HTML' } };
      }
      return { session, reply: { text: 'Не понял. ' + HELP, parseMode: 'HTML' } };
    }
  }
}

/**
 * Обработать нажатие inline-кнопки.
 * @returns {{session, reply, answer}} answer — короткий toast для answerCallbackQuery.
 */
export function handleCallback(session, data) {
  if (!session) session = newSession();
  switch (data) {
    case 'restart':
      return { session: newSession(), reply: { text: ASK.cost, parseMode: 'HTML' }, answer: 'Новый расчёт' };
    case 'drr':
      session.step = 'ask_drr';
      return { session, reply: { text: ASK.drr, parseMode: 'HTML' }, answer: 'Введите ДРР' };
    case 'target':
      session.step = 'ask_target_margin';
      return { session, reply: { text: ASK.target_margin, parseMode: 'HTML' }, answer: 'Введите маржу' };
    case 'pdf': {
      if (!ready(session)) return { session, reply: { text: 'Сначала задайте параметры: /calc', parseMode: 'HTML' }, answer: 'Нет данных' };
      return { session, reply: { text: '📄 Готовлю PDF-отчёт…', parseMode: 'HTML', wantPdf: true }, answer: 'Готовлю PDF' };
    }
    default:
      return { session, reply: null, answer: '' };
  }
}

export { HELP, ASK, parseNum, parseKeyVals };
