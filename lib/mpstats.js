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

// Путь к отчёту «по категории» (список товаров категории за период).
// MPSTATS: POST /wb/get/category  (тело: { path, startRow, endRow, ... }).
const CATEGORY_PATH =
  process.env.MPSTATS_CATEGORY_PATH || '/wb/get/category';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.MPSTATS_TOKEN;
  if (!t) throw new Error('MPSTATS_TOKEN не задан в переменных окружения');
  return t;
}

/**
 * Низкоуровневый запрос к MPSTATS с ретраями и бэкоффом.
 * Повторяем при сетевых ошибках и на 429/5xx.
 * @param {object} [opts]
 * @param {'GET'|'POST'} [opts.method] метод (по умолчанию GET)
 * @param {object}       [opts.body]   JSON-тело (для POST)
 * @param {number}       [opts.retries]
 */
async function apiRequest(pathAndQuery, { method = 'GET', body, retries = 3 } = {}) {
  const url = `${BASE_URL}${pathAndQuery}`;
  // Тайм-аут на каждый запрос: если MPSTATS «завис» — не блокируем весь отчёт.
  const timeoutMs = Number(process.env.MPSTATS_TIMEOUT_MS) || 25000;
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

// Совместимость: старое имя — GET-обёртка над apiRequest.
const apiGet = (pathAndQuery, opts) => apiRequest(pathAndQuery, { ...opts, method: 'GET' });

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
 * Приводит одну карточку товара из отчёта по категории к единому виду.
 * MPSTATS в разных ответах отдаёт немного разные имена полей — читаем через
 * несколько возможных ключей (как и в дневном ряду выше).
 */
function normalizeCategoryItem(row) {
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  const str = (v) => (v == null ? '' : String(v));
  return {
    sku: num(row.id ?? row.nmId ?? row.nm ?? row.sku ?? row.itemId),
    name: str(row.name ?? row.title ?? row.item_name),
    brand: str(row.brand ?? row.brand_name),
    seller: str(row.seller ?? row.supplier ?? row.seller_name),
    color: str(row.color ?? row.colors ?? row.colour),
    category: str(row.category ?? row.subject ?? row.path),
    // За период: продано штук и выручка. MPSTATS зовёт их по-разному в
    // зависимости от версии отчёта — перебираем известные варианты.
    unitsSold: num(row.sales ?? row.sold ?? row.orders ?? row.purchase),
    revenue: num(row.revenue ?? row.balance ?? row.turnover ?? row.sales_sum),
    finalPrice: num(row.final_price ?? row.price ?? row.client_price ?? row.priceFull),
    rating: num(row.rating ?? row.stars),
    comments: num(row.comments ?? row.feedbacks ?? row.reviews),
  };
}

/**
 * Одна страница отчёта по категории.
 * @param {string} categoryPath путь категории WB в терминах MPSTATS
 *   (например «Женщинам/Блузки и рубашки/Рубашки»).
 * @param {string} d1,d2 период 'YYYY-MM-DD'
 * @param {object} opts { startRow, endRow, filterModel }
 * @returns {Promise<{items: object[], total: number}>}
 */
export async function fetchCategoryPage(categoryPath, d1, d2, opts = {}) {
  const { startRow = 0, endRow = 500, filterModel } = opts;
  const body = {
    path: categoryPath,
    startRow,
    endRow,
    // Сортируем по продажам за период, чтобы топ-продавцы категории шли
    // первыми — тогда даже при ограничении числа страниц мы не упускаем
    // самые ходовые товары.
    sort: 'sales',
    sortModel: [{ colId: 'sales', sort: 'desc' }],
    // Необязательный server-side фильтр по имени (если задан) — MPSTATS
    // отфильтрует «в полоску» на своей стороне и сэкономит лимит.
    ...(filterModel ? { filterModel } : {}),
  };
  const raw = await apiRequest(`${CATEGORY_PATH}?d1=${d1}&d2=${d2}`, { method: 'POST', body });
  if (!raw) return { items: [], total: 0 };

  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.data)
      ? raw.data
      : Array.isArray(raw.items)
        ? raw.items
        : [];
  const total = Number(raw.total ?? raw.count ?? raw.totalCount ?? arr.length) || arr.length;
  return { items: arr.map(normalizeCategoryItem).filter((i) => i.sku), total };
}

/**
 * Тянет товары категории за период постранично, до maxRows штук
 * (отсортированные по продажам). Возвращает плоский список карточек.
 * @param {object} opts { pageSize, maxRows, filterModel, onProgress }
 */
export async function fetchCategoryItems(categoryPath, d1, d2, opts = {}) {
  const pageSize = Math.max(1, Number(opts.pageSize) || 500);
  const maxRows = Math.max(pageSize, Number(opts.maxRows) || 3000);
  const { filterModel, onProgress } = opts;

  const out = [];
  let startRow = 0;
  let reportedTotal = Infinity;

  while (startRow < maxRows && startRow < reportedTotal) {
    const endRow = startRow + pageSize;
    const { items, total } = await fetchCategoryPage(categoryPath, d1, d2, {
      startRow,
      endRow,
      filterModel,
    });
    reportedTotal = total;
    out.push(...items);
    if (onProgress) onProgress(out.length, Math.min(maxRows, total));
    // Категория закончилась раньше лимита — MPSTATS вернул меньше страницы.
    if (items.length < pageSize) break;
    startRow = endRow;
  }

  return { items: out, scanned: out.length, total: reportedTotal, cappedAt: maxRows };
}

export { BASE_URL, ITEM_SALES_PATH, CATEGORY_PATH };
