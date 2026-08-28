// planner/lib/nlq.js — «умный» разбор запроса на естественном языке в структурный фильтр отчёта.
// Нейросеть (Anthropic Claude) НЕ исполняет код и НЕ строит отчёт: она только переводит фразу
// пользователя («товары к закупу по ткани Муслин первого этапа в Китае») в JSON-фильтр из
// разрешённого набора значений. Дальше отчёт строится детерминированным конвейером на клиенте.
//
// Два режима работы (выбираются автоматически):
//   1) 'api'  — прямой вызов Messages API по ключу ANTHROPIC_API_KEY (оплата по токенам);
//   2) 'cli'  — вызов локального Claude Code (`claude -p …`) — РАБОТАЕТ ПО ПОДПИСКЕ Pro/Max,
//               без API-ключа и без оплаты за токены (в рамках лимитов подписки).
// Приоритет: если задан ключ — 'api'; иначе если рядом залогинен `claude` — 'cli'; иначе выкл.

import { spawn } from 'child_process';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
// Для API-режима нужен полный id модели. Для CLI-режима модель можно не указывать —
// Claude Code сам возьмёт модель подписки; при желании задаётся тем же ANTHROPIC_MODEL.
const DEFAULT_API_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// ── определение доступности CLI (Claude Code) ──
// Пробуем `claude --version` один раз при старте (server.js вызывает probeCli()).
export const cliInfo = { available: false, version: '', path: '', checkedAt: 0 };
function cliBin() { return (process.env.CLAUDE_CLI_PATH || 'claude'); }

export function probeCli() {
  return new Promise((resolve) => {
    const bin = cliBin();
    let out = '', done = false;
    let child;
    try { child = spawn(bin, ['--version'], { env: process.env }); }
    catch { cliInfo.available = false; cliInfo.checkedAt = Date.now(); return resolve(cliInfo); }
    const finish = (ok, ver) => {
      if (done) return; done = true;
      cliInfo.available = !!ok; cliInfo.version = ver || ''; cliInfo.path = bin; cliInfo.checkedAt = Date.now();
      resolve(cliInfo);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(false, ''); }, 5000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(false, ''); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0, out.trim().split('\n')[0] || ''); });
  });
}

export function apiEnabled() { return !!(process.env.ANTHROPIC_API_KEY || '').trim(); }
export function cliEnabled() { return !!(cliInfo.available || process.env.CLAUDE_CLI_PATH); }
export function activeMode() { return apiEnabled() ? 'api' : (cliEnabled() ? 'cli' : 'none'); }
export function isEnabled() { return apiEnabled() || cliEnabled(); }
export function status() {
  return {
    enabled: isEnabled(), mode: activeMode(),
    api: apiEnabled(),
    cli: { available: cliEnabled(), version: cliInfo.version || '' },
  };
}

// Инструмент структурированного вывода (API-режим) — модель обязана вернуть именно такой объект.
const FILTER_TOOL = {
  name: 'set_report_filter',
  description: 'Установить фильтр отчёта по ткани на основе запроса пользователя.',
  input_schema: {
    type: 'object',
    properties: {
      plansheets: { type: 'array', items: { type: 'string' }, description: 'Номера планшетов из разрешённого списка.' },
      articleIds: { type: 'array', items: { type: 'string' }, description: 'ID артикулов из разрешённого списка.' },
      months: { type: 'array', items: { type: 'string' }, description: 'Месяцы в формате YYYY-MM из разрешённого списка.' },
      sources: { type: 'array', items: { type: 'string', enum: ['china', 'bishkek'] }, description: 'Источник закупа: china = Китай, bishkek = Бишкек/Мадина.' },
      seasons: { type: 'array', items: { type: 'string', enum: ['summer', 'demi'] }, description: 'Сезон ткани: summer = лето (муслин/марлёвка), demi = демисезон.' },
      text: { type: 'string', description: 'Свободный текст для подстрочного поиска (тип ткани, цвет и т.п.), если его нельзя выразить полями выше. Иначе пустая строка.' },
      explain: { type: 'string', description: 'Короткое (до 12 слов) описание применённого фильтра по-русски.' },
    },
    required: ['explain'],
  },
};

function buildSystem(dims, reportKind) {
  const list = (arr, f) => (arr || []).map(f).join('\n') || '  (нет)';
  const months = list(dims.months, (m) => `  - ${m.ym} (${m.label})`);
  const arts = list(dims.articles, (a) => `  - ${a.id}${a.name ? ' — ' + a.name : ''}`);
  const plans = (dims.plansheets || []).join(', ') || '(нет)';
  const monthMeaning = reportKind === 'r2b' ? 'месяц ЗАКУПА ткани' : 'месяц ПРОИЗВОДСТВА';
  return `Ты — помощник, который переводит запрос пользователя о производстве одежды в структурный фильтр отчёта по ткани.

Правила:
- Используй ТОЛЬКО значения из разрешённых списков ниже. Если пользователь называет то, чего нет в списках, — не выдумывай ID, а положи слово в поле text.
- Массив можно оставить пустым (пустой = «все»).
- «Муслин», «марлёвка», «муслин/марлёвка», «летние ткани» → seasons: ["summer"]. «Демисезон», «зимние/осенние ткани» → seasons: ["demi"].
- «в Китае», «китайская закупка» → sources: ["china"]. «на Мадине», «в Бишкеке», «Мадина» → sources: ["bishkek"].
- Конкретное название ткани («Муслин», «Кулирка», цвет) без явного поля клади в text.
- «первый этап/транш закупа», «второй этап» относятся к летним тканям — если это нельзя выразить месяцем из списка, добавь фразу в text.
- months — это ${monthMeaning}, формат YYYY-MM.
- explain — короткая фраза, что именно ты отфильтровал.

Разрешённые планшеты: ${plans}

Разрешённые артикулы:
${arts}

Разрешённые месяцы (${monthMeaning}):
${months}`;
}

// Приводим «сырой» разбор (из tool_use или из JSON, выданного CLI) к валидному фильтру.
function validateFilter(inp, dimensions) {
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const okPlan = new Set((dimensions.plansheets || []).map(String));
  const okArt = new Set((dimensions.articles || []).map((a) => String(a.id)));
  const okMon = new Set((dimensions.months || []).map((m) => String(m.ym)));
  return {
    plansheets: arr(inp.plansheets).filter((v) => okPlan.has(v)),
    articleIds: arr(inp.articleIds).filter((v) => okArt.has(v)),
    months: arr(inp.months).filter((v) => okMon.has(v)),
    sources: arr(inp.sources).filter((v) => v === 'china' || v === 'bishkek'),
    seasons: arr(inp.seasons).filter((v) => v === 'summer' || v === 'demi'),
    text: typeof inp.text === 'string' ? inp.text.trim().slice(0, 120) : '',
  };
}

// Вытащить JSON-объект из текста (возможны Markdown-ограждения или лишние строки вокруг).
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

// ── режим API (по ключу) ──
async function parseViaApi(query, dimensions, reportKind) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  const body = {
    model: DEFAULT_API_MODEL,
    max_tokens: 512,
    system: buildSystem(dimensions, reportKind),
    tools: [FILTER_TOOL],
    tool_choice: { type: 'tool', name: 'set_report_filter' },
    messages: [{ role: 'user', content: String(query || '').slice(0, 2000) }],
  };
  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { return { ok: false, reason: 'network', detail: String((e && e.message) || e) }; }
  if (!resp.ok) {
    let detail = ''; try { detail = await resp.text(); } catch { /* ignore */ }
    return { ok: false, reason: 'api_error', status: resp.status, detail: detail.slice(0, 300) };
  }
  let data; try { data = await resp.json(); } catch { return { ok: false, reason: 'bad_json' }; }
  const tu = (data.content || []).find((c) => c.type === 'tool_use');
  if (!tu || !tu.input) return { ok: false, reason: 'no_tool_use' };
  return { ok: true, filter: validateFilter(tu.input, dimensions), explain: String(tu.input.explain || '').slice(0, 160), mode: 'api', model: DEFAULT_API_MODEL };
}

// ── режим CLI (по подписке через Claude Code) ──
async function parseViaCli(query, dimensions, reportKind) {
  const sys = buildSystem(dimensions, reportKind)
    + '\n\nВыведи ТОЛЬКО один JSON-объект с полями: plansheets, articleIds, months, sources, seasons (массивы строк), text (строка), explain (строка). Без пояснений и без Markdown-ограждения.';
  const args = ['-p', String(query || '').slice(0, 2000), '--output-format', 'json', '--append-system-prompt', sys];
  if (process.env.ANTHROPIC_MODEL) args.push('--model', process.env.ANTHROPIC_MODEL);
  return await new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    try { child = spawn(cliBin(), args, { env: process.env }); }
    catch (e) { return resolve({ ok: false, reason: 'no_cli', detail: String((e && e.message) || e) }); }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish({ ok: false, reason: 'timeout' }); }, 30000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, reason: e && e.code === 'ENOENT' ? 'no_cli' : 'spawn_error', detail: String((e && e.message) || e) }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, reason: 'cli_error', status: code, detail: (err || out).slice(0, 300) });
      let env; try { env = JSON.parse(out); } catch { return finish({ ok: false, reason: 'bad_envelope', detail: out.slice(0, 200) }); }
      if (env && env.is_error) return finish({ ok: false, reason: 'cli_error', detail: String(env.result || '').slice(0, 300) });
      const parsed = extractJson(typeof env.result === 'string' ? env.result : '');
      if (!parsed) return finish({ ok: false, reason: 'bad_json', detail: String(env.result || '').slice(0, 200) });
      finish({ ok: true, filter: validateFilter(parsed, dimensions), explain: String(parsed.explain || '').slice(0, 160), mode: 'cli' });
    });
  });
}

// Разобрать запрос. Возвращает {ok, filter, explain, mode} либо {ok:false, reason}.
export async function parseQuery(query, dimensions = {}, reportKind = 'r2b') {
  if (apiEnabled()) return parseViaApi(query, dimensions, reportKind);
  if (cliEnabled()) return parseViaCli(query, dimensions, reportKind);
  return { ok: false, reason: 'no_key' };
}
