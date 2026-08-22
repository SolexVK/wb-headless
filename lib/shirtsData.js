// lib/shirtsData.js — оркестратор данных для единого отчёта по рубашкам:
// три артикула (деньги + характеристики + запросы + отзывы + диагональное
// сканирование) + рыночный слой (ниша, топ-10, топ-300, цвета/размеры).
import { fetchItemFull } from './mpstats.js';
import { basketBaseFromPhoto, fetchCardJson, keyQueriesFromCard, fetchReviews } from './wbPublic.js';
import { classifyReviews } from './reviewsClassify.js';
import { scanArticle } from './diagonalScan.js';
import { buildShirtsMarket } from './shirtsMarket.js';

const pick = (o, keys) => { if (!o) return 0; for (const k of keys) { const v = o[k]; if (v != null && v !== '' && Number(v)) return Number(v); } return 0; };

async function fetchImg(url) {
  const abs = url.startsWith('//') ? 'https:' + url : url;
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(abs); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length) return `data:${r.headers.get('content-type') || 'image/webp'};base64,${b.toString('base64')}`; } else return ''; }
    catch (_) { /* ретрай */ }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return '';
}
// Пробует несколько URL-кандидатов подряд (big → меньший размер → др. кадр).
async function toDataUri(candidates) {
  for (const u of (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)) {
    const d = await fetchImg(u);
    if (d) return d;
  }
  return '';
}
// Кандидаты фото из /full: первый кадр (big и c516x688 и c246x328) + второй кадр.
function photoCandidates(full) {
  const list = full?.photo?.list || [];
  const out = [];
  if (list[0]) { out.push(list[0].f); out.push(list[0].f && list[0].f.replace('/big/', '/c516x688/')); out.push(list[0].t); }
  if (list[1]) out.push(list[1].f);
  return out.filter(Boolean);
}

// Короткий набор характеристик для карточки (только значимые поля).
const CHAR_KEYS = ['Состав', 'Покрой', 'Цвет', 'Вид застежки', 'Тип карманов', 'Фактура материала', 'Модель рукава', 'Длина рукава', 'Сезон'];
function shortChars(opt) {
  const out = [];
  for (const k of CHAR_KEYS) if (opt[k]) out.push({ name: k, value: String(opt[k]).split(/[;,]/)[0].trim().slice(0, 28) });
  return out;
}

export async function buildShirtsData({ skus, d1, d2, categoryPath = 'Мужчинам/Рубашки', sizesQuery = 'рубашка мужская с длинным рукавом', onProgress } = {}) {
  const articles = [];
  for (let i = 0; i < skus.length; i++) {
    const sku = Number(skus[i]);
    const full = await fetchItemFull(sku, d1, d2);
    const ps = full?.period_stats || {};
    const revenue = pick(ps, ['revenue', 'sales_revenue', 'turnover']);
    const units = pick(ps, ['sales', 'sold', 'orders']);
    const lost = pick(ps, ['lost_profit', 'lostProfit', 'lost_revenue']);
    const buyout = pick(ps, ['purchase', 'buyout', 'redemption']);
    const avgPrice = units > 0 ? Math.round(revenue / units) : pick(full, ['price']);
    const earned = buyout ? Math.round((revenue * buyout) / 100) : null;

    const photoF = full?.photo?.list?.[0]?.f;
    const img = await toDataUri(photoCandidates(full));
    const base = basketBaseFromPhoto(photoF);
    const card = await fetchCardJson(base);
    const queries = keyQueriesFromCard(card);
    const rev = await fetchReviews(card?.imtId);
    const cls = classifyReviews(rev.feedbacks, rev);

    const query = card?.imtName || queries[0]?.phrase || 'рубашка мужская с длинным рукавом';
    const scan = await scanArticle({
      sku, query,
      own: { brand: full?.brand || '', price: avgPrice, rating: cls.valuation, reviews: cls.total },
    });

    articles.push({
      sku,
      url: full?.link || `https://www.wildberries.ru/catalog/${sku}/detail.aspx`,
      brand: full?.brand || '',
      name: card?.imtName || full?.name || '',
      description: (card?.description || '').slice(0, 260),
      img,
      money: { revenue, units, avgPrice, buyout, earned, lost, lostShare: revenue ? lost / (revenue + lost) : 0 },
      chars: shortChars(card?.options || {}),
      queries: queries.map((q) => q.phrase).slice(0, 4),
      reviews: cls,
      scan,
    });
    if (onProgress) onProgress('article', i + 1, skus.length);
  }

  if (onProgress) onProgress('market', 0, 1);
  const market = await buildShirtsMarket({ categoryPath, d1, d2, minus: 'коротк', topN: 10, top300: 300, sizesQuery });

  return { d1, d2, categoryPath, articles, market };
}
