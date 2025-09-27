import express from 'express';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- конфиг ---------- */
const API_KEY = process.env.API_KEY || 'supersecret';
const PORT = Number(process.env.PORT || 8080);

// Аргументы для Render/безопасных окружений
const PUP_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process'
];
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- утилиты ---------- */
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function newBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: PUP_ARGS
  });
  const page = await browser.newPage();
  await page.setUserAgent(DEFAULT_UA);
  await page.setViewport({ width: 1280, height: 900 });
  return { browser, page };
}

async function safeClose(browser) {
  if (!browser) return;
  try { await browser.close(); } catch (_) {}
}

/** применить набор cookie к странице */
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
        sameSite: c.sameSite || 'Lax',
        expires: c.expires ? Math.floor(+c.expires / 1000) : undefined
      });
    } catch (_) {}
  }
}

/* ---------- состояния ---------- */
const sessions = new Map(); // sessionId -> { browser, page }
let sharedCookieJar = [];   // опционально — хранить куки на сервисе

/* ---------- health ---------- */
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/* ---------- 1) старт логина: телефон → отправка SMS → sessionId ---------- */
app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  let browser;
  try {
    const nb = await newBrowser();
    browser = nb.browser;
    const page = nb.page;

    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Переход к форме логина (селекторы могут меняться — подправим при необходимости)
    await page.waitForTimeout(800);
    await page
      .waitForSelector('a[href*="login"], a[href*="auth"], button[href*="login"]', { timeout: 30000 })
      .catch(() => null);
    const loginLink = await page.$('a[href*="login"], a[href*="auth"], button[href*="login"]');
    if (loginLink) await loginLink.click();

    // Поле телефона
    await page.waitForSelector('input[type="tel"], input[name*="phone"]', { timeout: 30000 });
    await page.click('input[type="tel"], input[name*="phone"]', { clickCount: 3 });
    await page.type('input[type="tel"], input[name*="phone"]', String(phone), { delay: 50 });

    // Кнопка «Отправить код»
    const btn = (await page.$('button[type="submit"], button, [role="button"]')) || null;
    if (btn) await btn.click();

    // Ждём появления поля кода
    await page.waitForSelector('input[type="text"][maxlength], input[name*="code"]', { timeout: 60000 });

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });
    return res.json({ sessionId });
  } catch (err) {
    await safeClose(browser);
    console.error('start error:', err?.message || err);
    return res.status(500).json({ error: 'start_failed', detail: String(err?.message || err) });
  }
});

/* ---------- 2) подтверждение SMS-кода: вернуть cookies ---------- */
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  if (!sessionId || !smsCode) return res.status(400).json({ error: 'sessionId and smsCode required' });

  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session not found' });

  const { browser, page } = sess;
  try {
    await page.type('input[type="text"][maxlength], input[name*="code"]', String(smsCode), { delay: 50 });
    const btn = (await page.$('button[type="submit"], button, [role="button"]')) || null;
    if (btn) await btn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);
    await page.waitForTimeout(1200);

    const cookies = await page.cookies();
    await safeClose(browser);
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (err) {
    await safeClose(browser);
    sessions.delete(sessionId);
    console.error('verify error:', err?.message || err);
    return res.status(500).json({ error: 'verify_failed', detail: String(err?.message || err) });
  }
});

/* ---------- 3) сохранить куки на сервисе (опционально) ---------- */
app.post('/set-cookies', requireKey, (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  return res.json({ ok: true, count: sharedCookieJar.length });
});

/* ---------- 4) получить СПП по списку НМ (через ЛК) ---------- */
app.post('/spp', requireKey, async (req, res) => {
  const { cookies, nmList } = req.body || {};
  const jar = (Array.isArray(cookies) && cookies.length) ? cookies : sharedCookieJar;
  if (!jar || !jar.length) return res.status(400).json({ error: 'no cookies' });
  if (!Array.isArray(nmList) || !nmList.length) return res.status(400).json({ error: 'nmList required' });

  let browser;
  try {
    const nb = await newBrowser();
    browser = nb.browser;
    const page = nb.page;

    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await applyCookies(page, jar);
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });

    await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2', timeout: 60000 });

    // Перехват XHR с данными таблицы
    let priceJson = null;
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (/discount.*prices.*list|prices.*list|discount-and-prices.*list/i.test(url)) {
          const ct = resp.headers()['content-type'] || '';
          if (ct.includes('application/json')) {
            const data = await resp.json();
            priceJson = data;
          }
        }
      } catch (_) {}
    });

    // Промотаем страницу, чтобы ушли запросы
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    let result = {};
    // 1) попытка распарсить XHR JSON
    if (priceJson) {
      const rows = priceJson.items || priceJson.data || priceJson.list || [];
      for (const r of rows) {
        const nm = Number(r.nmID ?? r.nmId ?? r.nmid);
        if (!nm || !nmList.includes(nm)) continue;

        // ПОДСТРОИТЬ под фактические названия полей JSON из ЛК:
        const spp =
          r.spp != null ? Number(r.spp) :
          r.wbDiscountPct != null ? Number(r.wbDiscountPct) :
          r.wbDiscount != null ? Number(r.wbDiscount) :
          null;
        const final = r.finalPrice ?? r.wbPrice ?? r.priceWithWB ?? r.priceAfterSpp ?? null;

        if (spp != null || final != null) result[nm] = { sppPct: spp, priceAfterSpp: final };
      }
    }

    // 2) fallback: парс DOM (на случай, если XHR не поймали)
    if (Object.keys(result).length === 0) {
      result = await page.evaluate((ids) => {
        const out = {};
        const toNum = (s) => (s ? Number(String(s).replace(/[^\d.]/g, '')) : null);
        const toPct = (s) => (s ? Number(String(s).replace(/[^-\d.]/g, '')) : null);

        const rows = document.querySelectorAll('table tr');
        rows.forEach((tr) => {
          const tds = tr.querySelectorAll('td');
          if (tds.length < 6) return;
          const nm = Number((tds[0].innerText || '').replace(/\D+/g, ''));
          if (!nm || !ids.includes(nm)) return;
          // ориентировочно: колонка СПП и «цена после СПП»
          const spp = toPct(tds[4]?.innerText || '');
          const final = toNum(tds[5]?.innerText || '');
          if (spp != null || final != null) out[nm] = { sppPct: spp, priceAfterSpp: final };
        });
        return out;
      }, nmList);
    }

    await safeClose(browser);
    return res.json(result);
  } catch (err) {
    await safeClose(browser);
    console.error('spp error:', err?.message || err);
    return res.status(500).json({ error: 'spp_failed', detail: String(err?.message || err) });
  }
});

/* ---------- start ---------- */
app.listen(PORT, () => {
  console.log(`WB headless listening on ${PORT}`);
});
