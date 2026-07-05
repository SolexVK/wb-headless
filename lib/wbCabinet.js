// lib/wbCabinet.js — вход в личный кабинет WB (seller.wildberries.ru) через
// headless-браузер с ПОДСТАНОВКОЙ КУК, которые пользователь отдаёт после того,
// как сам залогинился. Логин/СМС мы не автоматизируем — только переносим готовую
// сессию (куки) и работаем от её имени.
//
// Обход блокировок — как в scripts/fetch-wb-docs.mjs:
//   • антибот проходит настоящий браузер (реальный UA, ru-RU, скрытый webdriver);
//   • MITM-прокси окружения рвёт TLS 1.3 (ECH) → при HTTPS_PROXY опускаем до TLS 1.2.
//
// БЕЗОПАСНОСТЬ: куки — это полный доступ к кабинету. Файл с куками gitignored,
// значения кук в логи не пишем. Не коммитить, не пересылать.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { chromium } = await import('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

/** Путь к Chromium: WB_DOCS_BROWSER → PLAYWRIGHT_BROWSERS_PATH/chromium → дефолт PW. */
function resolveBrowser() {
  if (process.env.WB_DOCS_BROWSER) return process.env.WB_DOCS_BROWSER;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base) {
    const link = path.join(base, 'chromium');
    if (fs.existsSync(link)) return link;
  }
  try {
    const ep = chromium.executablePath();
    if (ep && fs.existsSync(ep)) return ep;
  } catch (_) {}
  return undefined;
}

/** sameSite из разных форматов → Playwright ('Strict'|'Lax'|'None'). */
function normSameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'lax' || s === 'unspecified' || s === '') return 'Lax';
  if (s === 'strict') return 'Strict';
  return 'Lax';
}

/**
 * Приводит куки к формату Playwright. Принимает:
 *   • массив объектов (экспорт из Cookie-Editor/EditThisCookie): {name,value,domain,
 *     path,expirationDate|expires,secure,httpOnly,sameSite,…};
 *   • строку заголовка "a=b; c=d" (тогда нужен defaultDomain).
 * @returns {Array<object>} куки для context.addCookies()
 */
export function normalizeCookies(raw, { defaultDomain = '.wildberries.ru' } = {}) {
  let arr;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      arr = Array.isArray(parsed) ? parsed : (parsed.cookies || [parsed]);
    } else {
      // заголовок Cookie: "name=value; name2=value2"
      return trimmed.split(/;\s*/).filter(Boolean).map((pair) => {
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        return { name, value, domain: defaultDomain, path: '/', secure: true, sameSite: 'Lax' };
      });
    }
  } else if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && Array.isArray(raw.cookies)) {
    arr = raw.cookies;
  } else {
    throw new Error('normalizeCookies: неизвестный формат кук');
  }

  return arr.map((c) => {
    const out = {
      name: c.name,
      value: c.value,
      domain: c.domain || defaultDomain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: normSameSite(c.sameSite),
    };
    // expires: приоритет числовому expirationDate/expires; сессионные — без expires.
    const exp = c.expirationDate ?? c.expires;
    if (typeof exp === 'number' && exp > 0) out.expires = Math.floor(exp);
    return out;
  }).filter((c) => c.name && c.value);
}

/** Читает куки из файла (по умолчанию .secrets/wb-cookies.json). */
export function loadCookiesFile(file) {
  const p = file || process.env.WB_COOKIES_FILE ||
    path.join(REPO_ROOT, '.secrets', 'wb-cookies.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      `Файл с куками не найден: ${p}\n` +
      'Залогинься в кабинете WB, выгрузи куки (расширение Cookie-Editor → Export → JSON) ' +
      'и сохрани сюда. Файл gitignored.'
    );
  }
  return { cookies: normalizeCookies(fs.readFileSync(p, 'utf8')), path: p };
}

/**
 * Достаёт куки из первого доступного источника (как резолвер токена):
 *   1) opts.cookies            — переданы напрямую;
 *   2) env WB_COOKIES / WB_COOKIES_JSON — секрет среды (в чат не попадает);
 *   3) файл .secrets/wb-cookies.json (gitignored).
 * @returns {{cookies: Array, source: string}}
 */
export function resolveCookies(opts = {}) {
  if (opts.cookies) return { cookies: normalizeCookies(opts.cookies), source: 'аргумент' };
  const env = process.env.WB_COOKIES || process.env.WB_COOKIES_JSON;
  if (env && env.trim()) return { cookies: normalizeCookies(env), source: 'env:WB_COOKIES' };
  const f = loadCookiesFile(opts.cookiesFile);
  return { cookies: f.cookies, source: `file:${f.path}` };
}

/**
 * Поднимает браузер+контекст с подставленными куками. Возвращает {browser, context, page}.
 * @param {object} opts
 * @param {Array|string} [opts.cookies]     куки (иначе читаем из файла)
 * @param {string}       [opts.cookiesFile] путь к файлу кук
 * @param {string}       [opts.downloadDir] куда сохранять загрузки (XLSX)
 * @param {boolean}      [opts.headless=true]
 */
export async function launchCabinet(opts = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const { cookies, source } = resolveCookies(opts);

  const proxyArgs = proxy ? ['--ssl-version-max=tls1.2', '--ignore-certificate-errors'] : [];
  log(`[cabinet] chromium: ${resolveBrowser() || '(дефолт PW)'} | прокси: ${proxy || 'нет'} | кук: ${cookies.length} | источник: ${source}`);

  const browser = await chromium.launch({
    executablePath: resolveBrowser(),
    headless: opts.headless !== false,
    proxy: proxy ? { server: proxy } : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-quic',
           '--disable-blink-features=AutomationControlled', ...proxyArgs],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: UA,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.addCookies(cookies);

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Открывает URL и ждёт, пока пройдёт антибот и дорисуется SPA.
 * Возвращает {status, title, url, loggedIn(грубая эвристика)}.
 */
export async function openAndSettle(page, url, { timeoutMs = 45000 } = {}) {
  let status = null;
  page.on('response', (r) => { if (r.url() === url) status = r.status(); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('  goto:', e.message.split('\n')[0]));

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const title = await page.title().catch(() => '');
    const len = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
    const challenge = /Почти готово/i.test(title);
    if (!challenge && len > 500) break;
    await page.mouse.move(200 + ((Date.now() / 7) % 300), 300).catch(() => {});
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(1000);

  const title = await page.title().catch(() => '');
  const curUrl = page.url();
  // Грубо: если нас перекинуло на auth/login — сессия невалидна.
  const loggedIn = !/auth|login|passport|signin/i.test(curUrl);
  return { status, title, url: curUrl, loggedIn };
}

export { REPO_ROOT, resolveBrowser };
