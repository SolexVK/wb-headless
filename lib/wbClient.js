// lib/wbClient.js — аккуратный клиент WB API с соблюдением лимитов запросов.
//
// Главная опасность прямой работы с WB API — превышение лимитов: WB считает их
// по алгоритму token bucket и при превышении отдаёт 429, а на каскад ошибок
// может временно заблокировать обращения. Этот клиент спроектирован так, чтобы
// НЕ доводить до 429, а если он всё же прилетел — реагировать по правилам WB.
//
// Что делает клиент (по официальной доке, см. docs/wb-api/limits.md):
//   • token bucket на КАЖДУЮ категорию API отдельно (лимиты у категорий свои);
//   • запросы размазываются по интервалу (interval = период / лимит), а не летят
//     залпом — плюс допускается «всплеск» (burst) не больше ёмкости ведра;
//   • читает заголовки ответа X-Ratelimit-Remaining/Limit/Reset/Retry и
//     синхронизует своё ведро с реальным остатком у сервера;
//   • на 429 — ждёт ровно X-Ratelimit-Retry секунд и повторяет (ограниченно);
//   • на прочие 4xx — НЕ повторяет (это ошибка запроса; повтор лишь жжёт лимит,
//     а в категории «Маркетплейс» один 4xx стоит как 10 запросов);
//   • на 5xx / сетевые сбои / тайм-аут — повтор с экспоненциальным бэкоффом.
//
// Базовые лимиты зависят от ТИПА токена. У отдельных методов лимиты жёстче —
// их нужно задавать точечно (methodLimit), сверяясь со страницей метода.

import { resolveWbToken, resolveTokenType } from './wbToken.js';

// ── Базовые лимиты по типам токенов (per-account, на 1 минуту) ───────────────
// Источник: dev.wildberries.ru → «лимиты запросов». period = 60 c.
const TOKEN_LIMITS = {
  personal: { limitPerMin: 300, burst: 20 },
  service: { limitPerMin: 300, burst: 20 },
  base: { limitPerMin: 150, burst: 10 },
  test: { limitPerMin: 150, burst: 10 },
};

// Хосты категорий WB API (можно переопределить через baseUrls в конструкторе).
const CATEGORY_HOSTS = {
  common: 'https://common-api.wildberries.ru',
  content: 'https://content-api.wildberries.ru',
  prices: 'https://discounts-prices-api.wildberries.ru',
  marketplace: 'https://marketplace-api.wildberries.ru',
  statistics: 'https://statistics-api.wildberries.ru',
  analytics: 'https://seller-analytics-api.wildberries.ru',
  promotion: 'https://advert-api.wildberries.ru',
  feedbacks: 'https://feedbacks-api.wildberries.ru',
  chat: 'https://buyer-chat-api.wildberries.ru',
  documents: 'https://documents-api.wildberries.ru',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 250);

/**
 * Token bucket: ёмкость = burst, пополнение = refillPerSec токенов в секунду.
 * take() резолвится, когда доступен хотя бы один токен (с учётом равномерного
 * пополнения), и списывает его. Так запросы идут не чаще, чем разрешено.
 */
class TokenBucket {
  constructor({ capacity, refillPerSec }) {
    this.capacity = Math.max(1, capacity);
    this.refillPerSec = refillPerSec;
    this.tokens = this.capacity; // стартуем «полными» — допускаем первый всплеск
    this.last = Date.now();
  }

  _refill() {
    const now = Date.now();
    const add = ((now - this.last) / 1000) * this.refillPerSec;
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add);
      this.last = now;
    }
  }

  async take() {
    this._refill();
    while (this.tokens < 1) {
      // Сколько ждать до появления одного токена.
      const need = 1 - this.tokens;
      const waitMs = Math.ceil((need / this.refillPerSec) * 1000);
      await sleep(Math.max(50, waitMs));
      this._refill();
    }
    this.tokens -= 1;
  }

  /** Синхронизация с сервером: сервер сказал, сколько всплеска осталось. */
  syncRemaining(remaining) {
    if (Number.isFinite(remaining)) {
      this.tokens = Math.min(this.capacity, Math.max(0, remaining));
      this.last = Date.now();
    }
  }

  /** Обнулить (после 429 — считаем, что всплеск исчерпан). */
  drain() {
    this.tokens = 0;
    this.last = Date.now();
  }
}

export class WbClient {
  /**
   * @param {object} opts
   * @param {string} opts.token        JWT-токен WB API (заголовок Authorization).
   * @param {string} [opts.tokenType]  personal|service|base|test (по умолч. base).
   * @param {object} [opts.baseUrls]   переопределение хостов категорий.
   * @param {number} [opts.maxRetries] попыток на временных сбоях (5xx/сеть).
   * @param {number} [opts.timeoutMs]  тайм-аут одного запроса.
   */
  constructor({ token, tokenType, baseUrls = {}, maxRetries = 3, timeoutMs = 30000 } = {}) {
    // Токен ищем единым резолвером (env WB_API_TOKEN / Wildberries_API → .env),
    // явный аргумент имеет приоритет. tokenSource — откуда взят, для диагностики.
    if (token) {
      this.token = token;
      this.tokenSource = 'аргумент';
    } else {
      const r = resolveWbToken();
      this.token = r.token;
      this.tokenSource = r.source;
    }
    this.tokenType = resolveTokenType(tokenType);
    if (!TOKEN_LIMITS[this.tokenType]) this.tokenType = 'personal';
    this.hosts = { ...CATEGORY_HOSTS, ...baseUrls };
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;

    // По одному ведру на категорию (базовый лимит токена) + отдельные вёдра
    // под конкретные методы, у которых лимит жёстче базового.
    this._catBuckets = new Map();
    this._methodBuckets = new Map();
  }

  _baseLimit() {
    return TOKEN_LIMITS[this.tokenType];
  }

  _catBucket(category) {
    if (!this._catBuckets.has(category)) {
      const { limitPerMin, burst } = this._baseLimit();
      this._catBuckets.set(
        category,
        new TokenBucket({ capacity: burst, refillPerSec: limitPerMin / 60 })
      );
    }
    return this._catBuckets.get(category);
  }

  // methodLimit: { limit, periodSec, burst } — из доки конкретного метода.
  _methodBucket(key, methodLimit) {
    if (!methodLimit) return null;
    if (!this._methodBuckets.has(key)) {
      const { limit, periodSec, burst } = methodLimit;
      this._methodBuckets.set(
        key,
        new TokenBucket({
          capacity: burst || Math.max(1, Math.floor(limit)),
          refillPerSec: limit / (periodSec || 60),
        })
      );
    }
    return this._methodBuckets.get(key);
  }

  /**
   * Запрос к WB API с соблюдением лимитов.
   * @param {string} category  ключ категории (content|statistics|…).
   * @param {string} pathAndMaybeQuery  путь, напр. '/api/v1/supplier/stocks?dateFrom=...'.
   * @param {object} [opts]
   * @param {string} [opts.method='GET']
   * @param {object} [opts.query]  объект query-параметров (удобная альтернатива строке).
   * @param {any}    [opts.body]   тело (будет JSON.stringify).
   * @param {object} [opts.methodLimit]  { limit, periodSec, burst } — точечный лимит метода.
   * @param {string} [opts.baseUrl]  переопределить хост для этого вызова.
   * @returns {Promise<{status:number, data:any, headers:Headers}>}
   */
  async request(category, pathAndMaybeQuery, opts = {}) {
    if (!this.token) {
      throw new Error(
        'Токен WB API не найден. Задайте его переменной окружения ' +
        'WB_API_TOKEN или Wildberries_API, либо строкой в .env в корне репозитория. ' +
        'Проверка: npm run token:check'
      );
    }
    const host = opts.baseUrl || this.hosts[category];
    if (!host) throw new Error(`Неизвестная категория WB API: ${category}`);

    const { method = 'GET', query, body, methodLimit } = opts;
    let path = pathAndMaybeQuery;
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
      ).toString();
      if (qs) path += (path.includes('?') ? '&' : '?') + qs;
    }
    const url = host + path;

    const catBucket = this._catBucket(category);
    const methodKey = `${category} ${method} ${pathAndMaybeQuery.split('?')[0]}`;
    const methodBucket = this._methodBucket(methodKey, methodLimit);

    let attempt = 0;
    // Отдельный счётчик для 429 — чтобы не зациклиться, если сервер упорно душит.
    let tooMany = 0;
    for (;;) {
      // Проактивно ждём разрешения и у категории, и у метода (если задан).
      await catBucket.take();
      if (methodBucket) await methodBucket.take();

      let resp;
      try {
        resp = await fetch(url, {
          method,
          headers: {
            Authorization: this.token,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Сетевые ошибки/тайм-аут — временные, повторяем с бэкоффом.
        if (attempt >= this.maxRetries) throw err;
        const wait = jitter(1000 * Math.pow(2, attempt));
        log(`  ↻ сеть/тайм-аут, повтор ${attempt + 1}/${this.maxRetries} через ${wait}мс`);
        await sleep(wait);
        attempt += 1;
        continue;
      }

      // Синхронизируем ведро категории с реальным остатком всплеска у сервера.
      const remaining = num(resp.headers.get('X-Ratelimit-Remaining'));
      if (remaining != null) catBucket.syncRemaining(remaining);

      if (resp.status === 429) {
        // Превышение скорости. Ждём ровно столько, сколько велит WB.
        catBucket.drain();
        if (methodBucket) methodBucket.drain();
        const retry = num(resp.headers.get('X-Ratelimit-Retry')) ??
          num(resp.headers.get('Retry-After')) ?? 2;
        tooMany += 1;
        if (tooMany > this.maxRetries + 2) {
          const e = new Error(`WB 429: лимит запросов, повторы исчерпаны (${category})`);
          e.status = 429;
          throw e;
        }
        log(`  ⏳ 429 (${category}): жду ${retry}с по X-Ratelimit-Retry и повторяю`);
        await sleep(jitter(retry * 1000));
        continue; // attempt НЕ увеличиваем — это не сбой, а штатное торможение
      }

      if (resp.status >= 500) {
        // Временный сбой сервера — повторяем.
        if (attempt >= this.maxRetries) {
          const e = new Error(`WB ${resp.status}: серверная ошибка (${category})`);
          e.status = resp.status;
          throw e;
        }
        const wait = jitter(1000 * Math.pow(2, attempt));
        log(`  ↻ ${resp.status}, повтор ${attempt + 1}/${this.maxRetries} через ${wait}мс`);
        await sleep(wait);
        attempt += 1;
        continue;
      }

      // Бинарный ответ (напр. ZIP-архив отчёта) — отдаём Buffer как есть.
      if (resp.ok && opts.responseType === 'arraybuffer') {
        const buffer = Buffer.from(await resp.arrayBuffer());
        return { status: resp.status, data: buffer, headers: resp.headers };
      }

      const data = await parseBody(resp);

      if (!resp.ok) {
        // Прочие 4xx (400/401/403/404/409/413…) — НЕ повторяем: это ошибка
        // самого запроса, повтор бесполезен и жжёт лимит (4xx в «Маркетплейс»
        // стоит как 10 запросов). Отдаём осмысленную ошибку наверх.
        const msg = (data && (data.title || data.detail || data.message)) ||
          (typeof data === 'string' ? data.slice(0, 200) : `HTTP ${resp.status}`);
        const e = new Error(`WB ${resp.status}: ${msg}`);
        e.status = resp.status;
        e.data = data;
        throw e;
      }

      return { status: resp.status, data, headers: resp.headers };
    }
  }

  // Удобный шорткат для GET.
  get(category, path, opts = {}) {
    return this.request(category, path, { ...opts, method: 'GET' });
  }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function parseBody(resp) {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json().catch(() => null);
  return resp.text().catch(() => null);
}

function log(msg) {
  process.stderr.write(msg + '\n');
}

export { TOKEN_LIMITS, CATEGORY_HOSTS, TokenBucket };
