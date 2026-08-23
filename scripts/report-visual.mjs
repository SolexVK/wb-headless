#!/usr/bin/env node
// scripts/report-visual.mjs — сборка отчёта из результатов прогона зрения.
//
// Читает то, что уже посчитано, и ничего не спрашивает у моделей и у MPStats:
//   out/vision-gate.jsonl   — гейт: тип изделия + характеристики карточки
//   out/vision-attrs.jsonl  — разбор: воротник, рукав, манжета, рисунок, плечо
//   data/*-meta.csv         — выручка, цена, отзывы (собрано там, где есть токен)
//
// Сводит признаки из текста и с фотографий, считает балл детерминированно
// (lib/visualScore.js) и раскладывает по корзинам.
//
// Запуск:
//   node scripts/report-visual.mjs
//   node scripts/report-visual.mjs --meta data/top500-shirts-meta.csv --top 30
//   node scripts/report-visual.mjs --csv out/report.csv --band close

import fs from 'fs';
import path from 'path';
import { TARGET } from '../lib/visualProfile.js';
import { mergeObservations, scoreCard, explain } from '../lib/visualScore.js';
import { attributesFromOptions } from '../lib/wbCard.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const OUT_DIR = arg('out-dir', path.resolve(process.cwd(), 'out'));
const GATE_FILE = arg('gate', path.join(OUT_DIR, 'vision-gate.jsonl'));
const ATTRS_FILE = arg('attrs', path.join(OUT_DIR, 'vision-attrs.jsonl'));
const META_FILE = arg('meta', path.resolve(process.cwd(), 'data', 'top500-shirts-meta.csv'));
const CSV_OUT = arg('csv', path.join(OUT_DIR, 'report.csv'));
const TOP_N = Number(arg('top', 20));
const ONLY_BAND = arg('band');

// ── Чтение ───────────────────────────────────────────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* битая строка */ }
  }
  return out;
}

/** Мини-разбор CSV: значения в кавычках могут содержать запятые. */
function readCsv(file) {
  if (!fs.existsSync(file)) return new Map();
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  const map = new Map();
  for (const line of lines) {
    const vals = line.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    const row = {};
    cols.forEach((c, i) => {
      let v = (vals[i] ?? '').trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/""/g, '"');
      row[c] = v;
    });
    if (row.nmId) map.set(Number(row.nmId), row);
  }
  return map;
}

const gate = readJsonl(GATE_FILE);
const attrs = readJsonl(ATTRS_FILE);
const meta = readCsv(META_FILE);

if (!gate.length && !attrs.length) {
  console.error(`Нет данных: ни ${GATE_FILE}, ни ${ATTRS_FILE}`);
  process.exit(1);
}

// ── Сведение по артикулу ─────────────────────────────────────────────────────
const byId = new Map();
const put = (nmId, patch) => byId.set(nmId, { ...(byId.get(nmId) || { nmId }), ...patch });

for (const r of gate) {
  if (r.error) { put(r.nmId, { gateError: r.error }); continue; }
  if (r.textReject) { put(r.nmId, { textReject: r.textReject }); continue; }
  put(r.nmId, { gateVision: r.vision, name: r.name, options: r.options });
}
for (const r of attrs) {
  if (r.error) { put(r.nmId, { attrsError: r.error }); continue; }
  put(r.nmId, { attrsVision: r.vision, name: r.name || byId.get(r.nmId)?.name,
    options: r.options || byId.get(r.nmId)?.options, attrsMs: r.ms });
}

// ── Скоринг ──────────────────────────────────────────────────────────────────
const scored = [];
const stats = { textReject: 0, gateReject: 0, errors: 0, noAttrs: 0 };

for (const card of byId.values()) {
  if (card.gateError || card.attrsError) { stats.errors += 1; continue; }
  if (card.textReject) { stats.textReject += 1; continue; }
  if (card.gateVision && card.gateVision.garment_type !== 'shirt') { stats.gateReject += 1; continue; }
  if (!card.attrsVision) { stats.noAttrs += 1; continue; }

  const fromText = attributesFromOptions({ options: card.options || {} });
  const fromVision = { ...card.attrsVision, garment_type: card.gateVision?.garment_type };
  const { values, sources, conflicts } = mergeObservations(fromText, fromVision, TARGET);
  const res = scoreCard(values, TARGET);

  scored.push({ ...card, values, sources, conflicts, ...res, meta: meta.get(card.nmId) || {} });
}

scored.sort((a, b) => b.score - a.score);

// ── Сводка ───────────────────────────────────────────────────────────────────
const line = '─'.repeat(78);
console.log(`\n${line}\nВОРОНКА\n${line}`);
console.log(`  всего артикулов в прогоне:    ${byId.size}`);
console.log(`  отсеял текстовый гейт:        ${stats.textReject}`);
console.log(`  отсеял гейт зрением:          ${stats.gateReject}`);
console.log(`  карточка пропала / ошибка:    ${stats.errors}`);
console.log(`  прошли гейт, но без разбора:  ${stats.noAttrs}`);
console.log(`  ОЦЕНЕНО:                      ${scored.length}`);

console.log(`\n${line}\nРАСПРЕДЕЛЕНИЕ ПО КОРЗИНАМ\n${line}`);
const byBand = new Map();
for (const s of scored) byBand.set(s.band, (byBand.get(s.band) || 0) + 1);
for (const b of TARGET.bands) {
  const n = byBand.get(b.key) || 0;
  const bar = '█'.repeat(Math.round((60 * n) / Math.max(1, scored.length)));
  console.log(`  ${String(b.from).padStart(3)}+ ${b.label.padEnd(24)} ${String(n).padStart(4)}  ${bar}`);
}
const gateFailed = byBand.get('gate_failed') || 0;
if (gateFailed) console.log(`      ${'отсев по гейту профиля'.padEnd(24)} ${String(gateFailed).padStart(4)}`);

// ── Наблюдаемость и расхождения ──────────────────────────────────────────────
const lowObs = scored.filter((s) => s.lowObservability).length;
const withConflicts = scored.filter((s) => s.conflicts.length).length;
console.log(`\n  низкая наблюдаемость (3+ признака не видно): ${lowObs}`);
console.log(`  расхождения текста и фото:                   ${withConflicts}`);

const unknownBy = new Map();
for (const s of scored) for (const a of s.unknown) unknownBy.set(a, (unknownBy.get(a) || 0) + 1);
if (unknownBy.size) {
  console.log('\n  какие признаки чаще всего не видны:');
  for (const [a, n] of [...unknownBy].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
    console.log(`    ${a.padEnd(14)} ${n} (${Math.round((100 * n) / scored.length)} %)`);
  }
}

const conflictBy = new Map();
for (const s of scored) for (const c of s.conflicts) conflictBy.set(c.attr, (conflictBy.get(c.attr) || 0) + 1);
if (conflictBy.size) {
  console.log('\n  где продавец расходится с фотографией:');
  for (const [a, n] of [...conflictBy].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${a.padEnd(14)} ${n} (${Math.round((100 * n) / scored.length)} %)`);
  }
}

// ── Топ ──────────────────────────────────────────────────────────────────────
const shown = ONLY_BAND ? scored.filter((s) => s.band === ONLY_BAND) : scored;
console.log(`\n${line}\nТОП-${Math.min(TOP_N, shown.length)}${ONLY_BAND ? ` (корзина «${ONLY_BAND}»)` : ''}\n${line}`);
for (const s of shown.slice(0, TOP_N)) {
  const m = s.meta;
  const rub = (v) => (v ? `${Number(v).toLocaleString('ru')} ₽` : '—');
  console.log(`\n${s.score.toString().padStart(3)}  ${s.nmId}  ${s.bandLabel}`);
  console.log(`     ${(s.name || m.name || '').slice(0, 66)}`);
  console.log(`     выручка ${rub(m.revenue)} · цена ${rub(m.price)} · отзывов ${m.comments || '—'}`
    + ` · рейтинг ${m.rating || '—'}`);
  const mism = s.mismatched.filter((x) => x.credit < 1)
    .map((x) => `${x.attr}=${x.value}`).join(', ');
  if (mism) console.log(`     не совпало: ${mism}`);
  if (s.unknown.length) console.log(`     не видно: ${s.unknown.join(', ')}`);
  for (const c of s.conflicts) {
    console.log(`     ⚠ ${c.attr}: продавец «${c.text}», фото «${c.vision}»`);
  }
  console.log(`     https://www.wildberries.ru/catalog/${s.nmId}/detail.aspx`);
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const attrKeys = Object.keys(TARGET.attributes);
const header = ['nmId', 'score', 'band', 'lowObservability', 'unknownCount', 'conflicts',
  'revenue', 'price', 'units', 'rating', 'comments', 'brand', 'name',
  ...attrKeys, ...attrKeys.map((k) => `src_${k}`), 'url'];
const lines = [header.join(',')];
for (const s of scored) {
  const m = s.meta;
  lines.push([
    s.nmId, s.score, s.band, s.lowObservability ? 1 : 0, s.unknown.length,
    esc(s.conflicts.map((c) => `${c.attr}:текст=${c.text}/фото=${c.vision}`).join('; ')),
    m.revenue || '', m.price || '', m.units || '', m.rating || '', m.comments || '',
    esc(m.brand), esc(s.name || m.name),
    ...attrKeys.map((k) => s.values[k]),
    ...attrKeys.map((k) => s.sources[k]),
    `https://www.wildberries.ru/catalog/${s.nmId}/detail.aspx`,
  ].join(','));
}
fs.mkdirSync(path.dirname(CSV_OUT), { recursive: true });
fs.writeFileSync(CSV_OUT, `${lines.join('\n')}\n`);
console.log(`\n${line}`);
console.log(`CSV: ${CSV_OUT} (${scored.length} строк)`);
console.log(`Подробный разбор одной карточки: node scripts/report-visual.mjs --top 1`);
