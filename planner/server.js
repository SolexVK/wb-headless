// planner/server.js — веб-сервер инструмента планирования производства.
// Отдаёт SPA из public/ и REST API для состояния и расчёта расписания.

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { defaultState, normalizeState, PARTIA_ROLES } from './lib/model.js';
import { buildSchedule } from './lib/scheduler.js';
import { computeJitLayout } from './lib/jitLayout.js';
import { findRescues } from './lib/rescue.js';
import { runForecast, savePlan, loadPlan, deletePlan, listPlans, searchCategories, getFeatureDict, runCandidates, getSubjectPhrases, budgetStatus } from './lib/seasonApi.js';
import { hasWbToken, fetchCards, fetchBoxTariffs, findWarehouse, buildWbSupply, listVendorPrefixes } from './lib/wb/wbApi.js';
import { computeWbLogistics } from './lib/wb/logistics.js';
import { dbAvailable, stateLoadJson, stateSaveJson, eventAdd, responsibleList, responsibleSet, userList, metaGet, metaSet, snapshotSave, snapshotList, snapshotGet, snapshotDelete, snapshotPrune } from './lib/db.js';
import { installAuth, requireView, requireEdit } from './lib/authMiddleware.js';
import { applyWritePolicy, filterStateForRead, canEditAnything } from './lib/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SAMPLES_DIR = path.join(DATA_DIR, 'samples'); // образцы ткани (картинки) на диске
// Маркер сборки backend — по нему видно, что запущенный процесс Node подхватил свежий код
// (модель партий/поставок). Меняется вручную вместе с правками бэкенда.
const BACKEND_BUILD = 'gantt-wslabels-2026-08-27';
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
// Токен MPStats можно задать из интерфейса (шапка → ⚙). Он хранится в БД и ПЕРЕОПРЕДЕЛЯЕТ .env.
// Исходный из .env запоминаем как фолбэк (кнопка «сбросить к .env»).
const ENV_MPSTATS_TOKEN = process.env.MPSTATS_TOKEN || '';
function loadMpstatsTokenFromDb() {
  try { const m = metaGet('mpstats_token'); if (m && m.value) process.env.MPSTATS_TOKEN = m.value; } catch { /* нет БД — остаётся .env */ }
}
loadMpstatsTokenFromDb();
const maskToken = (t) => { t = String(t || ''); return t.length > 12 ? t.slice(0, 6) + '…' + t.slice(-4) : (t ? '…' : ''); };
function mpstatsTokenStatus() {
  const cur = process.env.MPSTATS_TOKEN || '';
  let dbSet = false;
  try { const m = metaGet('mpstats_token'); dbSet = !!(m && m.value); } catch { /* ignore */ }
  return { hasToken: !!cur, source: dbSet ? 'ui' : (ENV_MPSTATS_TOKEN ? 'env' : 'none'), masked: maskToken(cur), envAvailable: !!ENV_MPSTATS_TOKEN };
}

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
    if (dbAvailable()) {
      let raw = stateLoadJson();
      if (raw == null && fs.existsSync(STATE_FILE)) { // одноразовый импорт файла state.json в БД
        try { raw = JSON.stringify(normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))); stateSaveJson(raw); console.log('[planner] состояние импортировано из state.json в БД'); } catch { /* skip */ }
      }
      const st = normalizeState(raw ? JSON.parse(raw) : defaultState());
      if (migrateSamples(st)) stateSaveJson(JSON.stringify(st));
      return st;
    }
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
  if (dbAvailable()) stateSaveJson(JSON.stringify(norm));
  else fs.writeFileSync(STATE_FILE, JSON.stringify(norm, null, 2));
  return norm;
}

// Диф партий при сохранении: авто-штамп даты смены статуса (в incoming, чтобы
// сохранилось) + запись событий в prod_events (append-only). Мягко: без БД — no-op.
function applyProductionEvents(oldState, newState, actor) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const oldById = Object.fromEntries((oldState.partias || []).map((p) => [p.id, p]));
    for (const np of (newState.partias || [])) {
      const op = oldById[np.id];
      // сохранить историю дат статусов, если клиент их не прислал
      np.statusDates = { ...((op && op.statusDates) || {}), ...(np.statusDates || {}) };
      const oldStatus = op ? op.status : undefined;
      if (np.status && np.status !== oldStatus) {
        np.statusDates[np.status] = today; // авто-штамп реального «сегодня»
        eventAdd({ actor, kind: 'status', partiaId: np.id, articleId: np.articleId, workshopId: np.workshopId || '', dateValue: today, fromValue: oldStatus || '', toValue: np.status });
      }
      const newExp = np.expectedReady || '';
      const oldExp = op ? (op.expectedReady || '') : '';
      if (newExp !== oldExp) {
        eventAdd({ actor, kind: 'expected', partiaId: np.id, articleId: np.articleId, workshopId: np.workshopId || '', dateValue: newExp, fromValue: oldExp, toValue: newExp });
      }
    }
  } catch (e) { console.error('[planner] applyProductionEvents:', String(e.message || e)); }
}

const app = express();
app.set('trust proxy', true); // за Tailscale Funnel: доверяем X-Forwarded-Proto/For

app.use(express.json({ limit: '4mb' }));

// ── Авторизация ──
// Основной механизм — Telegram-аккаунт с allowlist (planner/lib/authMiddleware.js),
// включается при заданном TELEGRAM_BOT_TOKEN. Устанавливает guard + роуты /auth/*,
// /api/me, /api/admin/*. Пока Telegram не настроен — падаем на легаси HTTP Basic
// (PLANNER_PASSWORD), чтобы сервис в сети не остался без защиты во время перехода.
const auth = installAuth(app);
const AUTH_USER = process.env.PLANNER_USER || 'admin';
const AUTH_PASS = process.env.PLANNER_PASSWORD || '';
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
if (!auth.enabled && AUTH_PASS) {
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
  console.log('[planner] легаси-защита паролем включена (пользователь: ' + AUTH_USER + ')');
} else if (!auth.enabled) {
  console.log('[planner] ВНИМАНИЕ: авторизация не задана — доступ открыт. Используйте только в локальной сети.');
}
// Красивые пути без .html: /login (публичный) и /admin (за guard, req.user уже есть).
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Анти-кэш для кода интерфейса: html/js/css отдаём с обязательной ревалидацией,
// иначе браузер держит старые app.js/styles.css после обновления (обновления «не видно»).
const NO_CACHE_RE = /\.(?:html|js|css)$/i;

// Пуленепробиваемый кэш-бастинг: index.html отдаём с версией (mtime) на app.js/styles.css —
// `app.js?v=<mtime>`. При изменении файла URL меняется → любой кэш (браузер/прокси) обязан
// скачать заново. Дополняет no-cache: снимает проблему «обновил, а изменений не видно».
const PUB_DIR = path.join(__dirname, 'public');
function indexHtmlVersioned() {
  let html = fs.readFileSync(path.join(PUB_DIR, 'index.html'), 'utf8');
  return html.replace(/(?:src|href)="(app\.js|styles\.css)"/g, (m, file) => {
    let v = ''; try { v = String(Math.floor(fs.statSync(path.join(PUB_DIR, file)).mtimeMs)); } catch { /* нет файла — как есть */ }
    return v ? m.replace(`"${file}"`, `"${file}?v=${v}"`) : m;
  });
}
app.get(['/', '/index.html'], (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.type('html').send(indexHtmlVersioned());
  } catch { res.sendFile(path.join(PUB_DIR, 'index.html')); }
});

app.use(express.static(PUB_DIR, {
  setHeaders(res, filePath) {
    if (NO_CACHE_RE.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));
app.use('/samples', express.static(SAMPLES_DIR)); // образцы ткани (за той же авторизацией)

// текущее состояние (коммерческая юнит-экономика скрывается, если нет доступа к 'unit')
app.get('/api/state', (req, res) => {
  const st = loadState();
  res.json(req.perms ? filterStateForRead(st, req.perms) : st);
});

// сохранить состояние целиком (запись режется по правам: принимаем только те секции,
// которые пользователю разрешено редактировать; остальное берём из сохранённого)
app.put('/api/state', (req, res) => {
  try {
    if (req.perms && !canEditAnything(req.perms)) return res.status(403).json({ ok: false, error: 'read_only' });
    const old = loadState();
    const incoming = req.perms ? applyWritePolicy(old, req.body, req.perms) : req.body;
    // авто-штамп даты смены статуса + журнал производственных событий (append-only)
    applyProductionEvents(old, incoming, req.user ? req.user.telegramId : null);
    const norm = saveState(incoming);
    res.json({ ok: true, state: req.perms ? filterStateForRead(norm, req.perms) : norm });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// сбросить к сиду (перед сбросом — авто-снимок, чтобы можно было вернуться)
app.post('/api/state/reset', requireEdit('data'), (req, res) => {
  try { if (dbAvailable()) { const cur = stateLoadJson(); if (cur) { snapshotSave(cur, 'перед сбросом к примеру', 'auto'); snapshotPrune(20); } } } catch { /* снимок не критичен */ }
  res.json({ ok: true, state: saveState(defaultState()) });
});

// ── Версии/резервные копии состояния ──
// список версий (без тел — только метаданные)
app.get('/api/state/snapshots', requireView('data'), (req, res) => {
  if (!dbAvailable()) return res.json({ ok: true, available: false, snapshots: [] });
  res.json({ ok: true, available: true, snapshots: snapshotList() });
});
// сохранить текущее состояние как именованную версию
app.post('/api/state/snapshots', requireEdit('data'), (req, res) => {
  if (!dbAvailable()) return res.status(400).json({ ok: false, error: 'нет БД — версии недоступны' });
  const cur = stateLoadJson();
  if (!cur) return res.status(400).json({ ok: false, error: 'нет сохранённого состояния' });
  const label = (req.body && req.body.label ? String(req.body.label) : '').trim() || 'без названия';
  const id = snapshotSave(cur, label, 'manual');
  res.json({ ok: true, id, snapshots: snapshotList() });
});
// восстановить состояние из версии (перед этим — авто-снимок текущего, чтобы откат был обратим)
app.post('/api/state/snapshots/:id/restore', requireEdit('data'), (req, res) => {
  if (!dbAvailable()) return res.status(400).json({ ok: false, error: 'нет БД — версии недоступны' });
  const json = snapshotGet(+req.params.id);
  if (!json) return res.status(404).json({ ok: false, error: 'версия не найдена' });
  try {
    const cur = stateLoadJson(); if (cur) snapshotSave(cur, 'перед восстановлением', 'auto');
    snapshotPrune(20);
    const norm = saveState(normalizeState(JSON.parse(json)));
    res.json({ ok: true, state: req.perms ? filterStateForRead(norm, req.perms) : norm });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// удалить версию
app.delete('/api/state/snapshots/:id', requireEdit('data'), (req, res) => {
  if (!dbAvailable()) return res.status(400).json({ ok: false, error: 'нет БД' });
  snapshotDelete(+req.params.id);
  res.json({ ok: true, snapshots: snapshotList() });
});

// ответственные (цех × роль → пользователь) + лёгкий список пользователей для выбора
app.get('/api/responsibles', requireView('data'), (req, res) => {
  const users = userList().map((u) => ({ telegramId: u.telegramId, name: u.name || u.username || String(u.telegramId), username: u.username || '' }));
  res.json({ ok: true, responsibles: responsibleList(), users, roles: PARTIA_ROLES });
});
app.put('/api/responsibles', requireEdit('data'), (req, res) => {
  const { workshopId, role, telegramId } = req.body || {};
  if (!workshopId || !role) return res.status(400).json({ ok: false, error: 'workshopId и role обязательны' });
  responsibleSet(workshopId, role, telegramId === '' || telegramId == null ? null : telegramId);
  res.json({ ok: true, responsibles: responsibleList() });
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

// «спасатель сроков» (3b): предложения по спасению партий, срывающих дедлайн
app.post('/api/rescue', (req, res) => {
  try {
    const state = req.body && req.body.articles ? normalizeState(req.body) : loadState();
    res.json({ ok: true, proposals: findRescues(state) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.stack || e) });
  }
});

// сохранить ручную правку блока (перетаскивание на Ганте) и вернуть пересчёт
app.post('/api/override', requireEdit('gantt'), (req, res) => {
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

// пер-батчевые пины Ганта (перенос блока на другой цех и/или дату; результат «Уплотнить»).
// Ключ — стабильный `partiaId#batchIndex`, значение { ws?, cut? }.
//  - одиночный:  { batchKey, ws?, cut? }         — установить/обновить пин батча
//  - сбросить:   { batchKey, clear:true }        — снять пин батча
//  - массово:    { pins:{k:{ws,cut},...} }        — слить набор пинов (для «Уплотнить»)
//  - снять всё:  { clearAll:true }                — очистить все пины
app.post('/api/pin', requireEdit('gantt'), (req, res) => {
  try {
    const { batchKey, ws, cut, clear, clearAll, pins } = req.body || {};
    const state = loadState();
    state.batchPins = state.batchPins || {};
    // одиночный перенос батча в другой цех — до применения пина запомним артикул и ИСХОДНЫЙ цех
    // (по текущему расписанию), чтобы потом авто-синхронизировать галочки «Кто шьёт».
    const singleWsMove = !!(batchKey && ws && !clear && !clearAll && !pins);
    let moveArticle = null, sourceWs = null;
    if (singleWsMove) {
      const before = buildSchedule(state).cycles.find((c) => c.batchKey === batchKey);
      if (before) { moveArticle = before.articleId; sourceWs = before.workshopId; }
    }
    if (clearAll) {
      state.batchPins = {};
      for (const p of state.partias || []) p.jitStart = ''; // «Сбросить раскладку» снимает и экономную раскладку (jitStart)
    } else if (pins && typeof pins === 'object') {
      for (const k of Object.keys(pins)) {
        const v = pins[k] || {};
        const cur = { ...(state.batchPins[k] || {}) };
        if (v.ws) cur.ws = v.ws; if (v.cut) cur.cut = v.cut;
        if (cur.ws || cur.cut) state.batchPins[k] = cur;
      }
    } else if (batchKey) {
      if (clear) delete state.batchPins[batchKey];
      else {
        const cur = { ...(state.batchPins[batchKey] || {}) };
        if (ws) cur.ws = ws; if (cut) cur.cut = cut;
        state.batchPins[batchKey] = cur;
      }
    }
    let norm = saveState(state);
    let schedule = buildSchedule(norm);
    // Авто-синхронизация «Кто шьёт этот артикул» при переносе блока в другой цех.
    // Зеркалим галочки на РЕАЛЬНОЕ размещение блоков: цех с блоками — отмечен, без блоков — снят.
    // Трогаем только артикул с ЯВНЫМ списком цехов; «любой цех» ([]) оставляем гибким.
    // Чтобы перетаскивание ОДНОГО блока не утащило следом другие батчи этого артикула (каскад при
    // расширении списка цехов), сперва «замораживаем» распределение прочих батчей — цех-пин на их
    // текущий цех (без даты, дата считается автоматически). Так двигается только тот блок, что тянул
    // пользователь, а галочки точно отражают, где что шьётся.
    if (singleWsMove && moveArticle && ws !== sourceWs) {
      const a = norm.articles.find((x) => x.id === moveArticle);
      if (a && Array.isArray(a.allowedWorkshops) && a.allowedWorkshops.length) {
        norm.batchPins = norm.batchPins || {};
        // 1) заморозить прочие батчи этого артикула на их текущих цехах (не трогаем уже пиненные по цеху)
        for (const c of schedule.cycles) {
          if (c.historical || c.articleId !== moveArticle) continue;
          const ex = norm.batchPins[c.batchKey];
          if (!ex || !ex.ws) norm.batchPins[c.batchKey] = { ...(ex || {}), ws: c.workshopId };
        }
        // 2) зеркалим allowedWorkshops = цеха, где реально есть блоки этого артикула
        const wsWith = new Set(schedule.cycles.filter((c) => !c.historical && c.articleId === moveArticle).map((c) => c.workshopId));
        const sewIds = norm.workshops.filter((w) => (w.capacities && w.capacities.sew) > 0).map((w) => w.id);
        a.allowedWorkshops = (sewIds.length && sewIds.every((id) => wsWith.has(id))) ? [] : [...wsWith]; // все шьющие → [] («любой»)
        norm = saveState(norm);
        schedule = buildSchedule(norm);
      }
    }
    res.json({ ok: true, schedule, state: norm });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// «Экономная раскладка (JIT)»: пересобрать даты старта пошива под оборачиваемость денег.
//  - preview (apply≠true): вернуть метрики «до/после» и пины БЕЗ сохранения (для окна подтверждения);
//  - apply=true: наложить пины (слить в state.batchPins), пересчитать, вернуть schedule+state.
// opts: { deliveryBufferDays, nonSummerCushionDays, summerFinishMMDD, minimizeWorkshops, groupByArticle, summerIds }
app.post('/api/jit-layout', requireEdit('gantt'), (req, res) => {
  try {
    const { apply, reset, opts } = req.body || {};
    const state = loadState();
    if (reset) { // снять экономную раскладку: очистить jitStart у всех партий + ws-пины
      for (const p of state.partias || []) p.jitStart = '';
      state.batchPins = {};
      const norm = saveState(state);
      return res.json({ ok: true, reset: true, schedule: buildSchedule(norm), state: norm });
    }
    const { jitStarts, wsPins, before, after, note } = computeJitLayout(state, opts || {});
    if (!apply) { return res.json({ ok: true, preview: true, before, after, note }); }
    // применяем: пол jitStart по партиям (аддитивно, ручной earliestStart не трогаем) + ws-пины (без дат)
    for (const p of state.partias || []) p.jitStart = (jitStarts[p.id] !== undefined) ? jitStarts[p.id] : '';
    state.batchPins = state.batchPins || {};
    for (const k in wsPins) state.batchPins[k] = { ...(state.batchPins[k] || {}), ws: wsPins[k].ws };
    const norm = saveState(state);
    res.json({ ok: true, applied: true, before, after, note, schedule: buildSchedule(norm), state: norm });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.stack || e.message || e) });
  }
});

// загрузка образца ткани: принимает data:-URL, пишет файл, возвращает путь /samples/<файл>
app.post('/api/sample', requireEdit('fabric'), (req, res) => {
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
  let extra = {};
  try { extra = budgetStatus(req.query.path || null); } catch { /* без БД — без бюджета */ }
  res.json({ ok: true, hasToken: !!process.env.MPSTATS_TOKEN, ...extra });
});
// ── Токен MPStats из интерфейса (шапка → ⚙). Хранится в БД, переопределяет .env ──
app.get('/api/settings/mpstats', requireView('season'), (req, res) => res.json({ ok: true, ...mpstatsTokenStatus() }));
app.put('/api/settings/mpstats', requireEdit('season'), (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token || token.length < 8) return res.status(400).json({ ok: false, error: 'Пустой или слишком короткий токен' });
  try { metaSet('mpstats_token', token); } catch (e) { return res.status(500).json({ ok: false, error: 'БД недоступна, токен не сохранён: ' + String(e.message || e) }); }
  process.env.MPSTATS_TOKEN = token; // сразу подхватят все клиенты (читают process.env при вызове)
  res.json({ ok: true, ...mpstatsTokenStatus() });
});
app.delete('/api/settings/mpstats', requireEdit('season'), (req, res) => {
  try { metaSet('mpstats_token', ''); } catch { /* ignore */ }
  process.env.MPSTATS_TOKEN = ENV_MPSTATS_TOKEN; // вернуть исходный из .env (или пусто)
  res.json({ ok: true, ...mpstatsTokenStatus() });
});
// фразы предмета (category/by_keywords) для выбора галочками; кэш в БД на 7 дней
app.post('/api/season/phrases', requireView('season'), async (req, res) => {
  try {
    const cfg = req.body || {};
    if (!cfg.path) return res.status(400).json({ ok: false, error: 'не указан путь предмета' });
    res.json({ ok: true, ...(await getSubjectPhrases(cfg)) });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// подсказка пути предмета по слову
app.get('/api/season/categories', requireView('season'), async (req, res) => {
  try { res.json({ ok: true, paths: await searchCategories(req.query.q || '', 40) }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// словарь признаков предмета (характеристики по группам + частые слова), кэш по path
app.get('/api/season/features', requireView('season'), async (req, res) => {
  try { res.json({ ok: true, dict: await getFeatureDict({ path: req.query.path, force: req.query.force === '1', sample: req.query.sample }) }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// список сохранённых планов (краткий индекс)
app.get('/api/season/plans', requireView('season'), (req, res) => {
  try { res.json({ ok: true, plans: listPlans() }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// один план целиком
app.get('/api/season/plan', requireView('season'), (req, res) => {
  const rec = loadPlan(req.query.articleId || '');
  if (!rec) return res.status(404).json({ ok: false, error: 'план не найден' });
  res.json({ ok: true, ...rec });
});
// удалить сохранённый план
app.delete('/api/season/plan', requireEdit('season'), (req, res) => {
  res.json({ ok: true, deleted: deletePlan((req.query.articleId) || (req.body && req.body.articleId) || '') });
});
// ТОП-20 «неопределённых» на ручную проверку (сбор + фильтр, без построения плана)
app.post('/api/season/candidates', requireEdit('season'), async (req, res) => {
  try {
    const cfg = req.body || {};
    res.json({ ok: true, ...(await runCandidates(cfg)) });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// построить прогноз по фильтру артикула и сохранить (это сетевой вызов к MPStats, ~секунды)
app.post('/api/season/build', requireEdit('season'), async (req, res) => {
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

// Остатки/поставки: тянем опубликованный Google-CSV по ссылке (обходим CORS браузера)
app.get('/api/supply/csv', requireView('season'), async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!/^https:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Нужна https-ссылка на опубликованный CSV (Файл → Опубликовать в интернете → CSV).' });
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(400).json({ ok: false, error: `Не удалось получить CSV: HTTP ${r.status}` });
    const text = await r.text();
    if (/<html/i.test(text.slice(0, 500))) return res.status(400).json({ ok: false, error: 'По ссылке вернулся HTML, а не CSV. Проверь, что таблица опубликована именно как CSV и доступна по ссылке.' });
    res.json({ ok: true, text });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// Автоподтяжка остатков WB (FBW) в предложение: по nmID → imtID → цвета → остатки по складам.
// Доступный остаток = quantity + inWayFromClient + inWayToClient×(1 − выкуп%). buyoutPct настраиваемый.
app.post('/api/supply/wb-pull', requireEdit('season'), async (req, res) => {
  try {
    if (!hasWbToken()) return res.status(400).json({ ok: false, error: 'WB-токен не задан в окружении службы (WB_API_TOKEN).' });
    const items = Array.isArray(req.body && req.body.items) ? req.body.items.filter((x) => x && x.articleId && (x.key || x.nmID)) : [];
    if (!items.length) return res.status(400).json({ ok: false, error: 'Нет артикулов с привязкой WB. Впиши на вкладке «Остатки и поставки» nmID или артикул продавца (напр. 023_рвп).' });
    const bp = +(req.body && req.body.buyoutPct);
    const out = await buildWbSupply({ items, buyoutPct: Number.isFinite(bp) ? bp : 37, force: !!(req.body && req.body.force) });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// Список артикулов продавца (префиксы vendorCode) — помощь в подборе «Ключа WB».
app.get('/api/supply/wb-vendors', requireView('season'), async (req, res) => {
  try {
    if (!hasWbToken()) return res.status(400).json({ ok: false, error: 'WB-токен не задан.' });
    res.json({ ok: true, ...(await listVendorPrefixes({ force: req.query.force === '1' })) });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// ── Wildberries API: карточки (маппинг+габариты) и логистика по тарифам ──
app.get('/api/wb/status', (req, res) => res.json({ ok: true, hasToken: hasWbToken() }));
// список карточек продавца для пикера «Артикул WB» (nmID/vendorCode/объём), кэш сутки
app.get('/api/wb/cards', requireView('unit'), async (req, res) => {
  try { res.json({ ok: true, cards: await fetchCards({ force: req.query.force === '1' }) }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
// логистика/хранение для артикула (по nmID или объёму) на складе (Коледино по умолчанию)
app.get('/api/wb/logistics', requireView('unit'), async (req, res) => {
  try {
    const warehouse = req.query.warehouse || 'Коледино';
    const days = req.query.days != null ? +req.query.days : 60;
    const ret = req.query.return != null ? +req.query.return : 50;
    let volumeL = req.query.volumeL != null ? +req.query.volumeL : null;
    let card = null;
    if (volumeL == null && req.query.nmID) {
      const cards = await fetchCards({});
      card = cards.find((c) => String(c.nmID) === String(req.query.nmID)) || null;
      volumeL = card ? card.volumeL : null;
    }
    const tar = await fetchBoxTariffs({ force: req.query.force === '1' });
    const wh = findWarehouse(tar, warehouse);
    const logistics = computeWbLogistics(volumeL, wh, { storageDays: days, returnLogistics: ret });
    res.json({ ok: true, warehouse: wh && wh.warehouseName, tariffDate: tar.date, volumeL, card, logistics });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'planner', backendBuild: BACKEND_BUILD }));

// Авто-снимок состояния при старте сервера — точка возврата ДО любых правок этой сессии
// (в т.ч. после обновления кода). Ротация: держим последние 20 авто-снимков; ручные не трогаем.
function snapshotOnBoot() {
  try {
    if (!dbAvailable()) return;
    const cur = stateLoadJson();
    if (cur && cur.length > 2) { snapshotSave(cur, `старт сервера · ${BACKEND_BUILD}`, 'auto'); snapshotPrune(20); }
  } catch { /* снимок не критичен для загрузки */ }
}

app.listen(PORT, HOST, () => {
  console.log(`[planner] backend build: ${BACKEND_BUILD}`);
  console.log(`[planner] слушает ${HOST}:${PORT}`);
  console.log(`[planner] локально: http://localhost:${PORT}`);
  snapshotOnBoot();
});
