// permissions.js — модель ролей и прав доступа (RBAC) для planner.
//
// Права задаются НА УРОВНЕ ЛИСТА: для каждого листа — 'none' | 'view' | 'edit'.
// Источник правды — сервер: SPA лишь прячет вкладки/включает read-only по этим правам,
// но реальная запись разрешается/режется здесь и в server.js (посекционная сверка при
// сохранении state), поэтому «наблюдатель» физически не может изменить данные в обход UI.
//
// Так как состояние приложения — единый объект, а многие вкладки читают одни и те же
// articles, право на РЕДАКТИРОВАНИЕ привязано к владельцу секции данных (см. SECTION_OWNER
// и applyWritePolicy). Право на ПРОСМОТР листа — про видимость вкладки и выгрузку данных.

// Перечень листов (вкладок) приложения. key совпадает с data-tab в index.html.
export const TABS = [
  { key: 'gantt', label: 'Диаграмма Ганта' },
  { key: 'matrix', label: 'План по размерам' },
  { key: 'salesplan', label: 'План продаж' },
  { key: 'fact', label: 'Факт' },
  { key: 'timing', label: 'Контроль сроков' },
  { key: 'fabric', label: 'Заказ ткани' },
  { key: 'dashboard', label: 'Дашборд' },
  { key: 'season', label: 'Ранг сезонности' },
  { key: 'reports', label: 'Отчёты' },
  { key: 'supply', label: 'Остатки и поставки' },
  { key: 'plancut', label: 'Сокращение' },
  { key: 'unit', label: 'Юнит-экономика' },
  { key: 'data', label: 'Данные' },
];
export const TAB_KEYS = TABS.map((t) => t.key);

// Права по умолчанию для роли «наблюдатель» — минимум, только просмотр дашборда.
export const DEFAULT_VIEWER_TABS = { dashboard: 'view' };

// Сотрудник компании: смотрит рабочие листы и выгружает из них файлы, ничего не меняет.
// Юнит-экономика тоже 'view' — но её экран работает как ЛИЧНЫЙ ЧЕРНОВИК: правки считаются
// в браузере сотрудника и не уходят в общую базу (см. unitPersist в public/app.js).
export const STAFF_TABS = {
  gantt: 'view',
  matrix: 'view',
  season: 'view',
  reports: 'view',
  unit: 'view',
};

// Гость демо-стенда: показать инструмент, не показывая внутренней кухни.
// Работает на отдельном экземпляре с обезличенной базой — см. docs/planner-demo.md.
export const GUEST_TABS = {
  gantt: 'view',
  matrix: 'view',
  season: 'view',
  reports: 'view',
};

// Пресеты ролей (шаблоны прав). role='custom' — произвольная карта в user.perms.
export function presetTabs(role) {
  if (role === 'admin' || role === 'editor') {
    const t = {}; for (const k of TAB_KEYS) t[k] = 'edit'; return t;
  }
  if (role === 'staff') return { ...STAFF_TABS };
  if (role === 'guest') return { ...GUEST_TABS };
  // viewer
  return { ...DEFAULT_VIEWER_TABS };
}

// Разобрать user.perms (JSON) → карта {tab: level}. Поддерживает и {tabs:{…}}, и плоскую {…}.
function parseTabs(user) {
  if (!user) return {};
  let raw = user.perms;
  if (!raw) return {};
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (p && p.tabs && typeof p.tabs === 'object') return p.tabs;
    if (p && typeof p === 'object') return p;
  } catch { /* битый JSON → нет прав */ }
  return {};
}

/** Эффективные права пользователя: {isAdmin, role, tabs:{tab:level}}. */
export function permsFor(user) {
  if (!user) return { isAdmin: false, role: null, tabs: {} };
  if (user.isAdmin) {
    const t = {}; for (const k of TAB_KEYS) t[k] = 'edit';
    return { isAdmin: true, role: 'admin', tabs: t };
  }
  return { isAdmin: false, role: user.role || 'viewer', tabs: parseTabs(user) };
}

export function canView(perms, tab) {
  if (!perms) return true;                 // авторизация выключена → полный доступ (локальная сеть)
  if (perms.isAdmin) return true;
  const lvl = perms.tabs[tab];
  return lvl === 'view' || lvl === 'edit';
}
export function canEdit(perms, tab) {
  if (!perms) return true;
  if (perms.isAdmin) return true;
  return perms.tabs[tab] === 'edit';
}
/** Есть ли право редактировать хоть что-то (для быстрой отсечки PUT). */
export function canEditAnything(perms) {
  if (!perms) return true;
  if (perms.isAdmin) return true;
  return TAB_KEYS.some((k) => perms.tabs[k] === 'edit');
}

// ── Политика записи state: берём серверную версию за базу и накладываем ТОЛЬКО те
// секции, которые пользователю разрешено редактировать. Остальное остаётся как в БД. ──
// Владельцы секций (какое право открывает запись какой части state):
//   data    → settings, seasons, stages, workshops, suppliers, version, СТРУКТУРА articles
//   unit    → state.unit и article.unit (коммерческая юнит-экономика/себестоимость)
//   fabric  → article.fabricInfo (метаданные/образцы ткани)
//   matrix|fact|salesplan → state.partias (партии/количества/факт)
//   gantt   → overrides, assignments (ручные правки Ганта)
function mergeArticles(stored, incoming, cap) {
  const sById = new Map((stored || []).map((a) => [a.id, a]));
  const iById = new Map((incoming || []).map((a) => [a.id, a]));
  // структура (набор/порядок/базовые поля) — за 'data'; иначе набор заблокирован серверным
  const base = cap.data ? (incoming || []) : (stored || []);
  return base.map((a) => {
    const s = sById.get(a.id) || {};
    const inc = iById.get(a.id) || {};
    const merged = cap.data ? { ...a } : { ...s };
    // unit — коммерческая часть
    merged.unit = cap.unit ? (inc.unit ?? a.unit ?? s.unit) : (s.unit ?? a.unit);
    // fabricInfo — ткань
    merged.fabricInfo = cap.fabric ? (inc.fabricInfo ?? a.fabricInfo ?? s.fabricInfo) : (s.fabricInfo ?? a.fabricInfo);
    return merged;
  });
}

/** Слить входящий state с сохранённым по правам. Возвращает то, что реально можно сохранить. */
export function applyWritePolicy(stored, incoming, perms) {
  if (!perms || perms.isAdmin) return incoming;
  const cap = {
    data: canEdit(perms, 'data'),
    unit: canEdit(perms, 'unit'),
    fabric: canEdit(perms, 'fabric'),
    partias: canEdit(perms, 'matrix') || canEdit(perms, 'fact') || canEdit(perms, 'salesplan') || canEdit(perms, 'timing'),
    gantt: canEdit(perms, 'gantt'),
  };
  const out = { ...stored };
  if (cap.data) {
    out.settings = incoming.settings; out.seasons = incoming.seasons;
    out.stages = incoming.stages; out.workshops = incoming.workshops;
    out.suppliers = incoming.suppliers;
    if (incoming.version != null) out.version = incoming.version;
  }
  if (cap.unit) out.unit = incoming.unit;
  if (cap.partias) out.partias = incoming.partias;
  if (cap.gantt) { out.overrides = incoming.overrides; out.assignments = incoming.assignments; }
  out.articles = mergeArticles(stored.articles, incoming.articles, cap);
  return out;
}

/** Отдать пользователю state, скрыв коммерческую юнит-экономику, если нет доступа к 'unit'. */
export function filterStateForRead(state, perms) {
  if (!perms || perms.isAdmin || canView(perms, 'unit')) return state;
  const s = { ...state };
  delete s.unit;
  s.articles = (state.articles || []).map((a) => { const c = { ...a }; delete c.unit; return c; });
  return s;
}
