// auth.js — авторизация через Telegram Login Widget + подписанные сессии.
//
// Telegram Login Widget возвращает подписанные данные о пользователе. Их подлинность
// проверяется HMAC-SHA256 с секретом = SHA256(bot_token): подделать вход нельзя.
// После проверки выдаём собственную сессию — компактный подписанный токен (как мини-JWT)
// на HMAC-SHA256 с SESSION_SECRET. В нём только telegramId + id сессии; права и статус
// проверяются на сервере по таблице users при каждом запросе (мгновенный отзыв доступа).

import crypto from 'crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Проверить данные Telegram Login Widget.
 * @param {object} data  поля от Telegram (включая hash): id, first_name, username, auth_date, hash…
 * @param {string} botToken  токен бота (из @BotFather)
 * @param {number} [maxAgeSec=86400]  макс. возраст auth_date (защита от повторной отправки)
 * @returns {boolean}
 */
export function verifyTelegramAuth(data, botToken, maxAgeSec = 86400) {
  if (!data || !botToken || !data.hash) return false;
  const { hash, ...rest } = data;
  const checkString = Object.keys(rest).sort()
    .filter((k) => rest[k] != null && rest[k] !== '')
    .map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  // сравнение постоянного времени
  const a = Buffer.from(hmac), b = Buffer.from(String(hash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const authDate = Number(rest.auth_date) || 0;
  if (Date.now() / 1000 - authDate > maxAgeSec) return false; // просрочено
  return true;
}

/** Новый идентификатор сессии (для «одна активная сессия на аккаунт»). */
export function newSessionId() { return crypto.randomBytes(16).toString('hex'); }

/** Подписать сессию: payload → компактный токен body.sig. */
export function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Проверить/распаковать сессию. Возвращает payload или null. */
export function verifySession(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const i = token.lastIndexOf('.');
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
