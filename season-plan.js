// season-plan.js — CLI-раннер «план продаж на сезон» (метод Овчинникова).
//
// Источник группы — один из двух:
//   A. Линейка из config/groups.json (явный список WB):
//        MPSTATS_TOKEN=xxx node season-plan.js --group РМП --d1 2024-08-01 --d2 2025-01-31
//   B. Сборка из ПРЕДМЕТА (path) с детальной фильтрацией:
//        MPSTATS_TOKEN=xxx node season-plan.js \
//          --path "Женщинам/Одежда/Платья" --words платье --price-min 1500 --price-max 4000 \
//          --min-sales 3 --limit 60 --d1 2024-08-01 --d2 2025-01-31
//
// Период по умолчанию — тот же сезон год назад (последние 365 дней, сдвинутые).
// Результат: reports-output/season-<label>-<d1>_<d2>.csv и .json + сводка.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSeasonPlanReport, seasonPlanToCSV } from './lib/seasonPlanReport.js';
import { seasonPlanXlsx, seasonPlanHtml } from './lib/reportExport.js';
import { loadGroups } from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ymd = (d) => d.toISOString().slice(0, 10);

/** Период по умолчанию (Правило 2): последние 2 года от текущей даты. */
export function default2Years() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // вчера — последний закрытый день
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 2);
  start.setUTCDate(start.getUTCDate() + 1);
  return { d1: ymd(start), d2: ymd(end) };
}

/** Разбор argv вида --key value / --flag в объект. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v) => (v == null || v === true ? undefined : Number(v));
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

/** Собирает параметры отчёта из разобранных аргументов/окружения. */
export function buildParamsFromArgs(a = {}) {
  const period = a.d1 && a.d2 ? { d1: a.d1, d2: a.d2 } : default2Years();

  const plan = {
    targetPeriodUnits: num(a['target-units']),
    ambition: num(a.ambition),
    minPrice: num(a['min-price']),
    hotCoeff: num(a['hot-coeff']),
    ratingLeadDays: num(a['rating-lead']),
    logisticsLeadDays: num(a['logi-lead']),
    oos: a.oos ? true : undefined, // поправка на out-of-stock
    weekly: a.weekly ? true : undefined, // недельный профиль (дни недели)
    competitorWeight: num(a['competitor-weight']), // доля конкурентов в базе (Правило 3)
    recencyWeight: num(a['recency-weight']), // вес недавнего года (Правило 2)
  };
  for (const k of Object.keys(plan)) if (plan[k] === undefined) delete plan[k];

  const filter = {
    words: list(a.words),
    allWords: list(a['all-words']),
    exclude: list(a.exclude),
    brands: list(a.brands),
    excludeBrands: list(a['exclude-brands']),
    priceMin: num(a['price-min']),
    priceMax: num(a['price-max']),
    minSales: num(a['min-sales']),
  };
  for (const k of Object.keys(filter)) if (filter[k] === undefined) delete filter[k];
  const hasFilter = Object.keys(filter).length > 0;
  const baseSourceArg = a['base-source']; // 'own' | 'market' | 'target'

  if (a.group) {
    const groups = loadGroups();
    const wbList = groups[a.group];
    if (!wbList) throw new Error(`Неизвестная группа «${a.group}». Есть: ${Object.keys(groups).join(', ')}`);
    const ownGroup = wbList.map((wb) => ({ wb }));

    // Комбинированный режим: линейка + предмет-аналоги. ФОРМА — от аналогов
    // (subject+filter), УРОВЕНЬ — от собственных продаж линейки.
    if (a.path && hasFilter) {
      return {
        ...period,
        label: a.group,
        subject: { path: a.path, filter, limit: num(a.limit), maxPages: num(a['max-pages']) },
        baseSource: baseSourceArg || 'own',
        own: { group: ownGroup, path: a.path },
        plan,
      };
    }
    // Режим A — сама линейка и форма, и база. С --path собираем BULK.
    return {
      ...period,
      label: a.group,
      group: ownGroup,
      path: a.path,
      baseSource: baseSourceArg || 'market', // база = собственный уровень группы
      plan,
    };
  }

  // Режим B — только предмет+фильтр. База — рыночная (или цель).
  if (a.path) {
    return {
      ...period,
      label: a.label || a.path,
      subject: { path: a.path, filter, limit: num(a.limit), maxPages: num(a['max-pages']) },
      baseSource: baseSourceArg || (plan.targetPeriodUnits ? 'target' : 'market'),
      plan,
    };
  }

  throw new Error('Укажите источник: --group <линейка> и/или --path <предмет> [фильтры].');
}

function slug(s) {
  return String(s || 'group').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
}

function writeOutputs(report) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `season-${slug(report.label)}-${report.period.d1}_${report.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  const xlsxPath = path.join(dir, `${base}.xlsx`);
  const htmlPath = path.join(dir, `${base}.html`);
  fs.writeFileSync(csvPath, seasonPlanToCSV(report));
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const out = { csvPath, jsonPath };
  // Правило 4: два файла-результата — .xlsx (по дням, с этапами) и HTML-артефакт.
  if (report.plan) {
    seasonPlanXlsx(report, xlsxPath);
    fs.writeFileSync(htmlPath, seasonPlanHtml(report));
    out.xlsxPath = xlsxPath;
    out.htmlPath = htmlPath;
  }
  return out;
}

function printSummary(report) {
  const p = report.plan;
  console.log('\n=== План продаж на сезон ===');
  console.log(`Линейка/предмет:   ${report.label}`);
  console.log(`Период истории:    ${report.period.d1} … ${report.period.d2}`);
  const methodLabel = report.method === 'category-bulk'
    ? 'bulk (графики категории)'
    : 'per-SKU (дорого по лимиту)';
  console.log(`Способ сбора:      ${methodLabel} — запросов к MPStats: ${report.requests}`);
  if (report.groupInfo) {
    console.log(`Предмет:           ${report.groupInfo.path}`);
    console.log(`Отобрано в группу: ${report.groupInfo.kept} из ${report.groupInfo.fetched} (всего в предмете ${report.groupInfo.total})`);
    if (report.groupInfo.truncated) {
      console.log(`  ⚠ Пагинация остановлена на ${report.groupInfo.maxPages} страницах, аналогов набрано меньше --limit.`);
      console.log(`     Фильтр узкий: поднимите --max-pages или ослабьте критерии (--words/--price-*/--min-sales).`);
    }
  }
  console.log(`Размер группы:     ${report.groupSize}, с данными: ${report.itemsWithData}`);

  if (report.dailyLimit) {
    console.log('\n⛔ Остановлено на дневном лимите MPSTATS:', report.dailyLimit);
  }
  if (!p) {
    console.log('\n⚠ Нет данных для построения плана.');
    return;
  }

  console.log('\n— Ранг сезонности —');
  console.log(`  ${p.rank.rank} (амплитуда p90/p50 = ${p.rank.amplitude}; медиана ${p.rank.p50}, пик ${p.rank.p90}, провал ${p.rank.p10})`);

  const ds = p.dataSufficiency;
  if (ds) {
    console.log(`  Активный период: ${ds.activeFrom}…${ds.activeTo} (${ds.approxMonths} мес.` +
      (ds.trimmedDays ? `, обрезано нулей: ${ds.trimmedDays} дн.` : '') + ')');
    if (ds.lowConfidence) {
      console.log(`  ⚠ Данных < ${'~10 мес'} — годовой профиль НЕДОСТОВЕРЕН, нужен более длинный период.`);
    }
  }

  const ph = p.phases;
  if (ph) {
    if (ph.peakAtEdge) console.log('  ⚠ Пик у края окна — расширьте период, сезон может быть срезан.');
    if (ph.saleTruncated) console.log('  ⚠ Фаза распродажи упирается в конец окна — данных после пика нет.');
    console.log('\n— Фазы сезона (история → проекция на след. год) —');
    const line = (o) => `${o.date} → ${o.dateNext}` + (o.index != null ? `  (индекс=${o.index})` : '');
    console.log(`  Вход в рынок:      ${ph.entry.date} → ${ph.entry.dateNext}${ph.entry.beforeWindow ? '  (раньше окна данных)' : ''}  [−${ph.entry.leadDays} дн. на подготовку]`);
    console.log(`  Старт разгона:     ${line(ph.ramp)}`);
    console.log(`  Горячий сезон с:   ${line(ph.hotStart)}`);
    console.log(`  ПИК:               ${line(ph.peak)}`);
    console.log(`  Горячий сезон по:  ${line(ph.hotEnd)}`);
    console.log(`  Старт распродажи:  ${line(ph.sale)}`);
  }

  if (p.pricing) {
    console.log('\n— Ценовые ориентиры (₽) —');
    console.log(`  Средняя по группе: ${fmt(p.pricing.meanPrice)}`);
    console.log(`  Вход/разгон:       ${fmt(p.pricing.entry)}`);
    console.log(`  Пик:               ${fmt(p.pricing.peak)}`);
    console.log(`  Распродажа:        ${fmt(p.pricing.sale)}`);
  }

  console.log('\n— Плановые заказы —');
  const bi = report.baseInfo || {};
  const baseLabel = {
    blend: `бленд ${Math.round((bi.competitorWeight ?? 0.9) * 100)}% конкуренты / ${Math.round((1 - (bi.competitorWeight ?? 0.9)) * 100)}% свои: конкуренты ${fmt(bi.competitorLevel)} + свои ${fmt(bi.ownBaseDaily)} → ${fmt(bi.blendedBaseDaily)} зак/день`,
    competitor: `100% конкуренты (${bi.reason}): ${fmt(bi.competitorPerItemDaily)}/товар × ${bi.ownSkuCount} SKU = ${fmt(bi.estimatedBaseDaily)}`,
    own: `от собственных продаж линейки (${fmt(bi.ownBaseDaily)} зак/день)`,
    target: 'от цели по штукам',
    group: 'рыночный уровень группы',
    override: 'заданная база',
  }[p.baseSource] || p.baseSource;
  console.log(`  Уровень базы: ${baseLabel}`);
  console.log(`  База плана: ${fmt(p.baseDaily)} зак/день (форма — от аналогов). Пример по фазам:`);
  const pick = (date) => p.daily.find((r) => r.date === date);
  for (const o of [ph?.ramp, ph?.peak, ph?.sale].filter(Boolean)) {
    const r = pick(o.date);
    if (r) console.log(`  ${o.label.padEnd(18)} ${o.date}: ${fmt(r.plannedOrders)} зак/день`);
  }
  if (p.weeklyProfile) {
    const wd = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    console.log(`  Недельный профиль: ${p.weeklyProfile.map((f, i) => `${wd[i]} ${f}`).join('  ')}`);
  }

  if (report.errors.length) {
    console.log(`\n⚠ Ошибок при запросах: ${report.errors.length}`);
  }
}

/**
 * Правило 1: интерактивный опрос параметров понятным языком ПЕРЕД сбором.
 * Возвращает объект аргументов (как из parseArgs), который идёт в buildParamsFromArgs.
 */
async function promptParams(preset = {}) {
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const ans = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return ans || def || undefined;
  };
  console.log('\nНастройка прогона (Enter — оставить значение по умолчанию):\n');
  const a = { ...preset };
  a.path = await ask('Путь предмета MPStats (напр. Женщинам/Блузки и рубашки/Рубашка)', preset.path);
  a.group = await ask('Своя линейка из groups.json для базы (можно пусто)', preset.group);
  a.words = await ask('Слова в названии — любое из (через запятую)', preset.words);
  a['all-words'] = await ask('Слова, которые должны быть ВСЕ', preset['all-words']);
  a.exclude = await ask('Исключить, если встречается', preset.exclude);
  a.brands = await ask('Только эти бренды', preset.brands);
  a['exclude-brands'] = await ask('Исключить бренды', preset['exclude-brands']);
  a['price-min'] = await ask('Цена от, ₽', preset['price-min']);
  a['price-max'] = await ask('Цена до, ₽', preset['price-max']);
  a['min-sales'] = await ask('Минимум продаж за период (отсечь мёртвые)', preset['min-sales'] || '3');
  a.limit = await ask('Сколько аналогов брать в группу', preset.limit || '60');
  a.d1 = await ask('Начало периода (YYYY-MM-DD), пусто — последние 2 года', preset.d1);
  a.d2 = await ask('Конец периода (YYYY-MM-DD)', preset.d2);
  a['base-source'] = await ask('Уровень базы: own / market / target', preset['base-source'] || (a.group ? 'own' : 'market'));
  a.oos = (await ask('Поправка на out-of-stock? (y/n)', 'y')) === 'y' || undefined;
  a.weekly = (await ask('Недельный профиль? (y/n)', 'y')) === 'y' || undefined;
  rl.close();
  return a;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let a = parseArgs(process.argv.slice(2));
  // Правило 1: без явных параметров источника ИЛИ с --interactive — спрашиваем.
  if (a.interactive || (!a.path && !a.group)) {
    a = await promptParams(a);
  }
  let params;
  try {
    params = buildParamsFromArgs(a);
  } catch (err) {
    console.error('Ошибка параметров:', err?.message || err);
    process.exit(1);
  }
  process.stderr.write(`Строю план сезона «${params.label}» за ${params.d1}…${params.d2}\n`);
  buildSeasonPlanReport({
    ...params,
    concurrency: Number(process.env.REPORT_CONCURRENCY) || 5,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stderr.write(`  обработано ${done}/${total}\n`);
    },
  })
    .then((report) => {
      const out = writeOutputs(report);
      printSummary(report);
      console.log('\nФайлы:');
      for (const pth of [out.xlsxPath, out.htmlPath, out.csvPath, out.jsonPath].filter(Boolean)) {
        console.log(`  ${pth}`);
      }
      if (report.dailyLimit) process.exit(2);
    })
    .catch((err) => {
      console.error('Ошибка отчёта:', err?.message || err);
      process.exit(1);
    });
}

export { writeOutputs, printSummary };
