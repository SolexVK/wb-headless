// lib/renderPdf.js — печать HTML в PDF через headless-хромиум (без npm-зависимостей).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/** Находит бинарь Chromium: env, стандартные пути, каталог Playwright. */
export function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, process.env.CHROME_PATH, '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  try {
    const base = '/opt/pw-browsers';
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('chromium-')) continue;
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return null;
}

/** Рендерит HTML-строку в PDF по пути pdfPath. Бросает, если Chromium не найден. */
export function htmlToPdf(html, pdfPath) {
  const chromium = findChromium();
  if (!chromium) throw new Error('Chromium не найден (задайте CHROMIUM_PATH)');
  const tmpHtml = pdfPath.replace(/\.pdf$/i, '') + '.render.html';
  fs.writeFileSync(tmpHtml, html);
  try {
    execFileSync(
      chromium,
      ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, `file://${path.resolve(tmpHtml)}`],
      { stdio: 'ignore', timeout: 60000 }
    );
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
  }
  return pdfPath;
}
