// lib/nicheReport.js — отчёт «Анализ ниши» (категории Wildberries).
//
// Что показывает и зачем: перед выходом в нишу продавцу важно понять её
// ёмкость и «проходимость». Из выгрузки товаров категории за период
// считаем агрегаты:
//   • ёмкость   — суммарная выручка и продажи ниши за период;
//   • спрос     — доля товаров с продажами (сколько карточек реально
//                 продаётся, а сколько «мёртвых»);
//   • конкуренция — сколько продавцов/брендов делят нишу;
//   • монополизация — какую долю выручки забирают топ-товары и топ-продавец
//                 (высокая доля = зайти новичку тяжело);
//   • экономика — средняя/медианная цена, средняя выручка на карточку.
//
// Данные берутся из MPSTATS (отчёт по категории, POST /wb/get/category).

import { fetchCategory } from './mpstats.js';

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

/** Медиана числового массива (не мутирует вход). */
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Строит отчёт по нише (категории) за период [d1, d2].
 * @returns {Promise<{categoryPath, period, generatedAt, totals, sellers, brands, items}>}
 */
export async function buildNicheReport({
  categoryPath,
  d1,
  d2,
  maxRows = 5000,
  pageSize = 500,
  topSellers = 15,
  onPage,
} = {}) {
  if (!categoryPath || !String(categoryPath).trim()) {
    throw new Error('Не задан путь категории (categoryPath).');
  }

  const { items: raw, total: productsInNiche, pages } = await fetchCategory(
    categoryPath,
    d1,
    d2,
    { maxRows, pageSize, onPage }
  );

  // Сортируем по выручке — верх ниши всегда первым (важно при усечении).
  const items = [...raw].sort((a, b) => b.revenue - a.revenue);

  const productsAnalyzed = items.length;
  const truncated = productsInNiche > productsAnalyzed;

  const withSales = items.filter((r) => r.units > 0 || r.revenue > 0);
  const totalRevenue = items.reduce((s, r) => s + r.revenue, 0);
  const totalUnits = items.reduce((s, r) => s + r.units, 0);

  // Уникальные продавцы и бренды среди проанализированных карточек.
  const uniq = (key) =>
    new Set(items.map((r) => r[key]).filter((v) => v && v !== '')).size;

  // Цены считаем по карточкам с ценой (нулевые/пустые не занижают медиану).
  const prices = items.map((r) => r.price).filter((p) => p > 0);

  // Монополизация: доля выручки топ-10 товаров и топ-продавца.
  const top10Revenue = items.slice(0, 10).reduce((s, r) => s + r.revenue, 0);

  // Разрез по продавцам: выручка, штуки, число карточек, доля ниши.
  const sellerMap = new Map();
  for (const r of items) {
    const key = r.seller || '(без продавца)';
    const cur = sellerMap.get(key) || { seller: key, products: 0, units: 0, revenue: 0 };
    cur.products += 1;
    cur.units += r.units;
    cur.revenue += r.revenue;
    sellerMap.set(key, cur);
  }
  const sellersAll = [...sellerMap.values()].sort((a, b) => b.revenue - a.revenue);
  const topSeller = sellersAll[0];

  const sellers = sellersAll.slice(0, topSellers).map((s) => ({
    seller: s.seller,
    products: s.products,
    units: round(s.units, 0),
    revenue: round(s.revenue, 0),
    revenueSharePct: totalRevenue > 0 ? round((s.revenue / totalRevenue) * 100, 1) : 0,
  }));

  // Разрез по брендам (компактный — только топ-10 для сводки).
  const brandMap = new Map();
  for (const r of items) {
    const key = r.brand || '(без бренда)';
    const cur = brandMap.get(key) || { brand: key, products: 0, revenue: 0 };
    cur.products += 1;
    cur.revenue += r.revenue;
    brandMap.set(key, cur);
  }
  const brands = [...brandMap.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((b) => ({
      brand: b.brand,
      products: b.products,
      revenue: round(b.revenue, 0),
      revenueSharePct: totalRevenue > 0 ? round((b.revenue / totalRevenue) * 100, 1) : 0,
    }));

  const ratings = items.map((r) => r.rating).filter((v) => v > 0);
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

  const totals = {
    productsInNiche,
    productsAnalyzed,
    truncated,
    pages,
    sellersCount: uniq('seller'),
    brandsCount: uniq('brand'),
    productsWithSales: withSales.length,
    productsNoSales: productsAnalyzed - withSales.length,
    withSalesPct:
      productsAnalyzed > 0 ? round((withSales.length / productsAnalyzed) * 100, 1) : 0,
    totalUnits: round(totalUnits, 0),
    totalRevenue: round(totalRevenue, 0),
    avgPrice: round(avg(prices), 0),
    medianPrice: round(median(prices), 0),
    avgRevenuePerProduct:
      productsAnalyzed > 0 ? round(totalRevenue / productsAnalyzed, 0) : 0,
    avgRevenuePerActiveProduct:
      withSales.length > 0 ? round(totalRevenue / withSales.length, 0) : 0,
    top10RevenueSharePct:
      totalRevenue > 0 ? round((top10Revenue / totalRevenue) * 100, 1) : 0,
    topSeller: topSeller ? topSeller.seller : '',
    topSellerSharePct:
      topSeller && totalRevenue > 0 ? round((topSeller.revenue / totalRevenue) * 100, 1) : 0,
    avgRating: round(avg(ratings), 2),
    avgComments: round(avg(items.map((r) => r.comments)), 0),
  };

  return {
    categoryPath,
    period: { d1, d2 },
    generatedAt: new Date().toISOString(),
    totals,
    sellers,
    brands,
    items,
  };
}

const CSV_COLUMNS = [
  ['sku', 'SKU'],
  ['name', 'Название'],
  ['brand', 'Бренд'],
  ['seller', 'Продавец'],
  ['price', 'Цена, ₽'],
  ['units', 'Продано, шт'],
  ['revenue', 'Выручка, ₽'],
  ['balance', 'Остаток, шт'],
  ['rating', 'Рейтинг'],
  ['comments', 'Отзывов'],
];

/** Экранирование значения для CSV (кавычки/разделители/переводы строк). */
function csvCell(v, sep) {
  if (v == null || v === '') return '';
  let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Экспорт товаров ниши в CSV (разделитель ';' и BOM — дружелюбно к RU Excel).
 * Строки отсортированы по убыванию выручки.
 */
export function nicheReportToCSV(report) {
  const sep = ';';
  const header = CSV_COLUMNS.map(([, title]) => title).join(sep);
  const lines = report.items.map((r) =>
    CSV_COLUMNS.map(([key]) => csvCell(r[key], sep)).join(sep)
  );

  const t = report.totals;
  const totalByKey = {
    name: 'ИТОГО',
    units: t.totalUnits,
    revenue: t.totalRevenue,
  };
  const totalLine = CSV_COLUMNS.map(([key]) => csvCell(totalByKey[key] ?? '', sep)).join(sep);

  return '﻿' + [header, ...lines, totalLine].join('\r\n') + '\r\n';
}
