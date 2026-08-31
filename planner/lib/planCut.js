// lib/planCut.js — движок «Сокращение плана».
// ФАЗА 0: карта соответствия «расцветка плана ↔ карточка WB (nmID)» + отчёт покрытия.
// Зачем: анализ продаж по цветам ВБ осмыслен, только если каждая расцветка плана честно
// сшита со своей карточкой ВБ (nmID). Сшивка: авто по названию цвета + РУЧНАЯ через
// a.wbColorMap { расцветка → nmID } (пользователь правит в интерфейсе). Штуки плана берём
// из партий (planMatrix), МАКС по этапам — чтобы не задваивать (одна вещь проходит все этапы).
//
// ГРУППА АРТИКУЛА (строго!): цвета берутся ТОЛЬКО из карточек, чей vendorCode начинается на
// номер артикула (первые цифры, напр. «034» → 034_рмж_цвет_пк). Так исключено смешивание с
// другими артикулами и подтягиваются ВСЕ цвета группы (в т.ч. те, чьи nmID не перечисляли).

import { fetchCards, vendorColor } from './wb/wbApi.js';

// Нормализация названия цвета для авто-сопоставления: регистр, ё→е, убрать пунктуацию/пробелы.
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/gi, ' ').trim();
const wbColorOf = (c) => (c.color || vendorColor(c.vendorCode) || '');

// Ведущие цифры строки (номер артикула): «034_рмж» → «034», «034рмж» → «034», «844264052» → как есть.
const leadDigits = (s) => (String(s || '').trim().match(/^\d+/) || [''])[0];
// Тег группы артикула = короткий номер (2–5 цифр). ПРИОРИТЕТ: номер из id артикула (003, 034).
// Только если у id нет номера — берём ЯВНЫЙ префикс из wbKey (цифры+буквы, напр. «034_рмж»).
// Голые/списочные nmID в wbKey игнорируем — они НЕ задают группу (обрывок nmID мог дать ложный тег).
function artTag(a) {
  const idd = leadDigits(a.id); if (/^\d{2,5}$/.test(idd)) return idd;
  for (const t of String(a.wbKey || '').split(/[,;\n]+/)) { const s = t.trim(); if (/^\d{2,5}[_a-zа-я-]/i.test(s)) return leadDigits(s); }
  const m = String(a.id || '').match(/\d{2,5}/); return m ? m[0] : '';
}

// Штук плана по артикул→цвет из партий (status=plan, не historical); по размеру берём МАКС
// по этапам (одна вещь = один комплект, проходит все этапы, суммировать этапы нельзя).
function planUnitsByArticleColor(state) {
  const tmp = {}; // articleId → color → size → maxQty
  for (const p of (state.partias || [])) {
    if (p.historical || p.status !== 'plan') continue;
    const m = p.planMatrix || {};
    const a = tmp[p.articleId] || (tmp[p.articleId] = {});
    for (const color of Object.keys(m)) {
      const bs = a[color] || (a[color] = {});
      for (const sz of Object.keys(m[color] || {})) {
        const q = Math.max(0, Math.round(+m[color][sz] || 0));
        bs[sz] = Math.max(bs[sz] || 0, q);
      }
    }
  }
  const out = {};
  for (const aid of Object.keys(tmp)) {
    out[aid] = {};
    for (const c of Object.keys(tmp[aid])) out[aid][c] = Object.values(tmp[aid][c]).reduce((x, v) => x + v, 0);
  }
  return out;
}

/**
 * Карта соответствия + покрытие, СГРУППИРОВАНО по артикулам (для редактирования в UI).
 * @returns {{ articles:[{articleId,articleName,wbKey,colors:[{color,units,matched,manual,nmID,wbColor}],
 *              wbCards:[{nmID,wbColor}], extraWb:[{nmID,wbColor}]}], summary }}
 */
export async function buildCoverage(state, { force = false } = {}) {
  const cards = await fetchCards({ force });
  const planU = planUnitsByArticleColor(state);

  const out = { articles: [], summary: {} };
  let totalUnits = 0, matchedUnits = 0, colorsTotal = 0, colorsMatched = 0;
  const noKey = [];

  for (const a of (state.articles || [])) {
    const activeColors = (a.colors || []).filter((c) => !((a.archivedColors || []).includes(c)));
    const units = planU[a.id] || {};
    const map = (a.wbColorMap && typeof a.wbColorMap === 'object') ? a.wbColorMap : {};
    // СТРОГО: группа артикула = карточки, чей vendorCode начинается на номер артикула (тег).
    const tag = artTag(a);
    const sibs = tag ? cards.filter((c) => leadDigits(c.vendorCode) === tag) : [];

    const wbByColor = new Map(); // норм-цвет ВБ → карточка (для авто-сшивки)
    const wbByNm = new Map();    // nmID → карточка (для ручной сшивки)
    for (const c of sibs) {
      const k = norm(wbColorOf(c));
      if (k && !wbByColor.has(k)) wbByColor.set(k, c);
      wbByNm.set(String(c.nmID), c);
    }
    const wbCards = sibs.map((c) => ({ nmID: c.nmID, wbColor: wbColorOf(c) }));

    const usedNm = new Set();
    const colors = [];
    for (const color of activeColors) {
      const u = units[color] || 0; totalUnits += u; colorsTotal += 1;
      let card = null, manual = false;
      const mapped = map[color];
      if (mapped != null && String(mapped) !== '' && wbByNm.has(String(mapped))) { card = wbByNm.get(String(mapped)); manual = true; }
      else if (mapped == null || String(mapped) === '') card = wbByColor.get(norm(color)) || null; // '' в карте = «не сшивать» пропускаем? нет: пусто = авто
      if (card) { matchedUnits += u; colorsMatched += 1; usedNm.add(String(card.nmID)); }
      colors.push({ color, units: u, matched: !!card, manual, nmID: card ? card.nmID : null, wbColor: card ? wbColorOf(card) : '' });
    }
    const extraWb = wbCards.filter((w) => !usedNm.has(String(w.nmID)));
    if (!sibs.length) noKey.push({ articleId: a.id, articleName: a.name, tag });
    out.articles.push({ articleId: a.id, articleName: a.name || '', wbKey: a.wbKey || '', tag, groupCount: sibs.length, colors, wbCards, extraWb });
  }

  out.summary = {
    articles: (state.articles || []).length, cardsCount: cards.length,
    colorsTotal, colorsMatched, colorsUnmatched: colorsTotal - colorsMatched,
    totalUnits, matchedUnits, coveragePct: totalUnits ? Math.round((matchedUnits / totalUnits) * 100) : 0,
    noKey,
  };
  return out;
}

// ── ФАЗА 1: сбор выкупов по цветам ──
// Все nmID, сшитые с расцветками плана (по ним тянем продажи).
export function mappedNmIds(coverage) {
  const s = new Set();
  for (const a of (coverage.articles || [])) for (const c of (a.colors || [])) if (c.matched && c.nmID != null) s.add(Number(c.nmID));
  return s;
}

// Свести карту сшивки + агрегат продаж по nmID → «продаваемость расцветок» по артикул×цвет.
// buyouts = НЕТТО выкупов (продажи − возвраты) за окно; null = расцветка не сшита (данных нет).
export function buildSalesView(coverage, salesByNm, window) {
  const byNm = salesByNm || {};
  const articles = (coverage.articles || []).map((a) => {
    const colors = (a.colors || []).map((c) => {
      const s = (c.matched && c.nmID != null) ? (byNm[String(c.nmID)] || null) : null;
      return {
        color: c.color, nmID: c.nmID, matched: c.matched, units: c.units,
        buyouts: s ? s.net : (c.matched ? 0 : null),
        forPay: s ? Math.round(s.forPay) : (c.matched ? 0 : null),
        firstDate: s ? s.firstDate : '', lastDate: s ? s.lastDate : '',
      };
    }).sort((x, y) => (y.buyouts ?? -1) - (x.buyouts ?? -1)); // лидеры продаж сверху
    const totBuyouts = colors.reduce((n, c) => n + (c.buyouts || 0), 0);
    const totForPay = colors.reduce((n, c) => n + (c.forPay || 0), 0);
    return { articleId: a.articleId, articleName: a.articleName, tag: a.tag, colors, totBuyouts, totForPay };
  });
  return {
    window: window || null,
    articles,
    summary: {
      articles: articles.length,
      totalBuyouts: articles.reduce((n, a) => n + a.totBuyouts, 0),
      totalForPay: articles.reduce((n, a) => n + a.totForPay, 0),
    },
  };
}
