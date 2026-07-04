// scripts/fetch-wb-docs.mjs — чтение страниц документации dev.wildberries.ru.
//
// Зачем отдельный инструмент: документация WB закрыта антибот-челленджем
// (`__wbaas/challenges/antibot`) и отрисовывается на клиенте (SPA), поэтому
// обычный HTTP-запрос (curl/fetch) возвращает не текст, а заглушку. Нужен
// настоящий браузер, который: (1) исполнит JS-челлендж и получит cookie-пропуск,
// (2) дорисует контент. Этот скрипт поднимает headless-Chromium и делает это.
//
// ── Обход блокировок (зафиксировано, чтобы не искать заново) ──────────────
//   1. Антибот  → проходится сам настоящим браузером; помогают «стелс»-мелочи:
//      реальный User-Agent, ru-RU локаль, скрытый navigator.webdriver,
//      небольшие «человеческие» паузы и движения мышью.
//   2. MITM-прокси окружения (если задан HTTPS_PROXY) РВЁТ TLS 1.3-хендшейк
//      Chrome из-за расширения ECH (Encrypted Client Hello). Поэтому при
//      наличии прокси опускаем потолок до TLS 1.2 (--ssl-version-max=tls1.2)
//      и игнорируем MITM-сертификат. Без прокси (обычная сеть, CI) — ничего
//      этого не нужно, работает штатный TLS 1.3.
//
// Использование:
//   node scripts/fetch-wb-docs.mjs <URL> [выходной_файл]
//   node scripts/fetch-wb-docs.mjs                       # дефолтный URL → stdout
//
// Примеры:
//   node scripts/fetch-wb-docs.mjs \
//     https://dev.wildberries.ru/docs/openapi/api-information docs/wb-api/limits.md
//
// Переменные окружения:
//   WB_DOCS_BROWSER   — путь к бинарю Chromium (если автопоиск не сработал)
//   HTTPS_PROXY       — если задан, включается воркэраунд TLS 1.2 (см. выше)
//   WB_DOCS_TIMEOUT   — общий тайм-аут прохождения челленджа, мс (по умолч. 90000)

import fs from 'fs';
import path from 'path';

// Импортируем из 'playwright' (полный пакет тянет playwright-core и умеет
// доустанавливать Chromium в CI командой `npx playwright install chromium`).
const { chromium } = await import('playwright');

const DEFAULT_URL = 'https://dev.wildberries.ru/docs/openapi/api-information';
const URL = process.argv[2] || DEFAULT_URL;
const OUT = process.argv[3] || null;
const MAX_MS = Number(process.env.WB_DOCS_TIMEOUT) || 90000;

const log = (...a) => process.stderr.write(a.join(' ') + '\n');

/** Похоже ли, что мы всё ещё на странице антибот-челленджа, а не на доке. */
const isChallenge = (title, html) =>
  /Почти готово/i.test(title || '') ||
  /__wbaas\/challenges\/antibot/i.test(html || '') ||
  /необходимо включить JavaScript/i.test(html || '');

/** Ищем исполняемый Chromium: явный путь → PLAYWRIGHT_BROWSERS_PATH → дефолт PW. */
function resolveBrowser() {
  if (process.env.WB_DOCS_BROWSER) return process.env.WB_DOCS_BROWSER;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base) {
    const link = path.join(base, 'chromium'); // симлинк на chrome в этом окружении
    if (fs.existsSync(link)) return link;
  }
  try {
    const ep = chromium.executablePath(); // штатный путь PW (актуально в CI)
    if (ep && fs.existsSync(ep)) return ep;
  } catch (_) {}
  return undefined; // пусть Playwright решает сам
}

export async function fetchDocText(url = URL, { timeoutMs = MAX_MS } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const executablePath = resolveBrowser();

  // Воркэраунд TLS 1.2 нужен ТОЛЬКО когда трафик идёт через MITM-прокси.
  const proxyArgs = proxy
    ? ['--ssl-version-max=tls1.2', '--ignore-certificate-errors']
    : [];

  log('→ URL:', url);
  log('  прокси:', proxy || '(нет, прямая сеть)');
  log('  chromium:', executablePath || '(дефолт Playwright)');

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    proxy: proxy ? { server: proxy } : undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-quic',
      '--disable-blink-features=AutomationControlled',
      ...proxyArgs,
    ],
  });

  try {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      viewport: { width: 1366, height: 900 },
      timezoneId: 'Europe/Moscow',
    });
    // Прячем очевидный признак автоматизации.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await ctx.newPage();
    let status = null;
    page.on('response', (r) => {
      if (r.url() === url) status = r.status();
    });

    await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch((e) => log('  goto:', e.message.split('\n')[0]));

    // Ждём, пока антибот пропустит и SPA дорисует контент. Страница челленджа
    // сама перезагружается — поэтому каждый вызов оборачиваем в .catch().
    const start = Date.now();
    let passed = false;
    while (Date.now() - start < timeoutMs) {
      const title = await page.title().catch(() => '');
      const html = await page.content().catch(() => '');
      const len = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
      if (!isChallenge(title, html) && len > 800) {
        passed = true;
        break;
      }
      // «Человеческое» шевеление + пауза.
      await page.mouse.move(200 + ((Date.now() / 7) % 300), 300).catch(() => {});
      await page.waitForTimeout(4000);
    }
    await page.waitForTimeout(1500);

    const title = await page.title().catch(() => '');
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

    log('  HTTP:', status, '| челлендж пройден:', passed ? 'ДА' : 'НЕТ', '| символов:', text.length);
    return { url, status, passed, title, text };
  } finally {
    await browser.close();
  }
}

// Запуск как самостоятельного скрипта.
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchDocText(URL)
    .then(({ text, passed }) => {
      if (OUT) {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        // Заголовок со ссылкой на источник — стабильный (без таймстампа),
        // чтобы git-diff показывал только реальные изменения документации.
        const header = `<!-- Источник: ${URL} -->\n` +
          `<!-- Снимок официальной документации WB API. Обновляется скриптом ` +
          `scripts/fetch-wb-docs.mjs. Дату обновления смотрите в истории git. -->\n\n`;
        fs.writeFileSync(OUT, header + text + '\n');
        log('→ сохранено в', OUT);
      } else {
        process.stdout.write(text + '\n');
      }
      process.exit(passed ? 0 : 2); // 2 — челлендж не пройден (контент неполный)
    })
    .catch((err) => {
      log('Ошибка:', err?.message || err);
      process.exit(1);
    });
}
