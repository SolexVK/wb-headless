# wb-headless — карта проекта

Сервис и набор скриптов для регулярных отчётов по магазину на Wildberries.

## Где что лежит (чтобы не искать)

- **Документация WB API и лимиты → [`docs/wb-api/`](docs/wb-api/)** ⭐
  - [`docs/wb-api/README.md`](docs/wb-api/README.md) — как читать доку WB в обход
    антибота, **сводка лимитов**, правило «точечно читать лимит метода»,
    регламент еженедельного обновления.
  - [`docs/wb-api/limits.md`](docs/wb-api/limits.md) — снимок официальной
    страницы лимитов (первоисточник).
  - [`docs/wb-api/pages.json`](docs/wb-api/pages.json) — список страниц доки,
    которые обновляются автоматически.
- **Чтение/обновление доки WB:**
  `npm run docs:fetch -- <URL>` (любая страница) и `npm run docs:limits`
  (снимок лимитов). Механика — [`scripts/fetch-wb-docs.mjs`](scripts/fetch-wb-docs.mjs).
- **Клиент WB API (соблюдение лимитов):** [`lib/wbClient.js`](lib/wbClient.js)
  — token-bucket на категорию, `X-Ratelimit-*`, реакция на 429, без ретраев на 4xx.
- **Отчёт «наличие + упущенная выручка»:** [`REPORTS.md`](REPORTS.md),
  логика в [`lib/stockReport.js`](lib/stockReport.js), раннер `report-stock.js`.
- **Источники данных:** MPSTATS — [`lib/mpstats.js`](lib/mpstats.js);
  WB API — [`lib/wbClient.js`](lib/wbClient.js) (+ источники поверх него).
- **Конфиг товаров:** [`config/skus.json`](config/skus.json) (SKU↔артикул),
  [`config/groups.json`](config/groups.json) (линейки).

## Ключевое правило работы с WB API

Прямая работа с WB API опасна превышением лимитов (WB банит при каскаде 429).
**Перед использованием любого метода — точечно прочитать его страницу в доке и
взять его собственный лимит** (он часто строже базового), затем передать в
`WbClient` через `methodLimit`. Подробности — в `docs/wb-api/README.md`.

## Источники данных: WB API vs MPSTATS

- **Свой магазин** (продажи, остатки, финансы, упущенная выручка) → **WB API**:
  точнее (факт, а не оценка), бесплатно, без чужой квоты.
- **Рынок и конкуренты** (ниши, чужие продажи, SEO/ключевые слова) → MPSTATS/
  внешний сервис: WB API чужие данные не отдаёт.
