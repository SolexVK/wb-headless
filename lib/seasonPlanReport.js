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
  oos = false,
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
  concurrency = 5,
  onProgress,
} = {}) {
  const oos = !!plan.oos;
  let groupInfo = null;
  let method;
  let requests = 0;
  let collected;

  // ── ФОРМА сезона — группа-аналогов (или явная группа) ──
  if (subject) {
    method = 'category-bulk';
    collected = await collectFromCategory({
      path: subject.path, d1, d2, filter: subject.filter || {},
      limit: subject.limit, maxPages: subject.maxPages, oos,
    });
    groupInfo = { path: subject.path, total: collected.total, fetched: collected.fetched, kept: collected.kept, truncated: collected.truncated, maxPages: collected.maxPages };
    requests = collected.requests;
  } else if (group && path) {
    method = 'category-bulk';
    const wbSet = new Set(group.map((g) => String(g.wb ?? g)));
    collected = await collectFromCategory({ path, d1, d2, wbSet, oos });
    groupInfo = { path, total: collected.total, fetched: collected.fetched, kept: collected.kept, requested: wbSet.size };
    requests = collected.requests;
  } else if (group && group.length) {
    method = 'per-sku';
    const res = await collectGroupDaily({ group, d1, d2, concurrency, onProgress, oos });
    collected = { ...res, group };
    requests = group.length;
  } else {
    throw new Error('Пустая группа: задайте group (список WB) или subject (path+filter).');
  }

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
    const weak = ownBase.days < weakDays || ownBase.base <= 0;
    if (!weak) {
      baseDailyOverride = ownBase.base;
      baseInfo = { source: 'own', ownBaseDaily: round1(ownBase.base), ownActiveDays: ownBase.days, ownSkuCount: skuCount };
    } else {
      // Слабая/нет своей базы → оценка по конкурентам: средний аналог на товар ×
      // число своих SKU × коэффициент (по умолчанию 0.9).
      const factor = plan.competitorFactor ?? 0.9;
      const perAnalog = shapeBase.base / analogCount;
      baseDailyOverride = perAnalog * skuCount * factor;
      baseInfo = {
        source: 'competitor', reason: ownBase.days < weakDays ? `своих данных мало (${ownBase.days} дн.)` : 'своих продаж нет',
        competitorPerItemDaily: round1(perAnalog), ownSkuCount: skuCount, factor,
        estimatedBaseDaily: round1(baseDailyOverride), ownActiveDays: ownBase.days,
      };
    }
  }

  const planOpts = { ...plan, baseSource: baseInfo.source };
  if (baseDailyOverride != null) planOpts.baseDailyOverride = baseDailyOverride;
  const seasonPlan = groupDaily.length > 0 ? buildSeasonPlan(groupDaily, planOpts) : null;

  return {
    label,
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

const CSV_COLUMNS = [
  ['date', 'Дата (история)'],
  ['dateNext', 'Дата (план +1 год)'],
  ['kSales', 'k продаж'],
  ['kStock', 'k остатков'],
  ['kPrice', 'k цены'],
  ['weekdayFactor', 'k дня недели'],
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
