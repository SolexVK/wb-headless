// wbSubjectKeywords.js — поисковые фразы ПРЕДМЕТА из MPStats
// (GET /wb/get/category/by_keywords?path=<предмет>). Один запрос отдаёт сотни реальных
// многословных запросов покупателей с частотами — это «меню фраз», из которого
// пользователь галочками отмечает релевантные его нише (в т.ч. «неявные жирные»
// вроде «рубашка летняя с длинным рукавом», где нет слова «муслин»).
//
// Ответ: { queries, words:[ { word, count, words:[формы], keys:[ {word, count, wb_count,
// norm_query, items_count} ] } ] }. Настоящие фразы — в keys[]. Сплющиваем все keys,
// дедуплицируем по norm_query, частота = сумма wb_count по формам одного нормализованного
// запроса, отображаемая фраза — форма с максимальной частотой.

const BASE_URL = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';

export class DailyLimitError extends Error {
  constructor(msg) { super(msg || 'Превышен суточный лимит запросов MPStats'); this.name = 'DailyLimitError'; this.dailyLimit = true; }
}

// Разбор ответа → [{phrase, norm, freq, words}] по убыванию частоты.
export function parseSubjectKeywords(json) {
  const groups = (json && json.words) || [];
  const byNorm = new Map();
  for (const g of groups) {
    for (const k of (g.keys || [])) {
      const phrase = String(k.word || '').trim();
      if (!phrase) continue;
      const norm = String(k.norm_query || phrase).trim().toLowerCase().replace(/ё/g, 'е');
      const freq = Number(k.wb_count) || Number(k.count) || 0;
      const words = String(phrase).trim().split(/\s+/).length;
      const prev = byNorm.get(norm);
      if (!prev) byNorm.set(norm, { phrase, norm, freq, words });
      else { prev.freq += freq; if (freq > (prev._top || 0)) { prev.phrase = phrase; prev._top = freq; } }
    }
  }
  return [...byNorm.values()]
    .map(({ _top, ...p }) => p)
    .filter((p) => p.freq > 0)
    .sort((a, b) => b.freq - a.freq);
}

/**
 * Загрузить фразы предмета (сеть). Возвращает массив фраз или бросает DailyLimitError.
 * @param {string} path — путь предмета WB.
 * @param {{d1:string,d2:string}} opts — период (обычно последние 30 дней).
 */
export async function fetchSubjectKeywords(path, { d1, d2 } = {}) {
  const token = process.env.MPSTATS_TOKEN;
  if (!token) throw new Error('MPSTATS_TOKEN не задан');
  const url = `${BASE_URL}/wb/get/category/by_keywords?path=${encodeURIComponent(path)}&d1=${d1}&d2=${d2}`;
  const resp = await fetch(url, {
    headers: { 'X-Mpstats-TOKEN': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.MPSTATS_CATEGORY_TIMEOUT_MS) || 120000),
  });
  if (resp.status === 429) {
    const body = await resp.text().catch(() => '');
    if (/лимит|limit/i.test(body)) throw new DailyLimitError();
    throw new Error(`category/by_keywords → HTTP 429`);
  }
  if (!resp.ok) throw new Error(`category/by_keywords → HTTP ${resp.status}`);
  return parseSubjectKeywords(await resp.json());
}
