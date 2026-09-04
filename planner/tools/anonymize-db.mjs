// anonymize-db.mjs — превратить КОПИЮ боевой базы planner в демонстрационную.
//
//   node --experimental-sqlite planner/tools/anonymize-db.mjs /opt/planner-demo/planner/data/planner.db
//
// Работает по месту, поэтому принимает только путь, где в имени есть «demo» —
// чтобы случайный запуск не изувечил боевую базу. Что делает:
//
//   1. Удаляет всё личное и секретное: пользователей, ответственных, журнал событий,
//      снимки состояния, архив отчётов, токены (MPStats, Google, Anthropic, сессии).
//   2. Обезличивает состояние: артикулы → «Модель N», поставщики и цеха → «Поставщик N»,
//      коды WB стираются, себестоимость и цены искажаются случайным множителем,
//      количества масштабируются одним коэффициентом (пропорции сохраняются).
//   3. Оставляет рыночные данные WB/MPStats (тарифы, карточки, ключевые фразы) — они
//      публичные и делают демо живым; бренд и артикулы продавца в карточках затираются.
import { createRequire } from 'node:module';
import path from 'path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const file = process.argv[2];
if (!file) { console.error('Укажи путь к БД демо-стенда'); process.exit(1); }
if (!/demo/i.test(path.resolve(file))) {
  console.error(`Отказываюсь: в пути «${file}» нет слова demo. Это защита от запуска на боевой базе.`);
  process.exit(1);
}

const db = new DatabaseSync(file);
const run = (sql, ...args) => { try { return db.prepare(sql).run(...args); } catch (e) { console.warn('  пропуск:', String(e.message).slice(0, 80)); return null; } };
const log = (...a) => console.log(' •', ...a);

// ── 1. личное и секретное ──────────────────────────────────────────────────
log('удаляю пользователей, ответственных, журнал событий');
run('DELETE FROM users');
run('DELETE FROM responsibles');
run('DELETE FROM prod_events');

log('удаляю снимки состояния и архив отчётов (в них настоящие данные)');
run('DELETE FROM state_snapshots');
run('DELETE FROM report_archive');
run('DELETE FROM season_searches');

log('удаляю токены и служебные секреты');
for (const key of ['mpstats_token', 'anthropic_key', 'google_tokens', 'google_report_sheets',
  'google_img_cache', 'nlq_cli_token', 'nlq_proxy', 'session_secret', 'mpstats_budget',
  'plancut_sales']) {
  run('DELETE FROM meta WHERE key = ?', key);
}

// ── 2. состояние приложения ────────────────────────────────────────────────
const row = db.prepare('SELECT json FROM app_state WHERE id = 1').get();
if (!row || !row.json) {
  console.log('\nВ базе нет состояния (app_state) — обезличивать нечего.');
} else {
  const st = JSON.parse(row.json);
  // Один общий множитель на объёмы: пропорции и логика плана сохраняются,
  // реальные объёмы производства не читаются.
  const qtyK = 0.7 + Math.random() * 0.5;
  const jitter = () => 0.7 + Math.random() * 0.6; // ±30% на деньги
  const money = (v) => (typeof v === 'number' && v > 0 ? Math.round((v * jitter()) / 10) * 10 : v);

  const arts = st.articles || [];
  arts.forEach((a, i) => {
    a.name = `Модель ${i + 1}`;
    if (a.vendorCode) a.vendorCode = `DEMO-${String(i + 1).padStart(3, '0')}`;
    a.wbKey = '';
    if (a.unit) {
      a.unit.cost = money(a.unit.cost);
      a.unit.logisticsToWb = money(a.unit.logisticsToWb);
      a.unit.basePrice = money(a.unit.basePrice);
      delete a.unit.wb;            // привязка к карточке WB продавца
    }
    if (a.fabricInfo && a.fabricInfo.supplier) a.fabricInfo.supplier = 'Поставщик (демо)';
    if (typeof a.qty === 'number') a.qty = Math.max(1, Math.round(a.qty * qtyK));
  });
  log(`артикулы обезличены: ${arts.length}`);

  (st.suppliers || []).forEach((s, i) => { s.name = `Поставщик ${i + 1}`; if (s.contact) s.contact = ''; if (s.note) s.note = ''; });
  (st.workshops || []).forEach((w, i) => { w.name = `Цех ${i + 1}`; if (w.note) w.note = ''; });
  log(`поставщики: ${(st.suppliers || []).length}, цеха: ${(st.workshops || []).length}`);

  (st.partias || []).forEach((p) => {
    for (const k of ['qty', 'plannedQty', 'factQty', 'shippedQty']) {
      if (typeof p[k] === 'number') p[k] = Math.max(0, Math.round(p[k] * qtyK));
    }
    if (p.note) p.note = '';
    if (p.sizes && typeof p.sizes === 'object') {
      for (const s of Object.keys(p.sizes)) {
        if (typeof p.sizes[s] === 'number') p.sizes[s] = Math.max(0, Math.round(p.sizes[s] * qtyK));
      }
    }
  });
  log(`партии пересчитаны множителем ${qtyK.toFixed(2)}: ${(st.partias || []).length}`);

  if (st.unit) { st.unit.cost = money(st.unit.cost); }
  st.version = 'demo';
  run('UPDATE app_state SET json = ?, updatedAt = ? WHERE id = 1', JSON.stringify(st), new Date().toISOString());
}

// ── 3. рыночные данные: оставляем, но стираем принадлежность продавцу ──────
log('стираю бренд и артикулы продавца в карточках WB');
run("UPDATE wb_cards SET vendorCode = 'DEMO', brand = 'Demo Brand'");

log('переименовываю метки сохранённых отчётов сезонности');
const plans = db.prepare('SELECT articleId FROM season_plans').all();
plans.forEach((p, i) => run('UPDATE season_plans SET label = ? WHERE articleId = ?', `Демо-отчёт ${i + 1}`, p.articleId));
log(`отчётов сезонности: ${plans.length}`);

db.prepare('VACUUM').run();
db.close();
console.log('\nГотово. База пригодна для публичного демо.');
