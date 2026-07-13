# MPStats API — справка для навыка

**База:** `https://mpstats.io/api` · **Авторизация:** заголовок `X-Mpstats-TOKEN: <токен>`
(альтернатива — query `?auth-token=<токен>`). Content-Type для POST: `application/json`.

## Используемые методы

| Метод | Что даёт | Параметры |
|-------|----------|-----------|
| `GET wb/get/categories` | всё дерево категорий WB (`{url,name,path}`) | — |
| `POST wb/get/category` | товары категории с метриками | query: `path`, `d1`, `d2`; body: `{startRow,endRow,sort:[{colId,sort}],filterModel}` |
| `GET wb/get/category/sellers` | продавцы категории | `path`, `d1`, `d2` |
| `GET wb/get/category/brands` | бренды категории | `path`, `d1`, `d2` |
| `GET wb/get/category/trends` | динамика категории по датам | `path`, `d1`, `d2` |
| `GET wb/get/category/price_segmentation` | распределение по ценовым сегментам | `path`, `d1`, `d2` |
| `GET wb/get/item/{sku}/sales` | продажи/остатки конкретной карточки | `d1`, `d2` |
| `POST analytics/v1/wb/search/items` | выдача по ключевому запросу (фаза 2, «от спроса») | query: `path`=запрос, `d1`, `d2`; body: `{startRow,endRow}` |

**Поисковая выдача (фаза 2).** Рабочий эндпоинт — `POST /analytics/v1/wb/search/items` (залочен
живым токеном). Ключевое слово идёт в query-параметре `path`; ответ `{total,data:[...]}`, где
`total` = кол-во карточек по запросу (предложение), `id`=nmId. `d2` должен быть СТРОГО раньше
сегодня (иначе 422). Старый `/wb/get/search` — html-заглушка (пустой 200), НЕ использовать.
Частотность (спрос) этот эндпоинт не отдаёт — источник в API не подтверждён (Оракул — Wildbox).

`filterModel` — формат AG-Grid, напр. фильтр по названию:
`{"name":{"filterType":"text","type":"contains","filter":"полос"}}`.

## Ключевые поля товара (из wb/get/category)

- Идентификация: `id` (SKU), `name`, `brand`, `seller`, `supplier_id` (→ ссылка на витрину
  `wildberries.ru/seller/<id>`), `color`, `subject`, `category`.
- Ассортимент: `size_count`, `size_count_in_stock` (размерный ряд — для планки входа).
- Продажи/выручка: `sales`, `sales_per_day_average`, `sales_estimated`, `revenue`,
  `revenue_potential`, `percent_from_revenue`, `lost_profit`, `lost_profit_percent`.
- Цена: `final_price`, `final_price_average`, `basic_price`, `client_price`, структура скидок
  (`basic_sale`, `promo_sale`, `client_sale`), `wallet_price`.
- Остатки/логистика: `balance`, `balance_fbs`, `turnover_days`, `days_in_stock`, `is_fbs`,
  `warehouses_count`, `commission_fbo`, `commission_fbs`.
- Контент/качество: `rating`, `comments`, `picscount`, `hasvideo`, `has3d`,
  `latest_negative_comments_percent`, `description_length`.
- SEO/видимость: `search_visibility`, `search_position_avg`, `category_position`,
  `category_visibility`, `search_words_count`, `search_cpm_avg`.
- Графики по дням (массивы): `sales_graph`, `revenue_graph`, `stocks_graph`, `price_graph`,
  `search_position_graph`, `category_position_graph`. Движок агрегирует `sales_graph`/`stocks_graph`
  поэлементно по всем товарам и группирует по месяцам → **помесячная реализация остатка** (временнáя
  диаграмма благоприятных окон). После агрегации дневные массивы удаляются из JSON (не раздувать вывод).

## Ошибки
- Ошибки приходят **конвертом** `{"code": <int>, "message": "..."}` (а не пустыми данными). Движок
  (`curl_json`) распознаёт `code >= 400` и бросает `MpstatsError`. Частые:
  - **429** — `Превышен лимит запросов за <дата>`: исчерпан дневной лимит → ждать/поднять тариф.
  - **401/403** — токен/доступ: проверить `MPSTATS_TOKEN` и что `mpstats.io` разрешён сетью.
- За **будущие** даты (если часы контейнера опережают горизонт данных MPStats) срез приходит пустым
  (`{data:[], total:0}`) — это не ошибка API, а отсутствие данных за период.

## Замечания
- Данные оценочные: MPStats восстанавливает продажи по остаткам и выкупам, это не отчёт из
  кабинета продавца. Использовать для сравнения/ранжирования, не как бухгалтерию.
- Лимиты по частоте запросов — не гнать перебор без нужды; дерево категорий кэшируется.
- Пол/категории: женское — корень `Женщинам`, мужское — `Мужчинам`, детское — `Детям`.
