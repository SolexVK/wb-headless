// lib/mpstats.js — минимальный клиент MPSTATS REST API
//
// Документация: https://mpstats.io/integrations/wb_reports
// База:   https://mpstats.io/api/
// Токен:  заголовок X-Mpstats-TOKEN (из переменной окружения MPSTATS_TOKEN)

const BASE_URL = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';

// Путь к отчёту «по дням» по одному товару (wb_item_sales).
// Шаблон вынесен в env на случай, если MPSTATS изменит схему URL —
// {sku} подставляется в момент запроса.
const ITEM_SALES_PATH =
  process.env.MPSTATS_ITEM_SALES_PATH || '/wb/get/item/{sku}/sales';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.MPSTATS_TOKEN;
  if (!t) throw new Error('MPSTATS_TOKEN не задан в переменных окружения');
  return t;
}

/**
 * Низкоуровневый GET-запрос к MPSTATS с ретраями и бэкоффом.
 * Повторяем при сетевых ошибках и на 429/5xx.
 */
async function apiRequest(pathAndQuery, { retries = 3, method = 'GET', body, timeoutMs } = {}) {
  const url = `${BASE_URL}${pathAndQuery}`;
  // Тайм-аут на каждый запрос: если MPSTATS «завис» — не блокируем весь отчёт.
  // Категорийные ответы с графиками крупные — им нужен запас (передаём явно).
  timeoutMs = timeoutMs || Number(process.env.MPSTATS_TIMEOUT_MS) || 25000;
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          'X-Mpstats-TOKEN': token(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body != null ? JSON.stringify(body) : undefined,
        // Прерываем запрос, если ответа нет дольше timeoutMs.
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (resp.status === 404) {
        // Товар без данных за период — не ошибка, отдаём пусто.
        return null;
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // Достаём читаемый текст: MPSTATS отдаёт JSON с полем message.
        let msg = body.slice(0, 200);
        try {
          const j = JSON.parse(body);
          if (j && j.message) msg = j.message;
        } catch (_) {}

        const err = new Error(`MPSTATS ${resp.status}: ${msg}`);
        // Дневной лимит запросов (429 + «лимит…») повтором не лечится и
        // сбросится только на след. сутки — помечаем, чтобы остановить отчёт.
        err.dailyLimit = resp.status === 429 && /лимит|limit/i.test(msg);
        // Повторяем только временные сбои: 5xx и НЕ-дневной 429.
        // Клиентские (401/403/400) и дневной лимит — не ретраим.
        err.retryable = err.dailyLimit ? false : resp.status === 429 || resp.status >= 500;
        throw err;
      }
      return await resp.json();
    } catch (err) {
      lastErr = err;
      // Сетевые ошибки и тайм-ауты считаем временными и повторяем.
      const retryable = err?.retryable !== false;
      if (!retryable || attempt === retries) break;
      const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      const reason = err?.name === 'TimeoutError' ? `тайм-аут ${timeoutMs}ms` : String(err?.message || err);
      process.stderr.write(`  ↻ повтор ${attempt + 1}/${retries} (${reason})\n`);
      await sleep(wait);
      attempt += 1;
    }
  }
  throw lastErr;
}

// Обратная совместимость: apiGet — тонкая обёртка над apiRequest (GET).
const apiGet = (pathAndQuery, opts = {}) => apiRequest(pathAndQuery, { ...opts, method: 'GET' });

/**
 * Приводит одну дневную запись отчёта к единому виду.
 * MPSTATS в разных версиях отдаёт немного разные имена полей —
 * поэтому читаем через несколько возможных ключей.
 */
function normalizeDailyRow(row) {
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  return {
    date: row.data ?? row.date ?? row.day ?? null,
    balance: num(row.balance ?? row.stock ?? row.balance_end ?? row.rest),
    sales: num(row.sales ?? row.sold ?? row.orders ?? row.sale),
    price: num(row.final_price ?? row.price ?? row.client_price ?? row.priceFull),
    revenue: num(row.revenue ?? row.turnover),
  };
}

/**
 * Возвращает дневной ряд продаж/остатков по одному SKU за период [d1, d2].
 * Формат дат: 'YYYY-MM-DD'. Возвращает [] если данных нет.
 */
export async function fetchItemDailySales(sku, d1, d2) {
  const path = ITEM_SALES_PATH.replace('{sku}', encodeURIComponent(sku));
  const raw = await apiGet(`${path}?d1=${d1}&d2=${d2}`);
  if (!raw) return [];

  // Ответ может быть голым массивом либо { data: [...] } / { items: [...] }.
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.data)
      ? raw.data
      : Array.isArray(raw.items)
        ? raw.items
        : [];

  return arr.map(normalizeDailyRow).filter((r) => r.date);
}

/**
 * Список товаров предмета/категории: POST /wb/get/category.
 * Пагинация/сортировка — в теле (ag-grid-стиль). До ~5000 строк за запрос.
 * @param {object} p
 * @param {string} p.path — путь предмета (напр. 'Женщинам/Одежда'), URL-энкодим.
 * @param {string} p.d1, p.d2 — период 'YYYY-MM-DD'.
 * @param {number} [p.startRow=0], [p.endRow=5000] — окно пагинации.
 * @param {object} [p.filterModel={}] — серверный фильтр (схема полей уточняется).
 * @param {Array}  [p.sortModel] — сортировка, по умолчанию по выручке убыв.
 * @returns {Promise<{total:number, data:object[]}>}
 */
export async function fetchCategoryItems({
  path,
  d1,
  d2,
  startRow = 0,
  endRow = 5000,
  filterModel = {},
  sortModel = [{ colId: 'revenue', sort: 'desc' }],
  timeoutMs,
} = {}) {
  const qs = `path=${encodeURIComponent(path)}&d1=${d1}&d2=${d2}`;
  const raw = await apiRequest(`/wb/get/category?${qs}`, {
    method: 'POST',
    body: { startRow, endRow, filterModel, sortModel },
    // Крупный ответ (графики по многим товарам) — даём щедрый тайм-аут.
    timeoutMs: timeoutMs || Number(process.env.MPSTATS_CATEGORY_TIMEOUT_MS) || 120000,
  });
  if (!raw) return { total: 0, data: [] };
  const data = Array.isArray(raw.data) ? raw.data : Array.isArray(raw) ? raw : [];
  const total = Number(raw.total) || data.length;
  return { total, data };
}

/**
 * Нормализует запись товара из выдачи по предмету к единому виду.
 * nmId в ответе приходит полем `id` (не `nmId`).
 */
export function normalizeCategoryItem(row) {
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  return {
    wb: row.id ?? row.nmId ?? row.nm ?? null,
    name: row.name ?? '',
    brand: row.brand ?? '',
    seller: row.seller ?? row.supplier ?? '',
    price: num(row.final_price ?? row.price),
    sales: num(row.sales),
    revenue: num(row.revenue),
    balance: num(row.balance),
    rating: num(row.rating),
    comments: num(row.comments),
  };
}

/**
 * Ось дат [d1..d2] включительно, массив 'YYYY-MM-DD'.
 * Графики в выдаче по категории выровнены по этой оси (индекс 0 = d1).
 */
export function dateAxis(d1, d2) {
  const out = [];
  let t = new Date(d1 + 'T00:00:00Z').getTime();
  const end = new Date(d2 + 'T00:00:00Z').getTime();
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

/**
 * Извлекает ДНЕВНОЙ РЯД из графиков товара выдачи по категории —
 * без единого доп. запроса (данные уже в ответе /wb/get/category).
 * Графики хронологичны (index 0 = d1). Цену берём как выручка/штуки
 * («цена реального спроса»), при отсутствии продаж — из price_graph.
 * @returns [{date, sales, balance, price, revenue}]
 */
export function extractItemDailyFromGraphs(item, d1, d2) {
  const dates = dateAxis(d1, d2);
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  const sales = item.sales_graph || [];
  const stocks = item.stocks_graph || [];
  const price = item.price_graph || [];
  const revenue = item.revenue_graph || [];
  // Если длина графика не совпала с осью — выравниваем по минимуму (от начала).
  const n = Math.min(dates.length, sales.length || dates.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = num(sales[i]);
    const rev = num(revenue[i]);
    out.push({
      date: dates[i],
      sales: s,
      balance: num(stocks[i]),
      price: s > 0 && rev > 0 ? rev / s : num(price[i]),
      revenue: rev,
    });
  }
  return out;
}

export { BASE_URL, ITEM_SALES_PATH };
