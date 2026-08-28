// planner/lib/nlq.js — «умный» разбор запроса на естественном языке в структурный фильтр отчёта.
// Нейросеть (Anthropic Claude) НЕ исполняет код и НЕ строит отчёт: она только переводит фразу
// пользователя («товары к закупу по ткани Муслин первого этапа в Китае») в JSON-фильтр из
// разрешённого набора значений. Дальше отчёт строится детерминированным конвейером на клиенте.
// Ключ берётся из process.env.ANTHROPIC_API_KEY (planner/data/.env или настройка в интерфейсе).

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export function isEnabled() {
  return !!(process.env.ANTHROPIC_API_KEY || '').trim();
}

// Инструмент структурированного вывода — модель обязана вернуть именно такой объект.
const FILTER_TOOL = {
  name: 'set_report_filter',
  description: 'Установить фильтр отчёта по ткани на основе запроса пользователя.',
  input_schema: {
    type: 'object',
    properties: {
      plansheets: { type: 'array', items: { type: 'string' }, description: 'Номера планшетов из разрешённого списка.' },
      articleIds: { type: 'array', items: { type: 'string' }, description: 'ID артикулов из разрешённого списка.' },
      months: { type: 'array', items: { type: 'string' }, description: 'Месяцы в формате YYYY-MM из разрешённого списка.' },
      sources: { type: 'array', items: { type: 'string', enum: ['china', 'bishkek'] }, description: 'Источник закупа: china = Китай, bishkek = Бишкек/Мадина.' },
      seasons: { type: 'array', items: { type: 'string', enum: ['summer', 'demi'] }, description: 'Сезон ткани: summer = лето (муслин/марлёвка), demi = демисезон.' },
      text: { type: 'string', description: 'Свободный текст для подстрочного поиска (тип ткани, цвет и т.п.), если его нельзя выразить полями выше. Иначе пустая строка.' },
      explain: { type: 'string', description: 'Короткое (до 12 слов) описание применённого фильтра по-русски.' },
    },
    required: ['explain'],
  },
};

function buildSystem(dims, reportKind) {
  const list = (arr, f) => (arr || []).map(f).join('\n') || '  (нет)';
  const months = list(dims.months, (m) => `  - ${m.ym} (${m.label})`);
  const arts = list(dims.articles, (a) => `  - ${a.id}${a.name ? ' — ' + a.name : ''}`);
  const plans = (dims.plansheets || []).join(', ') || '(нет)';
  const monthMeaning = reportKind === 'r2b' ? 'месяц ЗАКУПА ткани' : 'месяц ПРОИЗВОДСТВА';
  return `Ты — помощник, который переводит запрос пользователя о производстве одежды в структурный фильтр отчёта по ткани.
Отвечай ТОЛЬКО вызовом инструмента set_report_filter. Не пиши текст.

Правила:
- Используй ТОЛЬКО значения из разрешённых списков ниже. Если пользователь называет то, чего нет в списках, — не выдумывай ID, а положи слово в поле text.
- Массив можно оставить пустым (пустой = «все»).
- «Муслин», «марлёвка», «муслин/марлёвка», «летние ткани» → seasons: ["summer"]. «Демисезон», «зимние/осенние ткани» → seasons: ["demi"].
- «в Китае», «китайская закупка» → sources: ["china"]. «на Мадине», «в Бишкеке», «Мадина» → sources: ["bishkek"].
- Конкретное название ткани («Муслин», «Кулирка», цвет) без явного поля клади в text.
- «первый этап/транш закупа», «второй этап» относятся к летним тканям — если это нельзя выразить месяцем из списка, добавь фразу в text.
- months — это ${monthMeaning}, формат YYYY-MM.
- explain — короткая фраза, что именно ты отфильтровал.

Разрешённые планшеты: ${plans}

Разрешённые артикулы:
${arts}

Разрешённые месяцы (${monthMeaning}):
${months}`;
}

// Разобрать запрос. Возвращает {ok, filter, explain} либо {ok:false, reason}.
export async function parseQuery(query, dimensions = {}, reportKind = 'r2b') {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'no_key' };
  const body = {
    model: DEFAULT_MODEL,
    max_tokens: 512,
    system: buildSystem(dimensions, reportKind),
    tools: [FILTER_TOOL],
    tool_choice: { type: 'tool', name: 'set_report_filter' },
    messages: [{ role: 'user', content: String(query || '').slice(0, 2000) }],
  };
  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e && e.message || e) };
  }
  if (!resp.ok) {
    let detail = ''; try { detail = await resp.text(); } catch { /* ignore */ }
    return { ok: false, reason: 'api_error', status: resp.status, detail: detail.slice(0, 300) };
  }
  let data; try { data = await resp.json(); } catch { return { ok: false, reason: 'bad_json' }; }
  const tu = (data.content || []).find((c) => c.type === 'tool_use');
  if (!tu || !tu.input) return { ok: false, reason: 'no_tool_use' };
  const inp = tu.input;
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  // валидируем против разрешённых значений (нейросеть могла ошибиться)
  const okPlan = new Set((dimensions.plansheets || []).map(String));
  const okArt = new Set((dimensions.articles || []).map((a) => String(a.id)));
  const okMon = new Set((dimensions.months || []).map((m) => String(m.ym)));
  const filter = {
    plansheets: arr(inp.plansheets).filter((v) => okPlan.has(v)),
    articleIds: arr(inp.articleIds).filter((v) => okArt.has(v)),
    months: arr(inp.months).filter((v) => okMon.has(v)),
    sources: arr(inp.sources).filter((v) => v === 'china' || v === 'bishkek'),
    seasons: arr(inp.seasons).filter((v) => v === 'summer' || v === 'demi'),
    text: typeof inp.text === 'string' ? inp.text.trim().slice(0, 120) : '',
  };
  return { ok: true, filter, explain: String(inp.explain || '').slice(0, 160), model: DEFAULT_MODEL };
}
