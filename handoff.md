# Handoff — Производственный план (planner)

## Цель
Веб-инструмент планирования отшива рубашек: план продаж (детализация размер×цвет) →
партии по цехам → Гант → факт производства → заказ ткани → мультисезон, плюс раздел
**«Ранг сезонности»** (прогноз плана продаж по конкурентам через MPStats). Развёрнут на
Mac mini пользователя (Tailscale). Ветка: `claude/production-plan-twv8ki`.

## Текущее состояние
- **Работает**, развёрнут на Mac mini как служба launchd. Доступ по Tailscale:
  `http://100.108.217.93:8477` (порт 8477; логин `admin` + пароль из env `PLANNER_PASSWORD`).
- **8 вкладок**: Гант, План по размерам, План продаж, Факт, Заказ ткани, Дашборд,
  **Ранг сезонности**, Данные.
- Реальные данные (артикулы, цеха, расход/цена ткани) пользователь внёс в UI на проде.
- **Модель на ПАРТИЯХ** — ядро производственного плана. Старые сохранения мигрируют
  автоматически (normalizeState).
- **Эта сессия (всё запушено):** фикс сумм (`664a7fa`); образцы ткани на диск + DnD
  цветов (`ae2a2d9`); импорт/экспорт .xlsx (`94ff991`); раздел «Ранг сезонности» —
  порт движка + API (`3490abe`), UI (`4199f74`), docs токена (`6ad732e`).
- **По «единый vs по-этапно»** — подтверждено: **по-этапно ВЕРНО** (4 этапа = 4 разных
  объёма под пары месяцев; планировщик изолирует этапы, не залезает в следующий).
- **«Ранг сезонности» пока АВТОНОМЕН** (построил → сохранил → смотришь графики/цифры).
  НЕ подаёт данные в производственный план — по решению пользователя; связку сделаем позже.
- **ВАЖНО про деплой:** после каждого пуша давать полную команду обновления (см. низ файла).
  `npm install` можно НЕ запускать, если менялся только фронт/вендор/сезонный движок —
  новых npm-зависимостей нет (SheetJS вендорен файлом, сезонный движок на чистом Node).

## Файлы, над которыми работали (за сессию)
Производственный план:
- `planner/lib/model.js` — `pruneMatrix(M, article)` (чистка «осиротевших» цветов/размеров),
  вызывается в `ensurePartias`; хранит `a.seasonFilter` (конфиг фильтра сезонности).
- `planner/server.js` — образцы ткани на диск (`SAMPLES_DIR`, `/samples` статикой,
  `POST /api/sample`, `migrateSamples()` в load/save); `loadDotenv()` (грузит
  `planner/data/.env`); эндпоинты `/api/season/*`.
- `planner/public/app.js` — клиентский `pruneMatrix`/`pruneArticlePartias`; DnD цветов
  (`bindColorDnD`, ручка `.swatch-drag`); загрузка образца → `/api/sample` (в state путь);
  xlsx (`exportPlanXlsx`/`parsePlanWorkbook`/`importPlanAnyFile`); **раздел сезонности**
  (`renderSeason` и всё `season*`/`se*`).
- `planner/public/index.html` — вкладка «Ранг сезонности»; подключён `vendor/xlsx.full.min.js`.
- `planner/public/styles.css` — стили `.swatch-drag`, `.se-*` (карточки, графики, таблица).
- `planner/public/vendor/xlsx.full.min.js` — вендорен SheetJS 0.18.5 (Apache-2.0, 881 КБ), закоммичен.

Ранг сезонности (движок портирован из `origin/claude/sales-plan-hzlqew`):
- `planner/lib/season/{mpstats,salesPlan,forecast,seasonPlanReport,reportExport,xlsxWriter}.js`
  — движок как есть, БЕЗ npm-зависимостей (Node fetch + собственный xlsx).
- `planner/lib/seasonApi.js` — обёртка: `runForecast` (режим B: предмет+фильтр, база=рынок),
  `searchCategories`, `savePlan/loadPlan/deletePlan/listPlans`, `default2Years`.
- `planner/deploy/com.wbheadless.planner.plist`, `planner/DEPLOY.md` — слот/инструкция MPSTATS_TOKEN.

## Что изменилось (по сути)
1. **Фикс сумм.** `sumMatrix` считал по ВСЕМ ключам матрицы, а строки/столбцы — по
   `a.sizes`/`a.colors`. После удаления/переименования размера/цвета оставались «сироты» →
   «ВСЕГО» ≠ Σстолбцов ≠ Σстрок. `pruneMatrix` чистит матрицы: на сервере в `ensurePartias`
   (при каждой load/save чинит и старые данные), на клиенте при правке sizes/colors.
2. **Образцы ткани на диск** (`planner/data/samples/<sha1>.<ext>`), в state — только путь;
   встроенные data:-образцы мигрируют автоматически. `fabricImgSrc` работает и с data:, и с путём.
3. **DnD-порядок цветов** в «Данные» (ручка ⠿) — переставляет `a.colors`; все листы
   итерируют `a.colors`, fabricInfo/матрицы ключуются по имени → порядок применяется везде.
4. **.xlsx импорт/экспорт** плана (лист=артикул, блоки по этапам) вместо TSV; `importPlanAnyFile`
   разбирает по расширению (xlsx/tsv).
5. **Раздел «Ранг сезонности».** Часть 1 — конструктор (артикул, путь предмета WB + поиск,
   слова/исключения/цены/лимит, период, OOS/недельный) → `POST /api/season/build` (MPStats,
   ~3 запроса) → сохранение + запоминание фильтра в `a.seasonFilter`. Часть 2 — накопитель:
   выбор артикула → сводка (ранг, штук, цены, благоприятные месяцы) + 2 SVG-графика
   (спрос синий / цена красный пунктир / остатки фиолетовый пунктир; фон-полосы этапов +
   золотые полосы благоприятных) + таблица по дням/неделям/месяцам с раскраской по этапам.

## Что пробовали и НЕ сработало (грабли — важно!)
- **`page.evaluate` НЕ видит `state`/`matrixArticleId`** — это переменные ES-модуля, не на
  `window`. Браузерные smoke-тесты гонять ЧЕРЕЗ DOM: читать `#mx-article`, `[data-grand]`,
  `.se-*`; для сезонного раздела — кликать вкладку по тексту, дёргать `#se-*` инпуты и
  `dispatchEvent('change')`.
- **`require()` вендоренного `xlsx.full.min.js` в Node НЕ даёт рабочий API** (нет
  `readFile`/`read` — это браузерный UMD). Поэтому xlsx round-trip тестировал ЦЕЛИКОМ
  В БРАУЗЕРЕ: перехватить `window.XLSX.writeFile` (забрать книгу без скачивания), поправить
  ячейку, `XLSX.write(wb,{type:'array'})` → `new File(...)` → положить в `#mx-import` через
  `DataTransfer` и `dispatchEvent('change')`.
- **Синтетический HTML5-DnD** (перестановка цветов) требует ОДИН общий `DataTransfer`,
  переданный в `dragstart`/`dragover`/`drop` (иначе `colorDragSrc` не проставится/дроп не сработает).
- **Chrome для puppeteer:** `/root/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome`
  (НЕ `./chrome`). Запуск: `puppeteer.launch({executablePath: EXE, headless:'new', args:['--no-sandbox']})`.
- **`STATE_FILE` жёстко зашит** в `planner/data/state.json` (env пути нет). Тестовый сервер
  создаёт его сидом; всё в `planner/data/` gitignored — на репо не влияет.
- **MPStats имеет суточный лимит** — НЕ гонять `POST /api/season/build` лишний раз. Один build
  = обычно 3 запроса (bulk по графикам категории). При 429 движок останавливается и пишет об этом.
- **MPSTATS_TOKEN НЕТ ни в одной ветке** (секреты не коммитятся — правильно). В dev-контейнере
  он в ОКРУЖЕНИИ (`printenv MPSTATS_TOKEN`). На Mac mini — в `planner/data/.env` (gitignored),
  сервер грузит `loadDotenv()`. Токен в handoff/репо НЕ писать.
- Единственная безвредная ошибка консоли — 404 favicon (игнорировать).
- **Прошлые грабли (актуальны):** `position:sticky` ломается при `html,body{height:100%}`
  (проверять `getBoundingClientRect().top`, не скриншотом); фильтр сезона на Ганте мерить
  только на АКТИВНОЙ вкладке; `npm install` на Mac mini висел из-за сломанного PROXY в
  npm-конфиге; порт 8090 занят OpenClaw → 8477; кириллица в WWW-Authenticate роняла auth → realm ASCII.

## Команды для проверки
Локально (dev-контейнер):
```bash
# синтаксис всех модулей (включая сезонный движок)
node --check planner/server.js && node --check planner/lib/scheduler.js \
  && node --check planner/lib/model.js && node --check planner/public/app.js \
  && node --check planner/public/gantt.js && node --check planner/lib/seasonApi.js \
  && for f in planner/lib/season/*.js; do node --check "$f"; done && echo ALL-CHECK-OK

# планировщик на сиде (ожидаем: cycles 20 warnings 0)
node -e 'import("./planner/lib/model.js").then(async({defaultState})=>{const{buildSchedule}=await import("./planner/lib/scheduler.js");const s=buildSchedule(defaultState());console.log("cycles",s.cycles.length,"warnings",s.warnings.length)})'

# партии + фикс сумм (ожидаем 20 партий, matrix удалён, сезонов 1; grand==cols, orphan gone true)
node -e 'import("./planner/lib/model.js").then((M)=>{const s=M.normalizeState(M.defaultState());console.log("партий",s.partias.length,"matrix удалён",s.articles.every(a=>!a.matrix),"сезонов",s.seasons.length)})'
node -e 'import("./planner/lib/model.js").then(({normalizeState,defaultState})=>{const sumAll=M=>{let s=0;for(const c in M){const r=M[c]||{};for(const k in r)s+=+r[k]||0}return s};let s=normalizeState(defaultState());const p=s.partias.find(x=>sumAll(x.planMatrix)>0);const a=s.articles.find(x=>x.id===p.articleId);for(const c of a.colors){p.planMatrix[c]=p.planMatrix[c]||{};p.planMatrix[c]["PHANTOM"]=99}s=normalizeState(s);const p2=s.partias.find(x=>x.id===p.id);const a2=s.articles.find(x=>x.id===a.id);const cols=a2.colors.reduce((n,c)=>n+a2.sizes.reduce((m,z)=>m+(+((p2.planMatrix[c]||{})[z])||0),0),0);console.log("grand",sumAll(p2.planMatrix),"cols",cols,"orphan gone",!Object.values(p2.planMatrix).some(r=>"PHANTOM"in r))})'

# поднять локально (MPSTATS_TOKEN уже в окружении dev-контейнера)
PLANNER_PORT=8477 node planner/server.js
# сезонность (dev): токен есть →
curl -s localhost:8477/api/season/status            # {"ok":true,"hasToken":true}
curl -s "localhost:8477/api/season/categories?q=%D1%80%D1%83%D0%B1%D0%B0%D1%88" # пути предметов
# build НЕ гонять зря (лимит MPStats). Планы: planner/data/plans/<art>.json
```
Формальных unit-тестов НЕТ. Браузерные smoke — временные `_*.mjs` в корне, удаляются.

**Ожидаемое зелёное сейчас:** все `node --check` проходят; планировщик `cycles 20 warnings 0`;
партий 20, matrix удалён, сезонов 1; фикс сумм `grand==cols`, `orphan gone true`;
образцы: `POST /api/sample`→`{ok,path}`, `GET /samples/<f>`→200, в state.json 0 `data:image`;
xlsx: экспорт→правка +100→импорт→`grand` +100; DnD ручкой ⠿ меняет порядок; сезонность:
`/api/season/status`→`hasToken:true`, build арт.004 = mode forecast, 243 дня прогноза,
UI рисует 4 карточки + 2 графика (6 polyline) + раскрашенную таблицу. Красных нет.

## Формат данных движка сезонности (для UI/связки в будущем)
`report.plan.forecastDaily[{date,stage,favorable,plannedOrders,price,stock,kSales,weekdayFactor}]`,
`historyDaily[{date,stage,favorable,sales,price,stock}]`, `rank{rank,amplitude,p90,p50}`,
`phases.stageOfMonth{1..12→этап}`, `favorable{months,share}`, `adjustments`, `weeklyProfile`.
7 этапов (raw-строки): `вход/разгон/старт сезона/пик сезона/начало распродажи/конец распродажи/межсезонье`.

## Открытые вопросы (нужно решение пользователя)
Активных блокеров НЕТ. На будущее (НЕ делать без явного запроса):
- **Связка сезонности → произв. план** (пользователь сказал «позже»): отдельный механизм
  преобразования `forecastDaily` → план продаж по месяцам/этапам/артикулам + разбивка по
  цветам/размерам. Сейчас раздел автономен. ЖДУ отдельного задания.
- Мульти-партийный импорт .xlsx (несколько цехов в одном блоке STAGE) — не сделан; при
  надобности добавить колонку WORKSHOP.
- Экспорт Ганта/отчётов — не делали.

## Следующий шаг
При возобновлении: прогнать «Команды для проверки», сверить зелёное. Ждём обратную связь
пользователя после обновления прода (задать `MPSTATS_TOKEN` в `planner/data/.env`, проверить
раздел «Ранг сезонности» на реальных фильтрах). Дальше — либо связка сезонности с произв.
планом (по заданию), либо следующая правка.

### Обновление прода (Mac mini) — давать после каждого пуша
```bash
cd ~/wb-headless && git pull origin claude/production-plan-twv8ki
git log --oneline -1   # ожидаем 6ad732e (или новее)
cd planner && npm install --prefer-offline --ignore-scripts --no-audit --no-fund && cd ..
launchctl unload ~/Library/LaunchAgents/com.wbheadless.planner.plist
launchctl load   ~/Library/LaunchAgents/com.wbheadless.planner.plist
```
Затем в браузере `Cmd+Shift+R`. Для сезонности один раз задать токен:
`echo 'MPSTATS_TOKEN=…' >> ~/wb-headless/planner/data/.env` и перезагрузить агент.
Старые «съехавшие» суммы и встроенные образцы чинятся/мигрируют сами при первом открытии/сохранении.
