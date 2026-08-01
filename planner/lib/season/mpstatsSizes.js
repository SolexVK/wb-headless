// mpstatsSizes.js — размерный спрос конкурентов из ОФИЦИАЛЬНОГО API MPStats.
//
// Метод (подтверждён живьём): GET .../analytics/v1/wb/items/{sku}/sales/sizes?d1&d2
//   → [{ size_name, size_origin, sales }] — продажи ПО РАЗМЕРАМ за период.
// Один вызов на карточку сразу даёт кривую спроса — не нужны публичный card.wb.ru
// и ежедневные снимки остатков (их ban-risk по IP снят полностью).
//
// ЛИМИТЫ (док. MPStats): квота тарифа конечна (напр. 150 или 2500 вызовов),
// 429 отдаёт заголовок Retry-After (сек). Поэтому:
//   • строгий ТОП-N конкурентов (не вся выборка) — задаётся вызывающим;
//   • кэш в БД с TTL — повторные пересборки в окне стоят 0 вызовов;
//   • перед батчем читаем остаток квоты (fetchApiLimit) и не лезем при нехватке;
//   • 429 → ждём Retry-After (один раз), прочие 4xx НЕ ретраим (жгут квоту).
//
// Офлайн-разработка: SIZESALES_FIXTURE_FILE — JSON { "<sku>": [ {size_name,...} ] }
// или просто массив строк (одна карточка).

import fs from 'fs';

const BASE = (process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api').replace(/\/$/, '');
const ITEMS = `${BASE}/analytics/v1/wb/items`;
const MIN_INTERVAL_MS = Number(process.env.MPSTATS_SIZE_INTERVAL_MS) || 300; // размазываем запросы
const MAX_RETRY_WAIT_MS = 20000; // потолок ожидания по Retry-After

const token = () => process.env.MPSTATS_TOKEN || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const f = process.env.SIZESALES_FIXTURE_FILE;
  if (f && fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
  return null;
}

// Строки ответа → канонический вид. Терпимо к обёртке {data:[...]}.
function normalizeRows(j) {
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
  return arr.map((r) => ({
    size_name: String(r.size_name ?? '').trim(),
    size_origin: String(r.size_origin ?? '').trim(),
    sales: Number(r.sales) || 0,
  })).filter((r) => r.size_name);
}

// GET к analytics/v1. Бросает Error с полями {status, retryAfter}. 429 не «глотаем».
async function apiGet(url, { timeoutMs } = {}) {
  timeoutMs = timeoutMs || Number(process.env.MPSTATS_TIMEOUT_MS) || 20000;
  const resp = await fetch(url, {
    headers: { 'X-Mpstats-TOKEN': token(), 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get('Retry-After')) || 0;
    const e = new Error(`MPStats 429 (Retry-After ${retryAfter}s)`);
    e.status = 429; e.retryAfter = retryAfter;
    throw e;
  }
  if (!resp.ok) { const e = new Error(`MPStats HTTP ${resp.status}`); e.status = resp.status; throw e; }
  return resp.json().catch(() => null);
}

/** Остаток квоты API. { available, use, remaining } | null (офлайн/нет токена/ошибка). */
export async function fetchApiLimit() {
  if (!token()) return null;
  try {
    const j = await apiGet(`${BASE}/user/report_api_limit`);
    if (!j) return null;
    const available = Number(j.available) || 0;
    const use = Number(j.use) || 0;
    return { available, use, remaining: Math.max(0, available - use) };
  } catch { return null; }
}

/** Продажи по размерам одной карточки за [d1,d2]. Один вызов = кривая спроса карточки. */
export async function fetchSalesSizes(sku, { d1, d2 } = {}) {
  const fx = fixture();
  if (fx) return normalizeRows(Array.isArray(fx) ? fx : (fx[String(sku)] || fx.rows || []));
  const q = (d1 && d2) ? `?d1=${encodeURIComponent(d1)}&d2=${encodeURIComponent(d2)}` : '';
  return normalizeRows(await apiGet(`${ITEMS}/${encodeURIComponent(sku)}/sales/sizes${q}`));
}

/**
 * Батч по ТОП-N карточкам, последовательно и бережно к квоте.
 * @param {number[]} skus — уже урезанный вызывающим ТОП.
 * @param {{d1?:string,d2?:string,cacheGet?:(sku)=>rows|null,cacheSet?:(sku,rows)=>void,diag?:object}} opts
 *   cacheGet/cacheSet — кэш БД (cache-first). diag — накопитель диагностики (мутируется).
 * @returns {Promise<Map<number,{size_name,size_origin,sales}[]>>} sku → строки размеров.
 */
export async function fetchSalesSizesBatch(skus, { d1, d2, cacheGet, cacheSet, diag } = {}) {
  const ids = [...new Set((skus || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const out = new Map();
  if (diag) { diag.requested = ids.length; diag.fromCache = 0; diag.fetched = 0; diag.errors = diag.errors || []; }
  let last = 0;
  for (const sku of ids) {
    // cache-first — не тратим квоту, если свежий результат уже есть.
    if (cacheGet) {
      const cached = cacheGet(sku);
      if (cached) { out.set(sku, cached); if (diag) diag.fromCache += 1; continue; }
    }
    // Размазываем запросы (интервал = период/лимит по доке).
    const gap = MIN_INTERVAL_MS - (Date.now() - last);
    if (gap > 0) await sleep(gap);
    let rows = null;
    try {
      rows = await fetchSalesSizes(sku, { d1, d2 });
    } catch (e) {
      if (e && e.status === 429) {
        const wait = Math.min(MAX_RETRY_WAIT_MS, (e.retryAfter || 2) * 1000);
        if (diag) diag.errors.push(`429 sku ${sku} → ждём ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        try { rows = await fetchSalesSizes(sku, { d1, d2 }); }  // одна повторная попытка
        catch (e2) { if (diag) diag.errors.push(`429-повтор sku ${sku}: ${String(e2?.message || e2).slice(0, 80)}`); }
      } else if (diag) {
        diag.errors.push(`sku ${sku}: ${String(e?.message || e).slice(0, 80)}`); // 4xx/5xx — не ретраим
      }
    }
    last = Date.now();
    if (rows) { out.set(sku, rows); if (diag) diag.fetched += 1; if (cacheSet) { try { cacheSet(sku, rows); } catch { /* БД не критична */ } } }
  }
  return out;
}
