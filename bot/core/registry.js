// bot/core/registry.js — реестр скиллов бота.
//
// Источник правды для меню и формы — файлы bot/skills/*.manifest.js. Манифест
// описывает: человекочитаемое имя, схему полей (что спрашивать у пользователя),
// шаги выполнения (CLI/Claude + mid-flow интеракции), форматы вывода и ключи кэша.
//
// Добавить скилл = положить манифест в bot/skills/. Ядро бота не меняется.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(__dirname, '..', 'skills');

const FIELD_TYPES = new Set(['text', 'number', 'choice', 'multichoice', 'boolean', 'date-range']);
const STEP_INTERACTIONS = new Set(['pick-list', 'confirm-dry-run', 'creds-refresh']);
const EXECUTORS = new Set(['cli', 'claude']);

/**
 * Проверяет манифест. Возвращает массив ошибок (пустой = валиден).
 */
export function validateManifest(m, { file } = {}) {
  const at = file ? ` (${file})` : '';
  if (!m || typeof m !== 'object') return [`манифест пуст или не объект${at}`];
  const errs = [];
  if (!m.id) errs.push(`нет id${at}`);
  if (!m.title) errs.push(`нет title${at}`);

  if (!Array.isArray(m.fields)) {
    errs.push(`fields должен быть массивом${at}`);
  } else {
    const seen = new Set();
    m.fields.forEach((f, i) => {
      const tag = `fields[${i}]${f && f.key ? ` (${f.key})` : ''}`;
      if (!f || !f.key) errs.push(`${tag}: нет key${at}`);
      else if (seen.has(f.key)) errs.push(`${tag}: дубликат key${at}`);
      else seen.add(f.key);
      if (!FIELD_TYPES.has(f?.type)) errs.push(`${tag}: неизвестный type "${f?.type}"${at}`);
      if ((f?.type === 'choice' || f?.type === 'multichoice') && !Array.isArray(f.options))
        errs.push(`${tag}: type ${f.type} требует options[]${at}`);
      if (f?.showIf !== undefined && typeof f.showIf !== 'function')
        errs.push(`${tag}: showIf должен быть функцией${at}`);
    });
  }

  if (m.formats !== undefined && !Array.isArray(m.formats)) errs.push(`formats должен быть массивом${at}`);

  if (m.steps !== undefined) {
    if (!Array.isArray(m.steps)) errs.push(`steps должен быть массивом${at}`);
    else
      m.steps.forEach((s, i) => {
        const tag = `steps[${i}]${s && s.id ? ` (${s.id})` : ''}`;
        if (s?.executor && !EXECUTORS.has(s.executor)) errs.push(`${tag}: неизвестный executor "${s.executor}"${at}`);
        if (s?.interaction && !STEP_INTERACTIONS.has(s.interaction))
          errs.push(`${tag}: неизвестная interaction "${s.interaction}"${at}`);
        if (s?.buildArgv !== undefined && typeof s.buildArgv !== 'function')
          errs.push(`${tag}: buildArgv должен быть функцией${at}`);
      });
  }

  if (m.cache !== undefined) {
    if (!m.cache.source) errs.push(`cache.source не задан${at}`);
    if (m.cache.key !== undefined && typeof m.cache.key !== 'function') errs.push(`cache.key должен быть функцией${at}`);
  }

  return errs;
}

/**
 * Загружает все манифесты из dir в Map по id. Бросает, если есть ошибки или
 * дубликаты id — реестр не должен подниматься наполовину валидным.
 */
export async function loadRegistry(dir = SKILLS_DIR) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.js')).sort() : [];
  const map = new Map();
  const errors = [];
  for (const file of files) {
    let m;
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      m = mod.default;
    } catch (e) {
      errors.push(`не удалось импортировать ${file}: ${e.message}`);
      continue;
    }
    const errs = validateManifest(m, { file });
    if (errs.length) {
      errors.push(...errs);
      continue;
    }
    if (map.has(m.id)) {
      errors.push(`дубликат id "${m.id}" (${file})`);
      continue;
    }
    map.set(m.id, m);
  }
  if (errors.length) throw new Error('Ошибки манифестов:\n - ' + errors.join('\n - '));
  return map;
}

// ─────────────── помощники для FSM/меню ───────────────

/** Пункты меню: {id, title, description}. Скрывает adminOnly для не-админов. */
export function menuItems(registry, { isAdmin = false } = {}) {
  return [...registry.values()]
    .filter((m) => isAdmin || !m.adminOnly)
    .map((m) => ({ id: m.id, title: m.title, description: m.description || '' }));
}

/** Видимые поля при текущих params (учитывает showIf). */
export function visibleFields(manifest, params = {}) {
  return manifest.fields.filter((f) => typeof f.showIf !== 'function' || f.showIf(params));
}

/** Разбиение видимых полей: обязательные / необязательные / дополнительные (⚙). */
export function formPlan(manifest, params = {}) {
  const vis = visibleFields(manifest, params);
  return {
    required: vis.filter((f) => f.required && !f.advanced),
    optional: vis.filter((f) => !f.required && !f.advanced),
    advanced: vis.filter((f) => f.advanced),
  };
}

const isEmpty = (v) => v === undefined || v === null || v === '';

/** Ключи ещё не заполненных обязательных полей — что FSM должна спросить дальше. */
export function missingRequired(manifest, params = {}) {
  return visibleFields(manifest, params)
    .filter((f) => f.required && isEmpty(params[f.key]))
    .map((f) => f.key);
}

/** Применяет дефолты манифеста к params (не перезатирая заданное). */
export function withDefaults(manifest, params = {}) {
  const out = { ...params };
  for (const f of manifest.fields) {
    if (f.default !== undefined && isEmpty(out[f.key])) out[f.key] = f.default;
  }
  return out;
}
