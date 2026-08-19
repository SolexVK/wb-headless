// lib/wbToken.js — единая точка, где берётся токен Wildberries API.
//
// Зачем отдельный модуль: токен может лежать в разных местах в зависимости от
// того, как запущен код (интерактивная сессия, локальный запуск, CI). Чтобы
// «в нужный момент достать токен для нужного запроса» без гадания, поиск
// централизован здесь с чёткой очередью приоритетов и понятным ответом,
// ОТКУДА токен взят.
//
// Очередь поиска (первый непустой выигрывает):
//   1. process.env.WB_API_TOKEN        — каноническое имя переменной окружения
//   2. process.env.Wildberries_API     — имя, под которым токен задан в проекте
//                                        (.env и Repository secrets)
//   3. .env в корне репозитория         — ключи WB_API_TOKEN / Wildberries_API
//      (парсим файл напрямую, т.к. Node не грузит .env сам, без --env-file)
//
// ВАЖНО про CI/сессии: GitHub «Repository secrets» доступны ТОЛЬКО внутри
// GitHub Actions и только если workflow их прокидывает в env
// (`WB_API_TOKEN: ${{ secrets.Wildberries_API }}`). В интерактивную сессию/
// контейнер они НЕ попадают — там токен должен прийти переменной окружения
// среды или файлом .env.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Имена, под которыми ищем токен (и в env, и в .env).
const TOKEN_KEYS = ['WB_API_TOKEN', 'Wildberries_API'];

/** Минимальный парсер .env: KEY=VALUE, игнор комментариев и пустых строк. */
function parseDotEnv(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out; // файла нет — это нормально
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    // снимаем обрамляющие кавычки, если есть
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Находит токен WB API. Возвращает { token, source } или { token: null, source: null }.
 * source — человекочитаемое, откуда взят (для логов/диагностики), без значения токена.
 * @param {object} [opts]
 * @param {string} [opts.root]  корень репозитория (для .env). По умолчанию — этот репо.
 */
export function resolveWbToken({ root = REPO_ROOT } = {}) {
  // 1–2. Переменные окружения по очереди имён.
  for (const key of TOKEN_KEYS) {
    const v = process.env[key];
    if (v && v.trim()) return { token: v.trim(), source: `env:${key}` };
  }
  // 3. .env в корне репозитория.
  const env = parseDotEnv(path.join(root, '.env'));
  for (const key of TOKEN_KEYS) {
    const v = env[key];
    if (v && v.trim()) return { token: v.trim(), source: `.env:${key}` };
  }
  return { token: null, source: null };
}

/** Как в маске: первые 4 и последние 4 символа, середина скрыта. Для логов. */
export function maskToken(token) {
  if (!token) return '(нет)';
  if (token.length <= 12) return token.slice(0, 2) + '…' + token.slice(-2);
  return `${token.slice(0, 4)}…${token.slice(-4)} (len ${token.length})`;
}

/** Тип токена: явный аргумент → WB_TOKEN_TYPE → 'personal' (у нас персональный). */
export function resolveTokenType(explicit) {
  return (explicit || process.env.WB_TOKEN_TYPE || 'personal').toLowerCase();
}

export { TOKEN_KEYS, REPO_ROOT };
