// scripts/wb-cards-compare.mjs — автоматизация отчёта «Сравнение карточек»
// (кабинет WB, раздел Аналитика развития бизнеса → Сравнение карточек).
// Это UI-функция Джема, в API её нет — работаем в браузере с сессией пользователя.
//
// Страница: https://seller.wildberries.ru/platform-analytics/cards-comparison
// Сессия берётся из .secrets (куки + localStorage-токен), см. lib/wbCabinet.js.
//
// Флоу формы: «Сравнить карточки» → для каждого артикула ввести в поле
// «Введите артикул WB» и нажать «Добавить» → правая панель «N из 5» →
// «Сравнить карточки» (тратит 1 сравнение из лимита) → выгрузка XLSX.
//
// БЕЗОПАСНОСТЬ ЛИМИТА: по умолчанию DRY-RUN — добавляет карточки и делает скрин
// «N из 5», НО НЕ запускает сравнение (лимит не тратится). Запуск и выгрузка —
// только с флагом --submit.
//
// Использование:
//   node scripts/wb-cards-compare.mjs --our 167477208 --rivals 185854387,220692898,583508825,844264052
//   node scripts/wb-cards-compare.mjs --our ... --rivals ... --submit --out reports-output/compare.xlsx
//
// Флаги: --our <nm>  --rivals <nm,nm,...>  [--articles <nm,nm,...>]  [--submit]  [--out <xlsx>]  [--headful]

import fs from 'fs';
import path from 'path';
import { launchCabinet, openAndSettle } from '../lib/wbCabinet.js';

const CMP_URL = 'https://seller.wildberries.ru/platform-analytics/cards-comparison';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2); const n = args[i + 1];
    if (n && !n.startsWith('--')) { opt[k] = n; i++; } else opt[k] = true;
  }
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// Список артикулов: --articles перебивает; иначе our + rivals.
const list = (opt.articles || [opt.our, opt.rivals].filter(Boolean).join(','))
  .split(',').map((s) => String(s).trim()).filter(Boolean);

if (list.length < 2 || list.length > 5) {
  log('Нужно от 2 до 5 артикулов. Пример:');
  log('  node scripts/wb-cards-compare.mjs --our 167477208 --rivals 185854387,220692898,583508825,844264052');
  process.exit(2);
}
const SUBMIT = !!opt.submit;
const OUT = opt.out || `reports-output/cards-compare-${list.join('_')}.xlsx`;

const { browser, page } = await launchCabinet({ headless: !opt.headful });
try {
  log(`→ открываю страницу «Сравнение карточек»`);
  const info = await openAndSettle(page, CMP_URL);
  if (!info.loggedIn) throw new Error('Сессия невалидна (перекинуло на auth). Обнови куки/localStorage в .secrets.');
  await page.getByText('Принимаю', { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(1500);

  // Открыть форму создания сравнения.
  log('  жму «Сравнить карточки» (открыть форму)');
  await page.getByRole('button', { name: /^Сравнить карточки/ }).first().click()
    .catch(async () => { await page.getByText('Сравнить карточки', { exact: false }).first().click(); });
  await page.waitForSelector('input[placeholder="Введите артикул WB"]', { timeout: 20000 });
  await page.waitForTimeout(1000);

  // Добавляем каждый артикул: ввод → Enter → кнопка «Добавить».
  const input = page.locator('input[placeholder="Введите артикул WB"]');
  for (const nm of list) {
    log(`  + артикул ${nm}`);
    await input.click();
    await input.fill('');
    await input.type(String(nm), { delay: 40 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500); // ждём, пока подтянется карточка
    // Кнопка «Добавить» у найденной карточки (в левой панели).
    const addBtn = page.getByRole('button', { name: /^Добавить$/ }).first();
    if (await addBtn.count()) {
      await addBtn.click().catch(() => log(`    ⚠ не удалось нажать «Добавить» для ${nm}`));
    } else {
      log(`    ⚠ карточка ${nm} не найдена или «Добавить» не появилась`);
    }
    await page.waitForTimeout(1500);
  }

  // Скрин состояния (сколько добавлено).
  fs.mkdirSync('.secrets', { recursive: true });
  await page.screenshot({ path: '.secrets/cmp-filled.png' }).catch(() => {});
  const counter = await page.getByText(/Карточки для сравнения:\s*\d+\s*из\s*5/i).first().textContent().catch(() => '');
  log(`  состояние: ${counter || '(счётчик не прочитан)'} | скрин: .secrets/cmp-filled.png`);

  if (!SUBMIT) {
    log('\nDRY-RUN: сравнение НЕ запущено (лимит не потрачен). Проверь .secrets/cmp-filled.png.');
    log('Если всё верно — перезапусти с --submit, и я запущу сравнение и скачаю XLSX.');
    process.exit(0);
  }

  // Запуск сравнения (тратит 1 из лимита) + выгрузка XLSX.
  log('  запускаю сравнение (--submit)…');
  const submitBtn = page.getByRole('button', { name: /^Сравнить карточки/ }).last();
  await submitBtn.click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: '.secrets/cmp-result.png' }).catch(() => {});

  // Ищем кнопку выгрузки (XLSX/Скачать/Экспорт) и ловим загрузку.
  const dlTrigger = page.getByRole('button', { name: /скач|xlsx|экспорт|выгруз/i }).first();
  if (await dlTrigger.count()) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dlTrigger.click(),
    ]);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await download.saveAs(OUT);
    log(`✓ отчёт сохранён: ${OUT}`);
  } else {
    log('  ⚠ кнопка выгрузки не найдена — отчёт открыт на странице (.secrets/cmp-result.png). Селектор выгрузки уточним по скрину.');
  }
} catch (err) {
  await page.screenshot({ path: '.secrets/cmp-error.png' }).catch(() => {});
  log('Ошибка:', err?.message || err, '| скрин: .secrets/cmp-error.png');
  process.exit(1);
} finally {
  await browser.close();
}
