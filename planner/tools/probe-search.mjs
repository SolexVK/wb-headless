// probe-search.mjs — МИНИ-диагностика лимита (v9). Всего 2 запроса, печатает
// полный статус и тело — подтвердить, выжжен ли дневной лимит MPStats.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const CAT = 'Женщинам/Блузки и рубашки/Рубашка';
const ID = 227781398; // заведомо муслиновый (в v6 отдавал данные)
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);
if (!TOKEN) { line('⚠ нет MPSTATS_TOKEN'); process.exit(1); }
const H = { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' };

line('1) by_keywords одного товара:');
{
  const r = await fetch(`${BASE}/wb/get/item/${ID}/by_keywords?d1=${D1}&d2=${D2}`, { headers: H, signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  line(`   → HTTP ${r.status}  len=${t.length}`);
  line('   тело:', t.slice(0, 300).replace(/\s+/g, ' '));
}

line('\n2) category (базовый вызов):');
{
  const r = await fetch(`${BASE}/wb/get/category?path=${encodeURIComponent(CAT)}&d1=${D1}&d2=${D2}`, {
    method: 'POST', headers: H, body: JSON.stringify({ startRow: 0, endRow: 3, sortModel: [{ colId: 'revenue', sort: 'desc' }] }), signal: AbortSignal.timeout(60000),
  });
  const t = await r.text();
  line(`   → HTTP ${r.status}  len=${t.length}`);
  line('   тело:', t.slice(0, 300).replace(/\s+/g, ' '));
}
line('\n=== DONE ===');
