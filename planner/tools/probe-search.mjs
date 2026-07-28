// probe-search.mjs v10 — РАЗВЕДКА эндпоинтов + POC «поведенческой релевантности».
//
// Один экономный прогон на живом MPStats (запускать на Mac mini, где есть токен):
//   node --env-file=data/.env tools/probe-search.mjs
//   опции:  --cat="Женщинам/Блузки и рубашки/Рубашка"  --word=муслин,марлевк
//           --minus=прозрач,детск   --budget=25   --top=3   --phrases=20   --cand=12
//
// Что делает:
//  ФАЗА 0 — разведка: какие вызовы реально работают? Проверяем «фраза → артикулы»
//           (SERP) и «фразы предмета» (category/subject by_keywords) — печатаем статус
//           и форму ответа. Это отвечает на главный вопрос: возможен ли самый дешёвый
//           сценарий (ТОП-3 → фразы → запрос по фразам → артикулы) вообще.
//  ФАЗА 1 — POC: ТОП-3 муслиновых → by_keywords → 20 частотных фраз (3–6 слов) →
//           бесплатный предфильтр карточками → by_keywords по кандидатам →
//           балл релевантности (в скольких из 20 фраз засветился) + доля целевого
//           трафика. Печатает список аналогов, отсортированный по релевантности.
//
// ВСЕ запросы к MPStats считаются и ограничены --budget. На суточный лимит — стоп.
// by_keywords кэшируется на диск (data/wb-cache/keywords) — повторный прогон почти бесплатен.

import { fetchCategoryItems, normalizeCategoryItem } from '../lib/season/mpstats.js';
import { fetchCardsInfo, cardMatchText } from '../lib/season/wbCard.js';
import { fetchItemKeywords } from '../lib/season/wbKeywords.js';

// ── аргументы/конфиг ─────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const CAT = args.cat || 'Женщинам/Блузки и рубашки/Рубашка';
const WORDS = String(args.word || 'муслин,марлевк').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MINUS = String(args.minus || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const BUDGET = Number(args.budget || 25);      // потолок запросов к MPStats за прогон
const TOP = Number(args.top || 3);             // сколько «эталонов» берём под by_keywords
const N_PHRASES = Number(args.phrases || 20);  // сколько фраз показать
const CAND_CAP = Number(args.cand || 12);      // потолок кандидатов под by_keywords (фолбэк)
const BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
const TOKEN = process.env.MPSTATS_TOKEN;

const ymd = (d) => d.toISOString().slice(0, 10);
const d2d = new Date(); d2d.setUTCDate(d2d.getUTCDate() - 1);
const d1d = new Date(d2d); d1d.setUTCDate(d1d.getUTCDate() - 30);
const D1 = ymd(d1d), D2 = ymd(d2d);
const L = (...a) => console.log(...a);
const oneLine = (s, n = 240) => String(s).replace(/\s+/g, ' ').slice(0, n);

if (!TOKEN) { L('⚠ MPSTATS_TOKEN не задан. Запуск: node --env-file=data/.env tools/probe-search.mjs'); process.exit(1); }

let reqN = 0; let limitHit = false;
const H = { 'X-Mpstats-TOKEN': TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' };

// сырой запрос с учётом бюджета — для разведки недокументированных путей
async function raw(method, pathAndQuery, body) {
  if (limitHit) return { skipped: 'лимит' };
  if (reqN >= BUDGET) return { skipped: 'бюджет' };
  reqN++;
  try {
    const r = await fetch(`${BASE}${pathAndQuery}`, {
      method, headers: H, body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    if (r.status === 429 && /лимит|limit/i.test(t)) limitHit = true;
    let json; try { json = JSON.parse(t); } catch { /* не json */ }
    return { status: r.status, len: t.length, text: t, json };
  } catch (e) { return { error: String(e && e.message || e) }; }
}

// краткая форма ответа: тип, ключи, размер массивов, есть ли поля nmId/words
function shape(res) {
  if (res.skipped) return `(пропуск: ${res.skipped})`;
  if (res.error) return `ошибка ${res.error}`;
  const j = res.json;
  let s = `HTTP ${res.status}, len=${res.len}`;
  if (j == null) return `${s}, тело=«${oneLine(res.text, 120)}»`;
  if (Array.isArray(j)) return `${s}, массив[${j.length}]`;
  const keys = Object.keys(j);
  s += `, ключи={${keys.slice(0, 12).join(',')}}`;
  for (const k of ['data', 'items', 'words', 'result', 'keywords']) {
    if (Array.isArray(j[k])) s += `  ${k}[${j[k].length}]`;
    else if (j[k] && typeof j[k] === 'object') s += `  ${k}{${Object.keys(j[k]).length}}`;
  }
  return s;
}

// достаёт из ответа массив «товаров», если он там есть (эвристика по nmId-подобному полю)
function extractItems(res) {
  const j = res && res.json; if (!j) return null;
  const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : (Array.isArray(j.items) ? j.items : null));
  if (!arr || !arr.length) return null;
  const idKey = ['id', 'nmId', 'nm', 'sku'].find((k) => arr[0][k] != null);
  if (!idKey) return null;
  return arr.map((r) => Number(r[idKey])).filter((n) => Number.isFinite(n) && n > 0);
}

const words = (p) => String(p).trim().split(/\s+/).length;
const hasMinus = (text) => MINUS.some((m) => text.includes(m));
const hasWord = (text) => WORDS.some((w) => text.includes(w));

(async () => {
  L(`\n════ ПРОБНИК v10 · предмет: «${CAT}» · слова: [${WORDS.join(', ')}]${MINUS.length ? ` · минус: [${MINUS.join(', ')}]` : ''} · период ${D1}…${D2} · бюджет ${BUDGET} ════\n`);

  // ── категория: универсум товаров + дневные данные (1 запрос, дёшево) ───────
  L('▶ ФАЗА 0 · разведка эндпоинтов\n');
  let items = [];
  {
    reqN++;
    let cat; try { cat = await fetchCategoryItems({ path: CAT, d1: D1, d2: D2, startRow: 0, endRow: 500 }); }
    catch (e) { L(`  category: ОШИБКА ${e.message}`); if (e.dailyLimit) limitHit = true; cat = { total: 0, data: [] }; }
    items = (cat.data || []).map(normalizeCategoryItem).filter((x) => x.wb);
    L(`  [1] category (path=предмет) → всего в предмете ${cat.total}, получено строк ${items.length}`);
    if (items[0]) L(`      пример: nm=${items[0].wb} «${oneLine(items[0].name, 60)}» цена=${items[0].price} выручка=${items[0].revenue}`);
  }
  if (!items.length && !limitHit) L('  ⚠ категория пуста — проверь путь предмета (--cat=...)');

  // ── эталонный муслиновый товар для теста item/by_keywords ─────────────────
  // Берём из предмета первый, чья КАРТОЧКА содержит целевое слово (карточки бесплатны).
  let seedId = null, seedCards = new Map();
  if (items.length) {
    const head = items.slice(0, 60).map((x) => x.wb);
    seedCards = await fetchCardsInfo(head, { concurrency: 8 });
    const seed = items.slice(0, 60).find((x) => { const t = cardMatchText(seedCards.get(x.wb)); return t && hasWord(t) && !hasMinus(t); });
    seedId = seed ? seed.wb : (items[0] && items[0].wb);
    L(`  [-] эталон для by_keywords: nm=${seedId} ${seed ? '(карточка содержит целевое слово)' : '(целевого слова не нашёл в топ-60 карточек — взял первый)'}`);
  }

  // ── item/by_keywords (известно рабочий) — подтверждаем структуру ───────────
  if (seedId && !limitHit && reqN < BUDGET) {
    const r = await raw('GET', `/wb/get/item/${seedId}/by_keywords?d1=${D1}&d2=${D2}`);
    L(`  [2] item/${seedId}/by_keywords → ${shape(r)}`);
    if (r.json && r.json.words) {
      const sample = Object.entries(r.json.words).slice(0, 3).map(([k, v]) => `«${k}»{${Object.keys(v || {}).join(',')}}`).join('  ');
      L(`      поля фразы: ${sample}`);
    }
  }

  // ── КАНДИДАТЫ на «фразы предмета» и «фраза → артикулы» (недокументированы) ──
  const disc = [
    ['category/by_keywords GET', 'GET', `/wb/get/category/by_keywords?path=${encodeURIComponent(CAT)}&d1=${D1}&d2=${D2}`, null],
    ['subject/by_keywords GET', 'GET', `/wb/get/subject/by_keywords?path=${encodeURIComponent(CAT)}&d1=${D1}&d2=${D2}`, null],
    ['keywords/expanding GET (фраза)', 'GET', `/wb/get/keywords/expanding?path=${encodeURIComponent(WORDS[0])}&d1=${D1}&d2=${D2}`, null],
    ['keywords GET (фраза)', 'GET', `/wb/get/keywords?path=${encodeURIComponent(WORDS[0])}&d1=${D1}&d2=${D2}`, null],
    ['search POST (фраза, товары)', 'POST', `/wb/get/search?path=${encodeURIComponent(WORDS[0])}&d1=${D1}&d2=${D2}`, { startRow: 0, endRow: 20, sortModel: [{ colId: 'revenue', sort: 'desc' }], filterModel: {} }],
  ];
  let serpOk = null; // [label, ids[]] если нашёлся рабочий «фраза → артикулы»
  let subjectPhrases = null;
  for (const [label, method, path, body] of disc) {
    if (limitHit || reqN >= BUDGET) { L(`  [-] ${label}: пропуск (${limitHit ? 'лимит' : 'бюджет'})`); continue; }
    const r = await raw(method, path, body);
    L(`  [3] ${label} → ${shape(r)}`);
    const ids = extractItems(r);
    if (ids && ids.length && !serpOk) { serpOk = [label, ids]; L(`      ↑ похоже на СПИСОК ТОВАРОВ (${ids.length}) — кандидат на «фраза → артикулы»`); }
    // фразы предмета: ищем поле words/keywords с частотами
    if (!subjectPhrases && r.json) {
      const w = r.json.words || r.json.keywords || (Array.isArray(r.json.data) && r.json.data[0] && (r.json.data[0].word || r.json.data[0].keyword) ? r.json.data : null);
      if (w) { subjectPhrases = label; L(`      ↑ похоже на ФРАЗЫ ПРЕДМЕТА — можно брать список фраз за 1 запрос`); }
    }
  }
  L(`\n  ВЫВОД ФАЗЫ 0: «фраза → артикулы» ${serpOk ? `РАБОТАЕТ через ${serpOk[0]}` : 'НЕ найдено (самый дешёвый сценарий недоступен — идём фолбэком)'}; «фразы предмета одним запросом» ${subjectPhrases ? `есть (${subjectPhrases})` : 'не подтверждено'}.`);

  if (limitHit) { L('\n⚠ достигнут суточный лимит MPStats — стоп. Повторите завтра (кэш сохранён).'); return; }

  // ── ФАЗА 1 · POC релевантности ────────────────────────────────────────────
  L('\n▶ ФАЗА 1 · POC поведенческой релевантности\n');
  if (!items.length) { L('  нет товаров предмета — POC пропущен.'); return; }

  // 1) ТОП-N «эталонов»: по выручке, карточка содержит целевое слово, без минус-слов
  const seeds = items.filter((x) => { const t = cardMatchText(seedCards.get(x.wb)); return t && hasWord(t) && !hasMinus(t); }).slice(0, TOP);
  L(`  эталоны (${seeds.length}): ${seeds.map((s) => s.wb).join(', ') || '—'}`);
  if (!seeds.length) { L('  ⚠ среди топ-60 карточек нет целевого слова — возможно, неверный предмет/слово.'); return; }

  // 2) by_keywords эталонов → агрегируем фразы 3–6 слов
  const freq = new Map();
  for (const s of seeds) {
    if (limitHit || reqN >= BUDGET) break;
    reqN++;
    let prof; try { prof = await fetchItemKeywords(s.wb, { d1: D1, d2: D2 }); } catch (e) { if (e && e.dailyLimit) { limitHit = true; break; } prof = null; }
    if (!prof || !prof.phrases) continue;
    for (const p of prof.phrases) {
      const w = words(p.phrase);
      if (w < 3 || w > 6) continue;
      freq.set(p.phrase.toLowerCase(), (freq.get(p.phrase.toLowerCase()) || 0) + p.traffic);
    }
  }
  const top20 = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, N_PHRASES);
  L(`\n  ТОП-${top20.length} частотных фраз (3–6 слов) по эталонам:`);
  top20.forEach(([p, tr], i) => L(`   ${String(i + 1).padStart(2)}. ${String(tr).padStart(7)}  ${p}`));
  const phraseSet = top20.map(([p]) => p);
  if (!phraseSet.length) { L('  ⚠ фраз не набралось — стоп.'); return; }

  // 3) кандидаты: карточка содержит целевое слово, без минус-слов (бесплатный предфильтр)
  //    расширяем обзор карточек до 200 верхних по выручке
  const wide = items.slice(0, 200).map((x) => x.wb);
  const cards = await fetchCardsInfo(wide, { concurrency: 8 });
  const cand = items.slice(0, 200).filter((x) => {
    const t = cardMatchText(cards.get(x.wb)); return t && hasWord(t) && !hasMinus(t);
  });
  L(`\n  кандидатов после предфильтра карточками: ${cand.length} (из ${wide.length} просмотренных, бесплатно)`);

  // 4) by_keywords по кандидатам (в пределах бюджета) → балл релевантности
  const rows = [];
  for (const c of cand.slice(0, CAND_CAP)) {
    if (limitHit || reqN >= BUDGET) { L(`   … стоп по ${limitHit ? 'лимиту' : 'бюджету'} на nm=${c.wb}`); break; }
    reqN++;
    let prof; try { prof = await fetchItemKeywords(c.wb, { d1: D1, d2: D2 }); } catch (e) { if (e && e.dailyLimit) { limitHit = true; break; } prof = null; }
    if (!prof) continue;
    const candPhrases = new Set((prof.phrases || []).map((p) => p.phrase.toLowerCase()));
    const matched = phraseSet.filter((p) => candPhrases.has(p)).length;      // сколько из 20 фраз
    let tgt = 0; for (const p of (prof.phrases || [])) if (hasWord(p.phrase.toLowerCase())) tgt += p.traffic;
    const share = prof.total > 0 ? tgt / prof.total : 0;                     // доля целевого трафика
    rows.push({ wb: c.wb, name: c.name, price: c.price, revenue: c.revenue, matched, share });
  }
  rows.sort((a, b) => (b.matched - a.matched) || (b.share - a.share));
  L(`\n  РЕЛЕВАНТНОСТЬ кандидатов (совпало фраз из ${phraseSet.length} · доля целевого трафика):`);
  L('   nmId       фраз  доля   цена   выручка  название');
  for (const r of rows) {
    L(`   ${String(r.wb).padEnd(10)} ${String(r.matched).padStart(3)}/${phraseSet.length}  ${(r.share * 100).toFixed(0).padStart(3)}%  ${String(r.price).padStart(6)}  ${String(r.revenue).padStart(8)}  ${oneLine(r.name, 50)}`);
  }

  L(`\n════ ИТОГО: запросов к MPStats ≈ ${reqN}${limitHit ? ' · достигнут суточный лимит' : ''}. Кэш by_keywords сохранён — повтор почти бесплатен. ════`);
  L('Читаем глазами: у «настоящих» муслиновых фраз-совпадений и доля должны быть заметно выше, чем у случайных хлопковых. Порог доли/фраз подберём по этой картинке.\n');
})();
