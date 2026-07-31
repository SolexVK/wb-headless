// seasonApi.js — обёртка движка «Ранг сезонности» для веб-планировщика.
// Строит прогноз плана продаж по предмету+фильтру (режим B, база — рынок),
// сохраняет результат отдельным файлом в planner/data/plans/<articleId>.json.
// Движок (portированный из ветки sales-plan) лежит в planner/lib/season/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSeasonPlanReport, collectFromCategory, collectSerpCandidates } from './season/seasonPlanReport.js';
import { buildFeatureDict } from './season/featureDict.js';
import { fetchCategoryItems, normalizeCategoryItem } from './season/mpstats.js';
import { fetchCardsInfo, cardMatchText } from './season/wbCard.js';
import { fetchItemKeywords, DailyLimitError } from './season/wbKeywords.js';
import { dbAvailable, planSave, planLoad, planDelete, planList, featureDictLoad, featureDictSave,
  subjectKeywordsLoad, subjectKeywordsSave, searchSave, searchList, mpstatsBudgetToday, mpstatsBudgetAdd,
  keywordsLoadMany, keywordsSave } from './db.js';

const FEATURE_TTL_MS = 30 * 24 * 3600 * 1000; // словарь признаков кэшируем на 30 дней
const SUBJECT_KW_TTL_MS = 7 * 24 * 3600 * 1000; // фразы предмета — на 7 дней (меняются медленно)

const MPSTATS_BASE = process.env.MPSTATS_BASE_URL || 'https://mpstats.io/api';
// Дерево категорий MPStats (пути предметов) — для подсказки в UI.
async function fetchCategories() {
  const resp = await fetch(`${MPSTATS_BASE}/wb/get/categories`, {
    headers: { 'X-Mpstats-TOKEN': process.env.MPSTATS_TOKEN, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`MPStats /categories → HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANS_DIR = path.join(__dirname, '..', 'data', 'plans');

const ymd = (d) => d.toISOString().slice(0, 10);

// История — 2 года от текущей даты (Правило 2 методологии).
export function default2Years() {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1); // вчера — последний закрытый день
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - 2); start.setUTCDate(start.getUTCDate() + 1);
  return { d1: ymd(start), d2: ymd(end) };
}

function ensurePlansDir() { if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true }); }
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'art';

const list = (v) => (Array.isArray(v) ? v.filter(Boolean)
  : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v) => (v == null || v === '' || v === true ? undefined : Number(v));
// Целевые фразы: массив как есть; строка — по переносам строк, запятым или «;».
const phraseList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean)
  : v ? String(v).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) : []);

// последние 30 дней (для by_keywords — профиль запросов свежий)
function last30() {
  const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() - 1);
  const d1 = new Date(d2); d1.setUTCDate(d1.getUTCDate() - 30);
  return { d1: ymd(d1), d2: ymd(d2) };
}

// собрать subject.filter в форме, которую ждёт collectFromCategory
function buildFilter(f = {}) {
  const filter = {
    words: list(f.words), allWords: list(f.allWords), exclude: list(f.exclude),
    mustHave: list(f.mustHave), // строгий ключ («кровь из носа»): ВСЕ термины обязательны
    brands: list(f.brands), excludeBrands: list(f.excludeBrands),
    priceMin: num(f.priceMin), priceMax: num(f.priceMax),
    minSalesPerMonth: num(f.minSales), minRevenuePerMonth: num(f.minRevenue),
    matchAll: f.matchAll ? true : undefined,
  };
  // Новый режим: поведенческая релевантность (доля целевого поискового трафика).
  // Активируется, если заданы целевые слова ИЛИ выбранные фразы предмета.
  const targetWords = list(f.targetWords) || [];
  const pickedPhrases = list(f.pickedPhrases) || [];
  if (targetWords.length || pickedPhrases.length) {
    let threshold = num(f.threshold);
    if (threshold != null && threshold > 1) threshold = threshold / 100; // приняли проценты
    const kw = last30();
    filter.relevance = {
      targetWords, pickedPhrases,
      threshold: threshold != null ? threshold : 0.2,
      budget: num(f.budget) != null ? num(f.budget) : 60,
      minusWords: list(f.minusWords) || list(f.exclude) || [],
      kwD1: kw.d1, kwD2: kw.d2,
    };
  }
  for (const k of Object.keys(filter)) if (filter[k] === undefined) delete filter[k];
  return filter;
}

// Построить прогноз (режим B: предмет + фильтр, база = рынок).
// Движок сам выбирает окно сезона из ГОДОВОГО анализа; из UI приходит только
// целевой ГОД старта сезона (targetYear).
export async function runForecast(cfg = {}) {
  if (!process.env.MPSTATS_TOKEN) throw new Error('MPSTATS_TOKEN не задан в окружении службы (planner/data/.env)');
  const hist = default2Years();
  const targetYear = num(cfg.targetYear) || (Number(hist.d2.slice(0, 4)) + 1);
  const phrases = phraseList(cfg.phrases);
  if (!phrases.length) throw new Error('Не указаны целевые фразы (по ним ищем товары-аналоги)');
  const minusWords = list(cfg.minusWords) || list(cfg.exclude) || [];
  const subject = {
    path: cfg.path, limit: num(cfg.limit),
    // ГЛАВНЫЙ источник — SERP «фраза → товары» (1 запрос на фразу, дневные ряды за 2 года).
    serp: {
      phrases, minusWords,
      priceMin: num(cfg.priceMin), priceMax: num(cfg.priceMax),
      minRevenuePerMonth: num(cfg.minRevenue),
      limit: num(cfg.limit) || 60,
      approvedIds: (list(cfg.approvedIds) || []).map(Number).filter((n) => Number.isFinite(n) && n > 0),
      excludedIds: (list(cfg.excludedIds) || []).map(Number).filter((n) => Number.isFinite(n) && n > 0),
      gender: ['female', 'male', 'kids'].includes(cfg.gender) ? cfg.gender : null,
      nicheWords: list(cfg.nicheWords) || [],
    },
  };
  const report = await buildSeasonPlanReport({
    d1: hist.d1, d2: hist.d2,
    label: cfg.label || phrases[0],
    subject,
    forecast: { targetYear },
    baseSource: 'market',
    plan: { oos: cfg.oos !== false, weekly: cfg.weekly !== false, rampDays: num(cfg.rampDays), seasonFrac: num(cfg.seasonFrac), targetLevel: cfg.targetLevel === 'top1' ? 'top1' : 'top3',
      articleType: cfg.articleType === 'allseason' ? 'allseason' : 'seasonal',
      growthMode: cfg.growthMode === 'none' ? 'none' : 'market', growthYears: cfg.growthYears != null ? num(cfg.growthYears) : null,
      // «сегодня» = следующий день после конца истории (вчера) — прогноз строим вперёд от него
      asOf: ymd(new Date(Date.parse(hist.d2) + 86400000)) },
  });
  // Учёт запросов MPStats (SERP: 1 на фразу) + память запроса.
  if (dbAvailable()) {
    mpstatsBudgetAdd(report.requests || 0);
    try {
      searchSave({
        path: cfg.path, targetWords: phrases, minusWords, pickedPhrases: phrases, threshold: null,
        keptIds: (report.perItem || []).map((m) => m.wb).filter(Boolean),
      });
    } catch { /* память не критична */ }
  }
  return report;
}

const normPhrase = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

// Меню фраз для выбора галочками. ВАЖНО: отчёт предмета (category/by_keywords) НЕ содержит
// нишевых фраз (только «головные» запросы), поэтому фразы берём из by_keywords САМИХ
// целевых товаров: находим по карточкам топ-N товаров с целевым словом → их поисковые
// фразы содержат нишу («муслиновая рубашка…») + «жирные неявные» (по которым они тоже
// ранжируются). Кэш меню — по (предмет + целевые слова) на 7 дней; профили by_keywords
// эталонов переиспользуются при построении (лимит не тратится дважды).
async function buildTargetPhrases(path, targetWords, minusWords, { seeds = 6 } = {}) {
  const tw = targetWords.map(normPhrase).filter(Boolean);
  const mw = minusWords.map(normPhrase).filter(Boolean);
  const kw = last30();
  const cat = await fetchCategoryItems({ path, d1: kw.d1, d2: kw.d2, startRow: 0, endRow: 600 });
  if (dbAvailable()) mpstatsBudgetAdd(1);
  let items = (cat.data || []).map(normalizeCategoryItem).filter((x) => x.wb)
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  // бесплатный предфильтр карточками: товары с целевым словом, без минус-слов
  const head = items.slice(0, 250);
  const cards = await fetchCardsInfo(head.map((x) => x.wb), { concurrency: 8 });
  const cand = head.filter((x) => {
    const t = cardMatchText(cards.get(Number(x.wb)));
    if (!t) return false;
    if (mw.some((w) => t.includes(w))) return false;
    return tw.length ? tw.some((w) => t.includes(w)) : true;
  });
  const seedItems = cand.slice(0, seeds);
  // by_keywords эталонов: кэш-первым (БД), сеть только за неизвестными
  const cached = dbAvailable() ? keywordsLoadMany(seedItems.map((s) => s.wb), 30 * 24 * 3600 * 1000) : new Map();
  const freq = new Map(); let dailyLimit = false;
  for (const s of seedItems) {
    let prof = cached.get(Number(s.wb));
    if (!prof) {
      try { prof = await fetchItemKeywords(s.wb, { d1: kw.d1, d2: kw.d2 }); }
      catch (e) { if (e instanceof DailyLimitError) { dailyLimit = true; break; } prof = null; }
      if (prof && dbAvailable()) { keywordsSave(s.wb, prof, kw.d1, kw.d2); mpstatsBudgetAdd(1); }
    }
    if (!prof) continue;
    for (const p of (prof.phrases || [])) {
      const n = normPhrase(p.phrase);
      const words = n.split(/\s+/).length;
      if (words < 2 || words > 6) continue;      // фразы 2–6 слов
      if (mw.some((w) => n.includes(w))) continue; // минус-слова вон
      const cur = freq.get(n) || { phrase: p.phrase, norm: n, freq: 0, target: tw.some((w) => n.includes(w)) };
      cur.freq += p.traffic; freq.set(n, cur);
    }
  }
  const arr = [...freq.values()]
    .sort((a, b) => (b.target - a.target) || (b.freq - a.freq))   // муслиновые — наверх
    .slice(0, 80)
    .map((p) => ({ phrase: p.phrase, norm: p.norm, freq: Math.round(p.freq), target: !!p.target }));
  return { phrases: arr, seedsUsed: seedItems.length, targetCount: arr.filter((p) => p.target).length, dailyLimit };
}

// Меню фраз для выбора галочками. Кэш по (предмет+целевые слова) на 7 дней.
export async function getSubjectPhrases(cfg = {}) {
  if (!process.env.MPSTATS_TOKEN) throw new Error('MPSTATS_TOKEN не задан в окружении службы (planner/data/.env)');
  const path = String(cfg.path || '').trim();
  if (!path) throw new Error('Не указан путь предмета WB (path)');
  const targetWords = list(cfg.targetWords) || [];
  const minusWords = list(cfg.minusWords) || list(cfg.exclude) || [];
  const cacheKey = path + '' + targetWords.map((s) => s.toLowerCase()).sort().join(',');
  if (!cfg.force && dbAvailable()) {
    const hit = subjectKeywordsLoad(cacheKey, SUBJECT_KW_TTL_MS);
    if (hit) return { phrases: hit.phrases, cached: true, fetchedAt: hit.fetchedAt, budget: mpstatsBudgetToday() };
  }
  const r = await buildTargetPhrases(path, targetWords, minusWords);
  if (dbAvailable() && r.phrases.length) subjectKeywordsSave(cacheKey, r.phrases, null, null);
  return { phrases: r.phrases, cached: false, seedsUsed: r.seedsUsed, targetCount: r.targetCount, dailyLimit: r.dailyLimit, budget: dbAvailable() ? mpstatsBudgetToday() : null };
}

// Текущий дневной бюджет запросов MPStats (использовано/лимит/остаток) + недавние запросы.
export function budgetStatus(path) {
  if (!dbAvailable()) return { budget: null, recent: [] };
  return { budget: mpstatsBudgetToday(), recent: searchList(path || null, 10) };
}

// Кандидаты на ручную проверку: собрать выборку и вернуть ТОП-20 «неопределённых»
// (высокая выручка, в сегменте, не исключены, но не прошли плюс-слова) + размер выборки.
// «Предв. выбор»: ТОП-30 по продажам среди товаров БЕЗ нишевого ключа в названии —
// на визуальный отбор. Использует ту же выдачу SERP (кэш) — почти без запросов.
export async function runCandidates(cfg = {}) {
  if (!process.env.MPSTATS_TOKEN) throw new Error('MPSTATS_TOKEN не задан в окружении службы (planner/data/.env)');
  const phrases = phraseList(cfg.phrases);
  if (!phrases.length) throw new Error('Не указаны целевые фразы');
  const hist = default2Years();
  const log = [];
  const r = await collectSerpCandidates({
    phrases, minusWords: list(cfg.minusWords) || [],
    priceMin: num(cfg.priceMin), priceMax: num(cfg.priceMax), minRevenuePerMonth: num(cfg.minRevenue),
    gender: ['female', 'male', 'kids'].includes(cfg.gender) ? cfg.gender : null,
    approvedIds: (list(cfg.approvedIds) || []).map(Number).filter((n) => Number.isFinite(n) && n > 0),
    nicheWords: list(cfg.nicheWords) || [],
    topN: 30,
  }, hist.d1, hist.d2, log);
  if (dbAvailable()) mpstatsBudgetAdd(r.requests || 0);
  return { ...r, log };
}

// Словарь признаков предмета: из кэша (БД) или собрать заново. Кэш по path на 30 дней.
export async function getFeatureDict(cfg = {}) {
  if (!process.env.MPSTATS_TOKEN) throw new Error('MPSTATS_TOKEN не задан в окружении службы (planner/data/.env)');
  const path = String(cfg.path || '').trim();
  if (!path) throw new Error('Не указан путь предмета WB (path)');
  if (!cfg.force && dbAvailable()) {
    const hit = featureDictLoad(path, FEATURE_TTL_MS);
    if (hit) return { ...hit, cached: true };
  }
  const hist = default2Years();
  const log = [];
  const dict = await buildFeatureDict({ path, d1: hist.d1, d2: hist.d2, sample: num(cfg.sample) || 400, log });
  if (dbAvailable()) featureDictSave(path, dict);
  return { ...dict, cached: false };
}

// Поиск пути предмета по корню слова (для подсказки в UI).
export async function searchCategories(query, limit = 40) {
  const q = String(query || '').trim();
  if (!q) return [];
  const all = await fetchCategories();
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return all
    .filter((c) => re.test(c.path) && !/Акции/i.test(c.path))
    .map((c) => c.path)
    .slice(0, limit);
}

// ---- хранилище планов: SQLite (при наличии), иначе отдельные JSON-файлы ----
// Одноразовый импорт существующих JSON-планов в БД (чтобы не потерять при переходе).
let _plansMigrated = false;
function migrateJsonPlans() {
  if (_plansMigrated) return; _plansMigrated = true;
  if (!dbAvailable()) return;
  try {
    if ((planList() || []).length) return;            // в БД уже есть — не трогаем
    if (!fs.existsSync(PLANS_DIR)) return;
    let n = 0;
    for (const f of fs.readdirSync(PLANS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { const rec = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8')); planSave(rec.articleId, rec); n++; } catch { /* skip */ }
    }
    if (n) console.log(`[planner] импортировано планов сезонности в БД: ${n}`);
  } catch { /* игнор */ }
}
// Индексная строка плана из полной записи (без тяжёлых дневных рядов).
function planIndexRow(rec) {
  const p = (rec.report && rec.report.plan) || {};
  const fd = p.forecastDaily || [];
  return {
    articleId: rec.articleId,
    label: rec.report && rec.report.label,
    forecastPeriod: rec.report && rec.report.forecastPeriod,
    generatedAt: rec.report && rec.report.generatedAt,
    savedAt: rec.savedAt,
    rank: p.rank || null,
    totalUnits: Math.round(fd.reduce((s, d) => s + (+d.plannedOrders || 0), 0)),
  };
}
export function savePlan(articleId, report, cfg) {
  const rec = { articleId, cfg: cfg || null, report, savedAt: new Date().toISOString() };
  if (dbAvailable()) { planSave(articleId, rec); return rec; }
  ensurePlansDir();
  fs.writeFileSync(path.join(PLANS_DIR, safeId(articleId) + '.json'), JSON.stringify(rec));
  return rec;
}
export function loadPlan(articleId) {
  migrateJsonPlans();
  if (dbAvailable()) return planLoad(articleId);
  try {
    const fp = path.join(PLANS_DIR, safeId(articleId) + '.json');
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}
export function deletePlan(articleId) {
  if (dbAvailable()) return planDelete(articleId);
  const fp = path.join(PLANS_DIR, safeId(articleId) + '.json');
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); return true; }
  return false;
}
// краткий индекс сохранённых планов (без тяжёлых дневных рядов)
export function listPlans() {
  migrateJsonPlans();
  const out = [];
  if (dbAvailable()) {
    for (const rec of (planList() || [])) out.push(planIndexRow(rec));
  } else {
    ensurePlansDir();
    for (const f of fs.readdirSync(PLANS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(planIndexRow(JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8')))); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => String(a.articleId).localeCompare(String(b.articleId), undefined, { numeric: true }));
}
