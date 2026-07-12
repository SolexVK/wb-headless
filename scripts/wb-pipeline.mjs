// scripts/wb-pipeline.mjs — оркестратор каскада [1]→(ручной выбор)→[2]→[3].
//
// Каскад с РУЧНЫМ выбором конкурентов, две фазы одной командой:
//
//   Фаза 1 — DISCOVERY (без --rivals): прогнать [1] «ТОП по фразе», посчитать сезонность
//     (два агрегата MPStats по половинам периода), сохранить top-rivals.json и показать
//     таблицу-пикер. Ты выбираешь 2–4 конкурента.
//
//   Фаза 2 — ANALYSIS (с --rivals + --our): переиспользовать top-rivals.json (--run-id),
//     прогнать [2] «Сравнение карточек» в кабинете WB, затем [3] «Конкурентный анализ»
//     (Python-движок wb_analyze.py в каскадном режиме: ниша из [1] + воронка из [2]).
//
// Артефакты — в reports-output/<run-id>/:
//   top-rivals.json   — выдача [1] (+ _meta.seasonality для блока A)
//   cards-compare.*   — xlsx+json из [2]
//   analysis.md/html/pdf/json — отчёт [3]
//
// Примеры:
//   # Фаза 1 — найти и показать конкурентов:
//   node scripts/wb-pipeline.mjs --query "рубашка женская в полоску" --period 30 --top 20 \
//     --group "крой=оверс,прям" --exclude "притал,стойк" --price-min 1800
//   # → выбираешь строки/nmId и запускаешь фазу 2 (--run-id печатается в фазе 1):
//   node scripts/wb-pipeline.mjs --run-id <id> --our 841324733 \
//     --rivals 297675127,494807116,435980977,342248350 --cost 536 --submit

import { topByKeywords, formatPickTable } from '../lib/wbTopKeywords.js';
import { fetchSearchResults } from '../lib/mpstats.js';
import { runCardsComparison } from '../lib/wbCardsCompare.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../.claude/skills/wb-competitor-analysis/wb_analyze.py', import.meta.url));
const MAX_RIVALS = 4;              // «Сравнение карточек» — 2–5 карточек всего (наш + до 4)

// ── парсер аргументов (повторяемый --group, остальное — одиночные) ──
const argv = process.argv.slice(2);
const opt = {};
const groupsRaw = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2);
  const n = argv[i + 1];
  const val = n && !n.startsWith('--') ? (i++, n) : true;
  if (k === 'group') groupsRaw.push(val);
  else opt[k] = val;
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const numOpt = (v) => (v == null ? undefined : Number(v));
const listOpt = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

const rivals = listOpt(opt.rivals);
const analysisPhase = !!rivals;   // есть --rivals → фаза 2

if (!opt.query && !opt['run-id']) {
  log('Нужен --query (фаза 1, поиск конкурентов) или --run-id (фаза 2, из сохранённого top-rivals.json).');
  process.exit(2);
}

// период: --d1/--d2 или пресет --period N (d2 = вчера, строго раньше сегодня)
let d1 = opt.d1, d2 = opt.d2;
if (!d1 && !d2 && opt.period) {
  const days = Number(opt.period) || 30;
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  d2 = iso(Date.now() - day);
  d1 = iso(Date.now() - days * day);
}
// человекочитаемая подпись периода для шапки отчёта (движок иначе выведет из дат)
let periodLabel = opt['period-label'];
if (!periodLabel && opt.period) {
  const n = Number(opt.period) || 30;
  periodLabel = n >= 350 ? 'за последний год' : `за последние ${n} дней`;
}

// «глубокие» фильтры [1]: группы-признаки (ИЛИ) + exclude-гейт + метрики
const groups = groupsRaw.map((g) => {
  const [key, vals] = String(g).split('=');
  return { key: (key || '').trim(), any: listOpt(vals) || [] };
}).filter((g) => g.any.length);
const filters = clean({
  revenueFloor: numOpt(opt['revenue-floor']),
  exceptionRank: numOpt(opt['exception-rank']),
  priceMin: numOpt(opt['price-min']),
  priceMax: numOpt(opt['price-max']),
  minRating: numOpt(opt['min-rating']),
  minReviews: numOpt(opt['min-reviews']),
  minSales: numOpt(opt['min-sales']),
  deep: (groups.length || opt.exclude) ? { groups, exclude: listOpt(opt.exclude) || [] } : undefined,
});

const runId = opt['run-id'] || `${opt.our || 'top'}-${slug(opt.query || 'run')}-${stamp()}`;
const dir = `reports-output/${runId}`;
mkdirSync(dir, { recursive: true });
const topPath = `${dir}/top-rivals.json`;

try {
  // ── [1] ниша: переиспользуем сохранённую или строим заново ──
  let top;
  if (opt['run-id'] && existsSync(topPath) && !opt.query) {
    top = JSON.parse(readFileSync(topPath, 'utf-8'));
    log(`[1] переиспользую ${topPath} (${top.rivals?.length || 0} карточек, фраза «${top.query}»).`);
  } else {
    log(`[1] ТОП по фразе «${opt.query}» (MPStats)…`);
    // Тянем весь пул (до ~100) — нужен блоку D «Доминирующие цвета» (выборка). Пикер и
    // блок B показывают top-N (по умолчанию 20); анализ цветов/экономики идёт по всему пулу.
    top = await topByKeywords({
      query: opt.query, d1, d2, filters, our: opt.our,
      topN: numOpt(opt.pool) ?? 100, maxRows: numOpt(opt['max-rows']),
    });
    // сезонность: Δ% выручки 2-й половины периода к 1-й (два агрегата MPStats)
    const seas = await computeSeasonality(top.query, top.period.d1, top.period.d2);
    top._meta = { seasonality: seas != null ? { delta_pct: seas } : null };
    writeFileSync(topPath, JSON.stringify(top, null, 2));
    log(`    выдача ${top.fetched}/${top.total}, после фильтров — ${top.rivals.length}. ` +
        `Сезонность: ${seas != null ? (seas >= 0 ? '+' : '') + seas + '%' : 'н/д'}.`);
    log(`    → ${topPath}`);
  }
  if (!top.rivals?.length) {
    log('Конкурентов после фильтров нет — ослабь фильтры. Стоп.');
    process.exit(1);
  }

  // ── Фаза 1: показать пикер (top-N для выбора) и остановиться ──
  if (!analysisPhase) {
    const pickN = numOpt(opt.top) ?? 20;
    process.stdout.write(formatPickTable({ ...top, rivals: top.rivals.slice(0, pickN) }) + '\n');
    log(`\nRun-id: ${runId}`);
    log('Фаза 2 (после выбора конкурентов): назови 2–4 nmId и наш артикул —');
    log(`  node scripts/wb-pipeline.mjs --run-id ${runId} --our <НАШ> --rivals <nmId,…> --cost <себест> --submit`);
    process.exit(0);
  }

  // ── Фаза 2: analysis ──
  if (!opt.our) { log('Фаза 2 требует анализируемый артикул: --our <nmId>.'); process.exit(2); }

  // Чужой артикул (--foreign): его нет в вашем кабинете → «Сравнение карточек» [2] невозможно.
  // Пропускаем шаг [2] и воронку; [3] строится по нише/топу + карточке из публичных источников.
  const foreign = !!opt.foreign;
  let hasFunnel = false;
  if (foreign) {
    log(`\n[2] Пропущено: --foreign (артикул ${opt.our} — чужой, нет доступа к кабинету).`);
    log('    Отчёт [3] будет без блока «Воронка [2]»; карточка сравнивается с нишей по публичным данным.');
  } else {
    const doSubmit = !!opt.submit;
    const doExisting = !!opt['export-existing'];
    if (!doSubmit && !doExisting) {
      log('\n[2] Для [3] нужна воронка из «Сравнения карточек». Добавь --submit (потратит 1 из лимита)');
      log('    или --export-existing (переиспользовать готовое сравнение бесплатно).');
      log('    Если анализируешь ЧУЖОЙ артикул (нет в твоём кабинете) — добавь --foreign. Стоп.');
      process.exit(0);
    }
    log(`\n[2] Сравнение карточек${doSubmit ? ' (--submit, тратит 1 лимит)' : ' (--export-existing)'}: ` +
        `наш ${opt.our} + [${rivals.join(', ')}]…`);
    const cmp = await runCardsComparison({
      our: opt.our, rivals: rivals.slice(0, MAX_RIVALS),
      submit: doSubmit, exportExisting: doExisting,
      out: `${dir}/cards-compare.xlsx`, log,
    });
    if (!cmp?.data) throw new Error('[2] не вернул разобранные данные (cards-compare). Проверь сессию кабинета/выгрузку.');
    writeFileSync(`${dir}/cards-compare.json`, JSON.stringify(cmp.data, null, 2));
    log(`    → ${dir}/cards-compare.json (${cmp.data.articles?.length || 0} карточек)`);
    hasFunnel = true;
  }

  // ── [3] Конкурентный анализ (Python-движок, каскадный режим) ──
  log(`\n[3] Конкурентный анализ (wb_analyze.py, каскад)…`);
  const seasDelta = top._meta?.seasonality?.delta_pct;
  const engineArgs = [
    ENGINE,
    '--items-json', topPath,
    '--query', top.query || opt.query || 'каскад',
    '--top', String(numOpt(opt.top) ?? 20),
    '--bench', '20', '--cards', '6',
    '--out', `${dir}/analysis.md`,
    '--json-out', `${dir}/analysis.json`,
    '--html-out', `${dir}/analysis.html`,
    '--pdf-out', `${dir}/analysis.pdf`,
  ];
  if (hasFunnel) engineArgs.push('--funnel-json', `${dir}/cards-compare.json`);
  if (foreign) engineArgs.push('--foreign', '--my-sku', String(opt.our));  // без воронки my_sku надо задать явно
  if (opt.niche) engineArgs.push('--niche', String(opt.niche));
  if (periodLabel) engineArgs.push('--period-label', periodLabel);
  if (opt.cost != null) engineArgs.push('--cost', String(numOpt(opt.cost)));
  else log('    ⚠️ без --cost блок C (юнит-экономика/заработок) будет пропущен.');
  if (seasDelta != null) engineArgs.push('--seasonality-delta', String(seasDelta));
  if (opt['no-wb']) engineArgs.push('--no-wb');

  const r = spawnSync('python3', engineArgs, { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  if (r.status !== 0) throw new Error(`[3] движок завершился с кодом ${r.status}. Проверь Python/сеть.`);

  log(`\nГотово. Отчёт [3]: ${dir}/analysis.md · .html · .pdf · .json`);
  process.stdout.write(readFileSync(`${dir}/analysis.md`, 'utf-8'));
} catch (err) {
  log(`\nОшибка каскада: ${err?.message || err}`);
  if (err?.sessionExpired) log('Сессия кабинета истекла — обнови .secrets/ (см. скилл wb-cards-compare).');
  if (/MPSTATS_TOKEN/.test(String(err?.message))) log('Задай MPSTATS_TOKEN (заголовок X-Mpstats-TOKEN).');
  process.exit(1);
}

// ── сезонность: Δ% выручки 2-й половины периода к 1-й (два агрегата поиска MPStats) ──
async function computeSeasonality(query, pd1, pd2) {
  try {
    const day = 86400000;
    const t1 = Date.parse(pd1), t2 = Date.parse(pd2);
    if (!(t1 && t2 && t2 > t1)) return null;
    const mid = new Date((t1 + t2) / 2).toISOString().slice(0, 10);
    const nextMid = new Date(Date.parse(mid) + day).toISOString().slice(0, 10);
    const sumRev = (rows) => rows.reduce((s, r) => s + (Number(r.revenue ?? r.turnover ?? r.sales_sum) || 0), 0);
    const [h1, h2] = await Promise.all([
      fetchSearchResults(query, { d1: pd1, d2: mid }),
      fetchSearchResults(query, { d1: nextMid, d2: pd2 }),
    ]);
    const a = sumRev(h1.rows), b = sumRev(h2.rows);
    return a ? Math.round((b - a) / a * 100) : null;
  } catch (e) {
    log(`    (сезонность не посчитана: ${String(e?.message || e).slice(0, 50)})`);
    return null;
  }
}

// ── утилиты ──
function slug(s) { return String(s).toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'q'; }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
