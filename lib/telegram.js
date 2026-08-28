// lib/telegram.js — отправка уведомлений в Telegram (текст + файлы).
//
// Имена переменных совпадают с уже настроенным ботом проекта
// (ветка claude/telegram-chat-o45oqz), поэтому один и тот же .env работает
// и для бота, и для сторожа удержаний:
//   TELEGRAM_BOT_TOKEN   — токен от @BotFather
//   TELEGRAM_ALLOWED_CHAT (или TELEGRAM_ALLOWED_CHATS, или TELEGRAM_CHAT_ID)
//                        — куда слать; при списке шлём в каждый чат
//
// Особенности Telegram, которые здесь учтены:
//   • лимит 4096 символов на сообщение — режем по границе строк;
//   • 429 приходит с retry_after (секунды) — ждём ровно столько;
//   • parse_mode=HTML требует экранирования &, <, > в тексте;
//   • sendDocument — multipart, лимит 50 МБ на файл.

import fs from 'fs';
import path from 'path';

const MSG_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const raw = process.env.TELEGRAM_ALLOWED_CHATS || process.env.TELEGRAM_ALLOWED_CHAT || process.env.TELEGRAM_CHAT_ID || '';
  const chats = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return { token, chats, ready: Boolean(token && chats.length) };
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Режем длинный текст по переводам строк, чтобы не рвать разметку посередине. */
export function chunkText(text, limit = MSG_LIMIT) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out.length ? out : ['(пустое сообщение)'];
}

async function call(token, method, payload, { retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    let data;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });
      data = await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(2000 * 2 ** attempt);
      attempt += 1;
      continue;
    }
    if (data.ok) return data.result;
    // 429: Telegram сам сообщает, сколько ждать.
    const wait = data.parameters?.retry_after;
    if (wait && attempt < retries) {
      await sleep((wait + 1) * 1000);
      attempt += 1;
      continue;
    }
    const e = new Error(`Telegram ${method}: ${data.description || 'ошибка'}`);
    e.code = data.error_code;
    throw e;
  }
}

/**
 * Отправляет текст (HTML) во все настроенные чаты.
 * @returns {Promise<{sent:number, errors:string[]}>}
 */
export async function sendMessage(text, { silent = false, config = telegramConfig() } = {}) {
  if (!config.ready) throw new Error('Telegram не настроен: нужны TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT');
  const parts = chunkText(text);
  const errors = [];
  let sent = 0;
  for (const chat of config.chats) {
    for (const part of parts) {
      try {
        await call(config.token, 'sendMessage', {
          chat_id: chat, text: part, parse_mode: 'HTML',
          disable_web_page_preview: true, disable_notification: silent,
        });
        sent += 1;
      } catch (err) {
        // Откат в простой текст: чаще всего причина — незакрытый HTML-тег.
        try {
          await call(config.token, 'sendMessage', { chat_id: chat, text: part.replace(/<[^>]+>/g, '') });
          sent += 1;
        } catch (err2) {
          errors.push(`${chat}: ${err2.message}`);
        }
      }
    }
  }
  return { sent, errors };
}

/** Отправляет файл во все чаты. caption — HTML, до 1024 символов. */
export async function sendDocument(filePath, { caption = '', config = telegramConfig() } = {}) {
  if (!config.ready) throw new Error('Telegram не настроен: нужны TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT');
  const buf = fs.readFileSync(filePath);
  const errors = [];
  let sent = 0;
  for (const chat of config.chats) {
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('document', new Blob([buf]), path.basename(filePath));
    if (caption) {
      form.append('caption', caption.slice(0, CAPTION_LIMIT));
      form.append('parse_mode', 'HTML');
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.token}/sendDocument`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(120000),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
      sent += 1;
    } catch (err) {
      errors.push(`${chat}: ${err.message}`);
    }
  }
  return { sent, errors };
}

export { MSG_LIMIT, CAPTION_LIMIT };
