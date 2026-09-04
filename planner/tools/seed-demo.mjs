// seed-demo.mjs — наполнить базу демо-стенда ВЫМЫШЛЕННЫМИ данными.
//
//   node --experimental-sqlite planner/tools/seed-demo.mjs /opt/planner-demo/planner/data/planner.db
//
// Почему не копия боевой базы с заменой названий: даже с чужими подписями это остаётся
// настоящим производственным планом — реальные сроки, структура партий, размерные
// раскладки, число моделей. Витрину раздают кому угодно, поэтому в ней не должно быть
// НИ ОДНОЙ строки из рабочей базы. Здесь данные берутся из сида репозитория
// (lib/model.js: вымышленная фабрика, шесть цехов, пять моделей рубашек) — он открыт
// в публичном репозитории, показывать его безопасно по определению.
//
// Скрипт отказывается работать, если в пути к базе нет слова demo.
import { createRequire } from 'node:module';
import path from 'path';
import { defaultState } from '../lib/model.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2];
if (!file) { console.error('Укажи путь к базе демо-стенда'); process.exit(1); }
if (!/demo/i.test(path.resolve(file))) {
  console.error(`Отказываюсь: в пути «${file}» нет слова demo. Это защита от запуска на боевой базе.`);
  process.exit(1);
}

const db = new DatabaseSync(file);
const log = (...a) => console.log(' •', ...a);
const wipe = (table) => {
  try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* таблицы может не быть */ }
};

// Схема создаётся самим приложением при первом старте; если её ещё нет — выходим с подсказкой.
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
if (!tables.includes('app_state')) {
  console.error('В базе нет таблиц. Сначала запусти сервис один раз, чтобы он создал схему.');
  process.exit(1);
}

log('чищу всё, что могло остаться от прошлых запусков');
for (const t of ['users', 'responsibles', 'prod_events', 'state_snapshots', 'report_archive',
  'season_searches', 'season_plans', 'meta', 'wb_cards', 'wb_tariffs', 'wb_keywords',
  'wb_subject_keywords', 'wb_serp', 'feature_dict', 'wb_size_snap', 'mp_size_sales']) wipe(t);

const st = defaultState();
st.version = 'demo';
db.prepare('INSERT OR REPLACE INTO app_state(id, json, updatedAt) VALUES(1, ?, ?)')
  .run(JSON.stringify(st), new Date().toISOString());

log(`демо-план записан: моделей ${(st.articles || []).length}, партий ${(st.partias || []).length}, цехов ${(st.workshops || []).length}`);
db.prepare('VACUUM').run();
db.close();
console.log('\nГотово: в базе только вымышленные данные из сида репозитория.');
