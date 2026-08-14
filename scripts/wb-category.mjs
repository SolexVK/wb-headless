// scripts/wb-category.mjs — резолвер пути категории WB по словам.
// Печатает подходящие пути из дерева MPStats — выбери нужный для report-niche.js.
//
// Запуск:
//   node scripts/wb-category.mjs женские рубашки
//   node scripts/wb-category.mjs Женщинам Платья

import { fetchCategories } from '../lib/mpstats.js';

const words = process.argv.slice(2).join(' ').trim();
if (!words) {
  console.error('Укажите слова: node scripts/wb-category.mjs <слова ниши>');
  process.exit(1);
}

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
// корень слова (срезаем частые окончания) — «рубашки»→«рубашк»
const stem = (w) => norm(w).replace(/(ами|ах|ов|ев|ая|яя|ое|ые|ый|ий|ой|ом|ую|ю|а|я|и|ы|е|ь)$/, '');
// синонимы пола → корень раздела дерева (женские→Женщинам, мужские→Мужчинам, детские→Детям)
const GENDER = [
  [/^жен(ск|щ|$)/, 'женщ'], [/^муж(ск|ч|$)/, 'мужч'],
  [/^дет|^девоч|^мальчик|^малыш/, 'дет'],
];
const toStem = (w) => {
  const n = norm(w);
  for (const [re, root] of GENDER) if (re.test(n)) return root;
  return stem(w);
};
const stems = words.split(/\s+/).map(toStem).filter(Boolean);

const cats = await fetchCategories();
if (!cats.length) {
  console.error('Дерево категорий пусто (проверьте MPSTATS_TOKEN).');
  process.exit(1);
}

// оставляем пути, где встречается КАЖДЫЙ корень; исключаем «Акции».
const hits = cats.filter((c) => {
  const p = norm(c.path || '');
  return !/акци/.test(p) && stems.every((st) => p.includes(st));
});
// сортируем: сначала короткие пути (ближе к корню категории), потом по алфавиту.
hits.sort((a, b) => (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path));

console.log(`Найдено путей: ${hits.length} (по словам: ${words})\n`);
for (const c of hits.slice(0, 25)) console.log('  ' + c.path);
if (!hits.length) console.log('  ничего — попробуйте другие слова (пол + предмет).');
console.log('\nСкопируйте нужный путь в NICHE_PATH / первый аргумент report-niche.js.');
