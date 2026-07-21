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
import { buildGroupDailySeries, buildSeasonPlan } from './salesPlan.js';

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

/**
 * Детальная фильтрация выдачи по предмету до релевантных аналогов.
 * @param items — [{wb, name, brand, seller, price, sales, ...}] (normalizeCategoryItem).
 * @param f — {
 *   words?: string[],     // оставить, если имя содержит ЛЮБОЕ из слов
 *   allWords?: string[],  // оставить, если имя содержит ВСЕ слова
 *   exclude?: string[],   // выкинуть, если имя содержит любое из слов
 *   priceMin?, priceMax?, // ценовой коридор нашего сегмента
 *   minSales?,            // отсечь почти мёртвые карточки
 *   brands?: string[],    // оставить только эти бренды
 *   excludeBrands?: string[],
 * }
 */
export function filterGroupItems(items, f = {}) {
  const words = (f.words || []).map(lc);
  const allWords = (f.allWords || []).map(lc);
  const exclude = (f.exclude || []).map(lc);
  const brands = (f.brands || []).map(lc);
  const excludeBrands = (f.excludeBrands || []).map(lc);

  return items.filter((it) => {
    const name = lc(it.name);
    if (words.length && !words.some((w) => name.includes(w))) return false;
    if (allWords.length && !allWords.every((w) => name.includes(w))) return false;
    if (exclude.length && exclude.some((w) => name.includes(w))) return false;
    if (f.priceMin != null && it.price < f.priceMin) return false;
    if (f.priceMax != null && it.price > f.priceMax) return false;
    if (f.minSales != null && it.sales < f.minSales) return false;
    const brand = lc(it.brand);
    if (brands.length && !brands.includes(brand)) return false;
    if (excludeBrands.length && excludeBrands.includes(brand)) return false;
    return true;
  });
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
} = {}) {
  // Размер страницы: ответ несёт дневные графики по каждому товару (≈15 рядов ×
  // дни). При 5000 строках это сотни МБ и минуты загрузки. 1000 — компромисс:
  // грузится за ~секунды, а т.к. 1 запрос = 1 единица лимита, крупная страница
  // выгоднее многих мелких (меньше запросов при том же объёме данных).
  pageSize = pageSize || 1000;
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
      // Режим B: набрали достаточно отфильтрованных аналогов (страницы идут по
      // убыванию выручки, значит топ-N уже собран).
      const target = limit || 60;
      const kept = filterGroupItems(
        raw.map((r) => normalizeCategoryItem(r)).filter((it) => it.wb != null),
        filter
      ).length;
      if (kept >= target) break;
    }
  }

  let items = raw
    .map((r) => ({ ...normalizeCategoryItem(r), _raw: r }))
    .filter((it) => it.wb != null);
  items = wbSet
    ? items.filter((it) => wbSet.has(String(it.wb)))
    : filterGroupItems(items, filter);
  items.sort((a, b) => b.revenue - a.revenue);
  const keptBeforeLimit = items.length;
  if (limit && items.length > limit) items = items.slice(0, limit);

  // Дневные ряды из графиков — без единого доп. запроса.
  const perItem = items.map((it) => ({
    wb: it.wb,
    name: it.name,
    daily: extractItemDailyFromGraphs(it._raw, d1, d2),
  }));
  const groupDaily = buildGroupDailySeries(perItem.map((p) => p.daily));
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
    dailyLimit,
  };
}

/**
 * Тянет дневные ряды по списку SKU и агрегирует в дневной ряд группы.
 * @param group — [{wb, ...}] или [число].
 * @returns {Promise<{groupDaily, perItemMeta, errors, dailyLimit}>}
 */
export async function collectGroupDaily({ group, d1, d2, concurrency = 5, onProgress } = {}) {
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
  const groupDaily = buildGroupDailySeries(withData.map((p) => p.daily));
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
 * @param {object} [p.plan] — опции ядра.
 */
export async function buildSeasonPlanReport({
  d1,
  d2,
  group,
  path,
  label = '',
  subject,
  plan = {},
  concurrency = 5,
  onProgress,
} = {}) {
  let groupInfo = null;
  let method;
  let requests = 0;
  let collected;

  if (subject) {
    // Режим B — bulk по предмету с фильтром.
    method = 'category-bulk';
    collected = await collectFromCategory({
      path: subject.path,
      d1,
      d2,
      filter: subject.filter || {},
      limit: subject.limit,
    });
    groupInfo = { path: subject.path, total: collected.total, fetched: collected.fetched, kept: collected.kept };
    requests = collected.requests;
  } else if (group && path) {
    // Режим A по предмету — bulk + отбор по набору WB.
    method = 'category-bulk';
    const wbSet = new Set(group.map((g) => String(g.wb ?? g)));
    collected = await collectFromCategory({ path, d1, d2, wbSet });
    groupInfo = { path, total: collected.total, fetched: collected.fetched, kept: collected.kept, requested: wbSet.size };
    requests = collected.requests;
  } else if (group && group.length) {
    // Fallback — per-SKU (дорого по лимиту).
    method = 'per-sku';
    const res = await collectGroupDaily({ group, d1, d2, concurrency, onProgress });
    collected = { ...res, group };
    requests = group.length;
  } else {
    throw new Error('Пустая группа: задайте group (список WB) или subject (path+filter).');
  }

  const { groupDaily, perItemMeta, dailyLimit } = collected;
  const errors = collected.errors || [];
  const seasonPlan = groupDaily.length > 0 ? buildSeasonPlan(groupDaily, plan) : null;

  return {
    label,
    period: { d1, d2 },
    generatedAt: new Date().toISOString(),
    method, // 'category-bulk' (дёшево) | 'per-sku' (дорого)
    requests, // сколько запросов к MPStats потрачено
    groupInfo,
    groupSize: perItemMeta.length,
    itemsWithData: perItemMeta.filter((m) => m.days > 0).length,
    perItem: perItemMeta,
    plan: seasonPlan,
    errors,
    dailyLimit,
  };
}

const CSV_COLUMNS = [
  ['date', 'Дата (история)'],
  ['dateNext', 'Дата (план +1 год)'],
  ['kSales', 'k продаж'],
  ['kStock', 'k остатков'],
  ['kPrice', 'k цены'],
  ['plannedOrders', 'План заказов/день'],
];

/** Экспорт дневного плана в CSV (';' + BOM — дружелюбно к RU Excel). */
export function seasonPlanToCSV(report) {
  const sep = ';';
  const cell = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    return String(v);
  };
  const header = CSV_COLUMNS.map(([, t]) => t).join(sep);
  const rows = (report.plan?.daily || []).map((r) =>
    CSV_COLUMNS.map(([k]) => cell(r[k])).join(sep)
  );
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n';
}
