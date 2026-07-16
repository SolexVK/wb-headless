// planner/server.js — веб-сервер инструмента планирования производства.
// Отдаёт SPA из public/ и REST API для состояния и расчёта расписания.

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { defaultState, normalizeState } from './lib/model.js';
import { buildSchedule } from './lib/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = process.env.PLANNER_PORT || 8090;
const HOST = process.env.PLANNER_HOST || '0.0.0.0'; // слушать все интерфейсы (доступ по сети)

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState(), null, 2));
  }
}
function loadState() {
  ensureData();
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    return defaultState();
  }
}
function saveState(state) {
  ensureData();
  const norm = normalizeState(state);
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

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'planner' }));

app.listen(PORT, HOST, () => {
  console.log(`[planner] слушает ${HOST}:${PORT}`);
  console.log(`[planner] локально: http://localhost:${PORT}`);
});
