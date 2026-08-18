// lib/resolveWbToken.js — авто-поиск WB-токена «где бы он ни лежал».
//
// Цель — не вписывать токен руками. Резолвер по очереди проверяет типовые места
// и, найдя токен, кладёт его в process.env.WB_API_TOKEN (если тот ещё не задан),
// чтобы lib/wbApi.js подхватил его штатно.
//
// Порядок поиска:
//   1. Стандартные переменные: WB_API_TOKEN / WB_STATS_TOKEN /
//      WB_MARKETPLACE_TOKEN / WB_CONTENT_TOKEN (в т.ч. из .env/.env.local —
//      их уже загрузил loadEnv).
//   2. Переменные окружения с «похожим» именем (WB_TOKEN, WILDBERRIES_TOKEN,
//      WB_API_KEY … — любое имя вида WB…TOKEN/KEY или WILDBERRIES…), кроме MPSTATS.
//   3. Файл-токен: путь из WB_TOKEN_FILE либо типовые (~/.wb_token,
//      ~/.config/wb/token, <репо>/.wb-token).
//   4. macOS Keychain (только на darwin): security find-generic-password
//      по нескольким именам сервиса.
//
// Значение токена НИКОГДА не логируется — только источник и длина.

import './loadEnv.js'; // подтянуть .env/.env.local перед проверкой окружения
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const STANDARD = ['WB_API_TOKEN', 'WB_STATS_TOKEN', 'WB_MARKETPLACE_TOKEN', 'WB_CONTENT_TOKEN'];

// Похоже ли имя переменной на WB-токен (и точно не MPSTATS)?
function looksLikeWbTokenName(key) {
  const k = key.toLowerCase();
  if (k.includes('mpstats')) return false;
  const norm = k.replace(/[_-]/g, '');
  // Не токены, а указатели/настройки: путь к файлу, хост, URL, база.
  if (/(file|path|host|url|base|dir)$/.test(norm)) return false;
  if (norm.includes('wildberries') && (norm.includes('token') || norm.includes('key'))) return true;
  return norm.startsWith('wb') && (norm.includes('token') || norm.includes('key'));
}

function fromKeychain(checked) {
  if (process.platform !== 'darwin') return null;
  const account = process.env.USER || '';
  const services = ['WB_API_TOKEN', 'wb_api_token', 'wb-api-token', 'wildberries', 'wb'];
  for (const svc of services) {
    checked.push(`Keychain: сервис «${svc}»`);
    try {
      const args = ['find-generic-password', '-w', '-s', svc];
      if (account) args.push('-a', account);
      const out = execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const val = String(out).trim();
      if (val) return { value: val, source: `Keychain (сервис «${svc}»)` };
    } catch (_) { /* нет такой записи — идём дальше */ }
  }
  return null;
}

function fromFile(checked) {
  const candidates = [
    process.env.WB_TOKEN_FILE,
    path.join(os.homedir(), '.wb_token'),
    path.join(os.homedir(), '.config', 'wb', 'token'),
    path.join(REPO_ROOT, '.wb-token'),
  ].filter(Boolean);
  for (const f of candidates) {
    checked.push(`Файл: ${f}`);
    try {
      const val = fs.readFileSync(f, 'utf8').trim();
      if (val) return { value: val, source: `файл ${f}` };
    } catch (_) { /* нет файла — дальше */ }
  }
  return null;
}

/**
 * Находит WB-токен и проставляет process.env.WB_API_TOKEN.
 * @returns {{ found: boolean, source: string|null, checked: string[] }}
 */
export function resolveWbToken() {
  const checked = [];

  // 1. Стандартные переменные (включая раздельные по категориям).
  for (const name of STANDARD) {
    checked.push(`env: ${name}`);
    if (process.env[name]) {
      return { found: true, source: `переменная ${name}`, checked };
    }
  }

  // 2. Похоже названная переменная окружения.
  for (const [key, val] of Object.entries(process.env)) {
    if (val && looksLikeWbTokenName(key) && !STANDARD.includes(key)) {
      process.env.WB_API_TOKEN = val;
      return { found: true, source: `переменная ${key}`, checked: [...checked, `env(scan): ${key}`] };
    }
  }

  // 3. Файл-токен.
  const f = fromFile(checked);
  if (f) {
    process.env.WB_API_TOKEN = f.value;
    return { found: true, source: f.source, checked };
  }

  // 4. macOS Keychain.
  const kc = fromKeychain(checked);
  if (kc) {
    process.env.WB_API_TOKEN = kc.value;
    return { found: true, source: kc.source, checked };
  }

  return { found: false, source: null, checked };
}

/** Короткая маскировка для лога: длина + первые/последние 2 символа. */
export function tokenHint() {
  const t = process.env.WB_API_TOKEN || process.env.WB_STATS_TOKEN || '';
  if (!t) return '(нет)';
  const head = t.slice(0, 2);
  const tail = t.slice(-2);
  return `длина ${t.length}, ${head}…${tail}`;
}
