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

const lc = (s) => String(s ?? '').toLowerCase();

// Лёгкий стем русского слова: срезаем распространённое окончание, чтобы «клетка»
// матчила «в клетку», «лето» — «летняя» и т.п. (учёт словоформ).
const RU_ENDINGS = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ью', 'ья', 'ье', 'ем', 'ом', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'й', 'ь'];
function stem(word) {
  let w = lc(word).trim();
  for (const e of RU_ENDINGS) {
    if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, w.length - e.length);
  }
  return w;
}
const stems = (arr) => (arr || []).map(stem).filter(Boolean);
const hasStem = (text, stemList) => stemList.some((s) => text.includes(s));

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
  const soft = stems([...(f.words || []), ...(f.allWords || [])]);
  const exclude = stems(f.exclude);
  const brands = stems(f.brands);
  const excludeBrands = stems(f.excludeBrands);
  const months = f.windowMonths || 1;
  const minSales = f.minSalesPerMonth != null ? f.minSalesPerMonth * months : null;
  const minRev = f.minRevenuePerMonth != null ? f.minRevenuePerMonth * months : null;
  // Обратная совместимость: старый minSales (за окно, не за месяц).
  const minSalesAbs = f.minSales != null ? f.minSales : null;

  const out = [];
  for (const it of items) {
    const name = lc(it.name);
    const brand = lc(it.brand);
    if (f.priceMin != null && it.price < f.priceMin) continue;
    if (f.priceMax != null && it.price > f.priceMax) continue;
    if (exclude.length && hasStem(name, exclude)) continue;
    if (brands.length && !hasStem(brand, brands)) continue;
    if (excludeBrands.length && hasStem(brand, excludeBrands)) continue;
    // Живость: проходит, если ЛИБО продажи/мес ≥ порога, ЛИБО выручка/мес ≥ порога.
    if (minSales != null || minRev != null) {
      const okSales = minSales != null && it.sales >= minSales;
      const okRev = minRev != null && it.revenue >= minRev;
      if (!(okSales || okRev)) continue;
    }
    if (minSalesAbs != null && it.sales < minSalesAbs) continue;
    it._relevance = soft.length ? soft.filter((s) => name.includes(s)).length : 0;
    out.push(it);
  }
  return out;
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
} = {}) {
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
  const raw = [];
  let total = Infinity;
  let requests = 0;
  let dailyLimit = null;

  for (let startRow = 0; startRow < total && requests < maxPages; startRow += pageSize) {
    let res;
    try {
      res = await fetchCategoryItems({ path, d1, d2, startRow, endRow: startRow + pageSize });
    } catch (err) {
      if (err?.dailyLimit) { dailyLimit = String(err?.message || err); break; }
      throw err;
    }
    requests += 1;
    total = res.total || res.data.length;
    const matchedBefore = wbSet ? raw.filter((r) => wbSet.has(String(r.id ?? r.nmId))).length : 0;
    raw.push(...res.data);
    if (res.data.length < pageSize) break;
    // Ранняя остановка — не тянем лишние страницы (экономия лимита и трафика):
    if (wbSet) {
      const matched = raw.filter((r) => wbSet.has(String(r.id ?? r.nmId))).length;
      // Режим A: нашли все нужные WB — либо страница не добавила ни одного нового
      // (остальные, вероятно, архивные и в предмете отсутствуют).
      if (matched >= wbSet.size || matched === matchedBefore) break;
    } else {
      // Режим B: набрали достаточно РЕЛЕВАНТНЫХ аналогов. Со «мягкими» словами
      // считаем товары с совпадением стема (_relevance>0); без слов — просто
      // прошедшие жёсткие фильтры.
      const target = limit || 60;
      const passed = filterGroupItems(
        raw.map((r) => normalizeCategoryItem(r)).filter((it) => it.wb != null),
        fWin
      );
      const kept = hasSoft ? passed.filter((it) => it._relevance > 0).length : passed.length;
      if (kept >= target) break;
    }
  }

  let items = raw
    .map((r) => ({ ...normalizeCategoryItem(r), _raw: r }))
    .filter((it) => it.wb != null);
  items = wbSet
    ? items.filter((it) => wbSet.has(String(it.wb)))
    : filterGroupItems(items, fWin);
  // Сортировка (Правило п.3): релевантность → ОБЪЁМ ПРОДАЖ ↓ → ЦЕНА ↓.
  items.sort((a, b) =>
    (b._relevance || 0) - (a._relevance || 0) ||
    (b.sales || 0) - (a.sales || 0) ||
    (b.price || 0) - (a.price || 0));
  const keptBeforeLimit = items.length;
  if (limit && items.length > limit) items = items.slice(0, limit);

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
    daily: extractItemDailyFromGraphs(it._raw, d1, d2),
  }));
  const groupDaily = buildGroupDailySeries(maybeOOS(perItem.map((p) => p.daily), oos));
  const perItemMeta = perItem.map((p) => ({
    wb: p.wb,
    name: p.name,
    days: p.daily.length,
    unitsSold: p.daily.reduce((s, r) => s + (Number(r.sales) || 0), 0),
  }));

  return {
    group: items.map(({ _raw, ...g }) => g),
    groupDaily,
    perItemMeta,
    total: Number.isFinite(total) ? total : raw.length,
    fetched: raw.length,
    kept: keptBeforeLimit,
    requests,
    truncated,
    maxPages,
    dailyLimit,
    medianPrice,
    priceAnchor: priceAnchorBelowMedian, // конкурентная цена: медиана −10%
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
} = {}) {
  const oos = !!plan.oos;

  // Замыкание: собрать «форму» (аналоги/группу) за произвольное окно тем же источником.
  const collectShape = async (w1, w2) => {
    if (subject) {
      return { method: 'category-bulk', ...(await collectFromCategory({ path: subject.path, d1: w1, d2: w2, filter: subject.filter || {}, limit: subject.limit, maxPages: subject.maxPages, oos })) };
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
    ? { path: subject.path, total: collected.total, fetched: collected.fetched, kept: collected.kept, truncated: collected.truncated, maxPages: collected.maxPages }
    : path ? { path, total: collected.total, fetched: collected.fetched, kept: collected.kept } : null;

  const { groupDaily, perItemMeta, dailyLimit } = collected;
  const errors = collected.errors || [];

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

    // Уровень ТОП-3 (целевой пик): средняя дневных продаж трёх сильнейших аналогов.
    const perAnalogDaily = (perItemMeta || []).filter((m) => m.days > 0).map((m) => m.unitsSold / m.days).sort((a, b) => b - a);
    const top3Daily = perAnalogDaily.length
      ? perAnalogDaily.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, perAnalogDaily.length)
      : perItemBase;

    const fc = buildForecast({
      history: groupDaily,
      recent60: recentCol.groupDaily,
      prior60: priorCol.groupDaily,
      baseDaily,
      top3Daily,
      targetYear: forecast.targetYear,
      opts: { ...plan, baseSource: baseInfo.source, priceAnchor: collected.priceAnchor },
    });
    fc.priceInfo = { anchor: collected.priceAnchor, medianPrice: collected.medianPrice };

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
      groupSize: perItemMeta.length,
      itemsWithData: perItemMeta.filter((m) => m.days > 0).length,
      perItem: perItemMeta,
      plan: fc,
      errors,
      dailyLimit,
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
    plan: seasonPlan,
    errors,
    dailyLimit,
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
