// lib/reviewsClassify.js — классификация отзывов WB по звёздам, темам и сигналам
// соответствия; выделяет проблемные кластеры и рекомендации «что доработать».

// Тематические словари (корни слов). Порядок = приоритет отображения.
const THEMES = [
  { key: 'size', label: 'Размер / посадка', roots: ['мал', 'велик', 'маломер', 'большемер', 'размер', 'село', 'сел ', 'тесн', 'узк', 'широк', 'впритык', 'посадк', 'great', 'мешков'] },
  { key: 'fabric', label: 'Ткань / материал', roots: ['ткан', 'материал', 'тонк', 'просвечива', 'синтет', 'электриз', 'дешёв', 'дешев', 'жёстк', 'жестк', 'мнёт', 'мнет', 'катышк', 'колюч', 'плотн'] },
  { key: 'tailoring', label: 'Пошив / швы', roots: ['шов', 'шва', 'швы', 'нитк', 'строчк', 'пошив', 'крив', 'брак', 'дыр', 'распус', 'торч', 'обработ'] },
  { key: 'color', label: 'Цвет / отличие от фото', roots: ['цвет', 'оттен', 'не тот', 'отлича', 'на фото', 'по факту', 'иначе выгляд'] },
  { key: 'buttons', label: 'Пуговицы / фурнитура', roots: ['пуговиц', 'застёжк', 'застежк', 'молни', 'фурнитур', 'петл'] },
  { key: 'smell', label: 'Запах', roots: ['запах', 'пахн', 'воня', 'вон ', 'химией', 'химия'] },
  { key: 'delivery', label: 'Доставка / упаковка', roots: ['помят', 'упаковк', 'грязн', 'пятн', 'мятая', 'мятую', 'доставк', 'пакет'] },
  { key: 'quality', label: 'Общее качество', roots: ['качеств', 'ужас', 'отврат', 'не рекоменд', 'разочаров', 'верну', 'возврат'] },
];

const low = (s) => String(s || '').toLowerCase();
const fbText = (f) => `${low(f.text)} ${low(f.pros)} ${low(f.cons)}`;
const stars = (f) => Number(f.productValuation ?? f.rank ?? 0) || 0;
const isNeg = (f) => stars(f) > 0 && stars(f) <= 3;

// Нормализация сигнала соответствия (размер/фото/описание) к рус-меткам.
function matchLabel(v) {
  const s = low(v);
  if (!s) return null;
  if (/(^| )(ok|соответ|верн|как в описании|полное)/.test(s)) return 'соответствует';
  if (/(small|мал|меньше|маломер)/.test(s)) return 'маломерит';
  if (/(big|велик|больше|большемер)/.test(s)) return 'большемерит';
  return s.slice(0, 24);
}

function tallyMatch(feedbacks, field) {
  const m = {};
  for (const f of feedbacks) {
    const lab = matchLabel(f[field]);
    if (lab) m[lab] = (m[lab] || 0) + 1;
  }
  return m;
}

/**
 * @param {object[]} feedbacks — массив отзывов WB (v1)
 * @param {object} meta — {count, valuation} из fetchReviews (полные счётчики ниши отзыва)
 */
export function classifyReviews(feedbacks, meta = {}) {
  const fb = Array.isArray(feedbacks) ? feedbacks : [];
  const sampled = fb.length;
  const starCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let starSum = 0, withText = 0, withPhoto = 0;
  for (const f of fb) {
    const s = stars(f);
    if (s >= 1 && s <= 5) { starCounts[s]++; starSum += s; }
    if (low(f.text) || low(f.cons) || low(f.pros)) withText++;
    if (f.matchingPhoto === true || (Array.isArray(f.photo) && f.photo.length) || f.photos) withPhoto++;
  }
  const rated = Object.values(starCounts).reduce((a, b) => a + b, 0) || 1;
  const avgStars = starSum / rated;

  // Темы: сколько отзывов упоминают тему и сколько из них негативные.
  const themes = THEMES.map((t) => {
    let count = 0, neg = 0;
    const examples = [];
    for (const f of fb) {
      const txt = fbText(f);
      if (t.roots.some((r) => txt.includes(r))) {
        count++;
        const negative = isNeg(f) || low(f.cons).length > 0;
        if (negative) neg++;
        if (negative && examples.length < 3 && (low(f.cons) || low(f.text))) {
          examples.push({ text: (f.cons || f.text || '').slice(0, 160), stars: stars(f), size: f.size || '' });
        }
      }
    }
    return { key: t.key, label: t.label, count, neg, share: sampled ? count / sampled : 0, examples };
  }).filter((t) => t.count > 0).sort((a, b) => b.neg - a.neg || b.count - a.count);

  // Проблемные кластеры — темы, где преобладает негатив.
  const problems = themes.filter((t) => t.neg >= 2 && t.neg / Math.max(1, t.count) >= 0.3);

  // Рекомендации «что доработать» — из топ-проблем + сигналов соответствия.
  const matching = {
    size: tallyMatch(fb, 'matchingSize'),
    photo: tallyMatch(fb, 'matchingPhoto'),
    desc: tallyMatch(fb, 'matchingDescription'),
  };
  const improvements = [];
  const REMEDY = {
    size: 'Уточнить размерную сетку и замеры в описании; при систематическом «маломерит/большемерит» — скорректировать лекало или явно рекомендовать размер.',
    fabric: 'Пересмотреть плотность/состав ткани (просвечивание, синтетика, катышки); честно показать фактуру на фото/видео.',
    tailoring: 'Усилить контроль пошива (швы, нитки, строчка, брак) на производстве и приёмке.',
    color: 'Привести фото к реальному цвету (съёмка при нейтральном свете), добавить фото «как в жизни».',
    buttons: 'Заменить/усилить фурнитуру (пуговицы, застёжки); проверить пришив.',
    smell: 'Проветривание/смена обработки ткани, другая упаковка — устранить химический запах.',
    delivery: 'Плотная упаковка (индивидуальный пакет), защита от заминания и загрязнения.',
    quality: 'Комплексно поднять контроль качества — общий негатив «инерционно» тянет рейтинг вниз.',
  };
  for (const p of problems.slice(0, 5)) improvements.push({ theme: p.label, count: p.neg, remedy: REMEDY[p.key] || '' });
  // сигнал размера из структурированного поля
  const sz = matching.size;
  const szBad = (sz['маломерит'] || 0) + (sz['большемерит'] || 0);
  if (szBad >= 3 && !improvements.some((i) => /размер/i.test(i.theme))) {
    improvements.unshift({ theme: 'Размер (сигнал WB)', count: szBad, remedy: REMEDY.size });
  }

  // Топ-негатив (для показа примеров).
  const topNegatives = fb.filter(isNeg)
    .sort((a, b) => (Number(b.votes?.pluses) || 0) - (Number(a.votes?.pluses) || 0))
    .slice(0, 6)
    .map((f) => ({ text: (f.text || f.cons || '').slice(0, 200), stars: stars(f), size: f.size || '', color: f.color || '' }))
    .filter((x) => x.text);

  return {
    total: Number(meta.count) || sampled,
    sampled,
    valuation: meta.valuation != null ? meta.valuation : Number(avgStars.toFixed(2)),
    avgStars: Number(avgStars.toFixed(2)),
    stars: starCounts,
    negativeShare: sampled ? fb.filter(isNeg).length / sampled : 0,
    withText, withPhoto,
    themes, problems, matching, improvements, topNegatives,
  };
}
