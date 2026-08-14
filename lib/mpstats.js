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

// Дополнительные срезы по категории для анализа ниши (все GET, {path,d1,d2}).
const CATEGORY_TRENDS_PATH =
  process.env.MPSTATS_CATEGORY_TRENDS_PATH || '/wb/get/category/trends';
const CATEGORY_SELLERS_PATH =
  process.env.MPSTATS_CATEGORY_SELLERS_PATH || '/wb/get/category/sellers';
const CATEGORY_BRANDS_PATH =
  process.env.MPSTATS_CATEGORY_BRANDS_PATH || '/wb/get/category/brands';
const CATEGORY_PRICESEG_PATH =
  process.env.MPSTATS_CATEGORY_PRICESEG_PATH || '/wb/get/category/price_segmentation';

// Поисковая выдача по ключевому запросу (метод «от спроса»).
// ЗАЛОЧЕНО живым токеном (см. ветку magical-bardeen): рабочий эндпоинт —
// POST /analytics/v1/wb/search/items с query-параметром `path` (ключевое слово)
// + d1/d2 + ag-grid тело {startRow,endRow}. Ответ {total,data:[...]}, id=nmId.
// Старый /wb/get/search — html-заглушка (пустой 200), не использовать.
const SEARCH_PATH = process.env.MPSTATS_SEARCH_PATH || '/analytics/v1/wb/search/items';
const SEARCH_QUERY_PARAM = process.env.MPSTATS_SEARCH_QUERY_PARAM || 'path';

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
// Среднее по числовому ряду-графику (stocks_graph/sales_graph); [] → null.
function meanGraph(g) {
  if (!Array.isArray(g) || !g.length) return null;
  const nums = g.map((v) => Number(v) || 0);
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function normalizeCategoryRow(row) {
  const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
  const str = (v) => (v == null ? '' : String(v).trim());
  const balance = num(row.balance ?? row.stock ?? row.rest ?? row.quantity ?? row.balance_end);
  // средний остаток за период — из stocks_graph (иначе снимок balance = на сегодня)
  const avgStock = meanGraph(row.stocks_graph);
  return {
    sku: row.id ?? row.nmId ?? row.nm_id ?? row.sku ?? null,
    name: str(row.name ?? row.title ?? row.subject),
    brand: str(row.brand ?? row.brand_name),
    seller: str(row.seller ?? row.supplier ?? row.vendor ?? row.brand_seller),
    supplierId: row.supplier_id ?? row.supplierId ?? row.supplierid ?? null,
    // штук продано за период
    units: num(row.sales ?? row.sold ?? row.orders ?? row.sales_count),
    // выручка за период
    revenue: num(row.revenue ?? row.turnover ?? row.sum_sales ?? row.sales_revenue),
    // актуальная цена и остаток (снимок) + средний остаток за период
    price: num(row.final_price ?? row.price ?? row.client_price ?? row.avg_price),
    balance,
    avgStock: avgStock != null ? Math.round(avgStock) : balance,
    // отзывы и рейтинг — косвенно про «зрелость» карточки
    rating: num(row.rating ?? row.valuation ?? row.reviewRating),
    comments: num(row.comments ?? row.comments_count ?? row.feedbacks ?? row.reviews),
    // упущенная выручка (неудовлетворённый спрос)
    lostProfit: num(row.lost_profit ?? row.lostProfit ?? row.lost_revenue),
    // оборачиваемость (дней распродажи остатка)
    turnoverDays: num(row.turnover_days ?? row.turnoverDays),
    // возраст карточки
    firstDate: str(row.sku_first_date ?? row.first_date ?? row.start_date),
    // процент выкупа (для оценки возвратов)
    buyoutPct: num(row.purchase ?? row.buyout ?? row.redemption),
    // контент — планка входа
    picsCount: num(row.picscount ?? row.pics_count ?? row.photos),
    hasVideo: num(row.hasvideo ?? row.has_video) > 0 ? 1 : 0,
    descriptionLength: num(row.description_length ?? row.descriptionLength),
    negativePct: num(row.latest_negative_comments_percent),
    has3d: num(row.has3d ?? row.has_3d) > 0 ? 1 : 0,
    nameLength: num(row.name_length ?? row.nameLength),
    // размерный ряд и средние продажи в день — для планки входа и объёма
    sizeCount: num(row.size_count ?? row.sizeCount),
    sizeInStock: num(row.size_count_in_stock ?? row.sizeInStock),
    salesPerDay: num(row.sales_per_day_average ?? row.salesPerDay),
    // дневные ряды продаж/остатков — для временнóй диаграммы реализации (агрегируются и удаляются)
    salesGraph: Array.isArray(row.sales_graph) ? row.sales_graph.map((v) => Number(v) || 0) : null,
    stocksGraph: Array.isArray(row.stocks_graph) ? row.stocks_graph.map((v) => Number(v) || 0) : null,
    // реклама
    hasAd: num(row.ext_advertising ?? row.advertising) > 0 ? 1 : 0,
    searchCpm: num(row.search_cpm_avg ?? row.cpm),
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
      // Рабочий ключ сортировки MPSTATS — `sort` (проверено движком
      // wb_analyze.py). `sortModel` дублируем на случай иной версии схемы.
      sort: [{ colId: 'revenue', sort: 'desc' }],
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

// Достаёт массив строк из ответа MPSTATS в любой из известных обёрток.
function asArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return (
    raw.data || raw.items || raw.rows || raw.result || raw.sellers || raw.brands || []
  );
}

// Общий GET-срез по категории с параметрами {path,d1,d2} → массив строк.
async function fetchCategorySlice(basePath, categoryPath, d1, d2) {
  const q = `?path=${encodeURIComponent(categoryPath)}&d1=${d1}&d2=${d2}`;
  const raw = await apiGet(`${basePath}${q}`);
  return asArray(raw);
}

/** Всё дерево категорий WB: [{url,name,path}]. */
export async function fetchCategories() {
  const raw = await apiGet('/wb/get/categories');
  return asArray(raw);
}

/** Динамика ниши по датам (для тренда и сезонности). */
export function fetchCategoryTrends(categoryPath, d1, d2) {
  return fetchCategorySlice(CATEGORY_TRENDS_PATH, categoryPath, d1, d2);
}

/** Продавцы ниши (для оценки конкуренции). */
export function fetchCategorySellers(categoryPath, d1, d2) {
  return fetchCategorySlice(CATEGORY_SELLERS_PATH, categoryPath, d1, d2);
}

/** Бренды ниши (для оценки конкуренции). */
export function fetchCategoryBrands(categoryPath, d1, d2) {
  return fetchCategorySlice(CATEGORY_BRANDS_PATH, categoryPath, d1, d2);
}

/** Распределение ниши по ценовым сегментам. */
export function fetchPriceSegmentation(categoryPath, d1, d2) {
  return fetchCategorySlice(CATEGORY_PRICESEG_PATH, categoryPath, d1, d2);
}

/**
 * Поисковая выдача WB по ключевому запросу (постранично) — сырые строки MPSTATS.
 * `total` в ответе = сколько карточек по запросу (= предложение в нише по фразе).
 *
 * Период обязателен, причём d2 должен быть СТРОГО раньше сегодня (иначе 422) —
 * если дата не задана/сегодняшняя, подставляем d2=вчера, d1=за 30 дней до.
 *
 * @param {string} query ключевой запрос
 * @returns {Promise<{rows:object[], total:number, period:{d1,d2}, capped:boolean}>}
 */
export async function fetchSearchResults(query, { d1, d2, pageSize = 500, maxRows } = {}) {
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const today = iso(Date.now());
  // d2 не может быть сегодня/в будущем — клампим к вчера.
  let to = d2 || iso(Date.now() - day);
  if (to >= today) to = iso(Date.now() - day);
  const from = d1 && d1 < to ? d1 : iso(new Date(`${to}T00:00:00Z`).getTime() - 30 * day);
  const cap = Number(maxRows) || Number(process.env.NICHE_QUERY_MAX_ROWS) || 2000;

  const rows = [];
  let total = Infinity;
  let start = 0;

  while (start < Math.min(total, cap)) {
    const end = start + pageSize;
    const qs = new URLSearchParams();
    qs.set(SEARCH_QUERY_PARAM, query);
    qs.set('d1', from);
    qs.set('d2', to);
    const raw = await apiRequest(`${SEARCH_PATH}?${qs.toString()}`, {
      method: 'POST',
      body: { startRow: start, endRow: end },
    });
    const page = asArray(raw);
    if (!page.length) break;
    rows.push(...page);
    if (raw && Number.isFinite(raw.total)) total = raw.total;
    // Последняя (неполная) страница — выдача исчерпана.
    if (page.length < pageSize) {
      if (!Number.isFinite(total)) total = rows.length;
      break;
    }
    start = end;
  }

  const realTotal = Number.isFinite(total) ? total : rows.length;
  return { rows: rows.slice(0, cap), total: realTotal, period: { d1: from, d2: to }, capped: realTotal > cap };
}

export {
  BASE_URL,
  ITEM_SALES_PATH,
  CATEGORY_PATH,
  CATEGORY_TRENDS_PATH,
  CATEGORY_SELLERS_PATH,
  CATEGORY_BRANDS_PATH,
  CATEGORY_PRICESEG_PATH,
  SEARCH_PATH,
};
