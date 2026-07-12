// scripts/wb-cabinet-open.mjs — РАЗВЕДКА кабинета WB с подставленными куками.
//
// Заходит в кабинет от имени пользовательской сессии (куки), открывает нужную
// страницу и выгружает всё, что поможет собрать автоматизацию отчёта
// «Сравнение карточек»: статус логина, URL, видимый текст, поля ввода, кнопки,
// ссылки со словом «сравн», скриншот.
//
// Использование:
//   node scripts/wb-cabinet-open.mjs                       # открыть главную кабинета
//   node scripts/wb-cabinet-open.mjs --url <URL>           # открыть конкретную страницу
//   node scripts/wb-cabinet-open.mjs --cookies <файл>      # куки из своего файла
//   node scripts/wb-cabinet-open.mjs --out cabinet-cmp     # префикс для дампов
//
// Куки по умолчанию — .secrets/wb-cookies.json (gitignored). Значения не печатаем.

import fs from 'fs';
import { launchCabinet, openAndSettle } from '../lib/wbCabinet.js';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2); const n = args[i + 1];
    if (n && !n.startsWith('--')) { opt[k] = n; i++; } else opt[k] = true;
  }
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const URL = opt.url || 'https://seller.wildberries.ru/';
const OUT = opt.out || 'cabinet-last';

const { browser, page } = await launchCabinet({ cookiesFile: opt.cookies });
try {
  log(`→ открываю: ${URL}`);
  const info = await openAndSettle(page, URL);
  log(`  статус: ${info.status} | залогинен: ${info.loggedIn ? 'ДА' : 'НЕТ (перекинуло на auth?)'}`);
  log(`  URL после загрузки: ${info.url}`);
  log(`  title: ${info.title}`);

  // Видимый текст.
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  fs.writeFileSync(`${OUT}.txt`, text);

  // Кандидаты-селекторы: поля ввода, кнопки, ссылки со «сравн».
  const ui = await page.evaluate(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      dataqa: el.getAttribute('data-qa') || el.getAttribute('data-testid') || '',
      text: (el.textContent || '').trim().slice(0, 60),
      href: el.getAttribute('href') || '',
      id: el.id || '',
    });
    const inputs = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(pick);
    const buttons = [...document.querySelectorAll('button,[role="button"]')].map(pick);
    const links = [...document.querySelectorAll('a')]
      .map(pick)
      .filter((a) => /сравн|compar/i.test(a.text) || /compar|sravn/i.test(a.href));
    return { inputs, buttons, links };
  }).catch(() => ({ inputs: [], buttons: [], links: [] }));

  fs.writeFileSync(`${OUT}.ui.json`, JSON.stringify(ui, null, 2));
  await page.screenshot({ path: `${OUT}.png`, fullPage: true }).catch(() => {});

  log(`\nДампы: ${OUT}.txt (текст), ${OUT}.ui.json (поля/кнопки/ссылки), ${OUT}.png (скрин)`);
  log(`inputs: ${ui.inputs.length} | buttons: ${ui.buttons.length} | ссылки со «сравн»: ${ui.links.length}`);
  if (ui.links.length) {
    log('Ссылки со «сравн»:');
    ui.links.slice(0, 10).forEach((l) => log(`  • "${l.text}" → ${l.href}`));
  }
  process.exit(info.loggedIn ? 0 : 2);
} finally {
  await browser.close();
}
