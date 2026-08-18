// lib/loadEnv.js — крошечный загрузчик .env без внешних зависимостей.
//
// Побочный импорт: `import './lib/loadEnv.js'` в начале скрипта прочитает файл
// .env из корня репозитория и положит переменные в process.env — но только те,
// что ещё НЕ заданы в окружении (реальное окружение всегда важнее файла).
//
// Поддерживает: строки KEY=VALUE, комментарии (# …), пустые строки, кавычки
// вокруг значения и необязательный префикс `export `. Значение не разворачивает
// (никаких $VAR внутри) — берётся как есть.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseAndApply(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return; // .env нет — это нормально
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7) : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let val = body.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// .env.local читаем первым (более специфичный), затем .env — но так как
// parseAndApply не перекрывает уже заданные ключи, .env.local имеет приоритет.
parseAndApply(path.join(__dirname, '..', '.env.local'));
parseAndApply(path.join(__dirname, '..', '.env'));
