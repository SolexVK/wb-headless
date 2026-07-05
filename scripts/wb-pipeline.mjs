// scripts/wb-pipeline.mjs — оркестратор каскада [1]→[2]→[3].
//
// Одной командой: ключевой запрос → ТОП-N конкурентов из MPStats [1] →
// «Сравнение карточек» в кабинете WB [2] → «Конкурентный анализ» [3].
// Наш артикул ВСЕГДА задаём явно (--our) — правило каскада.
//
// Артефакты складываются в reports-output/<run-id>/:
//   top-rivals.json   — выдача [1] (контракт top-rivals)
//   cards-compare.*   — xlsx+json из [2] (при --submit или --export-existing)
//   analysis.json     — контракт [3]
//   analysis.md       — человекочитаемый отчёт [3]
//
// Стоимость: [2] с --submit тратит 1 из лимита «Сравнения карточек» и требует живой
// сессии кабинета (.secrets/ или env WB_COOKIES/WB_LOCALSTORAGE). Без --submit —
// DRY-RUN: делаем [1], показываем какие артикулы пошли бы в сравнение, и останавливаемся
// (данных для [3] ещё нет). --export-existing переиспользует готовое сравнение бесплатно.
//
//   node scripts/wb-pipeline.mjs --query "платье женское" --our 758196168 --top 4 --min-rating 4.5
//   node scripts/wb-pipeline.mjs --query "платье" --our 758196168 --submit          # тратит лимит
//   node scripts/wb-pipeline.mjs --our 758196168 --export-existing                  # [2 готовое]→[3]

import { topByKeywords } from '../lib/wbTopKeywords.js';
import { runCardsComparison } from '../lib/wbCardsCompare.js';
import { competitiveAnalysis, formatReport } from '../lib/wbCompetitiveAnalysis.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    const n = args[i + 1];
    if (n && !n.startsWith('--')) { opt[k] = n; i++; } else opt[k] = true;
  }
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const numOpt = (v) => (v == null ? undefined : Number(v));

if (!opt.our) {
  log('Не задан наш артикул. Пример:');
  log('  node scripts/wb-pipeline.mjs --query "платье женское" --our 758196168 --top 4');
  process.exit(2);
}
if (!opt.query && !opt['export-existing']) {
  log('Нужен --query (для [1]) либо --export-existing (переиспользовать готовое сравнение).');
  process.exit(2);
}

// «Сравнение карточек» принимает 2–5 артикулов ВСЕГО (наш + до 4 конкурентов).
const MAX_RIVALS = 4;
const runId = opt['run-id'] || `${opt.our}-${slug(opt.query || 'existing')}-${stamp()}`;
const dir = `reports-output/${runId}`;
mkdirSync(dir, { recursive: true });

const filters = clean({
  minRevenue: numOpt(opt['min-revenue']),
  minRating: numOpt(opt['min-rating']),
  minReviews: numOpt(opt['min-reviews']),
  minSales: numOpt(opt['min-sales']),
  priceMin: numOpt(opt['price-min']),
  priceMax: numOpt(opt['price-max']),
  excludeBrands: opt['exclude-brands']
    ? String(opt['exclude-brands']).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined,
  sortBy: opt.sort || 'position',
});

try {
  let rivals = [];

  // ── [1] ТОП-N по запросу (пропускаем, если --export-existing без --query) ──
  if (opt.query) {
    log(`\n[1] ТОП-N по запросу «${opt.query}» (MPStats)…`);
    const top = await topByKeywords({
      query: opt.query,
      topN: Math.min(numOpt(opt.top) ?? MAX_RIVALS, MAX_RIVALS),
      filters,
      our: opt.our,
      limit: numOpt(opt.limit) ?? 100,
    });
    writeFileSync(`${dir}/top-rivals.json`, JSON.stringify(top, null, 2));
    rivals = top.rivals.map((r) => r.nmId);
    log(`    из выдачи ${top.fetched} шт. → топ-${rivals.length}: ${rivals.join(', ') || '(пусто)'}`);
    log(`    → ${dir}/top-rivals.json`);
    if (!rivals.length && !opt['export-existing']) {
      log('    Конкурентов после фильтров не осталось — ослабь фильтры. Стоп.');
      process.exit(1);
    }
  }

  // ── [2] Сравнение карточек ────────────────────────────────────────────────
  const doExisting = !!opt['export-existing'];
  const doSubmit = !!opt.submit;

  if (!doSubmit && !doExisting) {
    // DRY-RUN: показываем план и останавливаемся (для [3] нужны реальные данные).
    log(`\n[2] Сравнение карточек — DRY-RUN (лимит не тратим).`);
    log(`    сравнили бы: наш ${opt.our} + конкуренты [${rivals.join(', ')}]`);
    log(`\nДальше: повтори с --submit (потратит 1 из лимита) или --export-existing (готовое бесплатно),`);
    log(`чтобы получить cards-compare.json и запустить [3] Конкурентный анализ.`);
    process.exit(0);
  }

  log(`\n[2] Сравнение карточек в кабинете WB${doSubmit ? ' (--submit, тратит 1 лимит)' : ' (--export-existing)'}…`);
  const cmp = await runCardsComparison({
    our: opt.our,
    rivals: rivals.slice(0, MAX_RIVALS),
    submit: doSubmit,
    exportExisting: doExisting,
    out: `${dir}/cards-compare.xlsx`,
    log,
  });
  if (!cmp?.data) {
    throw new Error('[2] не вернул разобранные данные (cards-compare). Проверь сессию кабинета/выгрузку.');
  }
  writeFileSync(`${dir}/cards-compare.json`, JSON.stringify(cmp.data, null, 2));
  log(`    → ${dir}/cards-compare.json (${cmp.data.articles?.length || 0} карточек)`);

  // ── [3] Конкурентный анализ ───────────────────────────────────────────────
  log(`\n[3] Конкурентный анализ…`);
  const analysis = competitiveAnalysis({ cardsCompare: cmp.data });
  writeFileSync(`${dir}/analysis.json`, JSON.stringify(analysis, null, 2));
  writeFileSync(`${dir}/analysis.md`, formatReport(analysis));
  log(`    узкое место воронки: ${analysis.funnel.bottleneck || 'нет'} | рекомендаций: ${analysis.recommendations.length}`);
  log(`    → ${dir}/analysis.json + analysis.md`);

  log(`\nГотово. Итоговый отчёт: ${dir}/analysis.md`);
  process.stdout.write(formatReport(analysis) + '\n');
} catch (err) {
  log(`\nОшибка каскада: ${err?.message || err}`);
  if (err?.sessionExpired) log('Сессия кабинета истекла — обнови .secrets/ (см. handoff «Важно про секреты»).');
  if (/MPSTATS_TOKEN/.test(String(err?.message))) log('Задай MPSTATS_TOKEN (заголовок X-Mpstats-TOKEN).');
  process.exit(1);
}

// ── утилиты ────────────────────────────────────────────────────────────────
function clean(o) { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; }
function slug(s) { return String(s).toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'q'; }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
