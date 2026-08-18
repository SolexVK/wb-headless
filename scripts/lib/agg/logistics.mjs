// scripts/lib/agg/logistics.mjs — чистые агрегаторы отчёта «Логистика».
// Вынесены из fbs-logistics.mjs, чтобы покрыть юнит-тестами на фиксированных
// заказах/поставках/продажах (без сети). Логика 1:1 с прежним инлайном пайплайна.
import { avg, median, pct, r2, hrs, mskDate } from './stats.mjs';

const isReturn = (s) => String(s.saleID || '').startsWith('R');
const okrugOf = (s) => (s.oblastOkrugName || '—');
const regionOf = (s) => (s.regionName || '—');

// СБОРКА: время «создание заказа → закрытие поставки» (createdAt → closedAt) по ФФ.
//   orders   — [{ ff, warehouseId, createdAt, supplyId, article, nmId }]
//   closedOf — (order) → closedAt|null (момент передачи поставки в доставку)
//   critH    — порог «критически долгой сборки», часов
//   asmFromSec — нижняя граница окна по createdAt (unix-сек)
export function buildAssembly(orders, closedOf, { critH, asmFromSec }) {
  const byFF = new Map();
  const crit = [];
  for (const o of orders) {
    const created = Math.floor(new Date(o.createdAt).getTime() / 1000);
    if (created < asmFromSec) continue; // сборку считаем за запрошенное окно
    if (!byFF.has(o.ff)) byFF.set(o.ff, { ff: o.ff, warehouseId: o.warehouseId, made: 0, processed: 0, pending: 0, times: [] });
    const g = byFF.get(o.ff); g.made++;
    const closed = closedOf(o);
    if (closed) {
      const t = hrs(o.createdAt, closed);
      if (t >= 0) { g.processed++; g.times.push(t); if (t > critH) crit.push({ ff: o.ff, article: o.article, hours: r2(t), createdAt: o.createdAt, closedAt: closed }); }
    } else g.pending++;
  }
  const rows = [...byFF.values()].map((g) => ({
    ff: g.ff, warehouseId: g.warehouseId, made: g.made, processed: g.processed, pending: g.pending,
    avgHours: r2(avg(g.times)), medianHours: r2(median(g.times)), p90Hours: r2(pct(g.times, 90)),
    maxHours: g.times.length ? r2(Math.max(...g.times)) : 0,
    criticalCount: g.times.filter((t) => t > critH).length,
  })).sort((a, b) => b.made - a.made);
  const all = [...byFF.values()].flatMap((g) => g.times);
  const buckets = { '<6ч': 0, '6–24ч': 0, '24–48ч': 0, '>48ч': 0 };
  for (const t of all) { if (t < 6) buckets['<6ч']++; else if (t < 24) buckets['6–24ч']++; else if (t < 48) buckets['24–48ч']++; else buckets['>48ч']++; }
  return {
    totals: {
      orders: rows.reduce((s, r) => s + r.made, 0), processed: all.length, pending: rows.reduce((s, r) => s + r.pending, 0),
      avgHours: r2(avg(all)), medianHours: r2(median(all)), p90Hours: r2(pct(all, 90)), criticalCount: crit.length,
    },
    byFF: rows, buckets,
    critical: crit.sort((a, b) => b.hours - a.hours).slice(0, 40),
  };
}

// ДОСТАВКА: время «отгрузка с ФФ → выкуп клиентом» (closedAt → sale.date) по ФФ/региону/дню.
//   sales   — строки статистики WB (S…/R…), с srid, date, regionName, oblastOkrugName
//   ridMap  — Map(srid → order) для привязки выкупа к ФФ отгрузки (srid == rid для FBS)
//   closedOf— (order) → closedAt|null; момент ухода с ФФ (фолбэк — createdAt заказа)
export function buildDelivery(sales, ridMap, closedOf) {
  const byFF = new Map(); const byReg = new Map(); const byDay = new Map();
  const all = []; let joined = 0, noShip = 0;
  for (const s of sales) {
    if (isReturn(s)) continue;              // доставку меряем по выкупам
    const o = ridMap.get(String(s.srid));   // привязка к ФФ отгрузки
    if (!o) continue;
    joined++;
    const ship = closedOf(o) || o.createdAt; // момент ухода с ФФ (передача в доставку)
    if (!ship) { noShip++; continue; }
    const t = (mskDate(s.date) - new Date(ship)) / 3600000; // ship — UTC ISO; s.date нормализуем к МСК
    if (!(t > 0) || t > 60 * 24) continue;  // отсекаем аномалии (отрицательные / > 60 сут)
    all.push(t);
    const day = String(s.date || '').slice(0, 10);
    if (!byFF.has(o.ff)) byFF.set(o.ff, { ff: o.ff, times: [] });
    byFF.get(o.ff).times.push(t);
    const rk = okrugOf(s) + '||' + regionOf(s);
    if (!byReg.has(rk)) byReg.set(rk, { okrug: okrugOf(s), region: regionOf(s), times: [] });
    byReg.get(rk).times.push(t);
    if (day) { if (!byDay.has(day)) byDay.set(day, { date: day, times: [] }); byDay.get(day).times.push(t); }
  }
  const ffRows = [...byFF.values()].map((g) => ({
    ff: g.ff, count: g.times.length, avgHours: r2(avg(g.times)), medianHours: r2(median(g.times)),
    p90Hours: r2(pct(g.times, 90)), minHours: g.times.length ? r2(Math.min(...g.times)) : 0, maxHours: g.times.length ? r2(Math.max(...g.times)) : 0,
  })).sort((a, b) => b.count - a.count);
  const regRows = [...byReg.values()].map((g) => ({ okrug: g.okrug, region: g.region, count: g.times.length, avgHours: r2(avg(g.times)), medianHours: r2(median(g.times)) }))
    .sort((a, b) => b.count - a.count);
  const buckets = { '<2 сут': 0, '2–4 сут': 0, '4–7 сут': 0, '>7 сут': 0 };
  for (const t of all) { const d = t / 24; if (d < 2) buckets['<2 сут']++; else if (d < 4) buckets['2–4 сут']++; else if (d < 7) buckets['4–7 сут']++; else buckets['>7 сут']++; }
  return {
    available: all.length > 0,
    totals: { count: all.length, joined, avgHours: r2(avg(all)), medianHours: r2(median(all)), p90Hours: r2(pct(all, 90)) },
    byFF: ffRows, byRegion: regRows, buckets,
    byDay: [...byDay.values()].map((g) => ({ date: g.date, count: g.times.length, avgHours: r2(avg(g.times)) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
