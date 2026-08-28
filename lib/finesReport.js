// lib/finesReport.js — отчёт «Штрафы и затраты на Wildberries».
//
// Что показывает и зачем: продавец видит выручку, но не видит, СКОЛЬКО у него
// забирает площадка и ЗА ЧТО. Отчёт раскладывает удержания WB на статьи,
// показывает долю каждой в выручке и находит SKU, которые «съедают» прибыль.
//
// Источник — детализация к отчётам реализации WB Finance API
// (POST /api/finance/v1/sales-reports/detailed, см. lib/wbFinance.js).
// Это тот же документ, по которому WB считает выплату, поэтому цифры сходятся
// с еженедельным отчётом в кабинете. Дополнительно сверяемся с контрольными
// суммами самого WB из списка отчётов (/sales-reports/list).
//
// МЕТОДОЛОГИЯ (прозрачная и воспроизводимая):
//
//   1. Строки продаж и возвратов берём со знаком: возврат/сторно уменьшает
//      выручку и сумму к перечислению. Знак определяем по doc_type_name
//      («Возврат») и по названию операции («возврат», «сторно продаж»).
//        Выручка (Пр)   = Σ retailAmount × знак
//        К перечислению = Σ forPay        × знак
//
//   2. Комиссия WB = Выручка − К перечислению. Это удержание площадки с
//      продажи целиком: собственно комиссия + эквайринг + вознаграждение ПВЗ.
//      Эквайринг (acquiring_fee) показываем отдельной справочной строкой —
//      он уже ВНУТРИ комиссии, второй раз не суммируется.
//
//   3. Остальные статьи — это отдельные колонки отчёта, поэтому просто
//      суммируются по всем строкам (двойного счёта нет):
//        логистика       deliveryService
//        хранение        paidStorage
//        платная приёмка paidAcceptance
//        штрафы          penalty          ← причина в bonusTypeName
//        удержания       deduction        (может быть < 0 = выплата продавцу)
//        доплаты         additionalPayment (в пользу продавца, УМЕНЬШАЕТ затраты)
//
//   4. Итого затрат = комиссия + логистика + хранение + приёмка + штрафы
//                     + удержания − доплаты
//      Доля затрат = Итого затрат / Выручка × 100 %
//
//   5. Разрезы: по причинам штрафов (bonusTypeName), по видам удержаний,
//      по операциям, по SKU и по отчётным неделям (reportId).
//      Строки без артикула (общие удержания, хранение «на кабинет») попадают
//      в псевдо-SKU «Без привязки к товару» — чтобы сумма по SKU сходилась
//      с итогом.

import { fetchSalesReportDetailed, fetchSalesReportsList } from './wbFinance.js';

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};

const pct = (part, whole) => (whole ? round((part / whole) * 100, 1) : 0);

/** Строки без артикула WB (общие удержания, хранение, приёмка «на кабинет»). */
export const NO_SKU_LABEL = 'Без привязки к товару';

/** Причина штрафа/удержания, когда WB её не заполнил. */
const NO_REASON = 'Причина не указана';

/**
 * Знак строки: возвраты и сторно уменьшают выручку и выплату.
 * WB отдаёт такие строки с положительными суммами, различая их
 * в doc_type_name / supplier_oper_name.
 */
export function rowSign(row) {
  const isReturnDoc = /возврат/i.test(row.docType || '');
  const isReturnOper = /возврат|сторно продаж/i.test(row.operation || '');
  return isReturnDoc || isReturnOper ? -1 : 1;
}

/** Пустая «копилка» статей затрат — используется и в итогах, и в разрезах. */
function emptyBucket() {
  return {
    units: 0,
    retail: 0,
    forPay: 0,
    acquiring: 0,
    logistics: 0,
    storage: 0,
    acceptance: 0,
    penalty: 0,
    deduction: 0,
    additionalPayment: 0,
    rebillLogistic: 0,
    deliveries: 0,
    returns: 0,
    rows: 0,
  };
}

/** Накопление одной строки отчёта в «копилку». */
function addRow(b, row) {
  const sign = rowSign(row);
  b.rows += 1;
  b.units += sign * row.quantity;
  b.retail += sign * row.retailAmount;
  b.forPay += sign * row.forPay;
  b.acquiring += row.acquiringFee;
  b.logistics += row.logistics;
  b.storage += row.storage;
  b.acceptance += row.acceptance;
  b.penalty += row.penalty;
  b.deduction += row.deduction;
  b.additionalPayment += row.additionalPayment;
  b.rebillLogistic += row.rebillLogisticCost;
  b.deliveries += row.deliveryAmount;
  b.returns += row.returnAmount;
  return b;
}

/**
 * Считает производные показатели «копилки»: комиссию, итог затрат, доли.
 */
export function finalizeBucket(b) {
  // Комиссия площадки = что реализовано минус что нам перечислят за товар.
  const commission = b.retail - b.forPay;
  const total =
    commission + b.logistics + b.storage + b.acceptance + b.penalty + b.deduction - b.additionalPayment;

  return {
    rows: b.rows,
    units: round(b.units, 0),
    revenue: round(b.retail, 2),
    forPay: round(b.forPay, 2),
    commission: round(commission, 2),
    commissionPct: pct(commission, b.retail),
    acquiring: round(b.acquiring, 2),
    logistics: round(b.logistics, 2),
    logisticsPct: pct(b.logistics, b.retail),
    storage: round(b.storage, 2),
    storagePct: pct(b.storage, b.retail),
    acceptance: round(b.acceptance, 2),
    acceptancePct: pct(b.acceptance, b.retail),
    penalty: round(b.penalty, 2),
    penaltyPct: pct(b.penalty, b.retail),
    deduction: round(b.deduction, 2),
    deductionPct: pct(b.deduction, b.retail),
    additionalPayment: round(b.additionalPayment, 2),
    rebillLogistic: round(b.rebillLogistic, 2),
    totalCosts: round(total, 2),
    costSharePct: pct(total, b.retail),
    netPayout: round(b.retail - total, 2),
    deliveries: round(b.deliveries, 0),
    returns: round(b.returns, 0),
    buyoutPct: b.deliveries > 0 ? pct(b.deliveries - b.returns, b.deliveries) : null,
    logisticsPerDelivery: b.deliveries > 0 ? round(b.logistics / b.deliveries, 2) : 0,
    costsPerUnit: b.units > 0 ? round(total / b.units, 2) : 0,
  };
}

/** Группировка строк по ключу с накоплением в «копилку». */
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, { key, bucket: emptyBucket(), sample: { ...row } });
    const entry = map.get(key);
    addRow(entry.bucket, row);
    // WB заполняет карточные поля не в каждой строке (у строк хранения или
    // штрафа бывает пусто) — добираем первое непустое значение по группе.
    for (const f of ['sellerArticle', 'subject', 'brand']) {
      if (!entry.sample[f] && row[f]) entry.sample[f] = row[f];
    }
  }
  return map;
}

/**
 * Разрез по причинам: берём строки, где сумма по нужной колонке ≠ 0,
 * и группируем по bonus_type_name (причина в терминах WB).
 * Если причина пустая — подставляем название операции, иначе NO_REASON.
 */
function byReason(rows, field) {
  const map = new Map();
  let totalAmount = 0;

  for (const row of rows) {
    const amount = row[field];
    if (!amount) continue;
    const reason = row.bonusType || row.operation || NO_REASON;
    if (!map.has(reason)) map.set(reason, { reason, amount: 0, rows: 0, skus: new Map() });
    const item = map.get(reason);
    item.amount += amount;
    item.rows += 1;
    totalAmount += amount;

    const skuKey = row.nmId || NO_SKU_LABEL;
    const prev = item.skus.get(skuKey) || { nmId: row.nmId || null, seller: row.sellerArticle, amount: 0 };
    prev.amount += amount;
    if (!prev.seller && row.sellerArticle) prev.seller = row.sellerArticle;
    item.skus.set(skuKey, prev);
  }

  return [...map.values()]
    .map((it) => ({
      reason: it.reason,
      amount: round(it.amount, 2),
      rows: it.rows,
      sharePct: pct(it.amount, totalAmount),
      topSkus: [...it.skus.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3)
        .map((s) => ({ ...s, amount: round(s.amount, 2) })),
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** Разрез по операциям WB (Продажа, Логистика, Штрафы, Хранение…). */
function byOperation(rows) {
  const map = groupBy(rows, (r) => r.operation || 'Без названия операции');
  return [...map.values()]
    .map(({ key, bucket }) => {
      const f = finalizeBucket(bucket);
      return {
        operation: key,
        rows: f.rows,
        revenue: f.revenue,
        logistics: f.logistics,
        storage: f.storage,
        acceptance: f.acceptance,
        penalty: f.penalty,
        deduction: f.deduction,
        additionalPayment: f.additionalPayment,
      };
    })
    .sort((a, b) => b.rows - a.rows);
}

/** Разрез по SKU. sellerNames — карта nmId → артикул продавца из config/skus.json. */
function bySku(rows, sellerNames = new Map()) {
  const map = groupBy(rows, (r) => r.nmId || NO_SKU_LABEL);
  return [...map.values()]
    .map(({ key, bucket, sample }) => {
      const nmId = typeof key === 'number' ? key : null;
      const f = finalizeBucket(bucket);
      return {
        sku: nmId,
        // Артикул продавца: сперва из отчёта WB (sa_name), затем из config/skus.json.
        seller: sample.sellerArticle || sellerNames.get(String(nmId)) || (nmId ? '' : NO_SKU_LABEL),
        subject: sample.subject,
        brand: sample.brand,
        ...f,
      };
    })
    .sort((a, b) => b.totalCosts - a.totalCosts);
}

/** Разрез по отчётным неделям WB (номер отчёта о реализации). */
function byWeek(rows) {
  const map = groupBy(rows, (r) => r.reportId || 0);
  return [...map.values()]
    .map(({ key, bucket, sample }) => ({
      reportId: key || null,
      dateFrom: sample.dateFrom,
      dateTo: sample.dateTo,
      ...finalizeBucket(bucket),
    }))
    .sort((a, b) => String(a.dateFrom).localeCompare(String(b.dateFrom)));
}

/**
 * Короткие выводы «на цифрах» — то, ради чего отчёт и собирается.
 * Пороги вынесены в константы: их легко подкрутить под свою экономику.
 */
const THRESHOLDS = {
  costShareHigh: 45,      // доля всех удержаний в выручке, % — выше = тревога
  logisticsHigh: 20,      // доля логистики в выручке, %
  storageHigh: 5,         // доля хранения в выручке, %
  penaltyHigh: 1,         // доля штрафов в выручке, %
  buyoutLow: 60,          // выкуп, % — ниже = логистика съедает маржу
  skuMinRevenue: 1000,    // ниже этой выручки SKU не разбираем (шум)
};

export function buildInsights(totals, skuRows) {
  const out = [];
  const items = [
    ['комиссия WB', totals.commission, totals.commissionPct],
    ['логистика', totals.logistics, totals.logisticsPct],
    ['хранение', totals.storage, totals.storagePct],
    ['платная приёмка', totals.acceptance, totals.acceptancePct],
    ['штрафы', totals.penalty, totals.penaltyPct],
    ['прочие удержания', totals.deduction, totals.deductionPct],
  ].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);

  if (items.length) {
    const top = items.slice(0, 3).map(([name, amount, share]) => `${name} ${Math.round(amount)} ₽ (${share}%)`);
    out.push(`Главные статьи удержаний: ${top.join(', ')}.`);
  }

  if (totals.costSharePct >= THRESHOLDS.costShareHigh) {
    out.push(
      `Площадка забирает ${totals.costSharePct}% выручки — это выше ориентира ` +
      `${THRESHOLDS.costShareHigh}%. При марже ниже этого уровня продажи убыточны.`
    );
  }
  if (totals.logisticsPct >= THRESHOLDS.logisticsHigh) {
    out.push(
      `Логистика ${totals.logisticsPct}% выручки (${Math.round(totals.logistics)} ₽). ` +
      `Обычно это низкий выкуп или габариты: проверьте размерную сетку, фото и описание.`
    );
  }
  if (totals.buyoutPct != null && totals.buyoutPct < THRESHOLDS.buyoutLow) {
    out.push(
      `Выкуп ${totals.buyoutPct}% при ${totals.deliveries} доставках — каждый невыкуп ` +
      `оплачивается логистикой в обе стороны (в среднем ${totals.logisticsPerDelivery} ₽ за доставку).`
    );
  }
  if (totals.storagePct >= THRESHOLDS.storageHigh) {
    out.push(
      `Хранение ${totals.storagePct}% выручки (${Math.round(totals.storage)} ₽) — ` +
      `признак затоваренности: неликвид лучше вывезти или распродать.`
    );
  }
  if (totals.penalty > 0) {
    const level = totals.penaltyPct >= THRESHOLDS.penaltyHigh ? 'много' : 'в пределах нормы';
    out.push(`Штрафы: ${Math.round(totals.penalty)} ₽ (${totals.penaltyPct}% выручки) — ${level}.`);
  }
  if (totals.additionalPayment > 0) {
    out.push(`WB доплатил ${Math.round(totals.additionalPayment)} ₽ (компенсации) — учтено в итоге со знаком минус.`);
  }

  // Самые «дорогие» товары: удержания съедают больше половины их выручки.
  const problem = skuRows
    .filter((r) => r.sku && r.revenue >= THRESHOLDS.skuMinRevenue && r.costSharePct >= 50)
    .slice(0, 5);
  if (problem.length) {
    out.push(
      'Товары, где удержания ≥ 50% выручки: ' +
      problem.map((r) => `${r.seller || r.sku} (${r.costSharePct}%)`).join(', ') + '.'
    );
  }

  return out;
}

/**
 * Сверка с контрольными суммами WB: берём список отчётов реализации за период
 * и сравниваем итоги WB с тем, что насчитали по строкам. Расхождение больше
 * рубля — повод не доверять цифрам (например, детализация выгрузилась не вся).
 * Сверка необязательна: если метод недоступен (токен без категории «Финансы»),
 * отчёт всё равно строится, а причина уходит в warnings.
 */
async function buildControl(d1, d2, period, totals, filtered) {
  const reports = await fetchSalesReportsList({ dateFrom: d1, dateTo: d2, period });
  if (!reports.length) return null;

  const sum = (key) => round(reports.reduce((acc, r) => acc + r[key], 0), 2);
  const wb = {
    revenue: sum('retailAmount'),
    forPay: sum('forPay'),
    logistics: sum('logistics'),
    storage: sum('storage'),
    acceptance: sum('acceptance'),
    penalty: sum('penalty'),
    deduction: sum('deduction'),
    additionalPayment: sum('additionalPayment'),
    bankPayment: sum('bankPayment'),
  };
  const keys = Object.keys(wb).filter((k) => k !== 'bankPayment');
  const diff = {};
  for (const k of keys) diff[k] = round(totals[k] - wb[k], 2);

  return {
    source: 'WB, /api/finance/v1/sales-reports/list',
    reports: reports.length,
    wb,
    diff,
    // При фильтре по товарам расхождение ожидаемо: сверять можно только целый кабинет.
    matches: filtered ? null : keys.every((k) => Math.abs(diff[k]) <= 1),
  };
}

/**
 * Строит отчёт по штрафам и затратам за период [d1, d2].
 *
 * @param {object}  opts
 * @param {string}  opts.d1        начало периода, YYYY-MM-DD
 * @param {string}  opts.d2        конец периода, YYYY-MM-DD
 * @param {'weekly'|'daily'} [opts.period='weekly'] периодичность отчётов WB
 * @param {Array}   [opts.items]   [{wb, seller}] — если задано, отчёт только по этим SKU
 * @param {boolean} [opts.control=true] сверять итоги с контрольными суммами WB
 * @param {Array}   [opts.rows]    готовые строки (для тестов — тогда WB не опрашивается)
 * @returns {Promise<object>} отчёт
 */
export async function buildFinesReport({
  d1,
  d2,
  period = 'weekly',
  items,
  rows: rawRows,
  control = true,
  onPage,
} = {}) {
  if (!d1 || !d2) throw new Error('Не задан период отчёта (d1, d2).');

  const fetched = rawRows
    ? { rows: rawRows, pages: 0, truncated: false }
    : await fetchSalesReportDetailed({ dateFrom: d1, dateTo: d2, period, onPage });

  const allRows = fetched.rows;

  // Ограничение выборки товарами из config (группа/фильтр). Строки без
  // артикула (общие удержания) при активном фильтре не берём — они
  // относятся ко всему кабинету и исказили бы картину по линейке.
  const sellerNames = new Map();
  let filterSet = null;
  if (items && items.length) {
    filterSet = new Set(items.map((it) => String(it.wb)));
    for (const it of items) sellerNames.set(String(it.wb), it.seller || '');
  }
  const rows = filterSet ? allRows.filter((r) => filterSet.has(String(r.nmId))) : allRows;

  const totalsBucket = emptyBucket();
  for (const row of rows) addRow(totalsBucket, row);
  const totals = finalizeBucket(totalsBucket);

  const skuRows = bySku(rows, sellerNames);
  const reports = [...new Map(
    rows.filter((r) => r.reportId).map((r) => [r.reportId, { id: r.reportId, dateFrom: r.dateFrom, dateTo: r.dateTo }])
  ).values()];

  const warnings = [];
  if (!allRows.length) {
    warnings.push(
      'WB вернул пустую детализацию. Это нормально, если за период не было ' +
      'закрытых отчётов о реализации (они формируются раз в неделю, по понедельникам).'
    );
  }
  if (filterSet && !rows.length && allRows.length) {
    warnings.push('Фильтр по товарам не выбрал ни одной строки — проверьте группу/фильтр.');
  }
  if (fetched.truncated) {
    warnings.push('Достигнут предел числа страниц (WB_FINANCE_MAX_PAGES) — данные неполные.');
  }

  // Сверка с итогами WB. Ошибка сверки не должна ронять отчёт: детализация
  // уже выгружена (и стоила минут ожидания на лимите 1 запрос/мин).
  let controlBlock = null;
  if (control && !rawRows) {
    try {
      controlBlock = await buildControl(d1, d2, period, totals, Boolean(filterSet));
      if (controlBlock && controlBlock.matches === false) {
        const off = Object.entries(controlBlock.diff)
          .filter(([, v]) => Math.abs(v) > 1)
          .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v} ₽`);
        warnings.push(`Расхождение с контрольными суммами WB — ${off.join(', ')}. Возможно, детализация выгрузилась не полностью.`);
      }
    } catch (err) {
      warnings.push(`Сверка с итогами WB не выполнена: ${String(err?.message || err)}`);
    }
  }

  return {
    period: { d1, d2, granularity: period },
    generatedAt: new Date().toISOString(),
    source: {
      api: 'WB Finance API, /api/finance/v1/sales-reports/detailed',
      rowsTotal: allRows.length,
      rowsUsed: rows.length,
      pages: fetched.pages,
      truncated: fetched.truncated,
      reports,
      filtered: Boolean(filterSet),
    },
    totals,
    control: controlBlock,
    fines: byReason(rows, 'penalty'),
    deductions: byReason(rows, 'deduction'),
    operations: byOperation(rows),
    bySku: skuRows,
    byWeek: byWeek(rows),
    insights: buildInsights(totals, skuRows),
    warnings,
  };
}

// ---------- CSV ----------

// Русская локаль: разделитель «;», десятичный разделитель — запятая,
// UTF-8 с BOM — чтобы Excel открывал без плясок с кодировкой.
const SEP = ';';
const cell = (v) => {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  return String(v).replace(/[;\r\n]+/g, ' ');
};
const csv = (lines) => '﻿' + lines.join('\r\n') + '\r\n';

const SKU_COLUMNS = [
  ['seller', 'Артикул продавца'],
  ['sku', 'Артикул WB'],
  ['subject', 'Предмет'],
  ['units', 'Продано, шт'],
  ['revenue', 'Выручка, ₽'],
  ['commission', 'Комиссия WB, ₽'],
  ['logistics', 'Логистика, ₽'],
  ['storage', 'Хранение, ₽'],
  ['acceptance', 'Приёмка, ₽'],
  ['penalty', 'Штрафы, ₽'],
  ['deduction', 'Удержания, ₽'],
  ['additionalPayment', 'Доплаты, ₽'],
  ['totalCosts', 'Итого затрат, ₽'],
  ['costSharePct', 'Доля затрат от выручки, %'],
  ['costsPerUnit', 'Затрат на единицу, ₽'],
  ['deliveries', 'Доставок'],
  ['returns', 'Возвратов'],
  ['buyoutPct', 'Выкуп, %'],
  ['netPayout', 'Остаётся продавцу, ₽'],
];

/** CSV по товарам: строка на SKU + итоговая строка. */
export function finesReportToCSV(report) {
  const header = SKU_COLUMNS.map(([, title]) => title).join(SEP);
  const lines = report.bySku.map((r) => SKU_COLUMNS.map(([key]) => cell(r[key])).join(SEP));

  const t = report.totals;
  const totalByKey = { ...t, seller: 'ИТОГО', sku: '', subject: '', brand: '' };
  const totalLine = SKU_COLUMNS.map(([key]) => cell(totalByKey[key] ?? '')).join(SEP);

  return csv([header, ...lines, totalLine]);
}

/** CSV по причинам: штрафы и удержания с суммами и долями. */
export function finesByReasonToCSV(report) {
  const header = ['Вид', 'Причина (bonusTypeName)', 'Сумма, ₽', 'Строк', 'Доля в виде, %', 'Топ товаров'].join(SEP);
  const line = (kind) => (r) =>
    [
      kind,
      cell(r.reason),
      cell(r.amount),
      cell(r.rows),
      cell(r.sharePct),
      cell(r.topSkus.map((s) => `${s.seller || s.nmId || '—'}: ${Math.round(s.amount)} ₽`).join(' | ')),
    ].join(SEP);

  return csv([
    header,
    ...report.fines.map(line('Штраф')),
    ...report.deductions.map(line('Удержание')),
  ]);
}
