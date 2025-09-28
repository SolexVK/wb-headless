// server.js — устойчивый вход в ЛК WB + сбор СПП + отладочные ручки

import express from 'express';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '1mb' }));

// -----------------------------
// 1) Здоровье и защита
// -----------------------------
app.get('/health', (req, res) => res.json({ ok: true }));

const API_KEY = process.env.API_KEY || 'supersecret';
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// -----------------------------
// 2) Поиск Chrome (устойчиво)
// -----------------------------
function resolveChromePath() {
  // 1) Явный путь из переменных окружения
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  // 2) Где чаще всего ставит @puppeteer/browsers при флаге --path=./chrome
  try {
    const root = path.resolve(process.cwd(), 'chrome');
    if (fs.existsSync(root)) {
      const entries = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      for (const dir of entries) {
        const guess = path.join(root, dir, 'chrome-linux64', 'chrome');
        if (fs.existsSync(guess)) return guess;
      }
    }
  } catch (_) {}

  // 3) Fallback — старый cache каталог
  const fallback = path.resolve(
    process.cwd(),
    '.cache/puppeteer/chrome/linux-stable/chrome-linux64/chrome'
  );
  return fallback;
}
const CHROME_PATH = resolveChromePath();

// быстрая ручка проверки расположения браузера
app.get('/debug-chrome', requireKey, (req, res) => {
  res.json({
    cwd: process.cwd(),
    chromePath: CHROME_PATH,
    exists: fs.existsSync(CHROME_PATH)
  });
});

// -----------------------------
// 3) Внутренние утилиты
// -----------------------------
const sessions = new Map(); // sessionId -> { browser, page }
let sharedCookieJar = [];   // общий пул куки (опционально reuse)

async function applyCookies(page, cookies) {
  if (!cookies || !cookies.length) return;
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
        sameSite: (c.sameSite || 'Lax')
      });
    } catch { /* ignore */ }
  }
}

// Отладка: скачать HTML текущей страницы
app.get('/debug-html', requireKey, async (req, res) => {
  try {
    const { url } = req.query;
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      args: ['--no-sandbox', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.goto(url || 'https://seller.wildberries.ru', { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    await browser.close();
    res.type('text/html').send(html);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Снимок скриншота для диагностики (base64)
app.get('/snap', requireKey, async (req, res) => {
  try {
    const { url } = req.query;
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      args: ['--no-sandbox', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url || 'https://seller.wildberries.ru', { waitUntil: 'networkidle2' });
    const b64 = (await page.screenshot({ fullPage: true })).toString('base64');
    await browser.close();
    res.json({ ok: true, pngBase64: b64 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Универсальный ожидатель «первого доступного» селектора из списка
async function waitAny(page, selectors = [], timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const h = await page.$(sel);
        if (h) return sel;
      } catch {}
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`waitAny timeout: ${selectors.join(' | ')}`);
}

// Клик по кнопке по тексту
async function clickByText(page, texts = []) {
  return page.evaluate((texts) => {
    const elements = Array.from(document.querySelectorAll('button,[role="button"],a'));
    const match = elements.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return texts.some(x => t.includes(x));
    });
    if (match) {
      (match).click();
      return true;
    }
    return false;
  }, texts.map(t => t.toLowerCase()));
}

// -----------------------------
// 4) Старт логина: отправка СМС
// -----------------------------
app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--lang=ru-RU,ru',
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1) Идём сразу на страницу, где наверняка потребует авторизацию
    //    (эта страница доступна только после входа)
    await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'domcontentloaded' });

    // 2) Если редиректит на логин — подстрахуемся несколькими прямыми путями
    const candidateAuthUrls = [
      'https://seller.wildberries.ru/security/login',
      'https://seller.wildberries.ru/login',
      'https://seller.wildberries.ru/ru/auth',
      'https://seller.wildberries.ru',
    ];

    // Пробуем цепочку навигаций, пока не увидим поле телефона
    let phoneSelector = null;
    const phoneSelectors = [
      'input[type="tel"]',
      'input[name*="phone"]',
      'input[name*="tel"]',
      'input[name*="phoneNumber"]',
      'input[inputmode="tel"]',
    ];

    async function ensureOnLogin() {
      // уже есть поле телефона?
      try {
        phoneSelector = await waitAny(page, phoneSelectors, 4000);
        return true;
      } catch {}

      // клик по «Войти/Личный кабинет» если на главной
      await clickByText(page, ['войти', 'личный кабинет', 'вход']).catch(()=>{});
      await page.waitForTimeout(1200);

      try {
        phoneSelector = await waitAny(page, phoneSelectors, 4000);
        return true;
      } catch {}

      // прямые адреса логина
      for (const url of candidateAuthUrls) {
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(()=>{});
        await page.waitForTimeout(800);
        try {
          phoneSelector = await waitAny(page, phoneSelectors, 4000);
          return true;
        } catch {}
      }

      // ещё одна попытка: снова на «закрытую» страницу — WB сам редиректит на логин
      await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2' }).catch(()=>{});
      await page.waitForTimeout(800);
      phoneSelector = await waitAny(page, phoneSelectors, 10000); // финальная попытка
      return true;
    }

    await ensureOnLogin();

    // 3) Ввод телефона
    await page.focus(phoneSelector);
    await page.keyboard.down('Control').catch(()=>{});
    await page.keyboard.press('A').catch(()=>{});
    await page.keyboard.up('Control').catch(()=>{});
    await page.type(phoneSelector, String(phone), { delay: 50 });

    // 4) Нажимаем подходящую кнопку: «Отправить код», «Продолжить», «Далее»
    const clicked =
      await clickByText(page, ['отправить код', 'получить код', 'продолжить', 'далее', 'войти']) ||
      await page.$eval('button[type="submit"]', (b) => { (b).click(); return true; }).catch(()=>false);

    if (!clicked) {
      throw new Error('Не удалось нажать кнопку отправки кода');
    }

    // 5) Ждём поле для СМС (6 цифр)
    const codeSelector = await waitAny(page, [
      'input[autocomplete="one-time-code"]',
      'input[name*="code"]',
      'input[maxlength="6"]',
      'input[type="text"]'
    ], 30000);

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });
    return res.json({ sessionId, codeSelectorFound: !!codeSelector });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      error: 'start_failed',
      detail: String(e && e.message ? e.message : e)
    });
  }
});

// -----------------------------
// 5) Подтверждение СМС: вернуть cookies
// -----------------------------
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session not found' });
  const { browser, page } = sess;

  try {
    // вводим код
    const codeSel = await waitAny(page, [
      'input[autocomplete="one-time-code"]',
      'input[name*="code"]',
      'input[maxlength="6"]',
      'input[type="text"]'
    ], 15000);

    await page.type(codeSel, String(smsCode), { delay: 80 });

    // сабмит
    await clickByText(page, ['подтвердить', 'войти', 'готово', 'далее']).catch(()=>{});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{});
    await page.waitForTimeout(1200);

    const cookies = await page.cookies();
    await browser.close();
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (e) {
    await browser.close().catch(() => {});
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// -----------------------------
// 6) Общий банку куки (опционально)
// -----------------------------
app.post('/set-cookies', requireKey, async (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  return res.json({ ok: true, count: sharedCookieJar.length });
});

// -----------------------------
// 7) Получение СПП с «Цены и скидки» (XHR перехват + DOM-fallback)
// -----------------------------
app.post('/spp', requireKey, async (req, res) => {
  const { cookies, nmList } = req.body || {};
  const jar = (Array.isArray(cookies) && cookies.length) ? cookies : sharedCookieJar;
  if (!jar || !jar.length) return res.status(400).json({ error: 'no cookies' });
  if (!Array.isArray(nmList) || !nmList.length) return res.status(400).json({ error: 'nmList required' });

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded' });
    await applyCookies(page, jar);
    await page.reload({ waitUntil: 'networkidle2' });

    let priceJson = null;
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (/discount.*prices.*list|prices.*list|discount-and-prices.*list/i.test(url)) {
          const ct = resp.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            priceJson = await resp.json();
          }
        }
      } catch {}
    });

    await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2' });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    let result = {};
    if (priceJson) {
      const rows = priceJson.items || priceJson.data || priceJson.list || [];
      for (const r of rows) {
        const nm = Number(r.nmID || r.nmId); if (!nm) continue;
        if (!nmList.includes(nm)) continue;
        const spp = (r.spp != null) ? Number(r.spp)
          : (r.wbDiscountPct != null) ? Number(r.wbDiscountPct) : null;
        const final = r.finalPrice ?? r.wbPrice ?? r.priceWithWB ?? null;
        if (spp != null || final != null) result[nm] = { sppPct: spp, priceAfterSpp: final };
      }
    }

    if (Object.keys(result).length === 0) {
      result = await page.evaluate((nmList) => {
        const map = {};
        const rows = document.querySelectorAll('table tr');
        rows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 6) return;
          const nm = Number((cells[0].innerText || '').replace(/\D+/g, ''));
          if (!nm || !nmList.includes(nm)) return;
          const sppText = (cells[4].innerText || '').replace(/\s+|%/g, '');
          const priceText = (cells[5].innerText || '').replace(/[^\d]/g, '');
          const spp = sppText ? Number(sppText) : null;
          const price = priceText ? Number(priceText) : null;
          if (spp != null || price != null) map[nm] = { sppPct: spp, priceAfterSpp: price };
        });
        return map;
      }, nmList);
    }

    await browser.close();
    return res.json(result);
  } catch (e) {
    await browser.close().catch(() => {});
    return res.status(500).json({ error: 'spp_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// -----------------------------
// 8) Запуск сервера
// -----------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('WB headless listening on', PORT));
