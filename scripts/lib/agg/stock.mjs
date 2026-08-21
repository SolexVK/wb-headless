// scripts/lib/agg/stock.mjs — метрики «динамики остатков» из ряда по дням.
// Ряд: { count, dates:[...], warehouses:[{name, values:[...]}], grand:[...] }.
// Используется и страницей отчёта (service/views), и PDF-дашбордом (scripts).

const lastOf = (a) => (a && a.length ? a[a.length - 1] : 0);

// Оценка «дней до нуля» по тренду периода: (now-first)/span за снимок (≈ день).
// Тренд < 0 (убывает) → now / |тренд|; иначе null (растёт/стабильно — риска нет).
export function stockMetrics(series) {
  const s = series || { count: 0, dates: [], warehouses: [], grand: [] };
  const span = Math.max(1, (s.count || (s.dates || []).length || 1) - 1);
  const per = (s.warehouses || []).map((w) => {
    const vals = w.values || [];
    const first = vals[0] || 0;
    const now = lastOf(vals);
    const delta = now - first;
    const trendPerDay = (now - first) / span;
    const daysToZero = trendPerDay < -1e-9 ? Math.max(0, Math.round(now / -trendPerDay)) : null;
    return { name: w.name, first, now, delta, daysToZero, min: vals.length ? Math.min(...vals) : 0, max: vals.length ? Math.max(...vals) : 0 };
  });
  const byDelta = [...per].sort((a, b) => b.delta - a.delta);
  const grow = byDelta[0] || null;
  const drop = byDelta[byDelta.length - 1] || null;
  const withOos = per.filter((p) => p.daysToZero != null).sort((a, b) => a.daysToZero - b.daysToZero);
  return {
    per,
    grow: grow && grow.delta > 0 ? grow : null,
    drop: drop && drop.delta < 0 ? drop : null,
    soonest: withOos[0] || null,
    riskCount: withOos.filter((p) => p.daysToZero <= 14).length,
    grandNow: lastOf(s.grand),
  };
}

// Человекочитаемо «дней до нуля» (null → растёт/стабильно).
export const oosLabel = (d) => (d == null ? 'растёт/стаб.' : `≈ ${d.toLocaleString('ru-RU')} дн до 0`);
