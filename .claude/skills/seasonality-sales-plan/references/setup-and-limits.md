# Настройка окружения и лимиты

## Переменные окружения
- `MPSTATS_TOKEN` — **обязателен**. Токен MPStats (заголовок `X-Mpstats-TOKEN`).
- `MPSTATS_BASE_URL` — необяз., по умолчанию `https://mpstats.io/api`.
- `Wildberries_API` (или `WB_API_TOKEN`) — токен WB Seller API (для стороны «свои»).
- `WB_TOKEN_TYPE` — `personal|service|base|test` (по умолчанию personal).
- `REPORT_CONCURRENCY` — параллелизм per-SKU fallback (по умолчанию 5).

## Лимиты MPStats
- Суточный лимит запросов (429 «Превышен лимит…»). Конвейер ловит и останавливается.
- **Экономия:** дневные ряды берутся из графиков `POST /wb/get/category` — вся
  группа одним запросом (не по SKU). Прогноз ≈ 4 запроса. Узкий фильтр → несколько
  страниц (по 1000 строк). Крупная страница выгоднее многих мелких (1 запрос = 1
  единица лимита).

## Лимиты WB Seller API (строгие, риск бана)
- Персональный/сервисный токен: **300 запросов/мин**, интервал **200 мс**, burst **20**.
- Базовый/тестовый: 150 запросов/мин, burst 10.
- **Ошибка 4XX = 10 запросов** (быстро жжёт бюджет) — минимизировать ошибки.
- Заголовки: `X-Ratelimit-Remaining` (сколько можно сейчас), при 429 —
  `X-Ratelimit-Retry` (через сколько секунд повтор), `X-Ratelimit-Reset`.
- Соблюдается встроенным `TokenBucket` в `lib/wbClient.js`. Не обходить лимитер.
- Проверка токена: `node scripts/wb-token-check.mjs`.
- Документация: `docs/wb-api/` (limits.md, analytics.md, reports-statistics.md).

## Хосты WB API (lib/wbClient.js)
content · statistics · analytics (seller-analytics) · prices · marketplace ·
promotion · feedbacks · chat · documents · common.
