// model.js — схема состояния приложения, значения по умолчанию, сид и нормализация.

let _idCounter = 1;
export function genId(prefix = 'id') {
  return `${prefix}_${(_idCounter++).toString(36)}${Date.now().toString(36).slice(-4)}`;
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

// ---- сид: этапы (2 месяца продаж → 1 месяц производства) ----
function seedStages() {
  // productionMonth: 'YYYY-MM' — календарный месяц отшива.
  // deadline: дата, к которой партия должна быть на складе WB (старт продаж).
  return [
    { id: 'stage1', name: 'Этап 1', salesMonths: 'Авг–Сен', productionMonth: '2026-07', deadline: '2026-08-01' },
    { id: 'stage2', name: 'Этап 2', salesMonths: 'Окт–Ноя', productionMonth: '2026-08', deadline: '2026-10-01' },
    { id: 'stage3', name: 'Этап 3', salesMonths: 'Дек–Янв', productionMonth: '2026-09', deadline: '2026-12-01' },
    { id: 'stage4', name: 'Этап 4', salesMonths: 'Фев–Мар', productionMonth: '2026-10', deadline: '2027-02-01' },
  ];
}

// ---- сид: цеха (4 основных + 2 вспомогательных) ----
function seedWorkshops() {
  return [
    { id: 'w_choro',  name: 'Чоро',   role: 'main', capacities: { cut: 500, sew: 250, iron: 500, otk: 1000 } },
    { id: 'w_ala',    name: 'Ала',    role: 'main', capacities: { cut: 500, sew: 240, iron: 500, otk: 1000 } },
    { id: 'w_naryn',  name: 'Нарын',  role: 'main', capacities: { cut: 450, sew: 220, iron: 450, otk: 900 } },
    { id: 'w_osh',    name: 'Ош',     role: 'main', capacities: { cut: 450, sew: 200, iron: 450, otk: 900 } },
    { id: 'w_talas',  name: 'Талас',  role: 'aux',  capacities: { cut: 300, sew: 130, iron: 300, otk: 600 } },
    { id: 'w_batken', name: 'Баткен', role: 'aux',  capacities: { cut: 250, sew: 110, iron: 250, otk: 500 } },
  ];
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
  const mk = (id, name, colors, sizes, fabricPerUnit, totals) => {
    const stageIds = ['stage1', 'stage2', 'stage3', 'stage4'];
    const matrix = {}; const plan = {};
    stageIds.forEach((sid, i) => {
      matrix[sid] = buildMatrix(totals[i], colors, sizes);
      plan[sid] = totals[i];
    });
    return { id, name, colors, sizes, fabricPerUnit, matrix, plan };
  };
  return [
    mk('026', 'Рубашка мужская 026', ['розовый-серый', 'белый-серый', 'голубой', 'синий'], S, 1.6, [1403, 1413, 1711, 1978]),
    mk('027', 'Рубашка мужская 027', ['голубой', 'белая', 'серый'], S, 1.6, [1674, 1769, 2017, 2399]),
    mk('031', 'Рубашка мужская 031', ['чёрный', 'синяя', 'коричневая', 'зелёный', 'белая'], S, 1.7, [1008, 1219, 1476, 1706]),
    mk('035', 'Рубашка мужская 035', ['розовый', 'серый', 'шоколад'], S, 1.6, [2087, 2502, 3301, 3800]),
    mk('004', 'Рубашка мужская 004', ['голубой', 'серый', 'чёрный'], S, 1.6, [1245, 1404, 2600, 3692]),
  ];
}

export function defaultState() {
  return {
    version: 1,
    settings: defaultSettings(),
    stages: seedStages(),
    workshops: seedWorkshops(),
    articles: seedArticles(),
    overrides: {}, // ручные правки Ганта: cycleId -> { cutStart?, workshopId? }
    assignments: {}, // фиксация цеха под артикул/этап (если задано вручную)
  };
}

// ---- нормализация/валидация пришедшего состояния ----
export function normalizeState(input) {
  const base = defaultState();
  if (!input || typeof input !== 'object') return base;
  const s = { ...base, ...input };
  s.settings = deepMergeSettings(base.settings, input.settings || {});
  s.stages = Array.isArray(input.stages) ? input.stages : base.stages;
  s.workshops = Array.isArray(input.workshops) ? input.workshops : base.workshops;
  s.articles = Array.isArray(input.articles) ? input.articles : base.articles;
  s.overrides = input.overrides && typeof input.overrides === 'object' ? input.overrides : {};
  s.assignments = input.assignments && typeof input.assignments === 'object' ? input.assignments : {};
  // подчистка мощностей
  for (const w of s.workshops) {
    w.role = w.role === 'aux' ? 'aux' : 'main';
    w.capacities = { cut: 1, sew: 1, iron: 1, otk: 1, ...(w.capacities || {}) };
    for (const k of ['cut', 'sew', 'iron', 'otk']) w.capacities[k] = Math.max(1, +w.capacities[k] || 1);
  }
  for (const a of s.articles) {
    a.plan = a.plan && typeof a.plan === 'object' ? a.plan : {};
    a.matrix = a.matrix && typeof a.matrix === 'object' ? a.matrix : {};
    a.fabricPerUnit = +a.fabricPerUnit > 0 ? +a.fabricPerUnit : 1.6;
    a.colors = Array.isArray(a.colors) ? a.colors : [];
    a.sizes = Array.isArray(a.sizes) ? a.sizes : [];
    // держим plan[stage] в синхроне с суммой матрицы (если матрица задана)
    for (const stageId of Object.keys(a.matrix)) {
      const sum = sumMatrixStage(a.matrix[stageId]);
      if (sum > 0) a.plan[stageId] = sum;
    }
  }
  return s;
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

// суммарный объём этапа по артикулу.
// Источник истины — матрица размер×цвет; если её нет, берём plan[stageId].
export function stageUnits(article, stageId) {
  const m = article.matrix && article.matrix[stageId];
  const fromMatrix = m ? sumMatrixStage(m) : 0;
  if (fromMatrix > 0) return fromMatrix;
  return Math.max(0, Math.round(+((article.plan || {})[stageId]) || 0));
}
