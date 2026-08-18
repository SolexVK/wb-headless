// scripts/lib/agg/stats.mjs — чистые числовые/временные хелперы агрегаторов отчётов.
// Выделены из пайплайнов, чтобы (а) не копипастить и (б) покрыть юнит-тестами
// (smoke-agg.mjs) на фиксированных входах — от них зависят все сроки и медианы.

// Среднее по массиву чисел (пустой → 0).
export const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

// Медиана (пустой → 0). Для чётной длины — среднее двух центральных.
export const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Перцентиль p (0..100) по «ближайшему рангу» (пустой → 0). p90 = pct(arr, 90).
export const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
};

// Округление до 2 знаков.
export const r2 = (x) => Math.round(x * 100) / 100;

// Разница «b − a» в часах (оба — разбираемые Date/ISO).
export const hrs = (a, b) => (new Date(b) - new Date(a)) / 3600000;

// Дата продажи из статистики WB идёт БЕЗ смещения (московское локальное время). На сервере
// в UTC `new Date(s.date)` разобрался бы как UTC → диф с UTC-временами заказа съезжал бы на 3ч.
// Явно проставляем +03:00, если смещения нет (Z или ±hh:mm — оставляем как есть).
export const mskDate = (d) => {
  const s = String(d || '');
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + '+03:00');
};
