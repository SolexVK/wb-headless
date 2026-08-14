// scripts/html-to-pdf.mjs — рендер готовой HTML-страницы в PDF встроенным Chromium.
//   node scripts/html-to-pdf.mjs <input.html> <output.pdf> [--landscape]
// Печать заточена под @media print самой страницы (A4, разрывы, точная цветопередача).
import fs from 'fs';
import path from 'path';

const [inHtml, outPdf] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const landscape = process.argv.includes('--landscape');
if (!inHtml || !outPdf) { process.stderr.write('usage: html-to-pdf.mjs <in.html> <out.pdf> [--landscape]\n'); process.exit(2); }

// Ищем исполняемый Chromium в разных раскладках Playwright (linux/mac, версии).
function resolveBrowser() {
  const cands = [];
  if (process.env.WB_DOCS_BROWSER) cands.push(process.env.WB_DOCS_BROWSER);
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium'))) {
      cands.push(
        path.join(base, d, 'chrome-linux', 'chrome'),
        path.join(base, d, 'chrome-linux', 'headless_shell'),
        path.join(base, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      );
    }
  }
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* */ } }
  return undefined; // пусть Playwright решит сам
}

const { chromium } = await import('playwright');
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: resolveBrowser(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (e) {
  process.stderr.write('Не удалось запустить Chromium для PDF. Установите браузер: npx playwright install chromium\n' + e.message + '\n');
  process.exit(3);
}
try {
  const page = await browser.newPage();
  await page.setContent(fs.readFileSync(inHtml, 'utf8'), { waitUntil: 'networkidle' });
  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  await page.pdf({ path: outPdf, format: 'A4', landscape, printBackground: true, preferCSSPageSize: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  process.stderr.write(`→ PDF: ${outPdf} (${(fs.statSync(outPdf).size / 1024).toFixed(1)} КБ)\n`);
} finally {
  await browser.close();
}
