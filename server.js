import express from 'express';
import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json({ limit: '1mb' }));

// healthchecks (и /health, и /healthz — чтобы что ни стояло в Render)
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
// healthchecks (оба пути, и корень на всякий случай)
app.get(['/health', '/healthz', '/'], (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// простой api-key
const API_KEY = process.env.API_KEY || 'supersecret';
function requireKey(req, res, next) {
  if ((req.headers['x-api-key'] || '') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// где живёт Chrome на Render (мы ставим его в postinstall именно сюда)
const DEFAULT_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';

async function launchBrowser() {
  // Puppeteer сам знает свой executablePath, но если хром не в дефолтном месте — подскажем.
  // Сначала пробуем стандартный путь Puppeteer:
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    return browser;
  } catch (e) {
    // fallback: укажем явно путь к chrome из cacheDir
    const pathCandidates = [
      `${DEFAULT_CACHE_DIR}/chrome/linux-*/chrome-linux64/chrome`,
      `${DEFAULT_CACHE_DIR}/chrome/linux-*/chrome`,
      `${DEFAULT_CACHE_DIR}/chrome/linux-*/chrome-linux64/chrome-branded`
    ];
    // очень лёгкий поиск: пробуем несколько типичных путей
    const fs = await import('fs');
    const globby = async (pattern) => {
      // микро-глоб: заменим * на пусто и проверим несколько вариантов
      const base = pattern.replace('*', '');
      const parts = base.split('/').filter(Boolean);
      // просто перебор директории linux-XXX
      const linuxDir = `${DEFAULT_CACHE_DIR}/chrome`;
      if (!fs.existsSync(linuxDir)) throw new Error('chrome cache dir not found');
      const entries = fs.readdirSync(linuxDir);
      for (const dir of entries) {
        if (!dir.startsWith('linux-')) continue;
        const candidate = pattern.replace('linux-*', dir);
        const clean = candidate.replace('*', '');
        if (fs.existsSync(clean)) return clean;
      }
      return null;
    };

    for (const p of pathCandidates) {
      const found = await globby(p).catch(() => null);
      if (found) {
        return puppeteer.launch({
          headless: 'new',
          executablePath: found,
          args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
      }
    }
    // если сюда дошли — отдадим исходную ошибку
    throw e;
  }
}

const sessions = new Map(); // sessionId -> {browser,page}
let sharedCookieJar = [];   // общие куки (по желанию)

/** применить куки к странице */
async function applyCookies(page, cookies) {
  if (!cookies || !cookies.length) return;
  const client = await page.target().createCDPSession();
  for (const c of cookies) {
    await client.send('Network.setCookie', {
      name: c.name, value: c.value, domain: c.domain || '.wildberries.ru',
      path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
      expires: c.expires ? Math.floor(+c.expires / 1000) : undefined,
      sameSite: (c.sameSite || 'Lax')
    }).catch(() => {});
  }
}

/** 1) старт логина: отправка SMS, отдаём sessionId */
app.post('/start', requireKey, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const browser = await launchBrowser();
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
    return res.status(500).json({ error: 'start_failed', detail: String(err && err.message || err) });
  }
});

/** 2) подтверждение SMS-кода: возвращаем cookies */
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
    try { await browser.close(); } catch (_) {}
    sessions.delete(sessionId);
    return res.status(500).json({ error: 'verify_failed', detail: String(err && err.message || err) });
  }
});

/** 3) сохранить куки в shared storage (опционально) */
app.post('/set-cookies', requireKey, async (req, res) => {
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  return res.json({ ok: true, count: sharedCookieJar.length });
});

/** 4) получить СПП по nmList (через ЛК) */
app.post('/spp', requireKey, async (req, res) => {
  const { cookies, nmList } = req.body || {};
  const jar = (Array.isArray(cookies) && cookies.length) ? cookies : sharedCookieJar;
  if (!jar || !jar.length) return res.status(400).json({ error: 'no cookies' });
  if (!Array.isArray(nmList) || !nmList.length) return res.status(400).json({ error: 'nmList required' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('https://seller.wildberries.ru', { waitUntil: 'domcontentloaded' });

    await applyCookies(page, jar);
    await page.reload({ waitUntil: 'networkidle2' });

    await page.goto('https://seller.wildberries.ru/discount-and-prices', { waitUntil: 'networkidle2' });

    // перехват XHR, который отдаёт таблицу
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
        if (!nm || !nmList.includes(nm)) continue;
        const spp = (r.spp != null) ? Number(r.spp)
                  : (r.wbDiscountPct != null) ? Number(r.wbDiscountPct)
                  : null;
        const final = r.finalPrice ?? r.wbPrice ?? r.priceWithWB ?? null;
        if (spp != null || final != null) result[nm] = { sppPct: spp, priceAfterSpp: final };
      }
    }

    if (Object.keys(result).length === 0) {
      // запасной вариант: чтение DOM
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
  } catch (err) {
    if (browser) try { await browser.close(); } catch (_) {}
    return res.status(500).json({ error: 'spp_failed', detail: String(err && err.message || err) });
  }
});

const PORT = process.env.PORT || 10000; // Render Free использует произвольный порт — ок
app.listen(PORT, () => console.log('WB headless listening on', PORT));
