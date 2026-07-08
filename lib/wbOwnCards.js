// lib/wbOwnCards.js — множество НАШИХ артикулов (nmID) из кабинета через
// Content API (content-api.wildberries.ru /content/v2/get/cards/list).
//
// Зачем: «Сравнение карточек» имеет смысл только если якорь — НАШ артикул (воронку
// WB отдаёт лишь по своим карточкам). Эта проверка дешёвая (Content API, не трогает
// лимит сравнений кабинета) и служит гейтом перед тратой лимита: не наш → не сабмитим.

import { WbClient } from './wbClient.js';

/**
 * Тянет ВСЕ наши nmID (пагинация курсором). Возвращает Set строк.
 * @param {object} [o]
 * @param {WbClient} [o.client]
 * @param {number} [o.limit=100]  размер страницы
 * @param {number} [o.maxPages=100]  предохранитель
 */
export async function fetchOwnNmIds({ client, limit = 100, maxPages = 100 } = {}) {
  const c = client || new WbClient();
  const ids = new Set();
  let cursor = { limit };
  for (let page = 0; page < maxPages; page++) {
    const r = await c.request('content', '/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { cursor, filter: { withPhoto: -1 } } },
    });
    if (r.status !== 200) break;
    const cards = r.data?.cards || [];
    for (const card of cards) if (card.nmID != null) ids.add(String(card.nmID));
    const cur = r.data?.cursor || {};
    if (cards.length < limit) break; // последняя страница
    cursor = { limit, updatedAt: cur.updatedAt, nmID: cur.nmID };
  }
  return ids;
}

/**
 * Наш ли артикул. С кэшем (интерфейс {get,set}) — множество наших nmID стабильно,
 * кэшируется на стороне вызывающего (напр. source_cache в рантайм-БД).
 * @returns {Promise<{ours:boolean, total:number}>}
 */
export async function checkOwnArticle(nmId, { client, cache, cacheKey = 'wb.own-cards' } = {}) {
  let list = cache ? cache.get(cacheKey) : null;
  if (!list) {
    list = [...(await fetchOwnNmIds({ client }))];
    if (cache) cache.set(cacheKey, list);
  }
  const set = new Set(list.map(String));
  return { ours: set.has(String(nmId)), total: set.size };
}
