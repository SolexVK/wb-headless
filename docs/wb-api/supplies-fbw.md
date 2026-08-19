<!-- Источник: https://dev.wildberries.ru/docs/openapi/orders-fbw -->
<!-- Снимок официальной документации WB API. Обновляется скриптом scripts/refresh-wb-docs.mjs. Дату см. в истории git. -->

Документация
Журнал изменений
Swagger
Песочница
Статус API
Сообщество
База знаний
Еще
Документация
Журнал изменений
Swagger
Песочница
Статус API
Сообщество
База знаний
Войти
Общее
Работа с товарами
Заказы FBS
Заказы DBW
DBS
Самовывоз
Поставки FBW
Информация для формирования поставок
Информация о поставках
Маркетинг и продвижение
Общение с покупателями
Тарифы
Аналитика и данные
Отчёты
Документы и бухгалтерия
Поставки FBW
Узнать больше о поставках FBW можно в справочном центре

В разделе описаны методы получения:

информации для формирования поставок
информации о поставках

Вы можете создавать карточки товара в песочнице Контента, а потом использовать баркоды товаров в песочнице Поставок

Информация для формирования поставок
Для доступа к методам используйте токен для категории Поставки

Получение информации для формирования поставок на склады WB:

Опции приёмки
Список складов
Транзитные направления
Опции приёмки
/api/v1/acceptance/options
Prod
POST
https://supplies-api.wildberries.ru/api/v1/acceptance/options
Sandbox
POST
https://supplies-api-sandbox.wildberries.ru/api/v1/acceptance/options
Описание метода

Метод временно отключён

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	6 запросов	10 сек	6 запросов
Сервисный	1 мин	6 запросов	10 сек	6 запросов
Базовый с секретом	1 мин	6 запросов	10 сек	6 запросов
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
QUERY PARAMETERS
warehouseID	
integer
Example: warehouseID=507

ID склада.
Если параметр не указан, возвращаются данные по всем складам.
Максимум одно значение

REQUEST BODY SCHEMA: application/json
required
Array (<= 5000 items)
quantity	
integer [ 1 .. 999999 ]

Суммарное количество товаров, планируемых для поставки.
Максимум 999999


barcode	
string

Баркод из карточки товара

Ответы
200

Успешно

400

Некорректный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

404

Не найдено

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
[
{
"quantity": 1,
"barcode": "k"
},
{
"quantity": 7,
"barcode": "1111111111"
}
]
Примеры ответа
200
400
401
402
429
Content type
application/json
Копировать
Показать все
{
"result": 
[
{},
{}
],
"requestId": "kr53d2bRKYmkK2N6zaNKHs"
}
Список складов
/api/v1/warehouses
Prod
GET
https://supplies-api.wildberries.ru/api/v1/warehouses
Sandbox
GET
https://supplies-api-sandbox.wildberries.ru/api/v1/warehouses
Описание метода

Метод временно отключён

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	6 запросов	10 сек	6 запросов
Сервисный	1 мин	6 запросов	10 сек	6 запросов
Базовый с секретом	1 мин	6 запросов	10 сек	6 запросов
Базовый	12 ч	1 запрос	12 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
Ответы
200

Успешно

401

Не авторизован

403

Доступ запрещён

404

Не найдено

429

Слишком много запросов

Примеры ответа
200
401
429
Content type
application/json
Копировать
Свернуть все
[
{
"ID": 300461,
"name": "Гомель 2",
"address": "Гомель, Могилёвская улица 1/А",
"workTime": "24/7",
"isActive": false,
"isTransitActive": true
}
]
Транзитные направления
/api/v1/transit-tariffs
GET
https://supplies-api.wildberries.ru/api/v1/transit-tariffs
Описание метода

Метод временно отключён

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	6 запросов	10 сек	10 запросов
Сервисный	1 мин	6 запросов	10 сек	10 запросов
Базовый с секретом	1 мин	6 запросов	10 сек	10 запросов
Базовый	12 ч	1 запрос	12 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
Ответы
200

Успешно

401

Не авторизован

429

Слишком много запросов

Примеры ответа
200
401
429
Content type
application/json
Копировать
Показать все
[
{
"transitWarehouseName": "Обухово",
"destinationWarehouseName": "Краснодар",
"activeFrom": "2024-11-03T21:01:00Z",
"boxTariff": null,
"palletTariff": 7500
},
{
"transitWarehouseName": "СЦ Гомель 2",
"destinationWarehouseName": "Краснодар (Тихорецкая)",
"activeFrom": "2025-04-08T21:00:48.019Z",
"boxTariff": 
[],
"palletTariff": 6500
}
]
Информация о поставках
Для доступа к методам используйте токен для категории Поставки

Получение информации о поставках товаров для хранения на складах WB:

Список поставок
Детали поставки
Товары поставки
Упаковка поставки
Список поставок
/api/v1/supplies
POST
https://supplies-api.wildberries.ru/api/v1/supplies
Описание метода

Метод возвращает список поставок, по умолчанию — последние 1000 поставок.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	30 запросов	2 сек	10 запросов
Сервисный	1 мин	30 запросов	2 сек	10 запросов
Базовый с секретом	1 мин	30 запросов	2 сек	10 запросов
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
QUERY PARAMETERS
limit	
integer [ 1 .. 1000 ]
Default: 1000

Количество записей в ответе


offset	
integer
Default: 0

После какого элемента выдавать данные

REQUEST BODY SCHEMA: application/json
required
dates	
Array of objects (models.DateFilterRequest)

Фильтр по датам


statusIDs	
Array of integers (models.HandySupplyStatus)
Items Enum: 1 2 3 4 5 6

Фильтр поставок по статусам. Возможные значения:

1 — Не запланировано
2 — Запланировано
3 — Отгрузка разрешена
4 — Идёт приёмка
5 — Принято
6 — Отгружено на воротах
Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Показать все
{
"dates": 
[
{}
],
"statusIDs": 
[
5,
6
]
}
Примеры ответа
200
400
401
402
429
Content type
application/json
Копировать
Свернуть все
[
{
"phone": "+7 916 *** 44 44",
"supplyID": null,
"preorderID": 34597755,
"createDate": "2024-12-29T16:58:26+03:00",
"supplyDate": null,
"factDate": null,
"updatedDate": null,
"statusID": 1,
"boxTypeID": 1
},
{
"phone": "+7 916 *** 33 33",
"supplyID": 26596368,
"preorderID": 34601223,
"createDate": "2024-12-29T16:57:59+03:00",
"supplyDate": "2024-12-29T00:00:00+03:00",
"factDate": null,
"updatedDate": null,
"statusID": 2,
"boxTypeID": 5
},
{
"phone": "+7 000 *** 36 76",
"supplyID": 22677736,
"preorderID": 27363170,
"createDate": "2024-08-22T18:10:59+03:00",
"supplyDate": "2024-08-22T00:00:00+03:00",
"factDate": "2024-08-22T12:24:14+03:00",
"updatedDate": "2024-08-22T18:33:45+03:00",
"statusID": 6,
"boxTypeID": 2,
"isBoxOnPallet": false
}
]
Детали поставки
/api/v1/supplies/{ID}
GET
https://supplies-api.wildberries.ru/api/v1/supplies/{ID}
Описание метода

Метод возвращает детали поставки по ID.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	30 запросов	2 сек	10 запросов
Сервисный	1 мин	30 запросов	2 сек	10 запросов
Базовый с секретом	1 мин	30 запросов	2 сек	10 запросов
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
PATH PARAMETERS
ID
required
	
integer

ID поставки или заказа

QUERY PARAMETERS
isPreorderID	
boolean
Default: false

Поиск по:

true — ID заказа, если в ID передаёте ID заказа
false — ID поставки, если в ID передаёте ID поставки
Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

404

Не найдено

429

Слишком много запросов

Примеры ответа
200
400
401
402
404
429
Content type
application/json
Копировать
{
"phone": "+7 903 *** 98 62",
"statusID": 5,
"boxTypeID": 2,
"createDate": "2025-07-15T17:17:45+03:00",
"supplyDate": "2025-07-15T00:00:00+03:00",
"factDate": "2025-07-18T11:37:32+03:00",
"updatedDate": "2025-07-18T12:59:53+03:00",
"warehouseID": 507,
"warehouseName": "Коледино",
"actualWarehouseID": 507,
"actualWarehouseName": "Коледино",
"transitWarehouseID": null,
"transitWarehouseName": "",
"acceptanceCost": 5000,
"paidAcceptanceCoefficient": 10,
"rejectReason": null,
"supplierAssignName": "Магазин",
"storageCoef": "215",
"deliveryCoef": "200",
"quantity": 10,
"readyForSaleQuantity": 0,
"acceptedQuantity": 10,
"unloadingQuantity": 10,
"depersonalizedQuantity": 0,
"isBoxOnPallet": true
}
Товары поставки
/api/v1/supplies/{ID}/goods
GET
https://supplies-api.wildberries.ru/api/v1/supplies/{ID}/goods
Описание метода

Метод возвращает информацию о товарах в поставке.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	30 запросов	2 сек	10 запросов
Сервисный	1 мин	30 запросов	2 сек	10 запросов
Базовый с секретом	1 мин	30 запросов	2 сек	10 запросов
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
PATH PARAMETERS
ID
required
	
integer

ID поставки или заказа

QUERY PARAMETERS
limit	
integer [ 1 .. 1000 ]
Default: 100

Количество записей в ответе


offset	
integer
Default: 0

После какого элемента выдавать данные


isPreorderID	
boolean
Default: false

Поиск по:

true — ID заказа, если в ID передаёте ID заказа
false — ID поставки, если в ID передаёте ID поставки
Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

429

Слишком много запросов

Примеры ответа
200
400
401
402
429
Content type
application/json
Копировать
Свернуть все
[
{
"barcode": "1234567891234",
"vendorCode": "wb4sewt0vg",
"nmID": 987456654,
"needKiz": true,
"tnved": "6204430000",
"techSize": "C",
"color": "красный",
"supplierBoxAmount": 10,
"quantity": 10,
"readyForSaleQuantity": 0,
"unloadingQuantity": 0,
"acceptedQuantity": 0
}
]
Упаковка поставки
/api/v1/supplies/{ID}/package
GET
https://supplies-api.wildberries.ru/api/v1/supplies/{ID}/package
Описание метода

Метод возвращает информацию об упаковке поставки.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	30 запросов	2 сек	10 запросов
Сервисный	1 мин	30 запросов	2 сек	10 запросов
Базовый с секретом	1 мин	30 запросов	2 сек	10 запросов
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
PATH PARAMETERS
ID
required
	
integer

ID поставки

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

429

Слишком много запросов

Примеры ответа
200
400
401
402
429
Content type
application/json
Копировать
Показать все
[
{
"packageCode": "WB_689",
"quantity": 1,
"barcodes": 
[]
}
]
Пользовательское соглашение Сервиса «WB API»
Соглашение о предоставлении доступа к платформе WB API
Политика в отношении обработки ПД РВБ
Прайс-лист WB API для сторонних сервисов
FAQ. Ответы на часто задаваемые вопросы

© Wildberries 2004-2026. Все права защищены. Контактные данные: dev-info@rwb.ru

Мы используем cookies для сбора статистики и улучшения сервиса
Принять
