<!-- Источник: https://dev.wildberries.ru/docs/openapi/analytics -->
<!-- Снимок официальной документации WB API. Обновляется скриптом scripts/fetch-wb-docs.mjs. Дату обновления смотрите в истории git. -->

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
Заказы DBS
Заказы Самовывоз
Поставки FBW
Маркетинг и продвижение
Общение с покупателями
Тарифы
Аналитика и данные
Воронка продаж
Поисковые запросы по вашим товарам
История остатков
Оценка товара
Аналитика продавца CSV
Отчёты
Документы и бухгалтерия
Аналитика и данные
Узнать больше об аналитике и данных можно в справочном центре

В разделе описаны методы получения:

Воронки продаж
Поисковых запросов по вашим товарам
Истории остатков
Оценки товара
Аналитики продавца в формате CSV
Воронка продаж
Для доступа к методам используйте токен для категории Аналитика
Узнать, как использовать методы в бизнес-кейсах, можно в инструкции по работе с Воронкой продаж
Узнать больше об аналитике воронки продаж можно в справочном центре

Методы получения статистики:

Карточек товаров за период
Карточек товаров по дням
Групп карточек товаров по дням
Таймзоны представлены в формате IANA, актуальный список можно посмотреть здесь
Статистика карточек товаров за период
/api/analytics/v3/sales-funnel/products
POST
https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products
Описание метода

Метод формирует отчёт о товарах, сравнивая ключевые показатели за текущий период с аналогичным прошлым.



Данные отчёта обновляются 1 раз в час.



В течение часа после события появляется большая часть данных:

о заказах
о переходах в карточку товара
о добавлениях товаров в корзину

Малая часть этих данных может появляться в течение нескольких дней.



Выкупы, отмены и возвраты отображаются в отчёте за тот день, когда товар был заказан. Например, если заказ был сделан 1 января, а покупатель вернул товар 10 января, данные об этом возврате появятся в отчёте за 1 января.
Окончательные итоги продаж вы можете отслеживать с помощью детализаций к отчётам реализации.



Параметры brandNames,subjectIds, tagIds, nmIds могут быть пустыми [], тогда в ответе возвращаются все карточки продавца.



Если вы указали несколько параметров, в ответе будут карточки, в которых есть одновременно все эти параметры. Если карточки не подходят по параметрам запроса, вернётся пустой ответ [].



Можно получить отчёт максимум за последние 365 дней.



В данных предыдущего периода:

Данные в pastPeriod указаны за такой же период, что и в selectedPeriod
Если дата начала pastPeriod раньше, чем год назад от текущей даты, она будет приведена к виду: pastPeriod.start = текущая дата — 365 дней

Можно использовать пагинацию.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
selectedPeriod
required
	
object

Запрашиваемый период


pastPeriod	
object

Период для сравнения


nmIds	
Array of integers <uint64> [ 0 .. 1000 ] items [ items <uint64 > ]

Артикулы WB, по которым нужно составить отчёт. Оставьте пустым, чтобы получить отчёт обо всех товарах


brandNames	
Array of strings

Список брендов для фильтрации


subjectIds	
Array of integers <uint64> [ items <uint64 > ]

Список ID предметов для фильтрации


tagIds	
Array of integers <uint64> [ items <uint64 > ]

Список ID ярлыков для фильтрации


skipDeletedNm	
boolean

Скрыть удалённые товары


orderBy	
object (OrderBy)

Параметры сортировки


limit	
integer <uint32> <= 1000
Default: 50

Количество карточек товара в ответе


offset	
integer <uint32>
Default: 0

Сколько элементов пропустить. Например, для значения 10 ответ начнётся с 11 элемента

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"selectedPeriod": 
{
"start": "2023-06-01",
"end": "2024-03-01"
},
"pastPeriod": 
{
"start": "2023-06-01",
"end": "2024-03-01"
},
"nmIds": 
[
1234567
],
"brandNames": 
[
"nike",
"adidas"
],
"subjectIds": 
[
64,
334
],
"tagIds": 
[
32,
53
],
"skipDeletedNm": false,
"orderBy": 
{
"field": "openCard",
"mode": "asc"
},
"limit": 231,
"offset": 10
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"products": 
[],
"currency": "RUB"
}
}
Статистика карточек товаров по дням
/api/analytics/v3/sales-funnel/products/history
POST
https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history
Описание метода

Метод возвращает статистику карточек товаров по дням или неделям.
Можно получить данные максимум за последнюю неделю.



Данные отчёта обновляются 1 раз в час.



В течение часа после события появляется большая часть данных:

о заказах
о переходах в карточку товара
о добавлениях товаров в корзину

Малая часть этих данных может появляться в течение нескольких дней.



Выкупы, отмены и возвраты отображаются в отчёте за тот день, когда товар был заказан. Например, если заказ был сделан 1 января, а покупатель вернул товар 10 января, данные об этом возврате появятся в отчёте за 1 января.
Окончательные итоги продаж вы можете отслеживать с помощью детализаций к отчётам реализации.

Чтобы получать отчёты за период до года, используйте методы Аналитика продавца CSV — тип DETAIL_HISTORY_REPORT. Отчёты этого типа доступны только с подпиской Джем
Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
selectedPeriod
required
	
object

Запрашиваемый период


nmIds
required
	
Array of integers <uint64> [ 1 .. 20 ] items [ items <uint64 > ]

Артикулы WB, по которым нужно составить отчёт


skipDeletedNm	
boolean

Скрыть удалённые товары


aggregationLevel	
string (Level)
Default: "day"
Enum: "day" "week"

Тип агрегации. Если не указано, то по умолчанию используется агрегация по дням.
Доступные уровни агрегации day, week

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"selectedPeriod": 
{
"start": "2023-06-01",
"end": "2024-03-01"
},
"nmIds": 
[
0
],
"skipDeletedNm": true,
"aggregationLevel": "day"
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
[
{
"product": 
{},
"history": 
[],
"currency": "RUB"
}
]
Статистика групп карточек товаров по дням
/api/analytics/v3/sales-funnel/grouped/history
POST
https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/grouped/history
Описание метода

Метод возвращает статистику карточек товаров по дням или неделям.
Карточки товаров сгруппированы по предметам, брендам и ярлыкам.
Можно получить данные максимум за последнюю неделю.



Данные отчёта обновляются 1 раз в час.



В течение часа после события появляется большая часть данных:

о заказах
о переходах в карточку товара
о добавлениях товаров в корзину

Малая часть этих данных может появляться в течение нескольких дней.



Выкупы, отмены и возвраты отображаются в отчёте за тот день, когда товар был заказан. Например, если заказ был сделан 1 января, а покупатель вернул товар 10 января, данные об этом возврате появятся в отчёте за 1 января.
Окончательные итоги продаж вы можете отслеживать с помощью детализаций к отчётам реализации.



Параметры brandNames, subjectIds, tagIds могут быть пустыми [], тогда группировка происходит по всем карточкам продавца.



Произведение количества предметов, брендов, ярлыков в запросе может быть не больше 16. Например, 4 бренда и 4 предмета или 2 предмета, 2 ярлыка и 4 бренда.

Чтобы получать отчёты за период до года, используйте методы Аналитика продавца CSV — тип GROUPED_HISTORY_REPORT. Отчёты этого типа доступны только с подпиской Джем
Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
selectedPeriod
required
	
object

Запрашиваемый период


brandNames	
Array of strings

Список брендов для фильтрации


subjectIds	
Array of integers <uint64> [ items <uint64 > ]

Список ID предметов для фильтрации


tagIds	
Array of integers <uint64> [ items <uint64 > ]

Список ID ярлыков для фильтрации


skipDeletedNm	
boolean

Скрыть удалённые товары


aggregationLevel	
string (Level)
Default: "day"
Enum: "day" "week"

Тип агрегации. Если не указано, то по умолчанию используется агрегация по дням.
Доступные уровни агрегации day, week

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"selectedPeriod": 
{
"start": "2023-06-01",
"end": "2024-03-01"
},
"brandNames": 
[
"nike",
"adidas"
],
"subjectIds": 
[
64,
334
],
"tagIds": 
[
32,
53
],
"skipDeletedNm": false,
"aggregationLevel": "day"
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
[
{}
]
}
Поисковые запросы по вашим товарам
Для доступа к методам используйте токен для категории Аналитика
Узнать, как использовать методы в бизнес-кейсах, можно в инструкции по работе с Поисковыми запросами по вашим товарам
Узнать больше об аналитике поисковых запросов можно в справочном центре

Методы получения отчёта по поисковым запросам по вашим товарам, в частности:

Основной страницы
Дополнительных данных к основной странице с пагинацией по группам или пагинацией по товарам в группе
Поисковых запросов по товару
Заказов и позиций по поисковым запросам товара
Вы можете использовать эти методы только с подпиской Джем
Основная страница
/api/v2/search-report/report
POST
https://seller-analytics-api.wildberries.ru/api/v2/search-report/report
Описание метода

Метод формирует набор данных для основной страницы отчёта по поисковым запросам с:

общей информацией
позициями товаров
данными по видимости и переходам в карточку
данными для таблицы по группам

Для получения дополнительных данных в таблице используйте отдельный запрос для:

пагинации по группам
получения по товарам в группе

Дополнительный параметр выбора списка товаров в таблице:

positionCluster — средняя позиция в поиске

Параметры includeSubstitutedSKUs и includeSearchTexts не могут одновременно иметь значение false.



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
currentPeriod
required
	
object (Period)

Текущий период


pastPeriod	
object (pastPeriod)

Прошлый период для сравнения. Количество дней — меньше или равно currentPeriod


nmIds	
Array of integers <int32> [ items <int32 > ]

Список артикулов WB для фильтрации


subjectIds	
Array of integers <int32> [ items <int32 > ]

Список ID предметов для фильтрации


brandNames	
Array of strings

Список брендов для фильтрации


tagIds	
Array of integers <int64> [ items <int64 > ]

Список ID ярлыков для фильтрации


positionCluster
required
	
string (PositionCluster)
Enum: "all" "firstHundred" "secondHundred" "below"

Товары с какой средней позицией в поиске показывать в отчёте:

all — все
firstHundred — от 1 до 100
secondHundred — от 101 до 200
below — от 201 и ниже

orderBy
required
	
object (OrderByMainAndDetails)

Параметры сортировки


includeSubstitutedSKUs	
boolean
Default: true

Показать данные по прямым запросам с подменным артикулом


includeSearchTexts	
boolean
Default: true

Показать данные по поисковым запросам без учёта подменного артикула


limit
required
	
integer <uint32> <= 1000

Количество групп товаров в ответе


offset
required
	
integer <uint32>

После какого элемента выдавать данные

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"pastPeriod": 
{
"start": "2024-02-08",
"end": "2024-02-08"
},
"nmIds": 
[
162579635,
166699779
],
"subjectIds": 
[
32,
64
],
"brandNames": 
[
"Adidas",
"Nike"
],
"tagIds": 
[
3,
5,
6
],
"positionCluster": "all",
"orderBy": 
{
"field": "avgPosition",
"mode": "asc"
},
"includeSubstitutedSKUs": true,
"includeSearchTexts": false,
"limit": 130,
"offset": 50
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"commonInfo": 
{},
"positionInfo": 
{},
"visibilityInfo": 
{},
"groups": 
[],
"currency": "RUB"
}
}
Пагинация по группам
/api/v2/search-report/table/groups
POST
https://seller-analytics-api.wildberries.ru/api/v2/search-report/table/groups
Описание метода

Метод формирует дополнительные данные к основному отчёту с пагинацией по группам. Пагинация возможна только при наличии фильтра по бренду, предмету или ярлыку.



Дополнительный параметр выбора списка товаров в таблице:

positionCluster — средняя позиция в поиске

Параметры includeSubstitutedSKUs и includeSearchTexts не могут одновременно иметь значение false.



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
currentPeriod
required
	
object (Period)

Текущий период


pastPeriod	
object (pastPeriod)

Прошлый период для сравнения. Количество дней — меньше или равно currentPeriod


nmIds	
Array of integers <int32> [ items <int32 > ]

Список артикулов WB для фильтрации


subjectIds	
Array of integers <int32> [ items <int32 > ]

Список ID предметов для фильтрации


brandNames	
Array of strings

Список брендов для фильтрации


tagIds	
Array of integers <int64> [ items <int64 > ]

Список ID ярлыков для фильтрации


orderBy
required
	
object (OrderByGrTe)

Параметры сортировки


positionCluster
required
	
string (PositionCluster)
Enum: "all" "firstHundred" "secondHundred" "below"

Товары с какой средней позицией в поиске показывать в отчёте:

all — все
firstHundred — от 1 до 100
secondHundred — от 101 до 200
below — от 201 и ниже

includeSubstitutedSKUs	
boolean
Default: true

Показать данные по прямым запросам с подменным артикулом


includeSearchTexts	
boolean
Default: true

Показать данные по поисковым запросам без учёта подменного артикула


limit
required
	
integer <uint32> <= 1000

Количество групп товаров в ответе


offset
required
	
integer <uint32>

После какого элемента выдавать данные

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"pastPeriod": 
{
"start": "2024-02-08",
"end": "2024-02-08"
},
"nmIds": 
[
162579635,
166699779
],
"subjectIds": 
[
64,
334
],
"brandNames": 
[
"nikkle",
"abikas"
],
"tagIds": 
[
32,
53
],
"orderBy": 
{
"field": "avgPosition",
"mode": "asc"
},
"positionCluster": "all",
"includeSubstitutedSKUs": true,
"includeSearchTexts": false,
"limit": 130,
"offset": 50
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"groups": 
[],
"currency": "RUB"
}
}
Пагинация по товарам в группе
/api/v2/search-report/table/details
POST
https://seller-analytics-api.wildberries.ru/api/v2/search-report/table/details
Описание метода

Метод формирует дополнительные данные к основному отчёту с пагинацией по товарам в группе. Пагинация возможна вне зависимости от наличия фильтров.



Фильтры для пагинации по товарам в группе или без фильтров:

кортеж subjectId,brandName,tagId — фильтр для группы
nmIds — фильтр по карточке товара

Дополнительный параметр выбора списка товаров:

positionCluster — средняя позиция в поиске

Параметры includeSubstitutedSKUs и includeSearchTexts не могут одновременно иметь значение false.



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
currentPeriod
required
	
object (Period)

Текущий период


pastPeriod	
object (pastPeriod)

Прошлый период для сравнения. Количество дней — меньше или равно currentPeriod


subjectId	
integer <int32>

ID предмета


brandName	
string

Название товара


tagId	
integer <int64>

ID ярлыка


nmIds	
Array of integers <uint64> <= 50 items [ items <uint64 > ]

Список артикулов WB


orderBy
required
	
object (OrderByMainAndDetails)

Параметры сортировки


positionCluster
required
	
string
Enum: "all" "firstHundred" "secondHundred" "below"

Товары с какой средней позицией в поиске показывать в отчёте:

all — все
firstHundred — от 1 до 100
secondHundred — от 101 до 200
below — от 201 и ниже

includeSubstitutedSKUs	
boolean
Default: true

Показать данные по прямым запросам с подменным артикулом


includeSearchTexts	
boolean
Default: true

Показать данные по поисковым запросам без учёта подменного артикула


limit
required
	
integer <uint32> <= 1000

Количество товаров в ответе


offset
required
	
integer <uint32>

После какого элемента выдавать данные

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"pastPeriod": 
{
"start": "2024-02-08",
"end": "2024-02-08"
},
"subjectId": 123,
"brandName": "Apple",
"tagId": 45,
"nmIds": 
[
162579635,
166699779
],
"orderBy": 
{
"field": "avgPosition",
"mode": "asc"
},
"positionCluster": "all",
"includeSubstitutedSKUs": true,
"includeSearchTexts": false,
"limit": 150,
"offset": 100
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"products": 
[],
"currency": "RUB"
}
}
Поисковые запросы по товару
/api/v2/search-report/product/search-texts
POST
https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/search-texts
Описание метода

Метод формирует топ поисковых запросов по товару.

Параметры выбора поисковых запросов:

limit — количество запросов, максимум 30. Для тарифов Джема Продвинутый и Премиальный максимум — 100.
topOrderBy — способ выбора топа запросов

Параметры includeSubstitutedSKUs и includeSearchTexts не могут одновременно иметь значение false.



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
currentPeriod
required
	
object (Period)

Текущий период


pastPeriod	
object (pastPeriod)

Прошлый период для сравнения. Количество дней — меньше или равно currentPeriod


nmIds
required
	
Array of integers <uint64> <= 50 items [ items <uint64 > ]

Список артикулов WB


topOrderBy
required
	
string
Enum: "openCard" "addToCart" "openToCart" "orders" "cartToOrder"

Фильтрация по поисковым запросам, по которым больше всего:

openCard — перешли в карточку
addToCart — добавили в корзину
openToCart — конверсия в корзину
orders — заказали товаров
cartToOrder — конверсия в заказ

includeSubstitutedSKUs	
boolean
Default: true

Показать данные по прямым запросам с подменным артикулом


includeSearchTexts	
boolean
Default: true

Показать данные по поисковым запросам без учёта подменного артикула


orderBy
required
	
object (OrderByGrTe)

Параметры сортировки


limit
required
	
StandardTariff (integer) or AdvancedTariff (integer) (TextLimit)
Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"pastPeriod": 
{
"start": "2024-02-08",
"end": "2024-02-08"
},
"nmIds": 
[
162579635,
166699779
],
"topOrderBy": "openToCart",
"includeSubstitutedSKUs": true,
"includeSearchTexts": false,
"orderBy": 
{
"field": "avgPosition",
"mode": "asc"
},
"limit": 20
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"items": 
[],
"currency": "RUB"
}
}
Заказы и позиции по поисковым запросам товара
/api/v2/search-report/product/orders
POST
https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/orders
Описание метода

Метод формирует данные для таблицы:

о заказах по каждому поисковому запросу для конкретного товара
о позициях товара в результатах поиска по каждому запросу

Данные указаны в рамках периода для запрошенного товара и сгруппированы по дням. Максимальный период — 7 дней.



Данные отчёта обновляются 1 раз в час.

Можно получить отчёт максимум за последние 365 дней с момента выполнения запроса
Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
period
required
	
object (PeriodOrdersRequest)

Текущий период. Максимум 7 суток


nmId
required
	
integer <uint64>

Артикул WB


searchTexts
required
	
Array of strings [ 1 .. 30 ] items

Поисковые запросы. Для тарифов Джема Продвинутый и Премиальный максимум — 100

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"period": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"nmId": 211131895,
"searchTexts": 
[
"костюм",
"пиджак"
]
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"total": 
[],
"items": 
[]
}
}
История остатков
Для доступа к методам используйте токен для категории Аналитика
Узнать, как использовать методы в бизнес-кейсах, можно в инструкции по работе с Историей остатков
Узнать больше об аналитике остатков можно в справочном центре

Это информация из детализированной таблицы товаров и виджета детализации по регионам.

Остатки в ответах данных методов — на текущий день.

Чтобы получать остатки по дням за период до 3 месяцев от текущей даты, используйте методы Аналитика продавца CSV — тип отчёта STOCK_HISTORY_DAILY_CSV

Методы получения отчёта по статистике остатков:

Текущих остатков на складах WB по размерам
Данных по таблице товаров с агрегацией по группам, товарам, размерам
Данных виджета Статистика по регионам отгрузки с детализацией по складам
Остатки на складах WB
/api/analytics/v1/stocks-report/wb-warehouses
POST
https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses
Описание метода
Метод доступен по Персональному токену, Сервисному токену, Базовому токену с секретом

Метод возвращает текущие остатки товаров на складах WB.

Данные обновляются 1 раз в 30 минут.

1 строка ответа — данные об 1 размере товара на 1 складе WB.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	3 запроса	20 сек	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
nmIds	
Array of integers <int64> [ 0 .. 1000 ] items [ items <int64 > ]

Артикулы WB


chrtIds	
Array of integers <int64> [ items <int64 > ]

ID размеров. Используется только для указанных в массиве nmIds артикулов


limit	
integer <uint32> <= 250000
Default: 250000

Количество строк в ответе


offset	
integer <uint32>
Default: 0

Сколько элементов пропустить. Например, для значения 10 ответ начнётся с 11 элемента

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"nmIds": 
[
111222333,
47254354
],
"chrtIds": 
[
111222333,
91663228
],
"limit": 250000,
"offset": 500000
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"items": 
[]
}
}
Данные по группам
/api/v2/stocks-report/products/groups
POST
https://seller-analytics-api.wildberries.ru/api/v2/stocks-report/products/groups
Описание метода

Метод формирует набор данных об остатках по группам товаров.

Группа товаров описывается кортежем subjectID, brandName, tagID.



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
nmIDs	
Array of integers <int64> [ items <int64 > ]

Список артикулов WB для фильтрации


subjectIDs	
Array of integers <int32> [ items <int32 > ]

Список ID предметов для фильтрации


brandNames	
Array of strings

Список брендов для фильтрации


tagIDs	
Array of integers <int64> [ items <int64 > ]

Список ID ярлыков для фильтрации


currentPeriod
required
	
object (PeriodInv)

Период


stockType
required
	
string (StockType)
Enum: "" "wb" "mp"

Тип складов хранения товаров:

"" — все
wb — склады WB
mp — склады продавца

skipDeletedNm
required
	
boolean

Скрыть удалённые товары


availabilityFilters
required
	
Array of strings (availabilityFilters)
Items Enum: "deficient" "actual" "balanced" "nonActual" "nonLiquid" "invalidData"

Доступность товара:

deficient — Дефицит
actual — Актуальный
balanced — Баланс
nonActual — Неактуальный
nonLiquid — Неликвид
invalidData — Не рассчитано

orderBy
required
	
object (TableOrderBy)

Вид сортировки данных


limit	
integer <uint32> <= 1000
Default: 100

Количество групп в ответе


offset
required
	
integer <uint32>

После какого элемента выдавать данные

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"nmIDs": 
[
111222333,
444555666
],
"subjectIDs": 
[
123,
456
],
"brandNames": 
[
"Эрк",
"Дент"
],
"tagIDs": 
[
3,
4,
5
],
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"stockType": "mp",
"skipDeletedNm": true,
"availabilityFilters": 
[
"deficient",
"balanced"
],
"orderBy": 
{
"field": "avgOrders",
"mode": "asc"
},
"limit": 150,
"offset": 100
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"groups": 
[],
"currency": "RUB"
}
}
Данные по товарам
/api/v2/stocks-report/products/products
POST
https://seller-analytics-api.wildberries.ru/api/v2/stocks-report/products/products
Описание метода

Метод формирует набор данных об остатках по товарам.

Можно получить данные как по отдельным товарам, так и в рамках всего отчёта — если в запросе отсутствуют фильтры: nmIDs, subjectID, brandName, tagID.



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
nmIDs	
Array of integers <int64> [ items <int64 > ]

Список артикулов WB для фильтрации


subjectID	
integer <int32>

ID предмета


brandName	
string

Бренд


tagID	
integer <int64>

ID ярлыка


currentPeriod
required
	
object (PeriodInv)

Период


stockType
required
	
string (StockType)
Enum: "" "wb" "mp"

Тип складов хранения товаров:

"" — все
wb — склады WB
mp — склады продавца

skipDeletedNm
required
	
boolean

Скрыть удалённые товары


orderBy
required
	
object (TableOrderBy)

Вид сортировки данных


availabilityFilters
required
	
Array of strings (availabilityFilters)
Items Enum: "deficient" "actual" "balanced" "nonActual" "nonLiquid" "invalidData"

Доступность товара:

deficient — Дефицит
actual — Актуальный
balanced — Баланс
nonActual — Неактуальный
nonLiquid — Неликвид
invalidData — Не рассчитано

limit	
integer <uint32> <= 1000
Default: 100

Количество товаров в ответе


offset
required
	
integer <uint32>

После какого элемента выдавать данные

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"nmIDs": 
[
111222333,
444555666
],
"subjectID": 123456,
"brandName": "Спортик",
"tagID": 25345,
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"stockType": "mp",
"skipDeletedNm": true,
"orderBy": 
{
"field": "avgOrders",
"mode": "asc"
},
"availabilityFilters": 
[
"deficient",
"balanced"
],
"limit": 150,
"offset": 100
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"items": 
[],
"currency": "RUB"
}
}
Данные по размерам
/api/v2/stocks-report/products/sizes
POST
https://seller-analytics-api.wildberries.ru/api/v2/stocks-report/products/sizes
Описание метода

Метод формирует набор данных об остатках по размерам товара.

Возможны случаи:

Товар имеет размеры и "includeOffice":true, тогда в ответе будут данные об остатках по каждому из размеров с вложенной детализацией по складам.
Товар имеет размеры и "includeOffice":false, тогда в ответе будут данные об остатках по каждому из размеров без вложенной детализации по складам.
Товар не имеет размера и "includeOffice":true, тогда в ответе будет детализация по складам. Без данных об остатках по каждому из размеров.
Товар не имеет размера и "includeOffice":false, тогда тело ответа будет пустым.

Товар не имеет размера, если у него единственный размер с "techSize":"0". В ответах метода получения данных по товарам у таких товаров "hasSizes":false.

Данные по складам продавца приходят в агрегированном виде — по всем сразу, без детализации по конкретным складам — эти записи будут с "regionName":"Маркетплейс" и "officeName":"".



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
nmID
required
	
integer <int64>

Артикул WB


currentPeriod
required
	
object (PeriodInv)

Период


stockType
required
	
string (StockType)
Enum: "" "wb" "mp"

Тип складов хранения товаров:

"" — все
wb — склады WB
mp — склады продавца

orderBy
required
	
object (TableOrderBy)

Вид сортировки данных


includeOffice
required
	
boolean

Включить детализацию по складам

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"nmID": 123456789,
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"stockType": "mp",
"orderBy": 
{
"field": "avgOrders",
"mode": "asc"
},
"includeOffice": true
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"offices": 
[],
"sizes": 
[],
"currency": "RUB"
}
}
Данные по складам
/api/v2/stocks-report/offices
POST
https://seller-analytics-api.wildberries.ru/api/v2/stocks-report/offices
Описание метода

Метод формирует набор данных об остатках по складам.

Данные по складам продавца приходят в агрегированном виде — по всем сразу, без детализации по конкретным складам — эти записи будут с "regionName":"Маркетплейс" и "offices":[].



Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	2 запроса	30 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
nmIDs	
Array of integers <int64> [ items <int64 > ]

Список артикулов WB для фильтрации


subjectIDs	
Array of integers <int32> [ items <int32 > ]

Список ID предметов для фильтрации


brandNames	
Array of strings

Список брендов для фильтрации


tagIDs	
Array of integers <int64> [ items <int64 > ]

Список ID ярлыков для фильтрации


currentPeriod
required
	
object (PeriodInv)

Период


stockType
required
	
string (StockType)
Enum: "" "wb" "mp"

Тип складов хранения товаров:

"" — все
wb — склады WB
mp — склады продавца

skipDeletedNm
required
	
boolean

Скрыть удалённые товары

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"nmIDs": 
[
111222333,
444555666
],
"subjectIDs": 
[
123,
456
],
"brandNames": 
[
"Эшк",
"ЗлатА",
"ОТК",
"арк"
],
"tagIDs": 
[
123,
456,
789
],
"currentPeriod": 
{
"start": "2024-02-10",
"end": "2024-02-10"
},
"stockType": "mp",
"skipDeletedNm": false
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"regions": 
[],
"currency": "RUB"
}
}
Оценка товара
Для доступа к методу используйте токен для категории Аналитика
Узнать больше об аналитике оценок товаров можно в справочном центре

Метод получения отчёта Оценка товара

Получить отчёт
/api/analytics/v1/item-rating
POST
https://seller-analytics-api.wildberries.ru/api/analytics/v1/item-rating
Описание метода
Метод доступен по Персональному токену, Сервисному токену

Метод формирует набор данных об оценках товаров.

Данные отчёта обновляются 1 раз в час.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	3 запроса	20 сек	3 запроса
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
currentPeriod
required
	
object (PeriodItemRating)

Текущий период


pastPeriod	
object (pastPeriodItemRating)

Прошлый период для сравнения. Количество дней — меньше или равно currentPeriod


nmIds	
Array of integers <int32> <= 50 items [ items <int32 > ]

Список артикулов WB для фильтрации


subjectIds	
Array of integers <int32> <= 50 items [ items <int32 > ]

Список ID предметов для фильтрации


brandNames	
Array of strings <= 50 items

Список брендов для фильтрации


tagIds	
Array of integers <int64> <= 50 items [ items <int64 > ]

Список ID ярлыков для фильтрации


isNotIncludeNMsWithoutSales	
boolean
Default: false

Не учитывать товары без продаж


orderBy
required
	
object (OrderByItemRating)

Параметры сортировки


limit	
integer <uint32> <= 1000
Default: 100

Количество товаров в ответе


offset
required
	
integer <uint32>

Сколько элементов пропустить. Например, для значения 10 ответ начнётся с 11 элемента

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
Свернуть все
{
"currentPeriod": 
{
"start": "2026-02-10",
"end": "2026-02-10"
},
"pastPeriod": 
{
"start": "2026-02-08",
"end": "2026-02-08"
},
"nmIds": 
[
162579635,
166699779
],
"subjectIds": 
[
232,
1364
],
"brandNames": 
[
"Abikas",
"Tike"
],
"tagIds": 
[
3,
5,
6
],
"isNotIncludeNMsWithoutSales": true,
"orderBy": 
{
"field": "feedbackCount",
"mode": "desc"
},
"limit": 130,
"offset": 50
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"sellerRating": 
{},
"feedbackIncrease": 
{},
"cards": 
[]
}
}
Аналитика продавца CSV
Для доступа к методам используйте токен для категории Аналитика
Узнать, как использовать методы в бизнес-кейсах, можно в инструкции по работе с Аналитикой продавца CSV

Чтобы получить отчёт:

Сгенерируйте его с помощью метода создания отчёта.
Дождитесь, когда отчёт будет готов. Вы можете проверить статус готовности через получение списка отчётов. Готовый отчёт хранится 48 часов.
Если вы получили статус FAILED, сгенерируйте отчёт повторно.
Получите отчёт.

Можно получить отчёт максимум за год. Отчёты по остаткам — за 3 месяца.

Максимальное количество отчётов, генерируемых в сутки — 20.

Вы можете использовать эти методы — за исключением отчётов по остаткам — только с подпиской Джем
Создать отчёт
/api/v2/nm-report/downloads
POST
https://seller-analytics-api.wildberries.ru/api/v2/nm-report/downloads
Описание метода

Метод создаёт задание на генерацию отчёта с расширенной аналитикой продавца.



Вы можете создать CSV-версии отчётов по воронке продаж или параметрам поиска с группировкой по:

артикулам WB
предметам, брендам и ярлыкам

В отчётах по воронке продаж можно группировать данные по дням, неделям или месяцам.



Также можете создать CSV-версии отчётов по текстам поисковых запросов и остаткам.



Каждый новый отчёт должен иметь уникальный ID.

Не используйте одинаковые ID для разных отчётов — это может привести к ошибкам при генерации

Набор параметров запроса в объекте params зависит от типа отчёта. Чтобы получить описание параметров, выберите тип отчёта в раскрывающемся списке в описании параметра reportType.



Параметры includeSubstitutedSKUs и includeSearchTexts не могут одновременно иметь значение false.



Если не удалось получить отчёт, можно создать повторное задание на генерацию. Также можно получить список и проверить статусы отчётов.

Отчёты по остаткам — типы STOCK_HISTORY_REPORT_CSV и STOCK_HISTORY_DAILY_CSV — можно создать без подписки Джем
Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
id
required
	
string <uuid>

ID отчёта в UUID-формате. Генерируется продавцом самостоятельно


reportType
required
	
string

Тип отчёта DETAIL_HISTORY_REPORT — Воронка продаж. По артикулам WB

DETAIL_HISTORY_REPORT
GROUPED_HISTORY_REPORT
SEARCH_QUERIES_PREMIUM_REPORT_GROUP
SEARCH_QUERIES_PREMIUM_REPORT_PRODUCT
SEARCH_QUERIES_PREMIUM_REPORT_TEXT
STOCK_HISTORY_REPORT_CSV
STOCK_HISTORY_DAILY_CSV
DETAIL_HISTORY_REPORT

userReportName	
string

Название отчёта. Если не указано, сформируется автоматически


params
required
	
object

Параметры отчёта

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Example
SalesFunnelItemReq
SalesFunnelGroupReq
SearchReportGroupReq
SearchReportItemReq
SearchReportTextReq
InventoryMetricsReportReq
InventoryHistoryReportReq
SalesFunnelItemReq

Воронка продаж. По артикулам WB

Копировать
Показать все
{
"id": "06eae887-9d9f-491f-b16a-bb1766fcb8d2",
"reportType": "DETAIL_HISTORY_REPORT",
"userReportName": "Listing report",
"params": 
{
"nmIDs": 
[],
"subjectIds": 
[],
"brandNames": 
[],
"tagIds": 
[],
"startDate": "2024-06-21",
"endDate": "2024-06-23",
"timezone": "Europe/Moscow",
"aggregationLevel": "day",
"skipDeletedNm": false
}
}
Примеры ответа
200
400
401
402
403
429
Content type
application/json
Копировать
{
"data": "Началось формирование файла/отчета"
}
Получить список отчётов
/api/v2/nm-report/downloads
GET
https://seller-analytics-api.wildberries.ru/api/v2/nm-report/downloads
Описание метода

Метод возвращает список отчётов с расширенной аналитикой продавца. Ответ содержит ID созданных отчётов и статусы генерации.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
QUERY PARAMETERS
filter[downloadIds]	
Array of strings <uuid> [ items <uuid > ]

ID отчёта

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

403

Доступ запрещён

429

Слишком много запросов

Примеры ответа
200
400
401
403
429
Content type
application/json
Копировать
Показать все
{
"data": 
[
{}
]
}
Сгенерировать отчёт повторно
/api/v2/nm-report/downloads/retry
POST
https://seller-analytics-api.wildberries.ru/api/v2/nm-report/downloads/retry
Описание метода

Метод создает повторное задание на генерацию отчёта с расширенной аналитикой продавца. Необходимо, если при генерации отчёта вы получили статус FAILED.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
downloadId	
string <uuid>

ID отчёта

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

403

Доступ запрещён

429

Слишком много запросов

Примеры запроса
Payload
Content type
application/json
Копировать
{
"downloadId": "06eea887-9d9f-491f-b16a-bb1766fcb8d2"
}
Примеры ответа
200
400
401
403
429
Content type
application/json
Копировать
{
"data": "Retry"
}
Получить отчёт
/api/v2/nm-report/downloads/file/{downloadId}
GET
https://seller-analytics-api.wildberries.ru/api/v2/nm-report/downloads/file/{downloadId}
Описание метода

Метод возвращает отчёт с расширенной аналитикой продавца по ID задания на генерацию.

Можно получить отчёт, который сгенерирован за последние 48 часов.
Отчёт будет загружен внутри архива ZIP в формате CSV.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	3 запроса	20 сек	3 запроса
Сервисный	1 мин	3 запроса	20 сек	3 запроса
Базовый с секретом	1 мин	3 запроса	20 сек	3 запроса
Базовый	1 ч	1 запрос	1 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
PATH PARAMETERS
downloadId
required
	
string <uuid>

ID отчёта

Ответы
200

Успешно

400

Неправильный запрос

401

Не авторизован

402

Требуется платёж

403

Доступ запрещён

429

Слишком много запросов

Примеры ответа
200
400
401
402
403
429
Content type
application/zip
Example
SalesFunnelItemRes
SalesFunnelGroupRes
SearchReportGroupRes
SearchReportItemRes
SearchReportTextRes
InventoryMetricsReportRes
InventoryHistoryReportRes
SalesFunnelItemRes
Копировать
nmID, dt, openCardCount, addToCartCount, ordersCount, ordersSumRub, buyoutsCount, buyoutsSumRub, cancelCount, cancelSumRub, addToCartConversion, cartToOrderConversion, buyoutPercent, addToWishlist, currency
70027655,2024-11-21,1,0,0,0,0,0,0,0,0,0,0,0,RUB
...
...
150317666,2024-11-21,2,0,0,0,0,0,0,0,0,0,0,0,RUB

Пользовательское соглашение Сервиса «WB API»
Соглашение о предоставлении доступа к платформе WB API
Политика в отношении обработки ПД РВБ
Прайс-лист WB API для сторонних сервисов
FAQ. Ответы на часто задаваемые вопросы

© Wildberries 2004-2026. Все права защищены. Контактные данные: dev-info@rwb.ru

Мы используем cookies для сбора статистики и улучшения сервиса
Принять
