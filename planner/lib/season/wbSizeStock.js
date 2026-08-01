// wbSizeStock.js — БЕСПЛАТНЫЙ снимок остатков ПО РАЗМЕРАМ из публичного WB (card detail).
//
// serp/карточка WB агрегируют все размеры в один nmID (по размерам продаж не отдают).
// Но публичный card-detail отдаёт по каждому товару `sizes[]` со складскими остатками
// по каждому размеру. Это НЕ продажи, а срез склада «прямо сейчас». Ценность:
//   1) видно РЕАЛЬНУЮ размерную сетку конкурента (какие размеры он вообще шьёт);
//   2) ежедневные снимки → убыль остатка между днями ≈ продажи по размеру (см. sizeCurve).
// Лимиты MPStats НЕ расходуются (это открытый CDN WB, как и basket-карточки).
//
// Офлайн-разработка: SIZESTOCK_FIXTURE_FILE — сырой ответ card-detail (как для serp).
// Живьём работает с продакшена (Mac mini); из дата-центра WB может отдавать 404 (гео/бот).

import fs from 'fs';

// v4 — актуальный публичный detail. v2/v1 отдают 404 (сняты у WB), поэтому дефолт именно v4.
// Переопределяется через WB_CARD_DETAIL_URL, если WB снова сменит путь.
const DETAIL_URL = process.env.WB_CARD_DETAIL_URL || 'https://card.wb.ru/cards/v4/detail';
const DEST = process.env.WB_DEST || '-1257786'; // регион доставки (влияет на видимость складов)
const CHUNK = 100;                              // card-detail принимает пачку nm через «;»

function fixture() {
  const f = process.env.SIZESTOCK_FIXTURE_FILE;
  if (f && fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
  return null;
}

// Каноничная метка размера: буквенные — в верхний регистр, «0»/пусто/«без размера» → ONE.
export function normSize(name, origName) {
  let s = String(name || '').trim();
  if (!s || s === '0') s = String(origName || '').trim();
  if (!s || s === '0' || /без\s*размер|one\s*size|б\/р/i.test(s)) return 'ONE';
  // латиница размеров — в верхний регистр; RU-числа оставляем как есть
  return /^[a-zа-я]/i.test(s) ? s.toUpperCase() : s;
}

// Разбор ответа card-detail → Map nmId → { total, sizes:[{size, qty}] }.
export function parseDetail(json) {
  const products = (json && json.data && Array.isArray(json.data.products)) ? json.data.products : [];
  const out = new Map();
  for (const p of products) {
    const nm = Number(p.id);
    if (!Number.isFinite(nm) || nm <= 0) continue;
    const acc = new Map();
    for (const s of (Array.isArray(p.sizes) ? p.sizes : [])) {
      const size = normSize(s.name, s.origName);
      const qty = (Array.isArray(s.stocks) ? s.stocks : []).reduce((a, x) => a + (Number(x.qty) || 0), 0);
      acc.set(size, (acc.get(size) || 0) + qty);
    }
    const sizes = [...acc.entries()].map(([size, qty]) => ({ size, qty }));
    out.set(nm, { total: sizes.reduce((a, s) => a + s.qty, 0), sizes });
  }
  return out;
}

async function fetchChunk(nmIds, diag) {
  const url = `${DETAIL_URL}?appType=1&curr=rub&dest=${DEST}&spp=30&nm=${nmIds.join(';')}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(Number(process.env.WB_CARD_TIMEOUT_MS) || 15000),
    });
  } catch (e) {
    if (diag) diag.errors.push(String(e?.message || e).slice(0, 120));
    return new Map();
  }
  if (diag) diag.statuses.push(resp.status);
  if (!resp.ok) return new Map();
  const json = await resp.json().catch(() => null);
  if (diag && json) diag.products += ((json.data && json.data.products) || []).length;
  return json ? parseDetail(json) : new Map();
}

/**
 * Снимок остатков по размерам для набора nmID.
 * @param {number[]} nmIds
 * @param {{endpoint?:string,requested?:number,statuses?:number[],errors?:string[],products?:number,source?:string}} [diag]
 *   — необязательный объект-накопитель диагностики (мутируется на месте). Позволяет UI объяснить пустой ответ.
 * @returns {Promise<Map<number,{total:number,sizes:{size:string,qty:number}[]}>>}
 */
export async function fetchSizeStock(nmIds, diag) {
  const ids = [...new Set((nmIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (diag) { diag.endpoint = DETAIL_URL; diag.requested = ids.length; }
  const fx = fixture();
  if (fx) { if (diag) diag.source = 'fixture'; return parseDetail(fx); } // фикстура покрывает столько товаров, сколько в файле
  if (diag) diag.source = 'live';
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = await fetchChunk(ids.slice(i, i + CHUNK), diag);
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}
