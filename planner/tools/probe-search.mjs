// probe-search.mjs — диагностика надёжности by_keywords (v8).
// Прошлый прогон дал 52% «без данных» на глубине — надо понять: это лимит MPStats
// (лечится ретраями/паузами/кэшем) или реально пустые ключи. Считаем ПРИЧИНЫ фейлов,
// ретраим 429/5xx с бэкоффом, ниже параллелизм, проверяем заведомо-муслиновые id.
// Запуск на Mac mini из planner/:  node --env-file=data/.env tools/probe-search.mjs

const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;
const CAT = 'Женщинам/Блузки и рубашки/Рубашка';
const TARGETS = ['муслин', 'марлевк'];
const SCAN = 1500, CONC = 4;
const PRICE_MIN = 1500, PRICE_MAX = 5000, SHARE_MIN = 0.20;
const KNOWN = [227781398, 844468291, 317965489, 219401072]; // муслин из прошлого прогона
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const D1 = ymd(d1), D2 = ymd(d2);
const line = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!TOKEN) { line('⚠ нет MPSTATS_TOKEN'); process.exit(1); }

const H = { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' };
const sum = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : 0);
const isTarget = (p) => TARGETS.some((t) => p.includes(t));
const reasons = {};
const tally = (r) => { reasons[r] = (reasons[r] || 0) + 1; };

async function category(endRow) {
  const r = await fetch(`${BASE}/wb/get/category?path=${encodeURIComponent(CAT)}&d1=${D1}&d2=${D2}`, {
    method: 'POST', headers: H, body: JSON.stringify({ startRow: 0, endRow, sortModel: [{ colId: 'revenue', sort: 'desc' }] }), signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  return (j.data || j || []).map((x) => ({ id: x.id, name: x.name, revenue: Number(x.revenue) || 0, price: Number(x.final_price) || 0 }));
}

async function byKeywords(id, retries = 2) {
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await fetch(`${BASE}/wb/get/item/${id}/by_keywords?d1=${D1}&d2=${D2}`, { headers: H, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 || r.status >= 500) { if (a < retries) { await sleep(1500 * (a + 1)); continue; } tally('http' + r.status); return null; }
      if (!r.ok) { tally('http' + r.status); return null; }
      const j = await r.json();
      const words = j.words || {};
      const n = Object.keys(words).length;
      if (!n) { tally('empty'); return null; }
      let total = 0, tgt = 0;
      for (const [phrase, v] of Object.entries(words)) { const tr = sum(v.traffic_volume); total += tr; if (isTarget(phrase.toLowerCase())) tgt += tr; }
      tally('ok');
      return { total, tgt, share: total > 0 ? tgt / total : 0 };
    } catch (e) { if (a < retries) { await sleep(1500 * (a + 1)); continue; } tally(e.name === 'TimeoutError' ? 'timeout' : 'err'); return null; }
  }
  return null;
}

line(`Цель: [${TARGETS.join(', ')}] | топ-${SCAN}, сегмент ${PRICE_MIN}–${PRICE_MAX}₽, порог ${SHARE_MIN * 100}%, conc ${CONC}, ретраи 2 | ${D1}…${D2}\n`);

line('Проверка заведомо-муслиновых id:');
for (const id of KNOWN) { const k = await byKeywords(id); line(`  ${id} → ${k ? `доля ${(k.share * 100).toFixed(0)}% (tgt ${k.tgt})` : 'НЕТ ДАННЫХ'}`); }
line('');

let t0 = Date.now();
const items = await category(SCAN);
const seg = items.filter((it) => it.price >= PRICE_MIN && it.price <= PRICE_MAX);
line(`Категория ${items.length} за ${((Date.now() - t0) / 1000).toFixed(1)}с | в сегменте ${seg.length}\n`);

const scored = [];
t0 = Date.now();
let done = 0;
for (let i = 0; i < seg.length; i += CONC) {
  const batch = seg.slice(i, i + CONC);
  const res = await Promise.all(batch.map((it) => byKeywords(it.id).then((k) => ({ it, k }))));
  for (const { it, k } of res) if (k) scored.push({ ...it, share: k.share });
  done += batch.length;
  process.stdout.write(`\r  by_keywords: ${done}/${seg.length}`);
}
const dt = (Date.now() - t0) / 1000;
line(`\n\nПричины ответов: ${JSON.stringify(reasons)}`);
line(`Успешно с ключами: ${scored.length}/${seg.length} | ${dt.toFixed(1)}с (${(dt / seg.length).toFixed(2)}с/товар)\n`);

for (const th of [0.1, 0.15, 0.2, 0.3]) line(`  порог ${(th * 100).toFixed(0)}% → ${scored.filter((s) => s.share >= th).length}`);
const final = scored.filter((s) => s.share >= SHARE_MIN).sort((a, b) => b.revenue - a.revenue);
line(`\n=== ВЫБОРКА при ${SHARE_MIN * 100}% (${final.length}) ===`);
for (const s of final.slice(0, 40)) line(`  ${s.id}  доля ${(s.share * 100).toFixed(0).padStart(3)}%  ${String(Math.round(s.revenue)).padStart(9)}₽  ${(s.name || '').slice(0, 52)}`);
line('\n=== DONE ===');
