// model.js — схема состояния приложения, значения по умолчанию, сид и нормализация.

let _idCounter = 1;
export function genId(prefix = 'id') {
  return `${prefix}_${(_idCounter++).toString(36)}${Date.now().toString(36).slice(-4)}`;
}

// смещение операции (раб. дней): целое ≥0 или null (тогда движок посчитает по умолчанию)
function cleanOffset(v) {
  return (Number.isFinite(+v) && v !== '' && v != null) ? Math.max(0, Math.round(+v)) : null;
}
// смещения по умолчанию для цеха, исходя из мощностей и типовых порогов потока
function defaultFlowOffsets(caps) {
  return {
    sew: Math.max(1, Math.ceil(250 / caps.cut)),   // пошив от кроя
    iron: Math.max(1, Math.ceil(300 / caps.sew)),  // утюжка от пошива
    otk: Math.max(1, Math.ceil(1000 / caps.iron)), // ОТК от утюжки
  };
}

// ---- значения по умолчанию ----
export function defaultSettings() {
  return {
    // календарь производства
    calendar: { weekends: [0], holidays: [] }, // 6-дневка: вс — выходной
    // поток внутри цикла: пороги запуска следующей операции (в штуках)
    flow: {
      sewAfterCut: 250,   // пошив стартует, когда скроено ~столько
      ironAfterSew: 300,  // утюжка стартует, когда сшито ~столько
      otkAfterIron: 1000, // ОТК стартует, когда отутюжено ~столько
    },
    // ткань
    fabric: {
      leadTimeDays: 21,   // от заказа до склада цеха (3 недели)
      safetyStages: 2,    // держать запас минимум на N этапов
      wastagePct: 8,      // запас по количеству (%)
      bufferDays: 4,      // ткань должна быть на складе на N дней раньше кроя
    },
    // логистика до WB
    logistics: {
      minDays: 10,
      maxDays: 15,
      cargoPickupWeekday: 1, // карго забирает раз в неделю (1 = понедельник)
    },
    // общий страховочный буфер под форс-мажоры (раб. дней на цикл)
    riskBufferDays: 2,
  };
}

// ---- сид: сезоны (контейнер над этапами) ----
function seedSeasons() {
  return [{ id: 'season1', name: 'Сезон 2026/27' }];
}

// ---- сид: этапы (2 месяца продаж → 1 месяц производства) ----
function seedStages() {
  // productionMonth: 'YYYY-MM' — календарный месяц отшива.
  // deadline: дата, к которой партия должна быть на складе WB (старт продаж).
  return [
    { id: 'stage1', name: 'Этап 1', seasonId: 'season1', salesMonths: 'Авг–Сен', productionMonth: '2026-07', deadline: '2026-08-01' },
    { id: 'stage2', name: 'Этап 2', seasonId: 'season1', salesMonths: 'Окт–Ноя', productionMonth: '2026-08', deadline: '2026-10-01' },
    { id: 'stage3', name: 'Этап 3', seasonId: 'season1', salesMonths: 'Дек–Янв', productionMonth: '2026-09', deadline: '2026-12-01' },
    { id: 'stage4', name: 'Этап 4', seasonId: 'season1', salesMonths: 'Фев–Мар', productionMonth: '2026-10', deadline: '2027-02-01' },
  ];
}

// ---- сид: цеха (4 основных + 2 вспомогательных) ----
function seedWorkshops() {
  const list = [
    { id: 'w_choro',  name: 'Чоро',   role: 'main', capacities: { cut: 500, sew: 250, iron: 500, otk: 1000 } },
    { id: 'w_ala',    name: 'Ала',    role: 'main', capacities: { cut: 500, sew: 240, iron: 500, otk: 1000 } },
    { id: 'w_naryn',  name: 'Нарын',  role: 'main', capacities: { cut: 450, sew: 220, iron: 450, otk: 900 } },
    { id: 'w_osh',    name: 'Ош',     role: 'main', capacities: { cut: 450, sew: 200, iron: 450, otk: 900 } },
    { id: 'w_talas',  name: 'Талас',  role: 'aux',  capacities: { cut: 300, sew: 130, iron: 300, otk: 600 } },
    { id: 'w_batken', name: 'Баткен', role: 'aux',  capacities: { cut: 250, sew: 110, iron: 250, otk: 500 } },
  ];
  for (const w of list) w.flowOffsets = defaultFlowOffsets(w.capacities);
  return list;
}

// ---- сид: артикулы (реальные номера/цвета из Google-таблицы, суммы по этапам — из неё же) ----
// Распределить суммарное кол-во total по цветам×размерам (детерминированно):
// размеры — колоколом (средние ходовее), цвета — примерно поровну.
// Возвращает { color: { size: qty } } с точной суммой = total.
export function buildMatrix(total, colors, sizes) {
  const nc = colors.length, ns = sizes.length;
  const m = {};
  if (!nc || !ns || total <= 0) {
    for (const c of colors) { m[c] = {}; for (const s of sizes) m[c][s] = 0; }
    return m;
  }
  const mid = (ns - 1) / 2;
  const sizeW = sizes.map((_, i) => 1 + (1 - Math.abs(i - mid) / (mid + 1)));
  const sizeSum = sizeW.reduce((a, b) => a + b, 0);
  const colW = colors.map((_, i) => 1 + ((i % 3) * 0.12)); // лёгкая неравномерность
  const colSum = colW.reduce((a, b) => a + b, 0);
  const cells = [];
  let assigned = 0;
  colors.forEach((c, ci) => {
    m[c] = {};
    sizes.forEach((s, si) => {
      const q = Math.round(total * (colW[ci] / colSum) * (sizeW[si] / sizeSum));
      m[c][s] = q; assigned += q; cells.push([c, s]);
    });
  });
  // добить остаток ±1 по ячейкам, чтобы сумма точно совпала
  let diff = total - assigned, idx = 0, guard = 0;
  while (diff !== 0 && guard++ < cells.length * 6) {
    const [c, s] = cells[idx % cells.length]; idx++;
    if (diff > 0) { m[c][s] += 1; diff--; }
    else if (m[c][s] > 0) { m[c][s] -= 1; diff++; }
  }
  return m;
}

function seedArticles() {
  const S = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
  // matrix: этап -> цвет -> размер -> штук; plan (сумма по этапу) выводится из matrix
  const mk = (id, name, comment, colors, sizes, fabricPerUnit, price, totals) => {
    const stageIds = ['stage1', 'stage2', 'stage3', 'stage4'];
    const matrix = {}; const plan = {};
    stageIds.forEach((sid, i) => {
      matrix[sid] = buildMatrix(totals[i], colors, sizes);
      plan[sid] = totals[i];
    });
    return { id, name, comment, colors, sizes, fabricPerUnit, fabricPricePerMeter: price, matrix, plan };
  };
  return [
    mk('026', 'Рубашка мужская 026', 'клетка, приталенная', ['розовый-серый', 'белый-серый', 'голубой', 'синий'], S, 1.6, 3.5, [1403, 1413, 1711, 1978]),
    mk('027', 'Рубашка мужская 027', 'однотонная, классика', ['голубой', 'белая', 'серый'], S, 1.6, 3.2, [1674, 1769, 2017, 2399]),
    mk('031', 'Рубашка мужская 031', 'твид, отложной воротник', ['чёрный', 'синяя', 'коричневая', 'зелёный', 'белая'], S, 1.7, 4.8, [1008, 1219, 1476, 1706]),
    mk('035', 'Рубашка мужская 035', 'лён, свободный крой', ['розовый', 'серый', 'шоколад'], S, 1.6, 4.1, [2087, 2502, 3301, 3800]),
    mk('004', 'Рубашка мужская 004', 'оксфорд, на пуговицах', ['голубой', 'серый', 'чёрный'], S, 1.6, 3.6, [1245, 1404, 2600, 3692]),
  ];
}

export function defaultState() {
  const state = {
    version: 1,
    settings: defaultSettings(),
    seasons: seedSeasons(),
    stages: seedStages(),
    workshops: seedWorkshops(),
    articles: seedArticles(),
    partias: [], // партии (план-заявки/производство) — источник истины по количествам
    overrides: {}, // ручные правки Ганта: cycleId -> { cutStart?, workshopId? }
    assignments: {}, // (устар.) фиксация цеха; теперь цех задаётся в партии
  };
  ensurePartias(state); // построить партии из сид-матриц
  return state;
}

// ---- нормализация/валидация пришедшего состояния ----
export function normalizeState(input) {
  const base = defaultState();
  if (!input || typeof input !== 'object') return base;
  const s = { ...base, ...input };
  s.settings = deepMergeSettings(base.settings, input.settings || {});
  s.unit = normalizeUnitGlobal(input.unit); // глобальные параметры ВБ/налогов (юнит-экономика)
  s.seasons = Array.isArray(input.seasons) && input.seasons.length ? input.seasons : base.seasons;
  s.stages = Array.isArray(input.stages) ? input.stages : base.stages;
  s.workshops = Array.isArray(input.workshops) ? input.workshops : base.workshops;
  s.articles = Array.isArray(input.articles) ? input.articles : base.articles;
  // партии: берём из input; если их нет — ensurePartias мигрирует из article.matrix
  s.partias = Array.isArray(input.partias) ? input.partias : [];
  s.overrides = input.overrides && typeof input.overrides === 'object' ? input.overrides : {};
  s.assignments = input.assignments && typeof input.assignments === 'object' ? input.assignments : {};
  // сезоны: гарантировать id/имя и привязку каждого этапа к существующему сезону
  if (!Array.isArray(s.seasons) || !s.seasons.length) s.seasons = seedSeasons();
  for (const se of s.seasons) { se.id = se.id || genId('season'); se.name = se.name || 'Сезон'; }
  const seasonIds = new Set(s.seasons.map((x) => x.id));
  for (const st of s.stages) { if (!st.seasonId || !seasonIds.has(st.seasonId)) st.seasonId = s.seasons[0].id; }
  // подчистка мощностей
  for (const w of s.workshops) {
    w.role = w.role === 'aux' ? 'aux' : 'main';
    w.capacities = { cut: 1, sew: 1, iron: 1, otk: 1, ...(w.capacities || {}) };
    for (const k of ['cut', 'sew', 'iron', 'otk']) w.capacities[k] = Math.max(1, +w.capacities[k] || 1);
    // смещения операций внутри цикла (раб. дней): пошив от кроя, утюжка от пошива, ОТК от утюжки
    const fo = w.flowOffsets && typeof w.flowOffsets === 'object' ? w.flowOffsets : {};
    w.flowOffsets = {
      sew: cleanOffset(fo.sew), iron: cleanOffset(fo.iron), otk: cleanOffset(fo.otk),
    };
    delete w.cycleOffsetDays; // устаревшее поле
  }
  for (const a of s.articles) {
    a.plan = a.plan && typeof a.plan === 'object' ? a.plan : {};
    a.matrix = a.matrix && typeof a.matrix === 'object' ? a.matrix : {};
    a.comment = typeof a.comment === 'string' ? a.comment : '';
    a.fabricPerUnit = +a.fabricPerUnit > 0 ? +a.fabricPerUnit : 1.6;
    a.fabricPricePerMeter = +a.fabricPricePerMeter >= 0 ? +a.fabricPricePerMeter : 0; // $/м
    // процент выкупа (WB): доля заказов, которые реально выкупают. Для одежды ~30–60%.
    // MPStats отдаёт «продажи» = выкупы; заказы = выкупы / (buyoutPct/100).
    a.buyoutPct = (+a.buyoutPct > 0 && +a.buyoutPct <= 100) ? +a.buyoutPct : 40;
    a.colors = Array.isArray(a.colors) ? a.colors : [];
    a.sizes = Array.isArray(a.sizes) ? a.sizes : [];
    // метаданные ткани по цвету: { цвет: { plansheet, colorNo, image(dataURL) } }
    a.fabricInfo = a.fabricInfo && typeof a.fabricInfo === 'object' ? a.fabricInfo : {};
    // конфиг фильтра аналогов для раздела «Ранг сезонности» (путь предмета, слова, ценовой коридор…)
    if (a.seasonFilter && typeof a.seasonFilter === 'object') { /* keep */ } else delete a.seasonFilter;
    // юнит-экономика: себестоимость, цена, плановая вилка маржи/прибыли, фаза ДРР, переопределения
    a.unit = normalizeUnitArticle(a.unit);
  }
  // автосортировка артикулов по номеру, от меньшего к большему (числовая)
  s.articles.sort(compareArticleId);
  // партии — источник истины по количествам (миграция из article.matrix при первом запуске)
  ensurePartias(s);
  return s;
}

// ---- ПАРТИИ (сквозной учёт план-заявок/производства) ----
export const PARTIA_STATUSES = ['plan', 'cutting', 'sewing', 'done', 'shipped'];
export const PARTIA_STATUS_RU = {
  plan: 'план', cutting: 'крой', sewing: 'пошив', done: 'готово', shipped: 'отгружено',
};

function genPartiaId() {
  return `p_${(_idCounter++).toString(36)}${Math.floor(_idCounter * 7).toString(36)}`;
}

// Гарантировать наличие и корректность s.partias.
// Если партий нет — мигрируем из article.matrix (1 партия на артикул+этап).
function ensurePartias(s) {
  if (!Array.isArray(s.partias)) s.partias = [];
  const articleIds = new Set(s.articles.map((a) => a.id));
  const stageIds = new Set(s.stages.map((st) => st.id));

  if (s.partias.length === 0) {
    for (const a of s.articles) {
      const m = a.matrix && typeof a.matrix === 'object' ? a.matrix : {};
      for (const stageId of Object.keys(m)) {
        if (!stageIds.has(stageId)) continue;
        if (sumMatrixStage(m[stageId]) <= 0) continue;
        s.partias.push({
          id: genPartiaId(), no: 0, articleId: a.id, stageId,
          workshopId: (s.assignments || {})[`${stageId}:${a.id}`] || '',
          planMatrix: m[stageId], factMatrix: {}, status: 'plan', historical: false,
        });
      }
    }
  }
  // выкинуть партии с несуществующими артикулом/этапом
  s.partias = s.partias.filter((p) => articleIds.has(p.articleId) && stageIds.has(p.stageId));
  // нормализация полей + чистка матриц от «осиротевших» цветов/размеров
  const artById = Object.fromEntries(s.articles.map((a) => [a.id, a]));
  for (const p of s.partias) {
    p.id = p.id || genPartiaId();
    p.workshopId = typeof p.workshopId === 'string' ? p.workshopId : '';
    const a = artById[p.articleId];
    p.planMatrix = pruneMatrix(p.planMatrix, a);
    p.factMatrix = pruneMatrix(p.factMatrix, a);
    p.status = PARTIA_STATUSES.includes(p.status) ? p.status : 'plan';
    p.historical = !!p.historical;
  }
  assignPartiaNumbers(s.partias, s.stages);
  // article.matrix больше не источник истины — не храним, чтобы не расходилось
  for (const a of s.articles) delete a.matrix;
}

// Нумерация партий: у КАЖДОГО цеха своя сквозная нумерация (1,2,3…).
// Порядок внутри цеха — по этапам, затем по порядку добавления. Авто-партии
// (без назначенного цеха) нумеруются в отдельной группе.
export function assignPartiaNumbers(partias, stages) {
  const stageOrder = {};
  stages.forEach((st, i) => { stageOrder[st.id] = i; });
  const indexed = partias.map((p, idx) => ({ p, idx }));
  indexed.sort((A, B) => (stageOrder[A.p.stageId] ?? 99) - (stageOrder[B.p.stageId] ?? 99) || A.idx - B.idx);
  const counters = {};
  for (const { p } of indexed) {
    const key = p.workshopId || '__auto__';
    counters[key] = (counters[key] || 0) + 1;
    p.no = counters[key];
  }
}

// суммарные штуки партии по плану / факту
export function partiaPlanUnits(p) { return sumMatrixStage(p && p.planMatrix); }
export function partiaFactUnits(p) { return sumMatrixStage(p && p.factMatrix); }
// эффективная матрица для логистики: факт если введён, иначе план
export function partiaEffectiveMatrix(p) {
  return partiaFactUnits(p) > 0 ? p.factMatrix : (p.planMatrix || {});
}
export function partiaEffectiveUnits(p) {
  const f = partiaFactUnits(p);
  return f > 0 ? f : partiaPlanUnits(p);
}
// партии артикула на этапе
export function partiasOf(state, articleId, stageId) {
  return (state.partias || []).filter((p) => p.articleId === articleId && p.stageId === stageId);
}
// суммарный план артикула на этапе (сумма планов всех его партий)
export function stagePlanUnits(state, articleId, stageId) {
  return partiasOf(state, articleId, stageId).reduce((s, p) => s + partiaPlanUnits(p), 0);
}

// сравнение id артикулов по номеру (числовое, «004» < «026»)
export function compareArticleId(a, b) {
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });
}

// оставить в матрице только цвета/размеры, реально существующие у артикула
// (убирает «осиротевшие» ключи после удаления/переименования — иначе суммы расходятся)
export function pruneMatrix(M, article) {
  if (!M || typeof M !== 'object') return {};
  if (!article) return M; // артикул не найден — не трогаем
  const cset = new Set(article.colors || []);
  const sset = new Set(article.sizes || []);
  const out = {};
  for (const c of Object.keys(M)) {
    if (!cset.has(c)) continue;
    const row = M[c] || {};
    out[c] = {};
    for (const sz of Object.keys(row)) if (sset.has(sz)) out[c][sz] = Math.max(0, Math.round(+row[sz] || 0));
  }
  return out;
}

// сумма всех ячеек матрицы одного этапа { цвет: { размер: qty } }
export function sumMatrixStage(stageMatrix) {
  if (!stageMatrix || typeof stageMatrix !== 'object') return 0;
  let s = 0;
  for (const color of Object.keys(stageMatrix)) {
    const row = stageMatrix[color];
    if (row && typeof row === 'object') {
      for (const size of Object.keys(row)) s += +row[size] || 0;
    }
  }
  return Math.round(s);
}

function deepMergeSettings(base, over) {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...(over[k] || {}) };
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  }
  return out;
}

// ── Юнит-экономика: нормализация параметров (полный каскадный P&L) ──
// Глобальные ставки ВБ/налогов (ПРОЦЕНТЫ для ввода) + ₽-статьи логистики/хранения/приёмки.
const UNIT_GLOBAL_DEFAULTS = {
  commission: 35.7,   // комиссия ВБ, % от S
  spp: 4,             // СПП, %
  wallet: 2,          // скидка WB Кошелёк, %
  acquiring: 4.7,     // эквайринг, % от конечной цены
  tax: 2,             // налог, % от оборота (конечная цена)
  drrLaunch: 30,      // ДРР запуск, %
  drrSteady: 8,       // ДРР выход, %
  extra: 0,           // доп.расходы, % от цены после скидки
  opexShare: 50,      // доля валовой прибыли на операционные расходы, %
  logisticsPvz: 0,    // логистика до ПВЗ, ₽/заказ
  returnLogistics: 0, // обратная логистика, ₽/заказ
  storage: 0,         // хранение, ₽/ед
  acceptanceTariff: 0, // базовый тариф платной приёмки, ₽/ед (× коэффициент артикула)
  mMin: 25, mMax: 30, // целевой коридор ВАЛОВОЙ маржи (валовая/S), %
};
function normalizeUnitGlobal(input) {
  const u = { ...UNIT_GLOBAL_DEFAULTS };
  if (input && typeof input === 'object') {
    for (const k of Object.keys(UNIT_GLOBAL_DEFAULTS)) {
      const v = Number(input[k]);
      if (Number.isFinite(v) && v >= 0) u[k] = v;
    }
  }
  return u;
}
// Параметры юнит-экономики на артикул.
function normalizeUnitArticle(input) {
  const i = input && typeof input === 'object' ? input : {};
  const t = i.target && typeof i.target === 'object' ? i.target : {};
  const posOrNull = (v) => (Number.isFinite(+v) && +v > 0 ? +v : null);
  const nonNeg = (v, d = 0) => (Number.isFinite(+v) && +v >= 0 ? +v : d);
  const margin = Number(t.margin);
  const profit = Number(t.profit);
  return {
    cost: nonNeg(i.cost),                 // себестоимость, ₽
    logisticsToWb: nonNeg(i.logisticsToWb), // логистика до склада ВБ (first-mile), ₽/ед
    basePrice: posOrNull(i.basePrice),    // базовая цена до скидки, ₽
    sellerDiscount: nonNeg(i.sellerDiscount), // скидка продавца, %
    acceptanceCoef: Number.isFinite(+i.acceptanceCoef) && +i.acceptanceCoef >= 0 ? +i.acceptanceCoef : 1, // коэф. платной приёмки
    target: {
      mode: t.mode === 'profit' ? 'profit' : 'margin',
      margin: Number.isFinite(margin) && margin >= 0 ? margin : 25, // целевая ВАЛОВАЯ маржа
      profit: Number.isFinite(profit) && profit >= 0 ? profit : null,
    },
    drrPhase: i.drrPhase === 'launch' ? 'launch' : 'steady',
    over: i.over && typeof i.over === 'object' ? i.over : {}, // переопределения глобальных ставок
  };
}
