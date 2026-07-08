// Манифест скилла «Конкуренты по запросу» (wb-top-keywords).
//
// Форма → CLI-прогон (npm run top:keywords) → mid-flow пикер конкурентов →
// выбор формата. Дорогая вытяжка (выдача MPStats по фразе) кэшируется в Слое 1.
//
// Продакшн-логика скилла живёт отдельно (.claude/skills/wb-top-keywords/ +
// scripts/wb-top-keywords.mjs); здесь — только бот-обёртка.
//
// Признаки-фасеты (Тип ткани/Покрой/Воротник/…): поля генерируются из справочника
// lib/wbFacets.js. Пользователь настраивает ТОЛЬКО релевантные (через «⚙ Настроить»):
// выбранное значение = плюс-ключ, остальные значения признака → минус-ключи.

import { FACETS } from '../../lib/wbFacets.js';

// Поля-признаки: choice, advanced, с «Любой» (не фильтровать). key = facet_<key>.
const facetFields = FACETS.map((f) => ({
  key: `facet_${f.key}`,
  facetKey: f.key,
  label: f.label,
  type: 'choice',
  advanced: true,
  default: 'любой',
  options: [{ value: 'любой', label: 'Любой' }, ...f.options.map((o) => ({ value: o.value, label: o.label }))],
}));

/** Собирает --facet <key>=<value> для выбранных (не «любой») признаков. */
function facetArgv(p) {
  const a = [];
  for (const f of FACETS) {
    const v = p[`facet_${f.key}`];
    if (v && v !== 'любой') a.push('--facet', `${f.key}=${v}`);
  }
  return a;
}

/** Разбирает поле «группы»: по строке (или через ;) — одно значение --group. */
function parseGroups(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Нормализует список через запятую (обрезает пробелы, убирает пустые). */
function normCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');
}

const has = (v) => v !== undefined && v !== null && v !== '';

export default {
  id: 'wb-top-keywords',
  title: '🔍 Конкуренты по запросу',
  description: 'ТОП выдачи WB по фразе + фильтры → список артикулов конкурентов',
  adminOnly: false,
  engineeringMode: true,
  npmScript: 'top:keywords', // npm run top:keywords -- <argv>

  // Форма. Обязательные поля спрашиваются сразу; advanced прячутся под «⚙ Настроить».
  fields: [
    {
      key: 'query',
      label: 'Ключевая фраза',
      type: 'text',
      required: true,
      placeholder: 'напр. рубашка в полоску женская',
    },
    {
      key: 'period',
      label: 'Период',
      type: 'choice',
      required: true,
      default: 30,
      options: [
        { value: 7, label: '7 дней' },
        { value: 30, label: '30 дней' },
        { value: 90, label: '90 дней' },
        { value: 'custom', label: 'Свои даты' },
      ],
    },
    {
      key: 'd1',
      label: 'Дата с (YYYY-MM-DD)',
      type: 'text',
      required: true,
      showIf: (p) => p.period === 'custom',
    },
    {
      key: 'd2',
      label: 'Дата по (YYYY-MM-DD)',
      type: 'text',
      required: true,
      showIf: (p) => p.period === 'custom',
      hint: 'строго раньше сегодня',
    },
    {
      key: 'top',
      label: 'Размер топа',
      type: 'choice',
      required: true,
      default: 20,
      options: [
        { value: 10, label: '10' },
        { value: 20, label: '20' },
        { value: 100, label: '100' },
      ],
      hint: 'потолок выдачи ~100',
    },

    // ── ⚙ дополнительные: признаки-фасеты (только релевантные) ──
    ...facetFields,
    // ── ⚙ прочие фильтры ──
    {
      key: 'groups',
      label: 'Группы-признаки (свои)',
      type: 'text',
      advanced: true,
      hint: 'по строке: имя=стем1,стем2 — если признака нет в списке выше',
    },
    { key: 'exclude', label: 'Слова-исключения', type: 'text', advanced: true, hint: 'через запятую, жёсткий гейт (по названию+характеристикам)' },
    { key: 'priceMin', label: 'Цена от, ₽', type: 'number', advanced: true },
    { key: 'priceMax', label: 'Цена до, ₽', type: 'number', advanced: true },
    { key: 'our', label: 'Наш артикул (исключить)', type: 'number', advanced: true },
    { key: 'images', label: 'Фото в отчёте', type: 'boolean', advanced: true, default: true },
  ],

  // Шаги выполнения.
  steps: [
    {
      id: 'fetch',
      executor: 'cli',
      // ctx.outJson — путь для JSON-контракта top-rivals (даёт исполнитель).
      buildArgv: (p, ctx = {}) => {
        const a = ['--query', String(p.query)];
        if (p.period === 'custom') {
          if (has(p.d1)) a.push('--d1', String(p.d1));
          if (has(p.d2)) a.push('--d2', String(p.d2));
        } else {
          a.push('--period', String(p.period ?? 30));
        }
        a.push('--top', String(p.top ?? 20));
        for (const g of parseGroups(p.groups)) a.push('--group', g);
        if (has(p.exclude)) a.push('--exclude', normCsv(p.exclude));
        a.push(...facetArgv(p)); // выбранные признаки-фасеты → --facet key=value
        if (has(p.priceMin)) a.push('--price-min', String(p.priceMin));
        if (has(p.priceMax)) a.push('--price-max', String(p.priceMax));
        if (has(p.our)) a.push('--our', String(p.our));
        if (p.images === false) a.push('--no-images');
        if (ctx.outJson) a.push('--out', ctx.outJson);
        return a;
      },
    },
    {
      id: 'pick',
      interaction: 'pick-list',
      prompt: 'Выберите 2–4 конкурента (номера строк или nmId)',
      min: 2,
      max: 4,
      // Источник строк пикера — JSON-контракт top-rivals из шага fetch.
      // Выбранные nmId идут дальше в «Сравнение карточек» [2].
    },
  ],

  formats: ['html', 'pdf', 'xlsx'],

  // Слой 1: дорогая вытяжка — выдача MPStats по фразе за период. Фильтры
  // (группы/exclude/цена) применяются ПОСЛЕ, поэтому в ключ кэша не входят —
  // одна и та же выдача переиспользуется под разные фильтры.
  cache: {
    source: 'mpstats.search',
    key: (p) =>
      p.period === 'custom'
        ? { phrase: p.query, d1: p.d1, d2: p.d2 }
        : { phrase: p.query, period: Number(p.period ?? 30) },
  },
};
