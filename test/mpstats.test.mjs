// Тесты извлечения дневных рядов из графиков категории (bulk-сбор).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateAxis, extractItemDailyFromGraphs } from '../lib/mpstats.js';

test('dateAxis: ось дат [d1..d2] включительно, хронологически', () => {
  const ax = dateAxis('2024-06-01', '2024-06-05');
  assert.deepEqual(ax, ['2024-06-01', '2024-06-02', '2024-06-03', '2024-06-04', '2024-06-05']);
});

test('extractItemDailyFromGraphs: разбирает графики в дневной ряд, цена = выручка/штуки', () => {
  const item = {
    sales_graph: [10, 0, 4],
    stocks_graph: [50, 48, 44],
    price_graph: [1000, 1000, 1100],
    revenue_graph: [12000, 0, 4800], // цена = 1200, —, 1200
  };
  const daily = extractItemDailyFromGraphs(item, '2024-06-01', '2024-06-03');
  assert.equal(daily.length, 3);
  assert.deepEqual(daily[0], { date: '2024-06-01', sales: 10, balance: 50, price: 1200, revenue: 12000 });
  // В день без продаж цена берётся из price_graph (нельзя делить выручку на 0).
  assert.equal(daily[1].price, 1000);
  assert.equal(daily[2].price, 1200);
});

test('extractItemDailyFromGraphs: выравнивает по минимуму при несовпадении длины графика', () => {
  const item = { sales_graph: [1, 2], stocks_graph: [5, 5], price_graph: [100, 100], revenue_graph: [100, 200] };
  const daily = extractItemDailyFromGraphs(item, '2024-06-01', '2024-06-05'); // ось 5, графики 2
  assert.equal(daily.length, 2);
});
