# Handoff — Производственный план (planner)

## Цель
Веб-инструмент планирования отшива рубашек: план продаж (детализация размер×цвет) →
партии по цехам → Гант → факт производства → заказ ткани → мультисезон. Развёрнут на
Mac mini пользователя (Tailscale). Ветка: `claude/production-plan-twv8ki`.

## Текущее состояние
- **Работает**, развёрнут на Mac mini как служба launchd. Доступ по Tailscale:
  `http://100.108.217.93:8477` (порт 8477; логин `admin` + пароль из env `PLANNER_PASSWORD`).
- **7 вкладок**: Гант, План по размерам, План продаж, Факт, Заказ ткани, Дашборд, Данные.
- Пользователь ВНЁС реальные данные (артикулы, цеха, расход/цена ткани) в UI на проде.
- **Модель на ПАРТИЯХ** — ядро. Старые сохранения мигрируют автоматически (normalizeState).
- **8 вкладок** (добавлена «Ранг сезонности» между Дашбордом и Данными).
- **ПОСЛЕДНЕЕ (эта сессия):** фикс сумм (`664a7fa`); образцы на диск + DnD цветов (`ae2a2d9`);
  импорт/экспорт .xlsx (`94ff991`); **раздел «Ранг сезонности»** — порт движка (`3490abe`) + UI (`4199f74`).
  По «единый vs по-этапно» — подтверждено: **по-этапно ВЕРНО** (планировщик изолирует этапы).
- **«Ранг сезонности»** (новое): строит прогноз плана продаж по конкурентам (MPStats). Часть 1 —
  конструктор фильтра+период+«Построить»; Часть 2 — накопитель: графики (спрос/цена/остатки,
  полосы фаз) + таблица по дням/неделям/месяцам с раскраской по этапам. Пока АВТОНОМНО (не подаёт
  в произв. план — по решению пользователя, связку сделаем позже). Движок в `planner/lib/season/`,
  планы в `planner/data/plans/<art>.json`. **Нужен `MPSTATS_TOKEN`** (см. ниже).
- **ВАЖНО про деплой:** после каждого пуша давать пользователю полную команду обновления
  (git pull + npm install в planner/ + launchctl unload/load + Cmd+Shift+R). Npm можно НЕ
  запускать, если менялся только фронт/вендор (новых npm-зависимостей нет — SheetJS вендорен файлом).

## Файлы, над которыми работали
- `planner/lib/model.js` — `pruneMatrix(M, article)` (чистка «сирот»), вызывается в `ensurePartias`.
- `planner/server.js` — **эта сессия:** образцы ткани на диск: `SAMPLES_DIR=planner/data/samples`,
  `/samples` статикой, `POST /api/sample` (data:→файл `<sha1>.<ext>`), `migrateSamples()` в
  loadState/saveState (переносит встроенные data:-образцы в файлы, одноразово, идемпотентно).
- `planner/public/app.js` — **эта сессия:** (a) клиентский `pruneMatrix`/`pruneArticlePartias`
  на правке sizes/colors; (b) DnD-цветов: `bindColorDnD`, `colorDragSrc`, ручка `.swatch-drag`;
  (c) загрузка образца шлёт на `/api/sample`, в state — только путь; (d) xlsx: `planAoAForArticle`,
  `exportPlanXlsx`, `parsePlanWorkbook`, `importPlanAnyFile` (xlsx/tsv по расширению).
- `planner/public/index.html` — подключён `vendor/xlsx.full.min.js` до `app.js`.
- `planner/public/styles.css` — стили `.swatch-drag`, `.swatch-item.dragging/.drop-target`.
- `planner/public/vendor/xlsx.full.min.js` — **НОВЫЙ**, вендорен SheetJS 0.18.5 (Apache-2.0, 881 КБ),
  НЕ в .gitignore (закоммичен), даёт глобал `window.XLSX`; npm-зависимости не нужны.
- (ранее) `planner/lib/scheduler.js`, `planner/public/gantt.js` — партии, Факт, Гант (не менялись).

## Что изменилось (эта сессия)
1. **Баг сумм («осиротевшие» ключи).** Причина: `sumMatrix(M)` считает по ВСЕМ ключам
   матрицы, а итоги по строкам/столбцам — по `a.sizes`/`a.colors` (подмножество). После
   удаления/переименования размера или цвета его количества оставались в `planMatrix`/
   `factMatrix` под старым ключом → «ВСЕГО» ≠ Σстолбцов ≠ Σстрок. Само добавление размера
   сумму не ломало; ломало именно накопление сирот от прошлых удалений.
2. **Фикс — чистка матриц до реальных цветов/размеров артикула:**
   - Сервер (`model.js`): `pruneMatrix` в `ensurePartias` → при загрузке И сохранении
     (`loadState`/`saveState` оба зовут `normalizeState`) сироты убираются автоматически,
     чинит и уже испорченные сохранения.
   - Клиент (`app.js`): при правке размерного ряда/цветов в «Данные» — мгновенная чистка
     всех партий артикула, суммы сходятся ещё до нажатия «Сохранить».
3. Затрагивает ВСЕ листы с матрицей (План по размерам, Факт, План продаж) и своды
   (Дашборд, Заказ ткани) — все они считают grand через `sumMatrix`, а строки/столбцы через
   `a.sizes`/`a.colors`; после чистки эти числа тождественно равны.

## Что пробовали и НЕ сработало (грабли — важно!)
- **`page.evaluate` НЕ видит `state`/`matrixArticleId`** — это переменные ES-модуля, не
  на `window`. Браузерные smoke-тесты надо гонять ЧЕРЕЗ DOM: читать `#mx-article`,
  `[data-grand]`, `[data-coltot]`, `[data-rowtot]`; для правки размеров в «Данные» —
  найти `input[data-f="id"]` со значением = artId, взять его `data-art` индекс, затем
  `input[data-art="<idx>"][data-f="sizes"]`, поменять value и `dispatchEvent('change')`.
- **Chrome для puppeteer** лежит по `/root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome`
  (НЕ `./chrome`, как в старых заметках). Запуск: `puppeteer.launch({executablePath: EXE, headless:'new', args:['--no-sandbox']})`.
- **`STATE_FILE` жёстко зашит** в `planner/data/state.json` (env для пути нет). Тестовый
  сервер создаёт этот файл сидом; после теста я его удалил (он gitignored) — на репо не влияет.
- Единственная безвредная ошибка консоли — 404 favicon (игнорировать).
- **Прошлые грабли (актуальны):** `position:sticky` ломается при `html,body{height:100%}`
  (проверять липкость замером `getBoundingClientRect().top`, не скриншотом); фильтр сезона
  на Ганте мерить только на АКТИВНОЙ вкладке Гант; `AskUserQuestion` в этой сессии падает
  (`permission stream closed`) — развилки задавать текстом; `npm install` на Mac mini висел
  из-за сломанного PROXY в npm-конфиге (не puppeteer); порт 8090 занят OpenClaw → 8477;
  кириллица в WWW-Authenticate роняла auth → realm ASCII "Planner".

## Команды для проверки
Локально (dev-контейнер, зависимости в корне стоят):
```bash
# синтаксис всех модулей
node --check planner/server.js && node --check planner/lib/scheduler.js \
  && node --check planner/lib/model.js && node --check planner/public/app.js \
  && node --check planner/public/gantt.js

# планировщик на сиде (ожидаем: cycles 20 warnings 0)
node -e 'import("./planner/lib/model.js").then(async({defaultState})=>{const{buildSchedule}=await import("./planner/lib/scheduler.js");const s=buildSchedule(defaultState());console.log("cycles",s.cycles.length,"warnings",s.warnings.length)})'

# партии: миграция + нумерация по цехам (ожидаем 20 партий, matrix удалён, сезонов 1)
node -e 'import("./planner/lib/model.js").then((M)=>{const s=M.normalizeState(M.defaultState());console.log("партий",s.partias.length,"matrix удалён",s.articles.every(a=>!a.matrix),"сезонов",s.seasons.length)})'

# ФИКС СУММ: впрыснуть сироту и проверить, что normalizeState вычищает (grand==cols, orphan gone true)
node -e 'import("./planner/lib/model.js").then(({normalizeState,defaultState})=>{const sumAll=M=>{let s=0;for(const c in M){const r=M[c]||{};for(const k in r)s+=+r[k]||0}return s};let s=normalizeState(defaultState());const p=s.partias.find(x=>sumAll(x.planMatrix)>0);const a=s.articles.find(x=>x.id===p.articleId);for(const c of a.colors){p.planMatrix[c]=p.planMatrix[c]||{};p.planMatrix[c]["PHANTOM"]=99}s=normalizeState(s);const p2=s.partias.find(x=>x.id===p.id);const a2=s.articles.find(x=>x.id===a.id);const cols=a2.colors.reduce((n,c)=>n+a2.sizes.reduce((m,z)=>m+(+((p2.planMatrix[c]||{})[z])||0),0),0);console.log("grand",sumAll(p2.planMatrix),"cols",cols,"orphan gone",!Object.values(p2.planMatrix).some(r=>"PHANTOM"in r))})'

# поднять локально (браузерные проверки — одноразовыми _*.mjs через puppeteer,
# chrome по /root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome)
PLANNER_PORT=8477 node planner/server.js
```
Формальных unit-тестов НЕТ. Браузерные smoke-тесты — временные `_*.mjs` в корне, удаляются.

**Ожидаемое зелёное сейчас:** все `node --check` проходят; планировщик `cycles 20 warnings 0`;
партий 20, matrix удалён, сезонов 1; фикс сумм — `grand==cols`, `orphan gone true`;
браузер: после удаления размеров у артикула `[data-grand] == Σ[data-coltot] == Σ[data-rowtot]`
(проверено — 979=979=979 на арт. 004). Прод: `curl -s -o /dev/null -w "%{http_code}"
localhost:8477/api/health` → 401. Красных нет.

## Открытые вопросы (нужно решение пользователя)
Все 4 прежних вопроса ЗАКРЫТЫ в этой сессии:
1. ✅ Реальные данные — пользователь внёс сам в UI.
2. ✅ «Единый vs по-этапно» — ПО-ЭТАПНО верно (подтверждено описанием процесса), не менялось.
3. ✅ Импорт — сделан через .xlsx (лист=артикул, блоки по этапам). Мульти-партийность внутри
   одного артикул+этап (несколько цехов в одном блоке) по-прежнему грузит в ПЕРВУЮ партию —
   если понадобится, добавить колонку WORKSHOP в блок STAGE.
4. ✅ Образцы ткани — вынесены на диск (planner/data/samples), с авто-миграцией.
Открытых блокеров НЕТ. Возможное на будущее: экспорт Ганта/отчётов; мульти-партийный импорт;
хард-лимит числа образцов не нужен (диск).

## Ранг сезонности — важное для возобновления
- Движок портирован из ветки `origin/claude/sales-plan-hzlqew` (skill `seasonality-sales-plan`)
  в `planner/lib/season/` (mpstats, salesPlan, forecast, seasonPlanReport, reportExport, xlsxWriter) —
  БЕЗ npm-зависимостей. Обёртка `planner/lib/seasonApi.js` (runForecast режим B, savePlan/listPlans).
- Эндпоинты: `GET /api/season/status|categories|plans|plan`, `DELETE /api/season/plan`,
  `POST /api/season/build`. Планы — отдельными JSON в `planner/data/plans/` (gitignored).
- **Токен MPStats:** в dev-контейнере он В ОКРУЖЕНИИ (`MPSTATS_TOKEN`, `Wildberries_API`) — не в git.
  На Mac mini задаётся файлом `planner/data/.env` (`MPSTATS_TOKEN=…`, gitignored) — сервер грузит
  его сам (loadDotenv). Проверка: `/api/season/status` → `{hasToken:true}`.
- Данные из движка (для UI): `report.plan.forecastDaily[{date,stage,favorable,plannedOrders,price,stock}]`,
  `historyDaily[{…,sales,…}]`, `rank{rank,amplitude,p90,p50}`, `phases.stageOfMonth`, `favorable{months}`.
  7 этапов (raw-строки): вход/разгон/старт сезона/пик сезона/начало распродажи/конец распродажи/межсезонье.
- Тест реальным вызовом MPStats: build обычно 3 запроса (bulk), ~секунды. НЕ гонять лишний раз (лимит).
- **Следующий шаг по этому направлению (позже, по словам пользователя):** отдельный механизм
  преобразования данных ранга сезонности → готовый план продаж по месяцам/этапам/артикулам/цветам/размерам.
  Сейчас раздел АВТОНОМЕН (построил→сохранил→смотришь). НЕ подключать к произв. плану без запроса.

## Следующий шаг
Пользователь: обновить прод, задать `MPSTATS_TOKEN` в `planner/data/.env`, проверить раздел
«Ранг сезонности» (построить план по артикулу, посмотреть графики/таблицу). Затем — следующая правка.
Блокеров нет.

### Проверка нового (dev)
```bash
# xlsx round-trip, миграция образцов, DnD цветов — тестировались одноразовыми _*.mjs (puppeteer).
# Ключевое ожидаемое: POST /api/sample → {ok,path}; GET /samples/<f> → 200; в state.json 0 "data:image";
# экспорт .xlsx → правка ячейки +100 → импорт → grand +100; DnD ручкой ⠿ меняет порядок a.colors.
node --check planner/server.js && node --check planner/public/app.js && echo OK
```

### Обновление прода (Mac mini) — давать после каждого пуша
```bash
cd ~/wb-headless && git pull origin claude/production-plan-twv8ki
git log --oneline -1   # ожидаем 664a7fa (или новее)
cd planner && npm install --prefer-offline --ignore-scripts --no-audit --no-fund && cd ..
launchctl unload ~/Library/LaunchAgents/com.wbheadless.planner.plist
launchctl load   ~/Library/LaunchAgents/com.wbheadless.planner.plist
```
Затем в браузере `Cmd+Shift+R`. Старые «съехавшие» суммы починятся сами при первом
открытии/сохранении (сироты вычистятся в normalizeState).
