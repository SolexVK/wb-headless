// server.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

// -------------------- базовые вещи --------------------
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const API_KEY = process.env.API_KEY || "supersecret";
function requireKey(req, res, next) {
  if ((req.headers["x-api-key"] || "") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Активные сессии: sessionId -> { browser, page, createdAt }
const sessions = new Map();

// -------------------- утилиты --------------------
/** Находим путь к установленному Chrome в Render/локально */
function resolveChromePath() {
  // 1) Явная переменная окружения (если задана)
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  // 2) Render: наш build кладёт Chrome вот сюда (пример из логов)
  //    /opt/render/project/src/chrome/linux-140.0.7339.207/chrome-linux64/chrome
  const chromeDir = path.join(__dirname, "chrome");
  if (fs.existsSync(chromeDir)) {
    const entries = fs.readdirSync(chromeDir);
    for (const e of entries) {
      const candidate = path.join(chromeDir, e, "chrome-linux64", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 3) Пути puppeteer-кэша (на всякий случай)
  const pptrCache = path.join(__dirname, ".cache", "puppeteer");
  if (fs.existsSync(pptrCache)) {
    const vendors = fs.readdirSync(pptrCache);
    for (const v of vendors) {
      const candidate = path.join(pptrCache, v, "chrome-linux64", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 4) Локальный dev: пусть Puppeteer сам разберётся
  return null;
}

/** Запуск браузера с безопасными флагами для Render */
async function launchBrowser() {
  const executablePath = resolveChromePath();
  const launchOpts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-extensions",
      "--window-size=1280,900",
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  return { browser, page, executablePath };
}

/** Ждём селектор в любом фрейме страницы */
async function waitInAnyFrame(page, selector, { timeout = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // 1) основной документ
    const el = await page.$(selector);
    if (el) return { handle: el, frame: page.mainFrame() };

    // 2) фреймы
    for (const f of page.frames()) {
      try {
        const fh = await f.$(selector);
        if (fh) return { handle: fh, frame: f };
      } catch (_) {}
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Selector not found in any frame: ${selector}`);
}

/** Печатаем в поле надёжно: кликаем, очищаем, вводим */
async function safeType(frame, selector, text) {
  await frame.click(selector, { delay: 50 }).catch(() => {});
  await frame.focus(selector);
  // очистка (на некоторых масках ввода помогает)
  await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.value = "";
  }, selector);
  await frame.type(selector, text, { delay: 50 });
}

/** Берём куки (включая все фреймы / домены) */
async function collectCookies(browser) {
  const pages = await browser.pages();
  let all = [];
  for (const p of pages) {
    try {
      const c = await p.cookies();
      all = all.concat(c);
    } catch (_) {}
  }
  // Удалим дубликаты по name+domain+path
  const uniq = {};
  for (const c of all) {
    uniq[`${c.name}|${c.domain}|${c.path}`] = c;
  }
  return Object.values(uniq);
}

/** Генератор простых id */
function rid() {
  return Math.random().toString(36).slice(2, 10);
}

// -------------------- отладочные ручки --------------------
app.get("/debug-chrome", requireKey, (_req, res) => {
  const p = resolveChromePath();
  res.json({ cwd: process.cwd(), chromePath: p || null, exists: !!(p && fs.existsSync(p)) });
});

// -------------------- основной флоу авторизации --------------------

/**
 * POST /start
 * Body: { phone: "+79261170080" } или "+7..." или "9261170080"
 * Делаем:
 * 1) Открываем https://seller-auth.wildberries.ru/ru/
 * 2) Находим поле номера (input[type="tel"]), печатаем только локальную часть:
 *    - Если номер начинается с +7/7/8 — берём последние 10 цифр (например "9261170080")
 * 3) Жмём Enter, ждём появления формы СМС (6 инпутов или контейнер)
 * 4) Возвращаем { sessionId, status: "waiting_sms" }
 */
app.post("/start", requireKey, async (req, res) => {
  const rawPhone = String((req.body && req.body.phone) || "").trim();
  if (!rawPhone) return res.status(400).json({ error: "phone required" });

  // берём последние 10 цифр (для РФ), т.к. +7 уже предзаполнен на странице
  const digits = rawPhone.replace(/\D+/g, "");
  const localPart = digits.length >= 10 ? digits.slice(-10) : digits;

  let browser, page, exePath;
  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    exePath = launched.executablePath;

    await page.goto("https://seller-auth.wildberries.ru/ru/", { waitUntil: "domcontentloaded", timeout: 60000 });

    // поле телефона
    // на этой странице одно поле type="tel"; внутри него маска формата +7 999 999-99-99
    const telSelector = 'input[type="tel"]';
    const { frame } = await waitInAnyFrame(page, telSelector, { timeout: 30000 });

    // печатаем локальную часть (без +7)
    await safeType(frame, telSelector, localPart);

    // Enter для отправки номера
    await frame.press("Enter");

    // ждём появления формы СМС. На WB это 6 ячеек ввода.
    // Поймаем либо контейнер, либо отдельные inputs
    // Часто это: input[autocomplete="one-time-code"] или набор input[maxlength="1"]
    try {
      await waitInAnyFrame(page, 'input[autocomplete="one-time-code"], input[maxlength="1"]', { timeout: 30000 });
    } catch {
      // альтернативный индикатор: надпись "Введите код из СМС"
      await waitInAnyFrame(page, 'input[type="tel"]', { timeout: 10000 });
    }

    // регистрируем сессию
    const sessionId = rid();
    sessions.set(sessionId, { browser, page, createdAt: Date.now() });

    return res.json({
      ok: true,
      status: "waiting_sms",
      sessionId,
      debug: { chrome: exePath || "bundled", localPart },
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      error: "start_failed",
      detail: err?.message || String(err),
    });
  }
});

/**
 * POST /verify
 * Body: { sessionId, code: "123456" }
 * Делаем:
 * 1) Находим 6 полей ввода, поочередно вводим цифры кода
 * 2) Ждём переход/загрузку ЛК
 * 3) Собираем куки и завершаем браузер
 * 4) Возвращаем { ok, cookies }
 */
app.post("/verify", requireKey, async (req, res) => {
  const { sessionId, code } = req.body || {};
  if (!sessionId || !code) return res.status(400).json({ error: "sessionId and code required" });

  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: "session not found or expired" });

  const { browser, page } = sess;

  try {
    const digits = String(code).replace(/\D+/g, "");
    if (digits.length !== 6) throw new Error("SMS code must contain 6 digits");

    // найдём контейнер с 6 инпутами
    // сначала попробуем получить массив инпутов maxlength="1"
    let inputs = [];
    for (const f of page.frames()) {
      try {
        const handles = await f.$$('input[maxlength="1"], input[autocomplete="one-time-code"]');
        if (handles && handles.length >= 4) {
          inputs = handles;
          break;
        }
      } catch (_) {}
    }

    // если не нашли набор отдельных инпутов — попробуем единственное поле type=tel и просто набрать 6 цифр
    if (!inputs.length) {
      const { frame } = await waitInAnyFrame(page, 'input[type="tel"]', { timeout: 20000 });
      await safeType(frame, 'input[type="tel"]', digits);
    } else {
      // печатаем по одному символу в каждое поле
      for (let i = 0; i < 6; i++) {
        const v = digits[i];
        const h = inputs[i] || inputs[inputs.length - 1]; // на всякий случай
        await h.focus();
        await page.keyboard.type(v, { delay: 50 });
        await page.waitForTimeout(50);
      }
    }

    // ждём загрузку ЛК (любой из доменов seller.wildberries.ru/*)
    // Переход может быть SPA, поэтому ждём появления меню/элементов ЛК
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // если остались на auth-странице, попробуем ткнуть фокус на последний инпут и Enter
    if (/seller-auth\.wildberries\.ru/.test(page.url())) {
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // собираем куки
    const cookies = await collectCookies(browser);

    // закрываем сессию браузера
    await browser.close().catch(() => {});
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (err) {
    // оставим браузер жить, чтобы можно было попробовать ещё раз в той же сессии
    return res.status(500).json({
      error: "verify_failed",
      detail: err?.message || String(err),
    });
  }
});

// -------------------- порт --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("WB headless listening on", PORT);
});
