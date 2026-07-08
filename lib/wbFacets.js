// lib/wbFacets.js — справочник признаков (фасетов) карточки и их матчинг.
//
// Идея: пользователь указывает релевантные признаки СВОЕГО артикула (по одному
// значению на признак). Выбранное значение = плюс-ключ; ОСТАЛЬНЫЕ значения того
// же признака автоматически становятся минус-ключами. Матчинг — по «тексту
// карточки» (название + характеристики + описание, из lib/wbCard.js enrichRows).
//
// Вердикт на признак: keep (нашли выбранное) / drop (нашли конкурирующее) /
// uncertain (сигнала нет — 🟡, не выбрасываем, помечаем для ручной/vision проверки).

const lc = (s) => String(s || '').toLowerCase();

// Справочник. Каждый признак: key, label, options[{value,label,stems}].
// stems — подстроки без окончаний (морфология ловится сама), в нижнем регистре.
export const FACETS = [
  {
    key: 'fabric',
    label: 'Тип ткани',
    options: [
      { value: 'хлопок', label: 'Хлопок', stems: ['хлопок', 'хлопк', 'cotton'] },
      { value: 'лен', label: 'Лён', stems: ['лён', 'льн', 'льнян', 'linen'] },
      { value: 'шелк', label: 'Шёлк', stems: ['шелк', 'шёлк', 'шелков', 'silk'] },
      { value: 'шерсть', label: 'Шерсть', stems: ['шерст', 'wool'] },
      { value: 'кашемир', label: 'Кашемир', stems: ['кашемир', 'cashmere'] },
      { value: 'муслин', label: 'Муслин', stems: ['муслин'] },
    ],
  },
  {
    key: 'cut',
    label: 'Покрой',
    options: [
      { value: 'приталенный', label: 'Приталенный', stems: ['притал'] },
      { value: 'прямой', label: 'Прямой', stems: ['прямой', 'прямая', 'прямого', 'прям покро', 'прямой силуэт'] },
      { value: 'оверсайз', label: 'Оверсайз', stems: ['оверс', 'oversize', 'свободн'] },
      { value: 'классический', label: 'Классический', stems: ['классическ', 'классик'] },
    ],
  },
  {
    key: 'collar',
    label: 'Воротник',
    options: [
      { value: 'отложной', label: 'Отложной', stems: ['отлож'] },
      { value: 'стойка', label: 'Стойка', stems: ['стойк'] },
      { value: 'с капюшоном', label: 'С капюшоном', stems: ['капюш'] },
      { value: 'без воротника', label: 'Без воротника', stems: ['без ворот', 'безворот', 'без воротник'] },
    ],
  },
  {
    key: 'closure',
    label: 'Вид застёжки',
    options: [
      { value: 'пуговицы', label: 'Пуговицы', stems: ['пуговиц'] },
      { value: 'кнопки', label: 'Кнопки', stems: ['кнопк', 'кнопоч'] },
    ],
  },
  {
    key: 'sleeve',
    label: 'Тип рукава',
    // Морфология + порядок слов: «с длинным рукавом», «рукав длинный», «длинные рукава».
    options: [
      { value: 'длинный', label: 'Длинный', patterns: ['длинн\\S*\\s+рукав', 'рукав\\S*\\s+длинн'] },
      { value: 'короткий', label: 'Короткий', patterns: ['коротк\\S*\\s+рукав', 'рукав\\S*\\s+коротк'] },
      {
        value: 'три четверти',
        label: '3/4',
        patterns: ['три\\s+четверт', '3/4', 'рукав\\S*\\s+3/4', 'укороч\\S*\\s+рукав'],
      },
    ],
  },
  {
    key: 'pocketsCount',
    label: 'Количество карманов',
    options: [
      { value: '0', label: 'Без карманов', stems: ['без карман'], patterns: ['без\\s+карман', 'карман\\S*\\s+нет', 'нет\\s+карман'] },
      { value: '1', label: '1 карман', patterns: ['1\\s+карман', 'один\\s+карман'] },
      { value: '2', label: '2 кармана', patterns: ['2\\s+карман', 'два\\s+карман'] },
    ],
  },
  {
    key: 'pocketsType',
    label: 'Тип карманов',
    options: [
      { value: 'накладной', label: 'Накладной', stems: ['накладн'] },
      { value: 'прорезной', label: 'Прорезной', stems: ['прорезн'] },
      { value: 'боковой', label: 'Боковой', patterns: ['боков\\S*\\s+карман', 'карман\\S*\\s+боков'] },
      { value: 'косой', label: 'Косой', patterns: ['кос\\S*\\s+карман', 'карман\\S*\\s+кос'] },
      { value: 'с клапаном', label: 'С клапаном', stems: ['клапан'] },
    ],
  },
  {
    key: 'pattern',
    label: 'Рисунок',
    options: [
      { value: 'однотон', label: 'Однотонная', stems: ['однотон', 'без принт', 'без рисун', 'гладкокраш', 'монохром'] },
      { value: 'полоска', label: 'Полоска', stems: ['полос', 'страйп', 'тельняш'] },
      { value: 'клетка', label: 'Клетка', stems: ['клетк', 'клетч', 'шотланд', 'тартан', 'гусин'] },
      { value: 'муслин', label: 'Муслин', stems: ['муслин'] },
    ],
  },
  {
    key: 'gender',
    label: 'Пол',
    options: [
      { value: 'мужской', label: 'Мужской', stems: ['мужск', 'мужчин', 'для него'] },
      { value: 'женский', label: 'Женский', stems: ['женск', 'для неё', 'для нее'] },
      { value: 'детский', label: 'Детский', stems: ['детск', 'ребён', 'ребен'] },
      { value: 'девочки', label: 'Девочки', stems: ['девоч'] },
      { value: 'мальчики', label: 'Мальчики', stems: ['мальчик'] },
    ],
  },
];

export const FACET_BY_KEY = Object.fromEntries(FACETS.map((f) => [f.key, f]));

/**
 * По выбору пользователя {facetKey: value} собирает список активных фасетов с
 * плюс/минус стемами для матчинга.
 * @returns {Array<{key,label,value,selectedStems,otherStems}>}
 */
export function buildFacetFilters(selections = {}) {
  const out = [];
  for (const [key, value] of Object.entries(selections)) {
    if (!value || value === 'любой') continue;
    const facet = FACET_BY_KEY[key];
    if (!facet) continue;
    const chosen = facet.options.find((o) => o.value === value);
    if (!chosen) continue;
    const others = facet.options.filter((o) => o.value !== value);
    // плюс — подстроки (stems) и/или regex-паттерны (patterns) выбранного значения.
    const selectedStems = chosen.stems || [];
    const selectedPatterns = chosen.patterns || [];
    // минус — то же у ОСТАЛЬНЫХ значений, за вычетом пересечений с выбранным
    // (синонимы «нет/однотон» не должны конфликтовать).
    const selS = new Set(selectedStems);
    const selP = new Set(selectedPatterns);
    const otherStems = others.flatMap((o) => o.stems || []).filter((s) => !selS.has(s));
    const otherPatterns = others.flatMap((o) => o.patterns || []).filter((p) => !selP.has(p));
    out.push({ key, label: facet.label, value, selectedStems, selectedPatterns, otherStems, otherPatterns });
  }
  return out;
}

// Компиляция regex-паттернов с кэшем (морфология/порядок слов у контекстных
// признаков: «с длинным рукавом», «рукав длинный» и т.п.).
const _reCache = new Map();
function matchAny(text, stems = [], patterns = []) {
  for (const s of stems) if (s && text.includes(s)) return true;
  for (const p of patterns) {
    let re = _reCache.get(p);
    if (!re) {
      try {
        re = new RegExp(p, 'i');
      } catch {
        re = null;
      }
      _reCache.set(p, re);
    }
    if (re && re.test(text)) return true;
  }
  return false;
}

/**
 * Вердикт по одному фасету для текста карточки.
 * keep — нашли выбранное значение; drop — нашли конкурирующее (и не выбранное);
 * uncertain — сигнала нет. Матч — по подстрокам (stems) И regex (patterns).
 */
export function facetVerdict(text, facet) {
  const t = lc(text);
  const sel = matchAny(t, facet.selectedStems, facet.selectedPatterns);
  const oth = matchAny(t, facet.otherStems, facet.otherPatterns);
  if (sel && oth) return 'uncertain'; // противоречивые сигналы → на визуальную проверку
  if (sel) return 'keep';
  if (oth) return 'drop';
  return 'uncertain';
}

/**
 * Применяет все активные фасеты к тексту карточки.
 * @returns {{drop:boolean, dropKey?:string, dropLabel?:string, uncertain:string[]}}
 *   drop — конфликт хотя бы по одному; dropKey/dropLabel — какой признак отсёк;
 *   uncertain — ключи признаков, по которым сигнала нет (🟡).
 */
export function applyFacets(text, facets = []) {
  const uncertain = [];
  for (const f of facets) {
    const v = facetVerdict(text, f);
    if (v === 'drop') return { drop: true, dropKey: f.key, dropLabel: f.label, uncertain };
    if (v === 'uncertain') uncertain.push(f.key);
  }
  return { drop: false, uncertain };
}
