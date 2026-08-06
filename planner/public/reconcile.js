// reconcile.js — СЛОЙ ПРИМИРЕНИЯ прогноза (Ранг сезонности) с карточкой артикула для «Плана
// по размерам». Чистый ESM (тестируется в Node, импортируется браузером). Архитектура C+:
//   • цвета: alias-словарь → авто-матч по канону → 3 корзины (совпало/решить/новое);
//   • размеры: диапазон спроса → дискретные размеры ряда (поровну), непокрытое → «не размещено»;
//   • ноль потерь: любое неразмещённое количество явно в unassigned (никогда не молча);
//   • детерминированное округление (Хэмилтон) — сумма ячеек точна, остаток в корзину.

import { canonColor } from './colorNorm.js';

// ── Размеры: числовой интервал и буквенный индекс (XXL==2XL, XXXL==3XL) ──
function parseNum(name) {
  const s = String(name || '');
  const r = s.match(/(\d{2,3})\s*[-–—]\s*(\d{2,3})/);
  if (r) { let a = +r[1], b = +r[2]; if (a > b) [a, b] = [b, a]; return { lo: a, hi: b }; }
  const m = s.match(/(\d{2,3})/);
  if (m) { const n = +m[1]; return { lo: n, hi: n }; }
  return null;
}
const BASE = { XXXS: -2, XXS: -1, XS: 0, S: 1, M: 2, L: 3, XL: 4 };
function letterIdx(s) {
  const t = String(s || '').toUpperCase().replace(/\s+/g, '');
  if (t in BASE) return BASE[t];
  let m = t.match(/^(\d+)XL$/); if (m) return 4 + (+m[1]) - 1;   // 2XL→5, 3XL→6…
  m = t.match(/^(X+)L$/); if (m) return 4 + m[1].length - 1;     // XXL→5, XXXL→6…
  m = t.match(/^(\d+)XS$/); if (m) return 0 - ((+m[1]) - 1);
  m = t.match(/^(X+)S$/); if (m) return 0 - (m[1].length - 1);
  return null;
}
// Буквенный интервал метки/оригина: «S-L» → [1,3], «M» → [2,2], иначе null.
function letterSpan(s) {
  const parts = String(s || '').split(/[-–—]/).map((x) => letterIdx(x)).filter((x) => x != null);
  if (!parts.length) return null;
  return [Math.min(...parts), Math.max(...parts)];
}
const normLabel = (s) => String(s || '').trim().toLowerCase().replace(/\s*[-–—]\s*/g, '-');

// Покрывает ли размер спроса (диапазон size_name + origin-буквы) дискретный размер ряда.
function sizeCovers(demandName, demandOrigin, artSize) {
  if (normLabel(demandName) === normLabel(artSize) || normLabel(demandOrigin) === normLabel(artSize)) return true;
  const artNum = parseNum(artSize), dNum = parseNum(demandName);
  if (artNum && dNum && artNum.lo === artNum.hi && artNum.lo >= dNum.lo && artNum.lo <= dNum.hi) return true; // 44 ∈ [44,46]
  if (artNum && dNum && !(artNum.lo === artNum.hi)) { // ряд тоже диапазонами: пересечение интервалов
    if (Math.max(artNum.lo, dNum.lo) <= Math.min(artNum.hi, dNum.hi)) return true;
  }
  const artL = letterIdx(artSize), dSpan = letterSpan(demandOrigin) || letterSpan(demandName);
  if (artL != null && dSpan && artL >= dSpan[0] && artL <= dSpan[1]) return true;
  return false;
}

// Детерминированное распределение целого total по весам (Хэмилтон): сумма = total, без потерь.
function apportion(total, keys, weightOf) {
  const T = Math.max(0, Math.round(total));
  const W = keys.reduce((s, k) => s + Math.max(0, weightOf(k)), 0);
  if (T === 0 || W <= 0 || !keys.length) return { alloc: Object.fromEntries(keys.map((k) => [k, 0])), placed: 0 };
  const raw = keys.map((k) => ({ k, exact: T * Math.max(0, weightOf(k)) / W }));
  const alloc = {}; let used = 0;
  for (const r of raw) { alloc[r.k] = Math.floor(r.exact); used += alloc[r.k]; }
  const rema = raw.map((r) => ({ k: r.k, frac: r.exact - Math.floor(r.exact) })).sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < T - used; i++) alloc[rema[i % rema.length].k] += 1;
  return { alloc, placed: T };
}

/**
 * Свести прогноз (кол-во по канон-цветам × доли размеров) в матрицу цвет×размер карточки.
 * @param {{colors:string[], sizes:string[], colorMap?:Object}} article — цвета/размеры ряда +
 *        пер-артикул привязки {канон-цвет → имя-цвета-карточки}.
 * @param {Array<{name:string, qty:number}>} colorRows — ядро цветов (канон-имена + кол-во).
 * @param {Array<{size:string, origin?:string, share:number}>} sizeRows — ядро размеров (доли, %).
 * @param {{aliases?:Object, sizeSplit?:string}} [opts] — aliases: глобальный словарь; sizeSplit='equal'.
 */
export function reconcilePlan(article, colorRows, sizeRows, { aliases = {}, sizeSplit = 'equal' } = {}) {
  const artColors = Array.isArray(article.colors) ? article.colors : [];
  const artSizes = Array.isArray(article.sizes) ? article.sizes : [];
  const colorMap = (article.colorMap && typeof article.colorMap === 'object') ? article.colorMap : {};

  // ── ЦВЕТА: канон каждого цвета карточки (алиас-или-normColor) → карта канон → [цвета карточки].
  const canonToArt = new Map();
  for (const ac of artColors) {
    const cn = canonColor(ac, aliases);
    if (!canonToArt.has(cn)) canonToArt.set(cn, []);
    canonToArt.get(cn).push(ac);
  }
  const colors = (colorRows || []).map((r) => {
    const demand = r.name; const qty = Math.round(+r.qty || 0);
    // 1) явная пер-артикул привязка
    if (colorMap[demand] && artColors.includes(colorMap[demand])) {
      return { demand, qty, status: 'matched', articleColor: colorMap[demand], explicit: true };
    }
    // 2) авто-матч по канону
    const cands = canonToArt.get(demand) || [];
    if (cands.length === 1) return { demand, qty, status: 'matched', articleColor: cands[0] };
    if (cands.length > 1) return { demand, qty, status: 'ambiguous', candidates: cands };
    // 3) новое
    return { demand, qty, status: 'new', candidates: artColors.slice() };
  });

  // ── РАЗМЕРЫ: вес по каждому размеру ряда (поровну от доли покрывающего диапазона), и доля,
  // не легшая ни на один размер ряда → в «не размещено».
  const rows = (sizeRows || []).filter((s) => (+s.share || 0) > 0);
  const totShare = rows.reduce((s, r) => s + (+r.share || 0), 0) || 1;
  const sizeWeights = Object.fromEntries(artSizes.map((s) => [s, 0]));
  const sizes = rows.map((r) => {
    const norm = (+r.share || 0) / totShare;
    const covered = artSizes.filter((as) => sizeCovers(r.size, r.origin, as));
    if (covered.length) { const per = norm / covered.length; for (const as of covered) sizeWeights[as] += per; } // ПОРОВНУ между накрытыми
    return { demand: r.size, origin: r.origin || '', share: r.share, articleSizes: covered, covered: covered.length > 0 };
  });
  // Непокрытые размерные доли (размер спроса, которого нет в ряду) НЕ теряем, а перераспределяем на
  // существующие размеры: нормируем веса к 1. Тогда ПОЛНОЕ кол-во цвета попадает в матрицу — суммы
  // по цвету в 🧩 совпадают с 🎨. Полностью неразмещённым цвет остаётся только если ряд пуст (wSum=0).
  const wSum = artSizes.reduce((s, as) => s + sizeWeights[as], 0);
  if (wSum > 0) for (const as of artSizes) sizeWeights[as] /= wSum;
  const assignedFraction = wSum > 0 ? 1 : 0;
  const unassignedSizeFraction = wSum > 0 ? 0 : 1;

  // ── МАТРИЦА: для сопоставленных цветов раскидываем qty×assignedFraction по размерам (Хэмилтон).
  const matrix = {};
  const unItems = [];
  for (const c of colors) {
    if (c.status === 'matched') {
      const placeTotal = Math.round(c.qty * assignedFraction);
      const { alloc, placed } = apportion(placeTotal, artSizes, (as) => sizeWeights[as]);
      matrix[c.articleColor] = matrix[c.articleColor] || Object.fromEntries(artSizes.map((s) => [s, 0]));
      for (const as of artSizes) matrix[c.articleColor][as] += alloc[as];
      const leftover = c.qty - placed; // непокрытые размеры + округление
      if (leftover > 0) unItems.push({ color: c.demand, articleColor: c.articleColor, qty: leftover, reason: 'unmapped-size' });
    } else {
      // цвет не сопоставлен → всё кол-во ждёт решения пользователя
      if (c.qty > 0) unItems.push({ color: c.demand, qty: c.qty, reason: c.status === 'ambiguous' ? 'ambiguous-color' : 'new-color' });
    }
  }
  const unassignedTotal = unItems.reduce((s, x) => s + x.qty, 0);
  const totalPlanned = Object.values(matrix).reduce((s, row) => s + Object.values(row).reduce((a, v) => a + v, 0), 0);

  return {
    matrix,
    colors,
    sizes,
    sizeWeights,
    unassignedSizeFraction: Math.round(unassignedSizeFraction * 1000) / 10, // % для UI
    unassigned: { total: unassignedTotal, items: unItems },
    newColors: colors.filter((c) => c.status === 'new').map((c) => c.demand),
    ambiguousColors: colors.filter((c) => c.status === 'ambiguous').map((c) => c.demand),
    totalPlanned,
  };
}

/**
 * Разложить готовую матрицу цвет×размер на N частей по долям поставок (Этап 3, серия поставок).
 * Каждая ячейка делится методом Хэмилтона → целые, Σчастей = исходная ячейка (НОЛЬ ПОТЕРЬ).
 * Пропорции берём только по времени (доли объёмов поставок) — полный цветной тираж сохраняется.
 * @param {Object} matrix — {цвет → {размер → шт}} (например result.matrix).
 * @param {number[]} shares — веса поставок (напр. qty каждой поставки); нормируются внутри.
 * @returns {Array<Object>} массив из shares.length матриц того же формата.
 */
export function splitMatrixByShares(matrix, shares) {
  const n = Array.isArray(shares) ? shares.length : 0;
  if (n <= 1) return [JSON.parse(JSON.stringify(matrix || {}))]; // одна поставка — вся матрица целиком
  const total = shares.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const norm = shares.map((s) => Math.max(0, s) / total);
  const idx = norm.map((_, i) => i);
  const out = Array.from({ length: n }, () => ({}));
  for (const color of Object.keys(matrix || {})) {
    for (const size of Object.keys(matrix[color] || {})) {
      const v = Math.round(matrix[color][size] || 0);
      if (v <= 0) continue;
      const { alloc } = apportion(v, idx, (i) => norm[i]);
      for (let i = 0; i < n; i++) if (alloc[i] > 0) (out[i][color] = out[i][color] || {})[size] = alloc[i];
    }
  }
  return out;
}
