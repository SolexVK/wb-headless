// lib/htmlToPdf.js — рендер HTML в PDF через headless Chromium (Playwright).
//
// В managed-окружении Playwright может не найти свой бинарь (версия не совпадает),
// поэтому резолвим Chromium сами: env WB_PDF_BROWSER → PLAYWRIGHT_BROWSERS_PATH/
// chromium-*/chrome-linux/chrome → дефолт Playwright.

import { readdirSync, existsSync } from 'node:fs';

function resolveChromium() {
  const envPath = process.env.WB_PDF_BROWSER;
  if (envPath && existsSync(envPath)) return envPath;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = `${base}/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch (_) { /* нет каталога — пусть Playwright сам */ }
  return undefined;
}

/**
 * Рендерит HTML-строку в PDF-файл.
 * @param {string} html   полный HTML-документ
 * @param {string} outPath путь к .pdf
 * @param {object} opts   { format='A4', printBackground=true, landscape=false }
 */
export async function htmlToPdf(html, outPath, opts = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: opts.format || 'A4',
      printBackground: opts.printBackground !== false,
      landscape: !!opts.landscape,
    });
  } finally {
    await browser.close();
  }
  return outPath;
}

export { resolveChromium };
