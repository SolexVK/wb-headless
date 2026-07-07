# Telegram-бот WB-скиллов — архитектура

Статус: **согласовано** (черновик v1). Ветка разработки: `claude/telegram-bot-skills-81540d`.

Бот, который по требованию пользователя подтягивает нужный WB-скилл, собирает у
пользователя входные данные (кнопки/диалог), выполняет скилл и возвращает готовый
отчёт в чат в выбранном формате. Скиллы добавляются постепенно — **добавить скилл =
добавить манифест**, без переписывания ядра бота.

---

## 1. Зафиксированные решения

| # | Решение | Выбор |
|---|---|---|
| 1 | Кабинеты WB | **Один кабинет на всех** (одна компания, несколько операторов). Креды в защищённом server env. Данные общие; разграничение — на уровне доступа и **персональной выдачи**. |
| 2 | Хранилище SQLite | **Временно — git-commit модель** (`data/wb.db` коммитится в ветку, как у scheduled-отчётов). Переход на persistent volume (VPS/контейнер) — позже, аддитивно. |
| 3 | Инженерный режим | **Только админам по коду.** Код скилла = продакшн; обычные пользователи видят только запуск отчётов. |

Схема БД заранее несёт `telegram_id` владельца и per-user настройки, поэтому будущий
переход на мульти-тенант (свой кабинет у каждого) и на persistent volume — аддитивный,
без ломки.

### Жёсткие правила (инварианты)

1. **Отчёты с истекающим доступом качаем немедленно.** Любой источник, где сам отчёт
   доступен ограниченное время (WB «Сравнение карточек» — **72 ч**), материализуется в
   момент создания: сразу скачиваем файл + парсим в структурированный JSON и кладём **и
   данные, и сырой файл** в БД. После истечения 72 ч доступ к WB-отчёту сгорает, а наши
   данные и файл остаются. Мы **никогда** не полагаемся на то, что отчёт можно будет
   до-скачать позже.
2. **Кэшируем атомарные вытяжки, а не только финальные отчёты** (см. §4).
3. **Персональная выдача.** Результат job уходит только в чат владельца.
4. **Лимиты уважаются семафорами** по источникам (см. §6).

---

## 2. Компоненты

```
Telegram ──► Bot API layer (grammY) ──► FSM диалога (per user)
                                             │
                                             ▼
                                     Очередь задач (jobs)
                                             │
                              ┌──────────────┼───────────────┐
                              ▼              ▼               ▼
                         Executor        Cache/Dedup     Rate-limiters
                       (cli / claude)   (source_cache)   (семафоры источников)
                              │
                              ▼
                     Канонический результат (JSON)
                              │
                        Renderer (HTML / PDF / XLSX по шаблонам скилла)
                              │
                              ▼
                     Telegram document ──► чат владельца
```

1. **Bot API layer** — grammY (Node, TypeScript/JS). Меню, инлайн-клавиатуры, приём
   документов (для кред кабинета). Хэндлеры без состояния; состояние диалога — в БД.
2. **Реестр скиллов (манифесты)** — один манифест на скилл (§7). Меню строится из реестра.
3. **FSM диалога** — конечный автомат на `(telegram_id, skill_run)`, персистится в БД
   (переживает рестарт бота). Стадии — §8.
4. **Очередь задач + воркеры** — параллельные сессии; каждый job несёт `telegram_id`
   владельца и `chat_id` для персональной выдачи.
5. **Executor-адаптер** — по манифесту: `cli` (spawn `npm run …`, парсим JSON/файлы) для
   механики; `claude` (headless Claude Code сессия со скиллом) для аналитики/интерактива;
   гибрид на уровне манифеста.
6. **Cache/Dedup** — перед каждым дорогим запросом смотрит `source_cache` (§4).
7. **Renderer** — из канонического JSON рендерит HTML/PDF/XLSX по **шаблонам скилла** (§5).
8. **Инженерный режим** — по коду, только админам; открывает Claude-сессию, привязанную к
   файлам скилла (§9).
9. **Секреты** — `.env` вне git, права `600`; загрузка через dotenv (§9).

---

## 3. Исполнитель скиллов (гибрид A + CLI)

Согласовано: вариант **A (Claude Agent SDK / headless)**, но алгоритмическую часть,
уже зашитую в скрипты, гоним **напрямую через CLI**.

| Скилл | Механика (CLI напрямую) | Аналитика/интерактив (Claude) |
|---|---|---|
| `wb-top-keywords` | сбор выдачи, фильтры, HTML (`npm run top:keywords`) | подсказка стемов/групп, помощь с пикером |
| `wb-cards-compare` | headless-браузер, submit, экспорт XLSX (`npm run cards:compare`) | обработка «сессия протухла», DRY-RUN подтверждение |
| `wb-brand-keyword-sales` | pull продаж + агрегация + PDF (`npm run sales:by-keyword`) | оговорки атрибуции, разбор брендов |
| `wb-competitor-analysis` | движок `wb_analyze.py` (слой A) | **ручной слой B** из базы знаний (существенный) |

Манифест объявляет для каждого шага, кто исполнитель.

---

## 4. Данные, кэш и реюз

### 4.1 Двухслойный кэш

**Слой 1 — сырые вытяжки (жгут лимиты/токены).** Кэшируем агрессивно по естественному
ключу + свежесть.

| Вытяжка | Ключ дедупа (`key_json`) | Свежесть | Реюз |
|---|---|---|---|
| MPStats: выдача по фразе | `{phrase, d1, d2, filters_hash}` | период в прошлом → неизменно | top-keywords, brand-sales, competitor-analysis |
| MPStats: ниша по категории | `{path, gender, d1, d2}` | неизменно | competitor-analysis |
| MPStats: дневной ряд SKU | `{wb, date}` (в `sku_daily`) | неизменно | stock, все |
| WB Statistics: продажи | `{nmIds_hash, from}` + max `lastChangeDate` | дозапись; реюз если уже тянули ≥ | brand-sales |
| **WB кабинет: воронка** | `{our, rivals_sorted_hash}` | **источник 72 ч**, данные — снимок навсегда | cards-compare, блок воронки competitor-analysis |
| WB card.json (контент/хар-ки/**imtID**) | `{nmId}` | TTL ~дни | competitor-analysis (F2), склейка |

**Правило:** перед дорогим запросом — lookup по `(source, key_hash)` в окне свежести.
Попадание → берём из кэша, лимит не тратим.

**Слой 2 — снимки готовых отчётов.** Канонический результат в JSON сохраняется один раз
(`skill_runs.result_json`, ключ `skill + params_hash`). Форматы HTML/PDF/XLSX рендерятся
**лениво** по выбору пользователя и кэшируются (`skill_artifacts`).

### 4.2 Правило 72 ч (материализация)

`cards-compare --submit`:
1. WB генерирует сравнение (тратит 1 из месячного лимита).
2. **Немедленно**: скачать XLSX → распарсить воронку в JSON.
3. Записать: структурированные данные в `source_cache` (снимок воронки, `expires_at`
   для данных = ∞); **сырой XLSX — как BLOB** в `report_files` (переживёт git-commit, т.к.
   попадёт в `wb.db`); отметить `source_expires_at = now + 72h` (когда сгорит WB-доступ).
4. В пределах 72 ч и если нужен именно WB-файл — `--export-existing` (бесплатно). После —
   отдаём наш сохранённый файл/данные; повторный `--submit` (трата лимита) — только по
   явному «нужны свежие».

### 4.3 Реюз по склейке (`imtID`)

Все цветовые варианты одной карточки делят `imtID`. Храним `imt_id ↔ nm_id ↔ color`
(`card_variants`, из card.json). Тогда для competitor-analysis по цвету B:
- нишевый слой (выдача по фразе, категория, сезонность, ТОП-конкуренты) **цвето-независим
  → реюзается целиком** от цвета A;
- различается только карточный блок G (воронка) — и то лишь если для нового цвета реально
  нужен свежий submit.

Итог: на склейке из N цветов дорогой нишевый анализ считается один раз, а не N.

### 4.4 Миграция БД v2 (поверх ветки `claude/database-branch-bx2f5u`)

Добавляется новым элементом в массив `MIGRATIONS` (`lib/db.js`), применится только новое.

```sql
-- v2 — слой бота
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  telegram_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                  -- 'brands', 'default_sku', пресеты…
  value       TEXT,
  PRIMARY KEY (telegram_id, key)
);

-- Слой 1: атомарные вытяжки, дедуп по (source, key_hash)
CREATE TABLE IF NOT EXISTS source_cache (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,            -- 'mpstats.search' | 'wb.sales' | 'wb.cards-compare' | 'wb.card' …
  key_hash          TEXT NOT NULL,            -- sha256(key_json)
  key_json          TEXT NOT NULL,            -- читаемый ключ (phrase/d1/d2/…)
  entity            TEXT,                     -- напр. WB nmId / фраза
  captured_at       TEXT NOT NULL,
  expires_at        TEXT,                     -- валидность НАШЕГО кэша (NULL = ∞)
  source_expires_at TEXT,                     -- когда сгорит доступ у ИСТОЧНИКА (72 ч у WB)
  cost_units        REAL DEFAULT 0,           -- сколько лимита стоила вытяжка (телеметрия)
  payload_json      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_cache_key ON source_cache(source, key_hash);

-- Сырые файлы отчётов (BLOB), чтобы пережить истечение доступа у источника
CREATE TABLE IF NOT EXISTS report_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,                  -- откуда (напр. 'wb.cards-compare')
  entity      TEXT,                           -- к чему относится
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_files ON report_files(source, entity, captured_at);

-- Склейка по цветам
CREATE TABLE IF NOT EXISTS card_variants (
  imt_id     INTEGER NOT NULL,
  nm_id      INTEGER NOT NULL,
  color      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (imt_id, nm_id)
);
CREATE INDEX IF NOT EXISTS idx_card_variants_nm ON card_variants(nm_id);

-- Прогоны скиллов (снимок отчёта + статус)
CREATE TABLE IF NOT EXISTS skill_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER,                       -- владелец (персональная выдача)
  skill        TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  params_hash  TEXT NOT NULL,                 -- дедуп одинаковых прогонов
  status       TEXT NOT NULL,                 -- queued|running|awaiting_user|done|error
  started_at   TEXT,
  finished_at  TEXT,
  result_json  TEXT,                          -- канонический результат (слой 2)
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_runs ON skill_runs(skill, params_hash, status);

-- Лениво отрендеренные файлы формата (кэш)
CREATE TABLE IF NOT EXISTS skill_artifacts (
  run_id     INTEGER NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
  format     TEXT NOT NULL,                   -- 'html'|'pdf'|'xlsx'
  file_id    INTEGER REFERENCES report_files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, format)
);
```

`source_cache` — типизированный наследник существующего `tool_exports`: тот же принцип
«пиши JSON сразу», плюс `key_hash` (быстрый дедуп) и две метки времени (наш TTL и TTL
источника). Существующие `tool_exports`/`report_runs`/`sku_daily` остаются как есть.

> Замечание к git-commit модели: BLOB-файлы в `wb.db` раздувают репозиторий. Пока это
> временный вариант — приемлемо (`cards-compare` редкий, лимит ~20/мес). При переходе на
> volume вынесем BLOB на диск, оставив в БД путь. Это изолированное изменение.

---

## 5. Формы-шаблоны под каждый формат (HTML / PDF / XLSX)

У каждого скилла — **три шаблона отчёта**, каждый спроектирован под свою разметку. Рендер
единый: `render(skill, format, resultJson) → file`. Один канонический JSON → три формы.

Конвенция расположения (рядом со скиллом):

```
.claude/skills/<skill>/templates/
  report.html.js    # HTML: фото, цвет, кликабельные артикулы, интерактив (тема, чек-листы)
  report.pdf.js     # PDF: печатная раскладка (обычно HTML-шаблон + print-CSS → htmlToPdf)
  report.xlsx.js    # XLSX: схема листов и колонок (exceljs)
```

- **HTML** — нативный рендер, самодостаточный (фото в data-URI), интерактив. У части скиллов
  уже есть (`top-keywords`, `competitor-analysis`).
- **PDF** — как правило тот же HTML под print-CSS через существующий `lib/htmlToPdf.js`
  (headless Chromium); ссылки на карточки WB остаются кликабельными.
- **XLSX** — через `exceljs`: под каждый скилл свой набор листов/колонок (для `cards-compare`
  наш презентационный XLSX строится из распарсенной воронки, а не из сырого WB-файла — сырой
  лежит отдельно в `report_files`).

Манифест перечисляет поддерживаемые форматы; после прогона бот спрашивает формат кнопками
`HTML / PDF / XLSX`, renderer берёт нужный шаблон, файл кэшируется в `skill_artifacts` и
уходит документом в чат.

---

## 6. Очередь, параллелизм, лимиты

- Каждый запуск скилла = job в очереди с `telegram_id`/`chat_id` владельца.
- Пул воркеров → параллельные сессии разных пользователей.
- **Семафоры по источникам** (общие на всех, т.к. кабинет один):
  - `wb.cards-compare.submit` — конкурентность **1** (месячный лимит + одна браузер-сессия).
  - `wb.sales` — **1 запрос/мин** (пауза 66 с уже в `pullSales`).
  - `mpstats` — дневной лимит токена; при 429 — понятная ошибка пользователю, не «нет данных».
- Дедуп прогонов по `params_hash`: одинаковый запрос в окне свежести отдаёт кэш, а не новый
  расход лимита.

---

## 7. Манифест скилла

Один файл на скилл (напр. `bot/skills/<skill>.manifest.js`) — источник правды для меню,
формы, mid-flow шагов, исполнителя и форматов. **Добавить скилл = добавить манифест.**

```js
export default {
  id: 'wb-top-keywords',
  title: '🔍 Конкуренты по запросу',          // человекочитаемо, для меню
  description: 'ТОП выдачи WB по фразе + фильтры + список артикулов конкурентов',
  adminOnly: false,
  engineeringMode: true,                       // доступен инженерный режим (админам)

  // Форма: собирается кнопками/вводом; advanced прячется под «⚙️ Настроить»
  fields: [
    { key: 'query',    label: 'Ключевая фраза', type: 'text',   required: true },
    { key: 'period',   label: 'Период',         type: 'choice', required: true,
      options: [ {v:7,l:'7 дней'}, {v:30,l:'30 дней'}, {v:90,l:'90 дней'}, {v:'custom',l:'Свои даты'} ] },
    { key: 'top',      label: 'Размер топа',     type: 'choice', required: true,
      options: [ {v:10,l:'10'}, {v:20,l:'20'}, {v:100,l:'100'} ], note: 'потолок выдачи ~100' },
    { key: 'groups',   label: 'Группы-признаки', type: 'text',   advanced: true,
      hint: 'имя = стем1, стем2 (стемами без окончаний)' },
    { key: 'exclude',  label: 'Слова-исключения',type: 'text',   advanced: true },
    { key: 'priceMin', label: 'Цена от, ₽',      type: 'number', advanced: true },
    { key: 'priceMax', label: 'Цена до, ₽',      type: 'number', advanced: true },
    { key: 'our',      label: 'Наш артикул (исключить)', type: 'number', advanced: true },
  ],

  // Шаги выполнения: кто исполнитель + где человек в цикле
  steps: [
    { id: 'fetch',  executor: 'cli',
      cmd: (p) => ['run','top:keywords','--','--query',p.query, /* … */ ] },
    { id: 'pick',   interaction: 'pick-list',   // печатает таблицу-пикер, ждёт выбор 2–4 конкурентов
      prompt: 'Выберите 2–4 конкурента (номера строк или nmId)' },
  ],

  formats: ['html', 'pdf', 'xlsx'],

  // Ключи кэша, которые этот скилл читает/пишет (Слой 1)
  cache: {
    reads:  ['mpstats.search'],
    writes: ['mpstats.search'],
  },
};
```

Поля-виджеты: `text | number | choice | multichoice | date-range | file`. Mid-flow
интеракции: `pick-list` (top-keywords), `confirm-dry-run` (cards-compare), `creds-refresh`
(протухшая сессия).

---

## 8. Машина состояний диалога

```
idle
  └─(выбор скилла из меню)─► collecting        # опрос обязательных полей, затем «⚙️ Настроить» для advanced
        └─(все поля)──────► confirm            # показать сводку → «Запустить»
              └─(запуск)──► queued ─► running
                                  │
                                  ├─(mid-flow: pick-list / dry-run)─► awaiting_user ─►(ответ)─► running
                                  │
                                  ├─(ошибка: сессия протухла)──────► awaiting_creds ─►(файлы)─► running
                                  │
                                  └─(готово)──► choose_format        # кнопки HTML/PDF/XLSX
                                                    └─(формат)─► delivering ─► delivered
```

Состояние на каждый `skill_run` персистится в БД → рестарт бота не теряет диалог.
`awaiting_user`/`awaiting_creds` — точки, где job приостановлен и ждёт Telegram-ответ владельца.

---

## 9. Безопасность и секреты

- **Кабинет один** → `MPSTATS_TOKEN`, `Wildberries_API`, куки/`localStorage` кабинета живут в
  `.env` на сервере бота. `.env` — вне git (в `.gitignore`), права файла `600`, значения не
  логируются. Куки кабинета — в `.secrets/*` (gitignored), как сейчас в `wb-cards-compare`.
- **Разграничение доступа** — по `users.role` и белому списку `telegram_id`. Персональная
  выдача — job знает владельца.
- **Инженерный режим** — только `role='admin'` + код активации на скилл. Открывает Claude-
  сессию с инструментами, ограниченными директорией скилла (`.claude/skills/<skill>/` + его
  `lib/`/`scripts/`). Правки уходят в git через обычный флоу ветки.
- **Обновление кред кабинета** — по сценарию из `wb-cards-compare` (пользователь-админ шлёт
  свежий экспорт кук + `localStorage`), бот кладёт в `.secrets/`.

---

## 10. Этапы реализации

1. ✅ **Каркас данных.** Слой БД перенесён в ветку бота; миграция v2 (`users`,
   `user_settings`, `source_cache`, `report_files`, `card_variants`, `skill_runs`,
   `skill_artifacts`) + хелперы (кэш с дедупом/свежестью, BLOB-файлы, склейка, прогоны,
   реюз, артефакты) написаны и покрыты дым-тестом. Боевая `data/wb.db` — на `user_version=2`.
2. ✅ **Реестр + первый манифест.** `bot/core/registry.js` (загрузка/валидация
   манифестов + помощники формы: `menuItems`/`formPlan`/`missingRequired`/`withDefaults`) и
   `bot/skills/wb-top-keywords.manifest.js` (форма с обяз./advanced полями и `showIf`,
   mid-flow пикер, `buildArgv`, ключ кэша `mpstats.search`, 3 формата). Покрыто дым-тестом
   (19 проверок). Конвенция манифеста — `bot/README.md`.
3. **Каркас бота** (grammY): меню из реестра, FSM, персист состояния, очередь+воркеры.
   - 3a ✅ **Сбор формы + подтверждение.** `bot/index.js` (grammY), `bot/core/fsm.js`
     (чистая логика диалога: collect → advanced_offer → advanced_menu → confirm, с
     валидацией ввода и авто-переходами), `bot/core/keyboards.js`, `bot/core/session-store.js`
     (персист диалога в `bot_sessions`, миграция v3). На «Запустить» показывается собранная
     CLI-команда. Дым-тесты FSM/реестра (42 проверки) зелёные; бот поднимается и опрашивает
     Telegram (@solexvk_wb_tools_bot). Токен — в `.env` (вне git).
   - 3b ⏳ Очередь + воркеры + реальное выполнение первого скилла через CLI.
   - 3c ⏳ Mid-flow пикер конкурентов + выбор формата + выдача.
4. **Executor** (cli) + Cache/Dedup поверх `source_cache`.
5. **Renderer** + 3 шаблона для первого скилла (HTML/PDF/XLSX).
6. Подключение остальных скиллов манифестами (`cards-compare` с правилом 72 ч → `brand-sales`
   → `competitor-analysis` с реюзом по склейке).
7. Инженерный режим (админ + код).
8. Переезд на persistent volume (BLOB → диск), когда появится VPS/контейнер.

---

## 11. Открытые вопросы (на потом)

- Библиотека бота — **grammY** (подтверждено).
- Формат «пресетов» пользователя (сохранённые бренды/наш арт.) в `user_settings`.
- Нужен ли просмотр истории отчётов из чата (поиск по `skill_runs` — индексация по скиллу,
  дате, артикулу уже заложена).
