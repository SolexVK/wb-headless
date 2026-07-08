// Манифест скилла «Сравнение карточек» (wb-cards-compare).
//
// Функция кабинета WB (не API): воронка «наш vs конкуренты». Якорь — ВАШ артикул
// (воронку WB отдаёт лишь по своим карточкам). Поток исполнения кастомный
// (runner:'cardsCompare'): гейт «наш/не наш» → DRY-RUN (скрин, бесплатно) →
// подтверждение → submit (тратит 1 сравнение из месячного лимита) → XLSX + данные
// в БД (правило 72 ч). Конкуренты берутся из пикера [1] или вводятся вручную.

/** Парсит список конкурентов из текста: "205764778, 494807118" → [строки]. */
export function parseRivals(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,}$/.test(s));
}

export default {
  id: 'wb-cards-compare',
  title: '📊 Сравнение карточек',
  description: 'Воронка «ваша карточка vs конкуренты» из кабинета WB (2–5 карточек)',
  adminOnly: false,
  engineeringMode: true,
  runner: 'cardsCompare', // кастомный исполнитель в боте (не CLI-generic)

  fields: [
    {
      key: 'our',
      label: 'Ваш артикул (nmID)',
      type: 'number',
      required: true,
      hint: 'должен быть в вашем кабинете WB',
    },
    {
      key: 'rivals',
      label: 'Артикулы конкурентов',
      type: 'text',
      required: true,
      placeholder: '2–4 nmID через запятую',
      hint: 'напр. 205764778, 494807118, 251575390',
    },
  ],

  steps: [
    { id: 'own-check', note: 'гейт: наш ли артикул (Content API, лимит не тратит)' },
    { id: 'dry-run', interaction: 'confirm-dry-run', note: 'скрин «N из 5», бесплатно' },
    { id: 'submit', note: 'тратит 1 сравнение; XLSX + воронка → БД (72 ч)' },
  ],

  formats: ['xlsx'],
};
