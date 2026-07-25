// probe-search.mjs — пробник MPStats (v5). Добиваем два эндпоинта:
//   /wb/get/search   — выдача ТОВАРОВ по фразе (даёт 200, но пустое тело — ищем тело)
//   /wb/get/keywords — ключи КАТЕГОРИИ (нужен path=категория + корректный filterModel)
// Печатаем сырой ответ (длина + первые символы) на каждый вариант.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const CAT = 'Женщинам/Блузки и рубашки/Рубашка';
const KW = 'муслиновая рубашка';
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);
if (!TOKEN) { line('⚠ нет MPSTATS_TOKEN — запусти с --env-file=data/.env'); process.exit(1); }

let N = 0;
async function hit(tag, method, pathAndQuery, body) {
  const url = `${BASE}${pathAndQuery}`;
  const shown = pathAndQuery.replace(encodeURIComponent(KW), '{kw}').replace(encodeURIComponent(CAT), '{cat}');
  try {
    const r = await fetch(url, {
      method,
      headers: { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    line(`\n [${++N}] ${tag}`);
    line(`     ${method} ${shown.slice(0, 78)}`);
    if (body) line(`     body: ${JSON.stringify(body).slice(0, 90)}`);
    line(`     → ${r.status}  len=${t.length}  ${t.slice(0, 260).replace(/\s+/g, ' ')}`);
    return t;
  } catch (e) { line(`\n [${++N}] ${tag} → ERR ${e.message}`); return ''; }
}

const kwe = encodeURIComponent(KW);
const cate = encodeURIComponent(CAT);

line('=== A. /wb/get/search — товары по фразе ===');
await hit('search GET path=kw + rows', 'GET', `/wb/get/search?path=${kwe}&d1=${D1}&d2=${D2}&startRow=0&endRow=20`);
await hit('search POST path=kw sortRevenue', 'POST', `/wb/get/search?path=${kwe}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20, sortModel: [{ colId: 'revenue', sort: 'desc' }], filterModel: {} });
await hit('search POST path=cat word=kw', 'POST', `/wb/get/search?path=${cate}&d1=${D1}&d2=${D2}`, { word: KW, startRow: 0, endRow: 20 });
await hit('search POST path=cat keyword=kw', 'POST', `/wb/get/search?path=${cate}&d1=${D1}&d2=${D2}`, { keyword: KW, startRow: 0, endRow: 20 });
await hit('search GET path=cat keyword=kw', 'GET', `/wb/get/search?path=${cate}&keyword=${kwe}&d1=${D1}&d2=${D2}`);

line('\n=== B. /wb/get/keywords — ключи категории ===');
await hit('keywords POST cat sort=count', 'POST', `/wb/get/keywords?path=${cate}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 30, sortModel: [{ colId: 'count', sort: 'desc' }], filterModel: {} });
await hit('keywords POST cat sort=sum_count', 'POST', `/wb/get/keywords?path=${cate}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 30, sortModel: [{ colId: 'sum_count', sort: 'desc' }], filterModel: {} });
await hit('keywords POST cat no-sort', 'POST', `/wb/get/keywords?path=${cate}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 30, sortModel: [], filterModel: {} });
await hit('keywords GET cat', 'GET', `/wb/get/keywords?path=${cate}&d1=${D1}&d2=${D2}`);

line('\n=== DONE ===');
