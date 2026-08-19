// scripts/wb-penalties-probe.mjs — разведка структуры отчётов об удержаниях WB.
//
// Зачем: официальная дока показывает схемы ответов свёрнутыми («Показать все»),
// поэтому набор полей у отчётов об удержаниях по снимку страницы не восстановить.
// Скрипт делает по ОДНОМУ запросу к каждому методу и печатает СТРУКТУРУ ответа
// (имена полей + типы + один обезличенный пример), чтобы понять, какие
// идентификаторы (nmId, штрихкод, номер поставки, srid, склад) отдаёт WB по
// каждому типу штрафа — от этого зависит, можно ли привязать строку штрафа
// из Excel к нашему фулфилменту.
//
// Лимиты соблюдаются строго: у каждого метода свой methodLimit из доки
// (docs/wb-api/reports-statistics.md). Все методы — категория токена «Аналитика».
//
//   node scripts/wb-penalties-probe.mjs                 # период: последние 90 дней
//   node scripts/wb-penalties-probe.mjs 2026-01-01 2026-08-19
//   node scripts/wb-penalties-probe.mjs --json out.json # + сырые ответы в файл
//
// ВНИМАНИЕ: методы жёсткие по лимитам (1 запрос в минуту, самовыкупы — 1 в 10 мин).
// Скрипт сам выдерживает паузы через WbClient, полный прогон занимает ~1–2 минуты.

import fs from 'fs';
import { WbClient } from '../lib/wbClient.js';

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

const dateTo = dates[1] || new Date().toISOString().slice(0, 10);
const dateFrom = dates[0] || new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);

// Лимит 1 запрос в минуту — общий для «жёстких» методов удержаний.
const L_MIN = { limit: 1, periodSec: 60, burst: 1 };
const L_10MIN = { limit: 1, periodSec: 600, burst: 1 }; // самовыкупы

const ENDPOINTS = [
  {
    key: 'measurement-penalties',
    title: 'Удержания за занижение габаритов упаковки',
    path: '/api/analytics/v1/measurement-penalties',
    query: () => ({ dateFrom: `${dateFrom}T00:00:00Z`, dateTo: `${dateTo}T23:59:59Z`, limit: 10 }),
    limit: L_MIN,
    pick: (d) => d?.data?.reports,
  },
  {
    key: 'warehouse-measurements',
    title: 'Замеры склада',
    path: '/api/analytics/v1/warehouse-measurements',
    query: () => ({ dateFrom: `${dateFrom}T00:00:00Z`, dateTo: `${dateTo}T23:59:59Z`, limit: 10 }),
    limit: L_MIN,
    pick: (d) => d?.data?.reports,
  },
  {
    key: 'deductions',
    title: 'Подмены и неверные вложения',
    path: '/api/analytics/v1/deductions',
    query: () => ({ dateFrom: `${dateFrom}T00:00:00Z`, dateTo: `${dateTo}T23:59:59Z`, limit: 10 }),
    limit: L_MIN,
    pick: (d) => d?.data?.reports,
  },
  {
    key: 'antifraud-details',
    title: 'Самовыкупы',
    path: '/api/v1/analytics/antifraud-details',
    query: () => ({}),
    limit: L_10MIN,
    pick: (d) => d?.details,
  },
  {
    key: 'goods-labeling',
    title: 'Штрафы за отсутствие маркировки',
    // Максимум 31 день на запрос — берём последний месяц окна.
    path: '/api/v1/analytics/goods-labeling',
    query: () => {
      const to = new Date(dateTo + 'T00:00:00Z');
      const from = new Date(to.getTime() - 30 * 86400e3);
      return { dateFrom: from.toISOString().slice(0, 10), dateTo };
    },
    limit: L_MIN,
    pick: (d) => d?.report,
  },
];

/** Схема одной строки: поле → тип + пример (значения обрезаем). */
function schemaOf(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = {};
  for (const row of rows.slice(0, 20)) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      if (out[k]) continue;
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      let sample = v;
      if (typeof v === 'string') sample = v.length > 60 ? v.slice(0, 57) + '…' : v;
      if (Array.isArray(v)) sample = `[${v.length}]`;
      if (v && typeof v === 'object' && !Array.isArray(v)) sample = Object.keys(v).join(',');
      out[k] = { type: t, sample };
    }
  }
  return out;
}

const wb = new WbClient({ tokenType: 'personal' });
const raw = {};

console.log(`Период: ${dateFrom} … ${dateTo}\n`);

for (const ep of ENDPOINTS) {
  process.stdout.write(`\n=== ${ep.title}\n    GET ${ep.path}\n`);
  try {
    const { status, data } = await wb.get('analytics', ep.path, {
      query: ep.query(),
      methodLimit: ep.limit,
    });
    raw[ep.key] = data;
    const rows = ep.pick(data);
    const total = data?.data?.total ?? (Array.isArray(rows) ? rows.length : null);
    console.log(`    HTTP ${status} · строк в выдаче: ${Array.isArray(rows) ? rows.length : 0}` +
      (total != null ? ` · всего: ${total}` : ''));
    const sch = schemaOf(rows);
    if (!sch) { console.log('    (пусто — за период удержаний нет, структуру не видно)'); continue; }
    const w = Math.max(...Object.keys(sch).map((k) => k.length));
    for (const [k, v] of Object.entries(sch)) {
      console.log(`      ${k.padEnd(w)}  ${String(v.type).padEnd(7)}  ${v.sample}`);
    }
  } catch (e) {
    console.log(`    ! ${e.status || ''} ${e.message}`);
  }
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(raw, null, 2));
  console.log(`\nСырые ответы → ${jsonOut}`);
}
