// probe-search.mjs — ФИНАЛЬНАЯ выборка «обратной релевантности» (v7).
// Сканируем топ категории глубже, для каждого товара берём by_keywords,
// считаем долю трафика по целевому слову и показываем итоговый список
// аналогов при пороге доли (то, на чём построится план). + counts по порогам, скорость.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const CAT = 'Женщинам/Блузки и рубашки/Рубашка';
const TARGETS = ['муслин', 'марлевк'];   // целевые слова (по подстроке стема)
const SCAN = 1500;             // глубина сканирования топа по выручке
const CONC = 8;                // параллелизм by_keywords
const PRICE_MIN = 1500, PRICE_MAX = 5000;
const SHARE_MIN = 0.20;        // порог доли целевого трафика
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);
if (!TOKEN) { line('⚠ нет MPSTATS_TOKEN — запусти с --env-file=data/.env'); process.exit(1); }

const H = { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' };
const sum = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : 0);
const isTarget = (p) => TARGETS.some((t) => p.includes(t));

async function category(endRow) {
  const r = await fetch(`${BASE}/wb/get/category?path=${encodeURIComponent(CAT)}&d1=${D1}&d2=${D2}`, {
    method: 'POST', headers: H, body: JSON.stringify({ startRow: 0, endRow, sortModel: [{ colId: 'revenue', sort: 'desc' }] }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  return (j.data || j || []).map((x) => ({ id: x.id, name: x.name, brand: x.brand, revenue: Number(x.revenue) || 0, price: Number(x.final_price) || 0 }));
}

async function byKeywords(id) {
  try {
    const r = await fetch(`${BASE}/wb/get/item/${id}/by_keywords?d1=${D1}&d2=${D2}`, { headers: H, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return null;
    const j = await r.json();
    const words = j.words || {};
    let total = 0, tgt = 0;
    for (const [phrase, v] of Object.entries(words)) {
      const tr = sum(v.traffic_volume); total += tr;
      if (isTarget(phrase.toLowerCase())) tgt += tr;
    }
    return { total, tgt, share: total > 0 ? tgt / total : 0 };
  } catch { return null; }
}

line(`Цель: [${TARGETS.join(', ')}] | топ-${SCAN} категории | сегмент ${PRICE_MIN}–${PRICE_MAX}₽ | порог доли ${SHARE_MIN * 100}% | ${D1}…${D2}\n`);
let t0 = Date.now();
let items = await category(SCAN);
line(`Категория: ${items.length} товаров за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
const seg = items.filter((it) => it.price >= PRICE_MIN && it.price <= PRICE_MAX);
line(`В сегменте по цене: ${seg.length}\n`);

let ok = 0, failed = 0;
const scored = [];
t0 = Date.now();
for (let i = 0; i < seg.length; i += CONC) {
  const batch = seg.slice(i, i + CONC);
  const res = await Promise.all(batch.map((it) => byKeywords(it.id).then((k) => ({ it, k }))));
  for (const { it, k } of res) {
    if (!k) { failed++; continue; }
    ok++; scored.push({ ...it, share: k.share, tgt: k.tgt });
  }
  process.stdout.write(`\r  by_keywords: ${ok + failed}/${seg.length} (ok ${ok}, fail ${failed})`);
}
const dt = (Date.now() - t0) / 1000;
line(`\n\nby_keywords: ${ok} ok, ${failed} без данных, ${dt.toFixed(1)}с (${(dt / Math.max(1, ok)).toFixed(2)}с/товар)\n`);

for (const th of [0.1, 0.15, 0.2, 0.3, 0.4]) line(`  порог ${(th * 100).toFixed(0)}% → аналогов: ${scored.filter((s) => s.share >= th).length}`);

const final = scored.filter((s) => s.share >= SHARE_MIN).sort((a, b) => b.revenue - a.revenue);
line(`\n=== ИТОГОВАЯ ВЫБОРКА при пороге ${SHARE_MIN * 100}% (${final.length}) — по выручке ===`);
for (const s of final.slice(0, 40)) {
  line(`  ${s.id}  доля ${(s.share * 100).toFixed(0).padStart(3)}%  ${String(Math.round(s.revenue)).padStart(9)}₽  ${s.price}₽  ${(s.name || '').slice(0, 52)}`);
}
line('\n=== DONE ===');
