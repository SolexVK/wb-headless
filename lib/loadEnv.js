// lib/loadEnv.js — подхват .env для CLI-скриптов, без зависимостей.
//
// Службы на Mac Mini получают переменные из своих launchd-plist, а скрипты,
// запускаемые руками, не получают ниоткуда. Отсюда «MPSTATS_TOKEN не задан»
// при запуске из git worktree, где .env отсутствует (он в .gitignore).
//
// Порядок поиска, первый найденный файл выигрывает:
//   1. $WB_ENV_FILE          — явное указание
//   2. ./.env                — текущий каталог
//   3. <корень репозитория>/.env
//   4. ../<имя репозитория>/.env — соседний основной клон, если запуск
//      из worktree: секреты лежат там, дублировать их незачем
//
// Уже выставленные переменные окружения НЕ перезаписываются: то, что задано
// в оболочке или в plist, всегда важнее файла.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function candidates() {
  const list = [];
  if (process.env.WB_ENV_FILE) list.push(process.env.WB_ENV_FILE);
  list.push(path.resolve(process.cwd(), '.env'));
  list.push(path.join(REPO_ROOT, '.env'));
  // Соседний основной клон: worktree называется как-то вроде
  // wb-headless-imgsearch, а секреты лежат в wb-headless рядом.
  const base = path.basename(REPO_ROOT);
  const stem = base.split('-').slice(0, 2).join('-');
  if (stem && stem !== base) {
    list.push(path.join(path.dirname(REPO_ROOT), stem, '.env'));
    list.push(path.join(os.homedir(), stem, '.env'));
  }
  return list;
}

/**
 * Загружает первый найденный .env в process.env, не затирая существующее.
 * @returns {{file: ?string, loaded: string[]}} путь и список добавленных ключей
 */
export function loadEnv() {
  for (const file of candidates()) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    const vars = parse(text);
    const loaded = [];
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        loaded.push(k);
      }
    }
    return { file, loaded };
  }
  return { file: null, loaded: [] };
}

/**
 * Проверяет, что нужные переменные есть, и внятно объясняет, что делать.
 * Завершает процесс с кодом 1, если чего-то не хватает.
 */
export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (!missing.length) return;
  console.error(`Не заданы переменные: ${missing.join(', ')}\n`);
  console.error('Где их взять — любой из вариантов:');
  console.error('  1. положить .env рядом со скриптом:');
  console.error(`       cp ~/wb-headless/.env ${process.cwd()}/.env`);
  console.error('  2. указать файл явно:');
  console.error('       WB_ENV_FILE=~/wb-headless/.env node <скрипт>');
  console.error('  3. выставить в оболочке:');
  console.error(`       export ${missing[0]}=...`);
  process.exit(1);
}
