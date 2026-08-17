/**
 * WB Content API — карточки товара и их размеры.
 *
 * Закрывает разрыв из docs/tools-contract.md: MPStats отдаёт данные на уровне nmID
 * (модель × цвет), а подсорт и точка перезаказа считаются на уровне баркода
 * (nmID × размер). Единственный источник состава размеров — Content API продавца.
 *
 * Токен: WB_CONTENT_TOKEN (категория «Контент»). Никогда не коммитить — только окружение.
 */

const BASE = process.env.WB_CONTENT_BASE || 'https://content-api.wildberries.ru';
const PAGE_LIMIT = 100;

function token() {
  const t = process.env.WB_CONTENT_TOKEN;
  if (!t) throw new Error('нет WB_CONTENT_TOKEN в окружении');
  return t;
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { Authorization: token(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WB Content ${pathname}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`WB Content ${pathname}: ответ не JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Постранично выгружает все карточки продавца.
 * Пагинация курсорная: следующий запрос повторяет updatedAt и nmID последней карточки.
 * @returns {Promise<Array>} сырые карточки
 */
export async function fetchCards({ maxPages = 200 } = {}) {
  const out = [];
  let cursor = { limit: PAGE_LIMIT };
  for (let page = 0; page < maxPages; page += 1) {
    const body = { settings: { sort: { ascending: false }, filter: { withPhoto: -1 }, cursor } };
    const data = await post('/content/v2/get/cards/list', body);
    const cards = data?.cards || [];
    out.push(...cards);
    const c = data?.cursor;
    // total меньше запрошенного лимита — страниц больше нет
    if (!c || cards.length === 0 || (c.total ?? cards.length) < cursor.limit) break;
    cursor = { limit: PAGE_LIMIT, updatedAt: c.updatedAt, nmID: c.nmID };
  }
  return out;
}

/**
 * Разворачивает карточки в плоский список баркодов.
 * Одна строка = одна торгуемая единица (nmID × размер).
 * @returns {{barcodes: Array, cards: Array, warnings: string[]}}
 */
export function flattenToBarcodes(cards) {
  const barcodes = [];
  const flatCards = [];
  const warnings = [];

  for (const card of cards) {
    const nmID = card.nmID;
    const vendorCode = card.vendorCode ?? '';
    const brand = card.brand ?? '';
    const title = card.title ?? '';
    const subject = card.subjectName ?? '';
    const sizes = card.sizes || [];

    flatCards.push({ nmID, vendorCode, brand, subject, title, sizeCount: sizes.length });

    if (!sizes.length) {
      warnings.push(`nmID ${nmID} (${vendorCode}): нет размеров`);
      continue;
    }
    for (const s of sizes) {
      const skus = s.skus || [];
      if (!skus.length) {
        warnings.push(`nmID ${nmID} (${vendorCode}), размер ${s.techSize ?? '?'}: нет баркода`);
        continue;
      }
      for (const barcode of skus) {
        barcodes.push({
          barcode: String(barcode),
          nmID,
          chrtID: s.chrtID,
          techSize: s.techSize ?? '',
          wbSize: s.wbSize ?? '',
          vendorCode,
          brand,
        });
      }
    }
  }
  return { barcodes, cards: flatCards, warnings };
}
