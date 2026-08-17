/**
 * WB Discounts & Prices API — цены со скидкой продавца.
 *
 * Зачем нужен отдельно от MPStats: MPStats отдаёт витринную цену, то есть уже
 * с учётом СПП. Наша юнит-экономика считается от цены со скидкой продавца, БЕЗ СПП
 * (см. CLAUDE.md, ответ D9). На проверенной выборке расхождение составило в среднем
 * 24,6 %, то есть расчёт по цене MPStats занижает базу на четверть и вместе с ней маржу.
 *
 * Токен берётся теми же именами переменных, что и в lib/wbContent.js.
 */

import { TOKEN_ENV_NAMES, tokenSource } from './wbContent.js';

const BASE = process.env.WB_PRICES_BASE || 'https://discounts-prices-api.wildberries.ru';
const PAGE = 1000;

function token() {
  const name = tokenSource();
  if (!name) throw new Error(`нет токена WB в окружении: проверьте ${TOKEN_ENV_NAMES.join(', ')}`);
  return process.env[name].trim();
}

/**
 * Постранично выгружает товары с ценами.
 * @returns {Promise<Array>} сырые записи API
 */
export async function fetchGoods({ maxPages = 20 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = `${BASE}/api/v2/list/goods/filter?limit=${PAGE}&offset=${page * PAGE}`;
    const res = await fetch(url, { headers: { Authorization: token() } });
    const text = await res.text();
    if (!res.ok) throw new Error(`WB Prices: HTTP ${res.status} ${text.slice(0, 200)}`);
    const goods = JSON.parse(text)?.data?.listGoods || [];
    out.push(...goods);
    if (goods.length < PAGE) break;
  }
  return out;
}

/**
 * Приводит выгрузку к плоскому виду.
 *
 * Цена задаётся на уровне размера, поэтому у одной карточки размеры могут стоить
 * по-разному. Возвращаем и разрез по размерам, и цену карточки — если размеры
 * стоят одинаково, это одно число; если нет, берём медиану и помечаем `mixed`.
 *
 * @returns {{cards: Array, sizes: Array, warnings: string[]}}
 */
export function flattenPrices(goods) {
  const cards = [];
  const sizes = [];
  const warnings = [];

  for (const g of goods) {
    const list = g.sizes || [];
    if (!list.length) {
      warnings.push(`nmID ${g.nmID} (${g.vendorCode ?? ''}): нет размеров с ценой`);
      continue;
    }
    const prices = [];
    for (const s of list) {
      const discounted = num(s.discountedPrice);
      sizes.push({
        nmID: g.nmID,
        chrtID: s.sizeID ?? s.chrtID ?? null,
        techSize: s.techSizeName ?? s.techSize ?? '',
        price: num(s.price),
        discountedPrice: discounted,
        vendorCode: g.vendorCode ?? '',
      });
      if (discounted != null) prices.push(discounted);
    }
    if (!prices.length) {
      warnings.push(`nmID ${g.nmID} (${g.vendorCode ?? ''}): нет discountedPrice ни у одного размера`);
      continue;
    }
    const uniq = [...new Set(prices)];
    cards.push({
      nmID: g.nmID,
      vendorCode: g.vendorCode ?? '',
      discount: num(g.discount),
      price: median(list.map((s) => num(s.price)).filter((x) => x != null)),
      discountedPrice: median(prices),
      mixed: uniq.length > 1,
      sizeCount: list.length,
    });
  }
  return { cards, sizes, warnings };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
