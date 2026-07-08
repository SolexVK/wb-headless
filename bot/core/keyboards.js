// bot/core/keyboards.js — сборка инлайн-клавиатур из манифеста/flow.
//
// Формат callback_data (компактно, ≤64 байт): 'action:key:value'.
//   menu:<skillId>        — выбрать скилл
//   set:<key>:<value>     — задать значение choice/boolean поля
//   advf:<key>            — настроить дополнительное поле
//   adv:cfg | adv:skip | adv:done
//   cfm:run | cfm:edit | cfm:cancel
//   nav:menu

import { InlineKeyboard } from 'grammy';
import { formPlan } from './registry.js';

/** Меню скиллов: по кнопке на скилл. */
export function menuKeyboard(items) {
  const kb = new InlineKeyboard();
  for (const it of items) kb.text(it.title, `menu:${it.id}`).row();
  return kb;
}

/** Клавиатура выбора значения для choice-поля. */
export function choiceKeyboard(field) {
  const kb = new InlineKeyboard();
  (field.options || []).forEach((o, i) => {
    kb.text(o.label, `set:${field.key}:${o.value}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  return kb;
}

/** Клавиатура да/нет для boolean-поля. */
export function booleanKeyboard(field) {
  return new InlineKeyboard()
    .text('Да', `set:${field.key}:1`)
    .text('Нет', `set:${field.key}:0`);
}

/** Предложение настроить дополнительные фильтры или пропустить. */
export function advancedOfferKeyboard() {
  return new InlineKeyboard()
    .text('⚙ Настроить фильтры', 'adv:cfg')
    .row()
    .text('Пропустить →', 'adv:skip');
}

/** Меню дополнительных полей: по кнопке на поле (с текущим значением) + Готово. */
export function advancedMenuKeyboard(manifest, flow) {
  const kb = new InlineKeyboard();
  for (const f of formPlan(manifest, flow.params).advanced) {
    const v = flow.params[f.key];
    const shown = v === undefined || v === null || v === '' ? '—' : formatVal(f, v);
    kb.text(`${f.label}: ${shown}`, `advf:${f.key}`).row();
  }
  kb.text('✅ Готово', 'adv:done');
  return kb;
}

/** Подтверждение запуска. */
export function confirmKeyboard() {
  return new InlineKeyboard()
    .text('🚀 Запустить', 'cfm:run')
    .row()
    .text('✏️ Изменить', 'cfm:edit')
    .text('✖ Отмена', 'cfm:cancel');
}

/** Клавиатура действий над готовым прогоном: форматы отчёта + выбор конкурентов. */
export function resultActionsKeyboard(runId, formats = ['html', 'pdf', 'xlsx'], { withPick = true } = {}) {
  const kb = new InlineKeyboard();
  const labels = { html: '📄 HTML', pdf: '📑 PDF', xlsx: '📊 XLSX' };
  formats.forEach((f) => kb.text(labels[f] || f, `fmt:${runId}:${f}`));
  kb.row();
  if (withPick) kb.text('🎯 Выбрать конкурентов (2–4)', `pick:${runId}`);
  return kb;
}

/**
 * Пикер конкурентов: страница тумблеров ⬜/✅ + пагинация + Готово(N).
 * @param {Set<string>} selected — выбранные nmId (строки)
 */
export function pickKeyboard(runId, rivals, selected, page = 0, { pageSize = 8 } = {}) {
  const kb = new InlineKeyboard();
  const pages = Math.max(1, Math.ceil(rivals.length / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  const start = p * pageSize;
  rivals.slice(start, start + pageSize).forEach((r, i) => {
    const idx = start + i;
    const on = selected.has(String(r.nmId));
    const label = `${on ? '✅' : '⬜'} ${idx + 1}. ${String(r.brand || '—').slice(0, 18)} · ${r.price}₽`;
    kb.text(label, `pkt:${runId}:${idx}`).row();
  });
  if (pages > 1) {
    kb.text(p > 0 ? '◀' : ' ', p > 0 ? `pkpg:${runId}:${p - 1}` : 'noop')
      .text(`${p + 1}/${pages}`, 'noop')
      .text(p < pages - 1 ? '▶' : ' ', p < pages - 1 ? `pkpg:${runId}:${p + 1}` : 'noop')
      .row();
  }
  kb.text(`✅ Готово (${selected.size})`, `pkok:${runId}`);
  return kb;
}

function formatVal(field, v) {
  if (field.type === 'boolean') return v ? 'да' : 'нет';
  if (field.type === 'choice') {
    const opt = (field.options || []).find((o) => String(o.value) === String(v));
    return opt ? opt.label : String(v);
  }
  return String(v);
}
