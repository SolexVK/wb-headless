// server.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// ----------- utils -----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** Ищем бинарник Chrome: сначала env, потом типовые каталоги */
function findChrome() {
  const envPath = process.env.CHROME_PATH;
  if (envPath && exists(envPath)) return envPath;

  // кандидаты (Render + наш билд-скрипт)
  const candidates = [
    path.join(__dirname, 'chrome'), // если кто-то вручную положит
    path.join(__dirname, 'chrome', 'linux-stable', 'chrome'),
    path.join(__dirname, '.cache', 'puppeteer', 'chrome'), // старый cache-dir
  ];

  // разворачиваем папки-корни: внутри ищем *chrome*/chrome
  for (const base of candidates) {
    if (!exists(base)) continue;

    // 1) прямой бинарник
    if (base.endsWith('chrome') && exists(base)) return base;

    // 2) ищем глубже: linux-xxx/chrome
    try {
      const sub = fs.readdirSync(base);
      for (const s of sub) {
        const p = path.join(base, s);
        // версия
        if (fs.lstatSync(p).isDirectory()) {
          const linux = path.join(p, 'chrome-linux64', 'chrome');
          const linuxAlt = path.join(p, 'linux-stable', 'chrome');
          const justChrome = path.join(p, 'chrome');
          if (exists(linux)) return linux;
          if (exists(linuxAlt)) return linuxAlt;
          if (exists(justChrome)) return justChrome;
        }
      }
    } catch {}
  }

  // частый путь из логов Render, если «попали в точку»
  // (обновится автоматически при новой установке — не критично если не существует)
  const guess = '/opt/render/project/src/chrome/linux-stable/chrome';
  if (exists(guess)) return guess;

  return null;
}

function ppLaunchOpts() {
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('Chrome binary not found. Check build step and CHROME_PATH.');
  }
  return {
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,900',
    ],
  };
}

// простой «кей» для API
const API_KEY = process.env.API_KEY || 'supersecret';
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// сессии для подтверждения SMS
const sessions = new Map(); // sessionId -> { browser, pageOrFrame }

// ----------- health & debug -----------
app.get('/', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/debug-chrome', requireKey, (req, res) => {
  const p = findChrome();
  res.json({ cwd: process.cwd(), chromePath: p, exists: !!p && exists(p) });
});

// ----------- авторизация: шаг 1 — отправка кода -----------
app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  let browser;
  try {
    browser = await puppeteer.launch(ppLaunchOpts());
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1) открываем ЛК
    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // иногда первая загрузка тяжёлая — дадим сети устаканиться
    await sleep(1200);

    // 2) пробуем найти форму ввода телефона
    // форма может быть либо сразу в DOM, либо в iframe
    const telSel = [
      'input[type="tel"]',
      'input[inputmode="tel"]',
      'input[name*="phone"]',
      'input[placeholder*="тел"]',
      'input[placeholder*="Тел"]',
      'input[aria-label*="тел"]',
    ].join(',');

    /** Возвращает { ctx, frame } где ctx - страница или фрейм, в котором есть инпут */
    async function findPhoneContext() {
      // 2.1 в основной странице
      const found = await page.$(telSel);
      if (found) return { ctx: page, frame: null };

      // 2.2 в iframe
      const targetFrame = page.frames().find(f => /auth|login|signin/i.test(f.url()));
      if (targetFrame) {
        const inFrame = await targetFrame.$(telSel);
        if (inFrame) return { ctx: targetFrame, frame: targetFrame };
      }

      // 2.3 попробуем кликнуть «Войти»/«Вход», чтобы появилась форма
      const loginBtnSel = [
        'a[href*="login"]',
        'a[href*="auth"]',
        'button:has-text("Войти")',
        'button:has-text("Вход")',
        '[data-qa*="login"]',
      ].join(',');

      try {
        const loginBtn = await page.$(loginBtnSel);
        if (loginBtn) {
          await loginBtn.click().catch(() => {});
          await sleep(800);
        }
      } catch {}
      // снова ищем
      const again = await page.$(telSel);
      if (again) return { ctx: page, frame: null };

      // ещё раз проверим фрейм после клика
      const f2 = page.frames().find(f => /auth|login|signin/i.test(f.url()));
      if (f2) {
        const inFrame2 = await f2.$(telSel);
        if (inFrame2) return { ctx: f2, frame: f2 };
      }
      return null;
    }

    const ctxInfo = await findPhoneContext();
    if (!ctxInfo) {
      return res.status(500).json({
        error: 'start_failed',
        detail: 'Не удалось найти поле ввода телефона (в DOM или iframe).',
      });
    }

    const ctx = ctxInfo.ctx;

    // 3) вводим телефон
    const telInput = await ctx.$(telSel);
    if (!telInput) {
      return res.status(500).json({
        error: 'start_failed',
        detail: 'Поле телефона не найдено после определения контекста.',
      });
    }
    await telInput.click({ clickCount: 3 }).catch(() => {});
    await telInput.type(phone, { delay: 50 });

    // 4) ищем кнопку «Получить код/Отправить» и кликаем
    const sendBtnSel = [
      'button[type="submit"]',
      'button:has-text("получить")',
      'button:has-text("Получить")',
      'button:has-text("код")',
      'button:has-text("Код")',
      '[data-qa*="send"]',
      '[role="button"]',
    ].join(',');

    let sendBtn = await ctx.$(sendBtnSel);
    // если явного сабмита нет — попробуем Enter по инпуту
    if (!sendBtn) {
      await telInput.press('Enter').catch(() => {});
    } else {
      await sendBtn.click().catch(() => {});
    }

    // 5) ждём появления поля для кода — маркер успеха отправки SMS
    const codeSel = [
      'input[name*="code"]',
      'input[autocomplete="one-time-code"]',
      'input[placeholder*="код"]',
      'input[placeholder*="Код"]',
    ].join(',');
    // проверим в текущем контексте и параллельно — в возможном всплывшем фрейме
    let hasCode = await ctx.$(codeSel);
    if (!hasCode) {
      // иногда форма перерисовывается — дадим чуть времени
      await sleep(2000);
      // на всякий ещё раз просканируем фреймы
      const codeFrame = page.frames().find(f => /auth|login|signin|confirm|code/i.test(f.url()));
      if (codeFrame) {
        hasCode = await codeFrame.$(codeSel);
        if (hasCode) sessions.set; // просто оставим контекст как есть, подтвердим на этапе /verify
      }
    }

    if (!hasCode) {
      return res.status(500).json({
        error: 'start_failed',
        detail: 'Не появилось поле ввода кода. Возможно, изменились селекторы/поток авторизации.',
      });
    }

    // держим браузер открытым до верификации
    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, pageOrFrame: ctx });
    return res.json({ ok: true, sessionId });

  } catch (e) {
    if (browser) { try { await browser.close(); } catch {} }
    return res.status(500).json({ error: 'start_failed', detail: String(e.message || e) });
  }
});

// ----------- авторизация: шаг 2 — ввод кода из SMS -----------
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  if (!sessionId || !smsCode) return res.status(400).json({ error: 'sessionId and smsCode required' });

  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session not found' });

  const { browser, pageOrFrame } = sess;
  try {
    const ctx = pageOrFrame;

    const codeSel = [
      'input[name*="code"]',
      'input[autocomplete="one-time-code"]',
      'input[placeholder*="код"]',
      'input[placeholder*="Код"]',
    ].join(',');

    const codeInput = await ctx.$(codeSel);
    if (!codeInput) throw new Error('Поле для кода не найдено.');

    await codeInput.click({ clickCount: 3 }).catch(() => {});
    await codeInput.type(String(smsCode), { delay: 60 });

    // клик «Подтвердить» или Enter
    const confirmSel = [
      'button[type="submit"]',
      'button:has-text("Подтверд")',
      'button:has-text("Войти")',
      '[data-qa*="confirm"]',
    ].join(',');
    const btn = await ctx.$(confirmSel);
    if (btn) await btn.click().catch(() => {});
    else await codeInput.press('Enter').catch(() => {});

    // ждём, чтобы куки установились и редирект прошёл
    await sleep(2000);

    const cookies = await (ctx.page ? ctx.page() : ctx).cookies
      ? await (ctx.page ? ctx.page() : ctx).cookies()
      : await browser.pages().then(ps => ps[0].cookies());

    await browser.close().catch(() => {});
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (e) {
    try { await browser.close(); } catch {}
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: String(e.message || e) });
  }
});

// ---------- пул общих cookies (опционально) ----------
let sharedCookieJar = [];
app.post('/set-cookies', requireKey, (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  res.json({ ok: true, count: sharedCookieJar.length });
});

// ---------- заглушка для будущего /spp (после логина куками) ----------
app.post('/spp', requireKey, async (req, res) => {
  res.json({ ok: false, note: 'Spp endpoint will be implemented after stable auth flow.' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('WB headless listening on', PORT));
