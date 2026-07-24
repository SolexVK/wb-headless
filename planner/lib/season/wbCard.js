// wbCard.js — бесплатное обогащение данных о товаре из публичной карточки WB
// (basket-CDN, card.json). Короткое «название» из выдачи MPStats часто не отражает
// особенности товара, из-за чего плюс/минус-слова фильтра не срабатывают. Здесь мы
// достаём ПОЛНУЮ карточку: заголовок (imt_name), описание и характеристики (options)
// — и собираем богатый текст для сопоставления. Источник тот же CDN, что и картинки,
// поэтому лимиты MPStats не расходуются.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'wb-cache', 'cardinfo');
const TTL_MS = 30 * 24 * 3600 * 1000; // карточки меняются редко — кэш на 30 дней
const HOST_MAX = 40;

// Оценка basket-хоста по «тому» (vol). Диапазоны со временем расширяются, поэтому это
// лишь стартовая точка — реальный хост подбирается перебором соседей (см. fetchCardInfo),
// а найденный хост запоминается per-vol (все nmID одного тома живут на одном хосте).
function guessHost(vol) {
  const t = [143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405,
    2621, 2833, 3061, 3299, 3537, 3801, 3993, 4235, 4463, 4653, 4863, 5062, 5322, 5586, 5860, 6144];
  for (let i = 0; i < t.length; i++) if (vol <= t[i]) return i + 1;
  return t.length + 1;
}

const _volHost = new Map(); // vol -> подтверждённый номер basket-хоста (в памяти на процесс)

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

function cardUrl(host, vol, part, nm) {
  return `https://basket-${String(host).padStart(2, '0')}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/ru/card.json`;
}

async function getJson(url, timeoutMs = 8000) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return null;
  return resp.json();
}

// Порядок кандидатов-хостов: подтверждённый для тома → оценка → соседи вокруг оценки.
function hostCandidates(vol) {
  const out = [];
  const push = (h) => { if (h >= 1 && h <= HOST_MAX && !out.includes(h)) out.push(h); };
  if (_volHost.has(vol)) push(_volHost.get(vol));
  const g = guessHost(vol);
  push(g);
  for (let d = 1; d <= 6; d++) { push(g + d); push(g - d); }
  return out;
}

function parseCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const options = Array.isArray(raw.options)
    ? raw.options.map((o) => ({ name: o.name || '', value: o.value != null ? String(o.value) : '' }))
    : [];
  return {
    nmId: raw.nm_id,
    imtName: raw.imt_name || '',
    subjName: raw.subj_name || '',
    subjRoot: raw.subj_root_name || '',
    vendorCode: raw.vendor_code || '',
    description: raw.description || '',
    options,
  };
}

/** Достать карточку одного nmID (с кэшем и подбором хоста). null при неудаче. */
export async function fetchCardInfo(nmId, { force = false } = {}) {
  const nm = Number(nmId);
  if (!Number.isFinite(nm) || nm <= 0) return null;
  if (!force) { const c = readCache(nm); if (c !== undefined) return c; }
  const vol = Math.floor(nm / 100000), part = Math.floor(nm / 1000);
  for (const host of hostCandidates(vol)) {
    let raw;
    try { raw = await getJson(cardUrl(host, vol, part, nm)); } catch { raw = null; }
    if (raw) { _volHost.set(vol, host); const info = parseCard(raw); writeCache(nm, info); return info; }
  }
  writeCache(nm, null); // запомним промах, чтобы не долбить CDN каждый раз
  return null;
}

/** Пакетно достать карточки с ограничением параллелизма. Возвращает Map nmId->info|null. */
export async function fetchCardsInfo(nmIds, { concurrency = 8, force = false } = {}) {
  const ids = [...new Set((nmIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const out = new Map();
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      out.set(id, await fetchCardInfo(id, { force }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return out;
}

/** Богатый текст для сопоставления слов: заголовок + предмет + описание + характеристики. */
export function cardMatchText(info) {
  if (!info) return '';
  const opt = (info.options || []).map((o) => `${o.name} ${o.value}`).join(' ');
  return [info.imtName, info.subjRoot, info.subjName, info.vendorCode, info.description, opt]
    .filter(Boolean).join(' \n ').toLowerCase();
}
