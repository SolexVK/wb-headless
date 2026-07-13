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
 * Собирает группу-эталон из выдачи по предмету (path) с фильтрацией.
 * @returns {Promise<{group, total, kept}>} — group: [{wb, name, ...}].
 */
export async function buildGroupFromSubject({ path, d1, d2, filter = {}, limit } = {}) {
  const { total, data } = await fetchCategoryItems({ path, d1, d2 });
  const all = data.map(normalizeCategoryItem).filter((it) => it.wb != null);
  let group = filterGroupItems(all, filter);
  if (limit && group.length > limit) group = group.slice(0, limit); // топ по выручке (сортировка сервера)
  return { group, total, fetched: all.length, kept: group.length };
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
 * Источник группы: либо explicit `group` (список WB), либо `subject` (path+filter).
 * @param {object} p
 * @param {string} p.d1, p.d2 — период истории (обычно тот же сезон год назад).
 * @param {Array}  [p.group] — явный список WB (напр. из config/groups.json).
 * @param {string} [p.label] — метка линейки/группы для вывода.
 * @param {object} [p.subject] — {path, filter, limit} для сборки из предмета.
 * @param {object} [p.plan] — опции ядра (targetPeriodUnits, ambition, minPrice, пороги).
 */
export async function buildSeasonPlanReport({
  d1,
  d2,
  group,
  label = '',
  subject,
  plan = {},
  concurrency = 5,
  onProgress,
} = {}) {
  let sourceGroup = group;
  let groupInfo = null;

  if (!sourceGroup && subject) {
    const built = await buildGroupFromSubject({
      path: subject.path,
      d1,
      d2,
      filter: subject.filter || {},
      limit: subject.limit,
    });
    sourceGroup = built.group;
    groupInfo = { path: subject.path, total: built.total, fetched: built.fetched, kept: built.kept };
  }

  if (!sourceGroup || sourceGroup.length === 0) {
    throw new Error('Пустая группа: задайте group (список WB) или subject (path+filter).');
  }

  const { groupDaily, perItemMeta, errors, dailyLimit } = await collectGroupDaily({
    group: sourceGroup,
    d1,
    d2,
    concurrency,
    onProgress,
  });

  const seasonPlan =
    groupDaily.length > 0 ? buildSeasonPlan(groupDaily, plan) : null;

  return {
    label,
    period: { d1, d2 },
    generatedAt: new Date().toISOString(),
    groupInfo,
    groupSize: sourceGroup.length,
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
