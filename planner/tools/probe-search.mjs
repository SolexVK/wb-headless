// probe-search.mjs — ДОКАЗАТЕЛЬСТВО подхода «обратная релевантность» (v6).
// Берём топ категории, для каждого товара тянем by_keywords (реальные поисковые
// фразы с трафиком) и проверяем, ранжируется ли он по целевому слову «муслин».
// Показываем совпавшие/не совпавшие + скорость. Всё на подтверждённых эндпоинтах.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const CAT = 'Женщинам/Блузки и рубашки/Рубашка';
const TARGET = 'муслин';       // целевое слово (по стему)
const SCAN = 120;              // сколько товаров из топа проверить
const CONC = 6;                // параллелизм by_keywords
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);
if (!TOKEN) { line('⚠ нет MPSTATS_TOKEN — запусти с --env-file=data/.env'); process.exit(1); }

const H = { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' };
const sum = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : 0);

async function category(endRow) {
  const r = await fetch(`${BASE}/wb/get/category?path=${encodeURIComponent(CAT)}&d1=${D1}&d2=${D2}`, {
    method: 'POST', headers: H, body: JSON.stringify({ startRow: 0, endRow, sortModel: [{ colId: 'revenue', sort: 'desc' }] }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  return (j.data || j || []).map((x) => ({ id: x.id, name: x.name, brand: x.brand, revenue: x.revenue }));
}

async function byKeywords(id) {
  try {
    const r = await fetch(`${BASE}/wb/get/item/${id}/by_keywords?d1=${D1}&d2=${D2}`, { headers: H, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    const j = await r.json();
    const words = j.words || {};
    const phrases = Object.entries(words).map(([phrase, v]) => ({ phrase, traffic: sum(v.traffic_volume) }))
      .filter((p) => p.traffic > 0).sort((a, b) => b.traffic - a.traffic);
    return phrases;
  } catch { return null; }
}

line(`Целевое слово: "${TARGET}" | сканируем топ-${SCAN} категории | период ${D1}…${D2}\n`);
const t0 = Date.now();
const items = await category(SCAN);
line(`Категория: получено ${items.length} товаров за ${((Date.now() - t0) / 1000).toFixed(1)}с\n`);

let ok = 0, matched = 0, failed = 0;
const hits = [], misses = [];
const t1 = Date.now();
for (let i = 0; i < items.length; i += CONC) {
  const batch = items.slice(i, i + CONC);
  const res = await Promise.all(batch.map((it) => byKeywords(it.id).then((ph) => ({ it, ph }))));
  for (const { it, ph } of res) {
    if (!ph) { failed++; continue; }
    ok++;
    const total = ph.reduce((s, p) => s + p.traffic, 0) || 1;
    const mus = ph.filter((p) => p.phrase.toLowerCase().includes(TARGET));
    const musTraffic = mus.reduce((s, p) => s + p.traffic, 0);
    const share = musTraffic / total;
    if (mus.length) { matched++; hits.push({ it, top: ph[0], mus: mus[0], share }); }
    else if (misses.length < 8) misses.push({ it, top: ph[0] });
  }
  process.stdout.write(`\r  by_keywords: ${ok + failed}/${items.length} (ok ${ok}, matched ${matched}, fail ${failed})`);
}
const dt = (Date.now() - t1) / 1000;
line(`\n\nby_keywords: ${ok} ok, ${failed} без данных, ${dt.toFixed(1)}с (${(dt / Math.max(1, ok)).toFixed(2)}с/товар)\n`);

line(`=== СОВПАЛИ по "${TARGET}" (${matched}) ===`);
for (const h of hits.slice(0, 25)) {
  line(`  ${h.it.id}  муслин-доля ${(h.share * 100).toFixed(0)}%  «${h.mus.phrase}» (${h.mus.traffic})`);
  line(`         ${(h.it.name || '').slice(0, 60)}  [топ-фраза: «${h.top.phrase}»]`);
}
line(`\n=== НЕ совпали (примеры) — топ-фраза товара ===`);
for (const m of misses) line(`  ${m.it.id}  «${m.top.phrase}» — ${(m.it.name || '').slice(0, 50)}`);
line('\n=== DONE ===');
