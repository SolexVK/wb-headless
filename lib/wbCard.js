// lib/wbCard.js — добор карточки WB (card.json с basket-CDN) и классификация
// рисунка ткани. Даёт то, чего нет в поисковой выдаче: СТРУКТУРНЫЕ характеристики
// (Покрой, Вырез, Рукав, Застёжка, Декор…), описание, imtId (склейка), цвета.
//
// Зачем: минус-ключи/группы фильтруют по НАЗВАНИЮ, но признак часто есть только в
// характеристиках карточки (напр. «Покрой = оверсайз» при отсутствии слова в
// названии). Матчинг по названию+характеристикам+описании убирает «грязь» бесплатно.
//
// Кэш — файловый (по nmId), т.к. характеристики почти не меняются и CLI-скилл
// запускается отдельным процессом. Путь: env CARD_CACHE_PATH или data/card-cache.json.

import fs from 'fs';
import path from 'path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const lc = (s) => String(s || '').toLowerCase();

// ── basket-хост по vol (nm//100000). Диапазоны WB; при промахе — соседи. ──
const BASKET_RANGES = [
  [0, 143, 1], [144, 287, 2], [288, 431, 3], [432, 719, 4], [720, 1007, 5],
  [1008, 1061, 6], [1062, 1115, 7], [1116, 1169, 8], [1170, 1313, 9], [1314, 1601, 10],
  [1602, 1655, 11], [1656, 1919, 12], [1920, 2045, 13], [2046, 2189, 14], [2190, 2405, 15],
  [2406, 2621, 16], [2622, 2837, 17], [2838, 3053, 18], [3054, 3269, 19], [3270, 3485, 20],
  [3486, 3701, 21], [3702, 3917, 22], [3918, 4133, 23], [4134, 4349, 24], [4350, 4565, 25],
  [4566, 4877, 26], [4878, 5189, 27],
];

export function basketHost(vol) {
  for (const [a, b, h] of BASKET_RANGES) if (vol >= a && vol <= b) return h;
  return vol > 5189 ? 28 + Math.floor((vol - 5190) / 250) : 28;
}

/** Скачивает card.json с перебором соседних basket-хостов. Возвращает объект или null. */
export async function fetchCardRaw(nmId, { timeoutMs = 8000 } = {}) {
  const nm = Number(nmId);
  if (!Number.isFinite(nm)) return null;
  const vol = Math.floor(nm / 100000);
  const part = Math.floor(nm / 1000);
  const h0 = basketHost(vol);
  // основной хост — с ретраями (пережить 429), соседние — по разу (± шире для новых vol)
  const plan = [
    [h0, 3], [h0 - 1, 1], [h0 + 1, 1], [h0 - 2, 1], [h0 + 2, 1],
    [h0 - 3, 1], [h0 + 3, 1], [h0 - 4, 1], [h0 + 4, 1],
  ].filter(([h]) => h >= 1 && h <= 60);
  for (const [h, tries] of plan) {
    const hh = String(h).padStart(2, '0');
    const url = `https://basket-${hh}.wbbasket.ru/vol${vol}/part${part}/${nm}/info/ru/card.json`;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
          const card = await res.json();
          card._host = hh;
          return card;
        }
        if (res.status === 429 && attempt < tries - 1) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        break; // не 429 (404 и т.п.) — этот хост не тот, к следующему
      } catch {
        break; // сеть/таймаут — к следующему хосту
      }
    }
  }
  return null;
}

/** Плоский список характеристик [{name,value}] из card.json (options/grouped_options). */
export function extractChars(card) {
  if (!card) return [];
  const seen = new Set();
  const out = [];
  const push = (o) => {
    if (o && o.name && !seen.has(o.name)) {
      seen.add(o.name);
      out.push({ name: o.name, value: o.value });
    }
  };
  if (Array.isArray(card.options)) card.options.forEach(push);
  for (const g of card.grouped_options || []) for (const o of g.options || []) push(o);
  return out;
}

/** Нормализованная карточка: { chars, description, imtId, colors, text }. */
export function normalizeCard(card) {
  const chars = extractChars(card);
  const description = card?.description || '';
  const imtId = card?.imt_id ?? card?.imtId ?? null;
  const colors = (card?.colors || card?.nm_colors_names || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  // «текст карточки» для матчинга: характеристики (имя+значение) + описание
  const text = [chars.map((c) => `${c.name} ${c.value}`).join(' '), description].join(' ');
  return { chars, description, imtId, colors, text };
}

// ── файловый кэш карточек ──────────────────────────────────────────────
export function openCardCache(file = process.env.CARD_CACHE_PATH || 'data/card-cache.json') {
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    store = {};
  }
  let dirty = false;
  return {
    get: (nm) => store[String(nm)],
    set: (nm, v) => {
      store[String(nm)] = v;
      dirty = true;
    },
    flush: () => {
      if (!dirty) return;
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(store));
      dirty = false;
    },
    size: () => Object.keys(store).length,
  };
}

/**
 * Обогащает строки выдачи характеристиками/описанием (по nmId). Изменяет на месте:
 * добавляет r._card = normalizeCard, r._matchText = name + текст карточки, r._pattern = Set.
 * Кэш переиспользуется между запусками. Только для строк, где нужен добор.
 * @returns {Promise<{enriched:number, fromCache:number, misses:number}>}
 */
export async function enrichRows(rows, { cache, concurrency = 8, timeoutMs = 8000, desiredPattern } = {}) {
  const stat = { enriched: 0, fromCache: 0, misses: 0 };
  const queue = rows.filter((r) => r && r.nmId != null);
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const r = queue[i++];
      let norm = cache ? cache.get(r.nmId) : undefined;
      if (norm) stat.fromCache++;
      else {
        const card = await fetchCardRaw(r.nmId, { timeoutMs });
        norm = card ? normalizeCard(card) : { chars: [], description: '', imtId: null, colors: [], text: '' };
        // Кэшируем ТОЛЬКО успешный добор: промах (429/новый vol) не должен
        // осесть как «характеристик нет» — иначе следующий прогон его не повторит.
        if (cache && card) cache.set(r.nmId, norm);
        if (card) stat.enriched++;
        else stat.misses++;
      }
      r._card = norm;
      r._matchText = lc(`${r.name || ''} ${norm.text || ''}`);
      r._pattern = classifyPattern(r._matchText);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  if (cache) cache.flush();
  return stat;
}

// ── классификация рисунка ткани ────────────────────────────────────────
// Семейства рисунка → стемы-сигналы (подстрока, нижний регистр). «однотон» —
// особое семейство (отсутствие принта).
export const PATTERN_LEX = {
  полоска: ['полос', 'страйп', 'тельняш', 'пинстрайп'],
  клетка: ['клетк', 'клетч', 'шотланд', 'тартан', 'гусин', 'виши', 'пепита'],
  горошек: ['горош', 'горох', 'polka'],
  цветочный: ['цветоч', 'флораль', 'цветы', 'растительн', 'ботаническ'],
  принт: ['принт', 'абстракт', 'орнамент', 'узор', 'пейсли', 'леопард', 'зебр', 'питон', 'камуфляж', 'тай-дай', 'тайдай', 'градиент', 'геометр', 'анимализ'],
  надписи: ['надпис', 'логотип', 'слоган', 'буквенн'],
  однотон: ['однотон', 'без принта', 'без рисунка', 'гладкокраш', 'монохром'],
};

/** Множество семейств рисунка, найденных в тексте (может включать 'однотон'). */
export function classifyPattern(text) {
  const t = lc(text);
  const tags = new Set();
  for (const [fam, stems] of Object.entries(PATTERN_LEX)) {
    if (stems.some((s) => t.includes(s))) tags.add(fam);
  }
  return tags;
}

const NON_PLAIN = ['полоска', 'клетка', 'горошек', 'цветочный', 'принт', 'надписи'];

/**
 * Вердикт по рисунку для карточки при желаемом типе.
 * @param {Set} tags       результат classifyPattern
 * @param {string} desired 'однотон' | 'полоска' | 'клетка' | 'горошек' | 'цветочный' | 'принт' | 'надписи' | '' (любой)
 * @returns {'keep'|'drop'|'uncertain'}
 */
export function patternVerdict(tags, desired) {
  if (!desired) return 'keep';
  const nonPlain = NON_PLAIN.filter((f) => tags.has(f));
  if (desired === 'однотон') {
    if (nonPlain.length) return 'drop'; // есть рисунок
    if (tags.has('однотон')) return 'keep'; // явно однотон
    return 'uncertain'; // сигнала нет — 🟡 (может быть нетегнутый принт)
  }
  // желаем конкретный рисунок
  if (tags.has(desired)) return 'keep';
  if (nonPlain.length || tags.has('однотон')) return 'drop'; // другой рисунок/однотон
  return 'uncertain'; // сигнала нет — 🟡
}
