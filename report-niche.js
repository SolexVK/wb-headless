// report-niche.js — CLI-раннер отчёта «Анализ ниши» (категории WB).
//
// Запуск:
//   MPSTATS_TOKEN=xxx NICHE_PATH="Женщинам/Одежда/Платья" node report-niche.js
//   MPSTATS_TOKEN=xxx node report-niche.js "Женщинам/Одежда/Платья"
//   MPSTATS_TOKEN=xxx node report-niche.js "Женщинам/Одежда/Платья" 2026-06-01 2026-06-30
//
// Путь категории берётся из аргумента №1 или из NICHE_PATH.
// Результат: reports-output/niche-<категория>-<d1>_<d2>.csv (товары) и .json
// (полный анализ: 5 блоков + скоринг) + сводка в консоль.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildNicheAnalysis } from './lib/nicheAnalysis.js';
import { nicheReportToCSV } from './lib/nicheReport.js';
import { readOracle, filterPhrases, toQueries } from './lib/oraclePhrases.js';
import { nicheHtmlDocument } from './lib/nicheReportHtml.js';
import { htmlToPdf } from './lib/renderPdf.js';
import { defaultPeriod } from './report-stock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));
}

/** Безопасное имя файла из пути категории: "Женщинам/Одежда" → "Женщинам_Одежда". */
function slugCategory(categoryPath) {
  return (
    String(categoryPath)
      .trim()
      .replace(/[\\/]+/g, '_')
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'niche'
  );
}

/** Адаптер: анализ → форма для nicheReportToCSV (товары + минимальные итоги). */
function toCsvReport(analysis) {
  return {
    items: analysis.items,
    totals: {
      totalUnits: analysis.capacity.totalUnits,
      totalRevenue: analysis.capacity.totalRevenue,
    },
  };
}

export async function runNicheReport({ categoryPath, d1, d2, query, frequency, supplyCards, cost: costArg } = {}) {
  const cat = categoryPath || process.env.NICHE_PATH;
  if (!cat || !String(cat).trim()) {
    throw new Error(
      'Не задан путь категории. Укажите его аргументом или через NICHE_PATH, ' +
        'напр.: NICHE_PATH="Женщинам/Платья и сарафаны/Платья" node report-niche.js'
    );
  }
  const period = d1 && d2 ? { d1, d2 } : defaultPeriod(Number(process.env.REPORT_DAYS) || 30);
  const q = query ?? process.env.NICHE_QUERY;
  const freq = frequency ?? process.env.NICHE_FREQ;
  const supply = supplyCards ?? process.env.NICHE_SUPPLY;
  const cost = costArg ?? process.env.NICHE_COST;
  // Несколько уточняющих фраз, если в спецификации есть «;» или «=фраза:карточки».
  const isMulti = q && /[;=]/.test(String(q));

  // Ингест Оракула (Wildbox): фразы из файла, отфильтрованные плюс/минус-ключами.
  const oracleFile = process.env.NICHE_ORACLE;
  let oracleQueries = null;
  if (oracleFile && String(oracleFile).trim()) {
    const phrases = readOracle(String(oracleFile).trim());
    const { selected } = filterPhrases(phrases, { plus: process.env.NICHE_PLUS, minus: process.env.NICHE_MINUS });
    oracleQueries = toQueries(selected);
    process.stderr.write(
      `Оракул: отобрано ${selected.length} из ${phrases.length} фраз ` +
        `(плюс: ${process.env.NICHE_PLUS || '—'} | минус: ${process.env.NICHE_MINUS || '—'})\n`
    );
    for (const s of selected) {
      process.stderr.write(`  • ${s.phrase} — ${s.frequency}/${s.count}\n`);
    }
  }

  process.stderr.write(
    `Анализ ниши: «${cat}», период ${period.d1} … ${period.d2}` +
      (oracleQueries ? `, фраз из Оракула: ${oracleQueries.length}` :
        q && String(q).trim() ? `, ${isMulti ? 'уточняющие фразы' : 'запрос'} «${String(q).trim()}»` : '') + '\n'
  );

  return buildNicheAnalysis({
    categoryPath: cat,
    d1: period.d1,
    d2: period.d2,
    query: oracleQueries ? null : isMulti ? null : q && String(q).trim() ? String(q).trim() : null,
    frequency: oracleQueries ? null : isMulti ? null : freq != null && String(freq).trim() ? Number(freq) : null,
    supplyCards: oracleQueries ? null : isMulti ? null : supply != null && String(supply).trim() ? Number(supply) : null,
    queries: oracleQueries || (isMulti ? String(q) : null),
    cost: cost != null && String(cost).trim() ? Number(cost) : null,
    maxRows: Number(process.env.NICHE_MAX_ROWS) || 5000,
    pageSize: Number(process.env.NICHE_PAGE_SIZE) || 500,
    onPage: (loaded, total) => {
      process.stderr.write(`  загружено ${loaded}${total ? ` из ${total}` : ''} товаров\n`);
    },
  });
}

export function writeOutputs(analysis) {
  const dir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(dir, { recursive: true });
  const base = `niche-${slugCategory(analysis.categoryPath)}-${analysis.period.d1}_${analysis.period.d2}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  const htmlPath = path.join(dir, `${base}.html`);
  fs.writeFileSync(csvPath, nicheReportToCSV(toCsvReport(analysis)));
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2));

  // HTML всегда; PDF — если найден Chromium и не отключено NICHE_PDF=0.
  const html = nicheHtmlDocument(analysis);
  fs.writeFileSync(htmlPath, html);
  const out = { csvPath, jsonPath, htmlPath };
  if (process.env.NICHE_PDF !== '0') {
    const pdfPath = path.join(dir, `${base}.pdf`);
    try {
      htmlToPdf(html, pdfPath);
      out.pdfPath = pdfPath;
    } catch (err) {
      process.stderr.write(`⚠ PDF не собран: ${String(err?.message || err)} (HTML сохранён)\n`);
    }
  }
  return out;
}

export function printSummary(analysis) {
  const { score, capacity: c, competition: comp, saturation: sat, trend, seasonality: seas } = analysis;

  if (analysis.conclusion?.points?.length) {
    console.log('\n' + '─'.repeat(64));
    console.log(`ЗАКЛЮЧЕНИЕ: ${analysis.conclusion.verdict} (${analysis.conclusion.total}/100) · узкое место: ${analysis.conclusion.bottleneck}`);
    for (const p of analysis.conclusion.points) {
      const mark = p.tone === 'good' ? '✓' : p.tone === 'bad' ? '✗' : '•';
      console.log(`  ${mark} ${p.text}`);
    }
    for (const f of analysis.conclusion.flags || []) {
      console.log(`  ${f.level === 'stop' ? '⛔' : '⚠'} ${f.text}`);
    }
    if (analysis.conclusion.recommendation) console.log(`  → ${analysis.conclusion.recommendation}`);
  }

  console.log('\n' + '═'.repeat(64));
  console.log(`АНАЛИЗ НИШИ: ${analysis.categoryPath}`);
  console.log(`Период: ${analysis.period.d1} … ${analysis.period.d2} (${analysis.period.days} дн)`);
  console.log('═'.repeat(64));
  console.log(
    `\n🏁 ВЕРДИКТ: ${score.verdict.toUpperCase()}  —  ${score.total}/100 баллов` +
      `\n   Узкое место: ${score.bottleneck}`
  );

  console.log('\nОценка по измерениям:');
  const rows = [
    ['Ёмкость', score.blocks.capacity],
    ['Сезонность', score.blocks.seasonality],
    ['Тренд', score.blocks.trend],
    ['Конкуренция', score.blocks.competition],
    ['Насыщенность', score.blocks.saturation],
  ];
  for (const [title, b] of rows) {
    const bar = '█'.repeat(Math.round(b.score / 2)) + '░'.repeat(10 - Math.round(b.score / 2));
    console.log(`  ${title.padEnd(13)} ${bar} ${String(b.score).padStart(2)}/20  ${b.label}`);
    console.log(`  ${''.padEnd(13)} ${b.detail}`);
  }

  const basis = c.dataBasis === 'niche' ? 'вся ниша, по ценовым сегментам' : 'по выгруженным top-N';
  console.log('\nЦифры ниши:');
  console.log(`  Товаров: ${fmt(c.productsInNiche)}` + (c.truncated ? ` (детально выгружено ${fmt(c.productsAnalyzed)} топ по выручке)` : ''));
  console.log(`  Выручка: ${fmt(c.totalRevenue)} ₽ (${fmt(c.totalUnits)} шт) за период — ${basis}`);
  console.log(`  Упущенная выручка (дефицит спроса): ${fmt(c.lostRevenue)} ₽`);
  if (analysis.sellThrough?.ratio != null) {
    console.log(`  Реализация остатка (Овчинников): ${analysis.sellThrough.ratio}× продажи/остаток · оборот ${analysis.sellThrough.medianTurnoverDays} дн.`);
  }
  console.log(`  Цена сред./медиана: ${fmt(c.avgPrice)} / ${fmt(c.medianPrice)} ₽`);
  console.log(`  Продавцов: ${fmt(comp.sellersCount)} · брендов: ${fmt(comp.brandsCount)}`);
  console.log(`  Монополизация (топ-10 товаров): ${comp.monopolyPct}% · лидер: ${comp.topSeller} (${comp.topSellerSharePct}%)`);
  if (trend) console.log(`  Тренд выручки: ${trend.growthPct}% ${trend.basis === 'yoy' ? 'год к году' : ''} (${trend.direction})`);
  if (seas?.sufficient) console.log(`  Сезонность: ${seas.level}, пик — мес ${seas.peakMonth}, спад — мес ${seas.troughMonth}`);

  if (analysis.sellers?.length) {
    console.log('\nТоп-продавцы ниши:');
    for (const s of analysis.sellers.slice(0, 7)) {
      const brand = s.brand && s.brand !== s.seller ? ` (${s.brand})` : '';
      console.log(`  ${s.seller}${brand}\t${s.products} карт.\t${fmt(s.revenue)} ₽\t${s.revenueSharePct}%${s.url ? '\t' + s.url : ''}`);
    }
  }

  // Уточняющие фразы — единой таблицей, ранжировано по реализации остатка.
  const qds = (analysis.queryDemands || []).slice()
    .sort((a, b) => (b.sellThrough?.ratio || 0) - (a.sellThrough?.ratio || 0));
  if (qds.length) {
    console.log('\nУточняющие фразы (по реализации остатка ↓):');
    console.log('  реализ.  оборот  спрос:предл  частота  запрос');
    for (const q of qds) {
      const st = q.sellThrough?.ratio;
      const ds = q.demandSupplyRatio;
      const arrow = ds == null ? ' ' : ds > 1 ? '↑' : ds < 1 ? '↓' : ' ';
      console.log(
        `  ${(st != null ? st + '×' : '—').padStart(6)}  ${(q.sellThrough?.medianTurnoverDays != null ? q.sellThrough.medianTurnoverDays + ' дн' : '—').padStart(6)}` +
        `  ${(ds != null ? arrow + ds + ':1' : '—').padStart(9)}  ${(fmt(q.frequency) || '—').padStart(7)}  ${q.query}`
      );
    }
  }

  if (analysis.notes?.length) {
    console.log('\n⚠ Примечания:');
    for (const n of analysis.notes) console.log(`  • ${n}`);
  }
}

// Запуск как самостоятельного скрипта.
//   node report-niche.js "<категория>" [d1] [d2] [запрос] [частотность] [кол-во_карточек]
// Несколько уточняющих фраз — 4-м аргументом через «;», у каждой опц. «=частота:карточки»:
//   node report-niche.js "<кат>" d1 d2 "тёплая=4569:4471; фланелевая=2086:2966"
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , argCat, argD1, argD2, argQuery, argFreq, argSupply, argCost] = process.argv;
  runNicheReport({
    categoryPath: argCat || undefined,
    d1: argD1 || undefined,
    d2: argD2 || undefined,
    cost: argCost || undefined,
    query: argQuery || undefined,
    frequency: argFreq || undefined,
    supplyCards: argSupply || undefined,
  })
    .then((analysis) => {
      const out = writeOutputs(analysis);
      printSummary(analysis);
      console.log('\nФайлы:');
      for (const p of [out.pdfPath, out.htmlPath, out.csvPath, out.jsonPath]) if (p) console.log(`  ${p}`);
    })
    .catch((err) => {
      console.error('Ошибка анализа ниши:', err?.message || err);
      process.exit(1);
    });
}
