// service/config.js — конфигурация из окружения (.env).
// Слушаем только loopback (правила Mac Mini): наружу публикует Caddy.
import 'dotenv/config';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';

// SESSION_SECRET обязателен в проде; в dev — генерируем эфемерный с предупреждением.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) throw new Error('SESSION_SECRET обязателен в production (см. .env.example)');
  sessionSecret = crypto.randomBytes(48).toString('hex');
  process.stderr.write('[config] SESSION_SECRET не задан — использую эфемерный (сессии сбросятся при рестарте). Задайте .env для стабильности.\n');
}

// TOKEN_ENC_KEY нужен с Фазы 1 (шифрование WB-токенов). В проде — обязателен;
// в dev без него сервис стартует, но привязка кабинета упадёт с понятной ошибкой.
const tokenEncKey = process.env.TOKEN_ENC_KEY || null;
if (!tokenEncKey && isProd) throw new Error('TOKEN_ENC_KEY обязателен в production (нужен для шифрования WB-токенов, см. .env.example)');
if (!tokenEncKey) process.stderr.write('[config] TOKEN_ENC_KEY не задан — подключение кабинетов WB будет недоступно (Фаза 1). Задайте .env.\n');

// BASE_PATH — префикс, под которым сервис отдаётся наружу (напр. '/fbs' за Caddy).
// Нормализуем к виду '' | '/fbs' (ведущий слэш, без хвостового). Пустой = корень.
let basePath = String(process.env.BASE_PATH || '').trim();
if (basePath && !basePath.startsWith('/')) basePath = '/' + basePath;
basePath = basePath.replace(/\/+$/, '');

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 9110),
  basePath,
  isProd,
  sessionSecret,
  tokenEncKey, // нужен с Фазы 1 (шифрование WB-токенов)
  dbPath: path.resolve(__dirname, process.env.DB_PATH || './data/app.sqlite'),
  // Онлайн-проверка токена через /ping WB при привязке кабинета.
  // По умолчанию включена; тесты/офлайн-среда выключают через WB_PING_ONLINE=0.
  wbPingOnline: !['0', 'false', 'no'].includes(String(process.env.WB_PING_ONLINE || '').toLowerCase()),
  // Лицензия: сколько мест (человек, включая владельца) у новой компании.
  // Строго ограничивает приглашения; менять число мест может только супер-админ.
  defaultLicenseSeats: Math.max(1, Number(process.env.DEFAULT_LICENSE_SEATS || 1)),
  // Супер-админы (могут менять число мест у любой компании). Список email через запятую.
  superAdminEmails: String(process.env.SUPER_ADMIN_EMAILS || 'solexvk@gmail.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

export const isSuperAdmin = (email) => !!email && config.superAdminEmails.includes(String(email).toLowerCase());
