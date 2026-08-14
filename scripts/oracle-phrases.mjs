// scripts/oracle-phrases.mjs — предпросмотр отбора фраз из выгрузки Оракула.
// Показывает, какие фразы пройдут плюс/минус-фильтр (без запросов к MPStats),
// и печатает готовую спецификацию для report-niche.js.
//
// Запуск:
//   node scripts/oracle-phrases.mjs <файл.xlsx|csv> "плюс1,плюс2" "минус1,минус2"
//   NICHE_PLUS="клетка,оверсайз" NICHE_MINUS="летняя,блузка" node scripts/oracle-phrases.mjs oracle.xlsx

import { readOracle, filterPhrases, toQuerySpec } from '../lib/oraclePhrases.js';

const [, , file, plusArg, minusArg] = process.argv;
if (!file) {
  console.error('Укажите файл Оракула: node scripts/oracle-phrases.mjs <файл.xlsx|csv> "плюс" "минус"');
  process.exit(1);
}
const plus = plusArg ?? process.env.NICHE_PLUS ?? '';
const minus = minusArg ?? process.env.NICHE_MINUS ?? '';

const phrases = readOracle(file);
const { selected, rejected } = filterPhrases(phrases, { plus, minus });

const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
console.log(`Прочитано фраз: ${phrases.length}`);
console.log(`Плюс-ключи: ${plus || '—'}`);
console.log(`Минус-ключи: ${minus || '—'}`);
console.log(`\nОТОБРАНО: ${selected.length} (сортировка по спрос:предложение ↓)\n`);
console.log('спрос:предл | частота | карточек | фраза | плюс-ключи');
for (const s of selected) {
  const r = s.count ? (s.frequency / s.count).toFixed(1) : '—';
  console.log(`  ${String(r).padStart(4)}:1 | ${fmt(s.frequency).padStart(9)} | ${fmt(s.count).padStart(8)} | ${s.phrase} [${s.plusHit.join('+')}]`);
}

console.log(`\nОтсеяно: ${rejected.length}. Спецификация для report-niche.js (переменная NICHE_QUERY):\n`);
console.log(toQuerySpec(selected));
