// scripts/wb-unit-bot.mjs — Telegram-бот Юнит-калькулятора WB.
//
// Пользователь в личке бота задаёт вводные (себестоимость, цена продажи, ДРР…)
// интерактивными сообщениями — бот присылает разбор экономики, коридор цены,
// точку безубыточности и, по кнопке, PDF-отчёт.
//
// Механизм: long-polling (getUpdates) — публичный URL не нужен, работает через
// исходящий HTTPS-прокси окружения. Логика диалога — lib/wbUnitBot.js (чистая,
// покрыта офлайн-тестом), транспорт — lib/telegram.js, расчёт — lib/wbUnitCalc.js.
//
// Запуск:
//   TELEGRAM_BOT_TOKEN=123:ABC npm run unit:bot
//   # опционально ограничить доступ (иначе отвечает всем):
//   TELEGRAM_ALLOWED_CHAT_IDS=11111111,22222222 TELEGRAM_BOT_TOKEN=... npm run unit:bot

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot } from '../lib/telegram.js';
import { handleMessage, handleCallback, computeResult } from '../lib/wbUnitBot.js';
import { formatHtml } from '../lib/wbUnitCalc.js';

const log = (...a) => process.stderr.write(`[unit-bot] ${a.join(' ')}\n`);

// Разрешённые chat id (если задано — остальным не отвечаем).
const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isAllowed = (chatId) => allowed.length === 0 || allowed.includes(String(chatId));

// Состояние диалога по чатам (в памяти — для калькулятора этого достаточно).
const sessions = new Map();

let bot;
try {
  bot = new TelegramBot();
} catch (err) {
  log(err.message);
  log('Пример: TELEGRAM_BOT_TOKEN=123:ABC npm run unit:bot');
  process.exit(2);
}

const me = await bot.getMe().catch((e) => { log('Токен не принят: ' + e.message); process.exit(1); });
log(`Запущен как @${me.username}. Жду сообщений${allowed.length ? ` (доступ: ${allowed.join(', ')})` : ' (доступ открыт всем)'}…`);

// Рендер PDF-отчёта во временный файл, отправка документом, уборка.
async function sendPdf(chatId, session) {
  const res = computeResult(session);
  const dir = mkdtempSync(join(tmpdir(), 'unit-bot-'));
  const path = join(dir, 'unit-calc.pdf');
  try {
    const { htmlToPdf } = await import('../lib/htmlToPdf.js');
    await htmlToPdf(formatHtml(res, { subtitle: 'Расчёт из Telegram' }), path);
    await bot.sendDocument(chatId, path, { caption: 'Юнит-калькулятор — PDF-отчёт' });
  } catch (err) {
    log('PDF не собран: ' + (err?.message || err));
    await bot.sendMessage(chatId, '⚠️ Не удалось собрать PDF (нужен Chromium/Playwright). Текстовый разбор выше актуален.', { parseMode: 'HTML' });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  const text = msg.text || '';
  const { session, reply } = handleMessage(sessions.get(chatId), text);
  sessions.set(chatId, session);
  if (reply?.text) await bot.sendMessage(chatId, reply.text, reply);
}

async function onCallback(cq) {
  const chatId = cq.message?.chat?.id;
  if (!chatId || !isAllowed(chatId)) { await bot.answerCallbackQuery(cq.id); return; }
  const { session, reply, answer } = handleCallback(sessions.get(chatId), cq.data);
  sessions.set(chatId, session);
  await bot.answerCallbackQuery(cq.id, answer || '');
  if (reply?.text) await bot.sendMessage(chatId, reply.text, reply);
  if (reply?.wantPdf) await sendPdf(chatId, session);
}

// Главный цикл long-poll. Сетевые сбои не роняют бота — пауза и повтор.
let running = true;
process.on('SIGINT', () => { running = false; log('Останавливаюсь…'); });
process.on('SIGTERM', () => { running = false; });

while (running) {
  try {
    const updates = await bot.getUpdates(50);
    for (const u of updates) {
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (err) {
        log('Ошибка обработки апдейта: ' + (err?.message || err));
      }
    }
  } catch (err) {
    log('Сбой long-poll: ' + (err?.message || err) + ' — пауза 5с');
    await new Promise((r) => setTimeout(r, 5000));
  }
}
process.exit(0);
