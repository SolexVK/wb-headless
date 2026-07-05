// lib/wbJemReports.js — работа с отчётами Джем (раздел «Аналитика продавца CSV»).
//
// Источник: docs/wb-api/analytics.md → «Аналитика продавца CSV».
// Категория токена: Аналитика. Хост: seller-analytics-api.wildberries.ru.
//
// Отчёты Джем — это АСИНХРОННЫЕ CSV-отчёты с расширенной аналитикой. Схема работы:
//   1) create()  — поставить задание на генерацию (свой уникальный UUID);
//   2) list()/status() — дождаться готовности (статус в списке отчётов);
//   3) getFile() — скачать готовый отчёт (ZIP с CSV, хранится 48 часов);
//   4) retry()   — пересоздать задание, если статус FAILED.
//
// Ограничения (из доки метода):
//   • подписка Джем обязательна для всех типов, КРОМE отчётов по остаткам
//     (STOCK_HISTORY_REPORT_CSV, STOCK_HISTORY_DAILY_CSV);
//   • период отчёта — максимум 1 год (отчёты по остаткам — 3 месяца);
//   • максимум 20 сгенерированных отчётов в сутки;
//   • готовый отчёт хранится 48 часов;
//   • у каждого отчёта должен быть УНИКАЛЬНЫЙ id (не переиспользовать).
//
// Лимит запросов у всех четырёх методов одинаковый (собственный лимит метода):
//   Персональный/Сервисный/Базовый-с-секретом — 3 запроса/мин, интервал 20с, всплеск 3;
//   Базовый без секрета — 1 запрос/час.

import { randomUUID } from 'crypto';
import { WbClient } from './wbClient.js';

const CATEGORY = 'analytics';
const BASE = '/api/v2/nm-report/downloads';

// Собственный лимит методов nm-report (см. docs/wb-api/analytics.md).
const METHOD_LIMIT = { limit: 3, periodSec: 60, burst: 3 };

// Типы отчётов (поле reportType при создании).
export const JEM_REPORT_TYPES = {
  DETAIL_HISTORY_REPORT: 'Воронка продаж, по артикулам WB',
  GROUPED_HISTORY_REPORT: 'Воронка продаж, с группировкой (предметы/бренды/ярлыки)',
  SEARCH_QUERIES_PREMIUM_REPORT_GROUP: 'Поисковые запросы, по группам',
  SEARCH_QUERIES_PREMIUM_REPORT_PRODUCT: 'Поисковые запросы, по товарам',
  SEARCH_QUERIES_PREMIUM_REPORT_TEXT: 'Поисковые запросы, по текстам',
  STOCK_HISTORY_REPORT_CSV: 'Остатки (без подписки Джем)',
  STOCK_HISTORY_DAILY_CSV: 'Остатки по дням (без подписки Джем)',
};

// Типы, которым НЕ нужна подписка Джем.
export const NON_JEM_TYPES = new Set(['STOCK_HISTORY_REPORT_CSV', 'STOCK_HISTORY_DAILY_CSV']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WbJemReports {
  /** @param {object} opts  как у WbClient (token/tokenType/…), либо {client}. */
  constructor(opts = {}) {
    this.wb = opts.client || new WbClient(opts);
  }

  /**
   * Поставить задание на генерацию отчёта.
   * @param {object} a
   * @param {string} a.reportType  один из JEM_REPORT_TYPES.
   * @param {object} a.params      параметры отчёта (зависят от типа; см. доку).
   * @param {string} [a.id]        UUID отчёта; по умолчанию генерируется.
   * @param {string} [a.userReportName]
   * @returns {Promise<{id:string, data:any}>}  id — чтобы потом опрашивать/скачивать.
   */
  async create({ reportType, params, id = randomUUID(), userReportName } = {}) {
    if (!reportType) throw new Error('create: нужен reportType');
    if (!params || typeof params !== 'object') throw new Error('create: нужен объект params');
    const body = { id, reportType, params, ...(userReportName ? { userReportName } : {}) };
    const { data } = await this.wb.request(CATEGORY, BASE, {
      method: 'POST', body, methodLimit: METHOD_LIMIT,
    });
    return { id, data };
  }

  /**
   * Список отчётов со статусами генерации. Без аргумента — все, иначе по ID.
   * @param {string[]} [downloadIds]
   * @returns {Promise<Array<object>>}
   */
  async list(downloadIds) {
    let path = BASE;
    if (Array.isArray(downloadIds) && downloadIds.length) {
      // Параметр с квадратными скобками собираем вручную (массив uuid).
      path += '?' + downloadIds
        .map((x) => `filter[downloadIds]=${encodeURIComponent(x)}`)
        .join('&');
    }
    const { data } = await this.wb.request(CATEGORY, path, { methodLimit: METHOD_LIMIT });
    return Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  }

  /** Статус одного отчёта: сырой объект из списка (или null, если не найден). */
  async status(id) {
    const rows = await this.list([id]);
    return rows.find((r) => (r.id || r.downloadId) === id) || rows[0] || null;
  }

  /** Пересоздать задание (нужно при статусе FAILED). */
  async retry(downloadId) {
    if (!downloadId) throw new Error('retry: нужен downloadId');
    const { data } = await this.wb.request(CATEGORY, `${BASE}/retry`, {
      method: 'POST', body: { downloadId }, methodLimit: METHOD_LIMIT,
    });
    return data;
  }

  /**
   * Скачать готовый отчёт (ZIP-архив с CSV). Возвращает Buffer.
   * Доступен, пока отчёт не старше 48 часов.
   */
  async getFile(downloadId) {
    if (!downloadId) throw new Error('getFile: нужен downloadId');
    const { data } = await this.wb.request(CATEGORY, `${BASE}/file/${downloadId}`, {
      responseType: 'arraybuffer', methodLimit: METHOD_LIMIT,
    });
    return data; // Buffer (application/zip)
  }

  /**
   * Полный цикл: создать → дождаться готовности → скачать ZIP.
   * Статусы в доке явно не перечислены (известен FAILED), поэтому определяем
   * готовность/провал устойчиво по подстроке, а сырой статус логируем.
   * @returns {Promise<{id:string, zip:Buffer, status:object}>}
   */
  async generateAndDownload({ reportType, params, id, userReportName,
                              pollMs = 20000, timeoutMs = 15 * 60 * 1000, onPoll } = {}) {
    const created = await this.create({ reportType, params, id, userReportName });
    const rid = created.id;
    const started = Date.now();

    for (;;) {
      const st = await this.status(rid);
      const raw = String(st?.status ?? st?.state ?? '').toLowerCase();
      if (onPoll) onPoll(st, raw);

      if (/fail|error/.test(raw)) {
        const e = new Error(`Отчёт ${rid}: статус ${(st?.status ?? raw) || 'FAILED'}`);
        e.report = st;
        throw e;
      }
      // Готов: статус похож на done/success/ready ИЛИ появился размер/флаг файла.
      const ready = /done|success|ready|complete|finish/.test(raw) || st?.isReady === true;
      if (ready) {
        const zip = await this.getFile(rid);
        return { id: rid, zip, status: st };
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Отчёт ${rid}: не готов за ${Math.round(timeoutMs / 1000)}c (статус ${raw || 'unknown'})`);
      }
      await sleep(pollMs);
    }
  }
}

export { CATEGORY as JEM_CATEGORY, BASE as JEM_BASE_PATH, METHOD_LIMIT as JEM_METHOD_LIMIT };
