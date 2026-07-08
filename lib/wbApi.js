// lib/wbApi.js — низкоуровневый клиент WB Seller API с ЖЁСТКИМ соблюдением лимитов.
//
// ⚠ Главное назначение модуля — не превысить лимиты Wildberries и не словить бан.
// WB применяет token-bucket и на превышение отвечает 429; при систематическом
// превышении может временно заблокировать токен. Поэтому здесь:
//   • все запросы к одному лимит-«ведру» строго СЕРИАЛИЗОВАНЫ и разнесены во
//     времени на минимальный интервал (по умолчанию — консервативно);
//   • на 429 честно ждём Retry-After и не долбим повторами;
//   • дефолтные интервалы взяты по верхней границе строгости из документации.
//
// Документация (на момент написания):
//   • Статистика  https://statistics-api.wildberries.ru  — /api/v1/supplier/stocks
//     отдаёт ТЕКУЩИЙ снимок остатков (истории нет), лимит ~1 запрос/мин.
//   • Аналитика    https://seller-analytics-api.wildberries.ru — асинхронные
//     CSV-отчёты (создать → статус → скачать). Тип STOCK_HISTORY_DAILY_CSV даёт
//     остаток по каждому дню (на 23:59) за период до 3 месяцев, без подписки Jam.
//
// Токен берётся из окружения WB_TOKEN (категория «Аналитика»/«Статистика»),
// в код/git не хардкодим.

const STATS_BASE = (process.env.WB_STATS_BASE || 'https://statistics-api.wildberries.ru').replace(/\/+$/, '');
const ANALYTICS_BASE = (process.env.WB_ANALYTICS_BASE || 'https://seller-analytics-api.wildberries.ru').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  const t = process.env.WB_TOKEN;
  if (!t) throw new Error('WB_TOKEN не задан в переменных окружения');
  return t;
}

/**
 * Пер-«ведро» последовательный планировщик: гарантирует, что между двумя
 * запросами одной группы пройдёт не меньше minIntervalMs. Разные группы
 * (например, статистика и аналитика) не мешают друг другу, но внутри группы
 * всё строго по очереди — никаких всплесков.
 */
class RateBucket {
  constructor(minIntervalMs) {
    this.minInterval = minIntervalMs;
    this.last = 0;
    this.tail = Promise.resolve();
  }
  // Ставит задачу в хвост очереди своей группы и запускает не раньше,
  // чем через minInterval после предыдущего старта в этой группе.
  schedule(fn) {
    const run = async () => {
      const wait = this.last + this.minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    };
    // Ошибку одной задачи не даём «отравить» всю очередь.
    const result = this.tail.then(run, run);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

// Консервативные интервалы. Меняются через env, но по умолчанию — «медленно и
// безопасно»: лучше собрать отчёт на минуту дольше, чем поймать бан.
const buckets = {
  stats: new RateBucket(Number(process.env.WB_STATS_MIN_INTERVAL_MS) || 61_000), // ~1/мин
  analytics: new RateBucket(Number(process.env.WB_ANALYTICS_MIN_INTERVAL_MS) || 21_000), // ~3/мин
};

/**
 * Один HTTP-запрос к WB с авторизацией, тайм-аутом, ретраями и уважением к 429.
 * НЕ вызывать напрямую в цикле — только через bucket.schedule (см. ниже).
 */
async function rawRequest(url, { method = 'GET', body, retries = 3, binary = false } = {}) {
  const timeoutMs = Number(process.env.WB_TIMEOUT_MS) || 60_000;
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    try {
      const headers = { Authorization: token(), Accept: 'application/json' };
      if (body != null) headers['Content-Type'] = 'application/json';
      const resp = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // 429 — превышение лимита. Ждём Retry-After (или растущий бэкофф) и повторяем.
      if (resp.status === 429) {
        const ra = Number(resp.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 * Math.pow(2, attempt);
        process.stderr.write(`  ⚠ WB 429 (лимит): ждём ${Math.round(wait / 1000)}с и повторяем\n`);
        await sleep(wait);
        attempt += 1;
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`WB ${resp.status}: токен недействителен или нет доступа к категории API`);
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const err = new Error(`WB ${resp.status}: ${text.slice(0, 300)}`);
        err.retryable = resp.status >= 500;
        throw err;
      }
      if (binary) return Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get('content-type') || '';
      return ct.includes('application/json') ? await resp.json() : await resp.text();
    } catch (err) {
      lastErr = err;
      const retryable = err?.retryable !== false && err?.name !== 'AbortError'
        ? true
        : err?.name === 'TimeoutError';
      if (attempt >= retries || err?.message?.includes('токен недействителен')) break;
      const wait = 2000 * Math.pow(2, attempt);
      process.stderr.write(`  ↻ WB повтор ${attempt + 1}/${retries} (${String(err?.message || err).slice(0, 80)})\n`);
      await sleep(wait);
      attempt += 1;
    }
  }
  throw lastErr;
}

/** GET/POST к Статистике через её лимит-ведро. */
export function statsRequest(path, opts) {
  return buckets.stats.schedule(() => rawRequest(`${STATS_BASE}${path}`, opts));
}
/** GET/POST к Аналитике через её лимит-ведро. */
export function analyticsRequest(path, opts) {
  return buckets.analytics.schedule(() => rawRequest(`${ANALYTICS_BASE}${path}`, opts));
}

export { STATS_BASE, ANALYTICS_BASE, sleep };
