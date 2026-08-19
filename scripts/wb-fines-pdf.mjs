// scripts/wb-fines-pdf.mjs — цветной PDF-отчёт по штрафам из результата разбора.
//
//   node scripts/wb-fines-pdf.mjs [reports-output/fines-attribution.json] [--out файл.pdf]
//   npm run fines:pdf
//
// Вход — JSON, который делает scripts/wb-fines-attribution.mjs (там же лежит xlsx).
// Печать — headless-хромиум через lib/renderPdf.js, без внешних ресурсов.

import fs from 'fs';
import path from 'path';
import { finesHtmlDocument } from '../lib/finesReportHtml.js';
import { htmlToPdf } from '../lib/renderPdf.js';

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--')) || 'reports-output/fines-attribution.json';
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : path.join(path.dirname(src), 'fines-report.pdf');

if (!fs.existsSync(src)) {
  console.error(`Нет файла ${src}. Сначала: npm run fines:attr -- <выгрузка.xlsx>`);
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!Array.isArray(rows) || !rows.length) {
  console.error('В файле нет строк штрафов.');
  process.exit(1);
}

const html = finesHtmlDocument(rows, { file: process.env.WB_FINES_SOURCE || '' });
fs.mkdirSync(path.dirname(out), { recursive: true });
htmlToPdf(html, out);
console.log(`PDF: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} КБ, строк: ${rows.length})`);
