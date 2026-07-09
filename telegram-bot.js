// telegram-bot.js — мост Telegram ↔ Claude Agent.
//
// Позволяет ставить задачи по проекту прямо из Telegram-чата: ваши сообщения
// уходят в Claude Agent SDK (тот же движок, что и Claude Code — с доступом к
// файлам репозитория, git и командам), а ответ приходит обратно в чат.
//
// Режим связи с Telegram — long polling (getUpdates): бот сам опрашивает
// Telegram, публичный URL/веб-хук не нужен. Запустил `npm run bot` — работает.
//
// Переменные окружения (см. .env.example):
//   TELEGRAM_BOT_TOKEN      — токен бота от @BotFather (обязательно)
//   TELEGRAM_ALLOWED_CHAT   — ваш chat id; только он может писать боту (обязательно)
//   ANTHROPIC_API_KEY       — ключ Claude API для движка агента (обязательно)
//   CLAUDE_MODEL            — модель (по умолчанию claude-opus-4-8)
//   CLAUDE_PERMISSION_MODE  — режим прав агента (по умолчанию acceptEdits)
//   BOT_WORKDIR             — рабочая папка агента (по умолчанию папка проекта)

import path from 'path';
import { fileURLToPath } from 'url';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT = String(process.env.TELEGRAM_ALLOWED_CHAT || '').trim();
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits';
const WORKDIR = process.env.BOT_WORKDIR
  || path.dirname(fileURLToPath(import.meta.url));

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const TG_MSG_LIMIT = 4096; // лимит длины сообщения в Telegram

// ---------- проверка окружения ----------
function requireEnv() {
  const missing = [];
  if (!TG_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!ALLOWED_CHAT) missing.push('TELEGRAM_ALLOWED_CHAT');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    console.error(
      'Не заданы переменные окружения: ' + missing.join(', ') +
      '\nСкопируйте .env.example в .env и впишите значения (см. REPORTS.md / TELEGRAM.md).'
    );
    process.exit(1);
  }
}

// ---------- Claude Agent SDK (грузим динамически, чтобы дать понятную ошибку) ----------
async function loadAgent() {
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    return mod.query;
  } catch (err) {
    console.error(
      'Не найден пакет @anthropic-ai/claude-agent-sdk.\n' +
      'Установите зависимости: npm install\n' +
      'Исходная ошибка: ' + (err?.message || err)
    );
    process.exit(1);
  }
}

// ---------- Telegram helpers ----------
async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  }
  return data.result;
}

async function sendMessage(chatId, text) {
  // режем длинные ответы на части по лимиту Telegram
  const chunks = [];
  let rest = String(text || '').trim() || '(пустой ответ)';
  while (rest.length > TG_MSG_LIMIT) {
    // стараемся резать по переносу строки, чтобы не рвать посреди слова
    let cut = rest.lastIndexOf('\n', TG_MSG_LIMIT);
    if (cut < TG_MSG_LIMIT * 0.5) cut = TG_MSG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    await tg('sendMessage', { chat_id: chatId, text: chunk });
  }
}

async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); }
  catch (_) { /* не критично */ }
}

// ---------- запуск задачи в Claude Agent ----------
// Храним sessionId, чтобы диалог продолжался между сообщениями (агент помнит контекст).
let sessionId = null;

async function runAgent(query, prompt) {
  let finalText = '';
  const options = {
    cwd: WORKDIR,
    model: MODEL,
    permissionMode: PERMISSION_MODE,
  };
  // bypassPermissions требует явного подтверждения (мера безопасности SDK)
  if (PERMISSION_MODE === 'bypassPermissions') {
    options.allowDangerouslySkipPermissions = true;
  }
  if (sessionId) options.resume = sessionId;

  for await (const message of query({ prompt, options })) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id; // запоминаем сессию для продолжения диалога
    } else if (message.type === 'result') {
      if (typeof message.result === 'string') {
        finalText = message.result; // успешный ответ агента
      } else if (message.is_error) {
        const errs = Array.isArray(message.errors) ? message.errors.join('\n') : '';
        finalText = 'Агент завершился с ошибкой' +
          (message.subtype ? ` (${message.subtype})` : '') +
          (errs ? ':\n' + errs : '.');
      }
    }
  }
  return finalText;
}

// ---------- команды ----------
const HELP = [
  'Я — мост в Claude Agent для проекта wb-headless.',
  'Просто пишите задачу текстом — я выполню её в репозитории и пришлю результат.',
  '',
  'Команды:',
  '/start — приветствие',
  '/reset — начать новый диалог (сбросить контекст сессии)',
  '/help — эта справка',
].join('\n');

async function handleMessage(query, chatId, text) {
  const trimmed = text.trim();

  if (trimmed === '/start' || trimmed === '/help') {
    await sendMessage(chatId, HELP);
    return;
  }
  if (trimmed === '/reset') {
    sessionId = null;
    await sendMessage(chatId, 'Контекст сброшен. Начинаем новый диалог.');
    return;
  }

  await sendTyping(chatId);
  // фоновый «печатает…», пока агент думает
  const typing = setInterval(() => sendTyping(chatId), 5000);
  try {
    const answer = await runAgent(query, trimmed);
    await sendMessage(chatId, answer);
  } catch (err) {
    await sendMessage(chatId, 'Ошибка: ' + (err?.message || String(err)));
  } finally {
    clearInterval(typing);
  }
}

// ---------- основной цикл long polling ----------
async function main() {
  requireEnv();
  const query = await loadAgent();

  // узнаём имя бота, заодно проверяем токен
  const me = await tg('getMe', {});
  console.log(`Бот @${me.username} запущен (long polling).`);
  console.log(`Рабочая папка агента: ${WORKDIR}`);
  console.log(`Разрешённый chat id: ${ALLOWED_CHAT}`);

  let offset = 0;
  // сбрасываем «зависшие» апдейты, накопившиеся до запуска
  try {
    const backlog = await tg('getUpdates', { offset: -1, timeout: 0 });
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
  } catch (_) {}

  while (true) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 30 });
    } catch (err) {
      console.error('getUpdates:', err?.message || err);
      await new Promise(r => setTimeout(r, 3000)); // подождём и повторим
      continue;
    }

    for (const upd of updates) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg || !msg.text) continue;

      const chatId = String(msg.chat.id);
      if (chatId !== ALLOWED_CHAT) {
        // не наш чат — вежливо игнорируем, но подсказываем chat id (удобно при настройке)
        await sendMessage(chatId, `Доступ запрещён. Ваш chat id: ${chatId}`);
        continue;
      }

      // обрабатываем сообщения последовательно, чтобы не путать сессию агента
      await handleMessage(query, chatId, msg.text);
    }
  }
}

main().catch((err) => {
  console.error('Фатальная ошибка бота:', err?.message || err);
  process.exit(1);
});
