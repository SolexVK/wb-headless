// probe-search.mjs — пробник MPStats (v4). Эндпоинты search/keyword/keywords
// требуют параметр path — проверяем path=<ФРАЗА> (и path=<категория>).
// Плюс сырой дамп by_keywords, чтобы увидеть структуру частотности.
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

async function hit(method, pathAndQuery, body, { raw = false } = {}) {
  const url = `${BASE}${pathAndQuery}`;
  const label = `${method} ${pathAndQuery.replace(encodeURIComponent(KW), '{kw}').replace(encodeURIComponent(CAT), '{cat}').slice(0, 66)}`;
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
      if (raw) { line(`  ✓ ${label} → 200`); line('     RAW:', t.slice(0, 500).replace(/\s+/g, ' ')); return { ok: true, json: j, text: t }; }
      const dataArr = j.data || j.result || j.items || j.keywords || (Array.isArray(j.words) ? j.words : null);
      let shape = `keys=${Object.keys(j).slice(0, 10).join(',')}`;
      if (Array.isArray(dataArr)) shape += ` | arr[${dataArr.length}] itemKeys=${Object.keys(dataArr[0] || {}).slice(0, 12).join(',')}`;
      else if (Array.isArray(j)) shape = `array[${j.length}] itemKeys=${Object.keys(j[0] || {}).slice(0, 12).join(',')}`;
      line(`  ✓ ${label} → 200 | ${shape}`);
      if (Array.isArray(dataArr)) line('     sample:', JSON.stringify(dataArr.slice(0, 3)).slice(0, 360));
      return { ok: true, json: j, text: t };
    }
    const msg = (j && (j.message || j.detail || JSON.stringify(j))) || t.slice(0, 160);
    line(`  ✗ ${label} → ${r.status} | ${String(msg).replace(/\s+/g, ' ').slice(0, 150)}`);
    return { ok: false, status: r.status, json: j, text: t };
  } catch (e) { line(`  ✗ ${label} → ERR ${e.message}`); return { ok: false }; }
}

const kwe = encodeURIComponent(KW);
const cate = encodeURIComponent(CAT);

line('=== 0. nmID ===');
let nmId = null;
{
  const r = await hit('POST', `/wb/get/category?path=${cate}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 3, sortModel: [{ colId: 'revenue', sort: 'desc' }] });
  try { nmId = (r.json.data || r.json)[0]?.id; } catch {}
  line('  nmID:', nmId);
}

line('\n=== 1. path = ФРАЗА (товары/аналитика по запросу) ===');
await hit('GET', `/wb/get/keywords?path=${kwe}&d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keywords?path=${kwe}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });
await hit('GET', `/wb/get/keyword?path=${kwe}&d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keyword?path=${kwe}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });
await hit('GET', `/wb/get/search?path=${kwe}&d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/search?path=${kwe}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20, sortModel: [], filterModel: {} });

line('\n=== 2. path = КАТЕГОРИЯ (ключи категории) ===');
await hit('GET', `/wb/get/keywords?path=${cate}&d1=${D1}&d2=${D2}`);
await hit('POST', `/wb/get/keywords?path=${cate}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20 });

line('\n=== 3. by_keywords — сырой дамп структуры ===');
if (nmId) await hit('GET', `/wb/get/item/${nmId}/by_keywords?d1=${D1}&d2=${D2}`, null, { raw: true });

line('\n=== DONE ===');
