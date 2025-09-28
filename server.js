// server.js — фикс явного пути к Chrome + авторизация на seller-auth
import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.API_KEY || 'supersecret';
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const WB_AUTH_URL = 'https://seller-auth.wildberries.ru/ru/';
const WB_HOME_URL = 'https://seller.wildberries.ru/';
const PUPP_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--window-size=1280,900',
];

// ———————————————————————
// 1) Находим chrome, установленный build:chrome
// ———————————————————————
function findLocalChrome() {
  // то, куда кладёт build:chrome
  const baseDir = path.join(__dirname, 'chrome');
  if (!fs.existsSync(baseDir)) return null;

  // ищем chrome/*/*/chrome
  const candidates = [];
  for (const v of fs.readdirSync(baseDir)) {
    const p1 = path.join(baseDir, v);
    try {
      const inner = fs.readdirSync(p1);
      for (const d of inner) {
        // linux-<ver>
        const bin1 = path.join(p1, d, 'chrome-linux64', 'chrome');
        const bin2 = path.join(p1, d, 'chrome-linux64', 'chrome.exe'); // на всякий
        if (fs.existsSync(bin1)) candidates.push(bin1);
        if (fs.existsSync(bin2)) candidates.push(bin2);
      }
    } catch {}
  }
  return candidates[0] || null;
}

function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// вспомогательно: посмотреть, какой путь к Chrome найден
app.get('/debug-chrome', requireKey, (req, res) => {
  const chromePath = findLocalChrome();
  res.json({
    cwd: process.cwd(),
    chromePath,
    exists: !!(chromePath && fs.existsSync(chromePath))
  });
});

const sessions = new Map();
let sharedCookieJar = [];

async function withCDPSetCookies(page, cookies = []) {
  if (!cookies.length) return;
  const client = await page.target().createCDPSession();
  for (const c of cookies) {
    try {
      await client.send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: c.domain || '.wildberries.ru',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expires: c.expires ? Math.floor(+c.expires / 1000) : undefined,
        sameSite: c.sameSite || 'Lax'
      });
    } catch {}
  }
}

// ———————————————————————
//  START: вводим телефон на seller-auth
// ———————————————————————
app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  const tail = (phone || '').replace(/[^\d]/g, '').replace(/^7/, '');
  if (!tail || tail.length < 8) {
    return res.status(400).json({ error: 'bad_phone', detail: 'Передай phone, напр. +79261234567' });
  }

  let browser;
  try {
    const chromePath = findLocalChrome();
    if (!chromePath) throw new Error('Chrome не найден (build не положил браузер в ./chrome).');

    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      args: PUPP_ARGS,
      executablePath: chromePath
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(WB_AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const phoneSelectors = [
      'input[inputmode="tel"]',
      'input[type="tel"]',
      'input[name*="phone"]',
      'input[data-test*="phone"]',
      'input[placeholder*="999 999-99-99"]'
    ];

    const findPhoneField = async () => {
      for (const sel of phoneSelectors) {
        const el = await page.$(sel);
        if (el) return { handle: el, frame: page };
      }
      for (const f of page.frames()) {
        for (const sel of phoneSelectors) {
          const el = await f.$(sel);
          if (el) return { handle: el, frame: f };
        }
      }
      return null;
    };

    let phoneField = null;
    const tStart = Date.now();
    while (!phoneField && Date.now() - tStart < 30000) {
      phoneField = await findPhoneField();
      if (!phoneField) await page.waitForTimeout(500);
    }
    if (!phoneField) throw new Error('Не найдено поле ввода телефона (во всех фреймах).');

    await phoneField.frame.evaluate(el => { el.value = ''; }, phoneField.handle);
    await phoneField.handle.type(tail, { delay: 50 });
    await phoneField.frame.keyboard.press('Enter');

    // ждём появления экрана ввода кода
    const codeSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[type="tel"][maxlength="1"]'
    ];
    const waitCodeScreen = async () => {
      const ok1 = await page.$(codeSelectors[0]);
      if (ok1) return true;
      const many = await page.$$(codeSelectors[1]);
      if (many && many.length >= 4) return true;
      for (const f of page.frames()) {
        const el1 = await f.$(codeSelectors[0]);
        if (el1) return true;
        const els = await f.$$(codeSelectors[1]);
        if (els && els.length >= 4) return true;
      }
      return false;
    };

    let codeReady = await waitCodeScreen();
    const t0 = Date.now();
    while (!codeReady && Date.now() - t0 < 30000) {
      await page.waitForTimeout(500);
      codeReady = await waitCodeScreen();
    }
    if (!codeReady) throw new Error('После ввода телефона не появился экран ввода СМС-кода.');

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });
    return res.json({ ok: true, sessionId });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: 'start_failed', detail: e.message });
  }
});

// ———————————————————————
//  VERIFY: вводим 6-значный код, ждём входа, отдаём куки
// ———————————————————————
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  if (!sessionId || !smsCode) return res.status(400).json({ error: 'bad_request' });

  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session_not_found' });

  const { browser, page } = sess;

  try {
    const code = String(smsCode).replace(/[^\d]/g, '');
    if (code.length < 4) throw new Error('Код слишком короткий');

    const locateCodeFields = async () => {
      let single = await page.$('input[autocomplete="one-time-code"]');
      if (single) return { type: 'single', frame: page, el: single, list: [] };
      let multi = await page.$$('input[type="tel"][maxlength="1"]');
      if (multi && multi.length >= 4) return { type: 'multi', frame: page, el: null, list: multi };
      for (const f of page.frames()) {
        single = await f.$('input[autocomplete="one-time-code"]');
        if (single) return { type: 'single', frame: f, el: single, list: [] };
        multi = await f.$$('input[type="tel"][maxlength="1"]');
        if (multi && multi.length >= 4) return { type: 'multi', frame: f, el: null, list: multi };
      }
      return null;
    };

    let fields = await locateCodeFields();
    const t = Date.now();
    while (!fields && Date.now() - t < 15000) {
      await page.waitForTimeout(300);
      fields = await locateCodeFields();
    }
    if (!fields) throw new Error('Поле(я) ввода кода не найдены.');

    if (fields.type === 'single') {
      await fields.el.focus();
      await fields.frame.keyboard.type(code, { delay: 80 });
    } else {
      const chars = code.split('');
      for (let i = 0; i < fields.list.length && i < chars.length; i++) {
        await fields.list[i].focus();
        await fields.frame.keyboard.type(chars[i], { delay: 60 });
      }
    }

    const redirectOk = await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).then(() => true).catch(() => false),
      (async () => {
        for (let i = 0; i < 40; i++) {
          if (page.url().startsWith(WB_HOME_URL)) return true;
          await page.waitForTimeout(500);
        }
        return false;
      })()
    ]);

    if (!redirectOk) {
      await page.goto(WB_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(1200);

    const allCookies = [];
    const pages = await browser.pages();
    for (const p of pages) {
      try { allCookies.push(...await p.cookies()); } catch {}
    }
    const uniq = [];
    const seen = new Set();
    for (const c of allCookies) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (!seen.has(key)) { seen.add(key); uniq.push(c); }
    }

    await browser.close().catch(() => {});
    sessions.delete(sessionId);
    sharedCookieJar = uniq;

    return res.json({ ok: true, cookies: uniq });

  } catch (e) {
    await browser.close().catch(() => {});
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: e.message });
  }
});

// (оставил /set-cookies и /spp как у тебя — без изменений, при необходимости добавим executablePath и туда)

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('WB headless listening on', PORT));
