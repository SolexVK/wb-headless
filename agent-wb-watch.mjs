// agent-wb-watch.mjs — сторож удержаний Wildberries.
//
// Раз в запуск: выгружает свежую детализацию, расследует каждую проблемную
// строку, собирает PDF и отправляет итог в Telegram. Если проблем нет —
// присылает короткое «всё в порядке», чтобы молчание нельзя было спутать
// с поломкой сторожа.
//
//   node agent-wb-watch.mjs                    # обычный запуск (по расписанию)
//   node agent-wb-watch.mjs --dry-run          # без отправки: печатает сообщение
//   node agent-wb-watch.mjs --cache            # из локального кэша, без API
//   node agent-wb-watch.mjs --window 5         # окно проверки, дней (по умолч. 3)
//   node agent-wb-watch.mjs --label "утренняя"
//
// Переменные окружения:
//   WB_API_TOKEN / Wildberries_API   — токен WB (категории «Финансы», «Аналитика»,
//                                      «Статистика», «Маркетплейс»)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT — те же, что у бота проекта
//   WATCH_WINDOW_DAYS (3), WATCH_BASELINE_DAYS (30), WATCH_STATE_FILE
//
// Лимиты WB соблюдаются клиентом lib/wbClient.js: у финансовых методов —
// 1 запрос в минуту, поэтому запуск занимает несколько минут. Это нормально.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './lib/wbClient.js';
import { resolveWbToken } from './lib/wbToken.js';
import { buildFindings } from './lib/watchRules.js';
import { buildMessage } from './lib/watchMessage.js';
import { logisticsHtml, finesHtml } from './lib/forensicsHtml.js';
import { analyzePrevious } from './lib/forensics.js';
import { htmlToPdf } from './lib/renderPdf.js';
import { sendMessage, sendDocument, telegramConfig } from './lib/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'reports-output');
const STATE_FILE = process.env.WATCH_STATE_FILE || path.join(__dirname, 'state', 'wb-watch-state.json');
const CACHE_FILE = path.join(OUT_DIR, 'watch-cache.json');
const M1 = { limit: 1, periodSec: 60, burst: 1 };

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** Сегодня по Москве: отчёты WB и расписание живут в МСК (UTC+3). */
const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function fetchDetailed(client, dateFrom, dateTo) {
  const rows = [];
  let rrdId = 0;
  for (let page = 1; page <= 10; page++) {
    const { status, data } = await client.request('finance', '/api/finance/v1/sales-reports/detailed', {
      method: 'POST', body: { dateFrom, dateTo, limit: 100000, rrdId, period: 'daily' }, methodLimit: M1,
    });
    const batch = status === 204 || !Array.isArray(data) ? [] : data;
    rows.push(...batch);
    if (!batch.length || batch.length < 100000) break;
    const next = Number(batch[batch.length - 1].rrdId);
    if (!next || next === rrdId) break;
    rrdId = next;
  }
  return rows;
}

/** Сбор всех источников. Сбой одного не должен ронять проверку целиком. */
export async function collect({ d1, d2, baselineDays }) {
  const client = new WbClient({ timeoutMs: 180000 });
  const errors = [];
  const safe = async (label, fn, fallback = []) => {
    try { return await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); return fallback; }
  };

  const rows = await safe('детализация', () => fetchDetailed(client, d1, d2));
  const baselineRows = await safe('база сравнения', () => fetchDetailed(client, shift(d1, -baselineDays), shift(d1, -1)));
  const returns = await safe('возвраты', async () => {
    const { data } = await client.get('analytics', '/api/v1/analytics/goods-return', {
      query: { dateFrom: shift(d2, -30), dateTo: d2 }, methodLimit: M1,
    });
    return data?.report || data || [];
  });
  const orders = await safe('заказы', async () =>
    (await client.get('statistics', '/api/v1/supplier/orders', { query: { dateFrom: `${shift(d1, -10)}T00:00:00`, flag: 0 }, methodLimit: M1 })).data || []);
  const warehouses = await safe('склады', async () => (await client.get('marketplace', '/api/v3/warehouses')).data || []);
  const fbsOrders = await safe('сборочные задания', async () => {
    const out = []; let next = 0;
    for (let i = 0; i < 20; i++) {
      const { data } = await client.get('marketplace', '/api/v3/orders', {
        query: { limit: 1000, next, dateFrom: Math.floor(new Date(`${shift(d1, -10)}T00:00:00Z`).getTime() / 1000) },
      });
      const batch = data?.orders || [];
      out.push(...batch);
      if (!batch.length || data.next == null || data.next === next) break;
      next = data.next;
    }
    return out;
  });

  const cache = { period: { d1, d2 }, collectedAt: new Date().toISOString(), rows, baselineRows, returns, orders, warehouses, fbsOrders, errors };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  return cache;
}

/** PDF-приложения: собираем только когда есть что расследовать. */
function buildAttachments({ result, cache, period }) {
  const files = [];
  const meta = { seller: 'продавец', financeRows: cache.rows.length, currency: result.summary.currency };
  const prev = { ...analyzePrevious(cache.baselineRows), label: 'база сравнения' };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = (name) => path.join(OUT_DIR, `${name}-${period.d1}_${period.d2}`);
  try {
    if (result.fines.total !== 0) {
      const html = finesHtml({ fines: result.fines, prev, period, meta });
      fs.writeFileSync(`${base('watch-fines')}.html`, html);
      files.push(htmlToPdf(html, `${base('watch-fines')}.pdf`));
    }
    if (result.log.total !== 0) {
      const html = logisticsHtml({ log: result.log, prev, period, meta, weekly: [] });
      fs.writeFileSync(`${base('watch-logistics')}.html`, html);
      files.push(htmlToPdf(html, `${base('watch-logistics')}.pdf`));
    }
  } catch (err) {
    process.stderr.write(`PDF не собран: ${err.message}\n`);
  }
  return files;
}

export async function run(opts = {}) {
  const windowDays = Number(opts.window || arg('window', process.env.WATCH_WINDOW_DAYS || 3));
  const baselineDays = Number(process.env.WATCH_BASELINE_DAYS || 30);
  const d2 = opts.d2 || arg('to', mskToday());
  const d1 = opts.d1 || arg('from', shift(d2, -(windowDays - 1)));
  const period = { d1, d2 };
  const label = opts.label || arg('label', new Date(Date.now() + 3 * 3600e3).getUTCHours() < 12 ? 'Утренняя' : 'Вечерняя');
  const dryRun = opts.dryRun ?? has('dry-run');
  const useCache = opts.cache ?? has('cache');

  if (!useCache && !resolveWbToken().token) throw new Error('Не найден токен WB (WB_API_TOKEN / Wildberries_API)');

  const cache = useCache ? loadJson(CACHE_FILE) : await collect({ d1, d2, baselineDays });
  if (!cache) throw new Error(`Кэш не найден: ${CACHE_FILE}`);

  const thresholds = loadJson(path.join(__dirname, 'config', 'watch-thresholds.json'), {});
  const state = loadJson(STATE_FILE, { seen: {}, runs: [] });

  const result = buildFindings({
    rows: cache.rows, baselineRows: cache.baselineRows, returns: cache.returns,
    orders: cache.orders, fbsOrders: cache.fbsOrders, warehouses: cache.warehouses,
    thresholds, state,
  });

  const attachments = result.severity === 'ok' ? [] : buildAttachments({ result, cache, period });
  const nextRun = /утр/i.test(label) ? 'сегодня в 18:00 МСК' : 'завтра в 07:00 МСК';
  const text = buildMessage({
    severity: result.severity, findings: result.findings, summary: result.summary,
    period, runLabel: label, nextRun, hasReport: attachments.length > 0, errors: cache.errors || [],
  });

  let delivery = { sent: 0, errors: ['dry-run: не отправляли'] };
  if (!dryRun) {
    const cfg = telegramConfig();
    if (!cfg.ready) {
      delivery = { sent: 0, errors: ['Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT)'] };
    } else {
      delivery = await sendMessage(text);
      for (const file of attachments) {
        const r = await sendDocument(file, { caption: `Расследование ${period.d1}–${period.d2}` });
        delivery.errors.push(...r.errors);
      }
    }
  }

  // Состояние: помним, о чём уже сообщали, чтобы вечером не повторять «новое».
  const now = new Date().toISOString();
  for (const f of result.findings) state.seen[f.key] = state.seen[f.key] || now;
  state.runs = [...(state.runs || []).slice(-19), { at: now, label, period, severity: result.severity, findings: result.findings.length }];
  state.lastRun = { at: now, severity: result.severity, findings: result.findings.length };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  }

  return { result, text, attachments, delivery, period };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(({ result, text, attachments, delivery }) => {
      console.log('─'.repeat(60));
      console.log(text.replace(/<[^>]+>/g, ''));
      console.log('─'.repeat(60));
      console.log(`Вердикт: ${result.severity}, находок: ${result.findings.length}, файлов: ${attachments.length}`);
      if (delivery.errors.length) console.log('Доставка:', delivery.errors.join('; '));
      else console.log(`Отправлено сообщений: ${delivery.sent}`);
      // Проблемы — не ошибка запуска: код 0, чтобы расписание не считало прогон упавшим.
    })
    .catch((err) => { console.error('Сторож упал:', err?.message || err); process.exit(1); });
}
