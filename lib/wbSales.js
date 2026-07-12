// lib/wbSales.js — клиент WB Statistics API «Продажи» (/api/v1/supplier/sales).
//
// Отдаёт фактические продажи и возвраты из кабинета продавца. Токен — env
// `Wildberries_API` (заголовок Authorization). Метод ЖЁСТКО лимитирован:
// для токена personal/сервисного — **1 запрос в минуту, без запаса** (см.
// docs/wb-api/reports-statistics.md). Один ответ отдаёт до ~80 000 строк; чтобы
// забрать больше — пагинация: в след. запросе dateFrom = lastChangeDate последней
// строки. Пустой массив [] = данные исчерпаны.
//
// Поэтому здесь: строгая пауза `minIntervalMs` (по умолч. 66 с) между страницами,
// обработка 429, дедуп по `saleID`, и опциональная фильтрация по nmId (чтобы не
// держать в памяти всю выдачу продавца).
//
// ВАЖНО про дедуп: пагинация по lastChangeDate возвращает пограничные строки в двух
// страницах — их надо схлопнуть. Ключ дедупа — `saleID` (уникален на продажу/возврат,
// S…/R…), а НЕ `srid`: srid — идентификатор ЗАКАЗА (одна покупка = несколько позиций
// с одним srid), дедуп по нему терял бы реальные продажи.

const SALES_URL = 'https://statistics-api.wildberries.ru/api/v1/supplier/sales';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.Wildberries_API;
  if (!t) throw new Error('Wildberries_API не задан в переменных окружения');
  return t;
}

// 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00' (RFC3339); дату со временем оставляем как есть.
const toRfc = (d) => (/T/.test(String(d)) ? String(d) : `${d}T00:00:00`);

/**
 * Постранично тянет продажи/возвраты с dateFrom, соблюдая лимит 1 запрос/мин.
 * @param {object} p
 *   dateFrom      начало (YYYY-MM-DD или RFC3339) — фильтр по lastChangeDate
 *   nmIds         Set/массив nmId для фильтра (иначе копим всё — тяжело)
 *   minIntervalMs пауза между страницами (по умолч. 66000 — лимит personal)
 *   maxPages      предохранитель (по умолч. 12)
 *   flag          0 (по lastChangeDate, дефолт) | 1 (все за конкретную дату)
 *   log           логгер прогресса
 * @returns {Promise<object[]>} строки продаж/возвратов (только nmIds, дедуп по srid)
 */
export async function pullSales({ dateFrom, nmIds, minIntervalMs = 66000, maxPages = 12, flag = 0, log = () => {} } = {}) {
  const want = nmIds ? new Set([...nmIds].map(Number)) : null;
  const seen = new Set();
  const rows = [];
  let cursor = toRfc(dateFrom);

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(minIntervalMs); // строго 1 запрос/мин
    const url = `${SALES_URL}?dateFrom=${encodeURIComponent(cursor)}&flag=${flag}`;
    let resp = await fetch(url, { headers: { Authorization: token() } });
    if (resp.status === 429) {
      log(`  429 (лимит) — ждём ${Math.round(minIntervalMs / 1000)}с и повторяем`);
      await sleep(minIntervalMs);
      resp = await fetch(url, { headers: { Authorization: token() } });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`WB sales ${resp.status}: ${body.slice(0, 200)}`);
    }
    const batch = await resp.json();
    if (!Array.isArray(batch)) throw new Error('WB sales: неожиданный формат ответа');

    let mine = 0;
    for (const x of batch) {
      if (want && !want.has(+x.nmId)) continue;
      // Ключ дедупа — saleID (уникален на продажу/возврат). Fallback на композит,
      // если saleID вдруг пуст (чтобы не потерять строку).
      const key = x.saleID || `${x.srid}|${x.date}|${x.nmId}|${x.finishedPrice}|${x.barcode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(x);
      mine++;
    }
    const last = batch.length ? batch[batch.length - 1].lastChangeDate : null;
    log(`  страница ${page}: строк ${batch.length}, наших ${mine}, накоплено ${rows.length}, last=${last || '—'}`);

    if (batch.length < 80000) break; // неполная страница — выдача исчерпана
    if (!last || last <= cursor) break; // курсор не сдвинулся — защита от петли
    cursor = last;
  }
  return rows;
}

export { SALES_URL };
