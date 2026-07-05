// lib/wbCardsCompareParse.js — извлечение структурированных данных из XLSX
// отчёта «Сравнение карточек» (лист «Показатели»).
//
// Это «звено-мост» каскада инструментов: отчёт сравнения карточек → нормализованный
// JSON, который потребляет инструмент «Конкурентный анализ» (блок воронки: CTR,
// конверсия в корзину/заказ, % выкупа и т.д.).
//
// Контракт (что возвращаем) — см. docs/pipeline/README.md:
//   {
//     source: 'wb-cards-compare',
//     our: '758196168',
//     periods: { current:{from,to}, previous:{from,to} },
//     articles: [ { nmId, isOur, name, brand, category, subject, createdAt,
//                   current:{...метрики}, previous:{...метрики} } ],
//     funnel: [ { nmId, isOur, ctr, cartConvPct, orderConvPct, buyoutPct } ]  // срез для воронки
//   }

import xlsx from 'xlsx';

// Метрики листа «Показатели»: [регэксп по названию строки, ключ, тип].
const METRICS = [
  [/^Показы/i, 'showings', 'num'],
  [/^Переход/i, 'cardTransitions', 'num'],
  [/^CTR/i, 'ctrPct', 'num'],
  [/^Добавления в корзину/i, 'cartAdds', 'num'],
  [/^Конверсия в корзину(?!.*поиск)/i, 'cartConvPct', 'num'],
  [/^Заказы/i, 'orders', 'num'],
  [/^Конверсия в заказ(?!.*поиск)/i, 'orderConvPct', 'num'],
  [/^Выкупы/i, 'buyouts', 'num'],
  [/^Процент выкупа/i, 'buyoutPct', 'num'],
  [/^Отмены/i, 'cancels', 'num'],
  [/^Средняя позиция/i, 'avgSearchPosition', 'num'],
  [/^Рейтинг карточки/i, 'cardRating', 'num'],
  [/^Рейтинг по отзывам/i, 'reviewRating', 'num'],
  [/^Количество отзывов/i, 'reviewCount', 'num'],
  [/^Медианная цена/i, 'medianPrice', 'num'],
  [/^Минимальная цена/i, 'priceMin', 'num'],
  [/^Максимальная цена/i, 'priceMax', 'num'],
  [/^Среднее время доставки/i, 'avgDeliveryTime', 'str'],
  [/^Статус продвижения/i, 'promoStatus', 'str'],
];
const META = [
  [/^Название/i, 'name'], [/^Бренд/i, 'brand'], [/^Категория/i, 'category'],
  [/^Предмет/i, 'subject'], [/^Дата создания/i, 'createdAt'],
];

const numify = (v) => {
  if (v === '' || v === '-' || v == null) return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const strify = (v) => (v === '' || v === '-' || v == null ? null : String(v).trim());

function findPeriods(wb) {
  const out = { current: null, previous: null };
  const ws = wb.Sheets['Общая информация'];
  const flat = ws ? xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' }).flat().map(String) : [];
  const ranges = [];
  for (const cell of flat) {
    const m = /С\s*(\d{4}-\d{2}-\d{2})\s*по\s*(\d{4}-\d{2}-\d{2})/i.exec(cell);
    if (m) ranges.push({ from: m[1], to: m[2] });
  }
  if (ranges[0]) out.current = ranges[0];
  if (ranges[1]) out.previous = ranges[1];
  return out;
}

/**
 * Парсит XLSX «Сравнение карточек» в нормализованный объект.
 * @param {string} file  путь к .xlsx (уже развёрнутому, не ZIP-обёртке).
 * @returns {object} контракт (см. заголовок файла).
 */
export function parseCardsComparison(file) {
  const wb = xlsx.readFile(file);
  const ws = wb.Sheets['Показатели'];
  if (!ws) throw new Error('В файле нет листа «Показатели» — это не отчёт сравнения карточек?');
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Строка-шапка со столбцами «Артикул WB <nmId>».
  const headerRow = rows.find((r) => String(r[0]).trim() === 'Показатели') || rows[1] || [];
  const valCols = [];
  headerRow.forEach((cell, idx) => {
    const m = /Артикул\s*WB\s*(\d+)/i.exec(String(cell));
    if (m) valCols.push({ idx, nmId: m[1] });
  });
  if (!valCols.length) throw new Error('Не нашёл столбцы «Артикул WB <nmId>» в листе «Показатели».');

  // Первая половина value-столбцов = текущий период, вторая = предыдущий (тот же порядок артикулов).
  const n = Math.floor(valCols.length / 2);
  const current = valCols.slice(0, n);
  const previous = valCols.slice(n, n * 2);

  const rowByLabel = (patterns) => rows.find((r) => patterns.some((re) => re.test(String(r[0]).trim())));
  const readRow = (patterns) => rowByLabel(Array.isArray(patterns) ? patterns : [patterns]);

  const articles = current.map((cCol, i) => {
    const pCol = previous[i];
    const art = { nmId: cCol.nmId, isOur: i === 0 };
    // мета (берём из текущего столбца)
    for (const [re, key] of META) {
      const row = readRow(re); if (row) art[key] = strify(row[cCol.idx]);
    }
    const readMetrics = (colIdx) => {
      const o = {};
      for (const [re, key, type] of METRICS) {
        const row = readRow(re); if (!row) continue;
        o[key] = type === 'num' ? numify(row[colIdx]) : strify(row[colIdx]);
      }
      return o;
    };
    art.current = readMetrics(cCol.idx);
    art.previous = pCol ? readMetrics(pCol.idx) : null;
    return art;
  });

  const funnel = articles.map((a) => ({
    nmId: a.nmId, isOur: a.isOur, name: a.name,
    ctrPct: a.current.ctrPct, cartConvPct: a.current.cartConvPct,
    orderConvPct: a.current.orderConvPct, buyoutPct: a.current.buyoutPct,
    showings: a.current.showings, orders: a.current.orders, buyouts: a.current.buyouts,
  }));

  return {
    source: 'wb-cards-compare',
    our: articles.find((a) => a.isOur)?.nmId || articles[0]?.nmId || null,
    periods: findPeriods(wb),
    articles,
    funnel,
  };
}
