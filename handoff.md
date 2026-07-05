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

## Что дальше (следующий шаг)
Выбрать первый инструмент каскада для сборки:
- **[3] Конкурентный анализ** — есть готовые данные `cards-compare.json`, собрать блок
  воронки (мы vs конкуренты, разрывы, выводы). ← рекомендация: начать отсюда.
- **[1] ТОП-10 по ключевому запросу** + фильтр → отдаёт `rivals[]` для сравнения карточек.
  Источник: поисковая аналитика Джема (API, `search-report`, см. `docs/wb-api/analytics.md`)
  или парсинг публичной выдачи — **нужно решение пользователя**.
- Затем оркестратор `scripts/wb-pipeline.mjs` (сцепка этапов).

## Важно про секреты (иначе кабинет не откроется)
Куки/токен кабинета живут в `.secrets/` (gitignored) и **в новую сессию НЕ переносятся**.
В начале работы проверить: `npm run cabinet:check`. Если «не авторизованы» — попросить
у пользователя свежие куки (Cookie-Editor→Export JSON) и localStorage-токен
(`wb-eu-passport-v2.access-token` и др.), положить в `.secrets/wb-cookies.json` и
`.secrets/wb-localstorage.txt`, ИЛИ задать env `WB_COOKIES` / `WB_LOCALSTORAGE`.
Токен WB API (для Джем-отчётов) — env `Wildberries_API` (может уже быть в среде).

## Команды для проверки
```bash
node --check lib/*.js scripts/*.mjs      # синтаксис
npm run token:check -- --ping            # токен WB API жив? (ожидаем HTTP 200)
npm run cabinet:check                    # сессия кабинета жива? (нужны .secrets или env)
npm run cards:compare -- --our <nm> --rivals <nm,nm>   # DRY-RUN (без траты лимита)
```
Ожидаемое «зелёное»: синтаксис чист; `token:check --ping` = 200 если задан `Wildberries_API`;
`cabinet:check` = «АВТОРИЗОВАНЫ» только при наличии свежих кред (иначе честно скажет обновить).

## Открытые вопросы (нужно решение пользователя)
1. С какого инструмента начинаем — [3] Конкурентный анализ (рекомендация) или [1] ТОП-10?
2. Для [1]: источник конкурентов — API (Джем search-report) или парсинг выдачи?
