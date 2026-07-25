// wbKeywords.js — поисковые фразы товара из MPStats (/wb/get/item/{id}/by_keywords)
// с диск-кэшем на 30 дней. Даёт «поведенческую релевантность»: по каким запросам
// покупатели реально находят товар и с каким трафиком. Муслиновая рубашка ранжируется
// по «муслин», льняная — по «лён» — это надёжнее, чем слова из названия/характеристик.
//
// ВАЖНО про квоту: by_keywords тратит СУТОЧНЫЙ лимит запросов MPStats (1 запрос/товар),
// поэтому (а) кэшируем на 30 дней, (б) вызываем только по узкому набору кандидатов,
// (в) на 429-«превышен лимит» останавливаемся и сообщаем честно (throw DailyLimitError).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'wb-cache', 'keywords');
const TTL_MS = 30 * 24 * 3600 * 1000; // профиль запросов меняется медленно — кэш на 30 дней
const BASE_URL = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';

export class DailyLimitError extends Error {
  constructor(msg) { super(msg || 'Превышен суточный лимит запросов MPStats'); this.name = 'DailyLimitError'; this.dailyLimit = true; }
}

function ensureDir() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); }
function cachePath(nm) { return path.join(CACHE_DIR, `${nm}.json`); }
function readCache(nm) {
  try {
    const st = fs.statSync(cachePath(nm));
    if (Date.now() - st.mtimeMs > TTL_MS) return undefined;
    return JSON.parse(fs.readFileSync(cachePath(nm), 'utf8'));
  } catch { return undefined; }
}
function writeCache(nm, info) { try { ensureDir(); fs.writeFileSync(cachePath(nm), JSON.stringify(info)); } catch { /* ignore */ } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sumNums = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : 0);

// Разбор ответа by_keywords → компактный профиль {phrases:[{phrase,traffic}], total}.
function parseKeywords(json) {
  const words = (json && json.words) || {};
  const phrases = [];
  let total = 0;
  for (const [phrase, v] of Object.entries(words)) {
    const traffic = sumNums(v && v.traffic_volume);
    if (traffic > 0) { phrases.push({ phrase: String(phrase), traffic }); total += traffic; }
  }
  phrases.sort((a, b) => b.traffic - a.traffic);
  return { phrases, total, fetchedAt: new Date().toISOString() };
}

// Один запрос by_keywords с ретраями. На дневной лимит — бросаем DailyLimitError.
async function fetchOne(nmId, d1, d2, retries = 2) {
  const token = process.env.MPSTATS_TOKEN;
  if (!token) throw new Error('MPSTATS_TOKEN не задан');
  const url = `${BASE_URL}/wb/get/item/${nmId}/by_keywords?d1=${d1}&d2=${d2}`;
  for (let a = 0; a <= retries; a++) {
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'X-Mpstats-TOKEN': token, Accept: 'application/json' },
        signal: AbortSignal.timeout(Number(process.env.MPSTATS_TIMEOUT_MS) || 25000),
      });
    } catch (e) {
      if (a < retries) { await sleep(1200 * (a + 1)); continue; }
      return null; // сетевой сбой/таймаут — считаем «нет данных»
    }
    if (resp.status === 404) return { phrases: [], total: 0, fetchedAt: new Date().toISOString() };
    if (resp.status === 429) {
      const body = await resp.text().catch(() => '');
      if (/лимит|limit/i.test(body)) throw new DailyLimitError(); // суточный лимит — не ретраим
      if (a < retries) { await sleep(1500 * (a + 1)); continue; } // иной 429 — притормозим
      return null;
    }
    if (resp.status >= 500) { if (a < retries) { await sleep(1500 * (a + 1)); continue; } return null; }
    if (!resp.ok) return null;
    try { return parseKeywords(await resp.json()); } catch { return null; }
  }
  return null;
}

/**
 * Профиль запросов одного товара (кэш→сеть). null — если данных нет.
 * @param {number|string} nmId
 * @param {{d1:string,d2:string,force?:boolean}} opts
 */
export async function fetchItemKeywords(nmId, { d1, d2, force = false } = {}) {
  const nm = String(nmId);
  if (!force) { const hit = readCache(nm); if (hit !== undefined) return hit; }
  const info = await fetchOne(nm, d1, d2);
  if (info) writeCache(nm, info); // кэшируем и «пустой» результат — чтобы не долбить повторно
  return info;
}

/**
 * Пакетное обогащение с потолком запросов и параллелизмом. Сначала отдаём всё, что есть
 * в кэше (бесплатно), затем добираем сетью до budget штук. На дневной лимит — стоп.
 * @param {Array<number|string>} ids
 * @param {{d1,d2,concurrency?,budget?,onProgress?,log?}} opts
 * @returns {Promise<{map:Map, fetched:number, cached:number, failed:number, limitHit:boolean, budgetLeft:number}>}
 */
export async function fetchKeywordsBatch(ids, { d1, d2, concurrency = 4, budget = 400, onProgress, log } = {}) {
  const map = new Map();
  const need = [];
  let cached = 0;
  for (const id of ids) {
    const nm = String(id);
    const hit = readCache(nm);
    if (hit !== undefined) { map.set(nm, hit); cached++; } else need.push(nm);
  }
  const toFetch = need.slice(0, Math.max(0, budget));
  const skipped = need.length - toFetch.length;
  if (log) log(`by_keywords: из кэша ${cached}, к запросу ${toFetch.length}${skipped ? `, отложено сверх лимита запросов ${skipped}` : ''}`);
  let fetched = 0, failed = 0, limitHit = false, done = 0;
  for (let i = 0; i < toFetch.length && !limitHit; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (nm) => {
      try { return { nm, info: await fetchItemKeywords(nm, { d1, d2 }) }; }
      catch (e) { if (e instanceof DailyLimitError) { limitHit = true; return { nm, info: undefined }; } return { nm, info: null }; }
    }));
    for (const { nm, info } of results) {
      if (info === undefined) continue;      // прервано лимитом
      if (info) { map.set(nm, info); fetched++; } else failed++;
    }
    done += batch.length;
    if (onProgress) onProgress(cached + done, cached + toFetch.length);
  }
  if (limitHit && log) log('⚠ достигнут суточный лимит запросов MPStats — часть товаров не обогащена (повторите завтра, кэш сохранён)');
  return { map, fetched, cached, failed, limitHit, budgetLeft: Math.max(0, budget - fetched) };
}

// Доля трафика товара, приходящаяся на целевые слова (по подстроке, регистронезависимо).
// targets — массив корней/слов (['муслин','марлевк']). Возвращает {share, targetTraffic, total, top}.
export function targetShare(profile, targets) {
  const t = (targets || []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  if (!profile || !profile.phrases || !profile.phrases.length || !t.length) {
    return { share: 0, targetTraffic: 0, total: profile ? profile.total || 0 : 0, top: null };
  }
  let tgt = 0, topPhrase = null;
  for (const p of profile.phrases) {
    if (t.some((w) => p.phrase.toLowerCase().includes(w))) { tgt += p.traffic; if (!topPhrase) topPhrase = p; }
  }
  const total = profile.total || 0;
  return { share: total > 0 ? tgt / total : 0, targetTraffic: tgt, total, top: topPhrase };
}
