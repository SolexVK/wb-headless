// lib/wbFinance.js — финансовые отчёты Wildberries (штрафы, удержания, затраты).
//
// Источник данных: WB Finance API (раздел «Документы и бухгалтерия» →
// «Финансовые отчёты»), https://dev.wildberries.ru/docs/openapi/financial-reports
//   • POST /api/finance/v1/sales-reports/list      — список отчётов реализации
//     с контрольными суммами (штрафы, хранение, приёмка, удержания, доплаты);
//   • POST /api/finance/v1/sales-reports/detailed  — ПОСТРОЧНАЯ детализация
//     за период: та самая, где у каждой операции видны penalty/bonusTypeName.
//
// Токен: категория «Финансы» (Профиль → Настройки → Доступ к API).
// Ищется резолвером lib/wbToken.js: WB_API_TOKEN → Wildberries_API → .env.
//
// ЛИМИТЫ (снимок доки — docs/wb-api/limits.md и страницы методов):
//   Оба метода: 1 запрос в минуту на аккаунт, всплеск 1 (Персональный,
//   Сервисный, Базовый с секретом). Базовый токен — 2 запроса в 24 ч.
//   Поэтому запросы идут через WbClient с ПЕРСОНАЛЬНЫМ ведром на каждый
//   метод (methodLimit): клиент сам выдерживает паузу и не доводит до 429,
//   а на 429 ждёт ровно X-Ratelimit-Retry секунд. Это важно: детализация
//   постраничная, и «залпом» её выгрузить нельзя — WB отдаст 429.
//
// Пагинация: начинаем с rrdId=0, дальше передаём rrdId последней строки
// предыдущего ответа. Повторяем, пока не придёт 204 (нет данных).

import { WbClient } from './wbClient.js';

const SALES_REPORTS_LIST = '/api/finance/v1/sales-reports/list';
const SALES_REPORTS_DETAILED = '/api/finance/v1/sales-reports/detailed';

// Лимит обоих методов: 1 запрос в минуту, всплеск 1 (см. шапку модуля).
const ONE_PER_MINUTE = { limit: 1, periodSec: 60, burst: 1 };

// Строк в одном ответе. Максимум по доке — 100000.
const PAGE_LIMIT = Math.min(Number(process.env.WB_FINANCE_PAGE_LIMIT) || 100000, 100000);

// Страховка от бесконечной пагинации.
const MAX_PAGES = Number(process.env.WB_FINANCE_MAX_PAGES) || 30;

let sharedClient = null;
/** Клиент с общими вёдрами лимитов: один на процесс, иначе лимиты не соблюсти. */
export function financeClient() {
  if (!sharedClient) {
    sharedClient = new WbClient({
      timeoutMs: Number(process.env.WB_TIMEOUT_MS) || 120000,
    });
  }
  return sharedClient;
}

/** Для тестов: подменить клиента (или сбросить, передав null). */
export function setFinanceClient(client) {
  sharedClient = client;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const str = (v) => (v == null ? '' : String(v).trim());
/** Первое непустое из нескольких возможных имён поля. */
const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] != null && row[k] !== '') return row[k];
  return null;
};

/**
 * Приводит строку детализации к единому виду.
 * Finance API отдаёт camelCase и числа СТРОКАМИ ("367", "12647.29"), старая
 * статистика v5 — snake_case. Читаем оба варианта, чтобы отчёт не сломался,
 * если WB отдаст данные в другом формате.
 */
export function normalizeDetailRow(row) {
  return {
    reportId: num(pick(row, 'reportId', 'realizationreport_id')),
    dateFrom: str(pick(row, 'dateFrom', 'date_from')).slice(0, 10),
    dateTo: str(pick(row, 'dateTo', 'date_to')).slice(0, 10),
    rrdId: num(pick(row, 'rrdId', 'rrd_id')),
    nmId: num(pick(row, 'nmId', 'nm_id')),
    sellerArticle: str(pick(row, 'vendorCode', 'sa_name')),   // артикул продавца
    subject: str(pick(row, 'subjectName', 'subject_name')),
    brand: str(pick(row, 'brandName', 'brand_name')),
    size: str(pick(row, 'techSize', 'ts_name')),
    barcode: str(pick(row, 'sku', 'barcode')),
    docType: str(pick(row, 'docTypeName', 'doc_type_name')),  // Продажа / Возврат
    operation: str(pick(row, 'sellerOperName', 'supplier_oper_name')),
    bonusType: str(pick(row, 'bonusTypeName', 'bonus_type_name')), // ПРИЧИНА штрафа
    officeName: str(pick(row, 'officeName', 'office_name')),
    quantity: num(pick(row, 'quantity')),
    retailAmount: num(pick(row, 'retailAmount', 'retail_amount')),
    retailPrice: num(pick(row, 'retailPrice', 'retail_price')),
    forPay: num(pick(row, 'forPay', 'ppvz_for_pay')),         // к перечислению
    commissionPercent: num(pick(row, 'commissionPercent', 'commission_percent')),
    acquiringFee: num(pick(row, 'acquiringFee', 'acquiring_fee')),
    logistics: num(pick(row, 'deliveryService', 'delivery_rub')),  // логистика, ₽
    deliveryAmount: num(pick(row, 'deliveryAmount', 'delivery_amount')),
    returnAmount: num(pick(row, 'returnAmount', 'return_amount')),
    storage: num(pick(row, 'paidStorage', 'storage_fee')),        // хранение, ₽
    acceptance: num(pick(row, 'paidAcceptance', 'acceptance')),   // приёмка, ₽
    penalty: num(pick(row, 'penalty')),                            // штраф, ₽
    deduction: num(pick(row, 'deduction')),                        // удержание, ₽
    additionalPayment: num(pick(row, 'additionalPayment', 'additional_payment')),
    rebillLogisticCost: num(pick(row, 'rebillLogisticCost', 'rebill_logistic_cost')),
    deliveryMethod: str(pick(row, 'deliveryMethod')),
    saleDt: str(pick(row, 'saleDt', 'sale_dt')).slice(0, 10),
    srid: str(pick(row, 'srid')),
  };
}

/** Контрольные суммы одного отчёта реализации (из списка отчётов). */
export function normalizeReportSummary(row) {
  return {
    reportId: num(pick(row, 'reportId', 'realizationreport_id')),
    dateFrom: str(pick(row, 'dateFrom')).slice(0, 10),
    dateTo: str(pick(row, 'dateTo')).slice(0, 10),
    createDate: str(pick(row, 'createDate')).slice(0, 10),
    retailAmount: num(pick(row, 'retailAmountSum')),
    forPay: num(pick(row, 'forPaySum')),
    logistics: num(pick(row, 'deliveryServiceSum')),
    storage: num(pick(row, 'paidStorageSum')),
    acceptance: num(pick(row, 'paidAcceptanceSum')),
    deduction: num(pick(row, 'deductionSum')),
    penalty: num(pick(row, 'penaltySum')),
    additionalPayment: num(pick(row, 'additionalPaymentSum')),
    bankPayment: num(pick(row, 'bankPaymentSum')),
  };
}

/**
 * Список отчётов реализации за период — с контрольными суммами WB.
 * Нужен, чтобы СВЕРИТЬ наши расчёты с тем, что WB показывает в кабинете.
 *
 * @returns {Promise<Array>} нормализованные сводки отчётов
 */
export async function fetchSalesReportsList({ dateFrom, dateTo, period = 'weekly', limit = 1000 } = {}) {
  const { status, data } = await financeClient().request('finance', SALES_REPORTS_LIST, {
    method: 'POST',
    body: { dateFrom, dateTo, period, limit },
    methodLimit: ONE_PER_MINUTE,
  });
  if (status === 204 || !Array.isArray(data)) return [];
  return data.map(normalizeReportSummary);
}

/**
 * Постраничная выгрузка детализации к отчётам реализации за период.
 * Идём по курсору rrdId, пока WB не ответит 204 «нет данных».
 *
 * @param {object} opts
 * @param {string} opts.dateFrom  YYYY-MM-DD (время — МСК, UTC+3)
 * @param {string} opts.dateTo    YYYY-MM-DD
 * @param {'weekly'|'daily'} [opts.period]
 * @param {function} [opts.onPage] колбэк прогресса
 * @returns {Promise<{rows: Array, pages: number, truncated: boolean}>}
 */
export async function fetchSalesReportDetailed({
  dateFrom,
  dateTo,
  period = 'weekly',
  limit = PAGE_LIMIT,
  onPage,
} = {}) {
  const client = financeClient();
  const rows = [];
  let rrdId = 0;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const { status, data } = await client.request('finance', SALES_REPORTS_DETAILED, {
      method: 'POST',
      body: { dateFrom, dateTo, period, limit, rrdId },
      methodLimit: ONE_PER_MINUTE,
    });
    pages += 1;

    // 204 «Нет данных» — сигнал конца выгрузки по документации WB.
    const batch = status === 204 || !Array.isArray(data) ? [] : data;
    for (const raw of batch) rows.push(normalizeDetailRow(raw));
    if (onPage) onPage({ page: pages, received: batch.length, total: rows.length });

    if (batch.length === 0) break;

    const nextRrdId = num(pick(batch[batch.length - 1], 'rrdId', 'rrd_id'));
    // Курсор не сдвинулся — дальше идти некуда (иначе зациклимся на лимите 1/мин).
    if (!nextRrdId || nextRrdId === rrdId) break;
    rrdId = nextRrdId;

    // Ответ короче лимита — страница последняя, лишний запрос не тратим:
    // он всё равно стоил бы минуты ожидания.
    if (batch.length < limit) break;

    if (pages >= MAX_PAGES) truncated = true;
  }

  return { rows, pages, truncated };
}

export { SALES_REPORTS_LIST, SALES_REPORTS_DETAILED, ONE_PER_MINUTE, PAGE_LIMIT };
