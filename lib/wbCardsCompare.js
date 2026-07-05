// lib/wbCardsCompare.js — переиспользуемая логика отчёта «Сравнение карточек».
//
// Вынесено из CLI, чтобы ДРУГИЕ инструменты (напр. «Конкурентный анализ» или
// «ТОП-10 по ключевым запросам») могли программно передать сюда артикулы
// конкурентов и запустить сравнение:
//
//   import { runCardsComparison } from './lib/wbCardsCompare.js';
//   const rivals = await getRivalsFromSomeOtherTool();   // [nmId, nmId, ...]
//   await runCardsComparison({ our: 167477208, rivals, submit: true });
//
// Наш артикул задаётся явно (его всегда спрашиваем у пользователя). Конкуренты —
// массив, который можно получить откуда угодно. Всего в сравнении 2–5 карточек.

import fs from 'fs';
import path from 'path';
import { launchCabinet, openAndSettle } from './wbCabinet.js';

export const CARDS_COMPARE_URL =
  'https://seller.wildberries.ru/platform-analytics/cards-comparison';

const noop = () => {};

/**
 * Собирает список артикулов конкурентов из разных источников (для CLI/интеграций):
 *   • массив/строка rivals (csv);
 *   • файл rivalsFile (JSON-массив, или {rivals:[...]}, или csv/по строкам);
 * Возвращает массив строк nmId (без дублей, без пустых).
 */
export function resolveRivals({ rivals, rivalsFile } = {}) {
  let out = [];
  if (Array.isArray(rivals)) out = rivals.slice();
  else if (typeof rivals === 'string' && rivals.trim()) out = rivals.split(/[,\s]+/);
  if (rivalsFile && fs.existsSync(rivalsFile)) {
    const raw = fs.readFileSync(rivalsFile, 'utf8').trim();
    if (raw.startsWith('[') || raw.startsWith('{')) {
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : (j.rivals || j.nmIds || j.articles || []);
      out = out.concat(arr.map((x) => (typeof x === 'object' ? x.nmId ?? x.nm ?? x.id : x)));
    } else {
      out = out.concat(raw.split(/[,\s]+/));
    }
  }
  return [...new Set(out.map((s) => String(s).trim()).filter(Boolean))];
}

/**
 * Прогоняет отчёт «Сравнение карточек» в кабинете.
 * @param {object} a
 * @param {string|number}   a.our       наш артикул (обязателен).
 * @param {Array<string|number>} [a.rivals]  артикулы конкурентов (0–4).
 * @param {boolean} [a.submit=false]    false — DRY-RUN (не тратит лимит); true — запуск+выгрузка.
 * @param {string}  [a.out]             путь для XLSX (при submit).
 * @param {boolean} [a.headful=false]
 * @param {function}[a.log]             куда писать прогресс (по умолчанию stderr).
 * @returns {Promise<object>} результат: {added, dryRun|submitted, counter, screenshot, out?}
 */
export async function runCardsComparison(a = {}) {
  const log = a.log || ((...x) => process.stderr.write(x.join(' ') + '\n'));
  const our = a.our != null ? String(a.our).trim() : '';
  if (!our) throw new Error('runCardsComparison: не задан наш артикул (our)');
  const rivals = (a.rivals || []).map((x) => String(x).trim()).filter(Boolean);
  const list = [...new Set([our, ...rivals])];
  if (list.length < 2 || list.length > 5) {
    throw new Error(`Нужно 2–5 уникальных артикулов (наш + конкуренты), получено ${list.length}: ${list.join(', ')}`);
  }
  const submit = !!a.submit;
  const out = a.out || `reports-output/cards-compare-${list.join('_')}.xlsx`;

  const { browser, page } = await launchCabinet({ headless: !a.headful });
  try {
    log('→ страница «Сравнение карточек»');
    const info = await openAndSettle(page, CARDS_COMPARE_URL);
    if (!info.loggedIn) {
      const e = new Error('SESSION_EXPIRED: сессия кабинета недействительна (перекинуло на авторизацию). ' +
        'Нужны свежие куки и токен: обнови .secrets/wb-cookies.json и .secrets/wb-localstorage.txt.');
      e.sessionExpired = true;
      throw e;
    }
    await page.getByText('Принимаю', { exact: false }).first().click().catch(noop);
    await page.waitForTimeout(1200);

    log('  открываю форму (кнопка «Сравнить карточки»)');
    await page.getByRole('button', { name: /^Сравнить карточки/ }).first().click()
      .catch(async () => { await page.getByText('Сравнить карточки', { exact: false }).first().click(); });
    await page.waitForSelector('input[placeholder="Введите артикул WB"]', { timeout: 20000 });
    await page.waitForTimeout(800);

    const input = page.locator('input[placeholder="Введите артикул WB"]');
    const added = [];
    for (const nm of list) {
      log(`  + ${nm}`);
      await input.click();
      await input.fill('');
      await input.type(nm, { delay: 40 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
      const addBtn = page.getByRole('button', { name: /^Добавить$/ }).first();
      if (await addBtn.count()) {
        await addBtn.click().then(() => added.push(nm))
          .catch(() => log(`    ⚠ не нажалась «Добавить» для ${nm}`));
      } else {
        log(`    ⚠ ${nm}: карточка не найдена / «Добавить» не появилась`);
      }
      await page.waitForTimeout(1200);
    }

    fs.mkdirSync('.secrets', { recursive: true });
    await page.screenshot({ path: '.secrets/cmp-filled.png' }).catch(noop);
    const counter = await page.getByText(/Карточки для сравнения:\s*\d+\s*из\s*5/i)
      .first().textContent().catch(() => '');
    log(`  добавлено: ${added.length}/${list.length} | ${counter || '(счётчик не прочитан)'}`);

    if (!submit) {
      return { added, dryRun: true, counter, screenshot: '.secrets/cmp-filled.png' };
    }

    log('  запускаю сравнение (--submit, тратит 1 из лимита)…');
    await page.getByRole('button', { name: /^Сравнить карточки/ }).last().click();
    await page.waitForTimeout(6000);
    await page.screenshot({ path: '.secrets/cmp-result.png' }).catch(noop);

    const dlTrigger = page.getByRole('button', { name: /скач|xlsx|экспорт|выгруз/i }).first();
    let saved = null;
    if (await dlTrigger.count()) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        dlTrigger.click(),
      ]);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await download.saveAs(out);
      saved = out;
      log(`✓ отчёт сохранён: ${out}`);
    } else {
      log('  ⚠ кнопка выгрузки не найдена — отчёт на странице (.secrets/cmp-result.png), селектор уточним по скрину');
    }
    return { added, submitted: true, counter, out: saved, screenshot: '.secrets/cmp-result.png' };
  } finally {
    await browser.close();
  }
}
