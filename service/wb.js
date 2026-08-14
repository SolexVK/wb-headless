// service/wb.js — валидация WB-токена кабинета (Фаза 1).
// Две ступени проверки:
//   1) ОФФЛАЙН — декодируем JWT (payload по RFC 7519) и по битовой маске `s`
//      определяем тип токена, срок и доступные категории. Наши отчёты требуют
//      Контент + Маркетплейс + Статистика (см. docs/wb-api/*).
//   2) ОНЛАЙН (best-effort) — дёргаем /ping на доменах нужных категорий. Если WB
//      явно отвечает 401 — токен невалиден/категория не совпадает → отказ.
//      Если сеть недоступна — не блокируем (маска уже подтвердила права), помечаем
//      онлайн-проверку как «пропущена».
// Токен здесь НИКОГДА не логируется и не возвращается наружу в открытом виде.

// Позиции бит в поле `s` (отсчёт от 0). Источник: docs/wb-api/limits.md.
const SCOPE_BITS = {
  content: 1, analytics: 2, prices: 3, marketplace: 4, statistics: 5,
  promotion: 6, feedbacks: 7, chat: 9, supplies: 10, returns: 11,
  documents: 12, finance: 13, users: 16,
};
const READONLY_BIT = 30;

export const SCOPE_RU = {
  content: 'Контент', analytics: 'Аналитика', prices: 'Цены и скидки',
  marketplace: 'Маркетплейс', statistics: 'Статистика', promotion: 'Продвижение',
  feedbacks: 'Вопросы и отзывы', chat: 'Чат с покупателями', supplies: 'Поставки',
  returns: 'Возвраты покупателями', documents: 'Документы', finance: 'Финансы',
  users: 'Пользователи',
};

// Категории, без которых наши отчёты не работают.
export const REQUIRED_SCOPES = ['content', 'marketplace', 'statistics'];

const TOKEN_TYPE = { 1: 'Базовый', 2: 'Тестовый', 3: 'Персональный', 4: 'Сервисный' };

// Домены /ping по категориям (только те, что проверяем онлайн).
const PING_HOSTS = {
  content: 'https://content-api.wildberries.ru',
  marketplace: 'https://marketplace-api.wildberries.ru',
  statistics: 'https://statistics-api.wildberries.ru',
};

/**
 * Декодирует payload WB-токена (JWT). Ничего не проверяет по сети.
 * @returns {{ok:boolean, error?:string, sid?:string, acc?:number, typeName?:string,
 *   isTest?:boolean, readOnly?:boolean, exp?:number, expiresAt?:string, expired?:boolean,
 *   sMask?:string, scopes?:string[], scopeNames?:string[]}}
 */
export function decodeWbToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, error: 'Пустой токен.' };
  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Это не похоже на JWT-токен WB (ожидались 3 части через точку).' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Не удалось декодировать payload токена.' };
  }

  // Маска `s` может превышать 32 бита — используем BigInt для битовых проверок.
  let mask = 0n;
  try { mask = BigInt(payload.s ?? 0); } catch { mask = 0n; }
  const hasBit = (pos) => (mask & (1n << BigInt(pos))) !== 0n;

  const scopes = Object.entries(SCOPE_BITS).filter(([, pos]) => hasBit(pos)).map(([k]) => k);
  const readOnly = hasBit(READONLY_BIT);

  const acc = Number(payload.acc);
  const isTest = payload.t === true || acc === 2;
  const exp = Number(payload.exp) || null;
  const expired = exp ? exp * 1000 < Date.now() : false;

  return {
    ok: true,
    sid: payload.sid || null,
    acc: Number.isFinite(acc) ? acc : null,
    typeName: TOKEN_TYPE[acc] || 'неизвестен',
    isTest,
    readOnly,
    exp,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    expired,
    sMask: mask.toString(),
    scopes,
    scopeNames: scopes.map((s) => SCOPE_RU[s] || s),
  };
}

/** Каких обязательных категорий не хватает в маске. */
export function missingScopes(decoded) {
  if (!decoded?.ok) return REQUIRED_SCOPES.slice();
  return REQUIRED_SCOPES.filter((s) => !decoded.scopes.includes(s));
}

/** Один /ping. 200 → ok; 401 → категория не совпадает/невалиден; сеть → skipped. */
async function pingOne(category, token, timeoutMs) {
  const url = `${PING_HOSTS[category]}/ping`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 200) return { category, ok: true, status: 200 };
    if (res.status === 401) return { category, ok: false, status: 401, reason: 'нет доступа (401)' };
    return { category, ok: false, status: res.status, reason: `HTTP ${res.status}` };
  } catch {
    return { category, ok: null, status: null, reason: 'сеть недоступна', skipped: true };
  }
}

/**
 * Полная проверка токена перед привязкой кабинета.
 * @param {string} token
 * @param {{online?:boolean, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, decoded:object, missing:string[], errors:string[],
 *   warnings:string[], pings:object[], meta:object}>}
 */
export async function validateToken(token, { online = true, timeoutMs = 8000 } = {}) {
  const decoded = decodeWbToken(token);
  const errors = [];
  const warnings = [];

  if (!decoded.ok) {
    return { ok: false, decoded, missing: REQUIRED_SCOPES.slice(), errors: [decoded.error], warnings, pings: [], meta: null };
  }
  if (decoded.expired) errors.push('Срок действия токена истёк — выпустите новый в кабинете продавца.');

  const missing = missingScopes(decoded);
  if (missing.length) {
    errors.push('В токене не хватает категорий: ' + missing.map((s) => SCOPE_RU[s]).join(', ') +
      '. Нужны: ' + REQUIRED_SCOPES.map((s) => SCOPE_RU[s]).join(', ') + '.');
  }
  if (decoded.acc === 3) {
    warnings.push('Это персональный токен. Для сервиса безопаснее выпустить отдельный токен только с нужными категориями.');
  }
  if (decoded.isTest) warnings.push('Это тестовый токен — данные могут быть не боевыми.');
  if (decoded.readOnly) warnings.push('Токен только на чтение — этого достаточно для отчётов (запись не требуется).');

  // Онлайн-проверка только если оффлайн-часть без фатальных ошибок (не жжём /ping зря).
  let pings = [];
  if (online && errors.length === 0) {
    pings = await Promise.all(REQUIRED_SCOPES.map((c) => pingOne(c, token, timeoutMs)));
    const denied = pings.filter((p) => p.ok === false);
    if (denied.length) {
      errors.push('WB отклонил токен для категорий: ' +
        denied.map((p) => `${SCOPE_RU[p.category]} (${p.reason})`).join(', ') + '.');
    }
    if (pings.some((p) => p.skipped)) {
      warnings.push('Онлайн-проверку /ping выполнить не удалось (сеть) — права подтверждены по маске токена.');
    }
  }

  const meta = {
    sid: decoded.sid,
    typeName: decoded.typeName,
    acc: decoded.acc,
    isTest: decoded.isTest,
    readOnly: decoded.readOnly,
    exp: decoded.exp,
    expiresAt: decoded.expiresAt,
    scopes: decoded.scopes,
    scopeNames: decoded.scopeNames,
    checkedAt: new Date().toISOString(),
    pingOk: pings.filter((p) => p.ok === true).map((p) => p.category),
  };

  return { ok: errors.length === 0, decoded, missing, errors, warnings, pings, meta };
}

export { SCOPE_BITS, READONLY_BIT, PING_HOSTS, TOKEN_TYPE };
