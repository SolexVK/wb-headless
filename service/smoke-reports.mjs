// service/smoke-reports.mjs — Фаза 2: оболочка отчётов + Подсорт (офлайн).
// PODSORT_FAKE=1 → раннер не ходит в WB, а кладёт канонический снимок.
//   node --experimental-sqlite smoke-reports.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite'; // для «состаривания» снимка (тест вкладки «Динамика»)

process.env.NODE_ENV = 'test';
process.env.BASE_PATH = ''; // тест в корне: не даём .env (BASE_PATH=/fbs) сбить пути
process.env.SESSION_SECRET = 'test-secret-please-change';
process.env.TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.WB_PING_ONLINE = '0';
process.env.PODSORT_FAKE = '1';
process.env.DEFAULT_LICENSE_SEATS = '3'; // чтобы пригласить участника для теста прав удаления
process.env.DB_PATH = path.join(os.tmpdir(), `fbs-reports-${process.pid}.sqlite`);

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const goodToken = (() => {
  const s = 2 ** 1 + 2 ** 4 + 2 ** 5; // Контент+Маркетплейс+Статистика
  const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
  return `${b64url({ alg: 'HS256' })}.${b64url({ s, acc: 1, sid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', exp, t: false })}.sig`;
})();

const { buildApp } = await import('./app.js');
const { Cabinets, ReportRuns } = await import('./models.js'); // для инъекции «снимка по расписанию» (userId=null)
const app = buildApp();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
async function req(method, url, body) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  for (const c of (res.headers.getSetCookie?.() || [])) cookie = c.split(';')[0];
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}
const form = (o) => new URLSearchParams(o).toString();
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (cond, msg) => { process.stdout.write(`${cond ? '✓' : '✗ FAIL'}  ${msg}\n`); if (!cond) failed++; };
// PDF зависит от наличия Chromium. Есть → строгая проверка сигнатуры; нет → мягкий пропуск.
async function pdfCheck(url, msg) {
  const r = await fetch(base + url, { headers: { cookie } });
  if (r.status === 200) { const b = Buffer.from(await r.arrayBuffer()); ok(b.slice(0, 4).toString('latin1') === '%PDF' && b.length > 1000, msg); }
  else process.stdout.write(`  ⚠  ${msg} — пропущен (нет Chromium в этой среде)\n`);
}

try {
  // Регистрация + кабинет с валидным токеном.
  let r = await req('GET', '/register');
  const email = `rep_${Date.now()}@example.com`;
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email, password: 'supersecret1', name: 'Отчёты' }));
  r = await req('GET', '/');
  const orgId = (r.text.match(/href="\/org\/(\d+)"/) || [])[1];
  r = await req('GET', `/org/${orgId}`);
  r = await req('POST', `/org/${orgId}/cabinet`, form({ _csrf: csrfOf(r.text), company: 'Осн', token: goodToken }));
  ok(r.status === 200 && r.text.includes('сохранён'), 'Ф2: кабинет с токеном подключён (настройка компании)');

  r = await req('GET', `/org/${orgId}/reports`);
  ok(r.status === 200 && r.text.includes('Подсорт') && r.text.includes('подключён'), 'Ф2: список отчётов + подключённый кабинет');

  r = await req('GET', `/org/${orgId}/reports/podsort`);
  const csrfP = csrfOf(r.text);
  ok(r.status === 200 && r.text.includes('Параметры расчёта') && r.text.includes('Данных пока нет'), 'Ф2: страница подсорта (форма, данных нет)');

  r = await req('POST', `/org/${orgId}/reports/podsort/refresh`, form({ _csrf: csrfP, articles: '002,003', velocityDays: 28, leadMin: 12, leadMax: 18, cover: 28, seedMin: 10, historyDays: 90 }));
  ok(r.status === 302, 'Ф2: запуск пересчёта → 302');

  // Ждём завершения фонового (фейкового) джоба.
  let done = false;
  for (let i = 0; i < 30 && !done; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/podsort`);
    if (r.text.includes('штук к подсорту') && r.text.includes('42')) done = true;
  }
  ok(done, 'Ф2: результат появился (подсорт 42 шт)');
  ok(r.text.includes('Сводная') && r.text.includes('⬇ Excel'), 'Ф2: сводная + кнопки выгрузки');

  const j = await req('GET', `/org/${orgId}/reports/podsort/download/json`);
  let parsed = null; try { parsed = JSON.parse(j.text); } catch { /* */ }
  ok(j.status === 200 && parsed?.totals?.reorderUnits === 42, 'Ф2: выгрузка JSON корректна');

  // Второй запуск → в архиве два запуска.
  r = await req('GET', `/org/${orgId}/reports/podsort`);
  r = await req('POST', `/org/${orgId}/reports/podsort/refresh`, form({ _csrf: csrfOf(r.text), articles: '002', velocityDays: 28, leadMin: 12, leadMax: 18, cover: 28, seedMin: 10, historyDays: 90 }));
  for (let i = 0; i < 30; i++) { await sleep(80); r = await req('GET', `/org/${orgId}/reports/archive`); if ((r.text.match(/\/archive\/\d+"/g) || []).length >= 2) break; }
  const runIds = [...new Set((r.text.match(/\/reports\/archive\/(\d+)"/g) || []).map((m) => m.match(/\d+/)[0]))];
  ok(r.status === 200 && r.text.includes('Архив отчётов') && runIds.length >= 2, 'Ф2: архив содержит запуски (≥2)');

  // Открыть архивный запуск — регенерируется вывод из снимка.
  r = await req('GET', `/org/${orgId}/reports/archive/${runIds[0]}`);
  ok(r.status === 200 && r.text.includes('подсорту') && r.text.includes('42'), 'Ф2: просмотр архивного запуска');
  const aj = await req('GET', `/org/${orgId}/reports/archive/${runIds[0]}/download/json`);
  let ap = null; try { ap = JSON.parse(aj.text); } catch { /* */ }
  ok(aj.status === 200 && ap?.totals?.reorderUnits === 42, 'Ф2: выгрузка архивного запуска (JSON)');

  // Изоляция: чужой архивный запуск недоступен.
  r = await req('GET', `/org/${orgId}/reports/archive/999999`);
  ok(r.status === 404, 'Ф2: несуществующий запуск → 404');

  // ── Отчёт «Остатки» ─────────────────────────────────────────────────────────
  r = await req('GET', `/org/${orgId}/reports/stock`);
  ok(r.status === 200 && r.text.includes('Остатки') && r.text.includes('Обновить данные'), 'Ф2: страница остатков');
  r = await req('POST', `/org/${orgId}/reports/stock/refresh`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 302, 'Ф2: запуск остатков → 302');
  let stDone = false;
  for (let i = 0; i < 30 && !stDone; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/stock`);
    if (r.text.includes('По фулфилментам') && r.text.includes('Тест-склад')) stDone = true;
  }
  ok(stDone, 'Ф2: остатки собрались (по фулфилментам)');
  const sj = await req('GET', `/org/${orgId}/reports/stock/download/json`);
  let sp = null; try { sp = JSON.parse(sj.text); } catch { /* */ }
  ok(sj.status === 200 && sp?.totals?.grandTotal === 12, 'Ф2: выгрузка остатков (JSON)');
  // Excel-выгрузка остатков (openpyxl → .xlsx = zip, сигнатура PK\x03\x04).
  const sx = await fetch(base + `/org/${orgId}/reports/stock/download/xlsx`, { headers: { cookie } });
  const xbuf = Buffer.from(await sx.arrayBuffer());
  ok(sx.status === 200 && xbuf.length > 500 && xbuf[0] === 0x50 && xbuf[1] === 0x4b, 'Ф2: выгрузка остатков (Excel .xlsx)');
  const sh = await fetch(base + `/org/${orgId}/reports/stock/download/html`, { headers: { cookie } });
  const shx = await sh.text();
  ok(sh.status === 200 && shx.includes('Остатки по фулфилмент'), 'Ф2: HTML-дашборд остатков');
  await pdfCheck(`/org/${orgId}/reports/stock/download/pdf`, 'Ф2: PDF-дашборд остатков');
  // Остатки попали в общий архив (report=stock).
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('Остатки') && /остаток\s*12/.test(r.text), 'Ф2: остатки видны в архиве');

  // Второй снимок остатков → выбор даты (dropdown) на странице отчёта.
  r = await req('GET', `/org/${orgId}/reports/stock`);
  r = await req('POST', `/org/${orgId}/reports/stock/refresh`, form({ _csrf: csrfOf(r.text) }));
  let twoSnaps = false, stockOpts = [];
  for (let i = 0; i < 30 && !twoSnaps; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/stock`);
    stockOpts = [...new Set((r.text.match(/<option value="(\d+)"/g) || []).map((m) => m.match(/\d+/)[0]))];
    if (r.text.includes('Снимок на дату') && stockOpts.length >= 2) twoSnaps = true;
  }
  ok(twoSnaps, 'Ф2: выбор даты остатков появился (≥2 снимка)');
  // Открыть более ранний снимок из архива по ?run= — показывается пометка «из архива».
  const older = stockOpts[stockOpts.length - 1];
  r = await req('GET', `/org/${orgId}/reports/stock?run=${older}`);
  ok(r.status === 200 && r.text.includes('из архива') && r.text.includes('Снимок остатков на'), 'Ф2: остатки на выбранную дату (снимок из архива)');

  // ── Остатки → вкладка «Динамика» ─────────────────────────────────────────────
  // Оба снимка — за один UTC-день, поэтому в графике 1 точка (нужно ≥2): проверяем
  // подсказку и защиту выгрузки. Затем «состариваем» один снимок на день назад
  // прямым SQL (как будто это вчерашний авто-снимок) → появляется реальный график.
  r = await req('GET', `/org/${orgId}/reports/stock?tab=dynamics`);
  ok(r.status === 200 && r.text.includes('Динамика') && r.text.includes('нужно') && /tab=dynamics/.test(r.text), 'Ф2: вкладка «Динамика» (1 снимок → подсказка «нужно ≥2»)');
  r = await req('GET', `/org/${orgId}/reports/stock/dynamics/download/pdf`);
  ok(r.status === 404, 'Ф2: динамика PDF при <2 снимках → 404 (защита)');

  const raw = new DatabaseSync(process.env.DB_PATH);
  raw.prepare("UPDATE report_runs SET created_at = datetime('now','-1 day') WHERE id = (SELECT MIN(id) FROM report_runs WHERE report='stock')").run();
  raw.close();
  r = await req('GET', `/org/${orgId}/reports/stock?tab=dynamics`);
  ok(r.status === 200 && r.text.includes('mv-chart') && r.text.includes('Изменение за период') && r.text.includes('Дней до 0'), 'Ф2: динамика — график по 2 дням (mv-chart + таблица + дни до 0)');
  ok(r.text.includes('data-dyn=') && r.text.includes('class="dyn-chip"') && r.text.includes('data-li="0"') && r.text.includes('data-dyn-all') && r.text.includes('data-dyn-none'), 'Ф2: динамика — чипы ФФ + «Показать все» + «Сбросить все»');
  ok(!r.text.includes('снимков в графике') && !r.text.includes('период (по снимкам)'), 'Ф2: динамика — убраны пустые плашки «период/снимков»');
  const dj = await req('GET', `/org/${orgId}/reports/stock/dynamics/download/json`);
  let dser = null; try { dser = JSON.parse(dj.text); } catch { /* */ }
  ok(dj.status === 200 && dser?.count === 2 && Array.isArray(dser?.warehouses), 'Ф2: динамика JSON — 2 дня, ряд по ФФ');
  const dh = await req('GET', `/org/${orgId}/reports/stock/dynamics/download/html`);
  ok(dh.status === 200 && /<html/i.test(dh.text) && dh.text.includes('Динамика остатков'), 'Ф2: динамика HTML-дашборд');
  await pdfCheck(`/org/${orgId}/reports/stock/dynamics/download/pdf`, 'Ф2: динамика PDF-дашборд');

  // ── Отчёт «Движение заказов» ─────────────────────────────────────────────────
  r = await req('GET', `/org/${orgId}/reports/movement`);
  ok(r.status === 200 && r.text.includes('Движение заказов') && r.text.includes('Параметры'), 'Ф2: страница движения заказов');
  r = await req('POST', `/org/${orgId}/reports/movement/refresh`, form({ _csrf: csrfOf(r.text), days: 14, articles: '' }));
  ok(r.status === 302, 'Ф2: запуск движения → 302');
  let mvDone = false;
  for (let i = 0; i < 30 && !mvDone; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/movement`);
    if (r.text.includes('Показатель') && r.text.includes('Тест-склад')) mvDone = true;
  }
  ok(mvDone, 'Ф2: движение собралось (тумблеры + фулфилмент)');
  const mj = await req('GET', `/org/${orgId}/reports/movement/download/json`);
  let mp = null; try { mp = JSON.parse(mj.text); } catch { /* */ }
  ok(mj.status === 200 && Array.isArray(mp?.series) && mp.series.length === 28 && mp.fulfillments.includes('Тест-склад'), 'Ф2: выгрузка движения (JSON, серия 28 дн)');
  const mx = await fetch(base + `/org/${orgId}/reports/movement/download/xlsx`, { headers: { cookie } });
  const mxb = Buffer.from(await mx.arrayBuffer());
  ok(mx.status === 200 && mxb.length > 500 && mxb[0] === 0x50 && mxb[1] === 0x4b, 'Ф2: выгрузка движения (Excel .xlsx)');
  const mh = await fetch(base + `/org/${orgId}/reports/movement/download/html`, { headers: { cookie } });
  const mhx = await mh.text();
  ok(mh.status === 200 && mhx.includes('Движение заказов по фулфилментам'), 'Ф2: HTML-дашборд движения');
  await pdfCheck(`/org/${orgId}/reports/movement/download/pdf`, 'Ф2: PDF-дашборд движения');
  // Тумблер единицы (₽) и базы оценки: себестоимость / ср.цена продажи / цена заказа.
  r = await req('GET', `/org/${orgId}/reports/movement?focus=delivered&unit=money&basis=cost&cost=620`);
  ok(r.status === 200 && r.text.includes('₽ (Себестоимость)') && r.text.includes('Себест., ₽'), 'Ф2: движение — база «себестоимость» (₽)');
  r = await req('GET', `/org/${orgId}/reports/movement?focus=delivered&unit=money&basis=sale`);
  ok(r.status === 200 && r.text.includes('₽ (Ср. цена 7д)'), 'Ф2: движение — база «ср. цена продажи 7д»');
  r = await req('GET', `/org/${orgId}/reports/movement?cmp=1`);
  ok(r.status === 200 && r.text.includes('Сравнение с прошлым периодом'), 'Ф2: движение — сравнение с прошлым периодом');
  // Фильтр складов: скрыть единственный склад → просьба выбрать хотя бы один.
  r = await req('GET', `/org/${orgId}/reports/movement?hide=0`);
  ok(r.status === 200 && r.text.includes('Выберите хотя бы один склад'), 'Ф2: движение — фильтр складов (скрыт всё → подсказка)');
  // Движение попало в общий архив.
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('Движение заказов') && /принято\s+[\d\s ]+·\s*передано/.test(r.text), 'Ф2: движение видно в архиве');
  // Фильтр архива по типу отчёта.
  ok(r.text.includes('Тип отчёта:') && r.text.includes('<option value="movement"'), 'Ф2: в архиве есть фильтр по типу отчёта');
  r = await req('GET', `/org/${orgId}/reports/archive?report=stock`);
  ok(r.status === 200 && /остаток\s+\d/.test(r.text) && !/·\s*передано\s+\d/.test(r.text), 'Ф2: фильтр архива показывает только выбранный тип');

  // ── Отчёт «География» ────────────────────────────────────────────────────────
  r = await req('GET', `/org/${orgId}/reports/geo`);
  ok(r.status === 200 && r.text.includes('География продаж и возвратов') && r.text.includes('Параметры'), 'Ф2: страница географии');
  r = await req('POST', `/org/${orgId}/reports/geo/refresh`, form({ _csrf: csrfOf(r.text), days: 30 }));
  ok(r.status === 302, 'Ф2: запуск географии → 302');
  let geoDone = false;
  for (let i = 0; i < 30 && !geoDone; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/geo`);
    if (r.text.includes('dk-kpi') && r.text.includes('Москва')) geoDone = true;
  }
  ok(geoDone, 'Ф2: география собралась (регионы)');
  const gj = await req('GET', `/org/${orgId}/reports/geo/download/json`);
  let gp = null; try { gp = JSON.parse(gj.text); } catch { /* */ }
  ok(gj.status === 200 && gp?.scopes?.all?.byRegion?.length === 3 && gp?.moscowNmCount === 2, 'Ф2: выгрузка географии (JSON)');
  const gx = await fetch(base + `/org/${orgId}/reports/geo/download/xlsx`, { headers: { cookie } });
  const gxb = Buffer.from(await gx.arrayBuffer());
  ok(gx.status === 200 && gxb.length > 500 && gxb[0] === 0x50 && gxb[1] === 0x4b, 'Ф2: выгрузка географии (Excel .xlsx)');
  const gh = await fetch(base + `/org/${orgId}/reports/geo/download/html`, { headers: { cookie } });
  const ghx = await gh.text();
  ok(gh.status === 200 && ghx.includes('География продаж и возвратов'), 'Ф2: HTML-дашборд географии');
  await pdfCheck(`/org/${orgId}/reports/geo/download/pdf`, 'Ф2: PDF-дашборд географии');
  r = await req('GET', `/org/${orgId}/reports/geo?scope=moscow&focus=pct&gran=okrug`);
  ok(r.status === 200 && r.text.includes('Товары моск. FF'), 'Ф2: география — тумблеры (моск. FF / % / округа)');
  ok(gp?.fbs?.byFF?.length >= 2 && gp?.fbs?.totals?.shipped > 0, 'Ф2: география — FBS-блок в снимке (byFF, отгружено)');
  r = await req('GET', `/org/${orgId}/reports/geo?tab=ff`);
  ok(r.status === 200 && r.text.includes('По ФФ отгрузки') && r.text.includes('Казань') && r.text.includes('исходному ФФ отгрузки'), 'Ф2: география — вкладка «По ФФ отгрузки» (привязка возвратов)');
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('География') && /продаж\s+\d+\s*·\s*возвратов/.test(r.text), 'Ф2: география видна в архиве');

  // ── Отчёт «Логистика» (сроки сборки, доставки и путь возврата) ──────────────
  r = await req('GET', `/org/${orgId}/reports/logistics`);
  ok(r.status === 200 && r.text.includes('сроки сборки, доставки и путь возврата') && r.text.includes('Параметры'), 'Ф2: страница логистики');
  r = await req('POST', `/org/${orgId}/reports/logistics/refresh`, form({ _csrf: csrfOf(r.text), days: 30 }));
  ok(r.status === 302, 'Ф2: запуск логистики → 302');
  let logiDone = false;
  for (let i = 0; i < 30 && !logiDone; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/logistics`);
    if (r.text.includes('Сроки сборки по ФФ') && r.text.includes('Казань')) logiDone = true;
  }
  ok(logiDone, 'Ф2: логистика собралась (сборка по ФФ)');
  const lj = await req('GET', `/org/${orgId}/reports/logistics/download/json`);
  let lp = null; try { lp = JSON.parse(lj.text); } catch { /* */ }
  ok(lj.status === 200 && lp?.assembly?.byFF?.length >= 2 && lp?.delivery?.byFF?.length >= 2, 'Ф2: выгрузка логистики (JSON)');
  const lx = await fetch(base + `/org/${orgId}/reports/logistics/download/xlsx`, { headers: { cookie } });
  const lxb = Buffer.from(await lx.arrayBuffer());
  ok(lx.status === 200 && lxb.length > 500 && lxb[0] === 0x50 && lxb[1] === 0x4b, 'Ф2: выгрузка логистики (Excel .xlsx)');
  const lh = await fetch(base + `/org/${orgId}/reports/logistics/download/html`, { headers: { cookie } });
  const lhx = await lh.text();
  ok(lh.status === 200 && lhx.includes('Логистика — сроки сборки, доставки и путь возврата') && lhx.includes('Путь возврата'), 'Ф2: HTML-дашборд логистики (+ путь возврата)');
  await pdfCheck(`/org/${orgId}/reports/logistics/download/pdf`, 'Ф2: PDF-дашборд логистики');
  r = await req('GET', `/org/${orgId}/reports/logistics?tab=delivery`);
  ok(r.status === 200 && r.text.includes('Скорость доставки по ФФ отгрузки') && r.text.includes('исходному ФФ отгрузки'), 'Ф2: логистика — вкладка «Доставка»');
  r = await req('GET', `/org/${orgId}/reports/logistics?tab=return`);
  ok(r.status === 200 && r.text.includes('Полный маршрут возврата') && r.text.includes('Склад возврата WB') && r.text.includes('Воронка'), 'Ф2: логистика — вкладка «Путь возврата» (ФФ→регион→склад WB)');
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('Логистика') && /сборка медиана/.test(r.text), 'Ф2: логистика видна в архиве');

  // ── Отчёт «Отказы по фулфилментам» (провалы сборки + потери) ────────────────
  r = await req('GET', `/org/${orgId}/reports/cancels`);
  ok(r.status === 200 && r.text.includes('Отказы по фулфилментам') && r.text.includes('Параметры'), 'Ф2: страница отказов');
  r = await req('POST', `/org/${orgId}/reports/cancels/refresh`, form({ _csrf: csrfOf(r.text), days: 30 }));
  ok(r.status === 302, 'Ф2: запуск отказов → 302');
  let canDone = false;
  for (let i = 0; i < 30 && !canDone; i++) {
    await sleep(80);
    r = await req('GET', `/org/${orgId}/reports/cancels`);
    if (r.text.includes('Разбор по фулфилментам') && r.text.includes('Казань')) canDone = true;
  }
  ok(canDone, 'Ф2: отказы собрались (разбор по ФФ)');
  ok(r.text.includes('потери по вине ФФ') && r.text.includes('% ФФ'), 'Ф2: отказы — KPI потерь и доля отказов ФФ');
  const cj = await req('GET', `/org/${orgId}/reports/cancels/download/json`);
  let cp = null; try { cp = JSON.parse(cj.text); } catch { /* */ }
  ok(cj.status === 200 && cp?.byFF?.length >= 2 && typeof cp?.totals?.lostRub === 'number', 'Ф2: выгрузка отказов (JSON)');
  const cx = await fetch(base + `/org/${orgId}/reports/cancels/download/xlsx`, { headers: { cookie } });
  const cxb = Buffer.from(await cx.arrayBuffer());
  ok(cx.status === 200 && cxb.length > 500 && cxb[0] === 0x50 && cxb[1] === 0x4b, 'Ф2: выгрузка отказов (Excel .xlsx)');
  const ch = await fetch(base + `/org/${orgId}/reports/cancels/download/html`, { headers: { cookie } });
  const chx = await ch.text();
  ok(ch.status === 200 && chx.includes('Отказы по фулфилментам') && chx.includes('Где теряем деньги'), 'Ф2: HTML-дашборд отказов');
  await pdfCheck(`/org/${orgId}/reports/cancels/download/pdf`, 'Ф2: PDF-дашборд отказов');
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('Отказы по фулфилментам') && /отказ ФФ/.test(r.text), 'Ф2: отказы видны в архиве');

  // HTML-выгрузка из архива (новое: рядом с Excel/JSON).
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(/\/archive\/\d+\/download\/html/.test(r.text), 'Ф2: в списке архива есть ссылка HTML');
  const ah = await req('GET', `/org/${orgId}/reports/archive/${runIds[1]}/download/html`);
  ok(ah.status === 200 && /<html/i.test(ah.text), 'Ф2: архивный запуск скачивается как HTML');

  // Автор удаляет СВОЙ запуск из архива.
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('Удалить'), 'Ф2: автор видит кнопку удаления своего запуска');
  r = await req('POST', `/org/${orgId}/reports/archive/${runIds[0]}/delete`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 302, 'Ф2: автор удалил свой запуск (302)');
  r = await req('GET', `/org/${orgId}/reports/archive/${runIds[0]}`);
  ok(r.status === 404, 'Ф2: удалённый запуск недоступен (404)');

  // Участник компании НЕ может удалить чужой запуск.
  r = await req('GET', `/org/${orgId}`);
  const memberEmail = `rep_member_${Date.now()}@example.com`;
  r = await req('POST', `/org/${orgId}/invite`, form({ _csrf: csrfOf(r.text), email: memberEmail }));
  r = await req('GET', `/org/${orgId}`);
  const inviteTok = (r.text.match(/\/invite\/([A-Za-z0-9_-]{10,})/) || [])[1];
  cookie = '';
  r = await req('GET', `/invite/${inviteTok}`);
  r = await req('GET', '/register');
  r = await req('POST', '/register', form({ _csrf: csrfOf(r.text), email: memberEmail, password: 'supersecret1', name: 'Член' }));
  r = await req('GET', `/invite/${inviteTok}`);
  r = await req('POST', `/invite/${inviteTok}/accept`, form({ _csrf: csrfOf(r.text) }));
  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.status === 200 && !/\/reports\/archive\/\d+\/delete/.test(r.text), 'Ф2: участник не видит кнопку удаления чужих запусков');
  r = await req('POST', `/org/${orgId}/reports/archive/${runIds[1]}/delete`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 403, 'Ф2: участник не может удалить чужой запуск (403)');

  // ── Массовая очистка архива + защита накопительного снимка ──────────────────
  // Симулируем «снимок по расписанию» (userId=null), как это делает scheduler.js.
  const cabId = Cabinets.firstOf(Number(orgId)).id;
  const schedId = ReportRuns.add({
    cabinetId: cabId, report: 'stock', paramsHash: 'sched', params: {}, userId: null,
    summary: { grandTotal: 7, activeWarehouses: 1, articleCount: 1 },
    snapshot: { generatedAt: new Date().toISOString(), totals: { grandTotal: 7 } },
  });

  // Возвращаемся владельцем (email/supersecret1 из начала теста).
  cookie = '';
  r = await req('GET', '/login');
  r = await req('POST', '/login', form({ _csrf: csrfOf(r.text), email, password: 'supersecret1' }));

  r = await req('GET', `/org/${orgId}/reports/archive`);
  ok(r.text.includes('по расписанию'), 'Ф2: накопительный снимок помечен «по расписанию»');
  ok(/Очистить все отчёты/.test(r.text), 'Ф2: владелец видит «Очистить все отчёты»');
  const beforeClear = (r.text.match(/\/archive\/\d+"/g) || []).length;
  ok(beforeClear >= 2, 'Ф2: в архиве есть авторские запуски + снимок по расписанию');

  // Накопительный снимок по расписанию нельзя удалить даже владельцу (поштучно).
  r = await req('POST', `/org/${orgId}/reports/archive/${schedId}/delete`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 403, 'Ф2: снимок по расписанию нельзя удалить поштучно (403)');

  // Массовая очистка владельцем: авторские удаляются, снимок по расписанию сохраняется.
  r = await req('GET', `/org/${orgId}/reports/archive`);
  r = await req('POST', `/org/${orgId}/reports/archive/clear`, form({ _csrf: csrfOf(r.text) }));
  ok(r.status === 302, 'Ф2: массовая очистка владельцем → 302');
  r = await req('GET', `/org/${orgId}/reports/archive`);
  const afterClear = (r.text.match(/\/archive\/\d+"/g) || []).length;
  ok(afterClear < beforeClear && r.text.includes('по расписанию') && !/сборка медиана/.test(r.text),
    'Ф2: очистка убрала авторские запуски, снимок по расписанию остался');
  const sv = await req('GET', `/org/${orgId}/reports/archive/${schedId}`);
  ok(sv.status === 200, 'Ф2: снимок по расписанию открывается после очистки');

  // Доступ: аноним не видит отчёты.
  cookie = '';
  r = await req('GET', `/org/${orgId}/reports/podsort`);
  ok(r.status === 302 && /\/login$/.test(r.location || ''), 'Ф2: без входа отчёты недоступны → /login');
} catch (e) {
  console.error('Ошибка теста:', e); failed++;
} finally {
  server.close();
  for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + suf, { force: true }); } catch { /* */ } }
}
process.stdout.write(failed ? `\n${failed} проверок упало\n` : '\nОтчёты (Ф2): все проверки зелёные\n');
process.exit(failed ? 1 : 0);
