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

// Путь к отчёту по категории (нише). MPSTATS отдаёт постранично
// (ag-grid: startRow/endRow), поэтому запрос — POST с телом-фильтром.
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
 * Поддерживает GET и POST (для постраничных отчётов вроде категории).
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

// Тонкая обёртка для GET-запросов (обратная совместимость).
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
 * Приводит одну товарную запись отчёта по категории к единому виду.
 * MPSTATS в разных версиях/разделах отдаёт разные имена полей — читаем
 * через несколько возможных ключей (как и в дневном ряду).
 */
function normalizeCategoryRow(row) {
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  const str = (v) => (v == null ? '' : String(v).trim());
  return {
    sku: row.id ?? row.nmId ?? row.nm_id ?? row.sku ?? null,
    name: str(row.name ?? row.title ?? row.subject),
    brand: str(row.brand ?? row.brand_name),
    seller: str(row.seller ?? row.supplier ?? row.vendor ?? row.brand_seller),
    // штук продано за период
    units: num(row.sales ?? row.sold ?? row.orders ?? row.sales_count),
    // выручка за период
    revenue: num(row.revenue ?? row.turnover ?? row.sum_sales ?? row.sales_revenue),
    // актуальная цена и остаток
    price: num(row.final_price ?? row.price ?? row.client_price ?? row.avg_price),
    balance: num(row.balance ?? row.stock ?? row.rest ?? row.quantity ?? row.balance_end),
    // отзывы и рейтинг — косвенно про «зрелость» карточки
    rating: num(row.rating ?? row.valuation ?? row.reviewRating),
    comments: num(row.comments ?? row.comments_count ?? row.feedbacks ?? row.reviews),
    category: str(row.category ?? row.categoryName ?? row.path),
  };
}

/**
 * Возвращает товары ниши (категории) за период [d1, d2] с постраничной
 * догрузкой. Сортировка по выручке (убыв.) — если упрёмся в лимит строк,
 * останутся самые крупные игроки ниши.
 *
 * @param {string} categoryPath путь категории WB, напр. "Женщинам/Одежда/Платья"
 * @returns {Promise<{items: object[], total: number, pages: number}>}
 *   items — нормализованные товары; total — сколько товаров в нише всего
 *   (по данным API, даже если выгрузили не всё); pages — сколько страниц забрали.
 */
export async function fetchCategory(
  categoryPath,
  d1,
  d2,
  { maxRows = 5000, pageSize = 500, onPage } = {}
) {
  const query = `?path=${encodeURIComponent(categoryPath)}&d1=${d1}&d2=${d2}`;
  const path = `${CATEGORY_PATH}${query}`;

  const items = [];
  let total = null;
  let pages = 0;
  let start = 0;

  while (start < maxRows) {
    const end = Math.min(start + pageSize, maxRows);
    const body = {
      startRow: start,
      endRow: end,
      filterModel: {},
      sortModel: [{ colId: 'revenue', sort: 'desc' }],
    };
    const raw = await apiRequest(path, { method: 'POST', body });
    if (!raw) break;

    // Ответ: { data:[...], total:N } либо { items:[...] } либо голый массив.
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.data)
        ? raw.data
        : Array.isArray(raw.items)
          ? raw.items
          : Array.isArray(raw.rows)
            ? raw.rows
            : [];

    if (total == null) {
      total = Number(raw.total ?? raw.count ?? raw.totalCount) || null;
    }
    for (const r of rows) items.push(normalizeCategoryRow(r));
    pages += 1;
    if (onPage) onPage(items.length, total ?? items.length);

    // Последняя страница: пришло меньше, чем просили, или выбрали всё.
    if (rows.length < end - start) break;
    start = end;
    if (total != null && start >= total) break;
  }

  return { items, total: total ?? items.length, pages };
}

export { BASE_URL, ITEM_SALES_PATH, CATEGORY_PATH };
