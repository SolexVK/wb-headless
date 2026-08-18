// service/smoke-warehouses.mjs — юнит-тест резолвера складов (scripts/lib/warehouses.mjs).
// Проверяет, что новые фулфилменты подхватываются живым списком, московские
// определяются по имени, неизвестный id получает «склад N», а при ошибке WB
// происходит откат на config-снимок. Офлайн, без сети (wb мокается).
//   node smoke-warehouses.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { loadWarehouses } from '../scripts/lib/warehouses.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
const ok = (cond, msg) => { process.stdout.write(`${cond ? '✓' : '✗ FAIL'}  ${msg}\n`); if (!cond) failed++; };

// Мок WbClient: возвращает заранее заданный ответ /api/v3/warehouses (или бросает).
const mockWb = (impl) => ({ get: impl });

try {
  // 1) Живой список: новый московский ФФ + новый обычный + склад без имени.
  const live = [
    { id: 100, name: 'Казань' },
    { id: 200, name: 'Мск новая зона' }, // новый московский ФФ, которого нет в статике
    { id: 300, name: 'Электросталь' },   // новый обычный ФФ
    { id: 400, name: '  Москва-Север  ' }, // имя с пробелами и «Москва»
    { id: 500 },                          // без имени
  ];
  const a = await loadWarehouses(mockWb(async () => ({ data: live })));
  ok(a.source === 'api', 'источник — живой список (api)');
  ok(a.all.length === 5, 'все склады из живого ответа на месте (5)');
  ok(a.nameOf(300) === 'Электросталь', 'новый обычный ФФ получил своё имя');
  ok(a.nameOf(999) === 'склад 999', 'неизвестный id → «склад N»');
  ok(a.isMoscow(200) === true, 'новый московский ФФ («Мск …») классифицирован как Москва');
  ok(a.isMoscow(400) === true, 'ФФ с «Москва» в имени (и пробелами) — тоже Москва');
  ok(a.isMoscow(100) === false, 'немосковский ФФ не помечен как Москва');
  ok(a.nameOf(400) === 'Москва-Север', 'имя триммится от пробелов');
  ok(a.moscowIds.has(200) && a.moscowIds.has(400) && a.moscowIds.size === 2, 'множество московских id верное');
  ok(a.moscowNames.includes('Мск новая зона'), 'имена московских ФФ собраны');

  // 2) Пустой живой список — валидно (складов у кабинета ещё нет), источник api.
  const b = await loadWarehouses(mockWb(async () => ({ data: [] })));
  ok(b.source === 'api' && b.all.length === 0 && b.nameOf(1) === 'склад 1', 'пустой живой список — api, без падения');

  // 3) Ошибка WB (нет сети/токена) → МУЛЬТИТЕНАНТ-безопасный откат на ПУСТОЙ список,
  //    а НЕ на config одного продавца (иначе кабинету B подставились бы склады кабинета A).
  const c = await loadWarehouses(mockWb(async () => { throw new Error('no network'); }));
  ok(c.source === 'empty', 'при ошибке WB — откат на пустой список (без чужих данных)');
  ok(c.all.length === 0 && c.moscowIds.size === 0, 'откат пуст — ничего чужого не подставляется');
  ok(c.nameOf(123456) === 'склад 123456', 'неизвестный склад на откате → «склад N» (не чужое имя)');

  // 4) Неожиданный (не массив) ответ WB → тоже пустой откат.
  const d = await loadWarehouses(mockWb(async () => ({ data: { error: 'oops' } })));
  ok(d.source === 'empty', 'не-массивный ответ WB → пустой откат');

  // 5) Явный opt-in (одно-продавцовый CLI) → откат на config-снимок доступен.
  process.env.WB_WAREHOUSES_FALLBACK_CONFIG = '1';
  const e = await loadWarehouses(mockWb(async () => { throw new Error('no network'); }));
  delete process.env.WB_WAREHOUSES_FALLBACK_CONFIG;
  ok(e.source === 'config' && e.all.length > 0, 'opt-in WB_WAREHOUSES_FALLBACK_CONFIG=1 → config-снимок');
} catch (e) {
  console.error('Ошибка теста:', e); failed++;
}

process.stdout.write(failed ? `\n${failed} проверок упало\n` : '\nСклады (резолвер): все проверки зелёные\n');
process.exit(failed ? 1 : 0);
