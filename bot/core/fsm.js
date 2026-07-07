// bot/core/fsm.js — машина состояний диалога сбора формы (чистая логика).
//
// Не зависит от grammY/Telegram: оперирует объектом flow и манифестом, возвращает
// «экран» (что показать) и события-редьюсеры (как изменить flow). Это позволяет
// покрыть диалог юнит-тестами без сети.
//
// flow = {
//   skill,                         -- id скилла
//   params,                        -- собранные значения
//   stage,                         -- collect | advanced_offer | advanced_menu | confirm
//   asking,                        -- null | {key, type}: ждём текстовый/числовой ввод
// }

import { missingRequired, formPlan, visibleFields, withDefaults } from './registry.js';

const fieldByKey = (m, key) => m.fields.find((f) => f.key === key);
const needsTextInput = (f) => f.type === 'text' || f.type === 'number' || f.type === 'date-range';
const advancedFields = (m, flow) => formPlan(m, flow.params).advanced;

/** Новый flow под скилл: дефолты применены, stage=collect. */
export function startFlow(manifest) {
  return { skill: manifest.id, params: withDefaults(manifest, {}), stage: 'collect', asking: null };
}

/** Что показать сейчас — чистая функция от stage+params. */
export function screenFor(manifest, flow) {
  switch (flow.stage) {
    case 'collect': {
      const miss = missingRequired(manifest, flow.params);
      return { type: 'ask', field: fieldByKey(manifest, miss[0]) };
    }
    case 'advanced_offer':
      return { type: 'advanced_offer' };
    case 'advanced_menu':
      return { type: 'advanced_menu', fields: advancedFields(manifest, flow) };
    case 'confirm':
    default:
      return { type: 'confirm', summary: summarize(manifest, flow.params) };
  }
}

/**
 * Разбор/валидация сырого ввода под тип поля.
 * @returns {{ok:true, value}|{ok:false, error}}
 */
export function coerceInput(field, raw) {
  const s = String(raw ?? '').trim();
  if (field.type === 'number') {
    const n = Number(s.replace(',', '.'));
    if (!Number.isFinite(n)) return { ok: false, error: 'Нужно число.' };
    return { ok: true, value: n };
  }
  if (field.key === 'd1' || field.key === 'd2' || field.type === 'date-range') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: 'Формат даты: YYYY-MM-DD.' };
    return { ok: true, value: s };
  }
  if (!s) return { ok: false, error: 'Пустое значение.' };
  return { ok: true, value: s };
}

/**
 * Устанавливает значение поля. Возвращает обновлённый flow.
 * В стадии collect после заполнения всех обязательных — авто-переход к advanced/confirm.
 */
export function applyValue(manifest, flow, key, value) {
  flow.params[key] = value;
  flow.asking = null;
  if (flow.stage === 'collect' && missingRequired(manifest, flow.params).length === 0) {
    flow.stage = advancedFields(manifest, flow).length > 0 ? 'advanced_offer' : 'confirm';
  }
  return flow;
}

/** Ставит поле в режим ожидания текстового/числового ввода (для ask/advanced_menu). */
export function setAsking(manifest, flow, key) {
  const f = fieldByKey(manifest, key);
  flow.asking = f && needsTextInput(f) ? { key, type: f.type } : null;
  return flow;
}

/** Событие: пользователь выбрал «настроить фильтры». */
export function configureAdvanced(flow) {
  flow.stage = 'advanced_menu';
  flow.asking = null;
  return flow;
}

/** Событие: пропустить/завершить дополнительные → к подтверждению. */
export function toConfirm(flow) {
  flow.stage = 'confirm';
  flow.asking = null;
  return flow;
}

/** Событие: вернуться к правке (с начала сбора). */
export function restartCollect(manifest, flow) {
  flow.stage = 'collect';
  flow.asking = null;
  // снимаем только НЕобязательные, чтобы обязательные пере-спросить заново? нет:
  // просто заново пройдём collect; обязательные уже заполнены → сразу advanced/confirm.
  return flow;
}

/** Человекочитаемая сводка заполненного (для экрана подтверждения). */
export function summarize(manifest, params) {
  const lines = [];
  for (const f of visibleFields(manifest, params)) {
    const v = params[f.key];
    if (v === undefined || v === null || v === '') continue;
    let shown = v;
    if (f.type === 'boolean') shown = v ? 'да' : 'нет';
    else if (f.type === 'choice') {
      const opt = (f.options || []).find((o) => String(o.value) === String(v));
      shown = opt ? opt.label : v;
    }
    lines.push({ key: f.key, label: f.label, value: shown });
  }
  return lines;
}
