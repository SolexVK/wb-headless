// scripts/lib/agg/cancels.mjs — чистый агрегатор отчёта «Отказы по фулфилментам».
// Отвечает на вопрос собственника: какой ФФ проваливает заказы и во что это обходится.
// Источник — сборочные задания (/api/v3/orders → warehouseId = ФФ) + их статусы
// (/api/v3/orders/status → supplierStatus/wbStatus). Логика чистая (без сети), чтобы
// покрыть юнит-тестами на фиксированных входах (smoke-agg.mjs).
import { r2 } from './stats.mjs';

// Классификация исхода ОДНОГО сборочного задания по паре статусов WB.
//   supplierStatus (действие продавца): new | confirm | complete | cancel | cancel_carrier
//   wbStatus (система WB): waiting | sorted | sold | canceled | canceled_by_client |
//                          declined_by_client | defect | ready_for_pickup | …
// Возвращает ключ категории-исхода.
export function classify(supplierStatus, wbStatus) {
  const sup = String(supplierStatus || '');
  const wb = String(wbStatus || '');
  if (wb === 'sold') return 'sold';                       // выкуплено — успех
  if (wb === 'defect') return 'defect';                   // брак
  if (wb === 'declined_by_client') return 'declinedClient'; // отмена клиентом в 1-й час
  if (wb === 'canceled_by_client') return 'canceledClient'; // отказ клиента при получении
  if (sup === 'cancel' || wb === 'canceled') return 'cancelSeller'; // отменено продавцом = ФФ
  if (sup === 'cancel_carrier' || wb === 'canceled_by_carrier') return 'canceledCarrier';
  if (!sup && !wb) return 'unknown';                      // статус не отдан (вне окна ретеншена)
  return 'inWork';                                        // new/confirm/complete/waiting/… — не финал
}

// Каталог категорий (порядок = порядок в UI). blame: ff | client | other | ok | na.
export const CANCEL_CATS = [
  { key: 'sold', ru: 'Выкуплено', blame: 'ok' },
  { key: 'cancelSeller', ru: 'Отказ ФФ (отменено продавцом)', blame: 'ff' },
  { key: 'defect', ru: 'Брак', blame: 'ff' },
  { key: 'canceledClient', ru: 'Отказ клиента при получении', blame: 'client' },
  { key: 'declinedClient', ru: 'Отмена клиентом (1-й час)', blame: 'client' },
  { key: 'canceledCarrier', ru: 'Отмена перевозчиком', blame: 'other' },
  { key: 'inWork', ru: 'В работе', blame: 'ok' },
  { key: 'unknown', ru: 'Без статуса', blame: 'na' },
];
export const CANCEL_RU = Object.fromEntries(CANCEL_CATS.map((c) => [c.key, c.ru]));

// Основной агрегатор.
//   orders   — [{ id, ff, warehouseId, createdAt, priceRub, article, nmId }]
//   statusOf — (order) → { supplierStatus, wbStatus } | null
// «Потери по вине/зоне ФФ» = упущенная выручка по отказам продавца + браку. Клиентский
// отказ при получении считаем отдельно (обратная логистика ложится на нас, но вина смешанная).
export function buildCancels(orders, statusOf) {
  const byFF = new Map();
  const catTot = {}; const moneyTot = {};
  for (const c of CANCEL_CATS) { catTot[c.key] = 0; moneyTot[c.key] = 0; }
  let withStatus = 0;
  for (const o of orders) {
    const st = statusOf(o) || {};
    const cat = classify(st.supplierStatus, st.wbStatus);
    if (cat !== 'unknown') withStatus++;
    const price = Number(o.priceRub) || 0;
    if (!byFF.has(o.ff)) byFF.set(o.ff, { ff: o.ff, warehouseId: o.warehouseId, made: 0, cats: {}, money: {} });
    const g = byFF.get(o.ff);
    g.made++;
    g.cats[cat] = (g.cats[cat] || 0) + 1;
    g.money[cat] = (g.money[cat] || 0) + price;
    catTot[cat] += 1;
    moneyTot[cat] += price;
  }
  const rows = [...byFF.values()].map((g) => {
    const c = (k) => g.cats[k] || 0;
    const m = (k) => Math.round(g.money[k] || 0);
    const decided = g.made - c('inWork') - c('unknown');
    const sellerCancel = c('cancelSeller');
    const defect = c('defect');
    return {
      ff: g.ff, warehouseId: g.warehouseId, made: g.made, decided, sold: c('sold'),
      sellerCancel, clientRefusal: c('canceledClient'), clientDecline: c('declinedClient'),
      defect, carrier: c('canceledCarrier'), inWork: c('inWork'), unknown: c('unknown'),
      sellerCancelPct: decided ? r2((sellerCancel / decided) * 100) : 0,
      failCount: sellerCancel + defect,
      lostRub: m('cancelSeller') + m('defect'),
      clientRefusalRub: m('canceledClient'),
    };
  }).sort((a, b) => b.lostRub - a.lostRub || b.sellerCancel - a.sellerCancel);

  const made = orders.length;
  const decidedAll = made - catTot.inWork - catTot.unknown;
  const totals = {
    made, withStatus, decided: decidedAll, sold: catTot.sold,
    sellerCancel: catTot.cancelSeller, clientRefusal: catTot.canceledClient, clientDecline: catTot.declinedClient,
    defect: catTot.defect, carrier: catTot.canceledCarrier, inWork: catTot.inWork, unknown: catTot.unknown,
    sellerCancelPct: decidedAll ? r2((catTot.cancelSeller / decidedAll) * 100) : 0,
    lostRub: Math.round(moneyTot.cancelSeller + moneyTot.defect),
    clientRefusalRub: Math.round(moneyTot.canceledClient),
  };
  const reasons = CANCEL_CATS
    .filter((c) => c.blame !== 'ok' && c.blame !== 'na' && catTot[c.key] > 0)
    .map((c) => ({ key: c.key, ru: c.ru, blame: c.blame, count: catTot[c.key], rub: Math.round(moneyTot[c.key]) }))
    .sort((a, b) => b.rub - a.rub || b.count - a.count);

  return {
    totals, byFF: rows, reasons,
    worst: rows.length && (rows[0].lostRub > 0 || rows[0].sellerCancel > 0)
      ? { ff: rows[0].ff, lostRub: rows[0].lostRub, sellerCancel: rows[0].sellerCancel, sellerCancelPct: rows[0].sellerCancelPct }
      : null,
  };
}
