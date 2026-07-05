// scripts/wb-top-keywords.mjs — CLI инструмента [1] «ТОП-N по ключевому запросу».
// Логика — в lib/wbTopKeywords.js (её же можно звать напрямую из оркестратора).
//
// По ключевому слову берём поисковую выдачу WB из MPSTATS, фильтруем по
// «уточнениям» и печатаем топ-N конкурентов. Требует MPSTATS_TOKEN в окружении.
//
// Печать: контракт top-rivals (JSON) в stdout — можно писать в файл (--out) и/или
// пайпить массив nmId дальше в «Сравнение карточек».
//
//   MPSTATS_TOKEN=xxx node scripts/wb-top-keywords.mjs --query "платье женское" --top 10
//   ... --min-revenue 100000 --min-rating 4.5 --price-min 800 --price-max 3000 --sort revenue
//   ... --our 167477208 --out reports-output/top-rivals.json
//   # сцепка каскада [1]→[2]:
//   node scripts/wb-top-keywords.mjs --query "платье" --nmids-only | \
//     node scripts/wb-cards-compare.mjs --our 167477208

import { topByKeywords } from '../lib/wbTopKeywords.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    const n = args[i + 1];
    if (n && !n.startsWith('--')) { opt[k] = n; i++; } else opt[k] = true;
  }
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const numOpt = (v) => (v == null ? undefined : Number(v));

if (!opt.query) {
  log('Не задан ключевой запрос. Пример:');
  log('  MPSTATS_TOKEN=xxx node scripts/wb-top-keywords.mjs --query "платье женское" --top 10 --min-rating 4.5');
  process.exit(2);
}

const filters = {
  minRevenue: numOpt(opt['min-revenue']),
  minRating: numOpt(opt['min-rating']),
  minReviews: numOpt(opt['min-reviews']),
  minSales: numOpt(opt['min-sales']),
  priceMin: numOpt(opt['price-min']),
  priceMax: numOpt(opt['price-max']),
  excludeBrands: opt['exclude-brands']
    ? String(opt['exclude-brands']).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined,
  sortBy: opt.sort || 'position',
};
// Убираем неуказанные пороги, чтобы не отфильтровать всё нулями.
for (const k of Object.keys(filters)) if (filters[k] === undefined) delete filters[k];

try {
  const res = await topByKeywords({
    query: opt.query,
    topN: numOpt(opt.top) ?? 10,
    filters,
    our: opt.our,
    d1: opt.d1,
    d2: opt.d2,
    limit: numOpt(opt.limit) ?? 100,
  });

  log(`Запрос: «${res.query}» — из выдачи ${res.fetched} шт., после фильтров топ-${res.rivals.length}.`);

  // --nmids-only: печатаем голый JSON-массив nmId (для пайпа в wb-cards-compare).
  const payload = opt['nmids-only']
    ? res.rivals.map((r) => r.nmId)
    : res;
  const out = JSON.stringify(payload, null, opt['nmids-only'] ? 0 : 2);

  if (opt.out) {
    mkdirSync(dirname(opt.out), { recursive: true });
    writeFileSync(opt.out, out);
    log(`Записано: ${opt.out}`);
  } else {
    process.stdout.write(out + '\n');
  }
} catch (err) {
  log(`Ошибка: ${err?.message || err}`);
  if (/MPSTATS_TOKEN/.test(String(err?.message))) {
    log('Задай токен MPSTATS: MPSTATS_TOKEN=... (заголовок X-Mpstats-TOKEN).');
  }
  process.exit(1);
}
