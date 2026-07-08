// lib/telegram.js — минимальный клиент Telegram Bot API на голом fetch.
//
// Без внешних зависимостей (как lib/mpstats.js). Достаточно для бота-калькулятора:
// long-poll getUpdates, sendMessage (HTML), sendDocument (PDF-отчёт), answerCallbackQuery.
// Токен — из TELEGRAM_BOT_TOKEN (получить у @BotFather).

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API = 'https://api.telegram.org';

export class TelegramBot {
  constructor(token) {
    this.token = token || process.env.TELEGRAM_BOT_TOKEN;
    if (!this.token) throw new Error('TELEGRAM_BOT_TOKEN не задан (получить у @BotFather)');
    this.offset = 0;
  }

  async call(method, payload = {}, { timeoutMs = 65000 } = {}) {
    const resp = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description || resp.status}`);
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  /** Кто мы (проверка токена). */
  getMe() { return this.call('getMe', {}, { timeoutMs: 15000 }); }

  /**
   * Long-poll новых апдейтов. Держит соединение до `timeout` секунд.
   * Автоматически сдвигает offset, чтобы не получать одно и то же дважды.
   */
  async getUpdates(timeout = 50) {
    const updates = await this.call('getUpdates', {
      offset: this.offset,
      timeout,
      allowed_updates: ['message', 'callback_query'],
    }, { timeoutMs: (timeout + 15) * 1000 });
    if (updates.length) this.offset = updates[updates.length - 1].update_id + 1;
    return updates;
  }

  sendMessage(chatId, text, { keyboard, parseMode } = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  }

  answerCallbackQuery(id, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  /** Отправить файл (PDF-отчёт) как документ. Multipart через FormData/Blob. */
  async sendDocument(chatId, filePath, { caption } = {}) {
    const buf = await readFile(filePath);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption);
    form.set('document', new Blob([buf], { type: 'application/pdf' }), basename(filePath));
    const resp = await fetch(`${API}/bot${this.token}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description || resp.status}`);
    return data.result;
  }
}

export default TelegramBot;
