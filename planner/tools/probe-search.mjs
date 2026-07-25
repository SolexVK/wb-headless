// probe-search.mjs — разовый пробник для нового «поискового» подхода к сбору аналогов.
// Проверяет: (1) отдаёт ли публичный поиск WB нишу (муслиновые рубашки) с этой машины,
// (2) каким эндпоинтом MPStats берём дневные продажи по nmID,
// (3) доступна ли частотность ключей товара (для расширения через конкурентов).
// Запуск на Mac mini из каталога planner/:  node --env-file=data/.env tools/probe-search.mjs
// Токен нигде не печатается.

const TOKEN = process.env.MPSTATS_TOKEN;
const MP = 'https://mpstats.io/api';
const H = { 'X-Mpstats-TOKEN': TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' };
const ymd = (d) => d.toISOString().slice(0, 10);
const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
const line = (...a) => console.log(...a);

if (!TOKEN) { line('⚠ MPSTATS_TOKEN не найден (нужен запуск с --env-file=data/.env). WB-поиск проверю всё равно.'); }

// ── 1. Публичный поиск WB (источник релевантности ниши) ──
async function wbSearch(q) {
  const enc = encodeURIComponent(q);
  const urls = [
    `https://search.wb.ru/exactmatch/ru/common/v9/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&query=${enc}&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false`,
    `https://search.wb.ru/exactmatch/ru/common/v4/search?appType=1&curr=rub&dest=-1257786&query=${enc}&resultset=catalog&sort=popular&spp=0`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Accept: '*/*', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { line(`  WB HTTP ${r.status} (${u.includes('v9') ? 'v9' : 'v4'})`); continue; }
      const j = await r.json();
      const p = j?.data?.products || [];
      if (p.length) return { products: p, ver: u.includes('v9') ? 'v9' : 'v4' };
    } catch (e) { line('  WB ERR', e.message); }
  }
  return { products: [], ver: null };
}

line('=== 1. WB SEARCH ===');
let firstId = null;
for (const q of ['муслиновая рубашка женская', 'рубашка муслин оверсайз', 'рубашка из муслина']) {
  const { products, ver } = await wbSearch(q);
  line(`\n"${q}" → ${products.length} товаров${ver ? ` (${ver})` : ''}`);
  for (const x of products.slice(0, 8)) line(`   ${x.id}  ${(x.brand || '').slice(0, 16).padEnd(16)} ${(x.name || '').slice(0, 46)}`);
  if (!firstId && products.length) firstId = products[0].id;
}

// ── 2. MPStats: дневные продажи по nmID ──
line('\n=== 2. MPStats item sales ===');
if (firstId && TOKEN) {
  for (const path of [`/wb/get/item/${firstId}/sales`]) {
    try {
      const r = await fetch(`${MP}${path}?d1=${ymd(d1)}&d2=${ymd(d2)}`, { headers: H, signal: AbortSignal.timeout(25000) });
      const t = await r.text();
      line(`GET ${path} → ${r.status} | ${t.slice(0, 160).replace(/\s+/g, ' ')}`);
    } catch (e) { line(path, 'ERR', e.message); }
  }
} else line('  пропуск (нет nmID или токена)');

// ── 3. MPStats: ключи товара по частотности ──
line('\n=== 3. MPStats item keywords (частотность) ===');
if (firstId && TOKEN) {
  for (const path of [`/wb/get/item/${firstId}/by_keywords`, `/wb/get/item/${firstId}/keywords`]) {
    try {
      const r = await fetch(`${MP}${path}?d1=${ymd(d1)}&d2=${ymd(d2)}`, { headers: H, signal: AbortSignal.timeout(25000) });
      const t = await r.text();
      line(`GET ${path} → ${r.status} | ${t.slice(0, 180).replace(/\s+/g, ' ')}`);
    } catch (e) { line(path, 'ERR', e.message); }
  }
} else line('  пропуск (нет nmID или токена)');

line('\n=== DONE ===');
