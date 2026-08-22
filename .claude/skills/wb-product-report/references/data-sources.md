# Источники данных и карта полей

## MPStats (нужен `MPSTATS_TOKEN`, заголовок `X-Mpstats-TOKEN`; суточный лимит → 429)

| Функция (`lib/mpstats.js`) | Эндпоинт | Что даёт |
|---|---|---|
| `fetchSearchResults(query,{d1,d2})` | POST `/analytics/v1/wb/search/items?path=<q>&d1&d2` (body `{startRow,endRow}`) | Выдача по фразе (до ~100), поля как у категории + `position`. `total`=предложение по фразе. |
| `fetchCategory(path,d1,d2,{maxRows,pageSize})` | POST `/wb/get/category?path&d1&d2` (body `{startRow,endRow,filterModel,sort:[{colId:'revenue',sort:'desc'}]}`) | Товары категории (сортировка по выручке), постранично. |
| `fetchItemFull(sku,d1,d2)` | GET `/wb/get/item/{sku}/full?d1&d2` | Карточка: `brand`, `link`, `photo.list[].f` (big webp), `balance`, `stock{fbo,fbs}`, `period_stats`. |
| `fetchItemDailySales(sku,d1,d2)` | GET `/wb/get/item/{sku}/sales?d1&d2` | Дневной ряд: `data`(дата), `balance`, `sales`, `final_price`, `price`. **Нет поля revenue** → считать `sales×final_price`. |

**Ключевые поля строки товара** (`normalizeCategoryRow` / search): `id`(sku), `name`, `brand`,
`seller`, `supplier_id`, `color`, `final_price`, `revenue`, `sales`(штуки), `lost_profit`(упущенка),
`lost_profit_percent`, `purchase`(выкуп %), `balance`, `size_count`, `size_count_in_stock`, `rating`,
`comments`, `thumb`, `thumb_middle`, `url`, `sku_first_date`, `sales_graph`/`revenue_graph`/
`stocks_graph`/`price_graph`.

**`period_stats`** (в `/full`): `revenue`, `sales`, `lost_profit`, `lost_profit_percent`, `purchase`
(выкуп %, оценочно на уровне категории!), `revenue_potential`, `days_in_stock`.

**Деньги в отчёте:** выручка=`period_stats.revenue`; штуки=`sales`; ср.цена продажи=выручка/штуки
(снимка цены в period_stats нет); заработал=выручка×`purchase`%; упущено=`lost_profit`.

## Публичные API WB (квоту MPStats НЕ тратят)

### card.json (характеристики, отзывы-id, описание)
- Базовый путь берём из URL фото: `photo.list[0].f` = `//basket-XX.wbbasket.ru/volA/partB/<sku>/images/big/1.webp`
  → `basketBaseFromPhoto` → `<base>/info/ru/card.json` (`lib/wbPublic.js:fetchCardJson`).
- Даёт: `imt_id` (для отзывов), `imt_name`, `subj_name`, `description`, `options[]` (характеристики:
  Состав, Цвет, Пол, Покрой, Вид застежки, Фактура… — **у блузок часто НЕТ «Длина рукава»**),
  `nm_colors_names`, `colors`, `sizes_table`.
- Ключевые запросы (SEO/принадлежность) — `keyQueriesFromCard`: из imt_name + пол+предмет+атрибуты.

### feedbacks (отзывы)
- `https://feedbacks2.wb.ru/feedbacks/v1/{imt_id}` (фолбэк `feedbacks1`) — `lib/wbPublic.js:fetchReviews`.
- Даёт: `feedbackCount`(всего), `valuation`(рейтинг), `feedbacks[]` (до ~1000 последних) с полями
  `text`, `pros`, `cons`, `productValuation`(звёзды), `color`, `size`, `matchingSize`(маломерит/
  большемерит/соответствует), `matchingPhoto`, `matchingDescription`, `answer`, `createdDate`, `votes`.
- Классификация (`lib/reviewsClassify.js`): по звёздам, по темам (размер/ткань/пошив/цвет/фурнитура/
  запах/доставка/качество), проблемные кластеры (где преобладает негатив), «что доработать» +
  сигнал соответствия размеру.

### search.wb.ru (выдача для конкурентов и размеров; **поминутный rate-limit → 429**)
- `https://search.wb.ru/exactmatch/ru/common/v9/search?appType=1&curr=rub&dest=-1257786&query=<q>&resultset=catalog&sort=popular&spp=30&page=<n>`
- Товар: `id`, `root`, `brand`, `supplierId`, `name`, `reviewRating`/`rating`, `feedbacks`(кол-во),
  `sizes[]` (`name`/`origName`, `price.{total|product}` в копейках), `colors`, `totalQuantity`, `pics`.
- Диагональное сканирование (`lib/diagonalScan.js:scanArticle`): по ключевому запросу берём выдачу,
  находим позицию своей карточки и реальных конкурентов (по числу отзывов, ≠ свой бренд, пустышки-
  новинки с 1 отзывом отсекаем), считаем гэпы (цена/рейтинг/отзывы/размерный ряд/видимость).
- Преобладающие размеры (`fetchDominantSizes`): агрегируем `sizes[].name` по нескольким страницам.
- **429**: ретрай с backoff (`searchJsonRetry`, до 12 попыток) — хост общий с диаг.сканированием.

### Фото
- `photo.list[0].f` (big) / `.t` (c246x328); также `thumb_middle` (c516x688) / `thumb` (c246x328)
  из строк категории/поиска. Скачивать в data-URI с несколькими кандидатами и ретраями
  (webp c basket CDN бывает нестабилен). Фото первого слайда = кадр `1.webp`.
- URL карточки товара: `https://www.wildberries.ru/catalog/{sku}/detail.aspx`.

## Периоды
- d2 должен быть СТРОГО раньше сегодня (иначе 422). Год: d1 = d2−364 дн. 3 месяца: d1 = d2−91 дн.

## Что где хранится (артефакты)
- `reports-output/` (в .gitignore): `*.pdf`, `*.html` (широкий интерактив), `*-book.html` (книжный),
  `*.json` (данные без тяжёлых data-URI, с `hasImg`). Слаг: `shirts-analysis-<skus>-<d1>_<d2>`.
