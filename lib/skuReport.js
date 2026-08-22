// lib/skuReport.js — годовая аналитика по конкретным артикулам (SKU) WB.
// По каждому SKU: выручка, «заработал» (= выручка × выкуп%), упущенная выручка,
// продажи, цена, бренд, фото, ссылка на карточку + помесячная динамика выручки.
// Данные: /wb/get/item/{sku}/full (period_stats) + /wb/get/item/{sku}/sales.
import { fetchItemFull, fetchItemDailySales } from './mpstats.js';

const numOf = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
// Первое не-нулевое число среди кандидатов-ключей объекта.
function pick(obj, keys) {
  if (!obj) return 0;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '' && Number(v)) return Number(v);
  }
  return 0;
}

// Извлекает SKU (nmId) из ссылки WB или возвращает число как есть.
export function parseSku(input) {
  const s = String(input).trim();
  const m = s.match(/catalog\/(\d+)/) || s.match(/(\d{5,})/);
  return m ? Number(m[1]) : null;
}

// Скачивает картинку → data-URI (пробует кандидатов, до 3 попыток на каждого
// — сеть до WB CDN бывает нестабильной), '' при полной неудаче.
async function toDataUri(candidates) {
  for (let u of candidates.filter(Boolean)) {
    const abs = u.startsWith('//') ? 'https:' + u : u;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(abs);
        if (!r.ok) break; // сам URL плохой — к следующему кандидату
        const ct = r.headers.get('content-type') || 'image/webp';
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length) return `data:${ct};base64,${buf.toString('base64')}`;
      } catch (_) { /* ретрай */ }
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
    }
  }
  return '';
}

// Достаёт URL картинки первого слайда из карточки /full.
// Реальная структура MPSTATS: photo = { list: [{ f: "//basket-..big/1.webp", t: "..." }] }.
// Также поддержаны строка / массив / объект с url — на случай иных версий схемы.
function photoCandidates(full, sku) {
  const out = [];
  const p = full?.photo ?? full?.thumb ?? full?.image;
  if (typeof p === 'string') out.push(p);
  else if (Array.isArray(p) && p.length) {
    const first = p[0];
    out.push(typeof first === 'string' ? first : first?.f || first?.url || first?.t);
  } else if (p && typeof p === 'object') {
    if (Array.isArray(p.list) && p.list.length) { out.push(p.list[0].f); out.push(p.list[0].t); }
    out.push(p.url || p.src);
  }
  if (full?.thumb_middle) out.unshift(full.thumb_middle);
  return out.filter(Boolean);
}

// Дневная выручка: в ряде /sales нет поля revenue — считаем продажи × цену
// (normalizeDailyRow.price = final_price, т.е. фактическая цена продажи).
const dayRevenue = (d) => (Number(d.sales) || 0) * (Number(d.price) || 0);

// Помесячная агрегация выручки из дневного ряда → [{label, revenue}].
function monthlyRevenue(daily) {
  const map = new Map();
  for (const d of daily || []) {
    if (!d.date) continue;
    const key = String(d.date).slice(0, 7); // YYYY-MM
    map.set(key, (map.get(key) || 0) + dayRevenue(d));
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, revenue]) => ({ label, revenue: Math.round(revenue) }));
}

/**
 * @param {object} o
 * @param {(number|string)[]} o.skus — артикулы или ссылки WB
 * @param {string} o.d1,o.d2 — период (обычно ~год)
 * @param {boolean} o.withImages — качать фото (по умолч. да)
 * @param {boolean} o.withDaily — тянуть дневной ряд для помесячной динамики (по умолч. да)
 */
export async function buildSkuReport({ skus, d1, d2, withImages = true, withDaily = true, onProgress } = {}) {
  const ids = skus.map(parseSku).filter(Boolean);
  const products = [];

  for (let i = 0; i < ids.length; i++) {
    const sku = ids[i];
    const full = await fetchItemFull(sku, d1, d2);
    const ps = full?.period_stats || full?.stats || full || {};

    const revenue = pick(ps, ['revenue', 'sales_revenue', 'turnover', 'sum_sales']);
    const units = pick(ps, ['sales', 'sold', 'orders', 'sales_count']);
    const lostProfit = pick(ps, ['lost_profit', 'lostProfit', 'lost_revenue', 'lost_profit_sum']);
    const buyoutPct = pick(ps, ['purchase', 'buyout', 'redemption', 'buyout_percent']);

    let daily = [];
    if (withDaily) {
      try { daily = await fetchItemDailySales(sku, d1, d2); } catch (_) { daily = []; }
    }
    // Фолбэк выручки — сумма дневного ряда (продажи × цена), если period_stats пуст.
    const revenueFromDaily = daily.reduce((s, d) => s + dayRevenue(d), 0);
    const unitsFromDaily = daily.reduce((s, d) => s + (Number(d.sales) || 0), 0);
    const rev = revenue || Math.round(revenueFromDaily);
    const un = units || unitsFromDaily;
    // Средняя цена продажи за год = выручка / штуки (снимок цены в period_stats отсутствует).
    const avgPrice = un > 0 ? Math.round(rev / un) : pick(full, ['price', 'final_price']);

    // «Заработал» = выручка × выкуп% (поправка на возвраты). Если выкупа нет — null.
    const earned = buyoutPct ? Math.round((rev * buyoutPct) / 100) : null;

    const img = withImages ? await toDataUri(photoCandidates(full, sku)) : '';

    products.push({
      sku,
      url: full?.link || `https://www.wildberries.ru/catalog/${sku}/detail.aspx`,
      brand: full?.brand || '',
      brandUrl: full?.brand ? `https://www.wildberries.ru/catalog/${sku}/detail.aspx` : '',
      name: full?.name || full?.full_name || '',
      color: full?.color || '',
      img,
      revenue: rev,
      units: un,
      avgPrice,
      buyoutPct,
      earned,
      lostProfit,
      balance: numOf(full?.balance ?? full?.stock?.fbo),
      rating: numOf(full?.rating),
      comments: numOf(full?.comments),
      firstDate: full?.first_date || '',
      monthly: monthlyRevenue(daily),
      hadFull: !!full,
    });
    if (onProgress) onProgress(i + 1, ids.length);
  }

  const sum = (f) => products.reduce((s, p) => s + (f(p) || 0), 0);
  const summary = {
    d1, d2, days: daysBetween(d1, d2), count: products.length,
    revenueSum: sum((p) => p.revenue),
    earnedSum: sum((p) => p.earned),
    lostSum: sum((p) => p.lostProfit),
    unitsSum: sum((p) => p.units),
  };
  return { products, summary };
}

function daysBetween(d1, d2) {
  const a = new Date(d1 + 'T00:00:00Z'), b = new Date(d2 + 'T00:00:00Z');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
