// lib/categoryReport.js — отчёт «Топ рубашек в полоску за сезон»
//
// Задача: по категории(ям) WB отобрать товары «в полоску» и построить
// рейтинг топ-N по выручке за период (например осенний сезон).
//
// Методология (прозрачная и воспроизводимая):
//   1. Тянем карточки категории за период, отсортированные MPSTATS по
//      продажам (топ-продавцы идут первыми). Число просмотренных карточек
//      ограничено maxRows на категорию — чтобы не жечь суточный лимит.
//   2. Оставляем только «полосатые» — по ключевым словам в названии/цвете
//      (полоск, полоса, striped, pinstripe…). Список слов настраивается.
//   3. Схлопываем дубли по SKU (один товар может прийти из двух категорий).
//   4. Сортируем по выручке за период ↓ и берём первые topN.
//
// Важно про «полноту»: если в категории товаров больше maxRows, часть
// хвоста (слабые продавцы) в выборку не попадёт — для рейтинга ТОПа это не
// критично, но мы честно репортим это в report.coverage и в консоль.

import { fetchCategoryItems } from './mpstats.js';

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

// Ключевые слова «в полоску» (регистр не важен). Латиница — на случай
// англоязычных названий брендов. Настраивается через STRIPE_KEYWORDS.
export const DEFAULT_STRIPE_KEYWORDS = [
  'полоск', // «в полоску», «полоска», «полоски»
  'полос', // «полосатый», «полоса», «полосами»
  'striped',
  'stripe',
  'pinstripe',
];

/** Разбирает строку-список ключевых слов «в полоску» (через запятую). */
export function parseKeywords(raw) {
  const list = String(raw || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_STRIPE_KEYWORDS;
}

/** Товар «в полоску», если любое ключевое слово встречается в имени/цвете. */
export function isStriped(item, keywords = DEFAULT_STRIPE_KEYWORDS) {
  const hay = `${item.name || ''} ${item.color || ''}`.toLowerCase();
  return keywords.some((kw) => hay.includes(kw));
}

/** Приводит карточку к строке отчёта (нормализует числа для вывода). */
function toRow(item) {
  const unitsSold = round(item.unitsSold, 0);
  let revenue = round(item.revenue, 0);
  // Если MPSTATS не отдал выручку — реконструируем из штук и цены.
  if (!revenue && unitsSold && item.finalPrice) {
    revenue = round(unitsSold * item.finalPrice, 0);
  }
  const avgPrice = unitsSold > 0 && revenue > 0 ? round(revenue / unitsSold, 0) : round(item.finalPrice, 0);
  return {
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    seller: item.seller,
    color: item.color,
    category: item.category,
    unitsSold,
    revenue,
    avgPrice,
    rating: round(item.rating, 1),
    comments: round(item.comments, 0),
  };
}

/**
 * Строит отчёт «Топ рубашек в полоску» по списку категорий за период.
 * @param {object} p
 * @param {string[]} p.categories пути категорий WB (MPSTATS)
 * @param {string}   p.d1,p.d2    период 'YYYY-MM-DD'
 * @param {number}   [p.topN=10]
 * @param {string[]} [p.keywords] ключевые слова «в полоску»
 * @param {number}   [p.pageSize] размер страницы MPSTATS
 * @param {number}   [p.maxRows]  сколько карточек просматривать на категорию
 * @param {object}   [p.filterModel] server-side фильтр MPSTATS (если нужен)
 * @param {(msg:string)=>void} [p.onProgress]
 */
export async function buildTopStripedReport({
  categories,
  d1,
  d2,
  topN = 10,
  keywords = DEFAULT_STRIPE_KEYWORDS,
  pageSize,
  maxRows,
  filterModel,
  onProgress,
} = {}) {
  const cats = (categories || []).map((c) => String(c).trim()).filter(Boolean);
  if (cats.length === 0) throw new Error('Не задан ни один путь категории (categories).');

  const errors = [];
  const coverage = []; // по категории: сколько просмотрели / сколько всего / был ли обрез
  const bySku = new Map(); // дедуп по SKU (берём максимум выручки на всякий случай)
  let stripedCount = 0;
  let scannedCount = 0;

  for (const category of cats) {
    try {
      if (onProgress) onProgress(`категория «${category}» — читаю…`);
      const { items, scanned, total, cappedAt } = await fetchCategoryItems(category, d1, d2, {
        pageSize,
        maxRows,
        filterModel,
      });
      scannedCount += scanned;
      const capped = total > scanned; // хвост категории не влез в maxRows
      coverage.push({ category, scanned, total, capped, cappedAt });

      for (const it of items) {
        if (!isStriped(it, keywords)) continue;
        stripedCount += 1;
        const prev = bySku.get(it.sku);
        // Один SKU может прийти из двух категорий — оставляем запись с большей
        // выручкой (она полнее отражает продажи товара за период).
        if (!prev || (Number(it.revenue) || 0) > (Number(prev.revenue) || 0)) {
          bySku.set(it.sku, it);
        }
      }
      if (onProgress) {
        onProgress(
          `категория «${category}»: просмотрено ${scanned}` +
            (capped ? ` из ${total} (обрез по лимиту ${cappedAt})` : ` (вся категория)`) +
            `, полосатых найдено ${stripedCount}`
        );
      }
    } catch (err) {
      errors.push({ category, error: String(err?.message || err) });
      if (onProgress) onProgress(`⚠ категория «${category}»: ${String(err?.message || err)}`);
    }
  }

  const allStriped = [...bySku.values()].map(toRow);
  allStriped.sort((a, b) => b.revenue - a.revenue);
  const top = allStriped.slice(0, topN);

  const totals = top.reduce(
    (acc, r) => {
      acc.unitsSold += r.unitsSold;
      acc.revenue += r.revenue;
      return acc;
    },
    { unitsSold: 0, revenue: 0 }
  );

  return {
    period: { d1, d2 },
    query: { categories: cats, topN, keywords },
    rows: top,
    totals: {
      topN: top.length,
      unitsSold: round(totals.unitsSold, 0),
      revenue: round(totals.revenue, 0),
      stripedFound: bySku.size,
      stripedMatches: stripedCount,
      scanned: scannedCount,
    },
    coverage,
    errors,
  };
}

const CSV_COLUMNS = [
  ['rank', '#'],
  ['sku', 'SKU'],
  ['name', 'Название'],
  ['brand', 'Бренд'],
  ['seller', 'Продавец'],
  ['color', 'Цвет'],
  ['unitsSold', 'Продано, шт'],
  ['revenue', 'Выручка, ₽'],
  ['avgPrice', 'Средняя цена, ₽'],
  ['rating', 'Рейтинг'],
  ['comments', 'Отзывов'],
];

/** Экспорт в CSV (разделитель ';' и BOM — дружелюбно к RU Excel). */
export function reportToCSV(report) {
  const sep = ';';
  const cell = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    // Экранируем разделитель/кавычки/переносы в тексте (названия длинные).
    const s = String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = CSV_COLUMNS.map(([, title]) => title).join(sep);
  const lines = report.rows.map((r, i) =>
    CSV_COLUMNS.map(([key]) => cell(key === 'rank' ? i + 1 : r[key])).join(sep)
  );

  const t = report.totals;
  const totalByKey = { name: 'ИТОГО (топ)', unitsSold: t.unitsSold, revenue: t.revenue };
  const totalLine = CSV_COLUMNS.map(([key]) => cell(totalByKey[key] ?? '')).join(sep);

  return '﻿' + [header, ...lines, totalLine].join('\r\n') + '\r\n';
}

/** Человекочитаемый разбор в Markdown — готовый «анализ» для отправки. */
export function reportToMarkdown(report) {
  const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
  const { period, rows, totals, coverage, query } = report;

  const lines = [];
  lines.push(`# Топ-${query.topN} рубашек в полоску за сезон`);
  lines.push('');
  lines.push(`**Период:** ${period.d1} … ${period.d2}`);
  lines.push(`**Категории:** ${query.categories.join('; ')}`);
  lines.push(`**Критерий «полоска»:** ${query.keywords.join(', ')}`);
  lines.push(
    `**Найдено полосатых:** ${fmt(totals.stripedFound)} (просмотрено карточек: ${fmt(totals.scanned)})`
  );
  lines.push('');
  lines.push('## Рейтинг по выручке за период');
  lines.push('');
  lines.push('| # | Товар | Бренд | Продано, шт | Выручка, ₽ | Ср. цена, ₽ | Рейтинг | Отзывов | SKU |');
  lines.push('|--:|---|---|--:|--:|--:|--:|--:|--:|');
  rows.forEach((r, i) => {
    const nm = (r.name || '').replace(/\|/g, '\\|').slice(0, 60);
    lines.push(
      `| ${i + 1} | ${nm} | ${r.brand || '—'} | ${fmt(r.unitsSold)} | ${fmt(r.revenue)} | ${fmt(
        r.avgPrice
      )} | ${r.rating || '—'} | ${fmt(r.comments)} | ${r.sku} |`
    );
  });
  lines.push('');
  lines.push(
    `**Итого по топу:** ${fmt(totals.unitsSold)} шт на ${fmt(totals.revenue)} ₽.`
  );

  const capped = coverage.filter((c) => c.capped);
  if (capped.length) {
    lines.push('');
    lines.push('> ⚠ **Охват неполный.** В этих категориях товаров больше, чем просмотрено:');
    for (const c of capped) {
      lines.push(`> - ${c.category}: просмотрено ${fmt(c.scanned)} из ${fmt(c.total)}.`);
    }
    lines.push('> Слабые продавцы из хвоста в рейтинг не попали (на ТОП это не влияет).');
  }
  if (report.errors.length) {
    lines.push('');
    lines.push(`> ⚠ Ошибок при запросах: ${report.errors.length} (см. .json).`);
  }
  return lines.join('\n') + '\n';
}
