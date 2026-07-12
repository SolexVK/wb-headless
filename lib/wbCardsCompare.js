// lib/wbCardsCompare.js — переиспользуемая логика отчёта «Сравнение карточек».
//
// UI-функция Джема (в API её нет). Работаем headless-браузером с сессией
// пользователя (см. lib/wbCabinet.js). Другие инструменты («Конкурентный анализ»,
// «ТОП-10 по запросам») могут передать сюда артикулы конкурентов и запустить:
//   import { runCardsComparison } from './lib/wbCardsCompare.js';
//   await runCardsComparison({ our: 758196168, rivals: [/* nmId... */], submit: true });
//
// Наш артикул задаётся явно (его всегда спрашиваем у пользователя). Всего 2–5.
//
// Полный цикл (--submit): добавить артикулы → «Сравнить карточки» (тратит 1 из
// лимита) → «Создать Excel» → «Сформировать» → «Загрузки» → скачать → развернуть
// (WB отдаёт ZIP с вложенным .xlsx). Пере-скачать уже готовое сравнение (в
// пределах 72 ч) можно бесплатно: exportExisting.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { launchCabinet, openAndSettle } from './wbCabinet.js';
import { parseCardsComparison } from './wbCardsCompareParse.js';

export const CARDS_COMPARE_URL =
  'https://seller.wildberries.ru/platform-analytics/cards-comparison';

// Сигнатуры SVG-иконок (у кнопок нет текста/aria) — проверены на живой странице.
const SVG = {
  openRow: /M8\.70421 10\.7071|3\.41421V8/,        // «открыть» сравнение в истории
  createExcel: /M20 1V7M17 4H23/,                   // «Создать Excel»
  downloadsPanel: /16\.5V3\.5|12 16\.5/,            // тумблер панели «Загрузки»
};

const noop = () => {};
const sleep = (p, ms) => p.waitForTimeout(ms);

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
    } else out = out.concat(raw.split(/[,\s]+/));
  }
  return [...new Set(out.map((s) => String(s).trim()).filter(Boolean))];
}

/** Клик по кнопке, у которой svg path матчит регэксп. */
async function clickBySvg(page, re) {
  const h = await page.evaluateHandle((src) => {
    const rx = new RegExp(src);
    return [...document.querySelectorAll('button')].find(
      (b) => rx.test(b.querySelector('svg path')?.getAttribute('d') || '')
    );
  }, re.source);
  const el = h.asElement();
  if (el) { await el.click().catch(noop); return true; }
  return false;
}

/** Если файл — ZIP с единственным вложенным .xlsx, разворачиваем его в out. */
function unwrapXlsx(tmpFile, out) {
  try {
    const list = execFileSync('unzip', ['-Z1', tmpFile], { encoding: 'utf8' }).trim().split('\n');
    const inner = list.find((n) => /\.xlsx$/i.test(n));
    if (list.length === 1 && inner) {
      const dir = path.dirname(out);
      execFileSync('unzip', ['-o', '-j', tmpFile, inner, '-d', dir]);
      fs.renameSync(path.join(dir, path.basename(inner)), out);
      fs.rmSync(tmpFile, { force: true });
      return out;
    }
  } catch (_) { /* нет unzip или не тот формат — оставляем как есть */ }
  if (tmpFile !== out) fs.renameSync(tmpFile, out);
  return out;
}

/** Добавляет артикулы в открытую форму сравнения. */
async function addArticles(page, list, log) {
  const input = page.locator('input[placeholder="Введите артикул WB"]');
  const added = [];
  for (const nm of list) {
    log(`  + ${nm}`);
    await input.click(); await input.fill(''); await input.type(nm, { delay: 40 });
    await page.keyboard.press('Enter');
    await sleep(page, 2500);
    const addBtn = page.getByRole('button', { name: /^Добавить$/ }).first();
    if (await addBtn.count()) await addBtn.click().then(() => added.push(nm)).catch(noop);
    else log(`    ⚠ ${nm}: карточка не найдена`);
    await sleep(page, 1200);
  }
  return added;
}

/**
 * Экспорт открытого отчёта в XLSX: Создать Excel → имя → Сформировать →
 * Загрузки → скачать самый свежий файл → развернуть ZIP.
 */
export async function exportExcelFromReport(page, { name, out, log = noop } = {}) {
  await page.getByText(/Динамика показателей/i).first().waitFor({ timeout: 20000 }).catch(noop);
  log('  Создать Excel…');
  await clickBySvg(page, SVG.createExcel);
  await page.getByText(/Создать Excel/i).first().waitFor({ timeout: 8000 }).catch(noop);
  const nameInput = page.getByPlaceholder(/Название файла/i).first();
  if (name) {
    if (await nameInput.count()) await nameInput.fill(name);
    else await page.locator('input').last().fill(name).catch(noop);
  }
  await page.getByRole('button', { name: /^Сформировать$/ }).first().click();
  log('  жду генерацию…');
  await sleep(page, 14000);

  await clickBySvg(page, SVG.downloadsPanel);         // открыть «Загрузки»
  await sleep(page, 3500);
  const dlBtn = page.locator('button', { hasText: /КБ/ }).first(); // самый свежий файл сверху
  if (!(await dlBtn.count())) { log('  ⚠ файл в «Загрузках» не найден'); return null; }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    dlBtn.click(),
  ]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.zip';
  await download.saveAs(tmp);
  const saved = unwrapXlsx(tmp, out);
  log(`✓ отчёт сохранён: ${saved}`);
  return saved;
}

/** Разбирает скачанный XLSX в нормализованный JSON рядом с файлом (звено каскада). */
function emitJson(xlsxPath, log = noop) {
  if (!xlsxPath) return null;
  try {
    const data = parseCardsComparison(xlsxPath);
    const jsonPath = xlsxPath.replace(/\.xlsx$/i, '.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    log(`✓ данные (JSON для каскада): ${jsonPath}`);
    return { jsonPath, data };
  } catch (e) {
    log(`⚠ не удалось разобрать XLSX в JSON: ${e.message}`);
    return null;
  }
}

/** Открывает уже готовое сравнение из истории по нашему артикулу (в пределах 72 ч — бесплатно). */
export async function openComparisonFromHistory(page, article, log = noop) {
  const ok = await page.evaluate((art) => {
    const rows = [...document.querySelectorAll('*')].filter((el) => {
      const t = el.textContent || '';
      return t.includes(String(art)) && /Доступен до/i.test(t) &&
        el.querySelectorAll('button').length >= 2 && el.querySelectorAll('*').length < 400;
    });
    rows.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const btn = rows[0]?.querySelectorAll('button')[0]; // первая кнопка строки = «открыть»
    if (btn) { btn.click(); return true; }
    return false;
  }, article);
  if (ok) { log(`  открыл готовое сравнение по ${article}`); await sleep(page, 8000); }
  return ok;
}

/**
 * @param {object} a
 * @param {string|number}  a.our
 * @param {Array}          [a.rivals]
 * @param {boolean}        [a.submit=false]  false — DRY-RUN (не тратит лимит).
 * @param {boolean}        [a.exportExisting=false] пере-скачать готовое сравнение (бесплатно), без submit.
 * @param {string}         [a.out]
 * @param {boolean}        [a.headful=false]
 * @param {function}       [a.log]
 */
export async function runCardsComparison(a = {}) {
  const log = a.log || ((...x) => process.stderr.write(x.join(' ') + '\n'));
  const our = a.our != null ? String(a.our).trim() : '';
  if (!our) throw new Error('runCardsComparison: не задан наш артикул (our)');
  const rivals = (a.rivals || []).map((x) => String(x).trim()).filter(Boolean);
  const list = [...new Set([our, ...rivals])];
  const out = a.out || `reports-output/cards-compare-${list.join('_')}.xlsx`;
  const fileName = a.name || `compare_${our}`;

  const { browser, page } = await launchCabinet({ headless: !a.headful });
  try {
    log('→ страница «Сравнение карточек»');
    const info = await openAndSettle(page, CARDS_COMPARE_URL);
    if (!info.loggedIn) {
      const e = new Error('SESSION_EXPIRED: сессия кабинета недействительна. Обнови .secrets/wb-cookies.json и .secrets/wb-localstorage.txt.');
      e.sessionExpired = true; throw e;
    }
    await page.getByText('Принимаю', { exact: false }).first().click().catch(noop);
    await sleep(page, 1200);

    // Режим: пере-скачать уже готовое сравнение (бесплатно).
    if (a.exportExisting) {
      const opened = await openComparisonFromHistory(page, our, log);
      if (!opened) throw new Error(`Готовое сравнение по ${our} не найдено в истории (или недоступно бесплатно).`);
      const saved = await exportExcelFromReport(page, { name: fileName, out, log });
      const j = emitJson(saved, log);
      return { exported: true, out: saved, json: j?.jsonPath || null, data: j?.data || null };
    }

    if (list.length < 2 || list.length > 5) {
      throw new Error(`Нужно 2–5 уникальных артикулов, получено ${list.length}: ${list.join(', ')}`);
    }

    log('  открываю форму (кнопка «Сравнить карточки»)');
    await page.getByRole('button', { name: /^Сравнить карточки/ }).first().click()
      .catch(async () => { await page.getByText('Сравнить карточки', { exact: false }).first().click(); });
    await page.waitForSelector('input[placeholder="Введите артикул WB"]', { timeout: 20000 });
    await sleep(page, 800);

    const added = await addArticles(page, list, log);
    fs.mkdirSync('.secrets', { recursive: true });
    await page.screenshot({ path: '.secrets/cmp-filled.png' }).catch(noop);
    const counter = await page.getByText(/Карточки для сравнения:\s*\d+\s*из\s*5/i).first().textContent().catch(() => '');
    log(`  добавлено: ${added.length}/${list.length} | ${counter || ''}`);

    if (!a.submit) return { added, dryRun: true, counter, screenshot: '.secrets/cmp-filled.png' };

    log('  «Сравнить карточки» (тратит 1 из лимита)…');
    await page.getByRole('button', { name: /^Сравнить карточки/ }).last().click();
    await sleep(page, 6000);
    const saved = await exportExcelFromReport(page, { name: fileName, out, log });
    const j = emitJson(saved, log);
    return { added, submitted: true, counter, out: saved, json: j?.jsonPath || null, data: j?.data || null, screenshot: '.secrets/cmp-result.png' };
  } finally {
    await browser.close();
  }
}
