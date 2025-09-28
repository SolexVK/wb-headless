// server.js — полная версия без page.waitForTimeout, с поддержкой фреймов и OTP

import express from 'express';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ----- конфиг -----
const API_KEY = process.env.API_KEY || 'supersecret';
const PORT = process.env.PORT || 8080;
const WB_AUTH_URL = 'https://seller-auth.wildberries.ru/ru/';

// Render-хром (ставим в build: `npx @puppeteer/browsers install chrome@stable --cache-dir=./.cache/puppeteer`)
function findLocalChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const base = path.resolve(process.cwd(), 'chrome');
    if (!fs.existsSync(base)) return null;
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('linux-'));
    // берём максимальную версию
    dirs.sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* noop */ }
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
      '--window-size=1280,900'
    ],
    defaultViewport: { width: 1280, height: 900 }
  };
  if (chromePath) opts.executablePath = chromePath;
  const browser = await puppeteer.launch(opts);
  return { browser, chromePath: chromePath || 'bundled Chromium' };
}

// ----- утилиты -----
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D+/g, '');
  // берём последние 10 цифр
  const tail = digits.slice(-10);
  if (tail.length !== 10) return null;
  return tail;
}

// Ищем элемент по набору селекторов во всех фреймах страницы
async function findFirst(page, selectors, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frames = page.frames();
    for (const sel of selectors) {
      for (const f of frames) {
        const h = await f.$(sel);
        if (h) return { frame: f, handle: h, selector: sel };
      }
    }
    await sleep(250);
  }
  return null;
}

async function typeSlow(handle, text, delay = 50) {
  // Фокус на элемент
  await handle.focus();
  // Очищаем поле (на всякий случай)
  await handle.click({ clickCount: 3 });
  await handle.press('Backspace');
  for (const ch of String(text)) {
    await handle.type(ch, { delay });
  }
}

async function pressEnter(handle) {
  await handle.press('Enter');
}

// ----- хранилище сессий -----
const sessions = new Map(); // sessionId -> { browser, page }
import { v4 as uuidv4 } from 'uuid';

// ----- health/debug -----
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/debug-chrome', requireKey, (req, res) => {
  const chromePath = findLocalChrome();
  res.json({
    cwd: process.cwd(),
    chromePath: chromePath || null,
    exists: !!chromePath
  });
});

// ----- START: ввод телефона -----
app.post('/start', requireKey, async (req, res) => {
  try {
    const phoneRaw = req.body?.phone;
    const localPart = normalizePhone(phoneRaw);
    if (!localPart) return res.status(400).json({ error: 'bad_phone' });

    const { browser, chromePath } = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(WB_AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // ищем поле телефона — главная страница или фрейм
    const phoneSelectors = [
      'input[type="tel"]',
      'input[name*="phone"]',
      'input[autocomplete="tel"]',
      'input.input__phone' // на случай кастомного класса
    ];
    const phone = await findFirst(page, phoneSelectors, { timeout: 45000 });
    if (!phone) {
      await browser.close();
      return res.status(500).json({ error: 'start_failed', detail: 'Не найдено поле ввода телефона (во всех фреймах).' });
    }

    await typeSlow(phone.handle, localPart, 60);
    await pressEnter(phone.handle);

    // ждём появления OTP (6 инпутов или одно поле для кода)
    const otpSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[name*="code"]',
      'input[type="tel"][maxlength="1"]', // набор из 6 ячеек
      'input[data-qa*="otp"]'
    ];
    const otp = await findFirst(page, otpSelectors, { timeout: 60000 });
    if (!otp) {
      // иногда WB рисует экран, но не пускает — дайте странице договорить загрузку
      await sleep(2000);
    }

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });

    return res.json({
      ok: true,
      status: 'waiting_sms',
      sessionId,
      debug: { chrome: chromePath, localPart }
    });
  } catch (err) {
    console.error('START error:', err);
    return res.status(500).json({ error: 'start_failed', detail: String(err?.message || err) });
  }
});

// ----- VERIFY: ввод СМС и возврат cookies -----
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, code } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session_not_found' });

  const { browser, page } = sess;
  try {
    const codeStr = String(code || '').replace(/\D+/g, '');
    if (codeStr.length !== 6) return res.status(400).json({ error: 'bad_code' });

    // ищем OTP-поля во всех фреймах
    const singleFieldSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[name*="code"]'
    ];
    const multiFieldSelector = 'input[type="tel"][maxlength="1"]';

    let filled = false;

    // Вариант 1: одно поле
    const single = await findFirst(page, singleFieldSelectors, { timeout: 10000 });
    if (single) {
      await typeSlow(single.handle, codeStr, 80);
      filled = true;
    } else {
      // Вариант 2: шесть ячеек
      // Собираем сразу все 6 во всех фреймах
      const frames = page.frames();
      let inputs = [];
      for (const f of frames) {
        const hs = await f.$$(multiFieldSelector);
        if (hs && hs.length) inputs = inputs.concat(hs);
      }
      if (inputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await typeSlow(inputs[i], codeStr[i], 80);
        }
        filled = true;
      }
    }

    if (!filled) {
      return res.status(500).json({ error: 'verify_failed', detail: 'Не удалось найти поля ввода SMS-кода.' });
    }

    // ждём перехода в ЛК/подтверждения
    // Либо ждём network idle, либо небольшой «дыхательный» интервал
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
    console.error('VERIFY error:', err);
    try { await browser.close(); } catch (_) {}
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: String(err?.message || err) });
  }
});

app.listen(PORT, () => console.log('WB headless listening on', PORT));
