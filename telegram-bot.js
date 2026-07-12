// telegram-bot.js — мост Telegram ↔ Claude Agent.
//
// Позволяет ставить задачи по проекту прямо из Telegram-чата: ваши сообщения
// уходят в Claude Agent SDK (тот же движок, что и Claude Code — с доступом к
// файлам репозитория, git и командам), а ответ приходит обратно в чат.
//
// Режим связи с Telegram — long polling (getUpdates): бот сам опрашивает
// Telegram, публичный URL/веб-хук не нужен. Запустил `npm run bot` — работает.
//
// Архитектура (Tier 0): опрос Telegram и выполнение задач расцеплены —
// это два независимых цикла (poll + worker). Пока агент работает над задачей,
// бот продолжает принимать сообщения; задачи ставятся в очередь.
//
// Переменные окружения (см. .env.example / TELEGRAM.md):
//   TELEGRAM_BOT_TOKEN      — токен бота от @BotFather (обязательно)
//   TELEGRAM_ALLOWED_CHAT   — ваш chat id; только он может писать боту (обязательно)
//   ANTHROPIC_API_KEY       — ключ Claude API для движка агента (обязательно)
//   CLAUDE_MODEL            — модель (по умолчанию claude-opus-4-8)
//   CLAUDE_PERMISSION_MODE  — режим прав агента (по умолчанию acceptEdits)
//   BOT_WORKDIR             — рабочая папка агента (по умолчанию папка проекта)
//   AGENT_TIMEOUT_MS        — таймаут одной задачи, мс (по умолчанию 600000 = 10 мин)
//   BOT_STATE_FILE          — файл состояния (по умолчанию .bot-state.json рядом)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- 0.2 Автозагрузка .env (без внешних зависимостей) ----------
function loadDotenv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; } // .env необязателен
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue; // комментарии и пустые строки пропускаем
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val; // реальное окружение приоритетнее
  }
}
loadDotenv(path.join(SCRIPT_DIR, '.env'));

// ---------- конфигурация ----------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT = String(process.env.TELEGRAM_ALLOWED_CHAT || '').trim();
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits';
const WORKDIR = process.env.BOT_WORKDIR || SCRIPT_DIR;
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 600000;
const STATE_FILE = process.env.BOT_STATE_FILE || path.join(SCRIPT_DIR, '.bot-state.json');

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const TG_MSG_LIMIT = 4096; // лимит длины сообщения в Telegram

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- проверка окружения ----------
function requireEnv() {
  const missing = [];
  if (!TG_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!ALLOWED_CHAT) missing.push('TELEGRAM_ALLOWED_CHAT');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    console.error(
      'Не заданы переменные окружения: ' + missing.join(', ') +
      '\nСкопируйте .env.example в .env и впишите значения (см. TELEGRAM.md).'
    );
    process.exit(1);
  }
}

// ---------- 0.5 Персистентность состояния (сессия переживает рестарт) ----------
let state = loadState();
let sessionId = state.sessionId || null;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { console.error('Не удалось сохранить состояние:', err?.message || err); }
}
function setSession(id) {
  if (id && id !== sessionId) { sessionId = id; state.sessionId = id; saveState(); }
}

// ---------- Claude Agent SDK (грузим динамически ради понятной ошибки) ----------
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
async function tg(method, payload, signal) {
  let res;
  try {
    res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') { const e = new Error('aborted'); e.aborted = true; throw e; }
    throw err;
  }
  const data = await res.json();
  if (!data.ok) {
    const e = new Error(`Telegram ${method}: ${data.description || res.status}`);
    e.code = data.error_code; // 0.6: пробрасываем код (409 и др.)
    throw e;
  }
  return data.result;
}

async function sendMessage(chatId, text) {
  const chunks = [];
  let rest = String(text || '').trim() || '(пустой ответ)';
  while (rest.length > TG_MSG_LIMIT) {
    let cut = rest.lastIndexOf('\n', TG_MSG_LIMIT);
    if (cut < TG_MSG_LIMIT * 0.5) cut = TG_MSG_LIMIT; // не режем слишком коротко
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    try { await tg('sendMessage', { chat_id: chatId, text: chunk }); }
    catch (err) { console.error('sendMessage:', err?.message || err); }
  }
}

async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); }
  catch (_) { /* не критично */ }
}

// ---------- 0.1 Очередь задач + воркер (расцеплены с опросом) ----------
const queue = [];
let wake = null;          // резолвер «в очереди появилась задача»
let busy = false;         // выполняется ли задача прямо сейчас
let currentAbort = null;  // AbortController текущей задачи (для таймаута/остановки)
let shuttingDown = false;

function enqueue(item) {
  queue.push(item);
  if (wake) { const w = wake; wake = null; w(); }
}
function waitForItem() {
  return new Promise((resolve) => { wake = resolve; });
}

async function worker(query) {
  while (!shuttingDown) {
    if (queue.length === 0) await waitForItem();
    if (shuttingDown) break;
    const item = queue.shift();
    if (!item) continue;
    busy = true;
    try { await processTask(query, item); }
    catch (err) { console.error('processTask:', err?.message || err); }
    finally { busy = false; }
  }
}

// ---------- выполнение одной задачи в Claude Agent ----------
async function processTask(query, { chatId, text }) {
  const abort = new AbortController();
  currentAbort = abort;
  // 0.3 таймаут задачи
  const timeout = setTimeout(() => abort.abort('timeout'), AGENT_TIMEOUT_MS);
  // фоновый индикатор «печатает…»
  sendTyping(chatId);
  const typing = setInterval(() => sendTyping(chatId), 5000);
  try {
    const answer = await runAgent(query, text, abort);
    await sendMessage(chatId, answer);
  } catch (err) {
    if (abort.signal.aborted) {
      const reason = abort.signal.reason;
      if (reason === 'timeout') {
        await sendMessage(chatId, `Задача прервана по таймауту (${Math.round(AGENT_TIMEOUT_MS / 1000)}с).`);
      } else if (reason === 'shutdown') {
        // бот выключается — сообщать поздно, просто логируем
        console.log('Задача прервана из-за остановки бота.');
      } else {
        await sendMessage(chatId, 'Задача прервана.');
      }
    } else {
      await sendMessage(chatId, 'Ошибка: ' + (err?.message || String(err)));
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(typing);
    currentAbort = null;
  }
}

async function runAgent(query, prompt, abort) {
  let finalText = '';
  const options = {
    cwd: WORKDIR,
    model: MODEL,
    permissionMode: PERMISSION_MODE,
    abortController: abort,
  };
  if (PERMISSION_MODE === 'bypassPermissions') {
    options.allowDangerouslySkipPermissions = true; // требование SDK
  }
  if (sessionId) options.resume = sessionId; // продолжаем диалог

  for await (const message of query({ prompt, options })) {
    if (message.type === 'system' && message.subtype === 'init') {
      setSession(message.session_id);
    } else if (message.type === 'result') {
      if (typeof message.result === 'string') {
        finalText = message.result;
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

// ---------- команды и маршрутизация входящих ----------
const HELP = [
  'Я — мост в Claude Agent для проекта wb-headless.',
  'Просто пишите задачу текстом — я выполню её в репозитории и пришлю результат.',
  '',
  'Команды:',
  '/start — приветствие',
  '/reset — начать новый диалог (сбросить контекст сессии)',
  '/help — эта справка',
  '',
  'Пока идёт одна задача, новые становятся в очередь.',
].join('\n');

function dispatch(chatId, text) {
  const t = text.trim();

  if (t === '/start' || t === '/help') { sendMessage(chatId, HELP); return; }
  if (t === '/reset') {
    setSession(null); sessionId = null; state.sessionId = null; saveState();
    sendMessage(chatId, 'Контекст сброшен. Начинаем новый диалог.');
    return;
  }

  const ahead = queue.length + (busy ? 1 : 0);
  enqueue({ chatId, text: t });
  if (ahead > 0) sendMessage(chatId, `Задача принята, впереди в очереди: ${ahead}.`);
}

// ---------- 0.1/0.6 цикл опроса Telegram ----------
const pollAbort = new AbortController();

async function poll() {
  let offset = 0;
  // сбрасываем «зависшие» апдейты, накопившиеся до запуска
  try {
    const backlog = await tg('getUpdates', { offset: -1, timeout: 0 });
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
  } catch (_) {}

  while (!shuttingDown) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 30 }, pollAbort.signal);
    } catch (err) {
      if (err.aborted) return; // штатная остановка
      if (err.code === 409) {
        console.error(
          'Конфликт 409: запущен другой экземпляр бота или установлен webhook.\n' +
          'Оставьте только один экземпляр (или удалите webhook: deleteWebhook). Останавливаюсь.'
        );
        shutdown('conflict');
        return;
      }
      console.error('getUpdates:', err?.message || err);
      await sleep(3000);
      continue;
    }

    for (const upd of updates) {
      offset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg || !msg.text) continue;

      const chatId = String(msg.chat.id);
      if (chatId !== ALLOWED_CHAT) {
        // не наш чат — подсказываем chat id (удобно при первичной настройке)
        sendMessage(chatId, `Доступ запрещён. Ваш chat id: ${chatId}`);
        continue;
      }
      dispatch(chatId, msg.text);
    }
  }
}

// ---------- 0.4 Graceful shutdown ----------
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nЗавершение работы (${reason})...`);
  pollAbort.abort();                 // прервать текущий long-poll
  if (wake) { const w = wake; wake = null; w(); } // разбудить воркер
  if (currentAbort) {
    console.log('Прерываю текущую задачу...');
    currentAbort.abort('shutdown');
  }
  saveState();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- запуск ----------
async function main() {
  requireEnv();
  const query = await loadAgent();

  const me = await tg('getMe', {}); // проверка токена + имя бота
  console.log(`Бот @${me.username} запущен (long polling).`);
  console.log(`Рабочая папка агента: ${WORKDIR}`);
  console.log(`Разрешённый chat id: ${ALLOWED_CHAT}`);
  console.log(`Таймаут задачи: ${Math.round(AGENT_TIMEOUT_MS / 1000)}с`);
  if (sessionId) console.log(`Восстановлена сессия: ${sessionId}`);

  await Promise.all([poll(), worker(query)]);
}

main().catch((err) => {
  console.error('Фатальная ошибка бота:', err?.message || err);
  process.exit(1);
});
