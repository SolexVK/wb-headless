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
    clientDeclineRub: Math.round(moneyTot.declinedClient), // справочно: отмена в 1-й час — НЕ потеря
  };
  // Отмену клиентом в 1-й час (declinedClient) в график причин НЕ включаем: заказ
  // отменён до сборки/отправки — реальных денег по нему нет; показываем справочно отдельно.
  const reasons = CANCEL_CATS
    .filter((c) => c.blame !== 'ok' && c.blame !== 'na' && c.key !== 'declinedClient' && catTot[c.key] > 0)
    .map((c) => ({ key: c.key, ru: c.ru, blame: c.blame, count: catTot[c.key], rub: Math.round(moneyTot[c.key]) }))
    .sort((a, b) => b.rub - a.rub || b.count - a.count);

  return {
    totals, byFF: rows, reasons,
    worst: rows.length && (rows[0].lostRub > 0 || rows[0].sellerCancel > 0)
      ? { ff: rows[0].ff, lostRub: rows[0].lostRub, sellerCancel: rows[0].sellerCancel, sellerCancelPct: rows[0].sellerCancelPct }
      : null,
  };
}

// ДЕНЬГИ ИЗ РЕАЛИЗАЦИИ: штрафы, удержания и обратная логистика по ФФ.
//   details  — «сырые» строки finance-детализации (fetchFinanceDetail)
//   ridToFF  — Map(srid → { ff, warehouseId }); только НАШИ FBS-заказы (srid = rid)
// «Потери по вине ФФ (деньги)» = штраф + обратная логистика возвратов. `deduction`
// шумный (подписки WB/Джем/Продвижение/хранение) → показываем ОТДЕЛЬНО, с разбивкой
// по причине (bonusTypeName), НЕ вмешивая в потери ФФ.
export function buildMoney(details, ridToFF) {
  const num = (v) => Number(v) || 0;
  const rnd = (x) => Math.round(x);
  const byFF = new Map(); const byReason = new Map();
  let matched = 0, unmatched = 0;
  const tot = { penalty: 0, deduction: 0, returnLogistics: 0, rows: 0 };
  for (const d of details || []) {
    const ff = ridToFF.get(String(d.srid));
    if (!ff) { unmatched++; continue; }               // не наш FBS-заказ (FBW/вне окна)
    matched++;
    const penalty = num(d.penalty);
    const deduction = num(d.deduction);
    const isReturn = String(d.docTypeName || '') === 'Возврат';
    const retLog = (isReturn ? num(d.deliveryAmount) : 0) + num(d.rebillLogisticCost);
    if (!byFF.has(ff.ff)) byFF.set(ff.ff, { ff: ff.ff, warehouseId: ff.warehouseId, penalty: 0, deduction: 0, returnLogistics: 0, rows: 0 });
    const g = byFF.get(ff.ff);
    g.penalty += penalty; g.deduction += deduction; g.returnLogistics += retLog; g.rows++;
    tot.penalty += penalty; tot.deduction += deduction; tot.returnLogistics += retLog; tot.rows++;
    if (penalty || deduction) {
      const reason = d.bonusTypeName || d.sellerOperName || '—';
      if (!byReason.has(reason)) byReason.set(reason, { reason, penalty: 0, deduction: 0, count: 0 });
      const r = byReason.get(reason); r.penalty += penalty; r.deduction += deduction; r.count++;
    }
  }
  const rows = [...byFF.values()].map((g) => ({
    ff: g.ff, warehouseId: g.warehouseId,
    penalty: rnd(g.penalty), deduction: rnd(g.deduction), returnLogistics: rnd(g.returnLogistics),
    ffLossRub: rnd(g.penalty + g.returnLogistics), rows: g.rows,
  })).sort((a, b) => b.ffLossRub - a.ffLossRub || b.penalty - a.penalty);
  const reasons = [...byReason.values()]
    .map((r) => ({ reason: r.reason, penalty: rnd(r.penalty), deduction: rnd(r.deduction), rub: rnd(r.penalty + r.deduction), count: r.count }))
    .sort((a, b) => b.rub - a.rub).slice(0, 30);
  return {
    available: true, matched, unmatched,
    totals: { penalty: rnd(tot.penalty), deduction: rnd(tot.deduction), returnLogistics: rnd(tot.returnLogistics), ffLossRub: rnd(tot.penalty + tot.returnLogistics), rows: tot.rows },
    byFF: rows, reasons,
  };
}

// СВОДКА ПО ФФ: сшивка «скорость сборки ↔ отказы ↔ деньги» в одну строку на ФФ.
//   cancelsRows   — buildCancels(...).byFF (sellerCancel, sellerCancelPct, lostRub)
//   assemblyByFF  — buildAssembly(...).byFF (medianHours, made, processed) | []
//   moneyRows     — buildMoney(...).byFF (penalty, returnLogistics, deduction, ffLossRub) | []
// totalLossRub = упущенная выручка от отказов ФФ + денежные потери (штраф+обр.логистика).
export function buildScorecard(cancelsRows, assemblyByFF, moneyRows) {
  const c = new Map((cancelsRows || []).map((r) => [r.ff, r]));
  const a = new Map((assemblyByFF || []).map((r) => [r.ff, r]));
  const m = new Map((moneyRows || []).map((r) => [r.ff, r]));
  const names = new Set([...c.keys(), ...a.keys(), ...m.keys()]);
  return [...names].map((ff) => {
    const cc = c.get(ff) || {}; const aa = a.get(ff) || {}; const mm = m.get(ff) || {};
    const cancelLost = cc.lostRub || 0;
    const moneyLoss = mm.ffLossRub || 0;
    return {
      ff, asmMedianHours: aa.medianHours ?? null, made: cc.made ?? (aa.made ?? 0),
      sellerCancel: cc.sellerCancel || 0, sellerCancelPct: cc.sellerCancelPct || 0,
      cancelLostRub: cancelLost, penaltyRub: mm.penalty || 0, returnLogRub: mm.returnLogistics || 0, deductionRub: mm.deduction || 0,
      totalLossRub: cancelLost + moneyLoss,
    };
  }).sort((x, y) => y.totalLossRub - x.totalLossRub || y.sellerCancel - x.sellerCancel);
}
