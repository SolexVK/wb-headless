// Манифест скилла «Наши продажи по запросам» (wb-brand-keyword-sales).
//
// Отчёт по ФАКТИЧЕСКИМ выкупам наших брендов, сгруппированный по ключевым фразам и
// периодам (данные из кабинета WB Statistics). CLI — npm run sales:by-keyword.
// Медленный: WB Statistics /supplier/sales — 1 запрос/мин ⇒ прогон 2–4 минуты.
// Исполнитель кастомный (runner:'brandSales'): вывод — PDF + JSON-сводка.

const has = (v) => v !== undefined && v !== null && v !== '';

/** Фразы: по одной в строке или через ';'. */
function parsePhrases(raw) {
  return String(raw || '')
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default {
  id: 'wb-brand-keyword-sales',
  command: 'sales', // /sales в меню Telegram
  title: '💰 Наши продажи по запросам',
  description: 'Фактические выкупы наших брендов по ключевым фразам и периодам (из кабинета WB)',
  adminOnly: false,
  engineeringMode: true,
  runner: 'brandSales',
  npmScript: 'sales:by-keyword',

  fields: [
    {
      key: 'brands',
      label: 'Наши бренды',
      type: 'text',
      required: true,
      placeholder: 'напр. AIDEMIKO, Aizek',
      hint: 'как в карточках WB, через запятую',
    },
    {
      key: 'phrases',
      label: 'Ключевые фразы',
      type: 'text',
      required: true,
      placeholder: 'рубашка муслиновая женская',
      hint: 'по одной фразе в строке (или через ;)',
    },

    // ── ⚙ дополнительные ──
    {
      key: 'from',
      label: 'Старт «с начала года» (YYYY-MM-DD)',
      type: 'text',
      advanced: true,
      hint: 'по умолчанию 1 января текущего года',
    },
    { key: 'days', label: 'Длина скользящего периода, дней', type: 'number', advanced: true, hint: 'по умолчанию 30' },
    {
      key: 'sum',
      label: 'Сумма',
      type: 'choice',
      advanced: true,
      default: 'finishedPrice',
      options: [
        { value: 'finishedPrice', label: 'Розничная (что заплатил покупатель)' },
        { value: 'forPay', label: 'К перечислению (forPay)' },
      ],
    },
  ],

  formats: ['pdf'],

  // ctx — пути вывода (даёт исполнитель бота).
  buildArgv: (p, ctx = {}) => {
    const a = ['--brands', String(p.brands)];
    for (const ph of parsePhrases(p.phrases)) a.push('--phrase', ph);
    if (has(p.from)) a.push('--from', String(p.from));
    if (has(p.days)) a.push('--days', String(p.days));
    if (p.sum === 'forPay') a.push('--sum', 'forPay');
    if (ctx.pdfOut) a.push('--pdf', ctx.pdfOut);
    if (ctx.jsonOut) a.push('--out', ctx.jsonOut);
    return a;
  },
};
