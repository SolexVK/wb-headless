// lib/visualScore.js — детерминированный скоринг карточки против эталона.
//
// Модель зрения сюда не попадает. На вход приходят уже готовые значения
// признаков (закрытые enum'ы), на выход — балл, корзина и построчное
// объяснение. Один и тот же вход всегда даёт один и тот же балл.

import { TARGET, FROM_TEXT } from './visualProfile.js';

const UNKNOWN = 'unknown';

// Ответы, которые модель выдаёт вместо «не разобрал». Замерено на размеченном
// наборе: cuff='folded' встретился четыре раза и все четыре раза неверно,
// верных `folded` не было ни одного. Засчитывать его как наблюдение — значит
// штрафовать карточку за то, что модель не разглядела манжету.
// Список пересматривать после каждой смены модели или промпта.
const UNRELIABLE = {
  cuff: ['folded'],
};

function calibrate(attr, value) {
  return UNRELIABLE[attr]?.includes(value) ? UNKNOWN : value;
}

// Модель зрения отвечает своими именами полей, профиль называет атрибуты
// по-своему. Без этого сопоставления `cuff` и `sleeve_length` молча
// превращались бы в unknown и выпадали из скоринга.
const VISION_TO_PROFILE = {
  collar: 'collar',
  sleeve_length: 'sleeves',
  cuff: 'cuffs',
  pattern: 'pattern',
  shoulder: 'shoulder',
  garment_type: 'garment_type',
  body_length: 'body_length',
  hem: 'hem',
};

/** Переименовывает ответ модели в термины профиля и калибрует значения. */
export function visionToProfile(fromVision = {}) {
  const out = {};
  for (const [visKey, value] of Object.entries(fromVision)) {
    const attr = VISION_TO_PROFILE[visKey];
    if (!attr || value == null) continue;
    out[attr] = calibrate(visKey, value);
  }
  return out;
}

/**
 * Сводит признаки из характеристик карточки и с фотографий в один набор.
 * Текст надёжнее там, где поле заполнено продавцом обязательно (состав,
 * покрой); зрение надёжнее в конструкции (воротник, низ, манжета).
 * Расхождения не прячем — они попадают в отчёт отдельным списком.
 *
 * @param {object} fromText  результат attributesFromOptions() из wbCard.js
 * @param {object} fromVision {attr: value} от модели зрения
 * @param {object} profile
 * @returns {{values: object, sources: object, conflicts: Array}}
 */
export function mergeObservations(fromText = {}, fromVision = {}, profile = TARGET) {
  // Ответ модели может прийти как в её именах полей, так и уже в терминах
  // профиля (ручная разметка в тестах) — приводим к профилю в любом случае.
  const vision = { ...visionToProfile(fromVision), ...pickProfileKeys(fromVision, profile) };
  const values = {};
  const sources = {};
  const conflicts = [];

  for (const attr of Object.keys(profile.attributes)) {
    const textVal = FROM_TEXT[attr] ? FROM_TEXT[attr](fromText) : null;
    const visVal = vision[attr] && vision[attr] !== UNKNOWN ? vision[attr] : null;

    if (textVal && visVal && textVal !== visVal) {
      conflicts.push({ attr, text: textVal, vision: visVal });
    }

    // Приоритет: для ткани и силуэта верим тексту (поля заполнены у 100 %
    // карточек и продавец описывает материал точнее, чем видно на фото),
    // для остального — зрению.
    const textWins = attr === 'fabric' || attr === 'silhouette';
    const chosen = textWins ? (textVal || visVal) : (visVal || textVal);

    values[attr] = chosen || UNKNOWN;
    sources[attr] = chosen == null ? 'none'
      : (textWins ? (textVal ? 'text' : 'vision') : (visVal ? 'vision' : 'text'));
  }
  return { values, sources, conflicts };
}

/** Значения, уже названные по-профильному, — пропускаем как есть. */
function pickProfileKeys(obj, profile) {
  const out = {};
  for (const attr of Object.keys(profile.attributes)) {
    if (obj[attr] != null) out[attr] = obj[attr];
  }
  return out;
}

/** Доля веса, которую набирает значение признака. null = признак не виден. */
function creditFor(spec, value) {
  if (value === UNKNOWN || value == null) return null;
  if (value === spec.target) return 1;
  const partial = spec.partial?.[value];
  return typeof partial === 'number' ? partial : 0;
}

/**
 * Считает балл карточки против эталона.
 *
 * @param {object} values  {attr: value} — уже сведённые наблюдения
 * @param {object} profile
 * @returns {{
 *   score:number, band:string, bandLabel:string, passedGates:boolean,
 *   failedGate:?object, lowObservability:boolean,
 *   matched:Array, mismatched:Array, unknown:Array, penalties:Array
 * }}
 */
export function scoreCard(values, profile = TARGET) {
  const matched = [];
  const mismatched = [];
  const unknown = [];
  const penalties = [];

  // ── Жёсткие гейты. unknown гейт НЕ валит: признак не виден ≠ признака нет.
  let failedGate = null;
  for (const attr of profile.gates) {
    const v = values[attr];
    if (v === UNKNOWN || v == null) continue;
    const spec = profile.attributes[attr];
    if (creditFor(spec, v) === 0) {
      failedGate = { attr, value: v, expected: spec.target };
      break;
    }
  }

  // ── Взвешенная сумма по видимым признакам.
  let earned = 0;
  let denominator = 0;
  let penaltyTotal = 0;

  for (const [attr, spec] of Object.entries(profile.attributes)) {
    const v = values[attr];
    const credit = creditFor(spec, v);

    if (credit === null) {
      unknown.push(attr);
      if (profile.unknownPolicy === 'zero') denominator += spec.weight;
      else if (profile.unknownPolicy === 'half') {
        denominator += spec.weight;
        earned += spec.weight * 0.5;
      }
      // redistribute — вес просто не попадает в знаменатель
      continue;
    }

    denominator += spec.weight;
    earned += spec.weight * credit;

    const row = { attr, value: v, weight: spec.weight, credit };
    if (credit === 1) matched.push(row);
    else mismatched.push({ ...row, expected: spec.target });

    const p = spec.penalty?.[v];
    if (p) {
      penaltyTotal += p;
      penalties.push({ attr, value: v, penalty: p });
    }
  }

  const base = denominator > 0 ? (100 * earned) / denominator : 0;
  const score = failedGate ? 0 : Math.max(0, Math.round(base - penaltyTotal));
  const band = profile.bands.find((b) => score >= b.from) || profile.bands.at(-1);

  return {
    score,
    band: failedGate ? 'gate_failed' : band.key,
    bandLabel: failedGate ? `отсев по гейту «${failedGate.attr}»` : band.label,
    passedGates: !failedGate,
    failedGate,
    lowObservability: unknown.length >= profile.lowObservabilityAt,
    matched,
    mismatched,
    unknown,
    penalties,
  };
}

/** Человекочитаемое объяснение балла — построчно, для отчёта и отладки. */
export function explain(result, profile = TARGET) {
  const lines = [];
  lines.push(`Балл ${result.score} — ${result.bandLabel}`);
  if (result.failedGate) {
    const g = result.failedGate;
    lines.push(`  гейт «${g.attr}»: ${g.value}, ожидалось ${g.expected}`);
    return lines.join('\n');
  }
  for (const m of result.matched) {
    lines.push(`  + ${m.attr.padEnd(14)} ${String(m.value).padEnd(22)} +${m.weight}`);
  }
  for (const m of result.mismatched) {
    const got = m.credit > 0 ? `+${Math.round(m.weight * m.credit)} из ${m.weight}` : `0 из ${m.weight}`;
    lines.push(`  − ${m.attr.padEnd(14)} ${String(m.value).padEnd(22)} ${got} (ожидалось ${m.expected})`);
  }
  for (const p of result.penalties) {
    lines.push(`  ! штраф ${p.attr}: ${p.value} → −${p.penalty}`);
  }
  if (result.unknown.length) {
    lines.push(`  ? не видно: ${result.unknown.join(', ')}`
      + (result.lowObservability ? '  ← низкая наблюдаемость' : ''));
  }
  return lines.join('\n');
}
