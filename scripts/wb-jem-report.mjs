// scripts/wb-jem-report.mjs — CLI для отчётов Джем (Аналитика продавца CSV).
//
// Токен берётся автоматически (lib/wbToken.js). Категория — Аналитика.
//
// Примеры:
//   # список всех отчётов и их статусы (read-only, безопасно)
//   node scripts/wb-jem-report.mjs --list
//
//   # статус одного отчёта
//   node scripts/wb-jem-report.mjs --status <downloadId>
//
//   # полный цикл: создать отчёт «Воронка продаж по артикулам» и скачать ZIP
//   node scripts/wb-jem-report.mjs --type DETAIL_HISTORY_REPORT \
//       --start 2024-06-01 --end 2024-06-07 --out reports-output/jem.zip
//
//   # свои параметры отчёта (перебивают start/end)
//   node scripts/wb-jem-report.mjs --type SEARCH_QUERIES_PREMIUM_REPORT_TEXT \
//       --params '{"nmIds":[123],"startDate":"2024-06-01","endDate":"2024-06-07"}'
//
//   # скачать уже готовый отчёт по id
//   node scripts/wb-jem-report.mjs --file <downloadId> --out reports-output/jem.zip
//
// ⚠️ Создание отчёта тратит суточную квоту (максимум 20 отчётов/сутки).

import fs from 'fs';
import path from 'path';
import { WbJemReports, JEM_REPORT_TYPES, NON_JEM_TYPES } from '../lib/wbJemReports.js';

// ── простой парсер --флагов ───────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { opt[key] = next; i++; } else { opt[key] = true; }
  }
}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function defaultParams(type, start, end) {
  const stock = NON_JEM_TYPES.has(type);
  if (stock) return { startDate: start, endDate: end };
  // Воронка/поисковые: типовой набор с пустыми фильтрами (весь ассортимент).
  return {
    nmIDs: [], subjectIds: [], brandNames: [], tagIds: [],
    startDate: start, endDate: end,
    timezone: 'Europe/Moscow', aggregationLevel: 'day', skipDeletedNm: false,
  };
}

async function main() {
  const jem = new WbJemReports(); // токен и тип токена — из окружения

  if (opt.help || (!opt.list && !opt.status && !opt.file && !opt.type)) {
    log('Отчёты Джем (Аналитика продавца CSV). Типы reportType:');
    for (const [t, d] of Object.entries(JEM_REPORT_TYPES)) log(`  ${t}  — ${d}`);
    log('\nФлаги: --list | --status <id> | --file <id> --out <zip> |');
    log('       --type <TYPE> --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--params <json>] [--out <zip>] [--name <str>]');
    process.exit(0);
  }

  // 1) Список отчётов.
  if (opt.list) {
    const rows = await jem.list();
    log(`Отчётов: ${rows.length}`);
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  // 2) Статус одного отчёта.
  if (opt.status) {
    const st = await jem.status(String(opt.status));
    process.stdout.write(JSON.stringify(st, null, 2) + '\n');
    return;
  }

  // 3) Скачать готовый отчёт по id.
  if (opt.file) {
    const zip = await jem.getFile(String(opt.file));
    const out = opt.out || `reports-output/jem-${opt.file}.zip`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zip);
    log(`✓ скачано: ${out} (${zip.length} байт)`);
    return;
  }

  // 4) Полный цикл: создать → дождаться → скачать.
  const type = String(opt.type);
  if (!JEM_REPORT_TYPES[type]) throw new Error(`Неизвестный reportType: ${type}`);
  const params = opt.params ? JSON.parse(opt.params) : defaultParams(type, opt.start, opt.end);
  if (!params.startDate || !params.endDate) {
    throw new Error('Нужны --start и --end (или --params с startDate/endDate)');
  }

  log(`Создаю отчёт ${type} за ${params.startDate}…${params.endDate}` +
      (NON_JEM_TYPES.has(type) ? ' (подписка Джем не требуется)' : ' (нужна подписка Джем)'));
  const { id, zip, status } = await jem.generateAndDownload({
    reportType: type, params, userReportName: opt.name,
    onPoll: (st, raw) => log(`  … статус: ${(st?.status ?? raw) || 'pending'}`),
  });

  const out = opt.out || `reports-output/jem-${type}-${params.startDate}_${params.endDate}.zip`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip);
  log(`✓ готово: ${out} (${zip.length} байт), id=${id}, статус=${status?.status ?? 'done'}`);
}

main().catch((err) => {
  log('Ошибка:', err?.message || err);
  if (err?.status) log('HTTP статус:', err.status);
  if (err?.data) log('Ответ:', JSON.stringify(err.data).slice(0, 400));
  process.exit(1);
});
