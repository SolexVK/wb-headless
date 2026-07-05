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
// ЗАЛОЧЕНО живым токеном: POST /api/analytics/v1/wb/search/items — это новый
// versioned-эндпоинт «Товары по поисковой фразе» (Laravel-валидация 422).
// Ключевое слово идёт query-параметром `path` (обязателен), период — d1/d2,
// тело — ag-grid { startRow, endRow }. Ответ: { total, data:[ {position,id,...} ] },
// где `id` = nmId. Старый /wb/get/search оказался html-заглушкой (пустой 200).
// Путь и имя параметра оставлены в env на случай смены схемы MPSTATS.
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

// Достаёт массив строк из ответа MPSTATS (форматы варьируются между отчётами).
function pickRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  for (const k of ['data', 'items', 'result']) if (Array.isArray(raw[k])) return raw[k];
  return [];
}

/**
 * Поисковая выдача WB по ключевому слову — ВСЯ (с пагинацией), сырые строки MPSTATS.
 * Нормализацию к контракту делает вызывающий (lib/wbTopKeywords.js); здесь только
 * транспорт: постранично тянем выдачу, пока не выберем всё (`total`) или не упрёмся
 * в предохранитель `maxRows`.
 *
 * Схема залочена живым токеном (см. коммент к SEARCH_PATH): POST с query-параметром
 * `path` (ключевое слово) + d1/d2 + ag-grid тело { startRow, endRow }. Ответ —
 * { total, data:[...] }. Период обязателен, причём d2 должен быть СТРОГО раньше
 * сегодня (иначе 422) — при отсутствии дат подставляем d2=вчера, d1=за 30 дней до.
 *
 * @param {string} query  ключевой запрос
 * @param {object} p  { d1, d2, pageSize=500, maxRows }
 * @returns {Promise<{rows:object[], total:number, period:{d1,d2}, capped:boolean}>}
 */
export async function fetchSearchResults(query, { d1, d2, pageSize = 500, maxRows } = {}) {
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  // d2 по умолчанию — вчера (сегодня эндпоинт не принимает); d1 — за 30 дней до d2.
  const to = d2 || iso(Date.now() - day);
  const from = d1 || iso(new Date(`${to}T00:00:00Z`).getTime() - 30 * day);
  const cap = Number(maxRows) || Number(process.env.MPSTATS_MAX_ROWS) || 2000;

  const period = { d1: from, d2: to };
  const rows = [];
  let total = Infinity;
  let start = 0;

  while (start < Math.min(total, cap)) {
    const end = start + pageSize;
    const qs = new URLSearchParams();
    qs.set(SEARCH_QUERY_PARAM, query);
    qs.set('d1', from);
    qs.set('d2', to);
    const raw = await apiPost(`${SEARCH_PATH}?${qs.toString()}`, { startRow: start, endRow: end });
    const page = pickRows(raw);
    if (!page.length) break;
    rows.push(...page);
    if (raw && Number.isFinite(raw.total)) total = raw.total;
    // Последняя (неполная) страница — выдача исчерпана.
    if (page.length < pageSize) { if (!Number.isFinite(total)) total = rows.length; break; }
    start = end;
  }

  const realTotal = Number.isFinite(total) ? total : rows.length;
  return { rows: rows.slice(0, cap), total: realTotal, period, capped: realTotal > cap };
}

export { BASE_URL, ITEM_SALES_PATH, SEARCH_PATH };
