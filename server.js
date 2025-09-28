// server.js — полный файл
import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '1mb' }));

// --------- конфиг ----------
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

// простая защита
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- хранение сессий ----------
const sessions = new Map(); // sessionId -> { browser, page }

// общая "банка" кук по желанию
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
        sameSite: (c.sameSite || 'Lax'),
      });
    } catch { /* noop */ }
  }
}

// ———————————————————————————————————————
// 1) START: открыть страницу ввода телефона, ввести хвост номера, нажать Enter
// ———————————————————————————————————————
import { v4 as uuidv4 } from 'uuid';

app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  const tail = (phone || '').replace(/[^\d]/g, '').replace(/^7/, ''); // берём хвост без +7
  if (!tail || tail.length < 8) {
    return res.status(400).json({ error: 'bad_phone', detail: 'Передай phone с номером, напр. +79261234567' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: HEADLESS ? 'new' : false,
      args: PUPP_ARGS,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // идём на форму авторизации
    await page.goto(WB_AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // селекторы возможного поля телефона (у WB оно с маской и может меняться)
    const phoneSelectors = [
      'input[inputmode="tel"]',
      'input[type="tel"]',
      'input[name*="phone"]',
      'input[data-test*="phone"]',
      'input[placeholder*="999 999-99-99"]',
    ];

    // ищем поле (пробуем несколько селекторов и фреймы тоже)
    const findPhoneField = async () => {
      // 1) на основном документе
      for (const sel of phoneSelectors) {
        const el = await page.$(sel);
        if (el) return { handle: el, frame: page };
      }
      // 2) во фреймах
      for (const f of page.frames()) {
        for (const sel of phoneSelectors) {
          const el = await f.$(sel);
          if (el) return { handle: el, frame: f };
        }
      }
      return null;
    };

    // ждём появление поля (повторными попытками)
    let phoneField = null;
    const startedAt = Date.now();
    while (!phoneField && Date.now() - startedAt < 30000) {
      phoneField = await findPhoneField();
      if (!phoneField) await page.waitForTimeout(500);
    }
    if (!phoneField) {
      throw new Error('Не найдено поле ввода телефона (во всех фреймах).');
    }

    // очищаем и печатаем хвост номера (код страны уже +7 на странице)
    await phoneField.frame.evaluate((el) => { el.value = ''; }, phoneField.handle);
    await phoneField.handle.type(tail, { delay: 50 });

    // жмём Enter
    await phoneField.frame.keyboard.press('Enter');

    // ждём появления экрана ввода кода (несколько вариантов)
    const codeSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[type="tel"][maxlength="1"]',
      'input[name*="code"]',
      'input[aria-label*="код"], input[placeholder*="код"]',
    ];

    const waitCodeScreen = async () => {
      // пробуем 1: одно поле с autocomplete=one-time-code
      const ok1 = await page.$(codeSelectors[0]);
      if (ok1) return true;
      // пробуем 2: шесть отдельных ячеек
      const many = await page.$$(codeSelectors[1]);
      if (many && many.length >= 6) return true;
      // пробуем во фреймах
      for (const f of page.frames()) {
        const el1 = await f.$(codeSelectors[0]);
        if (el1) return true;
        const els = await f.$$(codeSelectors[1]);
        if (els && els.length >= 6) return true;
      }
      return false;
    };

    const t0 = Date.now();
    let codeReady = await waitCodeScreen();
    while (!codeReady && Date.now() - t0 < 30000) {
      await page.waitForTimeout(500);
      codeReady = await waitCodeScreen();
    }
    if (!codeReady) {
      throw new Error('После ввода телефона не появился экран ввода СМС-кода.');
    }

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });

    return res.json({ ok: true, sessionId });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: 'start_failed', detail: e.message });
  }
});

// ———————————————————————————————————————
// 2) VERIFY: ввести 6-значный код, дождаться входа и вернуть куки
// ———————————————————————————————————————
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  if (!sessionId || !smsCode) return res.status(400).json({ error: 'bad_request', detail: 'Нужны sessionId и smsCode' });

  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session_not_found' });

  const { browser, page } = sess;

  try {
    const code = String(smsCode).replace(/[^\d]/g, '');
    if (code.length < 4) throw new Error('Код слишком короткий');

    // функция нахождения полей кода (один инпут или 6 инпутов)
    const locateCodeFields = async () => {
      // основной документ
      let single = await page.$('input[autocomplete="one-time-code"]');
      if (single) return { type: 'single', frame: page, el: single, list: [] };
      let multi = await page.$$('input[type="tel"][maxlength="1"]');
      if (multi && multi.length >= 4) return { type: 'multi', frame: page, el: null, list: multi };

      // фреймы
      for (const f of page.frames()) {
        single = await f.$('input[autocomplete="one-time-code"]');
        if (single) return { type: 'single', frame: f, el: single, list: [] };
        multi = await f.$$('input[type="tel"][maxlength="1"]');
        if (multi && multi.length >= 4) return { type: 'multi', frame: f, el: null, list: multi };
      }
      return null;
    };

    // ждём, пока поля кода будут доступны
    let fields = await locateCodeFields();
    const startWait = Date.now();
    while (!fields && Date.now() - startWait < 15000) {
      await page.waitForTimeout(300);
      fields = await locateCodeFields();
    }
    if (!fields) throw new Error('Поле(я) ввода кода не найдены.');

    // вводим код
    if (fields.type === 'single') {
      await fields.el.focus();
      await fields.frame.keyboard.type(code, { delay: 80 });
    } else {
      // 6 отдельных ячеек
      const chars = code.split('');
      for (let i = 0; i < fields.list.length && i < chars.length; i++) {
        await fields.list[i].focus();
        await fields.frame.keyboard.type(chars[i], { delay: 60 });
      }
    }

    // WB обычно сам редиректит в кабинет. Ждём либо смену урла, либо появление шапки ЛК.
    const redirectOk = await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).then(() => true).catch(() => false),
      (async () => {
        for (let i = 0; i < 40; i++) {
          const url = page.url();
          if (url.startsWith(WB_HOME_URL)) return true;
          await page.waitForTimeout(500);
        }
        return false;
      })(),
    ]);

    if (!redirectOk) {
      // даже если редирект не поймали, попробуем одним переходом добить кабинет — если токен уже проставился
      await page.goto(WB_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    // небольшая пауза, чтобы успели установиться куки
    await page.waitForTimeout(1200);

    // собираем куки со всех открытых контекстов/страниц
    const allCookies = [];
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        const ck = await p.cookies();
        allCookies.push(...ck);
      } catch {}
    }
    // фильтруем дубликаты
    const uniq = [];
    const seen = new Set();
    for (const c of allCookies) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniq.push(c);
      }
    }

    // закрываем браузер и гасим сессию
    await browser.close().catch(() => {});
    sessions.delete(sessionId);

    // опционально — сохранить в общий «банк», чтобы не передавать из таблицы каждый раз
    sharedCookieJar = uniq;

    return res.json({ ok: true, cookies: uniq });
  } catch (e) {
    await browser.close().catch(() => {});
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: e.message });
  }
});

// ———————————————————————————————————————
// По желанию: сохранить куки на сервере (общая банка)
// ———————————————————————————————————————
app.post('/set-cookies', requireKey, async (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  return res.json({ ok: true, count: sharedCookieJar.length });
});

// ———————————————————————————————————————
// Черновой /spp как был (оставлен без изменений)
// ———————————————————————————————————————
app.post('/spp', requireKey, async (req, res) => {
  const { cookies, nmList } = req.body || {};
  const jar = (Array.isArray(cookies) && cookies.length) ? cookies : sharedCookieJar;
  if (!jar || !jar.length) return res.status(400).json({ error: 'no_cookies' });
  if (!Array.isArray(nmList) || !nmList.length) return res.status(400).json({ error: 'nmList required' });

  const browser = await puppeteer.launch({ headless: HEADLESS ? 'new' : false, args: PUPP_ARGS });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(WB_HOME_URL, { waitUntil: 'domcontentloaded' });
    await withCDPSetCookies(page, jar);
    await page.reload({ waitUntil: 'networkidle2' });

    await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2' });

    let priceJson = null;
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (/discount.*prices.*list|prices.*list|discount-and-prices.*list/i.test(url)) {
          const ct = (resp.headers()['content-type'] || '');
          if (ct.includes('application/json')) {
            const data = await resp.json();
            priceJson = data;
          }
        }
      } catch {}
    });

    await page.waitForTimeout(1500);

    let result = {};
    if (priceJson) {
      const rows = priceJson.items || priceJson.data || priceJson.list || [];
      for (const r of rows) {
        const nm = Number(r.nmID || r.nmId);
        if (!nm || !nmList.includes(nm)) continue;
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
        rows.forEach((tr) => {
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
    await browser.close();
    return res.status(500).json({ error: 'spp_failed', detail: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('WB headless listening on', PORT));
