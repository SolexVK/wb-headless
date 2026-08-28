# WB API: методы, токены, лимиты

Первоисточник — <https://dev.wildberries.ru/docs/openapi/api-information>.
Снимки страниц документации лежат в ветке `claude/losses-wildberries-p8dhw6`
(`docs/wb-api/`). Ниже — то, что проверено живыми запросами.

## Токен

Один токен с нужными категориями: **Финансы** (детализация отчётов),
**Аналитика** (возвраты, удержания, хранение, приёмка), **Статистика**
(заказы, продажи), **Маркетплейс** (сборочные задания, склады продавца).

Резолвер `lib/wbToken.js` ищет токен по очереди:
`WB_API_TOKEN` → `Wildberries_API` (env) → те же ключи в `.env`.
Категории зашиты в сам JWT (поле `s` — битовая маска), срок — в `exp`.

## Лимиты запросов

Базовый лимит на аккаунт (период — 1 минута):

| Тип токена | Лимит | Интервал | Всплеск |
|---|---|---|---|
| Персональный / Сервисный | 300/мин | 200 мс | 20 |
| Базовый / Тестовый | 150/мин | 200 мс | 10 |

**У отдельных методов лимит жёстче базового** — он указан на странице метода:

| Метод | Лимит |
|---|---|
| `POST /api/finance/v1/sales-reports/detailed` | **1 запрос в минуту**, всплеск 1 |
| `POST /api/finance/v1/sales-reports/list` | 1 запрос в минуту |
| `GET /api/v1/analytics/goods-return` | 1 запрос в минуту (всплеск 10) |
| `GET /api/v1/supplier/orders`, `/sales` | 1 запрос в минуту |
| Отчёты об удержаниях (`/api/analytics/v1/*`) | 1 запрос в минуту |
| `GET /api/v3/orders`, `/api/v3/warehouses` | базовый лимит категории |

На 429 WB присылает `X-Ratelimit-Retry` (**секунды до повтора**) — ждать надо
ровно столько; `Retry-After` тут ни при чём. В обычных ответах приходит
`X-Ratelimit-Remaining` — остаток всплеска. Прочие 4xx повторять нельзя:
это ошибка запроса, а в категории «Маркетплейс» один 4xx стоит как 10 запросов.

Всё это уже реализовано в `lib/wbClient.js` (token bucket на каждый метод,
ожидание по `X-Ratelimit-Retry`, отсутствие повторов на 4xx).

## Методы, которые нужны расследованию

| Что нужно | Метод | Хост |
|---|---|---|
| Построчная детализация удержаний | `POST /api/finance/v1/sales-reports/detailed` | finance-api |
| Контрольные суммы отчётов (сверка) | `POST /api/finance/v1/sales-reports/list` | finance-api |
| Возвраты: ПВЗ, даты готовности и выдачи | `GET /api/v1/analytics/goods-return` | seller-analytics-api |
| Заказы и отмены (`isCancel`, `cancelDate`) | `GET /api/v1/supplier/orders` | statistics-api |
| Продажи и возвраты по срид | `GET /api/v1/supplier/sales` | statistics-api |
| Сборочные задания FBS (склад, время постановки) | `GET /api/v3/orders` | marketplace-api |
| Склады продавца (ФФ) | `GET /api/v3/warehouses` | marketplace-api |
| Тарифы коробов и коэффициенты складов | `GET /api/v1/tariffs/box` | common-api |
| Удержания за габариты | `GET /api/analytics/v1/measurement-penalties` | seller-analytics-api |
| Замеры склада | `GET /api/analytics/v1/warehouse-measurements` | seller-analytics-api |
| Подмены и неверные вложения | `GET /api/analytics/v1/deductions` | seller-analytics-api |
| Самовыкупы | `GET /api/v1/analytics/antifraud-details` | seller-analytics-api |
| Маркировка | `GET /api/v1/analytics/goods-labeling` | seller-analytics-api |
| Платное хранение (задачей) | `GET /api/v1/paid_storage` + `/tasks/{id}/status`/`download` | seller-analytics-api |
| Платная приёмка (задачей) | `GET /api/v1/acceptance_report` + задачи | seller-analytics-api |

## Особенности детализации

- Периодичность: `period: 'weekly'` (отчёт о реализации) или `'daily'`.
  **Для свежих коротких окон нужен `daily`**: недельный отчёт закрывается по
  понедельникам, и запрос «последние 7 дней» вернёт обрезанную неделю —
  логистика и штрафы в ней будут нулями.
- Пагинация курсорная: `rrdId` последней строки предыдущего ответа, до `204`.
- Числа приходят **строками** (`"367"`, `"12647.29"`), даты — RFC3339 (МСК).
- Имена полей camelCase: `deliveryService` (логистика), `paidStorage`,
  `paidAcceptance`, `penalty`, `deduction`, `additionalPayment`, `forPay`,
  `retailAmount`, `bonusTypeName`, `sellerOperName`, `vendorCode`,
  `warehouseLogisticsCoeff`, `srid`, `shkId`, `giId`, `rrdId`.
- Старый `statistics-api /api/v5/supplier/reportDetailByPeriod` в актуальной
  документации отсутствует — использовать Finance API.
