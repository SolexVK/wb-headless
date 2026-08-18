// service/smoke-wbfetch.mjs — юнит-тест общих выборок WB (scripts/lib/wbFetch.mjs).
// Офлайн, wb мокается. Проверяет чанкинг+дедуп заказов, страховку от вечного цикла,
// дедуп продаж по srid+saleID и добор поставок.
//   node smoke-wbfetch.mjs
import { fetchOrders, fetchSupplies, fetchSales } from '../scripts/lib/wbFetch.mjs';

let failed = 0;
const ok = (cond, msg) => { process.stdout.write(`${cond ? '✓' : '✗ FAIL'}  ${msg}\n`); if (!cond) failed++; };
const D = 86400;

try {
  // 1) Заказы: чанкинг окна + дедуп по rid через границы чанков.
  //    mock отдаёт «DUP» (повторяется в каждом чанке) + уникальный по началу чанка.
  const wbOrders = { get: async (cat, path, { query }) => {
    if (path === '/api/v3/orders') return { data: { orders: [{ rid: 'DUP', id: 'DUP' }, { rid: 'C' + query.dateFrom, id: 'C' + query.dateFrom }] } }; // next отсутствует → 1 страница на чанк
    throw new Error('unexpected ' + path);
  } };
  const o1 = await fetchOrders(wbOrders, { fromSec: 0, toSec: 60 * D, chunkDays: 28, dedupBy: 'rid' });
  ok(o1.filter((o) => o.rid === 'DUP').length === 1, 'заказы: дубль rid через чанки схлопнут (1 DUP)');
  ok(o1.length === 4, 'заказы: 3 чанка × уник + 1 DUP = 4 строки (чанкинг работает)');

  // 2) Дедуп по id (movement): один и тот же id в двух чанках — один раз.
  const wbById = { get: async (cat, path, { query }) => ({ data: { orders: [{ id: 7, rid: 'r' + query.dateFrom }, { id: 'x' + query.dateFrom, rid: 'y' }] } }) };
  const o2 = await fetchOrders(wbById, { fromSec: 0, toSec: 60 * D, chunkDays: 28, dedupBy: 'id' });
  ok(o2.filter((o) => o.id === 7).length === 1, 'заказы: дубль id через чанки схлопнут');

  // 3) Страховка от вечного цикла: страница ровно 1000, а next не меняется → выходим, не виснем.
  let calls = 0;
  const wbStuck = { get: async () => { calls++; return { data: { orders: Array.from({ length: 1000 }, (_, i) => ({ rid: 'p' + calls + '_' + i })), next: 0 } }; } };
  const o3 = await fetchOrders(wbStuck, { fromSec: 0, toSec: 10 * D, chunkDays: 28, dedupBy: 'rid' });
  ok(calls === 1 && o3.length === 1000, 'заказы: 1000 строк с неизменным next → один запрос, без зацикливания');

  // 4) Нормальная пагинация по next (2 страницы, затем <1000).
  const pages = [
    { orders: Array.from({ length: 1000 }, (_, i) => ({ rid: 'a' + i })), next: 5 },
    { orders: [{ rid: 'b1' }, { rid: 'b2' }], next: 9 },
  ];
  let pi = 0;
  const wbPaged = { get: async (cat, path, { query }) => ({ data: pages[query.next === 0 ? 0 : 1] || { orders: [] } }) };
  const o4 = await fetchOrders(wbPaged, { fromSec: 0, toSec: 5 * D, chunkDays: 28, dedupBy: 'rid' });
  ok(o4.length === 1002, 'заказы: пагинация по next собирает обе страницы (1000+2)');

  // 5) Продажи: дедуп по srid+saleID — продажа и возврат с одним srid сохраняются оба.
  const salePages = {
    'd0': [{ srid: 'e1', saleID: 'S1', lastChangeDate: 'd1' }, { srid: 'e1', saleID: 'R2', lastChangeDate: 'd2' }],
    'd2': [{ srid: 'e1', saleID: 'S1', lastChangeDate: 'd1' }, { srid: 'e3', saleID: 'S3', lastChangeDate: 'd3' }], // дубль S1 + новая
  };
  const wbSales = { get: async (cat, path, { query }) => ({ data: salePages[query.dateFrom] || [] }) };
  const s = await fetchSales(wbSales, { dateFrom: 'd0', pageThreshold: 2 });
  const isRet = (x) => String(x.saleID || '').startsWith('R');
  ok(s.length === 3, 'продажи: S1,R2,S3 (дубль S1 схлопнут, возврат сохранён)');
  ok(s.filter(isRet).length === 1, 'продажи: возврат R2 не потерян');

  // 6) Поставки: список + точечный добор недостающих, ошибка добора проглатывается.
  const wbSup = { get: async (cat, path) => {
    if (path === '/api/v3/supplies') return { data: { supplies: [{ id: 1 }, { id: 2 }] } };
    if (path === '/api/v3/supplies/3') return { data: { id: 3 } };
    throw new Error('supply 4 недоступна');
  } };
  const sup = await fetchSupplies(wbSup, { neededIds: [1, 2, 3, 4] });
  ok(sup.has(1) && sup.has(2) && sup.has(3) && !sup.has(4), 'поставки: список + добор 3, ошибка по 4 проглочена');
} catch (e) {
  console.error('Ошибка теста:', e); failed++;
}

process.stdout.write(failed ? `\n${failed} проверок упало\n` : '\nWB-выборки (wbFetch): все проверки зелёные\n');
process.exit(failed ? 1 : 0);
