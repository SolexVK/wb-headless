import express from 'express';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json({ limit: '1mb' }));

// healthcheck
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
// корень тоже жив
app.get('/', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// простой api-key защита
const API_KEY = process.env.API_KEY || 'supersecret';
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/** --------- НАСТРОЙКА ПУТИ К CHROME ---------- */
const DEFAULT_CHROME_PATH = path.resolve(
  process.cwd(),
  '.cache/puppeteer/chrome/linux-stable/chrome-linux64/chrome'
);
const CHROME_PATH = process.env.CHROME_PATH || DEFAULT_CHROME_PATH;

// для диагностики — проверить, виден ли бинарь из рантайма
app.get('/debug-chrome', requireKey, (req, res) => {
  const exists = fs.existsSync(CHROME_PATH);
  res.json({
    cwd: process.cwd(),
    chromePath: CHROME_PATH,
    exists,
  });
});

/** полезные дефолтные аргументы Chromium на хостингах */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--ignore-certificate-errors',
  '--incognito',
];

/** утилита: применить куки к странице */
async function applyCookies(page, cookies) {
  if (!cookies || !cookies.length) return;
  const client = await page.target().createCDPSession();
  for (const c of cookies) {
    await client
      .send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: c.domain || '.wildberries.ru',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expires: c.expires ? Math.floor(+c.expires / 1000) : undefined,
        sameSite: c.sameSite || 'Lax',
      })
      .catch(() => {});
  }
}

const sessions = new Map(); // sessionId -> {browser,page}
let sharedCookieJar = [];   // общий пул куки (по желанию)

/** 1) старт логина: отправка SMS, отдаём sessionId */
app.post('/start', requireKey, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone required' });

    // проверим, существует ли бинарь
    if (!fs.existsSync(CHROME_PATH)) {
      return res.status(500).json({
        error: 'start_failed',
        detail: `Chrome binary not found at ${CHROME_PATH}. Check build step or set CHROME_PATH env.`,
      });
    }

    const browser = await puppeteer.launch({
      headless: true,              // для Render headless обязателен
      executablePath: CHROME_PATH, // <-- ВАЖНО
      args: CHROME_ARGS,
      defaultViewport: { width: 1280, height: 900 },
    });

    const page = await browser.newPage();
    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Попытка найти ссылку/кнопку логина
    await page.waitForSelector('a[href*="login"], a[href*="auth"], button', { timeout: 30000 }).catch(() => {});
    const loginLink = await page.$('a[href*="login"], a[href*="auth"]');
    if (loginLink) await loginLink.click();

    await page.waitForSelector('input[type="tel"], input[name*="phone"]', { timeout: 30000 });
    await page.type('input[type="tel"], input[name*="phone"]', phone, { delay: 50 });

    // кнопка "Отправить код"
    const submitBtn = await page.$('button, [role="button"]');
    if (submitBtn) await submitBtn.click();

    // ждём поле кода
    await page.waitForSelector('input[type="text"][maxlength], input[name*="code"]', { timeout: 60000 });

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });
    return res.json({ sessionId });
  } catch (e) {
    console.error('START FAILED:', e);
    return res.status(500).json({
      error: 'start_failed',
      detail: String(e && e.message ? e.message : e),
    });
  }
});

/** 2) подтверждение SMS-кода: возвращаем cookies */
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session not found' });

  const { browser, page } = sess;
  try {
    await page.type('input[type="text"][maxlength], input[name*="code"]', String(smsCode), { delay: 50 });
    const btn = await page.$('button, [role="button"]');
    if (btn) await btn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const cookies = await page.cookies();
    await browser.close();
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (e) {
    await browser.close().catch(() => {});
    sessions.delete(sessionId);
    console.error('VERIFY FAILED:', e);
    return res.status(500).json({ error: 'verify_failed', detail: String(e && e.message ? e.message : e) });
  }
});

/** 3) сохранить куки (опционально) */
app.post('/set-cookies', requireKey, async (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  return res.json({ ok: true, count: sharedCookieJar.length });
});

/** 4) получить СПП по nmList (через ЛК) — как было */
app.post('/spp', requireKey, async (req, res) => {
  const { cookies, nmList } = req.body || {};
  const jar = (Array.isArray(cookies) && cookies.length) ? cookies : sharedCookieJar;
  if (!jar || !jar.length) return res.status(400).json({ error: 'no cookies' });
  if (!Array.isArray(nmList) || !nmList.length) return res.status(400).json({ error: 'nmList required' });

  if (!fs.existsSync(CHROME_PATH)) {
    return res.status(500).json({
      error: 'chrome_missing',
      detail: `Chrome binary not found at ${CHROME_PATH}`,
    });
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: CHROME_ARGS,
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded', timeout: 60000 });

    await applyCookies(page, jar);
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });

    await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2', timeout: 60000 });

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
      } catch (_) {}
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    let result = {};
    if (priceJson) {
      const rows = priceJson.items || priceJson.data || priceJson.list || [];
      for (const r of rows) {
        const nm = Number(r.nmID || r.nmId); if (!nm) continue;
        if (!nmList.includes(nm)) continue;
        const spp = (r.spp != null) ? Number(r.spp) :
                    (r.wbDiscountPct != null) ? Number(r.wbDiscountPct) : null;
        const final = r.finalPrice ?? r.wbPrice ?? r.priceWithWB ?? null;
        if (spp != null || final != null) result[nm] = { sppPct: spp, priceAfterSpp: final };
      }
    }

    if (Object.keys(result).length === 0) {
      result = await page.evaluate((ids) => {
        const map = {};
        const rows = document.querySelectorAll('table tr');
        rows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 6) return;
          const nm = Number((cells[0].innerText || '').replace(/\D+/g, ''));
          if (!nm || !ids.includes(nm)) return;
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
    console.error('SPP FAILED:', e);
    return res.status(500).json({ error: 'spp_failed', detail: String(e && e.message ? e.message : e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('WB headless listening on', PORT);
  console.log('Chrome expected at:', CHROME_PATH, 'exists:', fs.existsSync(CHROME_PATH));
});
