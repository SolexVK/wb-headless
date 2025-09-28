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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function exists(p){ try { return fs.existsSync(p); } catch { return false; } }

function findChrome(){
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && exists(fromEnv)) return fromEnv;

  const guesses = [
    '/opt/render/project/src/chrome/linux-stable/chrome',
    '/opt/render/project/src/chrome/linux-*/chrome',
  ];
  for (const g of guesses){
    if (exists(g)) return g;
  }
  // обходим кеши билда
  const base = path.join(__dirname, '.cache', 'puppeteer');
  if (exists(base)) {
    for (const dir of fs.readdirSync(base)){
      const p = path.join(base, dir);
      if (!fs.lstatSync(p).isDirectory()) continue;
      const a = path.join(p, 'chrome-linux64', 'chrome');
      const b = path.join(p, 'linux-stable', 'chrome');
      const c = path.join(p, 'chrome');
      if (exists(a)) return a;
      if (exists(b)) return b;
      if (exists(c)) return c;
    }
  }
  return null;
}

function ppLaunchOpts(){
  const executablePath = findChrome();
  if (!executablePath) throw new Error('Chrome binary not found (set CHROME_PATH or check build).');
  return {
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
}

// ---- API key guard
const API_KEY = process.env.API_KEY || 'supersecret';
function requireKey(req,res,next){
  if ((req.headers['x-api-key']||'') !== API_KEY) return res.status(401).json({error:'unauthorized'});
  next();
}

// ---- helpers: поиск во всех фреймах
async function findInAllFrames(page, selectorList, timeoutMs=20000){
  const started = Date.now();
  const sels = Array.isArray(selectorList) ? selectorList : [selectorList];

  while (Date.now() - started < timeoutMs){
    const frames = page.frames();
    for (const f of frames){
      for (const s of sels){
        try{
          const h = await f.$(s);
          if (h) return { frame: f, handle: h, selector: s };
        }catch{}
      }
    }
    await sleep(300);
  }
  return null;
}

function norm(arrayOrString){ return Array.isArray(arrayOrString) ? arrayOrString : [arrayOrString]; }

const PHONE_SELECTORS = [
  'input[type="tel"]',
  'input[inputmode="tel"]',
  'input[name*=phone i]',
  'input[placeholder*="тел" i]',
  'input[aria-label*="тел" i]',
];

const SEND_BTN_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("получить")',
  'button:has-text("код")',
  '[data-qa*="send"]',
  '[role="button"]',
];

const CODE_SELECTORS = [
  'input[name*=code i]',
  'input[autocomplete="one-time-code"]',
  'input[placeholder*="код" i]',
];

app.get('/', (req,res)=>res.json({ok:true, uptime:process.uptime()}));
app.get('/healthz', (req,res)=>res.json({ok:true}));

app.get('/debug-chrome', requireKey, (req,res)=>{
  const p = findChrome();
  res.json({ chromePath: p, exists: !!p && exists(p), cwd: process.cwd() });
});

// держим незакрытый браузер между /start и /verify
const sessions = new Map(); // sessionId -> { browser, page }

app.post('/start', requireKey, async (req,res)=>{
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({error:'phone required'});

  let browser;
  try{
    browser = await puppeteer.launch(ppLaunchOpts());
    const page = await browser.newPage();
    await page.setViewport({ width:1280, height:900 });

    // 1) идём прямо на страницу логина, если нет — на корень и жмём «Войти»
    try{
      await page.goto('https://seller.wildberries.ru/login/ru', { waitUntil:'domcontentloaded', timeout:45000 });
    }catch{
      await page.goto('https://seller.wildberries.ru', { waitUntil:'domcontentloaded', timeout:45000 });
    }
    await sleep(800);

    // если вдруг на корне — попробуем кликнуть «Войти»
    const loginClickable = await findInAllFrames(page, [
      'a[href*="login"]',
      'a[href*="auth"]',
      'button:has-text("войти" i)',
      '[data-qa*="login"]'
    ], 3000);
    if (loginClickable) {
      await loginClickable.handle.click().catch(()=>{});
      await sleep(1200);
    }

    // 2) ищем поле телефона (в любом фрейме)
    const phoneField = await findInAllFrames(page, PHONE_SELECTORS, 20000);
    if (!phoneField){
      throw new Error('Не найдено поле ввода телефона (во всех фреймах).');
    }
    const { frame: phoneFrame, handle: telInput } = phoneField;

    await telInput.click({ clickCount: 3 }).catch(()=>{});
    await telInput.type(phone, { delay: 50 });

    // 3) жмём «Отправить/Получить код» или Enter
    const sendButton = await findInAllFrames(page, SEND_BTN_SELECTORS, 2000);
    if (sendButton) await sendButton.handle.click().catch(()=>{});
    else await phoneFrame.keyboard.press('Enter').catch(()=>{});

    // 4) ждём появления поля кода — НО ищем его СНОВА, чтобы не ловить устаревший контекст
    const codeField = await findInAllFrames(page, CODE_SELECTORS, 20000);
    if (!codeField){
      throw new Error('После отправки телефона поле ввода кода не появилось.');
    }

    // успех: держим браузер открытым до /verify
    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page });
    return res.json({ ok:true, sessionId });

  }catch(e){
    if (browser) { try{ await browser.close(); }catch{} }
    return res.status(500).json({ error:'start_failed', detail: String(e.message || e) });
  }
});

app.post('/verify', requireKey, async (req,res)=>{
  const { sessionId, smsCode } = req.body || {};
  if (!sessionId || !smsCode) return res.status(400).json({ error:'sessionId and smsCode required' });

  const sess = sessions.get(sessionId);
  if (!sess) return res.status(400).json({ error:'session not found' });

  const { browser, page } = sess;
  try{
    // 1) ищем поле кода заново (на случай перерисовок)
    const codeField = await findInAllFrames(page, CODE_SELECTORS, 20000);
    if (!codeField) throw new Error('Поле кода не найдено на шаге verify.');

    await codeField.handle.click({ clickCount: 3 }).catch(()=>{});
    await codeField.handle.type(String(smsCode), { delay: 60 });

    // 2) нажимаем submit/Войти/Подтвердить ИЛИ Enter
    const confirmBtn = await findInAllFrames(page, [
      'button[type="submit"]',
      'button:has-text("подтверд" i)',
      'button:has-text("войти" i)',
      '[data-qa*="confirm"]'
    ], 1500);

    if (confirmBtn) await confirmBtn.handle.click().catch(()=>{});
    else await codeField.frame.keyboard.press('Enter').catch(()=>{});

    await sleep(2200);

    // 3) собираем куки
    const cookies = await page.cookies();
    await browser.close().catch(()=>{});
    sessions.delete(sessionId);

    return res.json({ ok:true, cookies });

  }catch(e){
    try{ await browser.close(); }catch{}
    sessions.delete(sessionId);
    return res.status(500).json({ error:'verify_failed', detail: String(e.message || e) });
  }
});

// shared cookie jar (опционально)
let sharedCookieJar = [];
app.post('/set-cookies', requireKey, (req,res)=>{
  sharedCookieJar = Array.isArray(req.body.cookies) ? req.body.cookies : [];
  res.json({ ok:true, count: sharedCookieJar.length });
});

// заглушка под будущий /spp
app.post('/spp', requireKey, async (req,res)=>{
  res.json({ ok:false, note:'Spp endpoint will be implemented after stable auth flow.' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log('WB headless listening on', PORT));
