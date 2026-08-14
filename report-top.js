// report-top.js — отчёт «Топ-N товаров» по категории WB (фото, ссылки, бренд,
// выручка/цена/остатки/склады, динамика) в PDF + HTML.
//
// Запуск:
//   MPSTATS_TOKEN=xxx TOP_PLUS="полоска" TOP_MINUS="короткий" TOP_N=10 \
//     node report-top.js "Мужчинам/Рубашки" 2026-07-15 2026-08-13 "Топ-10 рубашек в полоску"
//
// Переменные окружения:
//   TOP_PLUS   — корни, которые ВСЕ должны быть в названии (через запятую)
//   TOP_MINUS  — корни, которых не должно быть
//   TOP_N      — сколько товаров (по умолч. 10)
//   TOP_TITLE  — заголовок отчёта (иначе — 4-й аргумент или дефолт)
//   TOP_PDF=0  — не рендерить PDF
import fs from 'fs';
import path from 'path';
import { buildTopProducts } from './lib/topProducts.js';
import { buildTopProductsHtml } from './lib/topProductsHtml.js';
import { htmlToPdf } from './lib/renderPdf.js';

function defaultPeriod(days = 30) {
  // последние N дней, оканчивая вчера (данные за сегодня неполные)
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { d1: iso(start), d2: iso(end) };
}

async function main() {
  const [, , argCat, argD1, argD2, argTitle] = process.argv;
  const categoryPath = argCat || process.env.TOP_PATH;
  if (!categoryPath) {
    console.error('Укажите путь категории: node report-top.js "Мужчинам/Рубашки" [d1 d2] ["Заголовок"]');
    process.exit(1);
  }
  const { d1, d2 } =
    argD1 && argD2 ? { d1: argD1, d2: argD2 } : defaultPeriod(Number(process.env.TOP_DAYS) || 30);
  const plus = process.env.TOP_PLUS || '';
  const minus = process.env.TOP_MINUS || '';
  const topN = Number(process.env.TOP_N) || 10;
  const title = process.env.TOP_TITLE || argTitle || `Топ-${topN} товаров`;

  console.error(`Категория: ${categoryPath} · период ${d1}…${d2}`);
  console.error(`Фильтр — плюс: ${plus || '—'} | минус: ${minus || '—'} | топ-${topN}`);
  console.error('Загрузка категории и фото…');

  const { products, summary } = await buildTopProducts({
    categoryPath, d1, d2, plus, minus, topN,
    maxRows: Number(process.env.TOP_MAX_ROWS) || 5000,
    onProgress: (i, n) => process.stderr.write(`  фото ${i}/${n}\r`),
  });
  summary.title = title;

  if (!products.length) {
    console.error('Под фильтр не попал ни один товар. Ослабьте TOP_PLUS/TOP_MINUS.');
    process.exit(2);
  }

  // Консоль-сводка.
  console.error('');
  console.log(`\n${title}`);
  console.log(`  ${categoryPath} · ${d1}…${d2} (${summary.days} дн.)`);
  console.log(`  Суммарная выручка топ-${summary.shown}: ${(summary.revenueSum / 1e6).toFixed(1)} млн ₽ · ${summary.unitsSum} шт · ср. цена ${summary.avgPrice} ₽`);
  console.log(`  Отобрано ${summary.matchedCount} из ${summary.totalInCategory} в категории\n`);
  for (const p of products) {
    console.log(
      `  ${String(p.rank).padStart(2)}. ${(p.revenue / 1e6).toFixed(1)} млн ₽ | ${String(p.units).padStart(4)} шт | ${String(p.price).padStart(4)}₽ | ост ${String(p.balance).padStart(3)} | ${(p.brand || '—').slice(0, 16).padEnd(16)} | ${p.name.slice(0, 42)}`
    );
    console.log(`      ${p.url}`);
  }

  // Файлы.
  const outDir = path.resolve('reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = `top-${categoryPath.replace(/[\/\\]+/g, '_')}-${d1}_${d2}`;
  const htmlPath = path.join(outDir, `${slug}.html`);
  const jsonPath = path.join(outDir, `${slug}.json`);
  const html = buildTopProductsHtml({ products, summary });
  fs.writeFileSync(htmlPath, html);
  // JSON без тяжёлых data-URI (чтобы файл был читаемым).
  const lean = { summary, products: products.map(({ img, ...p }) => ({ ...p, hasImg: !!img })) };
  fs.writeFileSync(jsonPath, JSON.stringify(lean, null, 2));

  const files = [htmlPath, jsonPath];
  if (process.env.TOP_PDF !== '0') {
    const pdfPath = path.join(outDir, `${slug}.pdf`);
    try {
      htmlToPdf(html, pdfPath);
      files.unshift(pdfPath);
    } catch (e) {
      console.error('PDF не отрендерен:', e.message);
    }
  }

  console.log('\nФайлы:');
  for (const f of files) console.log('  ' + f);
}

main().catch((e) => {
  console.error('Ошибка:', e?.stack || e?.message || e);
  process.exit(1);
});
