// server.js — вход в WB с поддержкой Shadow-DOM и contenteditable

import express from 'express';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import { buildStockAvailabilityReport, reportToCSV } from './lib/stockReport.js';
import { defaultPeriod, loadItems, selectItems, selectByGroup, writeOutputs, runReport } from './report-stock.js';
import { openDb, closeDb, stats as dbStats } from './lib/db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.API_KEY || 'supersecret';
const PORT = process.env.PORT || 8080;
const WB_AUTH_URL = 'https://seller-auth.wildberries.ru/ru/';

// MPStats API: токен берём из окружения (.env), в код/git не хардкодим
const MPSTATS_TOKEN = process.env.MPSTATS_TOKEN || '';
const MPSTATS_BASE = (process.env.MPSTATS_BASE || 'https://mpstats.io/api').replace(/\/+$/, '');

// ---------- helpers ----------
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D+/g, '');
  const tail = digits.slice(-10);
  return tail.length === 10 ? tail : null;
}

function findLocalChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const base = path.resolve(process.cwd(), 'chrome');
    if (!fs.existsSync(base)) return null;
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('linux-')).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return null;
}

async function launchBrowser() {
  const chromePath = findLocalChrome();
  const opts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900'
    ],
    defaultViewport: { width: 1280, height: 900 }
  };
  if (chromePath) opts.executablePath = chromePath;
  const browser = await puppeteer.launch(opts);
  return { browser, chromePath: chromePath || 'bundled Chromium' };
}

async function preparePage(page) {
  // реальный UA, убираем webdriver
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  await page.setUserAgent(ua);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

// ищем элемент во всех фреймах; поддерживаем обычные и pierce/ селекторы для Shadow-DOM
async function findFirst(page, selectors, { timeout = 30000 } = {}) {
  const end = Date.now() + timeout;
  const selAll = [
    ...selectors,
    ...selectors.map(s => (s.startsWith('pierce/') ? s : `pierce/${s}`))
  ];
  while (Date.now() < end) {
    for (const frame of page.frames()) {
      for (const s of selAll) {
        try {
          const handle = await frame.$(s);
          if (handle) return { frame, handle, selector: s };
        } catch (_) {}
      }
    }
    await sleep(250);
  }
  return null;
}

async function typeSlowInto(page, handle, text, delay = 60) {
  // определим тип узла
  const tag = (await (await handle.getProperty('tagName')).jsonValue?.()) || '';
  const isCE = await (await handle.getProperty('isContentEditable')).jsonValue?.();

  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    await handle.focus();
    await handle.click({ clickCount: 3 });
    await handle.press('Backspace');
    await handle.type(text, { delay });
  } else if (isCE) {
    await handle.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text, { delay });
  } else {
    // как fallback: кликаем и печатаем в активный элемент
    await handle.click();
    await page.keyboard.type(text, { delay });
  }
}

// ---------- storage ----------
const sessions = new Map(); // sessionId -> { browser, page }

// ---------- health & debug ----------
app.get('/health', (req, res) => {
  let db = null;
  try {
    db = openDb();
    return res.json({ ok: true, uptime: process.uptime(), db: dbStats(db) });
  } catch (err) {
    return res.json({ ok: true, uptime: process.uptime(), db: { error: String(err?.message || err) } });
  } finally {
    if (db) closeDb(db);
  }
});
app.get('/debug-chrome', requireKey, (req, res) => {
  const chromePath = findLocalChrome();
  res.json({ cwd: process.cwd(), chromePath: chromePath || null, exists: !!chromePath });
});

// ---------- MPStats proxy ----------
// Универсальный шлюз: клиент дергает /mpstats/<путь MPStats>, сервер сам
// подставляет заголовок X-Mpstats-TOKEN и проксирует запрос на MPSTATS_BASE.
// Примеры:
//   GET  /mpstats/wb/get/category?path=...&d1=2024-01-01&d2=2024-01-31
//   POST /mpstats/wb/get/category            (JSON-тело уходит как есть)
app.all('/mpstats/*', requireKey, async (req, res) => {
  if (!MPSTATS_TOKEN) {
    return res.status(500).json({
      error: 'mpstats_token_missing',
      detail: 'Не задан MPSTATS_TOKEN. Впишите токен в .env и перезапустите сервер.'
    });
  }

  // всё после "/mpstats/" (включая query-строку) — как есть, без потери кодировки
  const rest = req.originalUrl.replace(/^\/mpstats\/?/, '');
  const target = `${MPSTATS_BASE}/${rest}`;

  try {
    const method = req.method.toUpperCase();
    const headers = {
      'X-Mpstats-TOKEN': MPSTATS_TOKEN,
      'Accept': 'application/json'
    };
    let body;
    if (method !== 'GET' && method !== 'HEAD' && req.body && Object.keys(req.body).length) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    const upstream = await fetch(target, { method, headers, body });
    const text = await upstream.text();
    const ct = upstream.headers.get('content-type') || 'application/json';
    return res.status(upstream.status).type(ct).send(text);
  } catch (err) {
    return res.status(502).json({ error: 'mpstats_request_failed', detail: String(err?.message || err) });
  }
});

// ---------- REPORT: наличие товара и упущенная выручка ----------
// GET /reports/stock-availability?d1=YYYY-MM-DD&d2=YYYY-MM-DD&format=json|csv&filter=РМП
// Без d1/d2 берётся период = последние REPORT_DAYS (по умолчанию 30) дней.
// filter — по артикулу продавца/WB, через запятую; пусто = все товары.
app.get('/reports/stock-availability', requireKey, async (req, res) => {
  try {
    if (!process.env.MPSTATS_TOKEN) {
      return res.status(500).json({ error: 'mpstats_token_missing' });
    }
    let { d1, d2, format, filter, group } = req.query;
    if (!d1 || !d2) ({ d1, d2 } = defaultPeriod(Number(process.env.REPORT_DAYS) || 30));

    // Приоритет: точечный фильтр → группа → все.
    const all = loadItems();
    const items = filter && String(filter).trim()
      ? selectItems(all, filter)
      : selectByGroup(all, group);
    const report = await buildStockAvailabilityReport({
      items,
      d1,
      d2,
      concurrency: Number(process.env.REPORT_CONCURRENCY) || 5,
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="stock-${d1}_${d2}.csv"`
      );
      return res.send(reportToCSV(report));
    }
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: 'report_failed', detail: String(err?.message || err) });
  }
});

// ---------- START ----------
app.post('/start', requireKey, async (req, res) => {
  const phoneRaw = req.body?.phone;
  const localPart = normalizePhone(phoneRaw);
  if (!localPart) return res.status(400).json({ error: 'bad_phone' });

  let browser;
  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    const page = await browser.newPage();
    await preparePage(page);

    // иногда редиректят с seller на auth — идём сразу на auth
    await page.goto(WB_AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // набор селекторов для поля телефона (включая Shadow-DOM/контейнеры)
    const phoneSelectors = [
      'input[type="tel"]',
      'input[name*="phone" i]',
      'input[autocomplete="tel"]',
      'input[inputmode="numeric"]',
      'input[placeholder*="999" i]',
      'div[contenteditable="true"]',
      '[role="textbox"]'
    ];

    const found = await findFirst(page, phoneSelectors, { timeout: 45000 });
    if (!found) {
      await browser.close();
      return res.status(500).json({
        error: 'start_failed',
        detail: 'Не найдено поле ввода телефона (во всех фреймах, включая Shadow-DOM).'
      });
    }

    await typeSlowInto(page, found.handle, localPart, 60);
    await page.keyboard.press('Enter');

    // ждём появления полей для кода (одно поле либо 6 ячеек)
    const otpSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[name*="code" i]',
      'input[type="tel"][maxlength="1"]',
      '[data-qa*="otp"]',
      'div[contenteditable="true"][data-qa*="otp"]'
    ];
    const otp = await findFirst(page, otpSelectors, { timeout: 60000 });
    if (!otp) {
      // контент иногда «догружается»
      await sleep(2000);
    }

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });

    return res.json({
      ok: true,
      status: 'waiting_sms',
      sessionId
    });
  } catch (err) {
    if (browser) try { await browser.close(); } catch (_) {}
    return res.status(500).json({ error: 'start_failed', detail: String(err?.message || err) });
  }
});

// ---------- VERIFY ----------
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, code } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session_not_found' });

  const { browser, page } = sess;
  try {
    const codeStr = String(code || '').replace(/\D+/g, '');
    if (codeStr.length !== 6) return res.status(400).json({ error: 'bad_code' });

    // 1 поле
    const single = await findFirst(page, [
      'input[autocomplete="one-time-code"]',
      'input[name*="code" i]'
    ], { timeout: 10000 });

    if (single) {
      await typeSlowInto(page, single.handle, codeStr, 80);
    } else {
      // 6 ячеек
      const frames = page.frames();
      let inputs = [];
      for (const f of frames) {
        const hs = await f.$$('input[type="tel"][maxlength="1"]');
        if (hs?.length) inputs = inputs.concat(hs);
      }
      if (inputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await typeSlowInto(page, inputs[i], codeStr[i], 80);
        }
      } else {
        return res.status(500).json({ error: 'verify_failed', detail: 'Поля ввода кода не найдены.' });
      }
    }

    // ждём подтверждение/редирект
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (_) {
      await sleep(1500);
    }

    const cookies = await page.cookies();
    await browser.close();
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (err) {
    try { await browser.close(); } catch (_) {}
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: String(err?.message || err) });
  }
});

// ---------- ПЛАНИРОВЩИК регулярного отчёта ----------
// Включается через REPORT_SCHEDULE_ENABLED=1. Раз в сутки в REPORT_SCHEDULE_HOUR
// (UTC, по умолчанию 6:00) строит отчёт и сохраняет CSV/JSON в reports-output/.
// Лёгкая реализация без внешних зависимостей: проверяем время раз в минуту.
function startReportScheduler() {
  if (process.env.REPORT_SCHEDULE_ENABLED !== '1') return;
  const hour = Number(process.env.REPORT_SCHEDULE_HOUR ?? 6);
  let lastRunDay = null;

  setInterval(async () => {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== hour || lastRunDay === dayKey) return;
    lastRunDay = dayKey;

    if (!process.env.MPSTATS_TOKEN) {
      console.warn('[scheduler] MPSTATS_TOKEN не задан — отчёт пропущен');
      return;
    }
    try {
      const { d1, d2 } = defaultPeriod(Number(process.env.REPORT_DAYS) || 30);
      console.log(`[scheduler] строю отчёт по наличию за ${d1}…${d2}`);
      // runReport сам применит REPORT_FILTER/REPORT_GROUP и запишет данные в БД.
      const report = await runReport({ d1, d2 });
      const { csvPath } = writeOutputs(report);
      console.log(
        `[scheduler] готово: упущено ≈ ${report.totals.lostRevenue} ₽, файл ${csvPath}`
      );
    } catch (err) {
      console.error('[scheduler] ошибка отчёта:', err?.message || err);
    }
  }, 60 * 1000);

  console.log(`Планировщик отчёта включён: ежедневно в ${hour}:00 UTC`);
}

app.listen(PORT, () => {
  console.log('WB headless listening on', PORT);
  startReportScheduler();
});
