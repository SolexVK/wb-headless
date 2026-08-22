// lib/shirtsMarket.js — рыночный слой: ниша «мужские рубашки с длинным рукавом»
// за год. Один запрос к MPStats-категории → объём рынка, доля упущенной выручки,
// топ-10 (фото/бренд/ссылка/годовая стат.), топ-300 (доля расцветок, размерные ряды).
// Преобладающие размеры — из публичной выдачи search.wb.ru (квоту MPStats не тратит).
import { fetchCategory } from './mpstats.js';

// ---- Нормализация цвета: первое базовое слово из «белый иней, белый мрамор» ----
const BASE_COLORS = ['белый', 'чёрный', 'черный', 'синий', 'голубой', 'серый', 'бежевый', 'коричневый',
  'зелёный', 'зеленый', 'красный', 'бордовый', 'розовый', 'жёлтый', 'желтый', 'оранжевый', 'фиолетовый',
  'хаки', 'молочный', 'кремовый', 'бирюзовый', 'сиреневый', 'песочный', 'графитовый', 'мятный', 'терракот'];
const COLOR_ALIAS = { черный: 'чёрный', зеленый: 'зелёный', желтый: 'жёлтый' };
function baseColor(raw) {
  const s = String(raw || '').toLowerCase();
  for (const c of BASE_COLORS) if (s.includes(c)) return COLOR_ALIAS[c] || c;
  const first = s.split(/[;,]/)[0].trim().split(/\s+/)[0];
  return first || 'прочее';
}

async function toDataUri(url) {
  if (!url) return '';
  const abs = url.startsWith('//') ? 'https:' + url : url;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(abs);
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length) return `data:${r.headers.get('content-type') || 'image/webp'};base64,${b.toString('base64')}`; }
      else break;
    } catch (_) { /* retry */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  return '';
}

// ---- Преобладающие размеры из search.wb.ru (агрегируем sizes[].name с наличием) ----
export async function fetchDominantSizes(query, pages = 3) {
  const counts = new Map(); // size -> {offered, inStock}
  for (let p = 1; p <= pages; p++) {
    const url = `https://search.wb.ru/exactmatch/ru/common/v9/search?appType=1&curr=rub&dest=-1257786&query=${encodeURIComponent(query)}&resultset=catalog&sort=popular&spp=30&page=${p}`;
    let j; try { const r = await fetch(url); if (!r.ok) break; j = await r.json(); } catch (_) { break; }
    const prods = j?.data?.products || j?.products || [];
    if (!prods.length) break;
    for (const pr of prods) {
      for (const s of pr.sizes || []) {
        const name = (s.name || s.origName || '').trim();
        if (!name) continue;
        const c = counts.get(name) || { offered: 0 };
        c.offered++;
        counts.set(name, c);
      }
    }
  }
  const total = [...counts.values()].reduce((s, c) => s + c.offered, 0) || 1;
  return [...counts.entries()]
    .map(([size, c]) => ({ size, offered: c.offered, share: c.offered / total }))
    .sort((a, b) => b.offered - a.offered);
}

/**
 * @param {object} o
 * @param {string} o.categoryPath — путь категории (Мужчинам/Рубашки)
 * @param {string} o.d1,o.d2 — период (год)
 * @param {string} o.minus — исключить по названию (напр. 'коротк')
 * @param {string} o.sizesQuery — запрос для фасета размеров
 */
export async function buildShirtsMarket({ categoryPath, d1, d2, minus = 'коротк', topN = 10, top300 = 300, sizesQuery, maxRows = 3000 } = {}) {
  const { items, total } = await fetchCategory(categoryPath, d1, d2, { maxRows, pageSize: 500 });
  const minusRoots = minus.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const filtered = items.filter((it) => {
    const n = (it.name || '').toLowerCase();
    return !minusRoots.some((r) => n.includes(r));
  });

  // Объём рынка — по всем отфильтрованным карточкам (с продажами).
  const withSales = filtered.filter((it) => it.revenue > 0);
  const revenueSum = withSales.reduce((s, it) => s + it.revenue, 0);
  const lostSum = withSales.reduce((s, it) => s + (it.lostProfit || 0), 0);
  const unitsSum = withSales.reduce((s, it) => s + (it.units || 0), 0);

  // Топ-300 для распределений.
  const top = filtered.slice(0, top300);

  // Доля расцветок.
  const colorMap = new Map();
  for (const it of top) { const c = baseColor(it.color); colorMap.set(c, (colorMap.get(c) || 0) + 1); }
  const colorDist = [...colorMap.entries()]
    .map(([color, count]) => ({ color, count, share: count / top.length }))
    .sort((a, b) => b.count - a.count);

  // Размерные ряды (ширина ряда = число размеров).
  const buckets = [{ label: '1', min: 1, max: 1 }, { label: '2–3', min: 2, max: 3 }, { label: '4–5', min: 4, max: 5 }, { label: '6–7', min: 6, max: 7 }, { label: '8+', min: 8, max: 999 }];
  const sizeRange = buckets.map((b) => ({ label: b.label, count: 0 }));
  let szSum = 0, szN = 0;
  for (const it of top) {
    const sc = it.sizeCount || 0;
    if (sc > 0) { szSum += sc; szN++; }
    const bi = buckets.findIndex((b) => sc >= b.min && sc <= b.max);
    if (bi >= 0) sizeRange[bi].count++;
  }
  const avgSizeRange = szN ? szSum / szN : 0;

  // Топ-10 с фото (data-URI).
  const topRanked = filtered.slice(0, topN);
  const top10 = [];
  for (let i = 0; i < topRanked.length; i++) {
    const it = topRanked[i];
    top10.push({
      rank: i + 1, sku: it.sku, name: it.name, brand: it.brand, seller: it.seller,
      url: it.url, img: await toDataUri(it.thumbMiddle || it.thumb),
      revenue: it.revenue, units: it.units, price: it.price, lostProfit: it.lostProfit,
      balance: it.balance, rating: it.rating, comments: it.comments, buyoutPct: it.buyoutPct, color: baseColor(it.color),
    });
  }

  // Преобладающие размеры (публичная выдача).
  let dominantSizes = [];
  if (sizesQuery) { try { dominantSizes = await fetchDominantSizes(sizesQuery, 3); } catch (_) { dominantSizes = []; } }

  return {
    categoryPath, d1, d2,
    totalInCategory: total,
    typeCount: filtered.length,
    withSalesCount: withSales.length,
    market: { revenueSum, lostSum, unitsSum, lostShare: revenueSum ? lostSum / (revenueSum + lostSum) : 0 },
    top10,
    top300: { n: top.length, colorDist, sizeRange, avgSizeRange },
    dominantSizes,
  };
}
