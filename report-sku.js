// report-sku.js — годовой отчёт по конкретным артикулам WB (выручка, «заработал»,
// упущенная выручка) с фото, кликабельными артикулом/брендом. PDF + HTML.
//
// Запуск:
//   MPSTATS_TOKEN=xxx node report-sku.js 881535653 188207534 806472155
//   MPSTATS_TOKEN=xxx node report-sku.js "https://www.wildberries.ru/catalog/881535653/detail.aspx" ...
//   период (env, необязательно): SKU_D1=2025-08-19 SKU_D2=2026-08-18  (по умолч. последние ~365 дн.)
//   заголовок: SKU_TITLE="..."  ·  без PDF: SKU_PDF=0
import fs from 'fs';
import path from 'path';
import { buildSkuReport, parseSku } from './lib/skuReport.js';
import { buildSkuReportHtml } from './lib/skuReportHtml.js';
import { htmlToPdf } from './lib/renderPdf.js';

function yearPeriod() {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 364 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { d1: iso(start), d2: iso(end) };
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const skus = args.map(parseSku).filter(Boolean);
  if (!skus.length) {
    console.error('Укажите артикулы или ссылки: node report-sku.js 881535653 188207534 ...');
    process.exit(1);
  }
  const d1 = process.env.SKU_D1 || yearPeriod().d1;
  const d2 = process.env.SKU_D2 || yearPeriod().d2;
  const title = process.env.SKU_TITLE || `Годовая аналитика по ${skus.length} артикулам`;

  console.error(`Артикулы: ${skus.join(', ')}`);
  console.error(`Период: ${d1}…${d2}`);
  console.error('Загрузка карточек, продаж и фото…');

  const { products, summary } = await buildSkuReport({
    skus, d1, d2,
    onProgress: (i, n) => process.stderr.write(`  артикул ${i}/${n}\r`),
  });
  summary.title = title;
  console.error('');

  // Консоль-сводка.
  console.log(`\n${title}  ·  ${d1}…${d2}`);
  console.log(`  Суммарно: выручка ${(summary.revenueSum / 1e6).toFixed(2)} млн ₽ · заработал ${summary.earnedSum ? (summary.earnedSum / 1e6).toFixed(2) + ' млн ₽' : '—'} · упущено ${(summary.lostSum / 1e6).toFixed(2)} млн ₽\n`);
  for (const p of products) {
    console.log(`  арт. ${p.sku} · ${p.brand || '—'}`);
    console.log(`     выручка ${(p.revenue / 1e6).toFixed(2)} млн ₽ | заработал ${p.earned != null ? (p.earned / 1e6).toFixed(2) + ' млн ₽' : '—'} | упущено ${(p.lostProfit / 1e6).toFixed(2)} млн ₽ | ${p.units} шт | выкуп ${p.buyoutPct || '—'}%`);
    console.log(`     ${p.url}`);
    if (!p.hadFull) console.log('     ⚠ карточка /full не получена (проверьте лимит API/артикул)');
  }

  const outDir = path.resolve('reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = `sku-${skus.join('-')}-${d1}_${d2}`.slice(0, 120);
  const htmlPath = path.join(outDir, `${slug}.html`);
  const jsonPath = path.join(outDir, `${slug}.json`);
  const html = buildSkuReportHtml({ products, summary });
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, products: products.map(({ img, ...p }) => ({ ...p, hasImg: !!img })) }, null, 2));

  const files = [htmlPath, jsonPath];
  if (process.env.SKU_PDF !== '0') {
    const pdfPath = path.join(outDir, `${slug}.pdf`);
    try { htmlToPdf(html, pdfPath); files.unshift(pdfPath); }
    catch (e) { console.error('PDF не отрендерен:', e.message); }
  }
  console.log('\nФайлы:');
  for (const f of files) console.log('  ' + f);
}

main().catch((e) => { console.error('Ошибка:', e?.stack || e?.message || e); process.exit(1); });
