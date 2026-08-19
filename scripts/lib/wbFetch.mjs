// scripts/lib/wbFetch.mjs — единые низкоуровневые выборки из WB API.
//
// Раньше пагинация /api/v3/orders, /api/v3/supplies и /api/v1/supplier/sales была
// СКОПИРОВАНА в 5–6 пайплайнов с расходящимися параметрами (чанк 28 vs 30 дней,
// ключ дедупа rid vs id, разные окна) — источник тонких, молчаливых расхождений.
// Здесь один механизм: пагинация по next со страховкой от вечного цикла, чанкинг
// окна и дедуп; РАЗЛИЧИЯ отчётов вынесены в параметры (окно/чанк/ключ). Каждый
// пайплайн сам агрегирует «сырые» строки под себя — так семантика сохраняется.

// Сборочные задания за [fromSec, toSec] кусками ≤chunkDays дней, с дедупом.
//   dedupBy: 'rid' (по o.rid) | 'id' (по o.id, fallback o.rid) — как было в каждом отчёте.
//   methodLimit — лимит метода маркетплейса; onLog(msg) — прогресс (опц.).
// Возврат: массив «сырых» заказов (в порядке получения, без дублей).
export async function fetchOrders(wb, { fromSec, toSec, chunkDays = 28, dedupBy = 'rid', methodLimit, onLog } = {}) {
  const CHUNK = chunkDays * 86400;
  const seen = new Set();
  const out = [];
  for (let end = toSec; end > fromSec;) {
    const start = Math.max(fromSec, end - CHUNK);
    let next = 0;
    for (let p = 1; ; p++) {
      const { data } = await wb.get('marketplace', '/api/v3/orders', { query: { limit: 1000, next, dateFrom: start, dateTo: end }, methodLimit });
      const b = data.orders || [];
      for (const o of b) {
        const raw = dedupBy === 'id' ? (o.id ?? o.rid) : o[dedupBy];
        if (raw != null) { const k = String(raw); if (seen.has(k)) continue; seen.add(k); }
        out.push(o);
      }
      onLog?.(`orders ${isoDay(start)}..${isoDay(end)}: стр.${p} +${b.length} (всего ${out.length})`);
      // Страховка от вечного цикла: выходим и по «<1000», и по пустому/неизменному next.
      if (b.length < 1000 || data.next == null || data.next === next) break;
      next = data.next;
    }
    end = start;
  }
  return out;
}

// Поставки: список (пагинация по next) + точечный добор недостающих id.
// Возврат: Map supplyId → объект поставки.
export async function fetchSupplies(wb, { neededIds = [], methodLimit, onLog } = {}) {
  const map = new Map();
  let next = 0;
  for (let p = 1; ; p++) {
    const { data } = await wb.get('marketplace', '/api/v3/supplies', { query: { limit: 1000, next }, methodLimit });
    const b = data.supplies || [];
    for (const s of b) map.set(s.id, s);
    if (b.length < 1000 || data.next == null || data.next === next) break;
    next = data.next;
  }
  const missing = [...neededIds].filter((id) => id && !map.has(id));
  if (missing.length) {
    onLog?.(`добираю ${missing.length} поставок точечно…`);
    for (const id of missing) {
      try { const { data } = await wb.get('marketplace', `/api/v3/supplies/${id}`, { methodLimit }); map.set(id, data); }
      catch (e) { onLog?.(`! supply ${id}: ${e.message || e}`); }
    }
  }
  return map;
}

// Продажи+возвраты из статистики (пагинация по lastChangeDate).
// ДЕДУП по srid+saleID: у возврата «R…» тот же srid, что у продажи «S…» — дедуп только
// по srid молча терял возвраты (см. фикс B1). Возврат: массив «сырых» строк.
export async function fetchSales(wb, { dateFrom, maxPages = 8, pageThreshold = 80000, methodLimit, onLog } = {}) {
  const seen = new Set();
  const rows = [];
  let from = dateFrom;
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await wb.get('statistics', '/api/v1/supplier/sales', { query: { dateFrom: from }, methodLimit });
    const b = Array.isArray(data) ? data : [];
    let last = null;
    for (const s of b) {
      const k = s.srid ? s.srid + '|' + (s.saleID || '') : null;
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      rows.push(s);
      last = s.lastChangeDate || last;
    }
    onLog?.(`sales стр.${page}: +${b.length} (всего ${rows.length})`);
    if (b.length < pageThreshold || !last) break;
    from = last;
  }
  return rows;
}

const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
