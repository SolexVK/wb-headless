// featureDict.js — «словарь признаков предмета» WB. По выбранному предмету собирает все
// слова-признаки из НАЗВАНИЙ, ОПИСАНИЙ и ХАРАКТЕРИСТИК карточек и группирует их.
//
// Ключевая идея: характеристики карточки WB УЖЕ сгруппированы по смыслу (Состав, Сезон,
// Покрой, Фактура, Декор, Рукав, Стиль…) — берём их как готовые смысловые группы, без
// внешних NLP-библиотек. Слова из названий/описаний, не покрытые характеристиками,
// добавляем отдельной группой «Частые слова» (по частоте, приведённые к единой форме
// нашим стеммером). Результат кэшируется по предмету для повторного использования.

import { fetchCategoryItems, normalizeCategoryItem } from './mpstats.js';
import { fetchCardsInfo } from './wbCard.js';
import { stem } from './seasonPlanReport.js';

// Русские стоп-слова + «коммерческая вода», которые не являются признаками товара.
const STOP = new Set((
  'и в во на с со для из по не а но что как это же до от при за о у к бы ли или то так ' +
  'вы мы все всех наш наша наше ваш вам вас нас его ее их если чтобы есть был была были ' +
  'быть очень более менее самый самая также тоже уже еще нет да там тут этот эта эти тот ' +
  'который которая можно нужно будет чем над под без про между' +
  // коммерческая вода / общие слова
  ' размер размеры цвет цвета купить доставка качество качественный товар товары модель ' +
  'артикул цена скидка новинка новый новая коллекция бренд производитель состав уход ' +
  'россия киргизия китай идеально идеальный отлично отличный стильный стиль магазин заказ ' +
  'подойдет подойдёт станет сделает создан создает подчеркнет вещь вещи гардероб образ ' +
  'носить сочетается сочетать любой любая каждый каждая день дня повод случай комплект шт'
).split(/\s+/).filter(Boolean));

// Неинформативные для фильтрации характеристики — прячем из словаря.
const NOISE_ATTR = new Set([
  'уход за вещами', 'комплектация', 'рост модели на фото', 'страна производства',
  'вес товара с упаковкой', 'вес товара без упаковки', 'вес с упаковкой', 'вес без упаковки',
  'высота упаковки', 'ширина упаковки', 'длина упаковки', 'гарантийный срок',
  'особенности артикула', 'параметры модели на фото', 'на изображении рост модели',
]);

const clean = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
// разбить значение характеристики на отдельные признаки: «хлопок 60%; шерсть 30%» → [хлопок, шерсть]
const splitVals = (v) => clean(v).split(/[;,/]/).map((x) => x.replace(/\s*\d+\s*%?\s*$/, '').trim()).filter(Boolean);

/**
 * Собрать словарь признаков по предмету.
 * @returns {Promise<{path, sample, withCards, attributes:[{name,total,values:[{value,count}]}],
 *                     keywords:[{word,count}], fetchedAt}>}
 */
export async function buildFeatureDict({ path, d1, d2, sample = 400, log = null } = {}) {
  if (!path) throw new Error('Не указан путь предмета (path)');
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'признаки', msg }); };
  // Тянем ВСЮ выдачу предмета (до 5000) — слова-признаки собираем из НАЗВАНИЙ всех товаров.
  const res = await fetchCategoryItems({ path, d1, d2, startRow: 0, endRow: 5000 });
  const all = (res.data || []).map((r) => normalizeCategoryItem(r)).filter((it) => it.wb != null);
  L(`Выдача предмета: всего ${res.total || all.length}, получено ${all.length}. Слова из названий — со ВСЕХ; характеристики/описания — с топ-${sample} по выручке.`);
  const top = all.slice(0, sample); // карточки тянем только для топ-N (характеристики/описание)

  let cards = new Map();
  try { cards = await fetchCardsInfo(top.map((it) => it.wb), { concurrency: 8 }); } catch { /* CDN недоступен → только названия */ }

  const attrGroups = new Map();   // имя характеристики -> Map(значение -> count)
  const attrStems = new Set();    // стемы значений характеристик (чтобы не дублировать в keywords)
  const kw = new Map();           // стем -> {form, count}
  let withCards = 0;

  const addAttr = (name, rawval) => {
    const nm = String(name || '').trim(); if (!nm || NOISE_ATTR.has(nm.toLowerCase())) return;
    if (!attrGroups.has(nm)) attrGroups.set(nm, new Map());
    const g = attrGroups.get(nm);
    for (const v of splitVals(rawval)) {
      if (v.length < 2 || /^\d+$/.test(v)) continue;
      g.set(v, (g.get(v) || 0) + 1);
      attrStems.add(stem(v.split(/\s+/)[0]));
    }
  };
  const addKw = (text) => {
    for (const raw of clean(text).split(/[^a-zа-я0-9]+/)) {
      if (raw.length < 3 || /^\d+$/.test(raw) || STOP.has(raw)) continue;
      const st = stem(raw); if (st.length < 3 || STOP.has(st)) continue;
      const cur = kw.get(st) || { form: raw, count: 0 };
      cur.count++;
      if (raw.length < cur.form.length) cur.form = raw; // самая короткая форма как ярлык
      kw.set(st, cur);
    }
  };

  for (const it of all) addKw(it.name);              // слова из названий — со ВСЕХ товаров
  for (const it of top) {
    const info = cards.get(Number(it.wb));
    if (info) {
      withCards++;
      addKw(info.imtName); addKw(info.description);
      for (const o of (info.options || [])) addAttr(o.name, o.value);
    }
  }
  L(`Карточки WB: обогащено ${withCards} из ${top.length}${withCards === 0 ? ' — ⚠ wbbasket.ru недоступен, характеристик нет (только слова из названий)' : ''}. Групп характеристик: ${attrGroups.size}.`);

  const attributes = [...attrGroups.entries()].map(([name, g]) => {
    const values = [...g.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count).slice(0, 24);
    return { name, total: values.reduce((s, v) => s + v.count, 0), values };
  }).filter((a) => a.values.length).sort((a, b) => b.total - a.total).slice(0, 16);

  const keywords = [...kw.values()]
    .filter((k) => !attrStems.has(stem(k.form)) && k.count >= 2)
    .sort((a, b) => b.count - a.count).slice(0, 60)
    .map((k) => ({ word: k.form, count: k.count }));

  return { path, total: all.length, sample: top.length, withCards, attributes, keywords, fetchedAt: new Date().toISOString(), log: log || [] };
}
