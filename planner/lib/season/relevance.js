// relevance.js — «поведенческая релевантность» вместо фильтра плюс/минус-слов.
//
// Идея (подтверждена живым тестом): товар «наш», если ЗАМЕТНАЯ доля его поискового
// трафика приходится на целевые слова/фразы. Муслиновая рубашка ранжируется по
// «муслин…», льняная — нет (0%), даже если в описании слово «муслин» есть. Поэтому
// текстовый предфильтр по карточке — лишь дешёвое СУЖЕНИЕ (чтобы не дёргать by_keywords
// по сотням), а РЕШАЕТ долю целевого трафика ≥ порога.
//
// Экономия суточного лимита MPStats (всего ~150/сут): профили by_keywords берём сначала
// из БД (кэш 30 дней), сеть — только за неизвестными и в пределах budget; каждый новый
// профиль сразу пишем в БД, чтобы переиспользовать в других отчётах.

import { fetchItemKeywords, DailyLimitError } from './wbKeywords.js';
import { keywordsLoadMany, keywordsSave } from '../db.js';

const KEYWORD_TTL_MS = 30 * 24 * 3600 * 1000;
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

/**
 * Доля целевого трафика профиля. Целевым считаем трафик фразы, если она содержит
 * любое целевое слово (подстрока) ИЛИ её нормализованная форма совпала с выбранной
 * фразой. Возвращает {share, targetTraffic, total, matched, top}.
 */
export function scoreProfile(profile, { targetWords = [], pickedNorms = [] } = {}) {
  const tw = targetWords.map(norm).filter(Boolean);
  const picked = new Set(pickedNorms.map(norm).filter(Boolean));
  const phrases = (profile && profile.phrases) || [];
  const total = (profile && profile.total) || 0;
  let tgt = 0, matched = 0, top = null;
  for (const p of phrases) {
    const ph = norm(p.phrase);
    const byWord = tw.some((w) => ph.includes(w));
    const byPick = picked.size && (picked.has(ph) || [...picked].some((pk) => ph.includes(pk)));
    if (byWord || byPick) { tgt += p.traffic; if (byPick) matched++; if (!top) top = p; }
  }
  return { share: total > 0 ? tgt / total : 0, targetTraffic: tgt, total, matched, top };
}

/**
 * Отобрать из пула кандидатов те, у кого доля целевого трафика ≥ threshold.
 * @param {Array} pool — элементы с {wb, _matchText?}. _matchText (текст карточки) —
 *   для бесплатного предфильтра, чтобы сузить круг before by_keywords.
 * @param {object} o
 * @param {string[]} o.targetWords   — целевые слова (муслин, марлевк).
 * @param {string[]} o.pickedPhrases — выбранные пользователем фразы предмета.
 * @param {number}   o.threshold     — минимальная доля целевого трафика (0..1).
 * @param {number}   o.budget        — максимум СЕТЕВЫХ запросов by_keywords за отчёт.
 * @param {string}   o.d1,o.d2       — период для by_keywords.
 * @param {function} [o.onProgress], [o.log]
 * @returns {Promise<{keep:Set, scores:Map, requests:number, cached:number, dailyLimit:?string, prefiltered:number}>}
 */
export async function filterByRelevance(pool, {
  targetWords = [], pickedPhrases = [], threshold = 0.2, budget = 60,
  d1, d2, onProgress, log,
} = {}) {
  const L = (msg) => { if (log) log.push({ t: new Date().toISOString(), stage: 'релевантность', msg }); };
  const tw = targetWords.map(norm).filter(Boolean);
  const pickedNorms = pickedPhrases.map(norm).filter(Boolean);
  const pickedWords = pickedNorms.flatMap((p) => p.split(/\s+/)).filter((w) => w.length > 3);

  // 1) бесплатный предфильтр карточками: сузить круг под by_keywords
  const looksTarget = (t) => {
    if (!t) return false;
    if (tw.some((w) => t.includes(w))) return true;
    if (pickedWords.length && pickedWords.some((w) => t.includes(w))) return true;
    return false;
  };
  const hasFilter = tw.length || pickedWords.length;
  const cand = hasFilter ? pool.filter((it) => looksTarget(it._matchText)) : pool.slice();
  L(`Предфильтр карточками: кандидатов ${cand.length} из ${pool.length}${hasFilter ? '' : ' (без целевых слов — берём весь пул)'}.`);

  // 2) кэш из БД — бесплатно
  const cachedMap = keywordsLoadMany(cand.map((c) => c.wb), KEYWORD_TTL_MS);
  const scores = new Map();
  const keep = new Set();
  const apply = (wb, profile) => {
    const s = scoreProfile(profile, { targetWords: tw, pickedNorms });
    scores.set(String(wb), s);
    if (s.share >= threshold) keep.add(String(wb));
  };
  const need = [];
  for (const c of cand) {
    const hit = cachedMap.get(Number(c.wb));
    if (hit) apply(c.wb, hit); else need.push(c);
  }
  L(`Профили из базы: ${cachedMap.size}; докупить сетью: ${need.length} (потолок ${budget}).`);

  // 3) сеть — только за неизвестными, в пределах budget; каждый профиль пишем в БД
  let requests = 0, dailyLimit = null, done = 0;
  const toFetch = need.slice(0, Math.max(0, budget));
  const skipped = need.length - toFetch.length;
  for (const c of toFetch) {
    if (dailyLimit) break;
    let prof;
    try { prof = await fetchItemKeywords(c.wb, { d1, d2 }); }
    catch (e) { if (e instanceof DailyLimitError) { dailyLimit = String(e.message || e); break; } prof = null; }
    requests++;
    if (prof) { keywordsSave(c.wb, prof, d1, d2); apply(c.wb, prof); }
    if (onProgress) onProgress(++done, toFetch.length, c.wb);
  }
  if (skipped) L(`⚠ ${skipped} кандидатов не проверены — уперлись в потолок запросов ${budget} (повторный отчёт добьёт их из кэша почти бесплатно).`);
  if (dailyLimit) L(`⚠ достигнут суточный лимит MPStats — часть кандидатов не проверена. ${dailyLimit}`);
  L(`Отобрано по доле трафика ≥ ${Math.round(threshold * 100)}%: ${keep.size} из проверенных ${scores.size}.`);

  return { keep, scores, requests, cached: cachedMap.size, dailyLimit, prefiltered: cand.length };
}
