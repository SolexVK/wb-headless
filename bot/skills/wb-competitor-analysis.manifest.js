// Манифест скилла «Конкурентный анализ ниши» (wb-competitor-analysis) — [3] каскада.
//
// Python-движок (.claude/skills/wb-competitor-analysis/wb_analyze.py, npm-скрипт
// analysis:competitive) собирает многоблочный отчёт по нише (ёмкость, ТОП-конкуренты,
// ценовой коридор по МАРЖЕ, контент-бенчмарк, сезонность, гэп-анализ своей карточки)
// + план доработки. Вывод — HTML/PDF/JSON-файлы (не rivals-контракт), поэтому
// исполнитель кастомный (runner:'competitorAnalysis').

const GENDER = { женский: 'women', мужской: 'men', детский: 'kids' };

const has = (v) => v !== undefined && v !== null && v !== '';

export default {
  id: 'wb-competitor-analysis',
  title: '🧭 Конкурентный анализ ниши',
  description: 'Ниша + юнит-экономика + ценовой коридор по марже + план доработки карточки',
  adminOnly: false,
  engineeringMode: true,
  runner: 'competitorAnalysis',
  npmScript: 'analysis:competitive',

  fields: [
    {
      key: 'gender',
      label: 'Пол',
      type: 'choice',
      required: true,
      options: [
        { value: 'женский', label: 'Женский' },
        { value: 'мужской', label: 'Мужской' },
        { value: 'детский', label: 'Детский' },
      ],
    },
    { key: 'item', label: 'Предмет', type: 'text', required: true, placeholder: 'напр. рубашка, платье' },
    {
      key: 'cost',
      label: 'Себестоимость, ₽',
      type: 'number',
      required: true,
      hint: 'landed до склада WB — нужна для расчёта маржи и выгодного коридора цен',
    },

    // ── ⚙ дополнительные ──
    { key: 'pattern', label: 'Принт/паттерн', type: 'text', advanced: true, hint: 'напр. полоска (фильтр ниши)' },
    { key: 'mySku', label: 'Ваш артикул (гэп-анализ)', type: 'number', advanced: true, hint: 'включает адресный план доработки' },
    { key: 'keywords', label: 'Ключевые запросы ниши', type: 'text', advanced: true, hint: 'через запятую — конкуренты из выдачи' },
    {
      key: 'top',
      label: 'Глубина топа',
      type: 'choice',
      advanced: true,
      default: 10,
      options: [{ value: 10, label: '10' }, { value: 20, label: '20' }],
    },
    {
      key: 'days',
      label: 'Период, дней',
      type: 'choice',
      advanced: true,
      default: 30,
      options: [{ value: 30, label: '30' }, { value: 60, label: '60' }, { value: 90, label: '90' }],
    },
    {
      key: 'by',
      label: 'Срез',
      type: 'choice',
      advanced: true,
      default: 'seller',
      options: [{ value: 'seller', label: 'Продавцы' }, { value: 'brand', label: 'Бренды' }],
    },
  ],

  formats: ['pdf', 'html'],

  // Флаги движка. ctx — пути вывода (даёт исполнитель бота).
  buildArgv: (p, ctx = {}) => {
    const a = ['--gender', GENDER[p.gender] || 'women', '--item', String(p.item), '--cost', String(p.cost)];
    if (has(p.pattern)) a.push('--pattern', String(p.pattern));
    if (has(p.mySku)) a.push('--my-sku', String(p.mySku));
    if (has(p.keywords)) a.push('--keywords', String(p.keywords));
    a.push('--top', String(p.top ?? 10), '--days', String(p.days ?? 30), '--by', String(p.by ?? 'seller'));
    if (ctx.htmlOut) a.push('--html-out', ctx.htmlOut);
    if (ctx.pdfOut) a.push('--pdf-out', ctx.pdfOut);
    if (ctx.jsonOut) a.push('--json-out', ctx.jsonOut);
    return a;
  },
};
