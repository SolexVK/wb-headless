// scripts/html-to-pdf.mjs — рендер готовой HTML-страницы в PDF через системный
// Chrome/Chromium (флаг --print-to-pdf). НЕ требует npm-пакета playwright и
// установки браузеров: берём любой уже установленный Chrome/Chromium/Edge/Brave.
//   node scripts/html-to-pdf.mjs <input.html> <output.pdf> [--landscape]
// Ориентация/поля берутся из @media print самой страницы (@page size:A4 landscape).
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const [inHtml, outPdf] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!inHtml || !outPdf) { process.stderr.write('usage: html-to-pdf.mjs <in.html> <out.pdf> [--landscape]\n'); process.exit(2); }

// Кандидаты на бинарник Chrome/Chromium: env → macOS-приложения → linux → Playwright/Puppeteer.
function candidates() {
  const c = [];
  for (const e of ['WB_CHROME', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'WB_DOCS_BROWSER']) if (process.env[e]) c.push(process.env[e]);
  const home = process.env.HOME || '';
  const macApps = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Yandex.app/Contents/MacOS/Yandex',
  ];
  for (const p of macApps) { c.push(p); if (home) c.push(home + p); }
  c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge');
  // Playwright-браузеры (если вдруг стоят) и puppeteer ./chrome.
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(REPO, 'chrome'), path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  for (const base of roots) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (!/chrom/i.test(d)) continue;
        c.push(
          path.join(base, d, 'chrome-linux', 'chrome'),
          path.join(base, d, 'chrome-linux64', 'chrome'),
          path.join(base, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          path.join(base, d, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(base, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        );
      }
    } catch { /* нет каталога */ }
  }
  return c;
}
function resolveBrowser() {
  for (const c of candidates()) { try { if (c && fs.existsSync(c)) return c; } catch { /* */ } }
  return null;
}

const bin = resolveBrowser();
if (!bin) {
  process.stderr.write('Не найден Chrome/Chromium для сборки PDF. Установите Google Chrome (или задайте путь в переменной WB_CHROME). HTML-дашборд можно сохранить в PDF из браузера: Печать → Сохранить как PDF.\n');
  process.exit(3);
}

const abs = 'file://' + path.resolve(inHtml);
const baseArgs = [
  '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb',
  '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=6000',
  `--print-to-pdf=${path.resolve(outPdf)}`, abs,
];
fs.mkdirSync(path.dirname(path.resolve(outPdf)), { recursive: true });

// Разные версии Chrome: пробуем --headless=new, затем --headless (старые сборки).
let ok = false, lastErr = '';
for (const hl of ['--headless=new', '--headless']) {
  try { fs.rmSync(outPdf, { force: true }); } catch { /* */ }
  const r = spawnSync(bin, [hl, ...baseArgs], { timeout: 120000, encoding: 'utf8' });
  lastErr = (r.stderr || '') + (r.error ? r.error.message : '');
  if (fs.existsSync(outPdf) && fs.statSync(outPdf).size > 800) { ok = true; break; }
}
if (!ok) { process.stderr.write('Chrome не смог собрать PDF (' + bin + '):\n' + lastErr.slice(-1500) + '\n'); process.exit(4); }
process.stderr.write(`→ PDF: ${outPdf} (${(fs.statSync(outPdf).size / 1024).toFixed(1)} КБ, ${path.basename(bin)})\n`);
