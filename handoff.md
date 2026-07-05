# Handoff — инструменты для Wildberries

Ветка: **`claude/resume-qfogf2`** (продолжение `claude/wildberries-tools`, вся история перенесена).
Продолжаем разработку инструментов здесь.
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
- **[1] ТОП-N по запросу (MPStats)** — `lib/wbTopKeywords.js` + `scripts/wb-top-keywords.mjs`
  (`npm run top:keywords`). По ключевому запросу берёт поисковую выдачу WB из MPStats,
  фильтрует («уточнения»: `min-revenue/min-rating/min-reviews/min-sales`, ценовой коридор,
  `exclude-brands`, `sort`) и отдаёт контракт `top-rivals`. Флаг `--nmids-only` сцепляет
  [1]→[2] пайпом в `wb-cards-compare`. Транспорт — `fetchSearchResults` в `lib/mpstats.js`.
  Чистая логика (нормализация/фильтр/сортировка/топ-N) **проверена на фикстуре — зелено**.

## Что дальше (следующий шаг)
**Залочить эндпоинт MPStats живым токеном и прогнать сквозной тест [1].**
- Токен: `MPSTATS_TOKEN` (заголовок `X-Mpstats-TOKEN`). Пользователь добавляет его в
  переменные окружения среды Claude Code (то же место, где `Wildberries_API`) — подхватится
  в НОВОЙ сессии. GitHub-секрет `secrets.MPSTATS_TOKEN` прочитать нельзя (write-only).
- Путь запроса уже сужен пробой без токена: **`/wb/get/search`** (реальный `401 Authorization
  Required` = маршрут есть; `/wb/get/search/results` давал `405`). Осталось с токеном:
  подтвердить метод (GET/POST), имя query-параметра (`query` vs `path`) и маппинг полей
  ответа на контракт (`nmId/name/brand/price/rating/reviews/sales/revenue/position` в
  `normalizeSearchRow`). Всё вынесено в env: `MPSTATS_SEARCH_PATH`, `MPSTATS_SEARCH_QUERY_PARAM`.
- Живой тест: `npm run top:keywords -- --query "платье женское" --top 10 --min-rating 4.5`.
  Если поля/путь не совпали — поправить дефолты в `lib/mpstats.js` / `normalizeSearchRow`.
- Затем: **[3] Конкурентный анализ** (данные `cards-compare.json` готовы) и оркестратор
  `scripts/wb-pipeline.mjs` (сцепка [1]→[2]→[3]).

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
Оба закрыты: начинаем с **[1] ТОП-N**, источник конкурентов — **MPStats** (парсинг поисковой
выдачи по запросу с фильтрацией). Актуальный блокер — не вопрос, а действие: добавить
`MPSTATS_TOKEN` в переменные окружения среды (см. «Следующий шаг»).
