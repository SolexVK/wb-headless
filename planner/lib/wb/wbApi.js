// wbApi.js — высокоуровневые обёртки WB API для planner: карточки (габариты,
// маппинг nmID↔vendorCode) и тарифы box (логистика/хранение), с JSON-кэшем на
// диске (строгие лимиты WB → не дёргаем API без нужды).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './wbClient.js';
import { dbAvailable, wbLoadCards, wbSaveCards, wbLoadTariffs, wbSaveTariffs } from '../db.js';

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
        vendorCode: card.vendorCode || '',
        brand: card.brand || '',
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
