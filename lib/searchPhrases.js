// lib/searchPhrases.js — сбор и объединение выдачи MPStats по нескольким
// поисковым фразам: топ-N по каждой фразе → merge → дедуп по SKU (с учётом,
// в скольких фразах карточка встретилась) → сортировка.
import { fetchSearchResults } from './mpstats.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const str = (v) => (v == null ? '' : String(v).trim());

function normRow(r) {
  return {
    sku: r.id ?? r.nmId ?? null,
    position: num(r.position),
    name: str(r.name),
    brand: str(r.brand),
    seller: str(r.seller),
    supplierId: r.supplier_id ?? null,
    url: str(r.url) || (r.id != null ? `https://www.wildberries.ru/catalog/${r.id}/detail.aspx` : ''),
    thumb: str(r.thumb),
    thumbMiddle: str(r.thumb_middle ?? r.thumb),
    color: str(r.color),
    subject: str(r.subject),
    gender: str(r.gender),
    price: num(r.final_price ?? r.price),
    revenue: num(r.revenue),
    sales: num(r.sales),
    lostProfit: num(r.lost_profit),
    lostPct: num(r.lost_profit_percent),
    rating: num(r.rating),
    comments: num(r.comments),
    sizeCount: num(r.size_count),
    sizeInStock: num(r.size_count_in_stock),
    buyoutPct: num(r.purchase),
    balance: num(r.balance),
    firstDate: str(r.sku_first_date),
  };
}

/**
 * @param {string[]} phrases — поисковые фразы
 * @param {object} o
 * @param {string} o.d1,o.d2 — период
 * @param {number} o.perPhrase — сколько карточек брать по каждой фразе (топ по позиции)
 */
export async function mergePhrases(phrases, { d1, d2, perPhrase = 100, onPhrase } = {}) {
  const map = new Map(); // sku -> item {..., phrases:[], bestPos}
  const byPhrase = [];
  for (const ph of phrases) {
    const { rows, total, period } = await fetchSearchResults(ph, { d1, d2, pageSize: perPhrase, maxRows: perPhrase });
    byPhrase.push({ phrase: ph, found: rows.length, totalInSearch: total });
    for (const r of rows) {
      const it = normRow(r);
      if (!it.sku) continue;
      const ex = map.get(it.sku);
      if (ex) {
        if (!ex.phrases.includes(ph)) ex.phrases.push(ph);
        ex.bestPos = Math.min(ex.bestPos, it.position || 9999);
      } else {
        map.set(it.sku, { ...it, phrases: [ph], bestPos: it.position || 9999 });
      }
    }
    if (onPhrase) onPhrase(ph, rows.length);
  }
  const items = [...map.values()];
  // Сортировка: сначала по «релевантности» (в скольких фразах встретилась), затем по выручке.
  items.sort((a, b) => b.phrases.length - a.phrases.length || b.revenue - a.revenue);
  // Ранг после сортировки.
  items.forEach((it, i) => { it.rank = i + 1; it.phraseHits = it.phrases.length; });
  return { items, byPhrase, period: { d1, d2 }, phrasesRequested: phrases.length, uniqueCount: items.length };
}
