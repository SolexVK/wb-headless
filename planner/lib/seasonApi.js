// seasonApi.js — обёртка движка «Ранг сезонности» для веб-планировщика.
// Строит прогноз плана продаж по предмету+фильтру (режим B, база — рынок),
// сохраняет результат отдельным файлом в planner/data/plans/<articleId>.json.
// Движок (portированный из ветки sales-plan) лежит в planner/lib/season/.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSeasonPlanReport } from './season/seasonPlanReport.js';

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
    brands: list(f.brands), excludeBrands: list(f.excludeBrands),
    priceMin: num(f.priceMin), priceMax: num(f.priceMax),
    minSalesPerMonth: num(f.minSales), minRevenuePerMonth: num(f.minRevenue),
  };
  for (const k of Object.keys(filter)) if (filter[k] === undefined) delete filter[k];
  return filter;
}

// Построить прогноз (режим B: предмет + фильтр, база = рынок).
export async function runForecast(cfg = {}) {
  if (!process.env.MPSTATS_TOKEN) throw new Error('MPSTATS_TOKEN не задан в окружении службы (planner/data/.env)');
  if (!cfg.path) throw new Error('Не указан путь предмета WB (path)');
  if (!cfg.from || !cfg.to) throw new Error('Не указан прогнозный период (from/to)');
  const hist = default2Years();
  return buildSeasonPlanReport({
    d1: hist.d1, d2: hist.d2,
    label: cfg.label || cfg.path,
    subject: {
      path: cfg.path,
      filter: buildFilter(cfg.filter || cfg),
      limit: num(cfg.limit),
      maxPages: num(cfg.maxPages),
    },
    forecast: { from: cfg.from, to: cfg.to },
    baseSource: 'market',
    plan: { oos: cfg.oos !== false, weekly: cfg.weekly !== false },
  });
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

// ---- хранилище планов (отдельные JSON-файлы, чтобы не раздувать state.json) ----
export function savePlan(articleId, report, cfg) {
  ensurePlansDir();
  const rec = { articleId, cfg: cfg || null, report, savedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(PLANS_DIR, safeId(articleId) + '.json'), JSON.stringify(rec));
  return rec;
}
export function loadPlan(articleId) {
  try {
    const fp = path.join(PLANS_DIR, safeId(articleId) + '.json');
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}
export function deletePlan(articleId) {
  const fp = path.join(PLANS_DIR, safeId(articleId) + '.json');
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); return true; }
  return false;
}
// краткий индекс сохранённых планов (без тяжёлых дневных рядов)
export function listPlans() {
  ensurePlansDir();
  const out = [];
  for (const f of fs.readdirSync(PLANS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf8'));
      const p = (rec.report && rec.report.plan) || {};
      const fd = p.forecastDaily || [];
      out.push({
        articleId: rec.articleId,
        label: rec.report && rec.report.label,
        forecastPeriod: rec.report && rec.report.forecastPeriod,
        generatedAt: rec.report && rec.report.generatedAt,
        savedAt: rec.savedAt,
        rank: p.rank || null,
        totalUnits: Math.round(fd.reduce((s, d) => s + (+d.plannedOrders || 0), 0)),
      });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => String(a.articleId).localeCompare(String(b.articleId), undefined, { numeric: true }));
}
