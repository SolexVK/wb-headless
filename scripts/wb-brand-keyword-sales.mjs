// scripts/wb-brand-keyword-sales.mjs — CLI скилла «Анализ своих товаров по ключевым запросам».
// Логика — в lib/wbBrandKeywordSales.js; PDF — lib/htmlToPdf.js.
//
// По ключевым фразам берёт наши карточки из выдачи WB (MPStats), тянет ФАКТИЧЕСКИЕ
// выкупы из кабинета (WB Statistics, лимит 1 запрос/мин) и делает отчёт (PDF/HTML/JSON)
// по каждому запросу и периоду: сколько штук выкуплено и на какую сумму (+ возвраты).
//
//   node scripts/wb-brand-keyword-sales.mjs \
//     --brands "AIDEMIKO,Aizek" \
//     --phrase "Рубашка муслиновая женская" --phrase "рубашка муслиновая мужская" \
//     --pdf
//   # период с начала года (дефолт) + последние 30 дней; --days N меняет короткий,
//   # --from YYYY-MM-DD переопределяет старт «с начала года».
//   # --sum forPay — считать сумму к перечислению вместо розничной.
//
// Требует env: MPSTATS_TOKEN (выдача) и Wildberries_API (продажи из кабинета).

import { analyzeBrandKeywordSales, formatHtml } from '../lib/wbBrandKeywordSales.js';
import { htmlToPdf } from '../lib/htmlToPdf.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const opt = {};
const phrases = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const n = argv[i + 1];
  const val = n && !n.startsWith('--') ? (i++, n) : true;
  if (k === 'phrase') phrases.push(val);
  else opt[k] = val;
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const listOpt = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

const brands = listOpt(opt.brands);
if (!brands.length || !phrases.length) {
  log('Нужны бренды и хотя бы одна фраза. Пример:');
  log('  node scripts/wb-brand-keyword-sales.mjs --brands "AIDEMIKO,Aizek" \\');
  log('    --phrase "Рубашка муслиновая женская" --phrase "рубашка муслиновая мужская" --pdf');
  process.exit(2);
}

// Периоды: «с начала года» (или --from) + «последние N дней» (--days, дефолт 30).
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = iso(Date.now());
const yearStart = opt.from || `${today.slice(0, 4)}-01-01`;
const days = Number(opt.days) || 30;
const periods = [
  { key: 'ytd', label: `с ${yearStart.slice(5).split('-').reverse().join('.')}`, from: yearStart, to: today },
  { key: 'd30', label: `${days} дн`, from: iso(Date.now() - days * day), to: today },
];
const sumField = opt.sum === 'forPay' ? 'forPay' : 'finishedPrice';

// Имя файла отчёта: <бренды>_<дата>.<ext>
function reportPath(ext) {
  const slug = brands.join('-').toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '').slice(0, 40) || 'brands';
  return `reports-output/анализ-по-запросам_${slug}_${today}.${ext}`;
}

try {
  log(`Бренды: ${brands.join(', ')} | фраз: ${phrases.length} | сумма: ${sumField}`);
  log(`Периоды: ${periods.map((p) => `${p.label} (${p.from}…${p.to})`).join(' | ')}`);

  const result = await analyzeBrandKeywordSales({ brands, phrases, periods, sumField, log });

  // Сводка в stderr.
  const money = (n) => Math.round(n).toLocaleString('ru-RU');
  for (const q of result.queries) {
    log(`\n«${q.phrase}» (${q.brandsMatched.join(', ')}, ${q.nmids} арт.):`);
    for (const p of periods) {
      const v = q.byPeriod[p.key];
      log(`  ${p.label}: выкупов ${v.buyouts}, сумма ${money(v.sum)}₽ (возвр. ${v.returns} на ${money(v.returnSum)}₽)`);
    }
  }

  if (opt.out || (!opt.pdf && !opt.html)) {
    const p = typeof opt.out === 'string' ? opt.out : reportPath('json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(result, null, 2));
    log(`\nJSON: ${p}`);
  }
  if (opt.html || opt.pdf) {
    const html = formatHtml(result, { title: opt.title });
    if (opt.html) {
      const p = typeof opt.html === 'string' ? opt.html : reportPath('html');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, html);
      log(`HTML: ${p}`);
    }
    if (opt.pdf) {
      const p = typeof opt.pdf === 'string' ? opt.pdf : reportPath('pdf');
      mkdirSync(dirname(p), { recursive: true });
      log('Рендерю PDF (Chromium)…');
      await htmlToPdf(html, p);
      log(`PDF: ${p}`);
    }
  }
} catch (err) {
  log(`\nОшибка: ${err?.message || err}`);
  if (/MPSTATS_TOKEN/.test(String(err?.message))) log('Задай MPSTATS_TOKEN (заголовок X-Mpstats-TOKEN).');
  if (/Wildberries_API/.test(String(err?.message))) log('Задай Wildberries_API (токен WB Statistics).');
  process.exit(1);
}
