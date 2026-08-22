// report-shirts.js — единый отчёт: рынок мужских рубашек + разбор 3 артикулов
// (деньги, характеристики, запросы, отзывы+классификация, диагональное сканирование)
// + ниша топ-10 + расцветки/размеры. PDF + HTML.
//
// Запуск: MPSTATS_TOKEN=xxx node report-shirts.js 881535653 188207534 806472155
//   период (env): SHIRTS_D1 / SHIRTS_D2 (по умолч. ~год); без PDF: SHIRTS_PDF=0
import fs from 'fs';
import path from 'path';
import { buildShirtsData } from './lib/shirtsData.js';
import { buildShirtsReportHtml } from './lib/shirtsReportHtml.js';
import { htmlToPdf } from './lib/renderPdf.js';

function yearPeriod() {
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 364 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { d1: iso(start), d2: iso(end) };
}

function parseSku(s) { const m = String(s).match(/catalog\/(\d+)/) || String(s).match(/(\d{5,})/); return m ? Number(m[1]) : null; }

async function main() {
  const skus = process.argv.slice(2).map(parseSku).filter(Boolean);
  if (!skus.length) { console.error('Укажите артикулы: node report-shirts.js 881535653 188207534 806472155'); process.exit(1); }
  const d1 = process.env.SHIRTS_D1 || yearPeriod().d1;
  const d2 = process.env.SHIRTS_D2 || yearPeriod().d2;

  console.error(`Артикулы: ${skus.join(', ')} · период ${d1}…${d2}`);
  const data = await buildShirtsData({
    skus, d1, d2,
    onProgress: (stage, i, n) => process.stderr.write(stage === 'market' ? '  рынок (ниша, топ-300, размеры)…\r' : `  артикул ${i}/${n} (деньги, карточка, отзывы, сканирование)\r`),
  });
  console.error('');

  // Консоль-сводка.
  const mk = data.market.market;
  console.log(`\nРынок «мужские рубашки с длинным рукавом»: ${(mk.revenueSum / 1e9).toFixed(2)} млрд ₽ · упущено ${(mk.lostSum / 1e9).toFixed(2)} млрд ₽ (${(mk.lostShare * 100).toFixed(1)}%)`);
  console.log(`Тип: ${data.market.typeCount} карточек, с продажами ${data.market.withSalesCount}`);
  for (const a of data.articles) {
    console.log(`\nарт. ${a.sku} · ${a.brand} — ${a.name.slice(0, 44)}`);
    console.log(`   выручка ${(a.money.revenue / 1e6).toFixed(1)}М | заработал ${a.money.earned != null ? (a.money.earned / 1e6).toFixed(1) + 'М' : '—'} | упущено ${(a.money.lost / 1e6).toFixed(1)}М | отзывов ${a.reviews.total} (★${a.reviews.valuation})`);
    console.log(`   проблемы: ${a.reviews.problems.map((p) => p.label).slice(0, 3).join(', ') || '—'}`);
    console.log(`   диаг.скан: позиция ${a.scan.ownRank ?? 'не в топе'}, гэпов ${a.scan.gaps.length}`);
  }
  console.log(`\nРасцветки: ${data.market.top300.colorDist.slice(0, 3).map((c) => c.color + ' ' + Math.round(c.share * 100) + '%').join(', ')}`);
  console.log(`Преобладающие размеры: ${data.market.dominantSizes.slice(0, 5).map((s) => s.size).join(', ')}`);

  const outDir = path.resolve('reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = `shirts-analysis-${skus.join('-')}-${d1}_${d2}`.slice(0, 120);
  const htmlPath = path.join(outDir, `${slug}.html`);
  const jsonPath = path.join(outDir, `${slug}.json`);
  const html = buildShirtsReportHtml(data);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify({
    ...data,
    articles: data.articles.map(({ img, ...a }) => ({ ...a, hasImg: !!img, reviews: { ...a.reviews, } })),
    market: { ...data.market, top10: data.market.top10.map(({ img, ...p }) => ({ ...p, hasImg: !!img })) },
  }, null, 2));

  const files = [htmlPath, jsonPath];
  if (process.env.SHIRTS_PDF !== '0') {
    const pdfPath = path.join(outDir, `${slug}.pdf`);
    try { htmlToPdf(html, pdfPath); files.unshift(pdfPath); } catch (e) { console.error('PDF не отрендерен:', e.message); }
  }
  console.log('\nФайлы:');
  for (const f of files) console.log('  ' + f);
}

main().catch((e) => { console.error('Ошибка:', e?.stack || e?.message || e); process.exit(1); });
