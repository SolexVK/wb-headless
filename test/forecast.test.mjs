// Тесты прогнозного модуля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForecast, dateRange } from '../lib/forecast.js';

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

test('dateRange: включительный диапазон дат', () => {
  assert.equal(dateRange('2026-08-01', '2026-08-31').length, 31);
  assert.equal(dateRange('2026-08-01', '2027-03-31').length, 243);
});

test('buildForecast: проецирует сезон на будущий период, длина = период', () => {
  // 2 года истории с летним пиком (июнь).
  const peak = (y) => new Date(`${y}-06-15T00:00:00Z`).getTime();
  const hist = daily('2024-07-01', '2026-06-30', (d) => {
    const t = new Date(d + 'T00:00:00Z').getTime();
    const y = Number(d.slice(0, 4));
    const near = Math.min(Math.abs(t - peak(y)), Math.abs(t - peak(y - 1)), Math.abs(t - peak(y + 1)));
    const f = Math.exp(-0.5 * (near / (30 * 86400000)) ** 2);
    return { sales: 5 + Math.round(60 * f), balance: 100 - Math.round(60 * f), price: Math.round(1000 * (0.9 + 0.3 * f)) };
  });
  const fc = buildForecast({
    history: hist,
    recent60: daily('2026-05-01', '2026-06-30', () => ({ sales: 40, price: 1100 })),
    prior60: daily('2025-05-01', '2025-06-30', () => ({ sales: 20, price: 1000 })),
    baseDaily: 50,
    forecastFrom: '2026-08-01', forecastTo: '2027-03-31',
    opts: { weekly: false },
  });
  assert.equal(fc.forecastDaily.length, 243);
  // Пик спроса летом → в прогнозе (авг-мар) продажи убывают к зиме и растут к марту.
  const aug = fc.forecastDaily.find((r) => r.date === '2026-08-15');
  const jan = fc.forecastDaily.find((r) => r.date === '2027-01-15');
  assert.ok(aug.plannedOrders > jan.plannedOrders, 'август должен быть выше января');
  // Корректировка объёма клэмпнута (raw=2.0 → в пределах).
  assert.ok(fc.adjustments.volumeAdj <= 2.0 && fc.adjustments.volumeAdj >= 0.5);
  assert.ok(fc.adjustments.priceAdj >= 0.5 && fc.adjustments.priceAdj <= 2.0);
  // Каждая строка прогноза имеет план и цену.
  assert.ok(fc.forecastDaily.every((r) => r.plannedOrders >= 0 && r.price > 0));
});

test('buildForecast: клэмп ограничивает шумный дрейф 60-дневного окна', () => {
  const hist = daily('2024-07-01', '2026-06-30', () => ({ sales: 20, balance: 50, price: 1000 }));
  const fc = buildForecast({
    history: hist,
    recent60: daily('2026-05-01', '2026-06-30', () => ({ sales: 200, price: 1000 })), // ×10
    prior60: daily('2025-05-01', '2025-06-30', () => ({ sales: 20, price: 1000 })),
    baseDaily: 50, forecastFrom: '2026-08-01', forecastTo: '2026-08-31', opts: {},
  });
  assert.equal(fc.adjustments.volumeAdj, 2.0); // клэмп сверху
  assert.equal(fc.adjustments.volumeAdjRaw, 10); // сырое значение сохранено
});
