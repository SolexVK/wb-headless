// supply.js — НЕТТИНГ спроса против уже существующего предложения (Этап 3, Фаза 1).
//
// Идея: план продаж (довозы = партии со сроком прихода на WB) — это СПРОС. Но часть товара
// уже есть/едет/шьётся вне плана — это ПРЕДЛОЖЕНИЕ. К производству нужно только то, чего не
// хватает: net = план − покрытое предложением. Покрытие — хронологическое, по каждой ячейке
// цвет×размер: предложение, доступное к дате довоза (availableOn ≤ дата), гасит его спрос;
// остаток предложения переходит на следующий довоз. Даты довозов НЕ двигаем — партии просто
// уменьшаются/обнуляются. planMatrix не трогаем (живой слой) — net считается на каждом recalc.

import { normColor } from '../public/colorNorm.js';

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '').slice(0, 10));

/**
 * @param {object} state — полное состояние (articles, partias, supplies).
 * @param {string} todayISO — «сегодня» (для предложения без даты и для source=wb).
 * @returns {{ net: Object<string,Object>, arrivals: Array, unmatched: Array }}
 *   net[partiaId] = матрица «к производству» (план минус покрытое). Для план-партий без
 *   предложения = копия planMatrix. arrivals — приход предложения для Ганта. unmatched —
 *   строки предложения, чей цвет не сопоставлен с артикулом (в неттинг не пошли).
 */
export function computeSupplyNetting(state, todayISO) {
  const today = isDate(todayISO) ? String(todayISO).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const net = {}; const arrivals = []; const unmatched = [];
  const supByArt = {};
  for (const s of (state.supplies || [])) (supByArt[s.articleId] = supByArt[s.articleId] || []).push(s);

  // план-партии (будущее производство) по артикулам; уже начатые (не 'plan') не неттингуем
  const partsByArt = {};
  for (const p of (state.partias || [])) {
    if (p.historical || p.status !== 'plan' || !p.deadline) continue;
    (partsByArt[p.articleId] = partsByArt[p.articleId] || []).push(p);
    net[p.id] = JSON.parse(JSON.stringify(p.planMatrix || {})); // старт: net = план
  }

  for (const a of (state.articles || [])) {
    const parts = (partsByArt[a.id] || []).slice().sort((x, y) => String(x.deadline).localeCompare(String(y.deadline)));
    const sup = supByArt[a.id] || [];
    if (!parts.length || !sup.length) continue;
    const artColors = a.colors || [];
    // канон → имя цвета артикула (для сопоставления цвета предложения с цветом артикула)
    const canonToArt = new Map();
    for (const c of artColors) { const cn = normColor(c); if (!canonToArt.has(cn)) canonToArt.set(cn, c); }
    // события предложения по ячейке "цвет|размер": [{date, qty}]
    const events = new Map();
    for (const s of sup) {
      const when = isDate(s.availableOn) ? String(s.availableOn).slice(0, 10) : today;
      for (const scol of Object.keys(s.matrix || {})) {
        const artCol = artColors.includes(scol) ? scol : canonToArt.get(normColor(scol));
        for (const sz of Object.keys(s.matrix[scol] || {})) {
          const qty = Math.max(0, Math.round(+s.matrix[scol][sz] || 0));
          if (qty <= 0) continue;
          if (!artCol) { unmatched.push({ articleId: a.id, color: scol, size: sz, qty, source: s.source }); continue; }
          const key = artCol + '|' + sz;
          const arr = events.get(key) || (events.set(key, []), events.get(key));
          arr.push({ date: when, qty });
        }
      }
    }
    // хронологическое покрытие каждой ячейки
    for (const [key, evs] of events) {
      const sep = key.lastIndexOf('|');
      const color = key.slice(0, sep), size = key.slice(sep + 1);
      evs.sort((x, y) => x.date.localeCompare(y.date));
      let pool = 0, si = 0;
      for (const p of parts) {
        while (si < evs.length && evs[si].date <= String(p.deadline || '9999-12-31')) { pool += evs[si].qty; si++; }
        const need = Math.round(+(((p.planMatrix || {})[color] || {})[size]) || 0);
        if (need <= 0) continue;
        const cover = Math.min(pool, need); pool -= cover;
        if (cover > 0) { net[p.id][color] = net[p.id][color] || {}; net[p.id][color][size] = Math.max(0, need - cover); }
      }
    }
  }

  for (const s of (state.supplies || [])) {
    let units = 0; for (const c in (s.matrix || {})) for (const sz in s.matrix[c]) units += Math.max(0, Math.round(+s.matrix[c][sz] || 0));
    if (units > 0) arrivals.push({ id: s.id, articleId: s.articleId, source: s.source, availableOn: isDate(s.availableOn) ? String(s.availableOn).slice(0, 10) : today, units, matrix: s.matrix });
  }
  arrivals.sort((x, y) => String(x.availableOn).localeCompare(String(y.availableOn)));
  return { net, arrivals, unmatched };
}

// сумма матрицы { цвет: { размер: qty } }
export function sumSupplyMatrix(M) {
  let s = 0; for (const c in (M || {})) for (const sz in M[c]) s += Math.max(0, Math.round(+M[c][sz] || 0));
  return s;
}

// прибавить матрицу src к dst (по ячейкам цвет×размер)
function addMatrixInto(dst, src) {
  for (const c in (src || {})) { dst[c] = dst[c] || {}; for (const sz in src[c]) dst[c][sz] = (+dst[c][sz] || 0) + (+src[c][sz] || 0); }
}

/**
 * Объединение мелких довозов ПОСЛЕ вычета остатков. Если нетто-остаток план-партии (довоза)
 * меньше минимальной производственной партии — сливаем его ВПЕРЁД, в следующий по сроку довоз
 * того же артикула (накопительно). Мутирует `net` (обнуляет слитый довоз, наращивает следующий).
 * Хвост (последний довоз) оставляем как есть — сливать некуда. Возвращает список слияний для меток.
 * @returns {Array<{articleId, from, into, units}>}
 */
export function mergeSmallNetDeliveries(state, net, minBatch) {
  const merges = [];
  const min = Math.max(0, Math.round(+minBatch || 0));
  if (min <= 0) return merges;
  const byArt = {};
  for (const p of (state.partias || [])) {
    if (p.historical || p.status !== 'plan' || !p.deadline || !net[p.id]) continue;
    (byArt[p.articleId] = byArt[p.articleId] || []).push(p);
  }
  for (const aid in byArt) {
    const parts = byArt[aid].sort((x, y) => String(x.deadline).localeCompare(String(y.deadline)));
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const u = sumSupplyMatrix(net[p.id]);
      if (u > 0 && u < min) {                 // мал → сливаем в следующий довоз
        const nx = parts[i + 1];
        net[nx.id] = net[nx.id] || {};
        addMatrixInto(net[nx.id], net[p.id]);
        merges.push({ articleId: aid, from: p.id, into: nx.id, units: u });
        net[p.id] = {};                        // довоз больше не шьётся отдельно
      }
    }
  }
  return merges;
}
