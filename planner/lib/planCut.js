// lib/planCut.js — движок «Сокращение плана».
// ФАЗА 0: карта соответствия «расцветка плана ↔ карточка WB (nmID)» + отчёт покрытия.
// Зачем: анализ продаж по цветам ВБ имеет смысл только если каждая расцветка плана честно
// сшита со своей карточкой ВБ (nmID). Здесь строим эту карту по a.wbKey (nmID/префикс) +
// сопоставлению названия цвета, и показываем, какая доля плана вообще покрыта данными ВБ.

import { fetchCards, resolveArticleCards, vendorColor } from './wb/wbApi.js';

// Нормализация названия цвета для сопоставления: регистр, ё→е, убрать пунктуацию/лишние пробелы.
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, ' ').trim();

// Сумма плановых штук по каждому цвету артикула из matrix[stage][color][size].
function articleColorUnits(a) {
  const out = {};
  for (const stage of Object.keys(a.matrix || {})) {
    const byColor = a.matrix[stage] || {};
    for (const color of Object.keys(byColor)) {
      let s = 0; const row = byColor[color] || {};
      for (const sz of Object.keys(row)) s += Math.max(0, Math.round(+row[sz] || 0));
      out[color] = (out[color] || 0) + s;
    }
  }
  return out;
}

/**
 * Построить карту соответствия и покрытие.
 * @returns {{ rows, summary }}
 *   rows: [{articleId, articleName, color, units, matched, nmID, wbColor, extraWb?}]
 *   summary: агрегаты (покрытие по цветам и по штукам, артикулы без ключа WB).
 */
export async function buildCoverage(state, { force = false } = {}) {
  const cards = await fetchCards({ force });
  const byNm = new Map(cards.map((c) => [String(c.nmID), c]));
  const articles = state.articles || [];
  const rows = [];
  let totalUnits = 0, matchedUnits = 0, colorsTotal = 0, colorsMatched = 0;
  const noKey = [];

  for (const a of articles) {
    const units = articleColorUnits(a);
    // активные расцветки плана (архивные уже не в плане и не считаются)
    const activeColors = (a.colors || []).filter((c) => !((a.archivedColors || []).includes(c)));
    if (!a.wbKey) noKey.push({ articleId: a.id, articleName: a.name, colors: activeColors.length, units: activeColors.reduce((s, c) => s + (units[c] || 0), 0) });

    const sibs = a.wbKey ? resolveArticleCards(a.wbKey, cards, byNm) : [];
    // карта: норм-цвет WB → {nmID, wbColor, sizes}
    const wbByColor = new Map();
    for (const c of sibs) {
      const wc = c.color || vendorColor(c.vendorCode) || '';
      const k = norm(wc);
      if (k && !wbByColor.has(k)) wbByColor.set(k, { nmID: c.nmID, wbColor: wc, sizes: (c.sizes || []).length, vendorCode: c.vendorCode });
    }

    const usedWb = new Set();
    for (const color of activeColors) {
      const u = units[color] || 0;
      totalUnits += u; colorsTotal += 1;
      const hit = wbByColor.get(norm(color));
      if (hit) { matchedUnits += u; colorsMatched += 1; usedWb.add(norm(color)); }
      rows.push({ articleId: a.id, articleName: a.name, color, units: u, matched: !!hit, nmID: hit ? hit.nmID : null, wbColor: hit ? hit.wbColor : '' });
    }
    // цвета карточек WB, не сопоставленные ни с одной расцветкой плана — подсказка для ручной сшивки
    for (const [k, v] of wbByColor) if (!usedWb.has(k)) rows.push({ articleId: a.id, articleName: a.name, color: '', units: 0, matched: false, extraWb: true, nmID: v.nmID, wbColor: v.wbColor });
  }

  return {
    rows,
    summary: {
      articles: articles.length,
      cardsCount: cards.length,
      colorsTotal, colorsMatched, colorsUnmatched: colorsTotal - colorsMatched,
      totalUnits, matchedUnits, coveragePct: totalUnits ? Math.round((matchedUnits / totalUnits) * 100) : 0,
      noKey,
    },
  };
}
