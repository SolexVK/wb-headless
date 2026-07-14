// lib/wbCards.js — прямой доступ к публичным карточкам Wildberries (без MPStats-квоты).
//
// Источник: basket-хосты WB. По nmId вычисляем vol=nm//100000, part=nm//1000 и хост
// basket-NN (таблица диапазонов + фолбэк на соседей). Отдаёт card.json (характеристики,
// описание, число фото) и ссылки на слайды images/big/{i}.webp — для визуального разбора
// воронки (первый слайд = драйвер CTR, инфографика, порядок смыслов).

import { writeFile, mkdir } from 'node:fs/promises';

// Диапазоны vol → basket-хост (из wb_analyze.py, актуализировано до 28).
const BASKET_RANGES = [
  [0, 143, '01'], [144, 287, '02'], [288, 431, '03'], [432, 719, '04'],
  [720, 1007, '05'], [1008, 1061, '06'], [1062, 1115, '07'], [1116, 1169, '08'],
  [1170, 1313, '09'], [1314, 1601, '10'], [1602, 1655, '11'], [1656, 1919, '12'],
  [1920, 2045, '13'], [2046, 2189, '14'], [2190, 2405, '15'], [2406, 2621, '16'],
  [2622, 2837, '17'], [2838, 3053, '18'], [3054, 3269, '19'], [3270, 3485, '20'],
  [3486, 3701, '21'], [3702, 3917, '22'], [3918, 4133, '23'], [4134, 4349, '24'],
  [4350, 4565, '25'], [4566, 4877, '26'], [4878, 5189, '27'],
];

const UA = 'Mozilla/5.0 (compatible; wb-analyze/1.0)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function basketHost(vol) {
  for (const [a, b, h] of BASKET_RANGES) if (vol >= a && vol <= b) return h;
  return '28';
}

// Кэш найденного хоста по vol (у карточек одного vol хост совпадает).
const _hostByVol = new Map();

// Порядок перебора хостов: сначала оценка по vol, затем расширяющаяся окрестность.
// Таблица BASKET_RANGES устарела для современных 10-значных nmId (vol > 5189),
// поэтому линейно экстраполируем и перебираем 1..60.
function hostProbeOrder(vol) {
  let guess;
  if (vol <= 5189) {
    guess = Number(basketHost(vol));
  } else {
    // эмпирика: ~240 vol на хост сверх диапазона таблицы (vol 10161 → ~41)
    guess = Math.round(27 + (vol - 5189) / 240);
  }
  const order = [];
  const seen = new Set();
  const push = (h) => { if (h >= 1 && h <= 60 && !seen.has(h)) { seen.add(h); order.push(h); } };
  for (let d = 0; d <= 60; d++) { push(guess - d); push(guess + d); }
  return order;
}

async function curl(url, { tries = 2, timeoutMs = 15000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.status === 429 || resp.status >= 500) {
        last = new Error(`HTTP ${resp.status}`);
        await sleep(600 * (i + 1));
        continue;
      }
      if (!resp.ok) return null;
      return resp;
    } catch (e) {
      last = e;
      await sleep(500 * (i + 1));
    }
  }
  if (last) return null;
  return null;
}

/** card.json карточки: характеристики, описание, media.photo_count + служебные _host/_vol/_part. */
export async function fetchCard(nm) {
  nm = Number(nm);
  const vol = Math.floor(nm / 100000);
  const part = Math.floor(nm / 1000);
  // Если хост для этого vol уже известен — идём прямо к нему.
  const known = _hostByVol.get(vol);
  const hosts = known != null ? [known, ...hostProbeOrder(vol).filter((h) => h !== known)] : hostProbeOrder(vol);
  for (const h of hosts) {
    const hh = String(h).padStart(2, '0');
    const resp = await curl(`https://basket-${hh}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/ru/card.json`, { tries: 1 });
    if (!resp) continue;
    const text = await resp.text();
    if (text && text.trimStart().startsWith('{')) {
      try {
        const d = JSON.parse(text);
        d._host = hh; d._vol = vol; d._part = part; d._nm = nm;
        _hostByVol.set(vol, h);
        return d;
      } catch (_) {}
    }
  }
  return null;
}

/** Ссылки на слайды images/{size}/{i}.webp (до limit штук).
 *  size: 'big' (~900px), 'c516x688' (средний), 'c246x328' (миниатюра для ленты). */
export function slideUrls(card, limit = 5, size = 'big') {
  if (!card) return [];
  const nm = card._nm;
  const n = card?.media?.photo_count || limit;
  const { _host: h, _vol: vol, _part: part } = card;
  const count = Math.min(Number(n) || limit, limit);
  return Array.from({ length: count }, (_, i) =>
    `https://basket-${h}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/${size}/${i + 1}.webp`
  );
}

/** Плоский список видимых характеристик [{name,value}] из card.json. */
export function characteristics(card) {
  if (!card) return [];
  if (Array.isArray(card.options) && card.options.length) {
    return card.options.filter((o) => o.name).map((o) => ({ name: o.name, value: o.value }));
  }
  const out = [];
  for (const g of card.grouped_options || []) {
    for (const o of g.options || []) if (o.name) out.push({ name: o.name, value: o.value });
  }
  return out;
}

/** Скачивает слайды карточки в dir/<nm>_<size>_<i>.webp; возвращает список сохранённых путей. */
export async function downloadSlides(card, dir, limit = 5, size = 'big') {
  const urls = slideUrls(card, limit, size);
  await mkdir(dir, { recursive: true });
  const tag = size === 'big' ? '' : `_${size}`;
  const saved = [];
  for (let i = 0; i < urls.length; i++) {
    const resp = await curl(urls[i], { tries: 2 });
    if (!resp) continue;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 500) continue; // пустой/битый
    const p = `${dir}/${card._nm}${tag}_${i + 1}.webp`;
    await writeFile(p, buf);
    saved.push({ path: p, url: urls[i], index: i + 1, bytes: buf.length });
  }
  return saved;
}
