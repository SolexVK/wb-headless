# Handoff — Производственный план (planner)

## Цель
Веб-инструмент планирования отшива рубашек: план продаж (детализация размер×цвет) →
партии по цехам → Гант → факт производства → заказ ткани → мультисезон. Развёрнут на
Mac mini пользователя (Tailscale). Ветка: `claude/production-plan-twv8ki`.

## Текущее состояние
- **Работает**, развёрнут на Mac mini как служба launchd. Доступ по Tailscale:
  `http://100.108.217.93:8477` (порт 8477; логин `admin` + пароль из env `PLANNER_PASSWORD`).
- **7 вкладок**: Гант, План по размерам, План продаж, Факт, Заказ ткани, Дашборд, Данные.
- Данные — сид-пример (5 артикулов, 6 цехов, 1 сезон). Реальные цифры пользователь не вносил.
- **Модель на ПАРТИЯХ** — ядро. Старые сохранения мигрируют автоматически (normalizeState).
- **ПОСЛЕДНЕЕ (эта сессия): исправлен баг с суммами.** После удаления/переименования
  размера/цвета количества оставались в матрицах партий «сиротами» → общая сумма их
  учитывала, а итоги по строкам/столбцам нет → суммы на листах расходились. Пофикшено
  чисткой матриц (см. «Что изменилось»). Коммит `664a7fa`, запушен.
- **ВАЖНО про деплой:** после каждого пуша давать пользователю полную команду обновления
  (git pull + npm install в planner/ + launchctl unload/load + Cmd+Shift+R).

## Файлы, над которыми работали
- `planner/lib/model.js` — **эта сессия:** добавлен `export function pruneMatrix(M, article)`;
  вызывается в `ensurePartias` для plan/factMatrix каждой партии (т.е. при каждой
  загрузке/сохранении через normalizeState старые «сироты» чинятся сами).
- `planner/public/app.js` — **эта сессия:** клиентские `pruneMatrix(M, a)` и
  `pruneArticlePartias(a)`; вызываются в `bindDataEvents` при правке полей `sizes`/`colors`
  артикула в «Данные» — партии сразу приводятся к текущему набору (суммы совпадают ДО
  сохранения). Оба хендлера теперь делают `pruneArticlePartias(a); mark(); renderData(); return;`.
- (ранее) `planner/lib/scheduler.js`, `planner/public/gantt.js`, `index.html`, `styles.css` —
  партии, Факт, Гант, мультисезон, темы (в этой сессии не менялись).

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
1. **Реальные данные — ЖДУ:** мощности цехов (крой/пошив/утюжка/ОТК шт/день, осн/вспом),
   расход ткани м/шт и цена $/м по артикулам — заменить сид.
2. **«Единый план для всех этапов»?** Сейчас модель хранит ОТДЕЛЬНУЮ план-матрицу на каждый
   этап (как в исходной Google-таблице). Если пользователь имел в виду ОДНУ матрицу на
   артикул для всех этапов — это другая структура. Оставлено по-этапно, он не возражал.
3. **Импорт партий при нескольких партиях на артикул+этап:** сейчас шаблон грузит в ПЕРВУЮ
   партию (или создаёт). Мульти-партийный импорт не сделан.
4. **Хранение образцов ткани** в state.json (лимит ~1 МБ/файл) — при десятках распухнет.
   На будущее вынести в отдельное хранилище. Не срочно.

## Следующий шаг
Дождаться, пока пользователь обновит прод (команды ниже) и подтвердит, что суммы теперь
сходятся на всех листах. Затем — реальные данные ИЛИ следующая правка. Блокеров нет.

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
