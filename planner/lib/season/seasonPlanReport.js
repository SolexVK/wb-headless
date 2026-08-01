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
import { computeColorShares } from './colorSize.js';
import { fetchSalesSizesBatch, fetchApiLimit } from './mpstatsSizes.js';
import { computeSizeCurveFromSales } from './sizeCurve.js';
import { serpLoad, serpSave, mpSizeSalesLoad, mpSizeSalesSave } from '../db.js';

const SERP_TTL_MS = 3 * 24 * 3600 * 1000; // кэш SERP на 3 дня (сезонная форма стабильна)
const lcName = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// Размерный спрос из ОФИЦИАЛЬНОГО API MPStats (sales/sizes). Берём строгий ТОП-N живых
// конкурентов по продажам, для каждого — продажи по размерам за окно [w1,w2] (cache-first,
// TTL). Экономно к квоте: перед батчем читаем остаток, при нехватке не лезем. Возвращает
// объект с diag даже при пустоте — блок покажет причину, а не исчезнет.
const SIZE_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;   // кэш размерного спроса — 7 дней
async function gatherSizeCurve(perItemMeta, { d1, d2, topN = 10, enabled = true } = {}) {
  if (!enabled) return null;
  // Окно спроса: свежие ~90 дней до конца истории (а не 2 года — иначе мешаем сезоны).
  const w2 = String(d2 || new Date().toISOString().slice(0, 10));
  const w1 = offsetDate(w2, -90);
  const diag = { source: 'mpstats', window: `${w1}…${w2}`, topN, requested: 0, fromCache: 0, fetched: 0, quota: null, errors: [], reason: '' };
  const base = { sizes: [], grid: { core: [], extreme: [] }, window: { d1: w1, d2: w2 } };
  const empty = (reason) => ({ ...base, diag: { ...diag, reason } });

  const live = (perItemMeta || []).filter((m) => (m.unitsSoldLY || m.unitsSold || 0) > 0)
    .sort((a, b) => (b.unitsSoldLY || b.unitsSold || 0) - (a.unitsSoldLY || a.unitsSold || 0)).slice(0, topN);
  const skus = live.map((m) => Number(m.wb)).filter((n) => Number.isFinite(n) && n > 0);
  if (!skus.length) return empty('no-live-nm');

  // Сколько карточек уже в свежем кэше — на столько квота не нужна.
  const needFetch = skus.filter((s) => !mpSizeSalesLoad(s, w1, w2, SIZE_CACHE_TTL_MS));
  // Квота-гард: если требуется живой запрос, но остаток меньше нужного — не тратим совсем.
  if (needFetch.length) {
    const quota = await fetchApiLimit();
    diag.quota = quota;
    if (quota && quota.remaining < needFetch.length) return empty('low-quota');
  }

  const perCompetitor = [];
  try {
    const bySku = await fetchSalesSizesBatch(skus, {
      d1: w1, d2: w2,
      cacheGet: (s) => mpSizeSalesLoad(s, w1, w2, SIZE_CACHE_TTL_MS),
      cacheSet: (s, rows) => mpSizeSalesSave(s, w1, w2, rows),
      diag,
    });
    for (const s of skus) { const rows = bySku.get(s); if (rows) perCompetitor.push({ sku: s, rows }); }
  } catch (e) { diag.errors.push(String(e?.message || e).slice(0, 120)); return empty('fetch-throw'); }

  if (!perCompetitor.length) return empty('empty');
  const curve = computeSizeCurveFromSales(perCompetitor);
  if (!curve.sizes.length) return { ...base, ...curve, diag: { ...diag, reason: curve.oneSizeCount ? 'all-one-size' : 'empty' } };
  return { ...base, ...curve, nmCount: perCompetitor.length, diag: { ...diag, reason: 'ok' } };
}

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
  'длинн', 'рукав', 'корот', 'безру', 'ворот', 'модел', 'фасон', 'застё', 'застеж', 'пугов',
  'одежд', 'магаз', 'бренд', 'новин', 'модна', 'модны', 'стиль', 'krasi', 'kruto',
  'хлопк', 'хлопо', 'котон', 'ткань', 'однот', 'цвет']);

// Нишевый корень: 4 символа — ловит все словоформы («муслин/муслина/муслиновая»→«мусл»,
// «марлевка/марлевки»→«марл»). Короче 4 не режем (чтобы «лён» и т.п. не давали ложных).
const nicheCore = (w) => { const s = String(w).toLowerCase().replace(/ё/g, 'е').trim(); return s.length >= 4 ? s.slice(0, 4) : s; };

// Нишевые ключи. Если задано нишевое слово (nicheWords) — берём ТОЛЬКО его (надёжно, без
// угадывания). Иначе выводим из фраз: значимые слова без общих категорийных/фасонных.
function nicheKeys(phrases, nicheWords = []) {
  const explicit = (nicheWords || []).map(nicheCore).filter((w) => w && w.length >= 4);
  if (explicit.length) return [...new Set(explicit)];
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
    // Самоочистка кэша старой схемы: если в сохранённых товарах нет поля color (кэш записан
    // до добавления цвета) — считаем промахом и перезапрашиваем (разово, +1 запрос на фразу).
    if (res && res.items && res.items.length && !('color' in res.items[0])) { res = null; }
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
  // ЦЕНА ПРОДАЖИ за последний год = МЕДИАНА, ВЗВЕШЕННАЯ ПО ШТУКАМ (цена, ниже которой продано
  // 50% годовых штук). Это цена, по которой реально ушёл товар: короткие малообъёмные скидки её
  // не двигают, а сильный продавец (много штук по полной) не занижается медианой по дням.
  // Плюс разброс priceLo..priceHi (мин/макс дневная цена за год) — для показа в ТОП-15.
  // Внимание: это ЦЕНА ПОКУПАТЕЛЯ (с СПП), как отдаёт MPStats.
  const lyCut0 = offsetDate(d2, -365);
  for (const it of all) {
    const gph = it.graph || [], rgph = it.revenueGraph || [];
    const days = [];
    for (let i = 0; i < periods.length; i++) { const u = gph[i] || 0; if (periods[i] > lyCut0 && u > 0) days.push({ pr: rgph[i] / u, u }); }
    if (days.length) {
      days.sort((a, b) => a.pr - b.pr);
      const totU = days.reduce((s, d) => s + d.u, 0);
      let cum = 0, med = days[days.length - 1].pr;
      for (const d of days) { cum += d.u; if (cum >= totU / 2) { med = d.pr; break; } }
      it.priceMed = Math.round(med);
      it.priceLo = Math.round(days[0].pr);
      it.priceHi = Math.round(days[days.length - 1].pr);
    } else { it.priceMed = it.price || 0; it.priceLo = it.price || 0; it.priceHi = it.price || 0; }
  }
  all = all.filter((it) => {
    const nm = lcName(it.name);
    if (mw.some((w) => nm.includes(w))) return false;
    if (priceMin != null && it.priceMed < priceMin) return false;   // по медианной цене
    if (priceMax != null && it.priceMed > priceMax) return false;
    if (minRevenuePerMonth != null && (it.revenue / windowMonths) < minRevenuePerMonth) return false;
    return true;
  });
  L(`Объединено по фразам: ${before} уник. товаров; после минус-слов/сегмента (по медианной цене)/выручки: ${all.length}.`);
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
    let sLY = 0, rLY = 0, aLY = 0; const gph = it.graph || [], rgph = it.revenueGraph || [];
    // activeDaysLY — дни за последний год, когда товар РЕАЛЬНО продавался (продажи > 0).
    // По ним считаем скорость в сезон, чтобы распроданные/новые товары не занижали уровень.
    for (let i = 0; i < periods.length; i++) { if (periods[i] > lyCut) { const s = gph[i] || 0; sLY += s; rLY += rgph[i] || 0; if (s > 0) aLY++; } }
    it.salesLY = sLY; it.revenueLY = rLY; it.activeDaysLY = aLY;
  }
  return { items: all, periods, requests, dailyLimit, windowMonths, total: before };
}

/**
 * Сбор аналогов для ПЛАНА. Итоговая выборка = товары с нишевым ключом в названии
 * (авто) + вручную одобренные «без ключа» (approvedIds, из «Предв. выбора»). Одобренные
 * берутся из той же выдачи SERP (без доп. запросов). Возвращает товары с дневными рядами.
 */
export async function collectSerpAll({ phrases = [], minusWords = [], priceMin, priceMax, minRevenuePerMonth, limit, gender = null, approvedIds = [], nicheWords = [], excludedIds = [] } = {}, d1, d2, log = null) {
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'сбор', msg }); };
  const g = await gatherSerp({ phrases, minusWords, priceMin, priceMax, minRevenuePerMonth, gender }, d1, d2, L);
  const keys = nicheKeys(phrases, nicheWords);
  const approved = new Set((approvedIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const excluded = new Set((excludedIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  L(`Нишевые ключи из фраз: [${keys.join(', ') || '—'}]. Одобрено вручную: ${approved.size}. Исключено вручную: ${excluded.size}.`);
  // (авто ключ в названии ∨ одобрено вручную) И НЕ исключено вручную (место освобождается → подтянется следующий)
  let all = g.items.filter((it) => (nameHasKey(it.name, keys) || approved.has(Number(it.wb))) && !excluded.has(Number(it.wb)));
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
export async function collectSerpCandidates({ phrases = [], minusWords = [], priceMin, priceMax, minRevenuePerMonth, gender = null, approvedIds = [], nicheWords = [], topN = 30 } = {}, d1, d2, log = null) {
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'кандидаты', msg }); };
  const g = await gatherSerp({ phrases, minusWords, priceMin, priceMax, minRevenuePerMonth, gender }, d1, d2, L);
  const keys = nicheKeys(phrases, nicheWords);
  const approved = new Set((approvedIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const noKey = g.items.filter((it) => !nameHasKey(it.name, keys));
  // Отбор — по ВЫРУЧКЕ за последний год, по убыванию (крупнейшие сверху).
  noKey.sort((a, b) => (b.revenueLY || 0) - (a.revenueLY || 0));
  const withKey = g.items.length - noKey.length;
  L(`Ключи [${keys.join(', ') || '—'}]: с ключом ${withKey}, без ключа ${noKey.length} → на отсмотр ТОП-${Math.min(topN, noKey.length)} по выручке за год (убыв.).`);
  const rows = noKey.slice(0, topN).map((it) => ({
    wb: it.wb, name: it.name, brand: it.brand, thumb: it.thumb,
    avgPrice: it.priceMed || (it.salesLY > 0 ? Math.round(it.revenueLY / it.salesLY) : it.price),
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
    wb: it.wb, name: it.name, brand: it.brand, color: it.color, price: it.price, priceMed: it.priceMed, priceLo: it.priceLo, priceHi: it.priceHi, thumb: it.thumb,
    salesLY: it.salesLY, revenueLY: it.revenueLY, activeDaysLY: it.activeDaysLY, balance: it.balance,
    daily: (it.dailyFull || []).filter((r) => inWin(r.date)),
  }));
  const groupDaily = buildGroupDailySeries(maybeOOS(perItem.map((p) => p.daily), oos));
  const perItemMeta = perItem.map((p) => {
    const daysN = p.daily.length;
    return {
      wb: p.wb, name: p.name, brand: p.brand, color: p.color, price: p.price, priceMed: p.priceMed, priceLo: p.priceLo, priceHi: p.priceHi, thumb: p.thumb,
      days: daysN, avgStock: 0, balance: p.balance || 0, // текущий остаток — для оборачиваемости
      unitsSold: p.daily.reduce((s, r) => s + (Number(r.sales) || 0), 0),
      revenue: p.daily.reduce((s, r) => s + (Number(r.revenue) || 0), 0),
      unitsSoldLY: p.salesLY || 0, revenueLY: p.revenueLY || 0, // за последний год — для витрины ТОП-15
      activeDaysLY: p.activeDaysLY || 0, // дни с продажами за последний год — для скорости в сезон
    };
  });
  // Медиана по МЕДИАННОЙ ЗА ГОД цене (priceMed), а не по текущей (final_price): устойчиво к
  // распродажам. Якорь = эта медиана (без авто-скидки; подрезание — настройка priceUndercut выше).
  const prices = all.items.map((it) => it.priceMed || it.price).filter((v) => v > 0).sort((a, b) => a - b);
  const medianPrice = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : 0;
  return {
    group: all.items.map((it) => ({ wb: it.wb, name: it.name, brand: it.brand, price: it.price, revenue: it.revenue, sales: it.sales, thumb: it.thumb })),
    groupDaily, perItemMeta,
    attributesFound: [],
    total: all.total, fetched: all.fetched, kept: all.kept,
    medianPrice, priceAnchor: medianPrice ? Math.round(medianPrice) : 0,
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

// Ценовые сегменты выборки по квартилям медианной цены за год (priceMed). Для каждого —
// число товаров и продажи/выручка/цена ТОП-3 этого сегмента. При заданной себестоимости
// (plan.cost) — грубая выгодность: viable 'ok' (цена > 1.6× себест.) | 'thin' (> себест.) | 'loss'.
function computePriceSegments(perItemMeta, plan) {
  const pm = (m) => m.priceMed || m.price || 0;
  const un = (m) => m.unitsSoldLY != null ? (m.unitsSoldLY || 0) : (m.unitsSold || 0);
  const rv = (m) => m.revenueLY != null ? (m.revenueLY || 0) : (m.revenue || 0);
  const items = (perItemMeta || []).filter((m) => m.days > 0 && pm(m) > 0 && un(m) > 0);
  if (items.length < 4) return null;
  const prices = items.map(pm).sort((a, b) => a - b);
  const q = (p) => prices[Math.floor(p * (prices.length - 1))];
  const q25 = q(0.25), q50 = q(0.5), q75 = q(0.75);
  const cost = Number(plan.cost) > 0 ? Number(plan.cost) : null;
  const spp = Math.min(90, Math.max(0, Number(plan.spp) || 0));
  const kSpp = 1 - spp / 100;                    // цена покупателя = бухгалтерская × kSpp
  const mLo = Number(plan.markupMin) > 0 ? Number(plan.markupMin) : 0; // целевая наценка (мин)
  const defs = [
    { key: 'cheap', name: 'Дешёвый', lo: 0, hi: q25 },
    { key: 'mid', name: 'Средний', lo: q25, hi: q50 },
    { key: 'high', name: 'Высокий', lo: q50, hi: q75 },
    { key: 'premium', name: 'Премиум', lo: q75, hi: Infinity },
  ];
  const bands = defs.map((d) => {
    const seg = items.filter((m) => { const p = pm(m); return p >= d.lo && p < d.hi; }).sort((a, b) => rv(b) - rv(a));
    const n = Math.min(3, seg.length);
    const avg = (f) => n ? Math.round(seg.slice(0, 3).reduce((s, m) => s + f(m), 0) / n) : 0;
    const avgPrice = avg(pm); // цена покупателя (с СПП), как в MPStats
    // Наша БУХГАЛТЕРСКАЯ цена, если встать в этот сегмент = цена покупателя / (1−СПП).
    // Выгодность — по наценке этой цены к себестоимости (грубо, без полного юнита).
    let accounting = null, markup = null, viable = null;
    if (cost && avgPrice > 0) {
      accounting = Math.round(avgPrice / (kSpp || 1));
      markup = Math.round(accounting / cost * 100) / 100;
      const okT = mLo > 0 ? mLo : 3.5; // целевая наценка, или 3.5× по умолчанию (покрыть ВБ+маржа)
      viable = accounting <= cost ? 'loss' : (markup >= okT ? 'ok' : 'thin');
    }
    return { key: d.key, name: d.name, lo: Math.round(d.lo), hi: d.hi === Infinity ? null : Math.round(d.hi), count: seg.length, top3Units: avg(un), top3Rev: avg(rv), avgPrice, accounting, markup, viable };
  });
  return { thresholds: { q25, q50, q75 }, bands, cost, spp, active: 'auto' };
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
  let collected = await collectShape(d1, d2); // история (2 года)
  requests += collected.requests || 0;

  // ── ЦЕНОВЫЕ СЕГМЕНТЫ + ЦЕЛЕВОЕ ОКНО ОТ СЕБЕСТОИМОСТИ ──
  // Сегменты (квартили priceMed) считаем по ПОЛНОЙ выборке — как карта рынка. Целевое окно
  // подбора конкурентов:
  //   • приоритет — ОТ СЕБЕСТОИМОСТИ: [себест×наценкаОт, себест×наценкаДо] × (1−СПП) → цена
  //     покупателя (её отдаёт MPStats). Так экономика задаёт, каких конкурентов брать.
  //   • иначе — выбранный квартиль (plan.priceSegment).
  // На конкурентах окна и строим объём/цену/ранг/ТОП-15. Из кэша SERP — без доп. запросов.
  let segmentsInfo = null;
  if (subject && subject.serp && _serpAll) {
    segmentsInfo = computePriceSegments(collected.perItemMeta, plan);
    const kSpp = 1 - Math.min(0.9, Math.max(0, (Number(plan.spp) || 0) / 100));
    const cost = Number(plan.cost) || 0, mLo = Number(plan.markupMin) || 0, mHi = Number(plan.markupMax) || 0;
    // Приоритет: ЯВНО выбранный сегмент (Дешёвый/…/Премиум) переопределяет окно от
    // себестоимости. «Авто» → окно от себестоимости (если задана), иначе вся выборка.
    let band = null, activeKey = null;
    if (segmentsInfo && plan.priceSegment && plan.priceSegment !== 'auto') {
      const b = segmentsInfo.bands.find((x) => x.key === plan.priceSegment);
      if (b && b.count > 0) { band = { lo: b.lo, hi: b.hi == null ? Infinity : b.hi }; activeKey = plan.priceSegment; }
    } else if (cost > 0 && mLo > 0 && mHi > 0) {
      band = { lo: cost * Math.min(mLo, mHi) * kSpp, hi: cost * Math.max(mLo, mHi) * kSpp };
      activeKey = 'cost';
    }
    if (band && segmentsInfo) {
      const hi = band.hi == null ? Infinity : band.hi;
      const kept = _serpAll.items.filter((it) => { const p = it.priceMed || it.price || 0; return p >= band.lo && p < hi; });
      if (kept.length > 0) {
        _serpAll.items = kept;
        collected = await collectShape(d1, d2); // пересобрать выборку на целевом окне
        segmentsInfo.active = activeKey;
        segmentsInfo.targetBand = { lo: Math.round(band.lo), hi: band.hi === Infinity ? null : Math.round(band.hi), source: activeKey === 'cost' ? 'от себестоимости' : (segmentsInfo.bands.find((x) => x.key === activeKey) || {}).name };
        LP(`Целевое окно цены покупателя ${Math.round(band.lo)}–${band.hi === Infinity ? '∞' : Math.round(band.hi)} ₽ (${activeKey === 'cost' ? 'от себестоимости×наценка×СПП' : 'сегмент'}): в выборке ${kept.length} конкурентов.`);
      } else {
        LP(`Целевое окно цены дало 0 конкурентов — оставляю полную выборку. Проверь себестоимость/наценку/СПП.`);
      }
    }
  }
  const method = collected.method;
  const groupInfo = subject
    ? { path: subject.path, total: collected.total, fetched: collected.fetched, kept: collected.kept, truncated: collected.truncated, maxPages: collected.maxPages, deepMatch: collected.deepMatch, cardsEnriched: collected.cardsEnriched }
    : path ? { path, total: collected.total, fetched: collected.fetched, kept: collected.kept } : null;

  const { groupDaily, perItemMeta, dailyLimit } = collected;
  // Доли спроса по цветам (нормализованные + сырые) из финальной выборки — для мини-инструмента
  // «Размеры и цвета». Из уже собранных данных (color в serp), без доп. запросов.
  const colorAnalysis = computeColorShares(perItemMeta);
  // Размерный спрос из MPStats sales/sizes по строгому ТОП-N конкурентов (cache-first, TTL,
  // квота-гард). Отключается plan.withSizes=false. Объект с diag даже при пустоте.
  const sizeAnalysis = await gatherSizeCurve(perItemMeta, {
    d1, d2, topN: Number(plan.sizeTopN) || 10, enabled: plan.withSizes !== false,
  });
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
    // Скорость аналога в сезон = продажи за ПОСЛЕДНИЙ ГОД ÷ дни, когда он РЕАЛЬНО продавался
    // (activeDaysLY), а не ÷ всё двухлетнее окно. Иначе распроданные и «молодые» бестселлеры
    // (нули за дни без наличия/до старта) занижают уровень, а с ним — весь прогноз.
    // Если LY-метрик нет (старый источник данных) — прежняя логика unitsSold/days за окно.
    const speed = (m) => (m.activeDaysLY > 0) ? (m.unitsSoldLY / m.activeDaysLY) : (m.days > 0 ? m.unitsSold / m.days : 0);
    const rev = (m) => (m.revenueLY ?? m.revenue) || 0;
    const units = (m) => (m.unitsSoldLY ?? m.unitsSold) || 0;
    // «ТОП-3/ТОП-1» — САМЫЕ КРУПНЫЕ по выручке за год (реальные лидеры рынка), а не самые
    // «быстрые за активный день»: иначе товар, что был в продаже 2 месяца, но продавался
    // бойко, ложно попадал бы в тройку. Берём лидеров по выручке → их скорость в сезон.
    const leaders = (perItemMeta || []).filter((m) => (m.activeDaysLY || 0) > 0 || m.days > 0)
      .sort((a, b) => rev(b) - rev(a) || units(b) - units(a));
    const top3arr = leaders.slice(0, 3).map(speed).filter((v) => v > 0);
    const top3Daily = top3arr.length ? top3arr.reduce((s, v) => s + v, 0) / top3arr.length : perItemBase;
    const strongest = leaders[0];
    const top1Daily = strongest ? (speed(strongest) || perItemBase) : perItemBase;
    const targetLevel = plan.targetLevel === 'top1' ? 'top1' : 'top3';
    const targetDaily = targetLevel === 'top1' ? top1Daily : top3Daily;

    // Подрезание цены под медиану сегмента: priceUndercut (0..0.5), по умолчанию 0 (без скидки).
    const undercut = Math.max(0, Math.min(0.5, Number(plan.priceUndercut) || 0));
    const priceAnchorUsed = Math.round((collected.priceAnchor || 0) * (1 - undercut));
    const fc = buildForecast({
      history: groupDaily,
      recent60: recentCol.groupDaily,
      prior60: priorCol.groupDaily,
      baseDaily,
      top3Daily: targetDaily,
      targetYear: forecast.targetYear,
      opts: { ...plan, baseSource: baseInfo.source, priceAnchor: priceAnchorUsed },
    });
    fc.priceInfo = { anchor: priceAnchorUsed, medianPrice: collected.medianPrice, undercut };

    // ── ОБЪЁМ плана = фактические продажи ТОП-1/ТОП-3 за АНАЛОГИЧНЫЙ период ──
    // Синтетическая кривая задаёт ФОРМУ сезона (разгон/пик/распродажа), но её ИТОГ прибиваем
    // к реальности: сколько лидер(ы) финальной выборки реально продали за ТО ЖЕ сезонное окно
    // в последнем ПОЛНОМ году. Точнее и без переоценки синтетическим пиком; ТОП-1 — амбициознее.
    let seasonTargets = null;
    try {
      const fp = fc.forecastPeriod;
      const pad = (n) => String(n).padStart(2, '0');
      const shiftY = (ymd, k) => { const [y, m, dd] = ymd.split('-').map(Number); return `${y - k}-${pad(m)}-${pad(dd)}`; };
      let ky = 1; while (ky < 6 && shiftY(fp.to, ky) > d2) ky++; // последнее ПОЛНОЕ окно (конец ≤ конца истории)
      let aFrom = shiftY(fp.from, ky); const aTo = shiftY(fp.to, ky);
      if (aFrom < d1) aFrom = d1;                               // не вылезаем за собранную историю
      const analog = await collectShape(aFrom, aTo);            // из кэша SERP — без доп. запросов
      const lead = (analog.perItemMeta || []).filter((m) => m.days > 0).sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
      const t1 = lead[0] ? Math.round(lead[0].unitsSold) : 0;
      const t3 = lead.length ? Math.round(lead.slice(0, 3).reduce((s, m) => s + m.unitsSold, 0) / Math.min(3, lead.length)) : 0;

      // ── ПРОЕКЦИЯ РОСТА на прогнозный год ──
      // Измеряем рост «год к году» на одном и том же окне двух свежих лет (оба в данных) и
      // компаундируем на нужное число лет. Режимы (growthMode):
      //   'cohort' — по ОДНИМ И ТЕМ ЖЕ товарам оба года (без новичков) → рост КАРТОЧКИ (реалистично);
      //   'market' — весь рынок с новичками (агрессивно, завышает);
      //   'none'   — без проекции.
      // По умолчанию: круглогодичный → cohort, сезонный → market. Ручной коэффициент
      // plan.growthManual (годовой) перекрывает измерение. Измеренное — зажато [0.5,2.0], ручное [0.5,3.0].
      const allSeasonMode = plan.articleType === 'allseason';
      const growthMode = plan.growthMode || (allSeasonMode ? 'cohort' : 'market');
      const manual = Number(plan.growthManual);
      const sumUnits = (col) => (col.perItemMeta || []).filter((m) => m.days > 0).reduce((s, m) => s + (m.unitsSold || 0), 0);
      const growYears = plan.growthYears != null ? Number(plan.growthYears) : ky;
      let gYoY = 1, growthYears = 0, growthClamped = false, growthMeasured = null;
      if (Number.isFinite(manual) && manual > 0) {
        const gc = Math.max(0.5, Math.min(3.0, manual)); growthClamped = gc !== manual; gYoY = gc; growthYears = growYears;
      } else if (growthMode !== 'none') {
        let rStart, rEnd, pStart, pEnd;
        if (allSeasonMode) { rStart = aFrom; rEnd = aTo; pStart = shiftY(aFrom, 1); pEnd = shiftY(aTo, 1); }
        else { rStart = shiftY(fp.from, ky - 1); rEnd = shiftY(fp.to, ky - 1); if (rEnd > d2) rEnd = d2; pStart = shiftY(rStart, 1); pEnd = shiftY(rEnd, 1); }
        if (pStart >= d1 && rEnd > rStart) {
          const recentM = await collectShape(rStart, rEnd);
          const priorM = await collectShape(pStart, pEnd);
          let raw = null;
          if (growthMode === 'cohort') {
            // одни и те же товары в оба окна (units>0) → рост карточки, без новичков рынка
            const pm = new Map(); (priorM.perItemMeta || []).forEach((m) => { if (m.days > 0 && m.unitsSold > 0) pm.set(Number(m.wb), m.unitsSold); });
            let cr = 0, cp = 0;
            (recentM.perItemMeta || []).forEach((m) => { const p = pm.get(Number(m.wb)); if (p && m.unitsSold > 0) { cr += m.unitsSold; cp += p; } });
            if (cp > 0 && cr > 0) raw = cr / cp;
          } else {
            const ru = sumUnits(recentM), pu = sumUnits(priorM);
            if (pu > 0 && ru > 0) raw = ru / pu;
          }
          if (raw != null) { const gc = Math.max(0.5, Math.min(2.0, raw)); growthClamped = gc !== raw; gYoY = gc; growthYears = growYears; growthMeasured = Math.round(raw * 100) / 100; }
        }
      }
      const growthFactor = Math.pow(gYoY, growthYears);
      const t1p = Math.round(t1 * growthFactor), t3p = Math.round(t3 * growthFactor);
      const curTotal = (fc.forecastDaily || []).reduce((s, r) => s + (Number(r.plannedOrders) || 0), 0);

      if (allSeasonMode) {
        // ── ОБЪЁМ ПОМЕСЯЧНО ── у круглогодичного товара лидеры МЕНЯЮТСЯ от месяца к месяцу
        // (летом одни, зимой другие), поэтому фикс. годовая тройка занижает межсезонье. Для
        // каждого календарного месяца берём СВОЙ топ-3/топ-1 (самый свежий полный месяц в
        // данных) → месячная цель. Годовой объём = сумма 12 целей × рост. План масштабируем
        // помесячно под эти цели; дни внутри месяца — по рельефу (мини-сезоны сохраняются).
        const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
        const monthWindow = (m) => {
          for (let y = Number(d2.slice(0, 4)); y >= Number(d1.slice(0, 4)); y--) {
            const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-${pad(lastDay(y, m))}`;
            if (from >= d1 && to <= d2) return { from, to };
          }
          return null;
        };
        const mt1 = {}, mt3 = {};
        for (let m = 1; m <= 12; m++) {
          const w = monthWindow(m); if (!w) { mt1[m] = 0; mt3[m] = 0; continue; }
          const col = await collectShape(w.from, w.to); // из кэша SERP
          const ld = (col.perItemMeta || []).filter((x) => x.days > 0).sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
          mt1[m] = ld[0] ? Math.round(ld[0].unitsSold) : 0;
          mt3[m] = ld.length ? Math.round(ld.slice(0, 3).reduce((s, x) => s + x.unitsSold, 0) / Math.min(3, ld.length)) : 0;
        }
        const mt = targetLevel === 'top1' ? mt1 : mt3;
        const monthTargetGrown = {}; for (let m = 1; m <= 12; m++) monthTargetGrown[m] = Math.round((mt[m] || 0) * growthFactor);

        // масштабируем каждый прогнозный месяц под свою цель (неполный месяц — пропорционально)
        const byFM = {}; for (const r of (fc.forecastDaily || [])) { const fm = r.date.slice(0, 7); (byFM[fm] = byFM[fm] || []).push(r); }
        const factorByFM = {};
        for (const fm of Object.keys(byFM)) {
          const rows = byFM[fm], mnum = Number(fm.slice(5, 7)), full = lastDay(Number(fm.slice(0, 4)), mnum);
          const curSum = rows.reduce((s, r) => s + (Number(r.plannedOrders) || 0), 0);
          const targetSum = (monthTargetGrown[mnum] || 0) * (rows.length / full);
          const f = curSum > 0 ? targetSum / curSum : 0;
          factorByFM[fm] = f;
          for (const r of rows) r.plannedOrders = round1(r.plannedOrders * f);
        }
        if (Array.isArray(fc.deliveries)) fc.deliveries = fc.deliveries.map((d) => ({ ...d, qty: Math.round(d.qty * (factorByFM[d.month] != null ? factorByFM[d.month] : 1)) }));
        // склад-пила заново после помесячного масштаба (стабильно >0, не обнуляем)
        const delByDate = {}; for (const d of (fc.deliveries || [])) delByDate[d.date] = (delByDate[d.date] || 0) + d.qty;
        let lvl = 0;
        for (const r of (fc.forecastDaily || [])) { lvl += (delByDate[r.date] || 0); lvl -= (Number(r.plannedOrders) || 0); r.stock = Math.max(0, Math.round(lvl)); }
        const usedTotal = (fc.forecastDaily || []).reduce((s, r) => s + (Number(r.plannedOrders) || 0), 0);
        fc.totalUnits = Math.round(usedTotal);
        fc.top3PeakDaily = Math.round(Math.max(...(fc.forecastDaily || []).map((r) => Number(r.plannedOrders) || 0), 0));
        seasonTargets = {
          mode: 'allseason-monthly', window: { from: aFrom, to: aTo }, yearsBack: ky, top1Units: t1, top3Units: t3,
          growthMode, growthYoY: Math.round(gYoY * 100) / 100, growthYears, growthFactor: Math.round(growthFactor * 100) / 100, growthClamped,
          growthMeasured, growthManual: (Number.isFinite(manual) && manual > 0) ? manual : null,
          monthlyTargets: monthTargetGrown, used: Math.round(usedTotal), curveTotalBefore: Math.round(curTotal),
        };
      } else {
        const targetTotal = targetLevel === 'top1' ? t1p : t3p;
        seasonTargets = {
          window: { from: aFrom, to: aTo }, yearsBack: ky, top1Units: t1, top3Units: t3,
          growthMode, growthYoY: Math.round(gYoY * 100) / 100, growthYears, growthFactor: Math.round(growthFactor * 100) / 100, growthClamped,
          growthMeasured, growthManual: (Number.isFinite(manual) && manual > 0) ? manual : null,
          top1Projected: t1p, top3Projected: t3p, used: targetTotal, curveTotalBefore: Math.round(curTotal),
        };
        if (targetTotal > 0 && curTotal > 0) {
          const factor = targetTotal / curTotal; // множитель формы, чтобы итог = спрогнозированному объёму
          for (const r of fc.forecastDaily) { r.plannedOrders = round1(r.plannedOrders * factor); r.stock = Math.round((Number(r.stock) || 0) * factor); }
          if (Array.isArray(fc.deliveries)) fc.deliveries = fc.deliveries.map((d) => ({ ...d, qty: Math.round(d.qty * factor) }));
          fc.totalUnits = Math.round(curTotal * factor);
          if (fc.top3PeakDaily != null) fc.top3PeakDaily = Math.round(fc.top3PeakDaily * factor);
        }
      }
    } catch (e) { LP(`Не удалось привязать объём к аналогичному периоду: ${String(e.message || e)}.`); }

    fc.levelInfo = {
      targetLevel,
      top1Daily: Math.round(top1Daily * 10) / 10,
      top3Daily: Math.round(top3Daily * 10) / 10,
      top1Name: strongest ? strongest.name : null,
      seasonTargets, // фактический объём ТОП-1/ТОП-3 за аналог. период — база «Выкупов»
    };
    const rk = fc.plan && fc.plan.rank;
    const usedTot = seasonTargets ? seasonTargets.used : null;
    LP(`Прогноз построен: ранг ${rk ? (rk.rank ?? '—') : '—'}, уровень ${targetLevel === 'top1' ? 'ТОП-1' : 'ТОП-3'}${usedTot ? `, объём ${usedTot} шт по аналог. периоду ${seasonTargets.window.from}…${seasonTargets.window.to}` : ` (${Math.round(targetDaily)} шт/день)`}, период прогноза ${fc.forecastPeriod ? fc.forecastPeriod.from + '…' + fc.forecastPeriod.to : '—'}.`);

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
      segments: segmentsInfo,
      colorAnalysis,
      sizeAnalysis,
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
    segments: segmentsInfo,
    colorAnalysis,
    sizeAnalysis,
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
