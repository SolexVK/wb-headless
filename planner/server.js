// planner/server.js — веб-сервер инструмента планирования производства.
// Отдаёт SPA из public/ и REST API для состояния и расчёта расписания.

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { defaultState, normalizeState } from './lib/model.js';
import { buildSchedule } from './lib/scheduler.js';
import { runForecast, savePlan, loadPlan, deletePlan, listPlans, searchCategories } from './lib/seasonApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SAMPLES_DIR = path.join(DATA_DIR, 'samples'); // образцы ткани (картинки) на диске
const PORT = process.env.PLANNER_PORT || 8090;
const HOST = process.env.PLANNER_HOST || '0.0.0.0'; // слушать все интерфейсы (доступ по сети)

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SAMPLES_DIR)) fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState(), null, 2));
  }
}

// Локальные секреты: подхватываем planner/data/.env (KEY=VALUE), НЕ переопределяя
// уже заданное окружение. Файл gitignored (planner/data/) — токены в репо не попадают.
// Сюда кладётся MPSTATS_TOKEN для раздела «Ранг сезонности».
function loadDotenv() {
  try {
    const envFile = path.join(DATA_DIR, '.env');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* ignore */ }
}
loadDotenv();

const IMG_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
};
// сохранить data:-URL картинки в файл на диске, вернуть публичный путь /samples/<файл>.
// Имя — по хэшу содержимого (дедупликация), поэтому повторная запись идемпотентна.
function saveSampleDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = IMG_EXT[m[1]] || 'img';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return null;
  ensureData();
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  const fp = path.join(SAMPLES_DIR, name);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
  return '/samples/' + name;
}
// перенести все встроенные (data:) образцы состояния в файлы; вернуть true, если что-то изменилось
function migrateSamples(state) {
  let changed = false;
  for (const a of state.articles || []) {
    if (!a.fabricInfo) continue;
    for (const c of Object.keys(a.fabricInfo)) {
      const info = a.fabricInfo[c];
      if (info && typeof info.image === 'string' && info.image.startsWith('data:')) {
        const p = saveSampleDataUrl(info.image);
        if (p) { info.image = p; changed = true; }
      }
    }
  }
  return changed;
}

function loadState() {
  ensureData();
  try {
    const st = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    if (migrateSamples(st)) fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); // одноразовый перенос data:→файл
    return st;
  } catch (e) {
    return defaultState();
  }
}
function saveState(state) {
  ensureData();
  const norm = normalizeState(state);
  migrateSamples(norm); // если клиент прислал встроенную картинку — тоже вынесем на диск
  fs.writeFileSync(STATE_FILE, JSON.stringify(norm, null, 2));
  return norm;
}

const app = express();

// Опциональная защита паролем (HTTP Basic).
// Включается, если задан PLANNER_PASSWORD. Логин по умолчанию — 'admin'
// (или PLANNER_USER). Без пароля сервер открыт — только для локальной сети!
const AUTH_USER = process.env.PLANNER_USER || 'admin';
const AUTH_PASS = process.env.PLANNER_PASSWORD || '';
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
if (AUTH_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Basic\s+(.+)$/i);
    if (m) {
      const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      if (timingSafeEqual(u || '', AUTH_USER) && timingSafeEqual(p || '', AUTH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Planner"');
    return res.status(401).send('Authorization required');
  });
  console.log('[planner] защита паролем включена (пользователь: ' + AUTH_USER + ')');
} else {
  console.log('[planner] ВНИМАНИЕ: пароль не задан — доступ открыт. Используйте только в локальной сети.');
}

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/samples', express.static(SAMPLES_DIR)); // образцы ткани (за той же авторизацией)

// текущее состояние
app.get('/api/state', (req, res) => {
  res.json(loadState());
});

// сохранить состояние целиком
app.put('/api/state', (req, res) => {
  try {
    const norm = saveState(req.body);
    res.json({ ok: true, state: norm });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// сбросить к сиду
app.post('/api/state/reset', (req, res) => {
  res.json({ ok: true, state: saveState(defaultState()) });
});

// расчёт расписания по текущему (или переданному) состоянию
app.post('/api/schedule', (req, res) => {
  try {
    const state = req.body && req.body.articles ? normalizeState(req.body) : loadState();
    const schedule = buildSchedule(state);
    res.json({ ok: true, schedule, state });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.stack || e) });
  }
});

// сохранить ручную правку блока (перетаскивание на Ганте) и вернуть пересчёт
app.post('/api/override', (req, res) => {
  try {
    const { cycleId, cutStart, clear } = req.body || {};
    const state = loadState();
    state.overrides = state.overrides || {};
    if (clear) delete state.overrides[cycleId];
    else state.overrides[cycleId] = { ...(state.overrides[cycleId] || {}), cutStart };
    const norm = saveState(state);
    res.json({ ok: true, schedule: buildSchedule(norm), state: norm });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// загрузка образца ткани: принимает data:-URL, пишет файл, возвращает путь /samples/<файл>
app.post('/api/sample', (req, res) => {
  try {
    const p = saveSampleDataUrl((req.body || {}).dataUrl);
    if (!p) return res.status(400).json({ ok: false, error: 'некорректное изображение' });
    res.json({ ok: true, path: p });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- Ранг сезонности (план продаж по методу сезонности) ----
// доступность (есть ли токен MPStats)
app.get('/api/season/status', (req, res) => {
  res.json({ ok: true, hasToken: !!process.env.MPSTATS_TOKEN });
});
// подсказка пути предмета по слову
app.get('/api/season/categories', async (req, res) => {
  try { res.json({ ok: true, paths: await searchCategories(req.query.q || '', 40) }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// список сохранённых планов (краткий индекс)
app.get('/api/season/plans', (req, res) => {
  try { res.json({ ok: true, plans: listPlans() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// один план целиком
app.get('/api/season/plan', (req, res) => {
  const rec = loadPlan(req.query.articleId || '');
  if (!rec) return res.status(404).json({ ok: false, error: 'план не найден' });
  res.json({ ok: true, ...rec });
});
// удалить сохранённый план
app.delete('/api/season/plan', (req, res) => {
  res.json({ ok: true, deleted: deletePlan((req.query.articleId) || (req.body && req.body.articleId) || '') });
});
// построить прогноз по фильтру артикула и сохранить (это сетевой вызов к MPStats, ~секунды)
app.post('/api/season/build', async (req, res) => {
  try {
    const cfg = req.body || {};
    if (!cfg.articleId) return res.status(400).json({ ok: false, error: 'не указан articleId' });
    const report = await runForecast(cfg);
    const rec = savePlan(cfg.articleId, report, cfg);
    res.json({ ok: true, ...rec });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'planner' }));

app.listen(PORT, HOST, () => {
  console.log(`[planner] слушает ${HOST}:${PORT}`);
  console.log(`[planner] локально: http://localhost:${PORT}`);
});
