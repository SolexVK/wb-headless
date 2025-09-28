import express from 'express';
import puppeteer from 'puppeteer-core';
import { v4 as uuidv4 } from 'uuid';
import { computeExecutablePath } from '@puppeteer/browsers';

const app = express();
app.use(express.json({ limit: '1mb' }));

// healthcheck
app.get('/', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// простой api-key для защиты
const API_KEY = process.env.API_KEY || 'supersecret';
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Где искать Chrome, который мы скачиваем при билде в ./.cache/puppeteer
function resolveChromePath() {
  // если явно передали через переменную окружения — используем её
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  // иначе вычисляем путь в кэше @puppeteer/browsers
  // (мы ставим chrome@stable в cacheDir "./.cache/puppeteer" на Linux)
  try {
    return computeExecutablePath({
      browser: 'chrome',
      cacheDir: './.cache/puppeteer',
      buildId: 'stable',
      platform: 'linux'
    });
  } catch (e) {
    return null;
  }
}

const sessions = new Map(); // sessionId -> {browser,page}
let sharedCookieJar = [];   // общий пул куки (по желанию)

/** утилита: применить куки к странице */
async function applyCookies(page, cookies) {
  if (!cookies || !cookies.length) return;
  const client = await page.target().createCDPSession();
  for (const c of cookies) {
    await client.send('Network.setCookie', {
      name: c.name,
      value: c.value,
      domain: c.domain || '.wildberries.ru',
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expires: c.expires ? Math.floor(+c.expires / 1000) : undefined,
      sameSite: (c.sameSite || 'Lax')
    }).catch(() => {});
  }
}

// ———————————————————————————————————————————
// 1) старт логина: отправка SMS, отдаём sessionId
// ———————————————————————————————————————————
app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const executablePath = resolveChromePath();
  if (!executablePath) {
    return res.status(500).json({
      error: 'start_failed',
      detail: 'Chrome not found. Make sure the build step installs chrome to ./.cache/puppeteer'
    });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-zygote'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href*="login"], a[href*="auth"]', { timeout: 30000 }).catch(() => {});
    const loginLink = await page.$('a[href*="login"], a[href*="auth"]');
    if (loginLink) await loginLink.click();

    await page.waitForSelector('input[type="tel"], input[name*="phone"]', { timeout: 30000 });
    await page.type('input[type="tel"], input[name*="phone"]', phone, { delay: 50 });

    const btn = await page.$('button, [role="button"]');
    if (btn) await btn.click();

    await page.waitForSelector('input[type="text"][maxlength="6"], input[name*="code"]', { timeout: 60000 });

    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });
    return res.json({ sessionId });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      error: 'start_failed',
      detail: String(err && err.message ? err.message : err)
    });
  }
});

// ———————————————————————————————————————————
// 2) подтверждение SMS-кода: возвращаем cookies
// ———————————————————————————————————————————
app.post('/verify', requireKey, async (req, res) => {
  const { sessionId, smsCode } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error: 'session not found' });
  const { browser, page } = sess;

  try {
    await page.type('input[type="text"][maxlength="6"], input[name*="code"]', String(smsCode), { delay: 50 });
    const btn = await page.$('button, [role="button"]');
    if (btn) await btn.click();

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const cookies = await page.cookies();
    await browser.close();
    sessions.delete(sessionId);

    return res.json({ ok: true, cookies });
  } catch (err) {
    await browser.close().catch(() => {});
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: String(err && err.message ? err.message : err) });
  }
});

// ———————————————————————————————————————————
// 3) сохранить куки (необязательно)
// ———————————————————————————————————————————
app.post('/set-cookies', requireKey, async (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  return res.json({ ok: true, count: sharedCookieJar.length });
});

// ———————————————————————————————————————————
// 4) пример эндпойнта spp (как был у тебя)
// ———————————————————————————————————————————
app.post('/spp', requireKey, async (req, res) => {
  const { cookies, nmList } = req.body || {};
  const jar = (Array.isArray(cookies) && cookies.length) ? cookies : sharedCookieJar;
  if (!jar || !jar.length) return res.status(400).json({ error: 'no cookies' });
  if (!Array.isArray(nmList) || !nmList.length) return res.status(400).json({ error: 'nmList required' });

  const executablePath = resolveChromePath();
  if (!executablePath) return res.status(500).json({ error: 'chrome_not_found' });

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded' });
  await applyCookies(page, jar);
  await page.reload({ waitUntil: 'networkidle2' });

  await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2' });

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

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  let result = {};
  if (priceJson) {
    const rows = priceJson.items || priceJson.data || priceJson.list || [];
    for (const r of rows) {
      const nm = Number(r.nmID || r.nmId);
      if (!nm) continue;
      if (!nmList.includes(nm)) continue;
      const spp = (r.spp != null) ? Number(r.spp) :
                  (r.wbDiscountPct != null) ? Number(r.wbDiscountPct) : null;
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
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('WB headless listening on', PORT));
