// probe-search.mjs — разовый пробник keyword-возможностей MPStats для нового
// «поискового» подхода к сбору аналогов (публичный поиск WB отпал: режет по 429).
// Задача: выяснить, какими эндпоинтами MPStats можно (а) искать товары по фразе,
// (б) брать частотность ключей товара, (в) расширять семантику.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs
// Токен нигде не печатается.

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const PATH = 'Женщинам/Блузки и рубашки/Рубашка';
const KW = 'муслиновая рубашка';
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);

if (!TOKEN) { line('⚠ MPSTATS_TOKEN не найден — запусти с  --env-file=data/.env'); process.exit(1); }

async function hit(method, pathAndQuery, body) {
  const url = `${BASE}${pathAndQuery}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    let shape = '';
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) shape = `array[${j.length}] keys=${Object.keys(j[0] || {}).slice(0, 8).join(',')}`;
      else if (j && typeof j === 'object') {
        const dataArr = j.data || j.result || j.items || j.keywords;
        shape = `obj keys=${Object.keys(j).slice(0, 8).join(',')}`;
        if (Array.isArray(dataArr)) shape += ` | data[${dataArr.length}] itemKeys=${Object.keys(dataArr[0] || {}).slice(0, 10).join(',')}`;
      }
    } catch { shape = t.slice(0, 90).replace(/\s+/g, ' '); }
    line(`  ${method} ${pathAndQuery.split('?')[0]} → ${r.status} | ${shape}`);
    return { ok: r.ok, status: r.status, text: t };
  } catch (e) { line(`  ${method} ${pathAndQuery.split('?')[0]} → ERR ${e.message}`); return { ok: false }; }
}

// ── 0. nmID из категории (заведомо рабочий вызов) ──
line('=== 0. category → nmID ===');
let nmId = null;
{
  const qs = `path=${encodeURIComponent(PATH)}&d1=${D1}&d2=${D2}`;
  const r = await hit('POST', `/wb/get/category?${qs}`, { startRow: 0, endRow: 5, sortModel: [{ colId: 'revenue', sort: 'desc' }] });
  try { const j = JSON.parse(r.text); nmId = (j.data || j)[0]?.id; } catch {}
  line('  nmID для проверок:', nmId);
}

// ── 1. Товары по фразе (выдача по запросу) — кандидаты ──
line('\n=== 1. ТОВАРЫ ПО ФРАЗЕ ===');
const kwEnc = encodeURIComponent(KW);
await hit('GET', `/wb/get/search/${kwEnc}?d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/search?query=${kwEnc}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });
await hit('GET', `/wb/get/keywords/${kwEnc}?d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keyword?d1=${D1}&d2=${D2}`, { keyword: KW, startRow: 0, endRow: 20 });
await hit('POST', `/wb/get/in_category?path=${encodeURIComponent(PATH)}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 5 });

// ── 2. Частотность ключей товара ──
line('\n=== 2. КЛЮЧИ ТОВАРА (частотность) ===');
if (nmId) {
  await hit('GET', `/wb/get/item/${nmId}/by_keywords?d1=${D1}&d2=${D2}`);
  await hit('GET', `/wb/get/item/${nmId}/keywords?d1=${D1}&d2=${D2}`);
  await hit('POST', `/wb/get/item/${nmId}/by_keywords?d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });
}

// ── 3. Расширение семантики (по сид-фразе) ──
line('\n=== 3. РАСШИРЕНИЕ СЕМАНТИКИ ===');
await hit('POST', `/wb/get/keywords/expanding?d1=${D1}&d2=${D2}`, { keyword: KW });
await hit('POST', `/wb/get/keywords/report?d1=${D1}&d2=${D2}`, { keywords: [KW, 'рубашка муслин'] });
await hit('POST', `/wb/get/keywords?d1=${D1}&d2=${D2}`, { keyword: KW });

line('\n=== DONE ===');
