// wbApi.js — высокоуровневые обёртки WB API для planner: карточки (габариты,
// маппинг nmID↔vendorCode) и тарифы box (логистика/хранение), с JSON-кэшем на
// диске (строгие лимиты WB → не дёргаем API без нужды).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './wbClient.js';
import { dbAvailable, wbLoadCards, wbSaveCards, wbLoadTariffs, wbSaveTariffs } from '../db.js';
import { normColor } from '../../public/colorNorm.js';

// Канонические цвета — для распознавания «цветового» сегмента в артикуле продавца (023_рвп_ГОЛУБОЙ_ип).
const CANON_COLORS = new Set(['белый/молочный', 'бежевый', 'чёрный', 'серый', 'голубой', 'синий', 'зелёный', 'розовый', 'красный', 'жёлтый', 'оранжевый', 'фиолетовый', 'коричневый']);
const isColorWord = (seg) => CANON_COLORS.has(normColor(seg));
const vcSegments = (vc) => String(vc || '').split(/[_\s]+/).filter(Boolean); // НЕ рвём по дефису (светло-коричневый — один цвет)
// Префикс товара (до цветового сегмента): «023_рвп_голубой_ип» → «023_рвп».
function vendorPrefix(vc) {
  const segs = vcSegments(vc);
  const ci = segs.findIndex(isColorWord);
  return ci > 0 ? segs.slice(0, ci).join('_') : '';
}
// Цвет из артикула продавца (сегмент, распознанный как цвет).
function vendorColor(vc) {
  const segs = vcSegments(vc);
  const seg = segs.find(isColorWord);
  return seg || '';
}
const vcStarts = (vc, pfx) => String(vc || '').toLowerCase().startsWith(String(pfx || '').toLowerCase());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'wb-cache');

function ensureCacheDir() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); }
function readCache(name, maxAgeMs) {
  try {
    const fp = path.join(CACHE_DIR, name);
    const st = fs.statSync(fp);
    if (maxAgeMs != null && Date.now() - st.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}
function writeCache(name, data) {
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify({ savedAt: new Date().toISOString(), data }));
}

export function hasWbToken() {
  return !!(process.env.WB_API_TOKEN || process.env.Wildberries_API);
}

// Цвет карточки WB из characteristics (name ~ «Цвет»); значение — массив или строка.
function cardColor(card) {
  const chs = (card && card.characteristics) || [];
  for (const ch of chs) {
    if (/цвет/i.test(ch && ch.name || '')) {
      const v = ch.value;
      return Array.isArray(v) ? String(v[0] || '').trim() : String(v || '').trim();
    }
  }
  return String((card && card.color) || '').trim();
}

const STOCKS_TTL = 60 * 60 * 1000; // остатки FBW — кэш 1 час (отчёт генерится и жёстко лимитирован)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Текущие остатки FBW через Seller Analytics «warehouse_remains» (отчёт: создать → дождаться →
 * скачать). Старый /api/v1/supplier/stocks закрыт (deprecated). Отчёт уже сведён по всем складам
 * (quantityWarehousesFull). Сгруппирован по nmId × размеру.
 */
export async function fetchStocks({ force = false } = {}) {
  if (!force) { const c = readCache('stocks.json', STOCKS_TTL); if (c) return c.data; }
  const c = client();
  const q = 'locale=ru&groupByBrand=false&groupBySubject=false&groupBySa=false&groupByNm=true&groupByBarcode=false&groupBySize=true';
  const created = await c.request('analytics', `/api/v1/warehouse_remains?${q}`, { method: 'GET', methodLimit: { limit: 1, periodSec: 60, burst: 1 } });
  const cd = created && created.data;
  const taskId = cd && (cd.taskId || (cd.data && cd.data.taskId));
  if (!taskId) throw new Error('WB: не удалось создать отчёт по остаткам (нет taskId)');
  let status = '';
  for (let i = 0; i < 24; i++) { // ~2 минуты ожидания генерации
    await sleep(5000);
    const st = await c.request('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/status`, { method: 'GET', methodLimit: { limit: 20, periodSec: 60, burst: 5 } });
    const sd = st && st.data;
    status = (sd && (sd.status || (sd.data && sd.data.status))) || '';
    if (status === 'done') break;
    if (status === 'purged' || status === 'canceled') throw new Error(`WB: отчёт по остаткам отменён (${status})`);
  }
  if (status !== 'done') throw new Error('WB: отчёт по остаткам не готов (таймаут ~2 мин). Нажми «свежие (без кэша)» чуть позже.');
  const dl = await c.request('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/download`, { method: 'GET', methodLimit: { limit: 10, periodSec: 60, burst: 5 } });
  const rows = Array.isArray(dl.data) ? dl.data : (dl.data && Array.isArray(dl.data.data) ? dl.data.data : []);
  writeCache('stocks.json', rows);
  return rows;
}

/** Свести остатки по (nmId × размер): quantityWarehousesFull (уже по всем складам) + в пути + возвраты. */
export function aggregateStocks(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const nmId = r.nmId != null ? r.nmId : r.nmID;
    if (nmId == null) continue;
    const ts = String(r.techSize != null ? r.techSize : '').trim();
    const key = nmId + '|' + ts;
    const cur = m.get(key) || { quantity: 0, inWayToClient: 0, inWayFromClient: 0 };
    cur.quantity += (r.quantityWarehousesFull != null ? +r.quantityWarehousesFull : +r.quantity) || 0;
    cur.inWayToClient += +r.inWayToClient || 0;
    cur.inWayFromClient += +r.inWayFromClient || 0;
    m.set(key, cur);
  }
  return m;
}

const FBS_TTL = 30 * 60 * 1000; // остатки FBS — кэш 30 минут

/** Склады продавца (FBS/маркетплейс): [{id, name}]. Кэш 12ч. */
export async function fetchFbsWarehouses({ force = false } = {}) {
  if (!force) { const c = readCache('fbs-warehouses.json', 12 * 3600 * 1000); if (c) return c.data; }
  const c = client();
  const { data } = await c.request('marketplace', '/api/v3/warehouses', { method: 'GET', methodLimit: { limit: 30, periodSec: 60, burst: 10 } });
  const list = (Array.isArray(data) ? data : []).map((w) => ({ id: w.id, name: w.name || '' })).filter((w) => w.id != null);
  writeCache('fbs-warehouses.json', list);
  return list;
}

/**
 * Остатки FBS (склады продавца) по штрихкодам. Возвращает Map(barcode → amount), сведённую
 * по всем складам продавца. Метод POST /api/v3/stocks/{warehouseId} принимает до 1000 skus.
 * Best-effort: если нет складов/доступа — вернётся пустая карта (FBS не у всех).
 */
export async function fetchFbsStockMap({ skus = [], force = false } = {}) {
  const uniq = [...new Set((skus || []).map((s) => String(s).trim()).filter(Boolean))];
  const out = new Map();
  if (!uniq.length) return out;
  const cacheName = 'fbs-stocks.json';
  if (!force) {
    const c = readCache(cacheName, FBS_TTL);
    if (c && c.data && Array.isArray(c.data)) { for (const [bc, amt] of c.data) out.set(bc, amt); return out; }
  }
  const c = client();
  const whs = await fetchFbsWarehouses({ force });
  for (const wh of whs) {
    for (let i = 0; i < uniq.length; i += 1000) {
      const batch = uniq.slice(i, i + 1000);
      const { data } = await c.request('marketplace', `/api/v3/stocks/${wh.id}`, {
        method: 'POST', body: { skus: batch }, methodLimit: { limit: 300, periodSec: 60, burst: 20 },
      });
      const rows = (data && Array.isArray(data.stocks)) ? data.stocks : [];
      for (const r of rows) {
        const bc = String(r.sku || '').trim(); if (!bc) continue;
        out.set(bc, (out.get(bc) || 0) + (+r.amount || 0));
      }
    }
  }
  writeCache(cacheName, [...out.entries()]);
  return out;
}

/**
 * Собрать WB-остатки в предложение по артикулам. Для каждого item {articleId, nmID}:
 * по nmID берём imtID → все цветовые карточки → по каждой (цвет + techSize) считаем
 * доступный остаток = quantity + inWayFromClient + inWayToClient×(1 − выкуп%).
 * @returns {{supplies:Array<{articleId,source,matrix,units}>, diag:Array, buyoutPct:number}}
 */
// Найти все цветовые карточки товара по ключу привязки: ключ = nmID (тогда берём imtID +
// префикс артикула продавца) ИЛИ префикс артикула продавца (023_рвп) → все карточки с ним.
function resolveArticleCards(key, cards, byNm) {
  const keys = String(key || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean); // можно несколько ключей
  const dedupe = (arr) => { const seen = new Set(), out = []; for (const c of arr) if (!seen.has(c.nmID)) { seen.add(c.nmID); out.push(c); } return out; };
  const all = [];
  for (const k of keys) {
    if (/^\d{6,}$/.test(k)) { const base = byNm.get(k); if (base) all.push(base); } // nmID → ТОЧНО эта карточка (артикул+цвет)
    else for (const c of cards) if (vcStarts(c.vendorCode, k)) all.push(c);            // префикс → все карточки с ним
  }
  return dedupe(all);
}

export async function buildWbSupply({ items = [], buyoutPct = 37, force = false, includeFbs = true } = {}) {
  const cards = await fetchCards({ force });
  const stocks = aggregateStocks(await fetchStocks({ force }));
  const byNm = new Map(cards.map((c) => [String(c.nmID), c]));
  const buyout = Math.max(0, Math.min(100, +buyoutPct || 0)) / 100; // доля выкупа (уходит из остатка)

  // Остатки FBS (склад продавца) — по штрихкодам всех запрашиваемых карточек, best-effort.
  let fbsMap = new Map(); let fbsErr = null; let fbsSkusAsked = 0;
  if (includeFbs) {
    const allSkus = new Set();
    for (const it of items) {
      for (const card of resolveArticleCards(it.key != null ? it.key : it.nmID, cards, byNm)) {
        for (const sz of (card.sizes || [])) for (const bc of (sz.skus || [])) allSkus.add(bc);
      }
    }
    fbsSkusAsked = allSkus.size;
    if (allSkus.size) { try { fbsMap = await fetchFbsStockMap({ skus: [...allSkus], force }); } catch (e) { fbsErr = String(e.message || e); } }
  }

  const supplies = []; const diag = [];
  for (const it of items) {
    const key = it.key != null ? it.key : it.nmID; // key = nmID или префикс артикула продавца
    const sibs = resolveArticleCards(key, cards, byNm);
    if (!sibs.length) { diag.push({ articleId: it.articleId, key: String(key || ''), error: 'карточки WB по этому ключу не найдены (проверь nmID / артикул продавца)' }); continue; }
    const matrix = {}; let fbsUnits = 0;
    for (const card of sibs) {
      const color = card.color || vendorColor(card.vendorCode) || 'без цвета';
      // штрихкоды по размеру (для FBS): techSize → [skus]
      const skusBySize = {};
      for (const sz of (card.sizes || [])) skusBySize[sz.techSize] = sz.skus || [];
      const sizeSet = new Set([...(card.techSizes || []), ...Object.keys(skusBySize)]);
      for (const ts of sizeSet) {
        const s = stocks.get(String(card.nmID) + '|' + ts);
        // FBW: наличие + возвраты + доля не выкупленного из «в пути к клиенту»
        const fbw = s ? Math.round((s.quantity || 0) + (s.inWayFromClient || 0) + (s.inWayToClient || 0) * (1 - buyout)) : 0;
        // FBS: физический остаток на складе продавца по штрихкодам этого размера (без дисконта выкупа)
        let fbs = 0; for (const bc of (skusBySize[ts] || [])) fbs += fbsMap.get(bc) || 0;
        fbsUnits += fbs;
        const eff = fbw + fbs;
        if (eff <= 0) continue;
        matrix[color] = matrix[color] || {};
        matrix[color][ts] = (matrix[color][ts] || 0) + eff;
      }
    }
    const units = Object.values(matrix).reduce((a, r) => a + Object.values(r).reduce((x, v) => x + v, 0), 0);
    const sample = sibs.slice(0, 3).map((c) => c.vendorCode).filter(Boolean);
    supplies.push({ articleId: it.articleId, source: 'wb', matrix, units });
    diag.push({ articleId: it.articleId, key: String(key || ''), cards: sibs.length, colors: Object.keys(matrix).length, units, fbs: fbsUnits, sample });
  }
  return {
    supplies, diag, buyoutPct: Math.round(buyout * 100),
    stocksRows: (stocks && stocks.size) || 0, cardsCount: cards.length,
    fbs: { skusAsked: fbsSkusAsked, found: fbsMap.size, error: fbsErr },
  };
}

/** Список артикулов продавца (vendorCode) сгруппированный по префиксу — для подбора «Ключа WB». */
export async function listVendorPrefixes({ force = false } = {}) {
  const cards = await fetchCards({ force });
  const byPfx = new Map();
  for (const c of cards) {
    const pfx = vendorPrefix(c.vendorCode) || c.vendorCode || '';
    if (!pfx) continue;
    const g = byPfx.get(pfx) || { prefix: pfx, count: 0, samples: [] };
    g.count += 1;
    if (g.samples.length < 4) g.samples.push(c.vendorCode);
    byPfx.set(pfx, g);
  }
  return { prefixes: [...byPfx.values()].sort((a, b) => b.count - a.count), cardsCount: cards.length };
}

/** Число из строки WB (запятая как разделитель; '' и '-' → null). */
const wbNum = (v) => {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Объём упаковки в литрах из dimensions (см). */
export function volumeLitres(dim) {
  if (!dim) return null;
  const l = +dim.length || 0, w = +dim.width || 0, h = +dim.height || 0;
  if (l <= 0 || w <= 0 || h <= 0) return null;
  return Math.round((l * w * h) / 1000 * 100) / 100; // л, до сотых
}

let _client = null;
function client() { if (!_client) _client = new WbClient({ tokenType: 'personal' }); return _client; }

const CARDS_TTL = 24 * 3600 * 1000; // сутки

/**
 * Список карточек продавца: [{nmID, vendorCode, brand, dimensions, volumeL}].
 * Пагинация курсором Content API. Кэш — сутки (или force).
 */
export async function fetchCards({ force = false } = {}) {
  if (!force) {
    if (dbAvailable()) { const hit = wbLoadCards(CARDS_TTL); if (hit) return hit; }
    else { const c = readCache('cards.json', CARDS_TTL); if (c) return c.data; }
  }
  const c = client();
  const limit = 100;
  const out = [];
  let cursor = { limit };
  for (let page = 0; page < 50; page++) {
    const body = { settings: { cursor, filter: { withPhoto: -1 } } };
    const { data } = await c.request('content', '/content/v2/get/cards/list', {
      method: 'POST', body,
      methodLimit: { limit: 100, periodSec: 60, burst: 10 },
    });
    const cards = (data && data.cards) || [];
    for (const card of cards) {
      out.push({
        nmID: card.nmID,
        imtID: card.imtID != null ? card.imtID : null, // объединяет цветовые варианты одного товара
        vendorCode: card.vendorCode || '',
        title: card.title || '', // название карточки (для выгрузки номенклатуры)
        brand: card.brand || '',
        color: cardColor(card), // цвет карточки (для сведения остатков по цвету)
        techSizes: Array.isArray(card.sizes) ? card.sizes.map((s) => String(s.techSize || '').trim()).filter(Boolean) : [],
        // размеры со штрихкодами (skus) — нужны для остатков FBS (склад продавца): запрос идёт по баркодам
        sizes: Array.isArray(card.sizes) ? card.sizes.map((s) => ({
          techSize: String(s.techSize || '').trim(),
          skus: Array.isArray(s.skus) ? s.skus.map((x) => String(x).trim()).filter(Boolean) : [],
        })).filter((s) => s.techSize) : [],
        dimensions: card.dimensions || null,
        volumeL: volumeLitres(card.dimensions),
      });
    }
    const cur = (data && data.cursor) || {};
    if (cards.length < limit || cur.nmID == null) break;
    cursor = { limit, updatedAt: cur.updatedAt, nmID: cur.nmID };
  }
  if (dbAvailable()) wbSaveCards(out); else writeCache('cards.json', out);
  return out;
}

const TARIFFS_TTL = 12 * 3600 * 1000; // полсуток

/** Тарифы box на дату (по умолчанию сегодня). warehouseList с распарсенными числами. */
export async function fetchBoxTariffs({ date, force = false } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const cacheName = `tariffs-box-${d}.json`;
  if (!force) {
    if (dbAvailable()) { const hit = wbLoadTariffs(d, TARIFFS_TTL); if (hit) return hit; }
    else { const c = readCache(cacheName, TARIFFS_TTL); if (c) return c.data; }
  }
  const c = client();
  const { data } = await c.get('common', '/api/v1/tariffs/box', {
    query: { date: d },
    methodLimit: { limit: 5, periodSec: 60, burst: 3 }, // строгий лимит метода
  });
  const raw = (((data || {}).response || {}).data || {}).warehouseList || [];
  const list = raw.map((w) => ({
    warehouseName: w.warehouseName,
    geoName: w.geoName,
    deliveryBase: wbNum(w.boxDeliveryBase),       // ₽, первый литр
    deliveryLiter: wbNum(w.boxDeliveryLiter),     // ₽, каждый доп. литр
    deliveryCoef: wbNum(w.boxDeliveryCoefExpr),   // % коэффициент логистики
    storageBase: wbNum(w.boxStorageBase),         // ₽/сут, первый литр
    storageLiter: wbNum(w.boxStorageLiter),       // ₽/сут, доп. литр
    storageCoef: wbNum(w.boxStorageCoefExpr),     // % коэффициент хранения
  }));
  const result = { date: d, warehouseList: list };
  if (dbAvailable()) wbSaveTariffs(d, list); else writeCache(cacheName, result);
  return result;
}

/** Найти склад по имени (по умолчанию — Коледино). */
export function findWarehouse(tariffs, name = 'Коледино') {
  const list = (tariffs && tariffs.warehouseList) || [];
  return list.find((w) => (w.warehouseName || '').toLowerCase().includes(name.toLowerCase())) || null;
}
