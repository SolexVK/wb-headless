// lib/visualProfile.js — спецификация эталона: веса, гейты, частичные совпадения.
//
// Здесь живёт вся «политика» сравнения. Модель зрения сюда ничего не решает:
// она отвечает на атомарные вопросы закрытыми значениями, а балл считает
// visualScore.js по этой таблице. Поменять поведение = поменять числа здесь.
//
// Веса отражают РАЗДЕЛЯЮЩУЮ СИЛУ признака внутри категории, а не важность
// «вообще». В категории «Рубашка» отложной воротник и сквозная застёжка есть
// почти у всех — они плохо делят выборку. Делят её ткань и рисунок.

/** Целевой профиль: женская рубашка из марлевки/муслина, оверсайз. */
export const TARGET = {
  id: 'womens_shirt_gauze_oversize',
  title: 'Женская рубашка оверсайз из марлевки/муслина',

  // Жёсткие гейты. Их всего три: признаки, которые видны почти всегда и
  // определяют «рубашка ли это вообще». Семь гейтов из исходного профиля
  // давали пустую выдачу — низ и манжета не видны на большинстве фото.
  gates: ['garment_type', 'collar', 'front_closure'],

  // Сумма весов = 100. Проверяется при загрузке.
  attributes: {
    fabric: {
      weight: 20,
      target: 'crinkled_gauze',
      // Частичный зачёт: значение → доля веса. Чего нет в таблице — ноль.
      partial: { smooth_matte: 0.3, unknown: null },
      penalty: {}, // ткани нет в negative_criteria: хватает потери 20 баллов
      note: 'главный различитель ниши; дублируется полем «Состав» из карточки',
    },
    silhouette: {
      weight: 14,
      target: 'oversize',
      partial: { relaxed: 0.8, straight: 0.4, unknown: null },
      penalty: { fitted: 10 }, // very_high
    },
    collar: {
      weight: 13,
      target: 'classic_turn_down',
      partial: { unknown: null },
      penalty: { // very_high по всем блузочным воротникам
        stand: 10, mandarin: 10, polo: 10, round_neck: 10,
        v_neck: 10, bow: 10, lapel: 10,
      },
      gate: true,
    },
    garment_type: {
      weight: 10,
      target: 'shirt',
      partial: { unknown: null },
      penalty: {}, // это гейт: несовпадение обнуляет карточку целиком
      gate: true,
    },
    front_closure: {
      weight: 8,
      target: 'full_button_placket',
      partial: { unknown: null },
      penalty: { zipper: 10, side: 10, none: 10, hidden: 5 }, // very_high
      gate: true,
    },
    hem: {
      weight: 8,
      target: 'rounded_shirt_tail',
      partial: { unknown: null },
      penalty: { straight: 5, cropped: 5, asymmetric: 5 }, // high
    },
    sleeves: {
      weight: 7,
      target: 'long',
      partial: { three_quarter: 0.4, unknown: null },
      penalty: { short: 5, sleeveless: 5 }, // high
    },
    cuffs: {
      weight: 7,
      target: 'separate_shirt_cuff',
      partial: { folded: 0.3, unknown: null },
      penalty: { none: 5, folded: 3, elastic: 3 }, // high
    },
    pattern: {
      weight: 6,
      target: 'solid',
      partial: { unknown: null },
      penalty: {}, // рисунка нет в negative_criteria: хватает потери 6 баллов
      note: 'фактуру жатки нельзя путать с принтом — правило в промпте',
    },
    body_length: {
      weight: 3,
      target: 'elongated',
      partial: { regular: 0.5, unknown: null },
      penalty: {},
    },
    pockets: {
      weight: 2,
      target: 'none',
      partial: { unknown: null },
      penalty: { large_patch: 2 }, // medium
    },
    shoulder: {
      weight: 2,
      target: 'soft_dropped',
      partial: { set_in: 0.4, unknown: null },
      penalty: {},
    },
  },

  // Что делать с признаком, который не виден. `redistribute` — вес выбывает
  // из знаменателя, балл считается по видимым признакам. Альтернативы:
  // `zero` (считать несовпадением) и `half` (полвеса).
  unknownPolicy: 'redistribute',

  // Больше скольких unknown — помечать карточку «низкая наблюдаемость».
  lowObservabilityAt: 3,

  // Границы корзин.
  bands: [
    { from: 90, key: 'very_close', label: 'очень близкий аналог' },
    { from: 80, key: 'close', label: 'близкий аналог' },
    { from: 70, key: 'review', label: 'посмотреть глазами' },
    { from: 50, key: 'adjacent', label: 'смежный товар' },
    { from: 0, key: 'irrelevant', label: 'нерелевантный' },
  ],

  // В основной список идёт всё от этого балла; ниже и до 70 — «посмотреть».
  cutoff: 80,
};

/**
 * Проверяет спецификацию: сумма весов, гейты существуют, у гейтов есть цель.
 * @returns {string[]} список проблем; пустой массив — всё в порядке
 */
export function validateProfile(p = TARGET) {
  const problems = [];
  const sum = Object.values(p.attributes).reduce((s, a) => s + a.weight, 0);
  if (sum !== 100) problems.push(`сумма весов ${sum}, ожидается 100`);
  for (const g of p.gates) {
    if (!p.attributes[g]) problems.push(`гейт «${g}» отсутствует среди атрибутов`);
  }
  for (const [name, a] of Object.entries(p.attributes)) {
    if (!a.target) problems.push(`у атрибута «${name}» нет целевого значения`);
    if (a.weight < 0) problems.push(`отрицательный вес у «${name}»`);
  }
  if (!['redistribute', 'zero', 'half'].includes(p.unknownPolicy)) {
    problems.push(`неизвестная политика unknown: ${p.unknownPolicy}`);
  }
  return problems;
}

/**
 * Признаки, которые берутся из характеристик карточки, а не с фото.
 * Ключ — атрибут профиля, значение — функция от attributesFromOptions().
 * Текст надёжнее зрения там, где продавец обязан заполнить поле.
 */
export const FROM_TEXT = {
  fabric: (t) => (t.gauzeClaim === true ? 'crinkled_gauze'
    : t.fabricClaim ? (/атлас|сатин|шелк|шёлк/i.test(t.fabricClaim) ? 'satin_shiny'
      : /флис|фланел|байк/i.test(t.fabricClaim) ? 'flannel'
        : /трикотаж|вязан/i.test(t.fabricClaim) ? 'knit'
          : /джинс|деним/i.test(t.fabricClaim) ? 'denim' : null) : null),
  silhouette: (t) => (t.fit === 'loose' ? 'oversize' : t.fit === 'fitted' ? 'fitted' : null),
  front_closure: (t) => (t.closure
    ? (/пуговиц/i.test(t.closure) ? 'full_button_placket'
      : /молни/i.test(t.closure) ? 'zipper'
        : /без застёжк|без застежк/i.test(t.closure) ? 'none' : null)
    : null),
  pockets: (t) => (t.chestPocket === 'no' ? 'none' : t.chestPocket === 'yes' ? 'large_patch' : null),
};
