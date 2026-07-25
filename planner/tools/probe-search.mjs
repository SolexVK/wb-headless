// probe-search.mjs — пробник keyword-возможностей MPStats (v3, диагностический).
// Печатает ПОЛНЫЙ текст ошибок (405/422 → узнаём нужный метод/тело) и структуру
// ответа by_keywords. Публичный поиск WB отпал (429). Ищем: (1) товары по фразе,
// (2) частотность ключей товара, (3) расширение семантики — всё через MPStats.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const PATH = 'Женщинам/Блузки и рубашки/Рубашка';
const KW = 'муслиновая рубашка';
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);
if (!TOKEN) { line('⚠ нет MPSTATS_TOKEN — запусти с --env-file=data/.env'); process.exit(1); }

async function hit(method, pathAndQuery, body, { dump = false } = {}) {
  const url = `${BASE}${pathAndQuery}`;
  const label = `${method} ${pathAndQuery.replace(encodeURIComponent(KW), '{kw}').slice(0, 70)}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (r.ok && j) {
      const dataArr = j.data || j.result || j.items || j.keywords || j.words;
      let shape = `keys=${Object.keys(j).slice(0, 10).join(',')}`;
      if (Array.isArray(dataArr)) shape += ` | arr[${dataArr.length}] itemKeys=${Object.keys(dataArr[0] || {}).slice(0, 12).join(',')}`;
      else if (Array.isArray(j)) shape = `array[${j.length}] itemKeys=${Object.keys(j[0] || {}).slice(0, 12).join(',')}`;
      line(`  ✓ ${label} → 200 | ${shape}`);
      if (dump && Array.isArray(dataArr)) {
        line('     sample:', JSON.stringify(dataArr.slice(0, 4)).slice(0, 400));
      }
    } else {
      const msg = (j && (j.message || j.detail || JSON.stringify(j))) || t.slice(0, 160);
      line(`  ✗ ${label} → ${r.status} | ${String(msg).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    return { ok: r.ok, status: r.status, text: t, json: j };
  } catch (e) { line(`  ✗ ${label} → ERR ${e.message}`); return { ok: false }; }
}

line('=== 0. category → nmID ===');
let nmId = null;
{
  const r = await hit('POST', `/wb/get/category?path=${encodeURIComponent(PATH)}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 5, sortModel: [{ colId: 'revenue', sort: 'desc' }] });
  try { nmId = (r.json.data || r.json)[0]?.id; } catch {}
  line('  nmID:', nmId);
}

const kwe = encodeURIComponent(KW);
line('\n=== 1. ТОВАРЫ ПО ФРАЗЕ (перебор метод/тело) ===');
await hit('POST', `/wb/get/search/${kwe}?d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });
await hit('POST', `/wb/get/search?d1=${D1}&d2=${D2}`, { query: KW, startRow: 0, endRow: 20 });
await hit('POST', `/wb/get/search?d1=${D1}&d2=${D2}`, { word: KW, startRow: 0, endRow: 20 });
await hit('POST', `/wb/get/search?query=${kwe}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20, sortModel: [], filterModel: {} });
await hit('GET', `/wb/get/keywords/${kwe}?d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keyword?d1=${D1}&d2=${D2}`, { word: KW });
await hit('POST', `/wb/get/keyword/${kwe}?d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });

line('\n=== 2. КЛЮЧИ ТОВАРА (частотность) — рабочий, дамп структуры ===');
if (nmId) await hit('GET', `/wb/get/item/${nmId}/by_keywords?d1=${D1}&d2=${D2}`, null, { dump: true });

line('\n=== 3. РАСШИРЕНИЕ СЕМАНТИКИ (перебор метод/тело) ===');
await hit('GET', `/wb/get/keywords/expanding?keyword=${kwe}&d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keywords/expanding?d1=${D1}&d2=${D2}`, { word: KW });
await hit('GET', `/wb/get/keywords/report?keyword=${kwe}&d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keywords/report?d1=${D1}&d2=${D2}`, { words: [KW] });
await hit('POST', `/wb/get/keywords?d1=${D1}&d2=${D2}`, { words: [KW] });
await hit('POST', `/wb/get/keywords?d1=${D1}&d2=${D2}`, { word: KW, startRow: 0, endRow: 20 });

line('\n=== DONE ===');
