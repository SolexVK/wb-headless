// scripts/wb-cards-compare.mjs — CLI отчёта «Сравнение карточек» (кабинет WB).
// Логика — в lib/wbCardsCompare.js (её же вызывают другие инструменты напрямую).
//
// Наш артикул задаётся явно. Конкуренты — из --rivals, --rivals-file (JSON/csv)
// или пайпом (для передачи из «Конкурентного анализа» / «ТОП-10 по запросам»).
//
// По умолчанию DRY-RUN (не тратит лимит). Запуск+выгрузка — с --submit.
//
//   node scripts/wb-cards-compare.mjs --our 167477208 --rivals 185854387,220692898,583508825,844264052
//   node scripts/wb-cards-compare.mjs --our 167477208 --rivals-file rivals.json --submit --out reports-output/cmp.xlsx
//   getRivals | node scripts/wb-cards-compare.mjs --our 167477208   # конкуренты из stdin (JSON-массив/csv)

import { runCardsComparison, resolveRivals } from '../lib/wbCardsCompare.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2); const n = args[i + 1];
    if (n && !n.startsWith('--')) { opt[k] = n; i++; } else opt[k] = true;
  }
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

const stdin = await readStdin();
let rivals = resolveRivals({ rivals: opt.rivals, rivalsFile: opt['rivals-file'] });
if (!rivals.length && stdin) rivals = resolveRivals({ rivals: stdin });

if (!opt.our) {
  log('Не задан наш артикул. Пример:');
  log('  node scripts/wb-cards-compare.mjs --our 167477208 --rivals 185854387,220692898,583508825,844264052');
  process.exit(2);
}

try {
  const res = await runCardsComparison({
    our: opt.our,
    rivals,
    submit: !!opt.submit,
    exportExisting: !!opt['export-existing'],
    out: opt.out,
    headful: !!opt.headful,
    log,
  });
  if (res.exported) {
    log(`\nПере-скачано готовое сравнение (лимит НЕ потрачен): ${res.out || '(файл не пойман)'}`);
  } else if (res.dryRun) {
    log(`\nDRY-RUN: добавлено ${res.added.length}. Лимит НЕ потрачен. Скрин: ${res.screenshot}`);
    log('Проверь скрин и запусти снова с --submit для реального сравнения и выгрузки.');
  } else if (res.submitted) {
    log(`\nГотово. ${res.out ? 'Файл: ' + res.out : 'Отчёт открыт на странице (см. скрин).'}`);
  }
} catch (err) {
  if (err?.sessionExpired) {
    log('\n⛔ СЕССИЯ ПРОТУХЛА. Нужны свежие куки и токен кабинета.');
    log('   Обнови файлы: .secrets/wb-cookies.json (Cookie-Editor → Export JSON)');
    log('   и .secrets/wb-localstorage.txt (localStorage-запись wb-eu-passport-v2.access-token и др.).');
    log('   Затем повтори команду. Проверить сессию: npm run cabinet:check');
    process.exit(3);
  }
  log('Ошибка:', err?.message || err);
  process.exit(1);
}
