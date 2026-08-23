#!/usr/bin/env node
// scripts/score-selftest.mjs — проверка скоринга на размеченном вручную наборе.
//
// Признаки взяты не от модели, а с ручного просмотра фотографий, плюс текст
// из карточки. Смысл теста — убедиться, что при заданных весах карточки
// попадают в ожидаемые корзины. Если правишь веса в visualProfile.js —
// прогони это, чтобы увидеть, куда поехали границы.
//
// Запуск: node scripts/score-selftest.mjs

import { TARGET, validateProfile } from '../lib/visualProfile.js';
import { scoreCard, explain, mergeObservations } from '../lib/visualScore.js';
import { fetchCard, attributesFromOptions } from '../lib/wbCard.js';

const problems = validateProfile();
if (problems.length) {
  console.error('Спецификация невалидна:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// Ручная разметка по фотографиям. То, чего на кадрах не видно, — unknown.
const VISION = {
  237194752: {
    label: 'марлевка оверсайз — ЦЕЛЕВАЯ', expect: 'very_close',
    v: { garment_type: 'shirt', collar: 'classic_turn_down', silhouette: 'oversize',
         fabric: 'crinkled_gauze', pattern: 'solid', hem: 'rounded_shirt_tail',
         sleeves: 'long', cuffs: 'separate_shirt_cuff', body_length: 'elongated',
         pockets: 'none', shoulder: 'soft_dropped', front_closure: 'full_button_placket' },
  },
  227781398: {
    label: 'муслин оверсайз — ЦЕЛЕВАЯ', expect: 'very_close',
    v: { garment_type: 'shirt', collar: 'classic_turn_down', silhouette: 'oversize',
         fabric: 'crinkled_gauze', pattern: 'solid', hem: 'rounded_shirt_tail',
         sleeves: 'long', cuffs: 'unknown', body_length: 'elongated',
         pockets: 'none', shoulder: 'soft_dropped', front_closure: 'full_button_placket' },
  },
  608341673: {
    label: 'атлас — конструкция совпала, ткань противоположна', expect: 'review',
    v: { garment_type: 'shirt', collar: 'classic_turn_down', silhouette: 'relaxed',
         fabric: 'satin_shiny', pattern: 'solid', hem: 'rounded_shirt_tail',
         sleeves: 'long', cuffs: 'separate_shirt_cuff', body_length: 'regular',
         pockets: 'none', shoulder: 'set_in', front_closure: 'full_button_placket' },
  },
  328892062: {
    label: 'клетка/фланель оверсайз — смежное', expect: 'adjacent',
    v: { garment_type: 'shirt', collar: 'classic_turn_down', silhouette: 'oversize',
         fabric: 'flannel', pattern: 'check', hem: 'unknown',
         sleeves: 'long', cuffs: 'unknown', body_length: 'unknown',
         pockets: 'none', shoulder: 'soft_dropped', front_closure: 'full_button_placket' },
  },
  179331048: {
    label: 'приталенная офисная — не подходит', expect: 'adjacent',
    v: { garment_type: 'shirt', collar: 'classic_turn_down', silhouette: 'fitted',
         fabric: 'smooth_matte', pattern: 'solid', hem: 'unknown',
         sleeves: 'long', cuffs: 'separate_shirt_cuff', body_length: 'unknown',
         pockets: 'none', shoulder: 'set_in', front_closure: 'full_button_placket' },
  },
  327286708: {
    label: 'блузка, стойка + V-вырез — отсев по гейту', expect: 'gate_failed',
    v: { garment_type: 'blouse_non_shirt', collar: 'stand', silhouette: 'straight',
         fabric: 'smooth_matte', pattern: 'solid', hem: 'straight',
         sleeves: 'three_quarter', cuffs: 'none', body_length: 'regular',
         pockets: 'none', shoulder: 'set_in', front_closure: 'none' },
  },
};

const useText = !process.argv.includes('--no-text');
let failures = 0;

for (const [nmStr, t] of Object.entries(VISION)) {
  const nm = Number(nmStr);
  let fromText = {};
  if (useText) {
    const card = await fetchCard(nm);
    if (card) fromText = attributesFromOptions(card);
  }
  const { values, sources, conflicts } = mergeObservations(fromText, t.v, TARGET);
  const r = scoreCard(values, TARGET);

  const ok = r.band === t.expect;
  if (!ok) failures += 1;
  console.log('─'.repeat(78));
  console.log(`${nm}  ${t.label}`);
  console.log(`${ok ? '  OK  ' : '  НЕ СОШЛОСЬ  '}ожидалось «${t.expect}», получено «${r.band}»`);
  console.log(explain(r, TARGET));
  const bySource = Object.entries(sources).filter(([, s]) => s === 'text').map(([a]) => a);
  if (bySource.length) console.log(`  из характеристик: ${bySource.join(', ')}`);
  for (const c of conflicts) {
    console.log(`  ⚠ расхождение ${c.attr}: в тексте «${c.text}», на фото «${c.vision}»`);
  }
}

console.log('─'.repeat(78));
console.log(failures ? `Не сошлось корзин: ${failures} из ${Object.keys(VISION).length}`
                     : `Все ${Object.keys(VISION).length} карточек попали в ожидаемые корзины`);
process.exit(failures ? 1 : 0);
