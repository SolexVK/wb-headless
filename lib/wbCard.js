// lib/wbCard.js — доступ к карточке Wildberries по nmId через CDN.
//
// Ни браузера, ни парсинга страниц: и характеристики, и фотографии лежат
// на basket-CDN и достаются обычным HTTP по вычисляемому адресу.
//   card.json:  https://basket-NN.wbbasket.ru/vol{V}/part{P}/{nm}/info/ru/card.json
//   фото:       https://basket-NN.wbbasket.ru/vol{V}/part{P}/{nm}/images/{size}/{n}.webp
// где V = nm/100000, P = nm/1000 (целочисленно).
//
// Номер шарда NN заранее неизвестен и подбирается перебором. Но шард
// назначается диапазонами vol, поэтому все товары одного vol лежат в одном
// шарде — кэшируем соответствие vol → шард и перебираем один раз на ~100 000
// артикулов, а не на каждый.

import fs from 'fs';
import path from 'path';

const CDN_HOST = (n) => `https://basket-${String(n).padStart(2, '0')}.wbbasket.ru`;
const MAX_SHARD = Number(process.env.WB_MAX_SHARD) || 40;
const UA = 'Mozilla/5.0';

/** Размеры фото на CDN и их стоимость в токенах для vision-модели. */
export const PHOTO_SIZES = {
  'c246x328': { w: 246, h: 328, tokens: 108 },
  'c516x688': { w: 516, h: 688, tokens: 473 },
  'big': { w: 900, h: 1200, tokens: 1440 },
};

// Кэш vol → шард. Живёт в памяти, при наличии каталога — и на диске.
const CACHE_FILE = process.env.WB_SHARD_CACHE
  || path.resolve(process.cwd(), 'cache', 'wb-shards.json');
let shardCache = null;

function loadCache() {
  if (shardCache) return shardCache;
  try {
    shardCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {
    shardCache = {};
  }
  return shardCache;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(shardCache));
  } catch (_) {
    // кэш — оптимизация, а не требование: молча продолжаем без него
  }
}

const volOf = (nm) => Math.floor(nm / 100000);
const partOf = (nm) => Math.floor(nm / 1000);

/** Путь внутри шарда — общий для card.json и картинок. */
const basePath = (nm) => `/vol${volOf(nm)}/part${partOf(nm)}/${nm}`;

async function head(url, timeoutMs = 6000) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r;
  } catch (_) {
    return null;
  }
}

/**
 * Определяет шард basket для артикула. Сначала смотрит кэш по vol,
 * затем перебирает шарды и запоминает найденный.
 * @returns {Promise<number|null>} номер шарда либо null, если карточки нет
 */
export async function resolveShard(nm) {
  const cache = loadCache();
  const vol = String(volOf(nm));
  if (cache[vol]) {
    // Доверяем кэшу, но проверяем: карточка могла переехать.
    const r = await head(`${CDN_HOST(cache[vol])}${basePath(nm)}/info/ru/card.json`);
    if (r && r.ok) return cache[vol];
  }
  for (let i = 1; i <= MAX_SHARD; i += 1) {
    const r = await head(`${CDN_HOST(i)}${basePath(nm)}/info/ru/card.json`);
    if (r && r.ok) {
      cache[vol] = i;
      saveCache();
      return i;
    }
  }
  return null;
}

/**
 * Приводит массив options из card.json к плоской карте {название: значение}.
 * Значения приводим к нижнему регистру — сравнивать будем по ним.
 */
export function optionsMap(card) {
  const out = {};
  for (const o of card?.options || []) {
    if (!o?.name) continue;
    out[String(o.name).trim()] = String(o.value ?? '').trim();
  }
  return out;
}

/**
 * Забирает карточку: характеристики, название, описание, число фото.
 * @returns {Promise<object|null>} null, если карточки нет на CDN
 */
export async function fetchCard(nm) {
  const shard = await resolveShard(nm);
  if (shard == null) return null;
  const url = `${CDN_HOST(shard)}${basePath(nm)}/info/ru/card.json`;
  const r = await head(url, 15000);
  if (!r || !r.ok) return null;
  const raw = await r.json();
  return {
    nmId: nm,
    shard,
    name: raw.imt_name || '',
    subject: raw.subj_name || '',
    subjectRoot: raw.subj_root_name || '',
    brand: raw.selling?.brand_name || '',
    supplierId: raw.selling?.supplier_id ?? null,
    description: raw.description || '',
    photoCount: Number(raw.media?.photo_count) || 0,
    hasVideo: Boolean(raw.media?.has_video),
    options: optionsMap(raw),
  };
}

/**
 * Ссылки на первые `count` фотографий карточки.
 * Возвращает не больше, чем реально есть фото (photoCount).
 */
export function photoUrls(card, count = 3, size = 'c516x688') {
  if (!PHOTO_SIZES[size]) throw new Error(`Неизвестный размер фото: ${size}`);
  const n = Math.min(count, card.photoCount || count);
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(`${CDN_HOST(card.shard)}${basePath(card.nmId)}/images/${size}/${i}.webp`);
  }
  return out;
}

// ── Текстовый гейт по характеристикам ────────────────────────────────────────
//
// Отсеиваем ТОЛЬКО по трём полям, значения которых прямо противоречат
// жёстким признакам эталона. Всё остальное влияет на балл, но не убивает
// карточку. Отсутствие поля — это unknown, а НЕ основание для отсева:
// продавцы заполняют характеристики неравномерно.

const REJECT_RULES = [
  { field: 'Пол', bad: /^(мужской|для мальчиков)$/i },
  { field: 'Вид застежки', bad: /молни|без застёжк|без застежк|завязк|шнур/i },
  { field: 'Тип рукава', bad: /коротк|без рукав/i },
];

/**
 * Жёсткий отсев по характеристикам.
 * @returns {{rejected: boolean, field?: string, value?: string}}
 *   rejected=false и без полей — карточка идёт дальше.
 */
export function hardRejectByOptions(card) {
  const opts = card?.options || {};
  for (const rule of REJECT_RULES) {
    const value = opts[rule.field];
    if (!value) continue; // поля нет → unknown, не отсеиваем
    if (rule.bad.test(value)) {
      return { rejected: true, field: rule.field, value };
    }
  }
  return { rejected: false };
}

/**
 * Признаки эталона, которые можно взять из характеристик, не глядя на фото.
 * Ключи совпадают с атрибутами визуального профиля — чтобы потом сверять
 * заявленное продавцом с увиденным на фотографии.
 */
export function attributesFromOptions(card) {
  const o = card?.options || {};
  const has = (k, re) => (o[k] ? re.test(o[k]) : null);
  return {
    gender: o['Пол'] || null,
    fit: has('Покрой', /оверсайз|свободн/i) ? 'loose'
       : has('Покрой', /приталенн|облегающ/i) ? 'fitted' : null,
    closure: o['Вид застежки'] || null,
    chestPocket: o['Тип карманов'] ? /без карман/i.test(o['Тип карманов']) ? 'no' : 'yes' : null,
    fabricClaim: o['Состав'] || null,
    // марлевка/муслин/жатка в составе — сильный сигнал целевой ткани
    gauzeClaim: o['Состав'] ? /марлевк|муслин|жатк|жат(ая|ый)/i.test(o['Состав']) : null,
    surface: o['Фактура материала'] || null,
    translucent: o['Фактура материала']
      ? /прозрачн/i.test(o['Фактура материала']) : null,
    sleeve: o['Тип рукава'] || null,
    decor: o['Декоративные элементы'] || null,
  };
}

/** Ограниченная по конкурентности обработка списка — чтобы не долбить CDN. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { error: String(err?.message || err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
