// lib/wb/wbSales.js — клиент WB Statistics API «Продажи» (/api/v1/supplier/sales).
// Фактические продажи (выкупы, saleID S…) и возвраты (R…) из кабинета продавца.
// Токен — env WB_API_TOKEN или Wildberries_API. Метод ЖЁСТКО лимитирован: 1 запрос/мин.
// Один ответ отдаёт до ~80 000 строк; больше — пагинация: dateFrom = lastChangeDate последней
// строки. Дедуп по saleID (не srid: srid — id заказа, дедуп по нему терял бы позиции).
// Перенесено из ветки claude/wildberries-tools.

const SALES_URL = 'https://statistics-api.wildberries.ru/api/v1/supplier/sales';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.WB_API_TOKEN || process.env.Wildberries_API;
  if (!t) throw new Error('WB_API_TOKEN / Wildberries_API не задан в переменных окружения');
  return t;
}

// 'YYYY-MM-DD' → 'YYYY-MM-DDT00:00:00' (RFC3339); дату со временем оставляем как есть.
const toRfc = (d) => (/T/.test(String(d)) ? String(d) : `${d}T00:00:00`);

/**
 * Постранично тянет продажи/возвраты с dateFrom, соблюдая лимит 1 запрос/мин.
 * @param {object} p
 *   dateFrom      начало (YYYY-MM-DD или RFC3339) — фильтр по lastChangeDate
 *   nmIds         Set/массив nmId для фильтра (иначе копим всё — тяжело)
 *   minIntervalMs пауза между страницами (по умолч. 66000)
 *   maxPages      предохранитель (по умолч. 12)
 *   onPage        колбэк прогресса ({page, batch, kept, total, last})
 * @returns {Promise<object[]>} строки продаж/возвратов (дедуп по saleID)
 */
export async function pullSales({ dateFrom, nmIds, minIntervalMs = 66000, maxPages = 12, flag = 0, onPage = () => {} } = {}) {
  const want = nmIds ? new Set([...nmIds].map(Number)) : null;
  const seen = new Set();
  const rows = [];
  let cursor = toRfc(dateFrom);

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(minIntervalMs); // строго 1 запрос/мин
    const url = `${SALES_URL}?dateFrom=${encodeURIComponent(cursor)}&flag=${flag}`;
    let resp = await fetch(url, { headers: { Authorization: token() } });
    if (resp.status === 429) { await sleep(minIntervalMs); resp = await fetch(url, { headers: { Authorization: token() } }); }
    if (!resp.ok) { const body = await resp.text().catch(() => ''); throw new Error(`WB sales ${resp.status}: ${body.slice(0, 200)}`); }
    const batch = await resp.json();
    if (!Array.isArray(batch)) throw new Error('WB sales: неожиданный формат ответа');

    let mine = 0;
    for (const x of batch) {
      if (want && !want.has(+x.nmId)) continue;
      const key = x.saleID || `${x.srid}|${x.date}|${x.nmId}|${x.finishedPrice}|${x.barcode}`;
      if (seen.has(key)) continue;
      seen.add(key); rows.push(x); mine++;
    }
    const last = batch.length ? batch[batch.length - 1].lastChangeDate : null;
    onPage({ page, batch: batch.length, kept: mine, total: rows.length, last });

    if (batch.length < 80000) break; // неполная страница — выдача исчерпана
    if (!last || last <= cursor) break; // курсор не сдвинулся — защита от петли
    cursor = last;
  }
  return rows;
}

// Свести строки продаж в агрегат по nmId: выкупы (S), возвраты (R), нетто, ₽ (forPay), даты.
export function aggregateSalesByNm(rows) {
  const byNm = {};
  for (const x of (rows || [])) {
    const nm = String(x.nmId);
    const g = byNm[nm] || (byNm[nm] = { buyouts: 0, returns: 0, net: 0, forPay: 0, firstDate: '', lastDate: '' });
    const isReturn = String(x.saleID || '').startsWith('R');
    if (isReturn) { g.returns += 1; g.forPay -= (+x.forPay || 0); }
    else { g.buyouts += 1; g.forPay += (+x.forPay || 0); }
    g.net = g.buyouts - g.returns;
    const d = String(x.date || '').slice(0, 10);
    if (d) { if (!g.firstDate || d < g.firstDate) g.firstDate = d; if (!g.lastDate || d > g.lastDate) g.lastDate = d; }
  }
  return byNm;
}

export { SALES_URL };
