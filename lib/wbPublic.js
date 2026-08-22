// lib/wbPublic.js — публичный слой Wildberries (без MPStats, квоту не тратит).
// card.json: характеристики, описание, цвета, размеры, imt_id, ключевые запросы.
// feedbacks: отзывы по imt_id (до ~1000 последних).

// fetch с ретраями (WB CDN/feedbacks бывают нестабильны).
async function fetchRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch (_) { /* ретрай */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return null;
}

// Базовый путь на basket-хосте из URL фото (…/images/big/1.webp → …/<sku>).
export function basketBaseFromPhoto(photoUrl) {
  if (!photoUrl) return '';
  const u = photoUrl.startsWith('//') ? 'https:' + photoUrl : photoUrl;
  return u.replace(/\/images\/.*$/, '');
}

// Скачивает card.json и приводит к удобному виду.
export async function fetchCardJson(basketBase) {
  if (!basketBase) return null;
  const url = basketBase.replace(/\/$/, '') + '/info/ru/card.json';
  try {
    const r = await fetchRetry(url);
    if (!r) return null;
    const c = await r.json();
    const options = c.options || (c.grouped_options || []).flatMap((g) => g.options || []) || [];
    const opt = {};
    for (const o of options) if (o && o.name) opt[o.name] = o.value;
    return {
      imtId: c.imt_id || null,
      imtName: c.imt_name || '',
      subjName: c.subj_name || '',
      subjRoot: c.subj_root_name || '',
      vendorCode: c.vendor_code || '',
      description: c.description || '',
      options: opt,
      optionsList: options.map((o) => ({ name: o.name, value: o.value })),
      colorsNames: c.nm_colors_names || '',
      colors: Array.isArray(c.colors) ? c.colors : [],
      sizesTable: c.sizes_table || null,
    };
  } catch (_) {
    return null;
  }
}

// Ключевые запросы из названия и характеристик (для «принадлежности»/SEO).
// Возвращает [{phrase, weight}] — эвристика: имя + пол+предмет+атрибуты.
export function keyQueriesFromCard(card) {
  if (!card) return [];
  const gender = /муж/i.test(card.options['Пол'] || '') ? 'мужская' : /жен/i.test(card.options['Пол'] || '') ? 'женская' : '';
  const subj = (card.subjName || 'рубашка').toLowerCase().replace(/и$/, 'а'); // «Рубашки»→«рубашка»
  const attrs = [];
  const push = (v) => { if (v) attrs.push(String(v).toLowerCase().split(/[;,]/)[0].trim()); };
  push(card.options['Покрой']);
  if (/длин/i.test(JSON.stringify(card.options))) attrs.push('с длинным рукавом');
  push(card.options['Вид ткани'] || card.options['Состав'] && (/лен|лён/i.test(card.options['Состав']) ? 'льняная' : /хлоп/i.test(card.options['Состав']) ? 'хлопковая' : ''));
  const base = [subj, gender].filter(Boolean).join(' ');
  const queries = [];
  // главный запрос — из имени карточки (очищенный)
  if (card.imtName) queries.push({ phrase: card.imtName.toLowerCase(), weight: 3 });
  queries.push({ phrase: `${base} ${attrs.join(' ')}`.replace(/\s+/g, ' ').trim(), weight: 2 });
  // атрибутные хвосты
  for (const a of attrs) queries.push({ phrase: `${base} ${a}`.trim(), weight: 1 });
  // дедуп
  const seen = new Set();
  return queries.filter((q) => q.phrase && !seen.has(q.phrase) && seen.add(q.phrase));
}

// Отзывы по imt_id. Endpoint отдаёт до ~1000 последних + счётчик и рейтинг.
export async function fetchReviews(imtId) {
  if (!imtId) return { count: 0, valuation: null, feedbacks: [] };
  for (const host of ['feedbacks2', 'feedbacks1']) {
    try {
      const r = await fetchRetry(`https://${host}.wb.ru/feedbacks/v1/${imtId}`);
      if (!r) continue;
      const j = await r.json();
      const fb = Array.isArray(j.feedbacks) ? j.feedbacks : [];
      if (fb.length || j.feedbackCount != null) {
        return {
          count: Number(j.feedbackCount) || fb.length,
          valuation: j.valuation != null ? Number(j.valuation) : null,
          feedbacks: fb,
        };
      }
    } catch (_) { /* следующий хост */ }
  }
  return { count: 0, valuation: null, feedbacks: [] };
}
