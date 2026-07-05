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

// Путь к поисковой выдаче по слову (какие товары стоят в выдаче WB по запросу).
// Дефолт /wb/get/search подтверждён пробой без токена (реальный 401 Authorization
// Required — маршрут существует; для сравнения /wb/get/search/results отдал 405).
// Метод (GET/POST) и имя query-параметра финально уточняются живым токеном —
// поэтому и путь, и имя параметра вынесены в env (перебиваются без правки кода).
const SEARCH_PATH = process.env.MPSTATS_SEARCH_PATH || '/wb/get/search';
const SEARCH_QUERY_PARAM = process.env.MPSTATS_SEARCH_QUERY_PARAM || 'query';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.MPSTATS_TOKEN;
  if (!t) throw new Error('MPSTATS_TOKEN не задан в переменных окружения');
  return t;
}

/**
 * Низкоуровневый запрос к MPSTATS с ретраями и бэкоффом.
 * Повторяем при сетевых ошибках и на 429/5xx. По умолчанию GET; для POST
 * передать { method:'POST', body:{...} } — тело сериализуется в JSON.
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
        ...(body != null ? { body: JSON.stringify(body) } : {}),
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

// Тонкие обёртки над apiRequest для читаемости на местах вызова.
const apiGet = (pathAndQuery, opts = {}) => apiRequest(pathAndQuery, { ...opts, method: 'GET' });
const apiPost = (pathAndQuery, body, opts = {}) =>
  apiRequest(pathAndQuery, { ...opts, method: 'POST', body: body ?? {} });

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
 * Поисковая выдача WB по ключевому слову: сырой массив товаров из MPSTATS.
 * Нормализацию к контракту делает вызывающий (lib/wbTopKeywords.js), здесь —
 * только транспорт: запрос + вытаскивание массива строк из разных форматов.
 *
 * ВНИМАНИЕ: точная схема (метод/путь/тело) MPSTATS для этого отчёта уточняется
 * при первом живом вызове с токеном; путь и имя query-параметра — в env
 * (MPSTATS_SEARCH_PATH / MPSTATS_SEARCH_QUERY_PARAM).
 *
 * @param {string} query  ключевой запрос
 * @param {object} p  { d1, d2, startRow=0, endRow=100 }
 * @returns {Promise<object[]>} сырые строки выдачи ([] если пусто)
 */
export async function fetchSearchResults(query, { d1, d2, startRow = 0, endRow = 100 } = {}) {
  const qs = new URLSearchParams();
  qs.set(SEARCH_QUERY_PARAM, query);
  if (d1) qs.set('d1', d1);
  if (d2) qs.set('d2', d2);

  const raw = await apiPost(`${SEARCH_PATH}?${qs.toString()}`, { startRow, endRow });
  if (!raw) return [];

  return Array.isArray(raw)
    ? raw
    : Array.isArray(raw.data)
      ? raw.data
      : Array.isArray(raw.items)
        ? raw.items
        : Array.isArray(raw.result)
          ? raw.result
          : [];
}

export { BASE_URL, ITEM_SALES_PATH, SEARCH_PATH };
