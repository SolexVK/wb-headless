// Тесты ядра плана сезона (node:test, без внешних зависимостей).
//   node --test   (или npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroupDailySeries,
  trimToActive,
  computeCoefficients,
  computeRank,
  detectPhases,
  buildSeasonPlan,
} from '../lib/salesPlan.js';

// Генератор дневного ряда по функции продаж/цены от даты.
function daily(d1, d2, fn) {
  const out = [];
  let t = new Date(d1 + 'T00:00:00Z').getTime();
  const end = new Date(d2 + 'T00:00:00Z').getTime();
  for (let i = 0; t <= end; i++, t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const { sales = 0, balance = 40, price = 1000 } = fn(date, i) || {};
    out.push({ date, sales, balance, price, revenue: sales * price });
  }
  return out;
}

test('buildGroupDailySeries: суммирует продажи/остатки, цена взвешена по продажам', () => {
  const a = [{ date: '2024-01-01', sales: 10, balance: 5, price: 100, revenue: 1000 }];
  const b = [{ date: '2024-01-01', sales: 30, balance: 7, price: 200, revenue: 6000 }];
  const [row] = buildGroupDailySeries([a, b]);
  assert.equal(row.sales, 40);
  assert.equal(row.stock, 12);
  assert.equal(row.skusInStock, 2);
  // средневзвешенная цена = (100*10 + 200*30) / 40 = 175
  assert.equal(row.price, 175);
});

test('trimToActive: обрезает ведущие и хвостовые дни без продаж', () => {
  const series = [
    { date: '2024-01-01', sales: 0 }, { date: '2024-01-02', sales: 0 },
    { date: '2024-01-03', sales: 5 }, { date: '2024-01-04', sales: 3 },
    { date: '2024-01-05', sales: 0 },
  ];
  const t = trimToActive(series);
  assert.equal(t.length, 2);
  assert.equal(t[0].date, '2024-01-03');
  assert.equal(t.at(-1).date, '2024-01-04');
});

test('computeRank: ярко выраженный при высоком p90/p50, слабый при ровном спросе', () => {
  // Ровный спрос → слабый.
  const flat = computeCoefficients(daily('2024-01-01', '2024-12-31', () => ({ sales: 20 })));
  assert.equal(computeRank(flat.kSales).code, 'weak');

  // Резкий сезон (гаусс-пик) → ярко выраженный, амплитуда = p90/p50.
  const peak = new Date('2024-07-01T00:00:00Z').getTime();
  const strong = computeCoefficients(
    daily('2024-01-01', '2024-12-31', (d) => {
      const x = (new Date(d + 'T00:00:00Z').getTime() - peak) / (25 * 86400000);
      return { sales: 5 + Math.round(80 * Math.exp(-0.5 * x * x)) };
    })
  );
  const r = computeRank(strong.kSales);
  assert.equal(r.code, 'strong');
  assert.ok(r.amplitude >= 2, `амплитуда ${r.amplitude} должна быть ≥2`);
});

test('detectPhases: пик по МЕСЯЧНОМУ объёму, а не по разовому дневному всплеску', () => {
  // Февраль — высокий объём (зимний товар). В мае один аномальный день-всплеск,
  // но месячный объём мая низкий. Пик обязан быть февралём, не маем.
  const series = daily('2024-01-01', '2024-12-31', (d) => {
    const m = d.slice(5, 7);
    if (m === '01') return { sales: 25 };
    if (m === '02') return { sales: 40 }; // пик-месяц по объёму
    if (m === '03') return { sales: 22 };
    if (d === '2024-05-14') return { sales: 300 }; // разовый всплеск
    return { sales: 4 };
  });
  const ph = detectPhases(series);
  assert.equal(ph.peak.month, 2, `ожидали пик в феврале, получили месяц ${ph.peak.month}`);
});

test('buildSeasonPlan: короткий ряд помечается lowConfidence, фазы упорядочены', () => {
  const peak = new Date('2024-06-15T00:00:00Z').getTime();
  const series = daily('2024-03-01', '2024-08-31', (d) => {
    const x = (new Date(d + 'T00:00:00Z').getTime() - peak) / (20 * 86400000);
    const f = Math.exp(-0.5 * x * x);
    return { sales: 5 + Math.round(50 * f), price: Math.round(1000 * (0.9 + 0.3 * f)) };
  });
  const plan = buildSeasonPlan(series);
  assert.equal(plan.dataSufficiency.lowConfidence, true); // < ~10 мес
  assert.ok(plan.phases.peak.month === 6);
  assert.ok(plan.pricing.peak >= plan.pricing.sale); // цена пика не ниже распродажи
  assert.ok(plan.daily.length > 0 && plan.daily[0].plannedOrders != null);
});
