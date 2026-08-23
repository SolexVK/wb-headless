#!/usr/bin/env node
// scripts/make-ids.mjs — собрать список артикулов категории в текстовый файл.
//
// Зачем отдельный шаг: MPStats требует токен, а Mac Mini, где крутится зрение,
// токена не имеет и иметь не должен. Список собирается там, где токен есть
// (облачная сессия), кладётся в репозиторий и разъезжается обычным git pull.
// Артикулы не секрет, в отличие от токена.
//
// Запуск:
//   node scripts/make-ids.mjs --top 500
//   node scripts/make-ids.mjs --top 2000 --category "Женщинам/Блузки и рубашки/Туника"
//   node scripts/make-ids.mjs --top 500 --min-revenue 1000000 --out data/my-ids.txt

import fs from 'fs';
import path from 'path';
import { loadEnv, requireEnv } from '../lib/loadEnv.js';

loadEnv();
requireEnv('MPSTATS_TOKEN');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const CATEGORY = arg('category', 'Женщинам/Блузки и рубашки/Рубашка');
const TOP = Number(arg('top', 500));
const MIN_REVENUE = Number(arg('min-revenue', 0));
const DAYS = Number(arg('days', 90));

// d2 строго раньше сегодняшнего дня — MPStats не отдаёт незакрытые сутки.
const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
const d2 = day(1);
const d1 = day(DAYS + 1);

const slug = CATEGORY.split('/').pop().toLowerCase()
  .replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '');
const OUT = arg('out', path.resolve(process.cwd(), 'data', `top${TOP}-${slug}.txt`));

const { fetchCategory } = await import('../lib/mpstats.js');
console.log(`Категория: ${CATEGORY}`);
console.log(`Период: ${d1}..${d2} (${DAYS} дн.), верхние ${TOP} по выручке`);

const { items, total } = await fetchCategory(CATEGORY, d1, d2, {
  maxRows: TOP,
  pageSize: 500,
  onPage: (got, all) => process.stdout.write(`  выгружено ${got} из ${all}\r`),
});
process.stdout.write('\n');

let rows = items.filter((i) => i.sku);
if (MIN_REVENUE > 0) {
  const before = rows.length;
  rows = rows.filter((i) => i.revenue >= MIN_REVENUE);
  console.log(`Порог выручки ${MIN_REVENUE.toLocaleString('ru')} ₽: осталось ${rows.length} из ${before}`);
}
if (!rows.length) {
  console.error('Пусто — проверьте путь категории через scripts/wb-category.mjs');
  process.exit(1);
}

const rub = (n) => `${Math.round(n).toLocaleString('ru')} ₽`;
const header = [
  `# ${CATEGORY} — верхние ${rows.length} по выручке за ${d1}..${d2}`,
  `# Всего товаров в категории: ${total}`,
  `# Выручка: первый ${rub(rows[0].revenue)}, последний ${rub(rows.at(-1).revenue)}`,
  '# Собрано там, где есть токен MPStats — машине со зрением он не нужен.',
  `# Обновить: node scripts/make-ids.mjs --top ${TOP}`,
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${header}\n${rows.map((i) => i.sku).join('\n')}\n`);

console.log(`\nЗаписано ${rows.length} артикулов: ${OUT}`);
console.log(`Выручка: первый ${rub(rows[0].revenue)}, последний ${rub(rows.at(-1).revenue)}`);
console.log(`\nДальше на машине со зрением:\n`
  + `  node scripts/vision-run.mjs --stage gate --ids ${path.relative(process.cwd(), OUT)} --cluster 25`);
