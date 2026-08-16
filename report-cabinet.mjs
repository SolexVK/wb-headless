// report-cabinet.mjs — сводка по кабинету WB на текущий момент.
//
// Собирает в один отчёт:
//   1) Потери на сгоревших складах (FBO): остатки на каждом атакованном складе × 620 ₽.
//   2) Остатки FBO на оставшихся (не сгоревших) складах WB — по складам и итого.
//   3) «В пути до получателей» и «В пути возвраты на склад WB».
//   4) Остатки FBS (свои склады продавца) — по складам и итого.
//
// Источники: warehouse_remains (FBO, seller-analytics), marketplace /api/v3
// (FBS-склады и остатки), content /content/v2 (баркоды для запроса FBS-остатков).
//
// ⚠️ warehouse_remains — снимок «на сейчас». После пожара WB со временем обнуляет
//    сгоревший товар, поэтому «потери» по текущим остаткам могут занижаться.
//    Раннер печатает, какие сгоревшие склады ещё видны, а какие уже обнулены/исчезли.
//
// Запуск:  WB_API_TOKEN=xxx node report-cabinet.mjs  [--cost 620]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WbClient } from './lib/wbClient.js';
import { resolveWbToken, resolveTokenType, maskToken } from './lib/wbToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
const rub = (n) => num(n) + ' ₽';

const SPECIAL = ['всего находится на складах', 'в пути до получателей', 'в пути возвраты на склад wb'];
const isSpecial = (name) => SPECIAL.includes(String(name || '').toLowerCase().trim());

function loadCfg() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'fire-warehouses.json'), 'utf8'));
}
// Последний снимок report:fire — чтобы восстановить остатки по складам, которые
// WB уже обнулил после пожара (пик остатков = оценка утраченного количества).
function latestFireLosses(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^fire-losses-.*\.json$/.test(f))
      .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? JSON.parse(fs.readFileSync(files[0], 'utf8')) : null;
  } catch (_) { return null; }
}
function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) if (argv[i] === '--cost') o.cost = Number(argv[++i]);
  return o;
}
const matchBurned = (name, pats) => {
  const n = String(name).toLowerCase();
  return pats.some((p) => n.includes(String(p).toLowerCase()));
};

// ── FBO: отчёт об остатках на складах WB ────────────────────────────────────
async function fetchFbo(wb) {
  const create = await wb.get('analytics', '/api/v1/warehouse_remains', {
    query: { locale: 'ru', groupByNm: true, groupBySa: true, groupByBrand: true, groupBySubject: true },
    methodLimit: { limit: 1, periodSec: 60, burst: 5 },
  });
  const taskId = create.data?.data?.taskId;
  if (!taskId) throw new Error('нет taskId (warehouse_remains)');
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('таймаут warehouse_remains');
    await sleep(6000);
    const st = await wb.get('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/status`,
      { methodLimit: { limit: 1, periodSec: 5, burst: 5 } });
    const s = st.data?.data?.status;
    log('  FBO статус:', s);
    if (s === 'done') break;
    if (['canceled', 'purged', 'error'].includes(s)) throw new Error('warehouse_remains: ' + s);
  }
  const dl = await wb.get('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/download`,
    { methodLimit: { limit: 1, periodSec: 5, burst: 5 } });
  if (!Array.isArray(dl.data)) throw new Error('warehouse_remains: не массив');
  return dl.data;
}

// ── FBS: свои склады + остатки по баркодам ──────────────────────────────────
async function fetchAllSkus(wb) {
  const skus = [];
  let cursor = { limit: 100 };
  for (let guard = 0; guard < 100; guard++) {
    const resp = await wb.request('content', '/content/v2/get/cards/list', {
      method: 'POST',
      body: { settings: { cursor, filter: { withPhoto: -1 } } },
      methodLimit: { limit: 1, periodSec: 2, burst: 3 },
    });
    const cards = resp.data?.cards || [];
    for (const c of cards) for (const s of (c.sizes || [])) for (const bc of (s.skus || [])) skus.push(bc);
    const rc = resp.data?.cursor || {};
    if (cards.length < (cursor.limit || 100)) break;
    cursor = { limit: 100, updatedAt: rc.updatedAt, nmID: rc.nmID };
  }
  return [...new Set(skus)];
}

async function fetchFbs(wb) {
  const wh = await wb.get('marketplace', '/api/v3/warehouses', { methodLimit: { limit: 1, periodSec: 3, burst: 3 } });
  const warehouses = Array.isArray(wh.data) ? wh.data : [];
  if (!warehouses.length) return { warehouses: [], perWh: [], total: 0, skuCount: 0 };
  const skus = await fetchAllSkus(wb);
  const chunks = [];
  for (let i = 0; i < skus.length; i += 1000) chunks.push(skus.slice(i, i + 1000));

  const perWh = [];
  for (const w of warehouses) {
    let sum = 0;
    for (const ch of chunks) {
      const r = await wb.request('marketplace', `/api/v3/stocks/${w.id}`, {
        method: 'POST', body: { skus: ch },
        methodLimit: { limit: 1, periodSec: 2, burst: 5 },
      });
      for (const s of (r.data?.stocks || [])) sum += Number(s.amount) || 0;
    }
    perWh.push({ name: w.name, id: w.id, qty: sum });
    log(`  FBS ${w.name}: ${sum}`);
  }
  perWh.sort((a, b) => b.qty - a.qty);
  return { warehouses, perWh, total: perWh.reduce((s, w) => s + w.qty, 0), skuCount: skus.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadCfg();
  const cost = Number(args.cost) || Number(cfg.avgCostRub) || 620;
  const pats = cfg.patterns;

  const { token, source } = resolveWbToken();
  if (!token) { log('✗ нет токена WB'); process.exit(2); }
  log(`токен: ${maskToken(token)} (${source}) · себестоимость ${cost} ₽`);

  const wb = new WbClient({ token, tokenType: resolveTokenType() });

  log('→ FBO: тяну warehouse_remains…');
  const items = await fetchFbo(wb);

  // Агрегация по складам.
  const whQty = new Map();       // физический склад → qty
  let transitToClient = 0, transitReturns = 0, totalReported = 0;
  for (const it of items) {
    for (const w of (it.warehouses || [])) {
      const name = w.warehouseName, q = Number(w.quantity) || 0;
      const low = String(name).toLowerCase().trim();
      if (low === 'в пути до получателей') transitToClient += q;
      else if (low === 'в пути возвраты на склад wb') transitReturns += q;
      else if (low === 'всего находится на складах') totalReported += q;
      else whQty.set(name, (whQty.get(name) || 0) + q);
    }
  }
  const all = [...whQty.entries()].map(([name, qty]) => ({ name, qty }))
    .filter((w) => !isSpecial(w.name)).sort((a, b) => b.qty - a.qty);
  const burned = all.filter((w) => matchBurned(w.name, pats));
  const remaining = all.filter((w) => !matchBurned(w.name, pats));
  const burnedQty = burned.reduce((s, w) => s + w.qty, 0);
  const remainingQty = remaining.reduce((s, w) => s + w.qty, 0);

  // Мерж с последним снимком: по складам, которые WB уже обнулил, берём последнее
  // известное количество (пик остатков) — это и есть оценка потерь на них.
  const hist = latestFireLosses(path.join(__dirname, 'reports-output'));
  const histBurned = hist ? Object.entries(hist.warehousesSeen).filter(([n]) => matchBurned(n, pats)) : [];
  const nowMap = new Map(burned.map((w) => [w.name, w.qty]));
  const histMap = new Map(histBurned);
  const mergedNames = new Set([...nowMap.keys(), ...histMap.keys()]);
  const merged = [...mergedNames].map((name) => {
    const now = nowMap.get(name) || 0, was = histMap.get(name) || 0, est = Math.max(now, was);
    return { name, now, est, gone: now === 0 && was > 0, rub: est * cost };
  }).filter((w) => w.est > 0).sort((a, b) => b.est - a.est);
  const estQty = merged.reduce((s, w) => s + w.est, 0);
  const histDate = hist ? new Date(hist.snapshotAt).toLocaleDateString('ru-RU') : null;

  // Какие сгоревшие склады из конфига УЖЕ не видны в отчёте (обнулены/исчезли).
  const seenBurnedPats = new Set();
  for (const w of burned) for (const p of pats) if (w.name.toLowerCase().includes(p.toLowerCase())) seenBurnedPats.add(p);
  const goneBurned = pats.filter((p) => !seenBurnedPats.has(p));

  log('→ FBS: тяну свои склады и остатки…');
  let fbs = { warehouses: [], perWh: [], total: 0, skuCount: 0 };
  try { fbs = await fetchFbs(wb); }
  catch (e) { log('  FBS ошибка:', e.status, e.message); fbs.error = `${e.status || ''} ${e.message}`; }

  const snapshotAt = new Date().toISOString();
  const report = {
    snapshotAt, cost,
    fbo: {
      burnedNow: burned.map((w) => ({ ...w, rub: w.qty * cost })),
      burnedNowTotalQty: burnedQty, burnedNowTotalRub: burnedQty * cost,
      burnedEstimate: merged, burnedEstTotalQty: estQty, burnedEstTotalRub: estQty * cost,
      estimateBasis: `max(now, snapshot ${histDate || 'n/a'})`,
      goneBurnedPatterns: goneBurned,
      remaining, remainingTotalQty: remainingQty,
      transitToClient, transitReturns, totalReportedOnWh: totalReported,
    },
    fbs: { total: fbs.total, perWh: fbs.perWh, warehousesCount: fbs.warehouses.length, skuCount: fbs.skuCount, error: fbs.error },
  };

  // ── Вывод ──
  const P = (...a) => process.stdout.write(a.join('') + '\n');
  P('\n════════ СВОДКА ПО КАБИНЕТУ WB ════════');
  P(`снимок: ${new Date(snapshotAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК · себестоимость ${cost} ₽\n`);

  P('1) ПОТЕРИ НА СГОРЕВШИХ СКЛАДАХ (FBO):');
  P(`   ${'склад'.padEnd(30)} ${'сейчас'.padStart(8)} ${'оценка*'.padStart(8)} ${'убыток ₽'.padStart(14)}`);
  for (const w of merged) {
    const mark = w.gone ? ' ⚠обнулён' : '';
    P(`   ${w.name.padEnd(30)} ${String(w.now).padStart(8)} ${String(w.est).padStart(8)} ${rub(w.rub).padStart(14)}${mark}`);
  }
  P(`   ${'—'.repeat(30)} ${'—'.repeat(8)} ${'—'.repeat(8)} ${'—'.repeat(14)}`);
  P(`   ${'ИТОГО'.padEnd(30)} ${String(burnedQty).padStart(8)} ${String(estQty).padStart(8)} ${rub(estQty * cost).padStart(14)}`);
  P(`   * оценка = пик остатков (макс. из «сейчас» и снимка ${histDate || '—'}); по обнулённым складам берётся последнее известное количество.`);
  P(`   «сейчас» (нижняя граница, только видимое): ${num(burnedQty)} ед / ${rub(burnedQty * cost)}`);

  P('\n2) ОСТАТКИ FBO НА ОСТАВШИХСЯ СКЛАДАХ:');
  for (const w of remaining) P(`   ${w.name.padEnd(28)} ${String(w.qty).padStart(7)} ед`);
  P(`   ${'—'.repeat(28)} ${'—'.repeat(7)}`);
  P(`   ${'ИТОГО FBO (оставшиеся)'.padEnd(28)} ${String(remainingQty).padStart(7)} ед`);

  P('\n3) В ПУТИ:');
  P(`   до покупателей ............ ${num(transitToClient)} ед`);
  P(`   возвраты на склад WB ...... ${num(transitReturns)} ед`);

  P('\n4) ОСТАТКИ FBS (свои склады продавца):');
  if (fbs.error) P(`   ⚠️ недоступно: ${fbs.error}`);
  else {
    for (const w of fbs.perWh) P(`   ${w.name.padEnd(28)} ${String(w.qty).padStart(7)} ед`);
    P(`   ${'—'.repeat(28)} ${'—'.repeat(7)}`);
    P(`   ${'ИТОГО FBS'.padEnd(28)} ${String(fbs.total).padStart(7)} ед  (${fbs.skuCount} баркодов, ${fbs.perWh.length} складов)`);
  }
  P('\n══════════════════════════════════════');

  const outDir = path.join(__dirname, 'reports-output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = snapshotAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, `cabinet-${stamp}.json`), JSON.stringify(report, null, 2));
  log(`\nсохранено: reports-output/cabinet-${stamp}.json`);
}

main().catch((e) => { log('✗ ' + (e.stack || e.message)); process.exit(1); });
