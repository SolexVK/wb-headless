<!-- Источник: https://dev.wildberries.ru/docs/openapi/financial-reports-and-accounting -->
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
DBS
Самовывоз
Поставки FBW
Маркетинг и продвижение
Общение с покупателями
Тарифы
Аналитика и данные
Отчёты
Документы и бухгалтерия
Баланс
Финансовые отчёты
Документы
Документы и бухгалтерия
Узнать больше о документах и бухгалтерии можно в справочном центре

Просмотр баланса, финансовых отчётов и документов продавца.

Баланс
Для доступа к методам используйте токен для категории Финансы
Узнать больше о балансе продавца можно в справочном центре

Чтобы получить текущий баланс, воспользуйтесь методом загрузки.

Получить баланс продавца
/api/v1/account/balance
GET
https://finance-api.wildberries.ru/api/v1/account/balance
Описание метода

Метод возвращает данные виджета баланса на главной странице портала продавцов.



Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	1 запрос	1 мин	1 запрос
Сервисный	1 мин	1 запрос	1 мин	1 запрос
Базовый с секретом	1 мин	1 запрос	1 мин	1 запрос
Базовый	24 ч	1 запрос	24 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
Ответы
200

Успешно

401

Не авторизован

402

Требуется платёж

429

Слишком много запросов

Примеры ответа
200
401
402
429
Content type
application/json
Копировать
{
"currency": "RUB",
"current": 10196.21,
"for_withdraw": 6395.8
}
Финансовые отчёты
Для доступа к методам используйте токен для категории Финансы
Узнать больше о финансовых отчётах можно в справочном центре

Методы получения:

Списка отчётов реализации и детализаций к отчётам по ID и за период
Списка отчётов об издержках на приём платежей и детализаций к отчётам по ID и за период. Доступно только для продавцов из России
Вы можете выгрузить данные в Google Таблицы
Список отчётов реализации
/api/finance/v1/sales-reports/list
POST
https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list
Описание метода
Метод доступен по Персональному токену, Сервисному токену

Метод возвращает список отчётов релизации по формату таблицы отчётов.

Данные доступны с 1 января 2025 года.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	1 запрос	1 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
dateFrom
required
	
string

Начальная дата отчёта.
Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Дата передаётся в формате RFC3339, время — в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

dateTo
required
	
string

Конечная дата отчёта.
Дата в формате RFC3339. Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Время передаётся в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

limit	
integer <= 1000
Default: 1000

Количество отчётов в ответе


offset	
integer
Default: 0

Сколько элементов пропустить. Например, для значения 10 ответ начнётся с 11 элемента


period	
string
Default: "weekly"
Enum: "daily" "weekly"

Периодичность отчётов:

weekly — еженедельные
daily — ежедневные
Ответы
200

Успешно

204

Нет данных

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
"dateFrom": "2026-03-17",
"dateTo": "2026-03-20",
"limit": 211,
"offset": 345,
"period": "daily"
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
Свернуть все
[
{
"reportId": 307401554,
"sellerFinanceName": "ИП Кружинин В. Р.",
"dateFrom": "2026-03-16",
"dateTo": "2026-03-22",
"createDate": "2026-03-23",
"currency": "RUB",
"reportType": 1,
"retailAmountSum": "258",
"forPaySum": "183.79",
"avgSalePercent": 0,
"deliveryServiceSum": "2558.47",
"paidStorageSum": "626.84",
"paidAcceptanceSum": "243.81",
"deductionSum": "150",
"penaltySum": "1457.61",
"additionalPaymentSum": "9509.71",
"cashbackAmountSum": "2",
"cashbackDiscountSum": "19",
"cashbackCommissionChangeSum": "0.2",
"paymentSchedule": "-1",
"bankPaymentSum": "5172.94"
}
]
Детализации к отчётам реализации по ID отчётов
/api/finance/v1/sales-reports/detailed/{reportId}
POST
https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed/{reportId}
Описание метода
Метод доступен по Персональному токену, Сервисному токену

Метод возвращает детализации к отчётам реализации по ID отчётов.

Данные доступны с 1 января 2025 года.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	1 запрос	1 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
PATH PARAMETERS
reportId
required
	
integer <int64>

ID отчёта.
Для ежедневных отчётов вместо стандартной десериализации рекомендуем использовать нестандартные библиотеки с поддержкой BigInt

REQUEST BODY SCHEMA: application/json
required
limit	
integer <= 100000
Default: 100000

Количество строк в ответе


rrdId	
integer
Default: 0

ID строки ответа. Необходим для получения отчёта частями.
Начинайте загрузку отчёта с "rrdid":0. В последующих запросах передавайте значение rrdId из последней строки предыдущего ответа.
Повторяйте запрос, пока не получите ответ 204


fields	
Array of strings

Список полей, которые вернутся в ответе. Если параметр не указан, возвращаются все поля

Ответы
200

Успешно

204

Нет данных

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
"limit": 21100,
"rrdId": 0,
"fields": 
[
"rrdId",
"nmId",
"docTypeName",
"retailAmount",
"acquiringFee",
"srid"
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
Свернуть все
[
{
"reportId": 1234567,
"dateFrom": "2026-03-16",
"dateTo": "2026-03-22",
"createDate": "2026-03-23",
"currency": "RUB",
"reportType": 1,
"rrdId": 1232610467,
"giId": 123456,
"dlvPrc": 1.8,
"fixTariffDateFrom": "2026-03-18",
"fixTariffDateTo": "2026-03-19",
"subjectName": "Мини-печи",
"nmId": 1234567,
"brandName": "BlahBlah",
"vendorCode": "MAB123",
"title": "ДС тарелка",
"techSize": "0",
"sku": "1231312352310",
"docTypeName": "Продажа",
"quantity": 1,
"retailPrice": "1249",
"retailAmount": "367",
"salePercent": 0,
"commissionPercent": 24,
"officeName": "Склад WB",
"sellerOperName": "Продажа",
"orderDt": "2026-03-14T00:00:00Z",
"saleDt": "2026-03-21T00:00:00Z",
"rrDate": "2025-10-20",
"shkId": 1239159661,
"retailPriceWithDisc": "399.68",
"deliveryAmount": 0,
"returnAmount": 0,
"deliveryService": "0",
"giBoxTypeName": "Монопаллета",
"productDiscountForReport": 0,
"sellerPromo": "0",
"spp": 25.31,
"kvwBase": 24.15,
"kvw": 1.81,
"supRatingUp": 0,
"isKgvpV2": 0,
"ppvzSalesCommission": "23.74",
"forPay": "376.99",
"ppvzReward": "0",
"acquiringFee": "14.89",
"acquiringPercent": 4.06,
"paymentProcessing": "Комиссия за организацию платежа с НДС",
"acquiringBank": "Тинькофф",
"vw": "22.25",
"vwNds": "4.45",
"ppvzOfficeName": "Москва Москва Очаковское шоссе 6к2",
"ppvzOfficeId": 105383,
"ppvzSupplierName": "ИП Жасмин",
"ppvzSupplierInn": "010101010101",
"declarationNumber": "",
"bonusTypeName": "Штраф МП. Невыполненный заказ (отмена клиентом после недовоза)",
"stickerId": "1964038895",
"country": "Россия",
"srvDbs": true,
"penalty": "231.35",
"additionalPayment": "0",
"rebillLogisticCost": "1.349",
"rebillLogisticOrg": "ИП Иванов Иван Иванович(123456789012)",
"paidStorage": "12647.29",
"deduction": "6354",
"paidAcceptance": "865",
"orderId": 2816993144,
"kiz": "0102900000376311210G2CIS?ehge)S\u001d91002A\u001d92F9Qof4FDo/31Icm14kmtuVYQzLypxm3HWkC1vQ/+pVVjm1dNAth1laFMoAGn7yEMWlTjxIe7lQnJqZ7TRZhlHQ==",
"isB2b": false,
"trbxId": "WB-TRBX-1234567",
"installmentCofinancingAmount": "0",
"wibesDiscountPercent": 1,
"cashbackAmount": "2",
"cashbackDiscount": "19",
"cashbackCommissionChange": "0.2",
"paymentSchedule": "-1",
"deliveryMethod": "FBS, (МГТ)",
"sellerPromoId": 14350,
"sellerPromoDiscount": 3,
"loyaltyId": 0,
"loyaltyDiscount": 0,
"uuidPromocode": "",
"salePricePromocodeDiscountPrc": 0,
"articleSubstitution": "",
"salePriceAffiliatedDiscountPrc": 0,
"agencyVat": 0,
"salePriceWholesaleDiscountPrc": 0,
"b2bCustomerTin": "010101010101",
"paidWithSocialCertificate": false,
"warehouseLogisticsCoeff": 0,
"orderUid": "id375f16c4bec295d9995393af803ff7b",
"srid": "0f1c3999172603062979867564654dac5b702849"
}
]
Детализации к отчётам реализации за период
/api/finance/v1/sales-reports/detailed
POST
https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed
Описание метода

Метод возвращает детализации к отчётам реализации за указанный период.

Данные доступны с 29 января 2024 года.

Вы можете выгрузить данные в Google Таблицы
Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	1 мин	1 запрос	1 мин	1 запрос
Сервисный	1 мин	1 запрос	1 мин	1 запрос
Базовый с секретом	1 мин	1 запрос	1 мин	1 запрос
Базовый	24 ч	2 запроса	12 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
dateFrom
required
	
string

Начальная дата отчёта.
Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Дата передаётся в формате RFC3339, время — в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

dateTo
required
	
string

Конечная дата отчёта.
Дата в формате RFC3339. Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Время передаётся в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

limit	
integer <= 100000
Default: 100000

Количество строк в ответе


rrdId	
integer
Default: 0

ID строки ответа. Необходим для получения отчёта частями.
Начинайте загрузку отчёта с "rrdid":0. В последующих запросах передавайте значение rrdId из последней строки предыдущего ответа.
Повторяйте запрос, пока не получите ответ 204


period	
string
Default: "weekly"
Enum: "daily" "weekly"

Периодичность отчётов:

weekly — еженедельные
daily — ежедневные

fields	
Array of strings

Список полей, которые вернутся в ответе. Если параметр не указан, возвращаются все поля

Ответы
200

Успешно

204

Нет данных

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
Свернуть все
{
"dateFrom": "2026-03-17",
"dateTo": "2026-03-20",
"limit": 21100,
"rrdId": 0,
"period": "daily",
"fields": 
[
"rrdId",
"nmId",
"docTypeName",
"retailAmount",
"acquiringFee",
"srid"
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
"reportId": 1234567,
"dateFrom": "2026-03-16",
"dateTo": "2026-03-22",
"createDate": "2026-03-23",
"currency": "RUB",
"reportType": 1,
"rrdId": 1232610467,
"giId": 123456,
"dlvPrc": 1.8,
"fixTariffDateFrom": "2026-03-18",
"fixTariffDateTo": "2026-03-19",
"subjectName": "Мини-печи",
"nmId": 1234567,
"brandName": "BlahBlah",
"vendorCode": "MAB123",
"title": "ДС тарелка",
"techSize": "0",
"sku": "1231312352310",
"docTypeName": "Продажа",
"quantity": 1,
"retailPrice": "1249",
"retailAmount": "367",
"salePercent": 0,
"commissionPercent": 24,
"officeName": "Склад WB",
"sellerOperName": "Продажа",
"orderDt": "2026-03-14T00:00:00Z",
"saleDt": "2026-03-21T00:00:00Z",
"rrDate": "2025-10-20",
"shkId": 1239159661,
"retailPriceWithDisc": "399.68",
"deliveryAmount": 0,
"returnAmount": 0,
"deliveryService": "0",
"giBoxTypeName": "Монопаллета",
"productDiscountForReport": 0,
"sellerPromo": "0",
"spp": 25.31,
"kvwBase": 24.15,
"kvw": 1.81,
"supRatingUp": 0,
"isKgvpV2": 0,
"ppvzSalesCommission": "23.74",
"forPay": "376.99",
"ppvzReward": "0",
"acquiringFee": "14.89",
"acquiringPercent": 4.06,
"paymentProcessing": "Комиссия за организацию платежа с НДС",
"acquiringBank": "Тинькофф",
"vw": "22.25",
"vwNds": "4.45",
"ppvzOfficeName": "Москва Москва Очаковское шоссе 6к2",
"ppvzOfficeId": 105383,
"ppvzSupplierName": "ИП Жасмин",
"ppvzSupplierInn": "010101010101",
"declarationNumber": "",
"bonusTypeName": "Штраф МП. Невыполненный заказ (отмена клиентом после недовоза)",
"stickerId": "1964038895",
"country": "Россия",
"srvDbs": true,
"penalty": "231.35",
"additionalPayment": "0",
"rebillLogisticCost": "1.349",
"rebillLogisticOrg": "ИП Иванов Иван Иванович(123456789012)",
"paidStorage": "12647.29",
"deduction": "6354",
"paidAcceptance": "865",
"orderId": 2816993144,
"kiz": "0102900000376311210G2CIS?ehge)S\u001d91002A\u001d92F9Qof4FDo/31Icm14kmtuVYQzLypxm3HWkC1vQ/+pVVjm1dNAth1laFMoAGn7yEMWlTjxIe7lQnJqZ7TRZhlHQ==",
"isB2b": false,
"trbxId": "WB-TRBX-1234567",
"installmentCofinancingAmount": "0",
"wibesDiscountPercent": 1,
"cashbackAmount": "2",
"cashbackDiscount": "19",
"cashbackCommissionChange": "0.2",
"paymentSchedule": "-1",
"deliveryMethod": "FBS, (МГТ)",
"sellerPromoId": 14350,
"sellerPromoDiscount": 3,
"loyaltyId": 0,
"loyaltyDiscount": 0,
"uuidPromocode": "",
"salePricePromocodeDiscountPrc": 0,
"articleSubstitution": "",
"salePriceAffiliatedDiscountPrc": 0,
"agencyVat": 0,
"salePriceWholesaleDiscountPrc": 0,
"b2bCustomerTin": "010101010101",
"paidWithSocialCertificate": false,
"warehouseLogisticsCoeff": 0,
"orderUid": "id375f16c4bec295d9995393af803ff7b",
"srid": "0f1c3999172603062979867564654dac5b702849"
}
]
Список отчётов об издержках на приём платежей
/api/finance/v1/acquiring/list
POST
https://finance-api.wildberries.ru/api/finance/v1/acquiring/list
Описание метода
Метод доступен по Персональному токену, Сервисному токену

Метод возвращает список отчётов об издержках на приём платежей по формату таблицы отчётов.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	1 запрос	1 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
dateFrom
required
	
string

Начальная дата отчёта.
Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Дата передаётся в формате RFC3339, время — в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

dateTo
required
	
string

Конечная дата отчёта.
Дата в формате RFC3339. Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Время передаётся в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

limit	
integer <= 1000
Default: 1000

Количество отчётов в ответе


offset	
integer
Default: 0

Сколько элементов пропустить. Например, для значения 10 ответ начнётся с 11 элемента

Ответы
200

Успешно

204

Нет данных

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
"dateFrom": "2026-03-17",
"dateTo": "2026-03-20",
"limit": 211,
"offset": 345
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
Свернуть все
[
{
"reportId": 307401554,
"sellerFinanceName": "ИП Кружинин В. Р.",
"dateFrom": "2026-03-16",
"dateTo": "2026-03-22",
"createDate": "2026-03-31",
"currency": "RUB",
"acquiringFeeSum": "258",
"acquiringFeeVatSum": "83.79"
}
]
Детализации к отчётам об издержках на приём платежей по ID отчётов
/api/finance/v1/acquiring/detailed/{reportId}
POST
https://finance-api.wildberries.ru/api/finance/v1/acquiring/detailed/{reportId}
Описание метода
Метод доступен по Персональному токену, Сервисному токену

Метод возвращает детализации к отчётам об издержках на приём платежей по ID отчётов.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	1 запрос	1 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
PATH PARAMETERS
reportId
required
	
integer <int64>

ID отчёта

REQUEST BODY SCHEMA: application/json
required
limit	
integer <= 100000
Default: 100000

Количество строк в ответе


rrdId	
integer
Default: 0

ID строки ответа. Необходим для получения отчёта частями.
Начинайте загрузку отчёта с "rrdid":0. В последующих запросах передавайте значение rrdId из последней строки предыдущего ответа.
Повторяйте запрос, пока не получите ответ 204


fields	
Array of strings

Список полей, которые вернутся в ответе. Если параметр не указан, возвращаются все поля

Ответы
200

Успешно

204

Нет данных

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
"limit": 21100,
"rrdId": 0,
"fields": 
[
"rrdId",
"nmId",
"docTypeName",
"retailAmount",
"acquiringFee",
"srid"
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
Свернуть все
[
{
"rrdId": 1232610467,
"reportId": 1234567,
"acqDate": "2026-03-21",
"acquiringBank": "Тинькофф",
"tin": "010101010101",
"taxRegistrationReasonCode": "7701123301",
"saleDate": "2026-03-21",
"srid": "D0.r3f80c3eec6f845c6840128b4c19986f9.0.0",
"docTypeName": "Продажа",
"nmId": 1234567,
"retailAmount": "367",
"acquiringFee": "14.89",
"acquiringFeeVat": "4.06",
"invoiceNumber": "С/Ф 123",
"invoiceDate": "2026-03-20",
"shkId": 1239159661,
"currency": "RUB"
}
]
Детализации к отчётам об издержках на приём платежей за период
/api/finance/v1/acquiring/detailed
POST
https://finance-api.wildberries.ru/api/finance/v1/acquiring/detailed
Описание метода
Метод доступен по Персональному токену, Сервисному токену

Метод возвращает детализации к отчётам об издержках на приём платежей за указанный период.

Лимит запросов на один аккаунт продавца:
Период	Лимит	Интервал	Всплеск
1 мин	1 запрос	1 мин	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
required
dateFrom
required
	
string

Начальная дата отчёта.
Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Дата передаётся в формате RFC3339, время — в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

dateTo
required
	
string

Конечная дата отчёта.
Дата в формате RFC3339. Можно передать дату или дату со временем. Время можно указывать с точностью до секунд или миллисекунд.
Время передаётся в часовом поясе Москва UTC+3.
Примеры:

2025-06-20
2025-06-20T23:59:59
2025-06-20T00:00:00.12345
2025-06-20T00:00:00

limit	
integer <= 100000
Default: 100000

Количество строк в ответе


rrdId	
integer
Default: 0

ID строки ответа. Необходим для получения отчёта частями.
Начинайте загрузку отчёта с "rrdid":0. В последующих запросах передавайте значение rrdId из последней строки предыдущего ответа.
Повторяйте запрос, пока не получите ответ 204


fields	
Array of strings

Список полей, которые вернутся в ответе. Если параметр не указан, возвращаются все поля

Ответы
200

Успешно

204

Нет данных

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
"dateFrom": "2026-03-17",
"dateTo": "2026-03-20",
"limit": 21100,
"rrdId": 0,
"fields": 
[
"rrdId",
"nmId",
"docTypeName",
"retailAmount",
"acquiringFee",
"srid"
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
Свернуть все
[
{
"rrdId": 1232610467,
"reportId": 1234567,
"acqDate": "2026-03-21",
"acquiringBank": "Тинькофф",
"tin": "010101010101",
"taxRegistrationReasonCode": "7701123301",
"saleDate": "2026-03-21",
"srid": "D0.r3f80c3eec6f845c6840128b4c19986f9.0.0",
"docTypeName": "Продажа",
"nmId": 1234567,
"retailAmount": "367",
"acquiringFee": "14.89",
"acquiringFeeVat": "4.06",
"invoiceNumber": "С/Ф 123",
"invoiceDate": "2026-03-20",
"shkId": 1239159661,
"currency": "RUB"
}
]
Документы
Для доступа к методам используйте токен для категории Документы

С помощью этих методов вы можете получить документы продавца различных категорий: акты, бухгалтерские отчёты, оферты, письма, списки товаров, УКД, УПД, уведомления и так далее.

Для работы с документами получите списки:

Категорий документов
Документов продавца, доступных для загрузки

Вы можете загрузить один или несколько документов из полученного списка.

Категории документов
/api/v1/documents/categories
GET
https://documents-api.wildberries.ru/api/v1/documents/categories
Описание метода

Метод возвращает категории документов для получения списка документов продавца.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	10 сек	1 запрос	10 сек	5 запросов
Сервисный	10 сек	1 запрос	10 сек	5 запросов
Базовый с секретом	10 сек	1 запрос	10 сек	5 запросов
Базовый	24 ч	1 запрос	24 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
QUERY PARAMETERS
locale	
string
Default: "en"
Example: locale=ru

Язык поля title:

ru — русский
en — английский
zh — китайский
Ответы
200

Успешно

401

Не авторизован

402

Требуется платёж

429

Слишком много запросов

Примеры ответа
200
401
402
429
Content type
application/json
Копировать
Показать все
{
"data": 
{
"categories": 
[]
}
}
Список документов
/api/v1/documents/list
GET
https://documents-api.wildberries.ru/api/v1/documents/list
Описание метода

Метод возвращает список документов продавца. Вы можете получить один или несколько документов из полученного списка.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	10 сек	1 запрос	10 сек	5 запросов
Сервисный	10 сек	1 запрос	10 сек	5 запросов
Базовый с секретом	10 сек	1 запрос	10 сек	5 запросов
Базовый	24 ч	1 запрос	24 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
QUERY PARAMETERS
locale	
string
Default: "en"
Example: locale=ru

Язык поля category:

ru — русский
en — английский
zh — китайский

beginTime	
string <date>
Example: beginTime=2024-07-09

Начало периода. Только вместе с endTime


endTime	
string <date>
Example: endTime=2024-07-15

Конец периода. Только вместе с beginTime


sort	
string
Default: "date"
Enum: "date" "category"
Example: sort=category

Сортировка:

date — по дате создания документа
category — по категории (только при locale=ru)

Только вместе с order


order	
string
Default: "desc"
Enum: "desc" "asc"
Example: order=asc

Сортировка:

desc — по убыванию
asc — по возрастанию

Только вместе с sort


category	
string
Example: category=redeem-notification

ID категории документов из поля name


serviceName	
string
Example: serviceName=redeem-notification-44841941

Уникальный ID документа


limit	
integer <= 50
Default: 50
Example: limit=10

Максимальное количество строк ответа


offset	
integer
Default: 0
Example: offset=90

После какой строки выдавать данные

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
{
"data": 
{
"documents": 
[]
}
}
Получить документ
/api/v1/documents/download
GET
https://documents-api.wildberries.ru/api/v1/documents/download
Описание метода

Метод загружает один документ из списка документов продавца.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	10 сек	1 запрос	10 сек	5 запросов
Сервисный	10 сек	1 запрос	10 сек	5 запросов
Базовый с секретом	10 сек	1 запрос	10 сек	5 запросов
Базовый	24 ч	1 запрос	24 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
QUERY PARAMETERS
serviceName
required
	
string
Example: serviceName=redeem-notification-44841941

Уникальный ID документа


extension
required
	
string
Example: extension=zip

Формат документа

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
{
"data": 
{
"fileName": "Notice of redemption 44841941.zip",
"extension": "zip",
"document": "UEsDBBQACAgIAAAAAAAAAAAAAAAAAAAAAABHAAAA0KPQstC10LTQvtC80LvQtdC90LjQtSDQviDQstGL0LrRg9C/0LUg4oSWNDQ4NDE5NDEg0L7RgiAyNS4wOS4yMDIzLnhsc3jsnQk0lP3f/0dEUiRkNwmVECI7o0WS7EklxprdkH2bKVkqISRkGSlkaxRlN2TPnmzJvu/Gzmz/Uz33fY/L8/Q8zrn/x/07565zcjrn9f1cn/V6f69v53zTVCWnYATtA+0DAX/Rg0AgM5ip5l2Yg5OwKeyu+Wl3O1vbcA3YV5FDVfPej2vXKptOK1V9LjycmPDG72uW4vcG9xdsOI1V2wj86sk6+4nHJeZ92NFgC/He3gmDlccFXSyumXYUGSKK4hLLsqu5aBTspu5lqlcGB/JNlQVn1Eumj6o8ZEWPRotEVGkH9/kf457totEKj2N2P4dSZWAIaC0ajy5J+VL5fen1YOhcGMxvvUw+XOKFOHL...LSL/tC77s0GzTi2iBuHorbMpcOaw0Hmsc/gpk7ty3/cdDYRmhkRUPAIC37P94CA8oiP/fIvpPK8n9l43YARWRgH/tI6E3ntD/nfOfPyj9jxxDwn+b8/8dZqBDQPjPNSAACJgBAAD21P9s/y8AAP//UEsHCFHrudyQEwAASxQAAFBLAQIUABQACAgIAAAAAACH4v2BaSgAAGNjAABHAAAAAAAAAAAAAAAAAAAAAADQo9Cy0LXQtNC+0LzQu9C10L3QuNC1INC+INCy0YvQutGD0L/QtSDihJY0NDg0MTk0MSDQvtGCIDI1LjA5LjIwMjMueGxzeFBLAQIUABQACAgIAAAAAADTmLxwRQcAAGAPAABLAAAAAAAAAAAAAAAAAN4oAADQo9Cy0LXQtNC+0LzQu9C10L3QuNC1INC+INCy0YvQutGD0L/QtSDihJY0NDg0MTk0MSDQvtGCIDI1LjA5LjIwMjMueGxzeC5zaWdQSwECFAAUAAgACAAAAAAAUeu53JATAABLFAAACAAAAAAAAAAAAAAAAACcMAAAbWNoZC56aXBQSwUGAAAAAAMAAwAkAQAAYkQAAAAA"
}
}
Получить документы
/api/v1/documents/download/all
POST
https://documents-api.wildberries.ru/api/v1/documents/download/all
Описание метода

Метод загружает несколько документов из списка документов продавца.

Лимит запросов на один аккаунт продавца:
Тип	Период	Лимит	Интервал	Всплеск
Персональный	5 мин	1 запрос	5 мин	5 запросов
Сервисный	5 мин	1 запрос	5 мин	5 запросов
Базовый с секретом	5 мин	1 запрос	5 мин	5 запросов
Базовый	24 ч	1 запрос	24 ч	1 запрос
AUTHORIZATIONS:
HeaderApiKey
REQUEST BODY SCHEMA: application/json
params	
Array of objects [ 1 .. 50 ] items
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
"params": 
[
{},
{}
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
{
"data": 
{
"fileName": "documents.zip",
"extension": "zip",
"document": "UEsDBBQACAgIAAAAAAAAAAAAAAAAAAAAAABHAAAA0KPQstC10LTQvtC80LvQtdC90LjQtSDQviDQstGL0LrRg9C/0LUg4oSWNDQ4NDE5NDEg0L7RgiAyNS4wOS4yMDIzLnhsc3jsnQk0lP3f/0dEUiRkNwmVECI7o0WS7EklxprdkH2bKVkqISRkGSlkaxRlN2TPnmzJvu/Gzmz/Uz33fY/L8/Q8zrn/x/07565zcjrn9f1cn/V6f69v53zTVCWnYATtA+0DAX/Rg0AgM5ip5l2Yg5OwKeyu+Wl3O1vbcA3YV5FDVfPej2vXKptOK1V9LjycmPDG72uW4vcG9xdsOI1V2wj86sk6+4nHJeZ92NFgC/He3gmDlccFXSyumXYUGSKK4hLLsqu5aBTspu5lqlcGB/JNlQVn1Eumj6o8ZEWPRotEVGkH9/kf457totEKj2N2P4dSZWAIaC0ajy5J+VL5fen1YOhcGMxvvUw+XOKFOHL...LSL/tC77s0GzTi2iBuHorbMpcOaw0Hmsc/gpk7ty3/cdDYRmhkRUPAIC37P94CA8oiP/fIvpPK8n9l43YARWRgH/tI6E3ntD/nfOfPyj9jxxDwn+b8/8dZqBDQPjPNSAACJgBAAD21P9s/y8AAP//UEsHCFHrudyQEwAASxQAAFBLAQIUABQACAgIAAAAAACH4v2BaSgAAGNjAABHAAAAAAAAAAAAAAAAAAAAAADQo9Cy0LXQtNC+0LzQu9C10L3QuNC1INC+INCy0YvQutGD0L/QtSDihJY0NDg0MTk0MSDQvtGCIDI1LjA5LjIwMjMueGxzeFBLAQIUABQACAgIAAAAAADTmLxwRQcAAGAPAABLAAAAAAAAAAAAAAAAAN4oAADQo9Cy0LXQtNC+0LzQu9C10L3QuNC1INC+INCy0YvQutGD0L/QtSDihJY0NDg0MTk0MSDQvtGCIDI1LjA5LjIwMjMueGxzeC5zaWdQSwECFAAUAAgACAAAAAAAUeu53JATAABLFAAACAAAAAAAAAAAAAAAAACcMAAAbWNoZC56aXBQSwUGAAAAAAMAAwAkAQAAYkQAAAAA"
}
}
Пользовательское соглашение Сервиса «WB API»
Соглашение о предоставлении доступа к платформе WB API
Политика в отношении обработки ПД РВБ
Прайс-лист WB API для сторонних сервисов
FAQ. Ответы на часто задаваемые вопросы

© Wildberries 2004-2026. Все права защищены. Контактные данные: dev-info@rwb.ru

Мы используем cookies для сбора статистики и улучшения сервиса
Принять
