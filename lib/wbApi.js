// lib/wbApi.js — минимальный клиент официального API Wildberries.
//
// Покрывает три группы эндпоинтов, нужные для сводки по остаткам:
//   • Статистика   (FBO):  GET  /api/v1/supplier/stocks        — остатки на складах WB
//                                                                 + «в пути к клиенту / от клиента»
//   • Маркетплейс  (FBS):  GET  /api/v3/warehouses             — склады продавца
//                          POST /api/v3/stocks/{warehouseId}   — остатки FBS по баркодам
//   • Контент:             POST /content/v2/get/cards/list     — карточки (nmID ↔ артикул ↔ баркоды)
//
// Токен(ы) — из окружения. WB выдаёт JWT-токен с набором категорий; один токен
// может закрывать все три группы. Если категории разнесены по разным токенам —
// можно задать отдельные переменные (см. token()).
//
// Заголовок авторизации WB — просто `Authorization: <токен>` (без «Bearer»).

const HOSTS = {
  stats:       process.env.WB_STATS_HOST       || 'https://statistics-api.wildberries.ru',
  marketplace: process.env.WB_MARKETPLACE_HOST || 'https://marketplace-api.wildberries.ru',
  content:     process.env.WB_CONTENT_HOST     || 'https://content-api.wildberries.ru',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Токен для группы. Приоритет: специфичная переменная → общий WB_API_TOKEN.
function token(group) {
  const specific = {
    stats:       process.env.WB_STATS_TOKEN,
    marketplace: process.env.WB_MARKETPLACE_TOKEN,
    content:     process.env.WB_CONTENT_TOKEN,
  }[group];
  const t = specific || process.env.WB_API_TOKEN;
  if (!t) {
    throw new Error(
      `Не задан WB-токен для группы «${group}». Укажите WB_API_TOKEN ` +
      `(или WB_${group.toUpperCase()}_TOKEN) в переменных окружения.`
    );
  }
  return t;
}

/**
 * Низкоуровневый запрос к WB API с ретраями и бэкоффом.
 * Повторяем сетевые ошибки, тайм-ауты, 429 и 5xx. 4xx (кроме 429) — не ретраим.
 */
async function apiFetch(group, pathAndQuery, { method = 'GET', body = null, retries = 4 } = {}) {
  const url = `${HOSTS[group]}${pathAndQuery}`;
  const timeoutMs = Number(process.env.WB_TIMEOUT_MS) || 60000;
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    try {
      const headers = { Authorization: token(group), Accept: 'application/json' };
      let payload;
      if (body != null) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const resp = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          msg = j?.errorText || j?.detail || j?.message || msg;
        } catch (_) {}
        const err = new Error(`WB ${group} ${resp.status}: ${msg}`);
        err.status = resp.status;
        // 429 (лимит) и 5xx — временные; на 429 WB требует подождать дольше.
        err.retryable = resp.status === 429 || resp.status >= 500;
        throw err;
      }

      // 204/пустое тело — вернём null.
      const text = await resp.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastErr = err;
      const retryable = err?.retryable !== false; // сеть/тайм-аут → true
      if (!retryable || attempt === retries) break;
      // На 429 у статистики лимит ~1 запрос/мин — ждём дольше.
      const base = err?.status === 429 ? 20000 : 2000;
      const wait = base * Math.pow(2, attempt);
      const reason = err?.name === 'TimeoutError' ? `тайм-аут ${timeoutMs}ms` : String(err?.message || err);
      process.stderr.write(`  ↻ WB повтор ${attempt + 1}/${retries} через ${wait}ms (${reason})\n`);
      await sleep(wait);
      attempt += 1;
    }
  }
  throw lastErr;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

// ─────────────────────────────── Статистика (FBO) ───────────────────────────────

/**
 * Текущий снимок остатков FBO (склады WB). dateFrom в прошлом = полный срез.
 * Возвращает нормализованные строки по (артикул × склад × баркод).
 * Поля: seller (артикул продавца), nmId, barcode, techSize, warehouse,
 *       available (доступно), full (всего), inWayToClient, inWayFromClient.
 */
export async function fetchFboStocks(dateFrom = '2020-01-01') {
  const raw = await apiFetch('stats', `/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(dateFrom)}`);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => ({
    seller: r.supplierArticle ?? '',
    nmId: num(r.nmId),
    barcode: String(r.barcode ?? ''),
    techSize: r.techSize ?? '',
    warehouse: r.warehouseName ?? '',
    available: num(r.quantity),
    full: num(r.quantityFull),
    inWayToClient: num(r.inWayToClient),
    inWayFromClient: num(r.inWayFromClient),
    category: r.category ?? '',
    subject: r.subject ?? '',
    brand: r.brand ?? '',
  }));
}

// ─────────────────────────────── Маркетплейс (FBS) ──────────────────────────────

/** Список складов продавца (FBS/фулфилмент). */
export async function fetchFbsWarehouses() {
  const raw = await apiFetch('marketplace', '/api/v3/warehouses');
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((w) => ({ id: num(w.id), name: w.name ?? `Склад ${w.id}`, officeId: num(w.officeId) }));
}

/**
 * Остатки FBS по списку баркодов на конкретном складе продавца.
 * WB принимает до 1000 баркодов за запрос — бьём на батчи.
 * Возвращает Map(barcode → amount) только для ненулевых.
 */
export async function fetchFbsStocks(warehouseId, barcodes) {
  const out = new Map();
  const uniq = [...new Set(barcodes.map(String).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 1000) {
    const batch = uniq.slice(i, i + 1000);
    const raw = await apiFetch('marketplace', `/api/v3/stocks/${warehouseId}`, {
      method: 'POST',
      body: { skus: batch },
    });
    for (const s of raw?.stocks ?? []) {
      const amt = num(s.amount);
      if (amt) out.set(String(s.sku), amt);
    }
  }
  return out;
}

// ─────────────────────────────── Контент (карточки) ─────────────────────────────

/**
 * Все карточки товара с пагинацией по курсору.
 * Возвращает Map(barcode → { seller, nmId, techSize }) — связка баркод ↔ артикул.
 * Нужна, чтобы агрегировать остатки FBS (они приходят по баркодам) по артикулу
 * продавца и чтобы получить полный список баркодов для опроса FBS.
 */
export async function fetchCardsByBarcode() {
  const byBarcode = new Map();
  const limit = 100;
  let cursor = { limit };
  // Защита от бесконечного цикла на нестабильном курсоре.
  for (let guard = 0; guard < 10000; guard += 1) {
    const raw = await apiFetch('content', '/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { cursor, filter: { withPhoto: -1 } } },
    });
    const cards = raw?.cards ?? [];
    for (const c of cards) {
      const seller = c.vendorCode ?? '';
      const nmId = num(c.nmID);
      for (const size of c.sizes ?? []) {
        for (const bc of size.skus ?? []) {
          byBarcode.set(String(bc), { seller, nmId, techSize: size.techSize ?? '' });
        }
      }
    }
    const rc = raw?.cursor ?? {};
    const total = num(rc.total);
    if (total < limit) break; // последняя страница
    cursor = { limit, updatedAt: rc.updatedAt, nmID: rc.nmID };
  }
  return byBarcode;
}

export { HOSTS };
