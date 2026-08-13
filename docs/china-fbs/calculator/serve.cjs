#!/usr/bin/env node
/* ============================================================
   Мини-сервер калькулятора с HTTP Basic Auth (без зависимостей).
   Слушает только 127.0.0.1 — наружу выводится через Tailscale Funnel.

   Запуск:
     CALC_USER="логин" CALC_PASS="пароль" node serve.cjs
   Переменные окружения:
     CALC_USER  — логин (по умолчанию 'admin')
     CALC_PASS  — пароль (ОБЯЗАТЕЛЬНО, иначе сервер не стартует)
     PORT       — порт (по умолчанию 8787)
     CALC_DIR   — папка со статикой (по умолчанию — папка этого файла)
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.CALC_DIR || __dirname);
const PORT = parseInt(process.env.PORT || '8787', 10);
const USER = process.env.CALC_USER || 'admin';
const PASS = process.env.CALC_PASS || '';

if (!PASS) {
  console.error('Ошибка: не задан пароль. Запустите так: CALC_USER="логин" CALC_PASS="пароль" node serve.cjs');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff2': 'font/woff2',
};

// Сравнение фикс-длины (SHA-256), константное время — без утечки длины/значения.
function digest(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEq(a, b) { return crypto.timingSafeEqual(digest(a), digest(b)); }

function authorized(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const u = i >= 0 ? decoded.slice(0, i) : '';
  const p = i >= 0 ? decoded.slice(i + 1) : '';
  const okUser = safeEq(u, USER);
  const okPass = safeEq(p, PASS);
  return okUser && okPass; // оба проверяются всегда (без короткого замыкания)
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="WB Calc", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('Требуется авторизация');
  }

  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const fp = path.join(ROOT, path.normalize(rel));
  // Защита от выхода за пределы папки (path traversal)
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Калькулятор запущен: http://127.0.0.1:${PORT}  (логин: ${USER})`);
  console.log(`Папка статики: ${ROOT}`);
  console.log('Наружу выводите через: tailscale funnel --bg ' + PORT);
});
