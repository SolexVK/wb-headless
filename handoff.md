# Handoff — инструменты для Wildberries

Ветка: **`claude/wildberries-tools`**. Продолжаем разработку инструментов здесь.
(Ветка `claude/wildberries-api-docs-bfnvun` — отдельная, там только правила WB API.)

## Цель
Каскад инструментов для WB: ТОП-10 по запросу → фильтр → «Сравнение карточек» →
«Конкурентный анализ». Инструменты сцепляются через общий JSON-контракт (ключ `nmId`).
Архитектура и контракт — в `docs/pipeline/README.md`.

## Текущее состояние (что работает)
- **Правила/база WB API** (перешли из соседней ветки): `lib/wbClient.js` (лимиты,
  token-bucket, X-Ratelimit, ретраи), `lib/wbToken.js` + `npm run token:check`,
  снимки доки `docs/wb-api/*`, скилл `wb-docs`. Токен WB — рабочий (env `Wildberries_API`).
- **Джем-отчёты (API)**: `lib/wbJemReports.js` + `scripts/wb-jem-report.mjs`
  (`npm run cards:compare` не путать — это `jem`: create→status→getFile, лимиты зашиты).
- **Вход в кабинет (браузер)**: `lib/wbCabinet.js` — куки + localStorage-токен через
  Playwright storageState, обход антибота + TLS1.2 под прокси. Проверка сессии:
  `npm run cabinet:check`. Разведка страниц: `scripts/wb-cabinet-open.mjs`.
- **«Сравнение карточек» (готово, проверено на аккаунте)**: `lib/wbCardsCompare.js`
  + `scripts/wb-cards-compare.mjs`. DRY-RUN (без траты лимита) / `--submit` (тратит 1)
  / `--export-existing` (пере-скачать готовое бесплатно). Выгрузка XLSX
  автоматизирована (Создать Excel→Сформировать→Загрузки→скачать→развернуть ZIP).
- **Экстрактор данных**: `lib/wbCardsCompareParse.js` — XLSX → нормализованный JSON
  (метрики воронки по nmId: CTR, конв. в корзину/заказ, % выкупа, показы, заказы…).
  `runCardsComparison` сам пишет `*.json` рядом с `*.xlsx`.
- Скилл `wb-cards-compare`.
- **[1] ТОП-N по запросу (MPStats) — ГОТОВО, ПРОВЕРЕНО ЖИВЫМ ТОКЕНОМ** —
  `lib/wbTopKeywords.js` + `scripts/wb-top-keywords.mjs` (`npm run top:keywords`).
  По ключевому запросу берёт поисковую выдачу WB из MPStats, фильтрует («уточнения»:
  `min-revenue/min-rating/min-reviews/min-sales`, ценовой коридор, `exclude-brands`,
  `sort`) и отдаёт контракт `top-rivals`. Флаг `--nmids-only` сцепляет [1]→[2] пайпом
  в `wb-cards-compare`. Транспорт — `fetchSearchResults` в `lib/mpstats.js`.
  **Эндпоинт залочен**: `POST https://mpstats.io/api/analytics/v1/wb/search/items`
  (новый versioned API, Laravel 422-валидация). Ключевое слово — query-параметр
  **`path`** (обязателен), период — `d1`/`d2` (важно: `d2` строго РАНЬШЕ сегодня,
  иначе 422 — дефолт ставит d2=вчера), тело — ag-grid `{startRow,endRow}`. Ответ —
  `{total, data:[{position,id,...}]}`, где `id` = nmId. Маппинг полей в
  `normalizeSearchRow` совпал (`id/name/brand/final_price/rating/comments/sales/
  revenue/position`) — правок не потребовал. Старый `/wb/get/search` оказался
  html-заглушкой (пустой 200) — тупик. Живой прогон: 99 шт. выдачи → фильтр → топ-N,
  `--nmids-only` даёт чистый JSON-массив nmId. Всё зелено.

## Что дальше (следующий шаг)
Эндпоинт MPStats залочен и [1] проверен вживую (см. выше). Осталось два куска:
- **[3] Конкурентный анализ** — на входе `cards-compare.json` (готов из [2]:
  нормализованные метрики воронки по nmId — CTR, конв. в корзину/заказ, % выкупа,
  показы, заказы). Сформировать сравнительный анализ «наш vs конкуренты»: где
  проседаем по воронке, ценовое позиционирование, выводы/рекомендации. Отдать
  JSON-контракт + человекочитаемый отчёт.
- **Оркестратор** `scripts/wb-pipeline.mjs` — сцепка [1]→[2]→[3] одной командой
  (запрос → топ-N конкурентов → сравнение карточек → конкурентный анализ).

## Важно про секреты (иначе кабинет не откроется)
Куки/токен кабинета живут в `.secrets/` (gitignored) и **в новую сессию НЕ переносятся**.
В начале работы проверить: `npm run cabinet:check`. Если «не авторизованы» — попросить
у пользователя свежие куки (Cookie-Editor→Export JSON) и localStorage-токен
(`wb-eu-passport-v2.access-token` и др.), положить в `.secrets/wb-cookies.json` и
`.secrets/wb-localstorage.txt`, ИЛИ задать env `WB_COOKIES` / `WB_LOCALSTORAGE`.
Токен WB API (для Джем-отчётов) — env `Wildberries_API` (может уже быть в среде).
Токен MPStats (для [1] ТОП-N) — env `MPSTATS_TOKEN` (заголовок `X-Mpstats-TOKEN`).
Проверить: `[ -n "$MPSTATS_TOKEN" ]`. Если пусто — добавить в переменные окружения среды.

## Команды для проверки
```bash
node --check lib/*.js scripts/*.mjs      # синтаксис
npm run token:check -- --ping            # токен WB API жив? (ожидаем HTTP 200)
npm run cabinet:check                    # сессия кабинета жива? (нужны .secrets или env)
npm run cards:compare -- --our <nm> --rivals <nm,nm>   # DRY-RUN (без траты лимита)
npm run top:keywords -- --query "платье женское" --top 10   # [1] — нужен MPSTATS_TOKEN
```
Ожидаемое «зелёное»: синтаксис чист; `token:check --ping` = 200 если задан `Wildberries_API`;
`cabinet:check` = «АВТОРИЗОВАНЫ» только при наличии свежих кред (иначе честно скажет обновить);
`top:keywords` = JSON `top-rivals` если задан `MPSTATS_TOKEN` (иначе честно попросит токен).
NB: свежий контейнер — сначала `npm install` (иначе `cabinet:check` упадёт без playwright).

## Открытые вопросы (нужно решение пользователя)
Блокеров нет. [1] ТОП-N готов и залочен (`MPSTATS_TOKEN` в среде подхватился, эндпоинт
подтверждён живьём). Двигаемся к [3] Конкурентный анализ + оркестратор.
