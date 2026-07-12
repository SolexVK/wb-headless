// telegram-bot.js — мост Telegram ↔ Claude Agent.
//
// Ставьте задачи по проекту прямо из Telegram: сообщения уходят в Claude Agent
// SDK (движок Claude Code — доступ к файлам репозитория, git, командам), ответ
// приходит в чат. Связь с Telegram — long polling (getUpdates), публичный URL
// не нужен. Запуск: `npm run bot`.
//
// Возможности: очередь задач, таймаут, graceful shutdown, персистентная сессия,
// прогресс в реальном времени, лимит расходов, подтверждение опасных действий
// кнопками, git-шорткаты, приём/отдача файлов, несколько проектов и пользователей,
// голосовые сообщения (при настроенном STT).
//
// Переменные окружения — см. .env.example / TELEGRAM.md.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------- 0.2 Автозагрузка .env (без внешних зависимостей) ----------
function loadDotenv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotenv(path.join(SCRIPT_DIR, '.env'));

// ---------- 2.4 проекты ----------
const WORKDIR_DEFAULT = process.env.BOT_WORKDIR || SCRIPT_DIR;
function parseProjects() {
  const map = {};
  for (const pair of (process.env.BOT_PROJECTS || '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    const dir = pair.slice(idx + 1).trim();
    if (name && dir) map[name] = dir;
  }
  if (Object.keys(map).length === 0) map.default = WORKDIR_DEFAULT;
  return map;
}
const PROJECTS = parseProjects();

// ---------- конфигурация ----------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// 2.5 несколько пользователей (список chat id), обратная совместимость с одиночным
function parseAllowed(str) {
  return new Set(String(str || '').split(',').map((s) => s.trim()).filter(Boolean));
}
const ALLOWED = parseAllowed(process.env.TELEGRAM_ALLOWED_CHATS || process.env.TELEGRAM_ALLOWED_CHAT || '');
const MODEL_DEFAULT = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const MODE_DEFAULT = process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits';
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 600000;
const DAILY_COST_LIMIT = Number(process.env.DAILY_COST_LIMIT) || 0;
const STATE_FILE = process.env.BOT_STATE_FILE || path.join(SCRIPT_DIR, '.bot-state.json');
const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
const TG_MSG_LIMIT = 4096;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function allowed(chatId) { return ALLOWED.has(String(chatId)); }

// ---------- 3.3 логирование в файл (опционально, с ротацией по размеру) ----------
function setupLogging() {
  const file = process.env.BOT_LOG_FILE;
  if (!file) return;
  const max = Number(process.env.BOT_LOG_MAX) || 5 * 1024 * 1024;
  const write = (level, args) => {
    const line = `[${new Date().toISOString()}] ${level} ` +
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    try {
      try { if (fs.statSync(file).size > max) fs.renameSync(file, file + '.1'); } catch (_) {}
      fs.appendFileSync(file, line);
    } catch (_) {}
  };
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { origLog(...a); write('INFO', a); };
  console.error = (...a) => { origErr(...a); write('ERROR', a); };
}

// ---------- проверка окружения ----------
function envMissing() {
  const m = [];
  if (!TG_TOKEN) m.push('TELEGRAM_BOT_TOKEN');
  if (ALLOWED.size === 0) m.push('TELEGRAM_ALLOWED_CHAT(S)');
  if (!process.env.ANTHROPIC_API_KEY) m.push('ANTHROPIC_API_KEY');
  return m;
}
function requireEnv() {
  const missing = envMissing();
  if (missing.length) {
    console.error(
      'Не заданы переменные окружения: ' + missing.join(', ') +
      '\nСкопируйте .env.example в .env и впишите значения (см. TELEGRAM.md).'
    );
    process.exit(1);
  }
}

// ---------- 0.5 Персистентность состояния ----------
let state = loadState();
let model = state.model || MODEL_DEFAULT;
let permissionMode = state.permissionMode || MODE_DEFAULT;
let project = (state.project && PROJECTS[state.project]) ? state.project : Object.keys(PROJECTS)[0];
let workdir = PROJECTS[project];
state.sessions = state.sessions || {};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { console.error('Не удалось сохранить состояние:', err?.message || err); }
}
// 2.5 сессии на каждый чат — контексты пользователей не смешиваются
function getSession(chatId) { return state.sessions[chatId] || null; }
function setSession(chatId, id) {
  if (id && state.sessions[chatId] !== id) { state.sessions[chatId] = id; saveState(); }
}
function resetSession(chatId) { delete state.sessions[chatId]; saveState(); }

// ---------- 1.5 учёт расходов по дням ----------
function today() { return new Date().toISOString().slice(0, 10); }
function costToday() { return state.costDate === today() ? (state.costToday || 0) : 0; }
function addCost(usd) {
  if (!usd || typeof usd !== 'number') return;
  const d = today();
  if (state.costDate !== d) { state.costDate = d; state.costToday = 0; }
  state.costToday = (state.costToday || 0) + usd;
  saveState();
}
function limitReached() { return DAILY_COST_LIMIT > 0 && costToday() >= DAILY_COST_LIMIT; }

// ---------- Claude Agent SDK ----------
async function loadAgent() {
  try { return (await import('@anthropic-ai/claude-agent-sdk')).query; }
  catch (err) {
    console.error(
      'Не найден пакет @anthropic-ai/claude-agent-sdk.\n' +
      'Установите зависимости: npm install\nИсходная ошибка: ' + (err?.message || err)
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
    e.code = data.error_code;
    throw e;
  }
  return data.result;
}

function chunk(text) {
  const chunks = [];
  let rest = String(text || '').trim() || '(пустой ответ)';
  while (rest.length > TG_MSG_LIMIT) {
    let cut = rest.lastIndexOf('\n', TG_MSG_LIMIT);
    if (cut < TG_MSG_LIMIT * 0.5) cut = TG_MSG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

async function sendMessage(chatId, text, extra) {
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const payload = { chat_id: chatId, text: parts[i] };
    if (extra && i === parts.length - 1) Object.assign(payload, extra); // клавиатуру — к последней части
    try { await tg('sendMessage', payload); }
    catch (err) { console.error('sendMessage:', err?.message || err); }
  }
}

// 1.4 ответ агента с HTML-форматированием и откатом в простой текст
async function sendResult(chatId, text) {
  const html = toHtml(text);
  if (html.length <= TG_MSG_LIMIT) {
    try { await tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' }); return; }
    catch (err) { console.error('HTML send failed, откат в текст:', err?.message || err); }
  }
  await sendMessage(chatId, text);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function toHtml(md) {
  const parts = String(md || '').split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const code = parts[i].replace(/^([A-Za-z0-9_+-]*)\n/, '');
      out += '<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>';
    } else {
      let seg = escapeHtml(parts[i]);
      seg = seg.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
      seg = seg.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      seg = seg.replace(/__([^_]+)__/g, '<b>$1</b>');
      out += seg;
    }
  }
  return out;
}

async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); }
  catch (_) {}
}

// 2.3 отправка файла из рабочей папки в чат (с защитой от выхода за пределы)
async function sendDocument(chatId, relPath) {
  const root = path.resolve(workdir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return sendMessage(chatId, 'Путь вне рабочей папки.');
  }
  let buf;
  try { buf = fs.readFileSync(abs); }
  catch (_) { return sendMessage(chatId, 'Файл не найден: ' + relPath); }
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([buf]), path.basename(abs));
    const res = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: form });
    const data = await res.json();
    if (!data.ok) sendMessage(chatId, 'Не удалось отправить файл: ' + (data.description || res.status));
  } catch (err) { sendMessage(chatId, 'Ошибка отправки файла: ' + (err?.message || err)); }
}

// скачать файл Telegram по file_id → Buffer
async function downloadTgFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${f.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('download ' + res.status);
  return { buf: Buffer.from(await res.arrayBuffer()), tgPath: f.file_path };
}

// 2.3 приём документа: сохраняем в рабочую папку
async function receiveDocument(chatId, doc) {
  try {
    const { buf, tgPath } = await downloadTgFile(doc.file_id);
    const name = path.basename(doc.file_name || tgPath || 'file');
    fs.writeFileSync(path.join(workdir, name), buf);
    sendMessage(chatId, `Файл сохранён: ${name} (${buf.length} байт). Сошлитесь на него в задаче.`);
  } catch (err) { sendMessage(chatId, 'Не удалось принять файл: ' + (err?.message || err)); }
}

// 2.6 голос → текст (через OpenAI-совместимый STT-эндпоинт, если настроен)
async function transcribe(buf, filename) {
  if (!process.env.STT_API_URL) return null;
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);
  form.append('model', process.env.STT_MODEL || 'whisper-1');
  const headers = process.env.STT_API_KEY ? { Authorization: `Bearer ${process.env.STT_API_KEY}` } : {};
  const res = await fetch(process.env.STT_API_URL, { method: 'POST', headers, body: form });
  const data = await res.json().catch(() => ({}));
  return data.text || null;
}
async function handleVoice(chatId, voice) {
  if (!process.env.STT_API_URL) {
    sendMessage(chatId, 'Распознавание голоса не настроено. Задайте STT_API_URL (OpenAI-совместимый /audio/transcriptions) и STT_API_KEY.');
    return;
  }
  try {
    const { buf } = await downloadTgFile(voice.file_id);
    const text = await transcribe(buf, 'voice.oga');
    if (!text) { sendMessage(chatId, 'Не удалось распознать голос.'); return; }
    sendMessage(chatId, `🎙 Распознано: ${text}`);
    dispatch(chatId, text);
  } catch (err) { sendMessage(chatId, 'Ошибка распознавания: ' + (err?.message || err)); }
}

// ---------- 2.2 git-шорткаты ----------
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: workdir, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}
async function gitDiff(chatId) {
  const stat = await git(['diff', '--stat']);
  const full = await git(['diff']);
  const body = (stat.out || 'нет изменений') + (full.out ? '\n\n' + full.out : '');
  await sendResult(chatId, '```\n' + body + '\n```');
}
async function gitPush(chatId) {
  const r = await git(['push']);
  await sendMessage(chatId, r.out || (r.code === 0 ? 'push выполнен.' : 'push завершился с ошибкой.'));
}
async function gitCommit(chatId, msg) {
  const add = await git(['add', '-A']);
  if (add.code !== 0) { await sendMessage(chatId, 'git add: ' + add.out); return; }
  const r = await git(['commit', '-m', msg]);
  await sendMessage(chatId, r.out || (r.code === 0 ? 'commit создан.' : 'commit не выполнен.'));
}

// ---------- 0.1 Очередь задач + воркер ----------
const queue = [];
let wake = null;
let busy = false;
let currentAbort = null;
let activeChatId = null; // чат текущей задачи (для подтверждений 2.1)
let shuttingDown = false;

function enqueue(item) {
  queue.push(item);
  if (wake) { const w = wake; wake = null; w(); }
}
function waitForItem() { return new Promise((resolve) => { wake = resolve; }); }

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

// ---------- 2.1 подтверждение опасных действий кнопками ----------
let confirmSeq = 0;
let pendingConfirm = null; // { id, resolve }

function canUseTool(toolName, input, { signal }) {
  const id = String(++confirmSeq);
  const hint = summarizeTool({ name: toolName, input });
  const kb = {
    inline_keyboard: [[
      { text: '✅ Разрешить', callback_data: `a:${id}` },
      { text: '⛔ Запретить', callback_data: `d:${id}` },
    ]],
  };
  sendMessage(activeChatId, `Разрешить действие?\n${hint}`, { reply_markup: kb });
  return new Promise((resolve) => {
    pendingConfirm = { id, resolve };
    signal.addEventListener('abort', () => {
      if (pendingConfirm && pendingConfirm.id === id) {
        pendingConfirm = null;
        resolve({ behavior: 'deny', message: 'Отменено.' });
      }
    }, { once: true });
  });
}

function resolveConfirm(id, allow) {
  if (!pendingConfirm || pendingConfirm.id !== id) return false;
  const { resolve } = pendingConfirm;
  pendingConfirm = null;
  if (allow) resolve({ behavior: 'allow' });
  else resolve({ behavior: 'deny', message: 'Запрещено пользователем.' });
  return true;
}

// ---------- выполнение задачи ----------
async function processTask(query, { chatId, text }) {
  const abort = new AbortController();
  currentAbort = abort;
  activeChatId = chatId;
  const timeout = setTimeout(() => abort.abort('timeout'), AGENT_TIMEOUT_MS);
  sendTyping(chatId);
  const typing = setInterval(() => sendTyping(chatId), 5000);
  try {
    const { text: answer, cost } = await runAgent(query, text, abort, chatId);
    addCost(cost);
    await sendResult(chatId, answer);
  } catch (err) {
    if (abort.signal.aborted) {
      const reason = abort.signal.reason;
      if (reason === 'timeout') await sendMessage(chatId, `Задача прервана по таймауту (${Math.round(AGENT_TIMEOUT_MS / 1000)}с).`);
      else if (reason === 'user') await sendMessage(chatId, 'Задача остановлена.');
      else if (reason === 'shutdown') console.log('Задача прервана из-за остановки бота.');
      else await sendMessage(chatId, 'Задача прервана.');
    } else {
      await sendMessage(chatId, 'Ошибка: ' + (err?.message || String(err)));
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(typing);
    currentAbort = null;
    activeChatId = null;
  }
}

function summarizeTool(b) {
  const name = b.name || 'tool';
  const inp = b.input || {};
  let hint = inp.file_path || inp.path || inp.pattern || inp.command || inp.url || inp.query || '';
  if (typeof hint !== 'string') hint = '';
  hint = hint.replace(/\s+/g, ' ').trim();
  if (hint.length > 120) hint = hint.slice(0, 117) + '…';
  return `🔧 ${name}${hint ? ': ' + hint : ''}`;
}

async function runAgent(query, prompt, abort, chatId) {
  let finalText = '';
  let cost = 0;
  const options = {
    cwd: workdir,
    model,
    permissionMode,
    abortController: abort,
    canUseTool, // 2.1 — вызывается SDK, когда инструменту нужно подтверждение
  };
  if (permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
  const resume = getSession(chatId);
  if (resume) options.resume = resume;

  for await (const message of query({ prompt, options })) {
    if (message.type === 'system' && message.subtype === 'init') {
      setSession(chatId, message.session_id);
    } else if (message.type === 'assistant') {
      for (const b of (message.message?.content || [])) {
        if (b && b.type === 'tool_use') sendMessage(chatId, summarizeTool(b));
      }
    } else if (message.type === 'result') {
      if (typeof message.total_cost_usd === 'number') cost = message.total_cost_usd;
      if (typeof message.result === 'string') finalText = message.result;
      else if (message.is_error) {
        const errs = Array.isArray(message.errors) ? message.errors.join('\n') : '';
        finalText = 'Агент завершился с ошибкой' +
          (message.subtype ? ` (${message.subtype})` : '') + (errs ? ':\n' + errs : '.');
      }
    }
  }
  return { text: finalText, cost };
}

// ---------- команды ----------
const HELP = [
  'Я — мост в Claude Agent. Пишите задачу текстом — выполню в проекте и пришлю результат.',
  '',
  'Команды:',
  '/start, /help — справка',
  '/status — очередь, модель, режим, проект, расходы',
  '/stop — остановить текущую задачу и очистить очередь',
  '/reset — новый диалог (сброс контекста сессии)',
  '/model [id] — показать/сменить модель',
  '/mode [' + MODES.join('|') + '] — показать/сменить режим прав',
  '/project [name] — показать/сменить проект',
  '/diff — показать git diff',
  '/commit [сообщение] — закоммитить (без сообщения — агент придумает сам)',
  '/push — git push',
  '/send <путь> — прислать файл из рабочей папки',
  '',
  'Можно прислать файл (сохраню в проект) или голосовое (распознаю, если настроен STT).',
  'В режиме прав default опасные действия подтверждаются кнопками.',
].join('\n');

function statusText(chatId) {
  const lines = [
    `Занят: ${busy ? 'да' : 'нет'}`,
    `В очереди: ${queue.length}`,
    `Проект: ${project} (${workdir})`,
    `Модель: ${model}`,
    `Режим прав: ${permissionMode}`,
    `Сессия: ${getSession(chatId) || 'нет'}`,
  ];
  lines.push(`Потрачено сегодня: $${costToday().toFixed(2)}${DAILY_COST_LIMIT ? ` из $${DAILY_COST_LIMIT}` : ''}`);
  return lines.join('\n');
}

function dispatch(chatId, text) {
  const t = text.trim();

  if (t === '/start' || t === '/help') { sendMessage(chatId, HELP); return; }
  if (t === '/status') { sendMessage(chatId, statusText(chatId)); return; }

  if (t === '/reset') {
    resetSession(chatId);
    sendMessage(chatId, 'Контекст сброшен. Начинаем новый диалог.');
    return;
  }

  if (t === '/stop') {
    const queued = queue.length;
    queue.length = 0;
    if (currentAbort) {
      currentAbort.abort('user');
      sendMessage(chatId, `Останавливаю текущую задачу.${queued ? ` Очередь очищена (${queued}).` : ''}`);
    } else {
      sendMessage(chatId, queued ? `Очередь очищена (${queued}). Активной задачи нет.` : 'Активной задачи нет.');
    }
    return;
  }

  if (t === '/model' || t.startsWith('/model ')) {
    const arg = t.slice(6).trim();
    if (!arg) { sendMessage(chatId, `Текущая модель: ${model}\nСменить: /model <id>`); return; }
    model = arg; state.model = arg; saveState();
    sendMessage(chatId, `Модель: ${model}`);
    return;
  }

  if (t === '/mode' || t.startsWith('/mode ')) {
    const arg = t.slice(5).trim();
    if (!arg) { sendMessage(chatId, `Текущий режим прав: ${permissionMode}\nСменить: /mode ${MODES.join('|')}`); return; }
    if (!MODES.includes(arg)) { sendMessage(chatId, `Неизвестный режим. Допустимо: ${MODES.join(', ')}`); return; }
    permissionMode = arg; state.permissionMode = arg; saveState();
    sendMessage(chatId, `Режим прав: ${permissionMode}`);
    return;
  }

  if (t === '/project' || t.startsWith('/project ')) { // 2.4
    const arg = t.slice(9).trim();
    const names = Object.keys(PROJECTS);
    if (!arg) { sendMessage(chatId, `Текущий проект: ${project} (${workdir})\nДоступно: ${names.join(', ')}\nСменить: /project <name>`); return; }
    if (!PROJECTS[arg]) { sendMessage(chatId, `Нет проекта «${arg}». Доступно: ${names.join(', ')}`); return; }
    project = arg; workdir = PROJECTS[arg]; state.project = arg; saveState();
    resetSession(chatId); // контекст сессии привязан к папке
    sendMessage(chatId, `Проект: ${project} (${workdir}). Контекст сброшен.`);
    return;
  }

  if (t === '/diff') { gitDiff(chatId); return; } // 2.2
  if (t === '/push') { gitPush(chatId); return; }
  if (t === '/commit' || t.startsWith('/commit ')) {
    const msg = t.slice(7).trim();
    if (msg) { gitCommit(chatId, msg); return; }
    // без сообщения — поручаем агенту осмысленный коммит
    text = 'Просмотри незакоммиченные изменения (git diff/status) и сделай git commit с осмысленным сообщением на русском. Не делай push.';
  } else if (t === '/send' || t.startsWith('/send ')) { // 2.3
    const rel = t.slice(5).trim();
    if (!rel) sendMessage(chatId, 'Укажите путь: /send <файл>');
    else sendDocument(chatId, rel);
    return;
  }

  // обычный текст → задача
  if (limitReached()) {
    sendMessage(chatId, `Дневной лимит расходов исчерпан: $${costToday().toFixed(2)} из $${DAILY_COST_LIMIT}. Сбросится завтра или увеличьте DAILY_COST_LIMIT.`);
    return;
  }
  const ahead = queue.length + (busy ? 1 : 0);
  enqueue({ chatId, text: text.trim() });
  if (ahead > 0) sendMessage(chatId, `Задача принята, впереди в очереди: ${ahead}.`);
}

// ---------- цикл опроса Telegram ----------
const pollAbort = new AbortController();

async function poll() {
  let offset = 0;
  try {
    const backlog = await tg('getUpdates', { offset: -1, timeout: 0 });
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
  } catch (_) {}

  while (!shuttingDown) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 30 }, pollAbort.signal);
    } catch (err) {
      if (err.aborted) return;
      if (err.code === 409) {
        console.error('Конфликт 409: запущен другой экземпляр бота или установлен webhook. Останавливаюсь.');
        shutdown('conflict');
        return;
      }
      console.error('getUpdates:', err?.message || err);
      await sleep(3000);
      continue;
    }

    for (const upd of updates) {
      offset = upd.update_id + 1;
      try { handleUpdate(upd); }
      catch (err) { console.error('handleUpdate:', err?.message || err); }
    }
  }
}

function handleUpdate(upd) {
  // 2.1 нажатия кнопок подтверждения
  if (upd.callback_query) {
    const cq = upd.callback_query;
    const chatId = String(cq.message?.chat?.id || '');
    tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (!allowed(chatId)) return;
    const [act, id] = String(cq.data || '').split(':');
    const ok = resolveConfirm(id, act === 'a');
    const verdict = act === 'a' ? '✅ разрешено' : '⛔ запрещено';
    tg('editMessageText', {
      chat_id: chatId, message_id: cq.message.message_id,
      text: (cq.message.text || 'Подтверждение') + '\n' + (ok ? verdict : '(уже обработано)'),
    }).catch(() => {});
    return;
  }

  const msg = upd.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  if (!allowed(chatId)) {
    sendMessage(chatId, `Доступ запрещён. Ваш chat id: ${chatId}`);
    return;
  }
  if (msg.text) dispatch(chatId, msg.text);
  else if (msg.document) receiveDocument(chatId, msg.document);
  else if (msg.voice) handleVoice(chatId, msg.voice);
}

// ---------- 0.4 Graceful shutdown ----------
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nЗавершение работы (${reason})...`);
  pollAbort.abort();
  if (wake) { const w = wake; wake = null; w(); }
  if (currentAbort) { console.log('Прерываю текущую задачу...'); currentAbort.abort('shutdown'); }
  saveState();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- 3.2 режим webhook (альтернатива polling) ----------
async function registerWebhook() {
  const secret = process.env.BOT_WEBHOOK_SECRET || '';
  if (process.env.BOT_WEBHOOK_URL) {
    const payload = { url: process.env.BOT_WEBHOOK_URL, allowed_updates: ['message', 'callback_query'] };
    if (secret) payload.secret_token = secret;
    await tg('setWebhook', payload);
    console.log('Webhook зарегистрирован в Telegram:', process.env.BOT_WEBHOOK_URL);
  }
}
function webhookRequestGuard(req) {
  const secret = process.env.BOT_WEBHOOK_SECRET || '';
  return !secret || req.headers['x-telegram-bot-api-secret-token'] === secret;
}

// Самостоятельный webhook-сервер (BOT_MODE=webhook): свой HTTP-порт.
async function startWebhook(query) {
  const port = Number(process.env.BOT_WEBHOOK_PORT) || 8081;
  const pathName = process.env.BOT_WEBHOOK_PATH || '/telegram/webhook';
  await registerWebhook();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== pathName) { res.writeHead(404); res.end(); return; }
    if (!webhookRequestGuard(req)) { res.writeHead(401); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end();
      try { handleUpdate(JSON.parse(body)); } catch (e) { console.error('webhook parse:', e.message); }
    });
  });
  server.listen(port, () => console.log(`Webhook-сервер слушает :${port}${pathName}`));
  await worker(query);
}

// Встраивание webhook в существующий Express-app (server.js). Не завершает процесс.
export async function registerExpressWebhook(app) {
  const missing = envMissing();
  if (missing.length) { console.error('Telegram webhook не смонтирован — нет: ' + missing.join(', ')); return; }
  setupLogging();
  const query = await loadAgent();
  const pathName = process.env.BOT_WEBHOOK_PATH || '/telegram/webhook';
  app.post(pathName, (req, res) => {
    if (!webhookRequestGuard(req)) { res.status(401).end(); return; }
    res.status(200).end();
    try { handleUpdate(req.body); } catch (e) { console.error('webhook:', e.message); }
  });
  await registerWebhook();
  worker(query); // фоновый воркер (не await)
  console.log('Telegram webhook смонтирован в Express на', pathName);
}

// ---------- запуск ----------
async function main() {
  setupLogging();
  requireEnv();
  const query = await loadAgent();
  const me = await tg('getMe', {});
  const mode = (process.env.BOT_MODE || 'polling').toLowerCase();
  console.log(`Бот @${me.username} запущен (${mode}).`);
  console.log(`Проект: ${project} (${workdir})`);
  console.log(`Разрешённые chat id: ${[...ALLOWED].join(', ')}`);
  console.log(`Модель: ${model} | режим: ${permissionMode} | таймаут: ${Math.round(AGENT_TIMEOUT_MS / 1000)}с`);
  if (DAILY_COST_LIMIT) console.log(`Дневной лимит: $${DAILY_COST_LIMIT} (потрачено $${costToday().toFixed(2)})`);

  if (mode === 'webhook') await startWebhook(query);
  else await Promise.all([poll(), worker(query)]);
}

if (IS_MAIN) {
  main().catch((err) => { console.error('Фатальная ошибка бота:', err?.message || err); process.exit(1); });
}

export { toHtml, escapeHtml, chunk, summarizeTool, loadDotenv, parseProjects, parseAllowed };
