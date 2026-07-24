// seasonApi.js — обёртка движка «Ранг сезонности» для веб-планировщика.
// Строит прогноз плана продаж по предмету+фильтру (режим B, база — рынок),
// сохраняет результат отдельным файлом в planner/data/plans/<articleId>.json.
// Движок (portированный из ветки sales-plan) лежит в planner/lib/season/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSeasonPlanReport } from './season/seasonPlanReport.js';
import { buildFeatureDict } from './season/featureDict.js';
import { dbAvailable, planSave, planLoad, planDelete, planList, featureDictLoad, featureDictSave } from './db.js';

const FEATURE_TTL_MS = 30 * 24 * 3600 * 1000; // словарь признаков кэшируем на 30 дней

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
  for (const k of Object.keys(filter)) if (filter[k] === undefined) delete filter[k];
  return filter;
}

// Построить прогноз (режим B: предмет + фильтр, база = рынок).
// Движок сам выбирает окно сезона из ГОДОВОГО анализа; из UI приходит только
// целевой ГОД старта сезона (targetYear).
export async function runForecast(cfg = {}) {
  if (!process.env.MPSTATS_TOKEN) throw new Error('MPSTATS_TOKEN не задан в окружении службы (planner/data/.env)');
  if (!cfg.path) throw new Error('Не указан путь предмета WB (path)');
  const hist = default2Years();
  const targetYear = num(cfg.targetYear) || (Number(hist.d2.slice(0, 4)) + 1);
  return buildSeasonPlanReport({
    d1: hist.d1, d2: hist.d2,
    label: cfg.label || cfg.path,
    subject: {
      path: cfg.path,
      filter: buildFilter(cfg.filter || cfg),
      limit: num(cfg.limit),
      maxPages: num(cfg.maxPages),
    },
    forecast: { targetYear },
    baseSource: 'market',
    plan: { oos: cfg.oos !== false, weekly: cfg.weekly !== false, rampDays: num(cfg.rampDays), seasonFrac: num(cfg.seasonFrac), targetLevel: cfg.targetLevel === 'top1' ? 'top1' : 'top3', deepMatch: cfg.deepMatch !== false },
  });
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
  const dict = await buildFeatureDict({ path, d1: hist.d1, d2: hist.d2, sample: num(cfg.sample) || 250 });
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
