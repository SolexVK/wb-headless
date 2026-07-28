// lib/seasonPlanReport.js — сбор данных из MPStats + сборка плана продаж на сезон.
//
// Связывает сеть (lib/mpstats.js) и чистое ядро (lib/salesPlan.js):
//   1. Собирает группу-эталон: либо явный список WB из config/groups.json,
//      либо выдача по ПРЕДМЕТУ (path) с детальной фильтрацией до релевантных.
//   2. Тянет дневные ряды (продажи/остатки/цена) по каждому SKU за период.
//   3. Агрегирует в дневной ряд группы и строит план (ранг, фазы, цена, заказы).
//
// Методология: docs/sales-plan-method.md.

import {
  fetchItemDailySales,
  fetchCategoryItems,
  normalizeCategoryItem,
  extractItemDailyFromGraphs,
} from './mpstats.js';
import { buildGroupDailySeries, buildSeasonPlan, applyOOSCorrection, trimToActive } from './salesPlan.js';
import { buildForecast } from './forecast.js';
import { fetchCardsInfo, cardMatchText, cardCharText } from './wbCard.js';
import { filterByRelevance } from './relevance.js';
import { fetchSerp, DailyLimitError as SerpLimitError } from './wbSerp.js';
import { serpLoad, serpSave } from '../db.js';

const SERP_TTL_MS = 3 * 24 * 3600 * 1000; // кэш SERP на 3 дня (сезонная форма стабильна)
const lcName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

/**
 * Собрать аналоги из SERP по 1-3 фразам ЗА ПОЛНОЕ окно [d1,d2] (один запрос на фразу,
 * кэш-первым). Возвращает товары с ПОЛНЫМИ дневными рядами + метаданные; окна сезона
 * потом нарезаются из этого в памяти (sliceSerpWindow) без новых запросов.
 */
// Значение характеристики «Пол» из карточки WB (женский/мужской/для девочек…).
function cardGender(card) {
  if (!card || !Array.isArray(card.options)) return '';
  const o = card.options.find((x) => /^пол\b|^пол$|пол\s/i.test(x.name || '') || (x.name || '').toLowerCase() === 'пол');
  return o ? String(o.value || '').toLowerCase().replace(/ё/g, 'е') : '';
}
// Корни целевого пола → какие значения «Пол» оставляем.
function genderRootsOf(g) {
  if (g === 'female' || g === 'жен') return ['жен'];
  if (g === 'male' || g === 'муж') return ['муж'];
  if (g === 'kids' || g === 'дет') return ['дет', 'девоч', 'мальч', 'дошкол'];
  return null;
}

// Общие категорийные слова (5-символьные корни), которые НЕ считаем нишевым ключом:
// они есть почти в любом названии предмета. Нишевый ключ (муслин, марлевка) остаётся.
const GENERIC5 = new Set(['рубаш', 'блузк', 'туник', 'футбо', 'плать', 'кофта', 'джемп', 'свите', 'сороч',
  'женск', 'женщи', 'дамск', 'мужск', 'мужчи', 'детск', 'девоч', 'мальч', 'подро', 'семей',
  'летня', 'летни', 'весен', 'зимня', 'зимни', 'осенн', 'демис', 'всесе',
  'оверс', 'прямо', 'приле', 'свобо', 'класс', 'базов', 'больш', 'разме', 'батал',
  'одежд', 'магаз', 'бренд', 'новин', 'модна', 'модны', 'стиль', 'krasi', 'kruto',
  'хлопк', 'хлопо', 'котон', 'ткань', 'однот', 'цвет']);

// Нишевые ключи из целевых фраз (значимые слова без общих категорийных). 5-символьный
// корень, чтобы ловить словоформы: «муслиновая»→«мусли» ловит «муслина/муслиновый».
function phraseKeys(phrases) {
  const out = new Set();
  for (const p of phrases) {
    for (const w of String(p).toLowerCase().replace(/ё/g, 'е').split(/[^а-я0-9]+/)) {
      if (w.length < 4) continue;
      const core = w.slice(0, 5);
      if (GENERIC5.has(core)) continue;
      out.add(core.length >= 4 ? core : w);
    }
  }
  return [...out];
}
// Есть ли в названии нишевый ключ. Если ключей нет — считаем, что «есть» (не режем).
function nameHasKey(name, keys) {
  if (!keys.length) return true;
  const nm = lcName(name);
  return keys.some((k) => nm.includes(k));
}

// Собрать и отфильтровать объединённую выдачу SERP (union + минус-слова/цена/выручка + пол).
// Общая часть для построения плана и для «Предв. выбора». Возвращает уже отфильтрованный
// массив товаров SERP + метаданные.
async function gatherSerp({ phrases = [], minusWords = [], priceMin, priceMax, minRevenuePerMonth, gender = null } = {}, d1, d2, L) {
  const phr = [...new Set(phrases.map((s) => String(s).trim()).filter(Boolean))];
  const mw = minusWords.map((w) => stem(w)).filter((w) => w && w.length >= 3);
  const byId = new Map();
  let requests = 0, dailyLimit = null, periods = [];
  for (const phrase of phr) {
    const key = `${phrase}|${d1}|${d2}`;
    let res = serpLoad(key, SERP_TTL_MS);
    if (res) { L(`Фраза «${phrase}»: из базы ${res.items.length} товаров.`); }
    else {
      try {
        res = await fetchSerp(phrase, { d1, d2 });
        serpSave(key, res); requests += 1;
        L(`Фраза «${phrase}»: SERP вернул ${res.items.length} товаров (доступно ${res.rowCount}). Запрос к MPStats.`);
      } catch (e) {
        if (e instanceof SerpLimitError) { dailyLimit = String(e.message || e); L(`Достигнут суточный лимит MPStats на фразе «${phrase}».`); break; }
        L(`Фраза «${phrase}»: ошибка SERP — ${String(e.message || e)}.`); continue;
      }
    }
    if (res.periods && res.periods.length > periods.length) periods = res.periods;
    for (const it of res.items) {
      const cur = byId.get(it.wb);
      if (!cur) byId.set(it.wb, { ...it, phrases: [phrase] });
      else cur.phrases.push(phrase);
    }
  }
  const windowMonths = Math.max(1, (Date.parse(d2) - Date.parse(d1)) / (30.4 * 86400000));
  let all = [...byId.values()];
  const before = all.length;
  all = all.filter((it) => {
    const nm = lcName(it.name);
    if (mw.some((w) => nm.includes(w))) return false;
    if (priceMin != null && it.price < priceMin) return false;
    if (priceMax != null && it.price > priceMax) return false;
    if (minRevenuePerMonth != null && (it.revenue / windowMonths) < minRevenuePerMonth) return false;
    return true;
  });
  L(`Объединено по фразам: ${before} уник. товаров; после минус-слов/сегмента/выручки: ${all.length}.`);
  const gRoots = genderRootsOf(gender);
  if (gRoots) {
    let cards = new Map();
    try { cards = await fetchCardsInfo(all.map((it) => it.wb), { concurrency: 8 }); } catch { /* CDN недоступен → пол не фильтруем */ }
    const beforeG = all.length; let known = 0;
    all = all.filter((it) => {
      const g = cardGender(cards.get(Number(it.wb)));
      if (!g) return true;
      known++;
      return gRoots.some((r) => g.includes(r));
    });
    L(`Фильтр по полу (${gender}): карточек с указанным полом ${known}, оставлено ${all.length} из ${beforeG}.`);
  }
  // Метрики «за последний год» — для ОТБОРА кандидатов и витрины ТОП-15 (свежая
  // релевантность: мёртвые год назад ТОПы не всплывают). Ранг сезонности при этом
  // строится на полных 2 годах дневных рядов.
  const lyCut = offsetDate(d2, -365);
  for (const it of all) {
    let sLY = 0, rLY = 0; const gph = it.graph || [], rgph = it.revenueGraph || [];
    for (let i = 0; i < periods.length; i++) { if (periods[i] > lyCut) { sLY += gph[i] || 0; rLY += rgph[i] || 0; } }
    it.salesLY = sLY; it.revenueLY = rLY;
  }
  return { items: all, periods, requests, dailyLimit, windowMonths, total: before };
}

/**
 * Сбор аналогов для ПЛАНА. Итоговая выборка = товары с нишевым ключом в названии
 * (авто) + вручную одобренные «без ключа» (approvedIds, из «Предв. выбора»). Одобренные
 * берутся из той же выдачи SERP (без доп. запросов). Возвращает товары с дневными рядами.
 */
export async function collectSerpAll({ phrases = [], minusWords = [], priceMin, priceMax, minRevenuePerMonth, limit, gender = null, approvedIds = [] } = {}, d1, d2, log = null) {
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'сбор', msg }); };
  const g = await gatherSerp({ phrases, minusWords, priceMin, priceMax, minRevenuePerMonth, gender }, d1, d2, L);
  const keys = phraseKeys(phrases);
  const approved = new Set((approvedIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  L(`Нишевые ключи из фраз: [${keys.join(', ') || '—'}]. Одобрено вручную: ${approved.size}.`);
  // авто (ключ в названии) ∨ одобрено вручную
  let all = g.items.filter((it) => nameHasKey(it.name, keys) || approved.has(Number(it.wb)));
  const withKey = all.filter((it) => nameHasKey(it.name, keys)).length;
  L(`В выборку: с ключом в названии ${withKey}, одобренных без ключа ${all.length - withKey}, всего ${all.length}.`);
  // ТОП-выборку упорядочиваем по выручке за ПОСЛЕДНИЙ ГОД (свежесть), ранг — на 2 годах.
  all.sort((a, b) => (b.revenueLY || 0) - (a.revenueLY || 0));
  const keptBeforeLimit = all.length;
  if (limit && all.length > limit) {
    const head = all.slice(0, limit);
    const headSet = new Set(head.map((x) => Number(x.wb)));
    // одобренные вручную не выбрасываем лимитом
    const extra = all.filter((x) => approved.has(Number(x.wb)) && !headSet.has(Number(x.wb)));
    all = head.concat(extra);
  }
  for (const it of all) {
    it.dailyFull = g.periods.map((date, i) => {
      const s = it.graph[i] || 0, r = it.revenueGraph[i] || 0;
      return { date, sales: s, revenue: r, price: s > 0 ? r / s : it.price, balance: 0 };
    });
  }
  return { periods: g.periods, items: all, total: g.total, fetched: g.total, kept: keptBeforeLimit, requests: g.requests, dailyLimit: g.dailyLimit, windowMonths: g.windowMonths };
}

/**
 * Кандидаты для «Предв. выбора»: ТОП-N по ПРОДАЖАМ среди товаров БЕЗ нишевого ключа в
 * названии (их надо отсмотреть глазами). Уже одобренные помечаются checked. Использует
 * ту же выдачу SERP (кэш) — почти без запросов.
 */
export async function collectSerpCandidates({ phrases = [], minusWords = [], priceMin, priceMax, minRevenuePerMonth, gender = null, approvedIds = [], topN = 30 } = {}, d1, d2, log = null) {
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'кандидаты', msg }); };
  const g = await gatherSerp({ phrases, minusWords, priceMin, priceMax, minRevenuePerMonth, gender }, d1, d2, L);
  const keys = phraseKeys(phrases);
  const approved = new Set((approvedIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const noKey = g.items.filter((it) => !nameHasKey(it.name, keys));
  // Отбор — по продажам за ПОСЛЕДНИЙ ГОД (salesLY).
  noKey.sort((a, b) => (b.salesLY || 0) - (a.salesLY || 0));
  const withKey = g.items.length - noKey.length;
  L(`Ключи [${keys.join(', ') || '—'}]: с ключом ${withKey}, без ключа ${noKey.length} → на отсмотр ТОП-${Math.min(topN, noKey.length)} по продажам за год.`);
  const rows = noKey.slice(0, topN).map((it) => ({
    wb: it.wb, name: it.name, brand: it.brand, thumb: it.thumb,
    avgPrice: it.salesLY > 0 ? Math.round(it.revenueLY / it.salesLY) : it.price,
    unitsSold: it.salesLY, revenue: it.revenueLY,
    monthlyRevenue: Math.round((it.revenueLY || 0) / 12),
    checked: approved.has(Number(it.wb)),
  }));
  return { candidates: rows, keys, withKey, total: g.items.length, noKeyCount: noKey.length, requests: g.requests, dailyLimit: g.dailyLimit };
}

// Нарезать собранные SERP-товары под окно [w1,w2] и вернуть структуру как у
// collectFromCategory (group/groupDaily/perItemMeta/…) — БЕЗ обращений к сети.
export function sliceSerpWindow(all, w1, w2, oos = false) {
  const inWin = (d) => d >= w1 && d <= w2;
  const perItem = all.items.map((it) => ({
    wb: it.wb, name: it.name, brand: it.brand, price: it.price, thumb: it.thumb,
    salesLY: it.salesLY, revenueLY: it.revenueLY,
    daily: (it.dailyFull || []).filter((r) => inWin(r.date)),
  }));
  const groupDaily = buildGroupDailySeries(maybeOOS(perItem.map((p) => p.daily), oos));
  const perItemMeta = perItem.map((p) => {
    const daysN = p.daily.length;
    return {
      wb: p.wb, name: p.name, brand: p.brand, price: p.price, thumb: p.thumb,
      days: daysN, avgStock: 0,
      unitsSold: p.daily.reduce((s, r) => s + (Number(r.sales) || 0), 0),
      revenue: p.daily.reduce((s, r) => s + (Number(r.revenue) || 0), 0),
      unitsSoldLY: p.salesLY || 0, revenueLY: p.revenueLY || 0, // за последний год — для витрины ТОП-15
    };
  });
  const prices = all.items.map((it) => it.price).filter((v) => v > 0).sort((a, b) => a - b);
  const medianPrice = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : 0;
  return {
    group: all.items.map((it) => ({ wb: it.wb, name: it.name, brand: it.brand, price: it.price, revenue: it.revenue, sales: it.sales, thumb: it.thumb })),
    groupDaily, perItemMeta,
    attributesFound: [],
    total: all.total, fetched: all.fetched, kept: all.kept,
    medianPrice, priceAnchor: medianPrice ? Math.round(medianPrice * 0.9) : 0,
    deepMatch: false, cardsEnriched: 0, undetermined: [], structuralPool: all.fetched,
    dailyLimit: all.dailyLimit, source: 'serp',
  };
}

/** Сдвиг 'YYYY-MM-DD' на N дней. */
function offsetDate(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Применяет OOS-поправку к каждому товарному ряду (если oos=true). */
function maybeOOS(perItemDaily, oos) {
  return oos ? perItemDaily.map((d) => applyOOSCorrection(d)) : perItemDaily;
}

/** Пул параллельных задач с ограничением concurrency и ранней остановкой. */
async function mapPool(items, concurrency, worker, shouldStop) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      if (shouldStop && shouldStop()) break;
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

export const lc = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е'); // ё=е для совпадений

// Лёгкий стем русского слова: срезаем распространённое окончание, чтобы «клетка»
// матчила «в клетку», «лето» — «летняя» и т.п. (учёт словоформ).
const RU_ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ых', 'их', 'ым', 'им', 'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ью', 'ья', 'ье', 'ем', 'ом', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'й', 'ь'];
export function stem(word) {
  let w = lc(word).trim();
  for (const e of RU_ENDINGS) {
    if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, w.length - e.length);
  }
  return w;
}
const stems = (arr) => (arr || []).map(stem).filter(Boolean);
const hasStem = (text, stemList) => stemList.some((s) => text.includes(s));

// ── Сопоставление ПО СЛОВАМ (не по подстроке) ──
// Множество стемов ЦЕЛЫХ слов текста. Так «лен» больше не совпадёт с «маленький».
function wordStemSet(text) {
  const set = new Set();
  for (const w of lc(text).split(/[^a-zа-я0-9]+/)) if (w.length >= 2) set.add(stem(w));
  return set;
}
// Значение фильтра может быть многословным («свободный крой») → массив стемов слов.
// Матч: ВСЕ слова значения присутствуют в множестве слов текста (значение как фраза).
const valueStemList = (arr) => (arr || []).map((v) => stems(String(v).split(/\s+/))).filter((a) => a.length);
const valueIn = (valueStems, set) => valueStems.length > 0 && valueStems.every((s) => set.has(s));

/**
 * Детальная фильтрация выдачи по предмету до релевантных аналогов.
 * ЖЁСТКИЕ фильтры (отсекают): цена, exclude, бренды, «живость» (мин. продажи/мес
 * ИЛИ мин. выручка/мес). МЯГКИЕ (не отсекают, только релевантность): words,
 * allWords — считаем число совпадений стемов, чтобы приоритизировать аналоги;
 * товар без совпадений тоже проходит, если прошёл жёсткие фильтры.
 * Слова матчатся по СТЕМУ (учёт словоформ: «клетка» → «в клетку»).
 * @param f — {words, allWords, exclude, brands, excludeBrands, priceMin, priceMax,
 *            minSalesPerMonth, minRevenuePerMonth, windowMonths}
 * @returns items (прошедшие жёсткие), у каждого проставлен `_relevance` (число).
 */
export function filterGroupItems(items, f = {}) {
  // Значения фильтра (могут быть многословными) → списки стемов слов.
  const plusVals = valueStemList(f.words);                                   // плюс: «любое из»
  const softVals = valueStemList([...(f.words || []), ...(f.allWords || [])]); // для релевантности
  const mustVals = valueStemList(f.mustHave);                               // строгий ключ: «все»
  const plusKey = new Set(plusVals.map((vs) => vs.join(' ')));
  // Минус, совпадающий по стему с плюсом (напр. «длинным»+ и «длинный»−), — конфликт;
  // плюс имеет приоритет («я это хочу»), поэтому такой минус игнорируем.
  const exclVals = valueStemList(f.exclude).filter((vs) => !plusKey.has(vs.join(' ')));
  const brands = stems(f.brands);
  const excludeBrands = stems(f.excludeBrands);
  const months = f.windowMonths || 1;
  const minSales = f.minSalesPerMonth != null ? f.minSalesPerMonth * months : null;
  const minRev = f.minRevenuePerMonth != null ? f.minRevenuePerMonth * months : null;
  // Обратная совместимость: старый minSales (за окно, не за месяц).
  const minSalesAbs = f.minSales != null ? f.minSales : null;

  const out = [];
  for (const it of items) {
    const brand = lc(it.brand);
    if (f.priceMin != null && it.price < f.priceMin) continue;
    if (f.priceMax != null && it.price > f.priceMax) continue;
    // Множества слов: полный текст (заголовок+описание+характеристики) — для ПЛЮС/релевантности;
    // только заголовок+характеристики — для СТРОГОГО КЛЮЧА и МИНУСА (без маркетинговой «воды»).
    const fullSet = it._wordSetFull || (it._wordSetFull = wordStemSet(it._matchText || lc(it.name)));
    const charSet = it._wordSetChar || (it._wordSetChar = wordStemSet(it._charText || it._matchText || lc(it.name)));
    // Строгий ключ: ВСЕ значения (как фразы) должны быть в характеристиках.
    if (mustVals.length && !mustVals.every((vs) => valueIn(vs, charSet))) continue;
    // Минус: если ЛЮБОЕ одно минус-значение совпало (по словам в характеристиках) — исключаем.
    if (exclVals.length && exclVals.some((vs) => valueIn(vs, charSet))) continue;
    // Плюс: если заданы — нужно совпадение ЛЮБОГО одного плюс-значения (в полном тексте).
    if (plusVals.length && !plusVals.some((vs) => valueIn(vs, fullSet))) continue;
    if (brands.length && !hasStem(brand, brands)) continue;
    if (excludeBrands.length && hasStem(brand, excludeBrands)) continue;
    // Живость: проходит, если ЛИБО продажи/мес ≥ порога, ЛИБО выручка/мес ≥ порога.
    if (minSales != null || minRev != null) {
      const okSales = minSales != null && it.sales >= minSales;
      const okRev = minRev != null && it.revenue >= minRev;
      if (!(okSales || okRev)) continue;
    }
    if (minSalesAbs != null && it.sales < minSalesAbs) continue;
    it._relevance = softVals.length ? softVals.filter((vs) => valueIn(vs, fullSet)).length : 0;
    out.push(it);
  }
  return out;
}

// Только структурные жёсткие фильтры (цена/живость/бренды), БЕЗ слов — чтобы собрать
// пул кандидатов ДО обогащения карточек (иначе короткое название отсеет релевантных).
const WORD_KEYS = ['words', 'allWords', 'exclude', 'mustHave'];
function structuralOnly(f) { const g = { ...f }; for (const k of WORD_KEYS) delete g[k]; return g; }

// Пул «неопределённых» товаров на ручную проверку: НЕ прошли плюс-слова, но при этом
// в ценовом сегменте, с выручкой/мес ≥ порога и НЕ исключены минус-словами. Такой товар
// может быть релевантным (напр. «рубашка женская» без прочих признаков, но с продажами).
const UNDET_MIN_MONTHLY = 100000; // ₽/мес — минимальная выручка «кандидата»
const UNDET_TOP = 20;
function computeUndetermined(pool, f, acceptedWb, months) {
  const exclVals = valueStemList(f.exclude);
  const out = [];
  for (const it of pool) {
    if (acceptedWb.has(String(it.wb))) continue;                 // уже в выборке
    if (f.priceMin != null && it.price < f.priceMin) continue;   // ценовой сегмент
    if (f.priceMax != null && it.price > f.priceMax) continue;
    if ((Number(it.revenue) || 0) / Math.max(1, months) < UNDET_MIN_MONTHLY) continue;
    const charSet = it._wordSetChar || wordStemSet(it._charText || lc(it.name));
    if (exclVals.length && exclVals.some((vs) => valueIn(vs, charSet))) continue; // явно исключённые — не «неопределённые»
    out.push(it);
  }
  out.sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0));
  return out.slice(0, UNDET_TOP).map((it) => ({
    wb: it.wb, name: it.name, brand: it.brand, price: it.price,
    unitsSold: Number(it.sales) || 0, revenue: Number(it.revenue) || 0,
    avgPrice: (Number(it.sales) > 0) ? (Number(it.revenue) / it.sales) : (it.price || null),
    monthlyRevenue: Math.round((Number(it.revenue) || 0) / Math.max(1, months)),
  }));
}

// Агрегировать характеристики отобранных карточек: {name -> [{value,count}]}. Значения
// вроде «хлопок 60%; шерсть 30%» бьём по ';' на отдельные признаки. Для блока «Характеристики
// выборки» — видно реальный состав/сезон/крой и можно подобрать строгий ключ.
function aggregateAttributes(items, topValues = 8, topAttrs = 14) {
  const byName = new Map();
  for (const it of items) {
    const opts = it._card && Array.isArray(it._card.options) ? it._card.options : [];
    for (const o of opts) {
      const name = String(o.name || '').trim(); if (!name) continue;
      const vals = String(o.value || '').split(/[;,]/).map((v) => v.trim().replace(/\s+\d+%$/, '').trim()).filter(Boolean);
      if (!byName.has(name)) byName.set(name, new Map());
      const vm = byName.get(name);
      for (const v of vals) vm.set(v, (vm.get(v) || 0) + 1);
    }
  }
  const out = [];
  for (const [name, vm] of byName) {
    const values = [...vm.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count).slice(0, topValues);
    out.push({ name, total: values.reduce((s, v) => s + v.count, 0), values });
  }
  return out.sort((a, b) => b.total - a.total).slice(0, topAttrs);
}

/**
 * BULK-СБОР: собирает группу И её дневные ряды ОДНИМ (или несколькими при
 * пагинации) запросом к /wb/get/category. Дневные ряды берутся из графиков
 * ответа (sales_graph/stocks_graph/price_graph) — БЕЗ per-SKU запросов.
 * Это ключевая оптимизация лимита: 1 запрос вместо N (по числу SKU).
 *
 * @param {object} p
 * @param {string} p.path — путь предмета.
 * @param {string} p.d1, p.d2 — период.
 * @param {object} [p.filter] — детальная фильтрация (режим B).
 * @param {number} [p.limit] — топ-N по выручке после фильтра.
 * @param {Set}    [p.wbSet] — если задан, оставляем только эти WB (режим A по path).
 * @param {number} [p.pageSize=5000] — строк за запрос (макс ~5000).
 * @param {number} [p.maxPages=4] — предохранитель на число страниц.
 * @returns {Promise<{group, groupDaily, perItemMeta, total, fetched, kept, requests, dailyLimit}>}
 */
export async function collectFromCategory({
  path,
  d1,
  d2,
  filter = {},
  limit,
  wbSet = null,
  pageSize,
  maxPages = 8,
  oos = false,
  deepMatch = true, // обогащать карточками WB (описание+характеристики) для матчинга слов
  includeWb = null, // Set nmID — вручную отобранные «неопределённые», включить принудительно
  log = null,       // массив для расширенного лога этапов (необязательно)
} = {}) {
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'сбор', msg }); };
  // Размер страницы: ответ несёт дневные графики по каждому товару (≈15 рядов ×
  // дни). При 5000 строках это сотни МБ и минуты загрузки. 1000 — компромисс:
  // грузится за ~секунды, а т.к. 1 запрос = 1 единица лимита, крупная страница
  // выгоднее многих мелких (меньше запросов при том же объёме данных).
  pageSize = pageSize || 1000;
  // Продажи/выручка в выдаче — за окно [d1..d2]; для порогов «в месяц» нужен
  // масштаб окна.
  const windowMonths = Math.max(1, (Date.parse(d2) - Date.parse(d1)) / (30.4 * 86400000));
  const fWin = { ...filter, windowMonths };
  const hasSoft = (filter.words?.length || filter.allWords?.length);
  const hasWords = !!(filter.words?.length || filter.allWords?.length || filter.exclude?.length || filter.mustHave?.length);
  // Режим поведенческой релевантности (новый): отбор по доле целевого поискового трафика
  // (by_keywords), а не по плюс/минус-словам. Требует обогащения карточек для предфильтра.
  const relevance = filter.relevance || null;
  const deep = deepMatch && (hasWords || !!relevance) && !wbSet; // обогащение нужно и для релевантности
  let relInfo = null;
  // Сколько карточек максимум обогащать. Раньше было 120 (сильно резало — отбор шёл
  // только по топ-120 выручки). Теперь тянем ВСЮ выдачу предмета и обогащаем весь
  // структурный пул (в сегменте) до этого потолка.
  const MAX_ENRICH = 1200;
  const raw = [];
  let total = Infinity;
  let requests = 0;
  let dailyLimit = null;

  L(`Запрос выдачи MPStats по предмету "${path}" (сортировка по выручке ↓), период ${d1}…${d2}.`);
  for (let startRow = 0; startRow < total && requests < maxPages; startRow += pageSize) {
    let res;
    try {
      res = await fetchCategoryItems({ path, d1, d2, startRow, endRow: startRow + pageSize });
    } catch (err) {
      if (err?.dailyLimit) { dailyLimit = String(err?.message || err); L(`Достигнут дневной лимит MPStats: ${dailyLimit}`); break; }
      throw err;
    }
    requests += 1;
    total = res.total || res.data.length;
    const matchedBefore = wbSet ? raw.filter((r) => wbSet.has(String(r.id ?? r.nmId))).length : 0;
    raw.push(...res.data);
    L(`Страница ${requests}: получено ${res.data.length}, всего в предмете ${total}, накоплено ${raw.length}.`);
    if (res.data.length < pageSize) break;
    // Режим A (по списку WB): ранняя остановка, когда все нужные найдены.
    if (wbSet) {
      const matched = raw.filter((r) => wbSet.has(String(r.id ?? r.nmId))).length;
      if (matched >= wbSet.size || matched === matchedBefore) break;
    }
    // Режим B: тянем ВСЮ выдачу предмета (до maxPages), чтобы фильтр применялся ко всей
    // базе, а не к топ-выдаче по выручке. Ранней остановки по числу совпадений больше нет.
  }
  L(`Итого получено артикулов из предмета: ${raw.length} (страниц ${requests}${requests >= maxPages ? `, упёрлись в лимит ${maxPages} страниц` : ''}).`);

  const allItems = raw
    .map((r) => ({ ...normalizeCategoryItem(r), _raw: r }))
    .filter((it) => it.wb != null);
  let items;
  let basePool = allItems;   // пул кандидатов (для «неопределённых»)
  let cardsEnriched = 0;
  const segMsg = (filter.priceMin != null || filter.priceMax != null)
    ? `сегмент ${filter.priceMin ?? '0'}–${filter.priceMax ?? '∞'} ₽` : 'без ценового сегмента';
  if (wbSet) {
    items = allItems.filter((it) => wbSet.has(String(it.wb)));
    L(`Режим по списку WB: оставлено ${items.length} из ${allItems.length}.`);
  } else if (deep) {
    // 1) Структурный пул (цена/живость) — ВСЕ подходящие по сегменту, топ по выручке.
    let pool = filterGroupItems(allItems, structuralOnly(fWin));
    pool.sort((a, b) => (b.revenue || 0) - (a.revenue || 0) || (b.sales || 0) - (a.sales || 0));
    L(`Структурный фильтр (${segMsg}, живость): прошло ${pool.length} из ${allItems.length}.`);
    const poolFull = pool.length;
    if (pool.length > MAX_ENRICH) { pool = pool.slice(0, MAX_ENRICH); L(`⚠ Кандидатов ${poolFull} > потолка обогащения ${MAX_ENRICH} — обогащаем топ-${MAX_ENRICH} по выручке (остальные не проверены по признакам).`); }
    // 2) Обогащаем карточками WB (бесплатный CDN): matchText = название + описание + характеристики.
    try {
      const cards = await fetchCardsInfo(pool.map((it) => it.wb), { concurrency: 8 });
      for (const it of pool) {
        const info = cards.get(Number(it.wb));
        if (info) {
          it._matchText = lc(it.name) + ' \n ' + cardMatchText(info);
          it._charText = cardCharText(info); // заголовок+характеристики — для строгого ключа
          it._card = info;
          cardsEnriched++;
        }
      }
    } catch { /* CDN недоступен → откат на матчинг по названию */ }
    L(`Обогащение карточек WB: успешно ${cardsEnriched} из ${pool.length}${cardsEnriched === 0 ? ' — ⚠ карточки не загрузились (wbbasket.ru недоступен?); отбор по названию' : ''}.`);
    basePool = pool;
    // 3) Применяем слова к обогащённому тексту. НО если ни одна карточка не подтянулась
    // (CDN недоступен) — полный откат на прежнее поведение (матчинг по НАЗВАНИЮ на всей
    // выдаче), чтобы недоступность CDN не давала пустую выборку. Без регресса.
    if (relevance) {
      // Отбор по доле целевого трафика (by_keywords, кэш-первым). Период by_keywords —
      // последние 30 дней (профиль запросов свежий), а не всё историческое окно.
      const kd2 = relevance.kwD2 || d2;
      const kd1 = relevance.kwD1 || offsetDate(kd2, -30);
      relInfo = await filterByRelevance(pool, {
        targetWords: relevance.targetWords || [],
        pickedPhrases: relevance.pickedPhrases || [],
        threshold: relevance.threshold ?? 0.2,
        budget: relevance.budget ?? 60,
        d1: kd1, d2: kd2, log, onProgress: relevance.onProgress,
      });
      for (const it of pool) {
        const s = relInfo.scores.get(String(it.wb));
        if (s) { it.share = s.share; it.matched = s.matched; it._relevance = s.share; }
      }
      items = pool.filter((it) => relInfo.keep.has(String(it.wb)));
      L(`Поведенческая релевантность (цель: [${(relevance.targetWords || []).join(', ') || '—'}]${(relevance.pickedPhrases || []).length ? ` + ${relevance.pickedPhrases.length} выбр. фраз` : ''}; порог доли ${Math.round((relevance.threshold ?? 0.2) * 100)}%) → принято ${items.length}. Профилей из базы ${relInfo.cached}, запросов сети ${relInfo.requests}${relInfo.dailyLimit ? '; ⚠ суточный лимит' : ''}.`);
    } else {
      items = cardsEnriched > 0 ? filterGroupItems(pool, fWin) : filterGroupItems(allItems, fWin);
      L(`Фильтр плюс/минус (плюс «любое из»: [${(filter.words || []).join(', ') || '—'}]; минус «любой исключает»: [${(filter.exclude || []).join(', ') || '—'}]; строгий ключ: [${(filter.mustHave || []).join(', ') || '—'}]) → принято ${items.length}.`);
    }
  } else {
    basePool = filterGroupItems(allItems, structuralOnly(fWin));
    items = filterGroupItems(allItems, fWin);
    L(`Фильтр (без глубокого анализа): структурных ${basePool.length}, принято ${items.length} из ${allItems.length}.`);
  }
  // Принудительное включение вручную отобранных «неопределённых» (по nmID) — минуя слова.
  if (includeWb && includeWb.size) {
    const have = new Set(items.map((it) => String(it.wb)));
    let added = 0;
    for (const it of allItems) {
      if (includeWb.has(String(it.wb)) && !have.has(String(it.wb))) { items.push(it); have.add(String(it.wb)); added++; }
    }
    L(`Добавлено вручную одобренных «неопределённых»: ${added}.`);
  }
  // Пул «неопределённых» на ручную проверку (только режим B со словами).
  const undetermined = (!wbSet && hasWords)
    ? computeUndetermined(basePool, fWin, new Set(items.map((it) => String(it.wb))), windowMonths)
    : [];
  if (!wbSet && hasWords) L(`«Неопределённых» кандидатов (без плюс/минус, ${segMsg}, ≥100 000 ₽/мес): ${undetermined.length}.`);
  // Сортировка (Правило п.3): релевантность → ОБЪЁМ ПРОДАЖ ↓ → ЦЕНА ↓.
  items.sort((a, b) =>
    (b._relevance || 0) - (a._relevance || 0) ||
    (b.sales || 0) - (a.sales || 0) ||
    (b.price || 0) - (a.price || 0));
  // ПРАВИЛО ПЛЮС/МИНУС (по требованию): плюс-слова — «любое из» (достаточно одного
  // совпадения, не обязательно всех); минус-слова — «любое одно исключает». Дополнительный
  // отсев по доле совпавших признаков НЕ применяем (иначе теряются релевантные с одним
  // совпадением). Сортировка по релевантности выше — только для порядка топ-выдачи.
  const keptBeforeLimit = items.length;
  if (limit && items.length > limit) items = items.slice(0, limit);
  L(`Итоговая выборка аналогов для плана: ${items.length}${keptBeforeLimit > items.length ? ` (из ${keptBeforeLimit} прошедших, ограничено размером группы ${limit})` : ''}.`);

  // Характеристики отобранной выборки (Состав/Сезон/Крой…) — для блока проверки и подбора
  // строгого ключа. Только при глубоком режиме (когда карточки обогащены).
  const attributesFound = deep ? aggregateAttributes(items) : [];

  // Ценовой якорь «по медиане и ниже на 10%» (конкурентная цена входа среди ТОПов):
  // медиана цен отобранных конкурентов минус 10%.
  const prices = items.map((it) => it.price).filter((v) => v > 0).sort((a, b) => a - b);
  const medianPrice = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : 0;
  const priceAnchorBelowMedian = medianPrice ? Math.round(medianPrice * 0.9) : 0;

  // Обрезано предохранителем: упёрлись в maxPages, в предмете есть ещё товары, а
  // отфильтрованных аналогов набралось меньше запрошенного limit. Значит фильтр
  // узкий — стоит поднять --max-pages или ослабить критерии.
  const hitCap = requests >= maxPages && raw.length < total;
  const truncated = !wbSet && hitCap && keptBeforeLimit < (limit || 60);

  // Дневные ряды из графиков — без единого доп. запроса.
  const perItem = items.map((it) => ({
    wb: it.wb,
    name: it.name,
    brand: it.brand,
    price: it.price,
    share: it.share,      // доля целевого трафика (режим релевантности)
    matched: it.matched,  // сколько выбранных фраз совпало
    daily: extractItemDailyFromGraphs(it._raw, d1, d2),
  }));
  const groupDaily = buildGroupDailySeries(maybeOOS(perItem.map((p) => p.daily), oos));
  const perItemMeta = perItem.map((p) => {
    const daysN = p.daily.length;
    const stockSum = p.daily.reduce((s, r) => s + (Number(r.balance) || 0), 0);
    return {
      wb: p.wb,
      name: p.name,
      brand: p.brand,
      price: p.price,
      share: p.share,     // доля целевого трафика
      matched: p.matched,
      days: daysN,
      avgStock: daysN ? stockSum / daysN : 0, // средний остаток → для оборачиваемости
      unitsSold: p.daily.reduce((s, r) => s + (Number(r.sales) || 0), 0),
      revenue: p.daily.reduce((s, r) => s + (Number(r.revenue) || 0), 0),
    };
  });

  return {
    group: items.map(({ _raw, _card, _charText, _matchText, ...g }) => g),
    groupDaily,
    perItemMeta,
    attributesFound,
    total: Number.isFinite(total) ? total : raw.length,
    fetched: raw.length,
    kept: keptBeforeLimit,
    requests,
    truncated,
    maxPages,
    dailyLimit,
    medianPrice,
    priceAnchor: priceAnchorBelowMedian, // конкурентная цена: медиана −10%
    deepMatch: deep,
    cardsEnriched, // сколько карточек обогащено (матчинг по описанию+характеристикам)
    undetermined,  // ТОП-20 «неопределённых» на ручную проверку
    structuralPool: basePool.length,
    relevance: relInfo && {
      threshold: relevance.threshold ?? 0.2,
      cached: relInfo.cached, requests: relInfo.requests,
      prefiltered: relInfo.prefiltered, dailyLimit: relInfo.dailyLimit || null,
    },
  };
}

/**
 * Тянет дневные ряды по списку SKU и агрегирует в дневной ряд группы.
 * @param group — [{wb, ...}] или [число].
 * @returns {Promise<{groupDaily, perItemMeta, errors, dailyLimit}>}
 */
export async function collectGroupDaily({ group, d1, d2, concurrency = 5, onProgress, oos = false } = {}) {
  const list = (group || []).map((g) => ({ wb: String(g.wb ?? g), name: g.name || '' }));
  const errors = [];
  let dailyLimit = null;
  let done = 0;

  const perItem = await mapPool(
    list,
    concurrency,
    async (item) => {
      try {
        const daily = await fetchItemDailySales(item.wb, d1, d2);
        if (onProgress) onProgress(++done, list.length, item.wb);
        return { wb: item.wb, name: item.name, daily };
      } catch (err) {
        if (err?.dailyLimit && !dailyLimit) dailyLimit = String(err?.message || err);
        errors.push({ wb: item.wb, error: String(err?.message || err) });
        if (onProgress) onProgress(++done, list.length, item.wb);
        return { wb: item.wb, name: item.name, daily: [] };
      }
    },
    () => dailyLimit !== null
  );

  const withData = perItem.filter(Boolean);
  const groupDaily = buildGroupDailySeries(maybeOOS(withData.map((p) => p.daily), oos));
  const perItemMeta = withData.map((p) => ({
    wb: p.wb,
    name: p.name,
    days: p.daily.length,
    unitsSold: p.daily.reduce((s, r) => s + (Number(r.sales) || 0), 0),
    revenue: p.daily.reduce((s, r) => s + (Number(r.revenue) || 0), 0),
  }));

  return { groupDaily, perItemMeta, errors, dailyLimit };
}

/**
 * Полный отчёт «план продаж на сезон» по группе.
 *
 * Способ сбора (по убыванию экономии лимита):
 *   1. BULK через графики категории — 1 запрос на группу. Используется, если
 *      задан `subject` (режим B) ИЛИ `group`+`path` (режим A по предмету).
 *   2. FALLBACK per-SKU — N запросов (по числу SKU). Только если задан `group`
 *      без `path` (нет предмета для bulk).
 *
 * @param {object} p
 * @param {string} p.d1, p.d2 — период истории (обычно тот же сезон год назад).
 * @param {Array}  [p.group] — явный список WB (напр. из config/groups.json).
 * @param {string} [p.path] — путь предмета для BULK-сбора режима A.
 * @param {object} [p.subject] — {path, filter, limit} для режима B.
 * @param {string} [p.label] — метка линейки/группы.
 * @param {object} [p.plan] — опции ядра (oos, weekly, ambition, targetPeriodUnits…).
 * @param {string} [p.baseSource] — 'own' | 'target' | 'market'. УРОВЕНЬ плана.
 * @param {object} [p.own] — {group:[WB], path} собственная линейка для базы 'own'.
 */
export async function buildSeasonPlanReport({
  d1,
  d2,
  group,
  path,
  label = '',
  subject,
  plan = {},
  baseSource = 'market',
  own = null,
  forecast = null, // {from, to} — прогноз на будущий период (Правило 3)
  concurrency = 5,
  onProgress,
  includeWb = null, // Set nmID — вручную одобренные «неопределённые», включить принудительно
  log = [],         // расширенный лог этапов
} = {}) {
  const oos = !!plan.oos;
  const includeSet = includeWb && includeWb.size ? includeWb : (Array.isArray(plan.includeWb) && plan.includeWb.length ? new Set(plan.includeWb.map(String)) : null);
  const LP = (msg) => log.push({ t: new Date().toISOString(), stage: 'план', msg });

  // Замыкание: собрать «форму» (аналоги/группу) за произвольное окно тем же источником.
  let _serpAll = null, _serpReqCounted = false; // SERP тянем один раз на полное окно, окна режем в памяти
  const collectShape = async (w1, w2) => {
    if (subject && subject.serp) {
      if (!_serpAll) _serpAll = await collectSerpAll(subject.serp, d1, d2, log);
      const req = _serpReqCounted ? 0 : ((_serpReqCounted = true), _serpAll.requests || 0);
      return { method: 'serp', requests: req, ...sliceSerpWindow(_serpAll, w1, w2, oos) };
    }
    if (subject) {
      return { method: 'category-bulk', ...(await collectFromCategory({ path: subject.path, d1: w1, d2: w2, filter: subject.filter || {}, limit: subject.limit, maxPages: subject.maxPages, oos, deepMatch: plan.deepMatch !== false, includeWb: includeSet, log })) };
    } else if (group && path) {
      const wbSet = new Set(group.map((g) => String(g.wb ?? g)));
      return { method: 'category-bulk', ...(await collectFromCategory({ path, d1: w1, d2: w2, wbSet, oos })) };
    } else if (group && group.length) {
      const res = await collectGroupDaily({ group, d1: w1, d2: w2, concurrency, onProgress, oos });
      return { method: 'per-sku', requests: group.length, ...res };
    }
    throw new Error('Пустая группа: задайте group (список WB) или subject (path+filter).');
  };

  let requests = 0;
  const collected = await collectShape(d1, d2); // история (2 года)
  requests += collected.requests || 0;
  const method = collected.method;
  const groupInfo = subject
    ? { path: subject.path, total: collected.total, fetched: collected.fetched, kept: collected.kept, truncated: collected.truncated, maxPages: collected.maxPages, deepMatch: collected.deepMatch, cardsEnriched: collected.cardsEnriched }
    : path ? { path, total: collected.total, fetched: collected.fetched, kept: collected.kept } : null;

  const { groupDaily, perItemMeta, dailyLimit } = collected;
  const errors = collected.errors || [];
  LP(`Сбор аналогов завершён: в выборке ${perItemMeta.length}, с дневными данными ${perItemMeta.filter((m) => m.days > 0).length}. Строю уровень/ранг/фазы и план.`);

  // ── УРОВЕНЬ плана (baseDaily) ──
  const shapeBase = baseFromDaily(groupDaily);
  const analogCount = perItemMeta.filter((m) => m.days > 0).length || 1;
  let baseInfo = { source: baseSource };
  let baseDailyOverride; // если undefined — ядро возьмёт свою логику (market/target)

  if (baseSource === 'own' && own && (own.group?.length)) {
    // Тянем собственную линейку (bulk по предмету, иначе per-SKU).
    let ownCol;
    if (own.path) {
      const wbSet = new Set(own.group.map((g) => String(g.wb ?? g)));
      ownCol = await collectFromCategory({ path: own.path, d1, d2, wbSet, oos });
      requests += ownCol.requests;
    } else {
      ownCol = await collectGroupDaily({ group: own.group, d1, d2, concurrency, oos });
      requests += own.group.length;
    }
    const ownBase = baseFromDaily(ownCol.groupDaily);
    const skuCount = own.group.length;
    const weakDays = plan.weakDays ?? 90;
    // Правило 3: УРОВЕНЬ = competitorWeight·конкуренты + (1−w)·свои.
    // Конкурентная оценка нашего уровня = средний аналог/товар × число наших SKU.
    const cw = plan.competitorWeight ?? 0.9;
    const perAnalog = analogCount ? shapeBase.base / analogCount : 0;
    const competitorLevel = perAnalog * skuCount;
    const hasOwn = ownBase.days >= weakDays && ownBase.base > 0;
    if (hasOwn) {
      baseDailyOverride = cw * competitorLevel + (1 - cw) * ownBase.base;
      baseInfo = {
        source: 'blend', competitorWeight: cw,
        competitorPerItemDaily: round1(perAnalog), competitorLevel: round1(competitorLevel),
        ownBaseDaily: round1(ownBase.base), ownActiveDays: ownBase.days, ownSkuCount: skuCount,
        blendedBaseDaily: round1(baseDailyOverride),
      };
    } else {
      // Своих данных нет/мало → 100% по конкурентам.
      baseDailyOverride = competitorLevel;
      baseInfo = {
        source: 'competitor', reason: ownBase.days > 0 ? `своих данных мало (${ownBase.days} дн.)` : 'своих продаж нет',
        competitorPerItemDaily: round1(perAnalog), competitorLevel: round1(competitorLevel),
        ownSkuCount: skuCount, ownActiveDays: ownBase.days, estimatedBaseDaily: round1(baseDailyOverride),
      };
    }
  }

  const ambition = plan.ambition ?? 1;
  // Разрешение УРОВНЯ: свой бленд (own) → иначе для прогноза берём средний
  // КОНКУРЕНТ НА КАРТОЧКУ (план на 1 карточку), для истории — весь уровень группы.
  const perItemBase = analogCount ? shapeBase.base / analogCount : shapeBase.base;
  let baseDaily = baseDailyOverride != null ? baseDailyOverride : (forecast ? perItemBase : shapeBase.base);
  baseDaily *= ambition;
  if (baseDailyOverride == null && forecast) {
    baseInfo = { source: 'competitor-per-item', competitorPerItemDaily: round1(perItemBase), analogCount, note: 'план на 1 карточку (средний конкурент); задайте свою линейку --group для бленда 90/10' };
  }

  // ── ВЕТКА ПРОГНОЗА: движок сам выбирает окно сезона из ГОДОВОГО анализа ──
  if (forecast && groupDaily.length > 0) {
    // Правило 4: аналоги за последние 60 дней и то же окно год назад.
    const recentCol = await collectShape(offsetDate(d2, -59), d2);
    requests += recentCol.requests || 0;
    const priorCol = await collectShape(offsetDate(d2, -59 - 365), offsetDate(d2, -365));
    requests += priorCol.requests || 0;

    // ЦЕЛЕВОЙ УРОВЕНЬ (пик плана). Два режима:
    //   'top3' (по умолчанию) — средняя дневных продаж трёх сильнейших аналогов (реалистично);
    //   'top1' — уровень САМОГО сильного аналога (амбициозно: цель стать ТОП-1, макс. объём).
    // «Сильнейший» — по ВЫРУЧКЕ (при заданном ценовом сегменте это и максимум продаж);
    // ценовой сегмент уже применён фильтром (priceMin/priceMax), поэтому сравниваем внутри него.
    const withDays = (perItemMeta || []).filter((m) => m.days > 0);
    const byDaily = withDays.map((m) => m.unitsSold / m.days).sort((a, b) => b - a);
    const top3Daily = byDaily.length ? byDaily.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, byDaily.length) : perItemBase;
    const strongest = withDays.slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0) || (b.unitsSold || 0) - (a.unitsSold || 0))[0];
    const top1Daily = strongest && strongest.days > 0 ? strongest.unitsSold / strongest.days : (byDaily[0] || perItemBase);
    const targetLevel = plan.targetLevel === 'top1' ? 'top1' : 'top3';
    const targetDaily = targetLevel === 'top1' ? top1Daily : top3Daily;

    const fc = buildForecast({
      history: groupDaily,
      recent60: recentCol.groupDaily,
      prior60: priorCol.groupDaily,
      baseDaily,
      top3Daily: targetDaily,
      targetYear: forecast.targetYear,
      opts: { ...plan, baseSource: baseInfo.source, priceAnchor: collected.priceAnchor },
    });
    fc.priceInfo = { anchor: collected.priceAnchor, medianPrice: collected.medianPrice };
    fc.levelInfo = {
      targetLevel,
      top1Daily: Math.round(top1Daily * 10) / 10,
      top3Daily: Math.round(top3Daily * 10) / 10,
      top1Name: strongest ? strongest.name : null,
    };
    const rk = fc.plan && fc.plan.rank;
    LP(`Прогноз построен: ранг ${rk ? (rk.rank ?? '—') : '—'}, уровень ${targetLevel === 'top1' ? 'ТОП-1' : 'ТОП-3'} (${Math.round(targetDaily)} шт/день), период прогноза ${fc.forecastPeriod ? fc.forecastPeriod.from + '…' + fc.forecastPeriod.to : '—'}.`);

    return {
      label,
      mode: 'forecast',
      historyPeriod: { d1, d2 },
      forecastPeriod: fc.forecastPeriod,
      generatedAt: new Date().toISOString(),
      method,
      requests,
      groupInfo,
      baseInfo,
      relevance: collected.relevance || null,
      groupSize: perItemMeta.length,
      itemsWithData: perItemMeta.filter((m) => m.days > 0).length,
      perItem: perItemMeta,
      attributesFound: collected.attributesFound || [],
      plan: fc,
      errors,
      dailyLimit,
      log,
    };
  }

  // ── Исторический план (как раньше) ──
  const planOpts = { ...plan, baseSource: baseInfo.source };
  if (baseDailyOverride != null) planOpts.baseDailyOverride = baseDailyOverride;
  const seasonPlan = groupDaily.length > 0 ? buildSeasonPlan(groupDaily, planOpts) : null;

  return {
    label,
    mode: 'history',
    period: { d1, d2 },
    generatedAt: new Date().toISOString(),
    method,
    requests,
    groupInfo,
    baseInfo,
    groupSize: perItemMeta.length,
    itemsWithData: perItemMeta.filter((m) => m.days > 0).length,
    perItem: perItemMeta,
    attributesFound: collected.attributesFound || [],
    plan: seasonPlan,
    errors,
    dailyLimit,
    log,
  };
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** Среднедневная база по активному периоду ряда группы (штук/день). */
function baseFromDaily(groupDaily) {
  const a = trimToActive(groupDaily || []);
  if (!a.length) return { base: 0, days: 0 };
  const sum = a.reduce((s, r) => s + (Number(r.sales) || 0), 0);
  return { base: sum / a.length, days: a.length };
}

const CSV_HISTORY = [
  ['date', 'Дата (история)'], ['dateNext', 'Дата (план)'], ['stage', 'Этап'],
  ['plannedOrders', 'Продажи план, шт'], ['price', 'Цена, ₽'],
  ['kSales', 'k продаж'], ['kStock', 'k остатков'], ['kPrice', 'k цены'], ['weekdayFactor', 'k дня недели'],
];
const CSV_FORECAST = [
  ['date', 'Дата'], ['stage', 'Этап'], ['plannedOrders', 'Продажи план, шт'],
  ['price', 'Цена, ₽'], ['favorable', 'Благоприятно'],
];

/** Экспорт дневного плана/прогноза в CSV (';' + BOM — дружелюбно к RU Excel). */
export function seasonPlanToCSV(report) {
  const sep = ';';
  const cell = (v) => {
    if (v === true) return 'да';
    if (v == null || v === '' || v === false) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    return String(v);
  };
  const forecast = report.mode === 'forecast';
  const cols = forecast ? CSV_FORECAST : CSV_HISTORY;
  const daily = forecast ? report.plan?.forecastDaily || [] : report.plan?.daily || [];
  const header = cols.map(([, t]) => t).join(sep);
  const rows = daily.map((r) => cols.map(([k]) => cell(r[k])).join(sep));
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n';
}
