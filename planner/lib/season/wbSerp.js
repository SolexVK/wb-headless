// wbSerp.js — SERP «фраза → товары» из MPStats (POST /api/seo/keywords/<фраза>/serp-v2).
//
// ГЛАВНЫЙ источник аналогов для ранга сезонности. Один запрос по фразе («рубашка
// муслиновая женская») отдаёт до 200 товаров, которые РЕАЛЬНО находят по этой фразе
// (поведенческая релевантность — включая те, где в названии нет слова «муслин»), и у
// КАЖДОГО — дневные графики продаж/выручки за запрошенный период (до 2 лет). Значит
// релевантные артикулы + их двухлетняя сезонность добываются за 1 запрос на фразу.
//
// Авторизация — тем же X-Mpstats-TOKEN. Канал SEO отдельный от REST-отчётов.
// Ограничения проверены живьём: endRow ≤ 200; период задаётся d1/d2 (иначе 30 дней).

import fs from 'fs';
import path from 'path';

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
export const SERP_MAX_ROWS = 200;

export class DailyLimitError extends Error {
  constructor(msg) { super(msg || 'Превышен суточный лимит запросов MPStats'); this.name = 'DailyLimitError'; this.dailyLimit = true; }
}

// Разбор ответа serp-v2 → { periods:[даты], items:[{...}], rowCount }.
export function parseSerp(json) {
  const periods = Array.isArray(json && json.periods) ? json.periods.map(String) : [];
  const rows = Array.isArray(json && json.rowData) ? json.rowData : [];
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  const items = rows.map((r) => ({
    wb: Number(r.id),
    name: r.name || '',
    brand: r.brand || '',
    seller: r.seller || '',
    price: num(r.final_price),
    sales: num(r.sales),           // продаж за весь период
    revenue: num(r.revenue),       // выручка за весь период
    rating: num(r.rating),
    comments: num(r.comments),
    balance: num(r.balance),       // текущий остаток (дневного нет)
    subject: r.subject || '',
    subjectId: r.subject_id ?? null,
    thumb: r.thumb || '',
    url: r.url || '',
    graph: Array.isArray(r.graph) ? r.graph.map(num) : [],               // дневные продажи
    revenueGraph: Array.isArray(r.revenue_graph) ? r.revenue_graph.map(num) : [], // дневная выручка
  })).filter((x) => Number.isFinite(x.wb) && x.wb > 0);
  return { periods, items, rowCount: num(json && json.rowCount) };
}

// Офлайн-фикстура для разработки/тестов без сети: SERP_FIXTURE_FILE — один файл на все
// фразы (сырой ответ serp-v2). Позволяет собирать/проверять пайплайн, не трогая MPStats.
function fixture() {
  const f = process.env.SERP_FIXTURE_FILE;
  if (f && fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
  return null;
}

/**
 * Товары, ранжирующиеся по фразе, с дневными графиками за [d1,d2].
 * @param {string} phrase — поисковая фраза (напр. «рубашка муслиновая женская»).
 * @param {{d1:string,d2:string,endRow?:number}} opts
 * @returns {Promise<{periods:string[], items:object[], rowCount:number}>}
 */
export async function fetchSerp(phrase, { d1, d2, endRow = SERP_MAX_ROWS } = {}) {
  const fx = fixture();
  if (fx) return parseSerp(fx);
  const token = process.env.MPSTATS_TOKEN;
  if (!token) throw new Error('MPSTATS_TOKEN не задан');
  const rows = Math.min(SERP_MAX_ROWS, Math.max(1, endRow));
  const url = `${BASE}/seo/keywords/${encodeURIComponent(phrase)}/serp-v2?mp=Wildberries`
    + (d1 && d2 ? `&d1=${d1}&d2=${d2}` : '');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'X-Mpstats-TOKEN': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    // Сортировка по ВЫРУЧКЕ: 200 верхних = топ-200 по выручке среди всех ранжирующихся по
    // фразе (до 5000). Так в выборку попадают крупные ТОПы, даже если в названии нет
    // ключевого слова (они ранжируются по фразе, но названы иначе). Проверено: serp это принимает.
    body: JSON.stringify({ startRow: 0, endRow: rows, filterModel: {}, sortModel: [{ colId: 'revenue', sort: 'desc' }], includeTotals: true, organicOnly: false }),
    signal: AbortSignal.timeout(Number(process.env.MPSTATS_CATEGORY_TIMEOUT_MS) || 120000),
  });
  if (resp.status === 429) {
    const body = await resp.text().catch(() => '');
    if (/лимит|limit/i.test(body)) throw new DailyLimitError();
    throw new Error('serp-v2 → HTTP 429');
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`serp-v2 → HTTP ${resp.status}: ${body.slice(0, 120)}`);
  }
  return parseSerp(await resp.json());
}
