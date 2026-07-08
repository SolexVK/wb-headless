// bot/render/wb-top-keywords.js — рендер отчёта «Конкуренты по запросу» в
// HTML / PDF / XLSX из канонического JSON-контракта top-rivals.
//
// HTML/PDF переиспользуют готовый шаблон скилла (lib/wbTopKeywords.js formatHtml)
// и конвертацию (lib/htmlToPdf.js). XLSX строится из строк rivals через xlsx.

import * as XLSX from 'xlsx';
import { formatHtml, embedThumbnails } from '../../lib/wbTopKeywords.js';
import { htmlToPdf } from '../../lib/htmlToPdf.js';

/** HTML-строка отчёта. images=true — вшить миниатюры (сеть к CDN WB, необязательно). */
export async function html(data, { images = true } = {}) {
  if (images && Array.isArray(data.rivals)) {
    try {
      await embedThumbnails(data.rivals);
    } catch {
      /* нет сети/CDN — отдаём без фото */
    }
  }
  return formatHtml(data);
}

/** PDF-файл: HTML → headless Chromium. Ссылки на карточки остаются кликабельными. */
export async function pdf(data, outPath, opts = {}) {
  const h = await html(data, opts);
  await htmlToPdf(h, outPath);
  return outPath;
}

/** XLSX-файл: таблица конкурентов из rivals. */
export function xlsx(data, outPath) {
  const rows = (data.rivals || []).map((r, i) => ({
    '#': r.position ?? i + 1,
    nmId: r.nmId,
    'Бренд': r.brand,
    'Название': r.name,
    'Цвет': r.color,
    'Цена, ₽': r.price,
    'Ср. цена, ₽': r.avgSalePrice,
    'Рейтинг': r.rating,
    'Отзывы': r.reviews,
    'Продажи': r.sales,
    'Выручка, ₽': r.revenue,
    'Тип': r.matchType,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 4 }, { wch: 11 }, { wch: 16 }, { wch: 44 }, { wch: 18 },
    { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 13 }, { wch: 8 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Конкуренты');
  XLSX.writeFile(wb, outPath);
  return outPath;
}
