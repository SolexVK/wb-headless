#!/usr/bin/env node
// scripts/wb-card.mjs — карточка WB по артикулу: характеристики, фото, гейт.
//
// Запуск:
//   node scripts/wb-card.mjs 237194752
//   node scripts/wb-card.mjs 237194752 227781398 179331048
//   node scripts/wb-card.mjs --json 237194752
//   node scripts/wb-card.mjs --fields   # сводка: какие поля вообще приходят
//
// Режим --fields берёт артикулы из аргументов (или из топа категории через
// MPStats, если задан MPSTATS_TOKEN) и считает, насколько часто продавцы
// заполняют каждую характеристику. Это нужно, чтобы понимать, на какие поля
// вообще можно опираться в текстовом гейте.

import { loadEnv } from '../lib/loadEnv.js';
import {
  fetchCard, photoUrls, hardRejectByOptions, attributesFromOptions, mapLimit,
} from '../lib/wbCard.js';

loadEnv();

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fieldsMode = args.includes('--fields');
const nmIds = args.filter((a) => /^\d{5,}$/.test(a)).map(Number);

if (!nmIds.length) {
  console.error('Укажите артикулы: node scripts/wb-card.mjs <nmId> [nmId ...]');
  console.error('Флаги: --json (машинный вывод), --fields (частота заполнения полей)');
  process.exit(1);
}

const cards = await mapLimit(nmIds, 8, async (nm) => {
  const card = await fetchCard(nm);
  if (!card) return { nmId: nm, missing: true };
  return card;
});

// ── Режим сводки по полям ────────────────────────────────────────────────────
if (fieldsMode) {
  const found = cards.filter((c) => !c.missing && !c.error);
  const counts = new Map();
  for (const c of found) {
    for (const [k, v] of Object.entries(c.options)) {
      if (!counts.has(k)) counts.set(k, { n: 0, samples: new Set() });
      const e = counts.get(k);
      e.n += 1;
      if (e.samples.size < 4) e.samples.add(v.slice(0, 28));
    }
  }
  console.log(`Карточек прочитано: ${found.length} из ${nmIds.length}\n`);
  console.log('ПОЛЕ                              ЗАПОЛНЕНО   ПРИМЕРЫ ЗНАЧЕНИЙ');
  const rows = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [name, e] of rows) {
    const pct = Math.round((100 * e.n) / found.length);
    console.log(`${name.padEnd(33)} ${String(pct).padStart(3)}%      ${[...e.samples].join(' | ')}`);
  }
  process.exit(0);
}

// ── Машинный вывод ───────────────────────────────────────────────────────────
if (asJson) {
  const out = cards.map((c) => (c.missing || c.error ? c : {
    ...c,
    photos: photoUrls(c, 3),
    gate: hardRejectByOptions(c),
    attrs: attributesFromOptions(c),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// ── Человеческий вывод ───────────────────────────────────────────────────────
for (const c of cards) {
  console.log('─'.repeat(78));
  if (c.missing) { console.log(`${c.nmId}: карточка не найдена на CDN`); continue; }
  if (c.error) { console.log(`${c.nmId}: ошибка — ${c.error}`); continue; }

  console.log(`${c.nmId}  ·  basket-${String(c.shard).padStart(2, '0')}  ·  ${c.brand || 'без бренда'}`);
  console.log(`  ${c.name}`);
  console.log(`  раздел: ${c.subjectRoot} / ${c.subject}   фото: ${c.photoCount}${c.hasVideo ? ' + видео' : ''}`);

  const gate = hardRejectByOptions(c);
  console.log(gate.rejected
    ? `  ГЕЙТ: ОТСЕВ — «${gate.field}» = «${gate.value}»`
    : '  ГЕЙТ: проходит');

  console.log('  характеристики:');
  const opts = Object.entries(c.options);
  if (!opts.length) console.log('    (продавец не заполнил ни одной)');
  for (const [k, v] of opts) console.log(`    ${k}: ${v}`);

  const a = attributesFromOptions(c);
  const known = Object.entries(a).filter(([, v]) => v !== null && v !== '');
  console.log(`  признаки эталона из текста (${known.length} из ${Object.keys(a).length}):`);
  for (const [k, v] of known) console.log(`    ${k} = ${v}`);

  console.log('  фото:');
  for (const u of photoUrls(c, 3)) console.log(`    ${u}`);
}
console.log('─'.repeat(78));
