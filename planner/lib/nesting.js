// nesting.js — правила настила (Фаза 2). Настил = один раскрой = один артикул,
// внутри разные цвета и размеры. Ориентиры (мягкие): размер ≥ minSizeQty,
// цвет ≥ minColorQty. Здесь — валидация матрицы и настил-корректное дробление.

function colorTotal(row) {
  let s = 0;
  for (const k of Object.keys(row || {})) s += +row[k] || 0;
  return Math.round(s);
}
export function matrixTotal(m) {
  let s = 0;
  for (const c of Object.keys(m || {})) s += colorTotal(m[c]);
  return Math.round(s);
}

// Нарушения настила: размер с 1..min-1 шт, или цвет с суммой < min.
export function validateMatrix(m, rules = {}) {
  const minSize = rules.minSizeQty || 20;
  const minColor = rules.minColorQty || 400;
  const out = [];
  for (const color of Object.keys(m || {})) {
    const row = m[color] || {};
    const tot = colorTotal(row);
    if (tot > 0 && tot < minColor) out.push({ kind: 'color', color, qty: tot, min: minColor });
    for (const size of Object.keys(row)) {
      const q = +row[size] || 0;
      if (q > 0 && q < minSize) out.push({ kind: 'size', color, size, qty: q, min: minSize });
    }
  }
  return out;
}

// Разделить матрицу на кусок ~targetUnits и остаток. Сначала — по ЦЕЛЫМ цветам
// (каждый цвет и так ≥ min, размеры не трогаем → кусок валиден). Если по цветам
// не выходит два непустых куска (напр. один цвет) — режем ВНУТРИ цвета
// пропорционально, сохраняя каждый размер ≥ minSizeQty (иначе размер целиком в
// больший кусок). Возвращает { chunk, remainder, method }.
export function splitPartia(m, targetUnits, rules = {}) {
  const byColor = splitByColors(m, targetUnits);
  if (matrixTotal(byColor.chunk) > 0 && matrixTotal(byColor.remainder) > 0) {
    return { chunk: byColor.chunk, remainder: byColor.remainder, method: 'color' };
  }
  return splitWithinColors(m, targetUnits, rules);
}

function splitByColors(m, targetUnits) {
  const colors = Object.keys(m || {})
    .map((c) => ({ c, tot: colorTotal(m[c]) }))
    .filter((x) => x.tot > 0)
    .sort((a, b) => b.tot - a.tot);
  const chunk = {}, remainder = {};
  let acc = 0;
  for (const { c, tot } of colors) {
    if (acc < targetUnits) { chunk[c] = { ...m[c] }; acc += tot; }
    else remainder[c] = { ...m[c] };
  }
  return { chunk, remainder };
}

function splitWithinColors(m, targetUnits, rules) {
  const minSize = rules.minSizeQty || 20;
  const total = matrixTotal(m);
  const ratio = total ? Math.min(0.99, Math.max(0.01, targetUnits / total)) : 0.5;
  const chunk = {}, remainder = {};
  for (const c of Object.keys(m || {})) {
    const ch = {}, rm = {};
    for (const s of Object.keys(m[c] || {})) {
      const q = +m[c][s] || 0;
      if (q <= 0) continue;
      let a = Math.round(q * ratio), b = q - a;
      // если одна из частей ненулевая, но меньше min — не дробим размер, отдаём целиком в больший кусок
      if ((a > 0 && a < minSize) || (b > 0 && b < minSize)) { if (ratio >= 0.5) { a = q; b = 0; } else { a = 0; b = q; } }
      if (a > 0) ch[s] = a;
      if (b > 0) rm[s] = b;
    }
    if (Object.keys(ch).length) chunk[c] = ch;
    if (Object.keys(rm).length) remainder[c] = rm;
  }
  return { chunk, remainder, method: 'size' };
}
