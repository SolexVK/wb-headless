// calendar.js — рабочий календарь производства.
// По умолчанию 6-дневная неделя: воскресенье (getDay()===0) — выходной.
// Даты внутри движка — «дни» в формате ISO 'YYYY-MM-DD' (без времени/таймзон).

const MS_DAY = 24 * 60 * 60 * 1000;

const MONTHS_RU = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];
const MONTHS_RU_FULL = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// ---- базовые операции над ISO-датой ----
export function toISO(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISO(s) {
  // всегда в UTC-полночь, чтобы не ловить сдвиги таймзон
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(iso, n) {
  const t = parseISO(iso).getTime() + n * MS_DAY;
  return toISO(new Date(t));
}

export function diffDays(a, b) {
  // календарных дней между a и b (b - a)
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / MS_DAY);
}

export function dayOfWeek(iso) {
  return parseISO(iso).getUTCDay(); // 0=вс ... 6=сб
}

export function fmtRu(iso) {
  const d = parseISO(iso);
  return `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]}`;
}

export function monthNameFull(monthIndex0) {
  return MONTHS_RU_FULL[((monthIndex0 % 12) + 12) % 12];
}

// ---- рабочий календарь ----
// weekends: массив дней недели-выходных (по умолчанию [0] = воскресенье).
// holidays: набор ISO-дат-исключений (нерабочие).
export function makeCalendar({ weekends = [0], holidays = [] } = {}) {
  const weekendSet = new Set(weekends);
  const holidaySet = new Set(holidays);

  const isWorkingDay = (iso) =>
    !weekendSet.has(dayOfWeek(iso)) && !holidaySet.has(iso);

  // следующий рабочий день, начиная с iso (включая сам iso)
  const nextWorkingDay = (iso) => {
    let cur = iso;
    let guard = 0;
    while (!isWorkingDay(cur) && guard++ < 3650) cur = addDays(cur, 1);
    return cur;
  };

  // прибавить n рабочих дней к дате начала (start считается 0-м).
  // возвращает дату, на которую придётся n-й рабочий день.
  const addWorkingDays = (startIso, n) => {
    let cur = nextWorkingDay(startIso);
    let left = Math.max(0, Math.ceil(n));
    let guard = 0;
    while (left > 0 && guard++ < 100000) {
      cur = nextWorkingDay(addDays(cur, 1));
      left--;
    }
    return cur;
  };

  // сколько рабочих дней в интервале [from, to] включительно
  const workingDaysBetween = (fromIso, toIso) => {
    let cur = fromIso;
    let count = 0;
    let guard = 0;
    while (diffDays(cur, toIso) >= 0 && guard++ < 100000) {
      if (isWorkingDay(cur)) count++;
      cur = addDays(cur, 1);
    }
    return count;
  };

  // рабочих дней в календарном месяце (monthIndex0: 0..11)
  const workingDaysInMonth = (year, monthIndex0) => {
    const first = toISO(new Date(Date.UTC(year, monthIndex0, 1)));
    const last = toISO(new Date(Date.UTC(year, monthIndex0 + 1, 0)));
    return workingDaysBetween(first, last);
  };

  return {
    weekends: [...weekendSet],
    holidays: [...holidaySet],
    isWorkingDay,
    nextWorkingDay,
    addWorkingDays,
    workingDaysBetween,
    workingDaysInMonth,
  };
}

export { MONTHS_RU, MONTHS_RU_FULL, MS_DAY };
