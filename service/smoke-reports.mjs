// service/smoke-reports.mjs — Фаза 2: оболочка отчётов + Подсорт (офлайн).
// PODSORT_FAKE=1 → раннер не ходит в WB, а кладёт канонический снимок.
//   node --experimental-sqlite smoke-reports.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';

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
    if (r.text.includes('Подсорт, шт') && r.text.includes('42')) done = true;
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
  ok(r.status === 200 && r.text.includes('Результат') && r.text.includes('42'), 'Ф2: просмотр архивного запуска');
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
  // Тумблер единицы (₽) и базы оценки: себестоимость / ср.цена продажи / цена заказа.
  r = await req('GET', `/org/${orgId}/reports/movement?focus=delivered&unit=money&basis=cost&cost=620`);
  ok(r.status === 200 && r.text.includes('₽ (Себестоимость)') && r.text.includes('Себест., ₽'), 'Ф2: движение — база «себестоимость» (₽)');
  r = await req('GET', `/org/${orgId}/reports/movement?focus=delivered&unit=money&basis=sale`);
  ok(r.status === 200 && r.text.includes('₽ (Ср. цена 7д)') && r.text.includes('Ср.продажа, ₽'), 'Ф2: движение — база «ср. цена продажи 7д»');
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
