// lib/forensics.js — расследование удержаний Wildberries: логистика и штрафы.
//
// Отвечает на два вопроса, на которые сводный отчёт (lib/finesReport.js) ответить
// не может, потому что там всё сложено в итоги:
//   1. ЗА ЧТО именно удержана логистика и почему тариф такой (при ИУ на логистику);
//   2. ЧТО стало причиной каждого штрафа — с датами, заказами, складами и сроками.
//
// Ключ к обоим расследованиям — поле bonusTypeName в строке детализации: у строк
// логистики оно содержит причину («Возврат брака (К продавцу)», «Возврат товара,
// который приехал по МП, продавцу»), у строк штрафа — состав нарушения.
//
// Связки между источниками (проверены на живых данных, доля матчей в комментариях):
//   логистика/хранение → возвраты      по srid и shkId          (745/747, 238/245)
//   логистика          → поставка      по giId = incomeID       (746/747)
//   штраф за отмену    → FBS-задание   по srid = rid            (68/69)
//   штраф за отмену    → заказ         по srid                  (58/69)
//   FBS-задание        → склад продавца по warehouseId          (100%)

const n = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const low = (v) => String(v ?? '').toLowerCase();
const day = (v) => String(v ?? '').slice(0, 10);
const round = (v, d = 2) => { const f = 10 ** d; return Math.round((Number(v) || 0) * f) / f; };
const HOURS = 36e5;
const DAYS = 864e5;

/** Группировка с суммой и счётчиком. */
export function groupSum(items, keyFn, valFn = () => 0) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, { key: k, count: 0, sum: 0, items: [] });
    const e = m.get(k);
    e.count += 1;
    e.sum += valFn(it);
    e.items.push(it);
  }
  return [...m.values()].map((e) => ({ ...e, sum: round(e.sum) })).sort((a, b) => b.sum - a.sum || b.count - a.count);
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Индексы по источникам — строятся один раз и переиспользуются обоими отчётами. */
export function buildIndex(src) {
  const returnsBySrid = new Map((src.returns || []).map((r) => [low(r.srid), r]));
  const returnsByShk = new Map((src.returns || []).map((r) => [String(r.shkId), r]));
  const ordersBySrid = new Map((src.orders || []).map((o) => [low(o.srid), o]));
  const fbsByRid = new Map((src.fbsOrders || []).map((o) => [low(o.rid), o]));
  const warehouseById = new Map((src.warehouses || []).map((w) => [w.id, w.name]));
  // Поставка (giId) → склад, с которого шла отгрузка: берём из продаж/заказов.
  const supplyWarehouse = new Map();
  for (const s of [...(src.sales || []), ...(src.orders || [])]) {
    const k = String(s.incomeID);
    if (!supplyWarehouse.has(k)) supplyWarehouse.set(k, { name: s.warehouseName, type: s.warehouseType });
  }
  return { returnsBySrid, returnsByShk, ordersBySrid, fbsByRid, warehouseById, supplyWarehouse };
}

const findReturn = (idx, row) =>
  idx.returnsBySrid.get(low(row.srid)) || idx.returnsByShk.get(String(row.shkId)) || null;

// ───────────────────────── ЛОГИСТИКА ─────────────────────────

/**
 * Расследование логистики: каждую строку начисления связываем с возвратом,
 * ПВЗ выдачи и поставкой, затем считаем срезы.
 */
export function analyzeLogistics(src) {
  const idx = buildIndex(src);
  const asOf = src.asOf ? new Date(src.asOf).getTime() : Date.now();
  const rows = (src.finance || []).filter((r) => n(r.deliveryService) !== 0);

  const enriched = rows.map((r) => {
    const ret = findReturn(idx, r);
    const supply = idx.supplyWarehouse.get(String(r.giId));
    return {
      date: day(r.rrDate),
      amount: n(r.deliveryService),
      reason: r.bonusTypeName || '(причина не указана)',
      method: r.deliveryMethod || '—',
      coef: n(r.warehouseLogisticsCoeff) || 1,
      article: r.vendorCode || String(r.nmId),
      nmId: r.nmId,
      size: r.techSize,
      subject: r.subjectName,
      pvz: r.ppvzOfficeName || (ret ? ret.dstOfficeAddress : '') || '—',
      country: r.country || '—',
      office: r.officeName || '—',
      orderDt: day(r.orderDt),
      supply: supply ? `${supply.name} [${supply.type}]` : '—',
      giId: r.giId,
      returnType: ret ? ret.returnType : null,
      readyDt: ret ? ret.readyToReturnDt : null,
      completedDt: ret ? ret.completedDt : null,
      srid: r.srid,
    };
  });

  const total = round(enriched.reduce((s, r) => s + r.amount, 0));
  // Прямая доставка покупателю — строки продажи с логистикой (не возврат).
  const forwardRows = enriched.filter((r) => !/возврат|отзыв/i.test(r.reason));

  // Тарификация возвратов по ПВЗ: сколько выдач и сколько из них оплачено.
  const chargedSrids = new Set(enriched.map((r) => low(r.srid)));
  const chargedShk = new Set(enriched.map((r) => String(r.srid)));
  const issued = (src.returns || []).filter((r) => r.completedDt);
  const pvzStats = groupSum(issued, (r) => r.dstOfficeAddress || '—').map((g) => {
    const charged = g.items.filter((r) => chargedSrids.has(low(r.srid)) || chargedShk.has(String(r.srid)));
    return {
      pvz: g.key,
      issued: g.count,
      charged: charged.length,
      chargedPct: g.count ? round((charged.length / g.count) * 100, 1) : 0,
      dates: [...new Set(g.items.map((r) => day(r.completedDt)))].sort(),
    };
  }).sort((a, b) => b.issued - a.issued);

  // Отложенный «хвост»: возвраты уже выданы, а начисления ещё не пришли.
  //
  // ВАЖНО: отсутствие начислений по ПВЗ в окне отчёта НЕ означает, что он
  // бесплатный. Проверено на живых данных: московский ПВЗ выглядел
  // «нетарифицируемым» (917 выдач, 0 начислений), а на следующем закрытом дне
  // все 509 выдач были оплачены на 100%. Причина — лаг: списание приходит
  // пакетом в день выдачи, но сам день может быть ещё не закрыт. Поэтому в
  // прогноз берём ВСЕ выданные без начисления, а «тихие» ПВЗ показываем
  // отдельно как диагностику, а не как экономию.
  const pending = issued.filter(
    (r) => !chargedSrids.has(low(r.srid)) && !chargedShk.has(String(r.srid))
  );
  const quietPvz = pvzStats.filter((p) => p.charged === 0).map((p) => p.pvz);
  // Насколько давно выданы неоплаченные возвраты — чем старше, тем вероятнее,
  // что начисление придёт отдельным пакетом, а не потерялось.
  const ageDays = (r) => (r.completedDt ? (asOf - new Date(r.completedDt)) / DAYS : 0);
  const stale = pending.filter((r) => ageDays(r) > 3);
  const avgTariff = enriched.length ? round(total / enriched.length) : 0;

  const amounts = enriched.map((r) => r.amount);
  return {
    total,
    rowCount: enriched.length,
    forwardTotal: round(forwardRows.reduce((s, r) => s + r.amount, 0)),
    forwardCount: forwardRows.length,
    avgTariff,
    minTariff: amounts.length ? round(Math.min(...amounts)) : 0,
    maxTariff: amounts.length ? round(Math.max(...amounts)) : 0,
    medianTariff: round(median(amounts)),
    byReason: groupSum(enriched, (r) => r.reason, (r) => r.amount),
    byMethod: groupSum(enriched, (r) => r.method, (r) => r.amount),
    byDate: groupSum(enriched, (r) => r.date, (r) => r.amount).sort((a, b) => a.key.localeCompare(b.key)),
    byCoef: groupSum(enriched, (r) => r.coef, (r) => r.amount)
      .map((g) => ({ ...g, avg: round(g.sum / g.count) }))
      .sort((a, b) => Number(a.key) - Number(b.key)),
    byPvz: groupSum(enriched, (r) => r.pvz, (r) => r.amount),
    bySupply: groupSum(enriched, (r) => r.supply, (r) => r.amount),
    byArticle: groupSum(enriched, (r) => r.article, (r) => r.amount),
    pvzStats,
    pending: {
      count: pending.length,
      forecast: round(pending.length * avgTariff),
      stale: stale.length,
      quietPvz,
    },
    rows: enriched.sort((a, b) => b.amount - a.amount),
  };
}

// ───────────────────────── ШТРАФЫ ─────────────────────────


/**
 * Расследование штрафов: разбираем каждую причину отдельно.
 * Отмены заказов связываем с FBS-заданием (склад, дата постановки) и заказом
 * (дата отмены) → получаем срок, который заказ провисел до срыва.
 * Хранение возвратов на ПВЗ связываем с возвратом → сколько суток пролежало.
 */
export function analyzeFines(src) {
  const idx = buildIndex(src);
  const asOf = src.asOf ? new Date(src.asOf).getTime() : Date.now();
  const rows = (src.finance || []).filter((r) => n(r.penalty) !== 0);

  const cancels = [];
  const storage = [];
  const other = [];

  for (const r of rows) {
    const amount = n(r.penalty);
    const reason = r.bonusTypeName || '(причина не указана)';
    const base = {
      amount,
      date: day(r.rrDate),
      reason,
      article: r.vendorCode || String(r.nmId),
      nmId: r.nmId,
      size: r.techSize,
      subject: r.subjectName,
      srid: r.srid,
      shkId: r.shkId,
    };

    if (/невыполненный заказ/i.test(reason)) {
      const fbs = idx.fbsByRid.get(low(r.srid));
      const order = idx.ordersBySrid.get(low(r.srid));
      const created = fbs?.createdAt || order?.date || null;
      const cancelled = order?.isCancel ? order.cancelDate : null;
      const hours = created && cancelled ? round((new Date(cancelled) - new Date(created)) / HOURS, 1) : null;
      cancels.push({
        ...base,
        orderId: fbs?.id ?? order?.gNumber ?? null,
        createdAt: created,
        cancelDate: cancelled,
        hours,
        ff: fbs ? idx.warehouseById.get(fbs.warehouseId) || `склад #${fbs.warehouseId}` : '(не определён)',
        office: fbs ? (fbs.offices || []).join(' / ') : '—',
        supplyId: fbs?.supplyId || '',
        price: order ? n(order.finishedPrice) : null,
        priceShare: order && n(order.finishedPrice) ? round((amount / n(order.finishedPrice)) * 100, 1) : null,
      });
    } else if (/хранение возвратов/i.test(reason)) {
      const ret = findReturn(idx, r);
      const days = ret?.readyToReturnDt && ret?.completedDt
        ? round((new Date(ret.completedDt) - new Date(ret.readyToReturnDt)) / DAYS, 2)
        : null;
      storage.push({
        ...base,
        pvz: ret?.dstOfficeAddress || '—',
        readyDt: ret?.readyToReturnDt || null,
        takenDt: ret?.completedDt || null,
        days,
        orderId: ret?.orderId || null,
        returnType: ret?.returnType || '—',
        status: ret?.status || '—',
      });
    } else {
      other.push(base);
    }
  }

  const sum = (a) => round(a.reduce((s, x) => s + x.amount, 0));
  const material = cancels.filter((c) => c.amount > 1); // копеечные хвосты не искажают статистику
  const hoursArr = material.filter((c) => c.hours != null).map((c) => c.hours);
  const daysArr = storage.filter((s) => s.days != null).map((s) => s.days);
  // Суточный тариф хранения: минимальная ненулевая сумма — это одни сутки.
  const storageAmounts = storage.map((s) => s.amount).filter((v) => v > 0);
  const dailyRate = storageAmounts.length ? round(Math.min(...storageAmounts)) : 0;

  // Возвраты, которые уже готовы к выдаче, но ещё не забраны: по ним штраф
  // продолжает капать каждые сутки. Считаем очаг и суточную «капель».
  const awaiting = (src.returns || []).filter((r) => /готов к выдаче/i.test(r.status || '') && !r.completedDt);
  const ageDays = (r) => (r.readyToReturnDt ? (asOf - new Date(r.readyToReturnDt)) / DAYS : 0);
  const overdue = awaiting.filter((r) => ageDays(r) > 2);   // уже в платной зоне
  const maxAge = awaiting.length ? Math.max(...awaiting.map(ageDays)) : 0;
  // Возвраты, по которым срок хранения на ПВЗ уже вышел: их могут утилизировать
  // или отправить обратно, и это дороже суточной платы.
  const expired = (src.returns || []).filter((r) => /истек срок хранения/i.test(r.status || ''));

  return {
    awaiting: {
      count: awaiting.length,
      overdue: overdue.length,
      maxAgeDays: round(maxAge, 2),
      byPvz: groupSum(awaiting, (r) => r.dstOfficeAddress || '—'),
      expired: {
        count: expired.length,
        byPvz: groupSum(expired, (r) => r.dstOfficeAddress || '—'),
        oldest: expired.map((r) => r.readyToReturnDt).filter(Boolean).sort()[0] || null,
      },
    },
    total: sum(rows.map((r) => ({ amount: n(r.penalty) }))),
    byReason: groupSum(rows, (r) => r.bonusTypeName || '(причина не указана)', (r) => n(r.penalty)),
    cancels: {
      total: sum(cancels),
      count: cancels.length,
      material: material.length,
      avg: material.length ? round(sum(material) / material.length) : 0,
      byFf: groupSum(material, (c) => c.ff, (c) => c.amount),
      byCreatedDate: groupSum(material, (c) => day(c.createdAt), (c) => c.amount).sort((a, b) => a.key.localeCompare(b.key)),
      byCancelDate: groupSum(material.filter((c) => c.cancelDate), (c) => day(c.cancelDate), (c) => c.amount).sort((a, b) => a.key.localeCompare(b.key)),
      byArticle: groupSum(material, (c) => c.article, (c) => c.amount),
      hours: hoursArr.length
        ? { min: round(Math.min(...hoursArr), 1), median: round(median(hoursArr), 1), max: round(Math.max(...hoursArr), 1) }
        : null,
      priceShare: (() => {
        const shares = material.filter((c) => c.priceShare != null).map((c) => c.priceShare);
        return shares.length
          ? { min: round(Math.min(...shares), 1), median: round(median(shares), 1), max: round(Math.max(...shares), 1), n: shares.length }
          : null;
      })(),
      rows: material.sort((a, b) => b.amount - a.amount),
      dust: cancels.filter((c) => c.amount <= 1).length,
    },
    storage: {
      total: sum(storage),
      count: storage.length,
      dailyRate,
      byPvz: groupSum(storage, (s) => s.pvz, (s) => s.amount),
      byDate: groupSum(storage, (s) => s.date, (s) => s.amount).sort((a, b) => a.key.localeCompare(b.key)),
      byArticle: groupSum(storage, (s) => s.article, (s) => s.amount),
      byDays: groupSum(storage.filter((s) => s.days != null), (s) => Math.floor(s.days), (s) => s.amount)
        .sort((a, b) => Number(a.key) - Number(b.key)),
      notTakenYet: storage.filter((x) => !x.takenDt).length,
      days: daysArr.length
        ? { min: round(Math.min(...daysArr), 2), median: round(median(daysArr), 2), max: round(Math.max(...daysArr), 2) }
        : null,
      rows: storage.sort((a, b) => b.amount - a.amount),
    },
    other: { total: sum(other), count: other.length, rows: other },
  };
}

/** Сводка предыдущего периода: нужна, чтобы отличить разовый всплеск от нормы. */
export function analyzePrevious(prevRows = []) {
  const pen = prevRows.filter((r) => n(r.penalty) !== 0);
  const log = prevRows.filter((r) => n(r.deliveryService) !== 0);
  return {
    penaltyTotal: round(pen.reduce((s, r) => s + n(r.penalty), 0)),
    penaltyByReason: groupSum(pen, (r) => r.bonusTypeName || '—', (r) => n(r.penalty)),
    logisticsTotal: round(log.reduce((s, r) => s + n(r.deliveryService), 0)),
    logisticsByReason: groupSum(log, (r) => r.bonusTypeName || '—', (r) => n(r.deliveryService)),
    byDate: groupSum(prevRows, (r) => day(r.rrDate), (r) => n(r.penalty)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export { n as num, day, round };
