// Тест минимального xlsx-писателя: валидный ZIP + нужные части + данные.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xlsxBuffer } from '../lib/xlsxWriter.js';

test('xlsxBuffer: валидный ZIP с нужными частями и данными', () => {
  const buf = xlsxBuffer(
    {
      name: 'Лист',
      columns: [{ header: 'Дата', width: 14 }, { header: 'Продажи', width: 12 }],
      rows: [
        { fill: '#FF0000', cells: ['2024-06-01', 42] },
        { cells: ['2024-06-02', 7] },
      ],
    },
    ['#FF0000']
  );
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 2).toString(), 'PK'); // сигнатура ZIP
  const s = buf.toString('latin1');
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) {
    assert.ok(s.includes(part), `нет части ${part}`);
  }
  assert.ok(s.includes('<v>42</v>'), 'нет числового значения');
  assert.ok(s.includes('2024-06-01'), 'нет строкового значения');
  // EOCD-сигнатура в конце.
  assert.equal(buf.slice(-22, -18).readUInt32LE(0), 0x06054b50);
});
