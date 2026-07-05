// scripts/wb-competitive-analysis.mjs — CLI инструмента [3] «Конкурентный анализ».
// Логика — в lib/wbCompetitiveAnalysis.js (её же зовёт оркестратор напрямую).
//
// Вход — контракт cards-compare из [2] (файл --in или stdin). Выход — по умолчанию
// человекочитаемый markdown-отчёт в stdout; --json печатает контракт анализа.
//
//   node scripts/wb-competitive-analysis.mjs --in reports-output/run1/cards-compare.json
//   node scripts/wb-competitive-analysis.mjs --in cc.json --json --out analysis.json
//   cat cards-compare.json | node scripts/wb-competitive-analysis.mjs        # из stdin
//
// Сцепка каскада [2]→[3]: runCardsComparison пишет cards-compare.json — сюда его и подаём.

import { competitiveAnalysis, formatReport } from '../lib/wbCompetitiveAnalysis.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

try {
  const raw = opt.in ? readFileSync(opt.in, 'utf8') : readStdin();
  if (!raw.trim()) {
    log('Не передан контракт cards-compare. Пример:');
    log('  node scripts/wb-competitive-analysis.mjs --in reports-output/<run>/cards-compare.json');
    log('  ...или подать JSON в stdin.');
    process.exit(2);
  }
  const cardsCompare = JSON.parse(raw);
  const analysis = competitiveAnalysis({ cardsCompare });

  const out = opt.json ? JSON.stringify(analysis, null, 2) : formatReport(analysis);

  if (opt.out) {
    mkdirSync(dirname(opt.out), { recursive: true });
    writeFileSync(opt.out, out);
    log(`Записано: ${opt.out}`);
  } else {
    process.stdout.write(out + '\n');
  }
  log(`Анализ готов: наш ${analysis.our} vs ${analysis.rivalsCount} конкурентов; узкое место — ${analysis.funnel.bottleneck || 'нет'}.`);
} catch (err) {
  log(`Ошибка: ${err?.message || err}`);
  process.exit(1);
}
