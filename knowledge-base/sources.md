# Источники и статус обработки

Сырые транскрибации хранятся в [`sources/`](sources/). Ниже — соответствие «урок → темы».

## Обработанные уроки (16)

| Файл источника | Тема урока | Куда разнесено |
|----------------|-----------|----------------|
| `sources/lesson-01-voronka-algoritm.txt` | Воронка продаж, алгоритм ранжирования, смыслы, принадлежность, цена, отзывы/рич-контент (обзорно) | [01](01-algoritm-ranzhirovaniya-voronka.md), [02](02-zaprosy-podskazki-prinadlezhnost.md), [05](05-cena-i-cenovaya-segmentaciya.md), [06](06-otzyvy-rich-content-konversii.md) |
| `sources/lesson-02-listing-infografika.txt` | Листинг и инфографика: 10 вопросов смыслов, принципы одежды/товарки, оформление слайдов | [03](03-listing-infografika.md) |
| `sources/lesson-03-analiz-listinga-gem.txt` | Анализ листинга конкурентов, сегменты, Gem/Competition, Keywords, теги смыслов, ассоциированные конверсии, рич-контент | [04](04-konkurentnyy-analiz-metodika.md), [06](06-otzyvy-rich-content-konversii.md) |
| `sources/lesson-04-dz-smysly-zaprosy.txt` | ДЗ: смыслы в запросах, Competition (наш + 4 конкурента) | [04](04-konkurentnyy-analiz-metodika.md) |
| `sources/lesson-05-neyropostroyka-ai.txt` | Нейропостройка листинга: nano-banana, Gemini, Veo, Klink, апскейлер, GoLogin; какие базовые фото нужны; видео как ответы на вопросы | [07](07-proizvodstvo-kontenta-ai.md) |
| `sources/lesson-06-podbor-tovara.txt` | Подбор товара, «супер-карточка», цвет/характеристики/категория, СПП-пороги, метод «прошлое → будущее», сезонность | [09](09-podbor-tovara-supr-kartochka.md), [05](05-cena-i-cenovaya-segmentaciya.md) |
| `sources/lesson-07-dz-osobennosti-tovara.txt` | ДЗ №4: таблица особенностей товара (своя + 2 конкурента), одежда и товарка | [09](09-podbor-tovara-supr-kartochka.md) |
| `sources/lesson-08-razbor-svarka-kombinezon.txt` | Живой разбор: сварка (ракурс, клеммы, депонирование, склейка) и детский комбинезон (неочевидные факторы, мембрана/альпалюкс) | [03](03-listing-infografika.md), [04](04-konkurentnyy-analiz-metodika.md), [06](06-otzyvy-rich-content-konversii.md), [10](10-ab-testy-polki-personalizaciya.md) |
| `sources/lesson-09-razbor-trusy.txt` | Живой разбор: женские трусы (набор vs комплект, контур-модель, цветовая раскладка, АБ-тест, полки, персонализация) | [03](03-listing-infografika.md), [06](06-otzyvy-rich-content-konversii.md), [09](09-podbor-tovara-supr-kartochka.md), [10](10-ab-testy-polki-personalizaciya.md) |
| `sources/lesson-10-seo-optimizaciya-1.txt` | SEO часть 1: алгоритм (Яндекс/LCA), кластеры, зоны индексации, наименование, характеристики, категории, сбор запросов (Wildbox/Keywords), текст через ChatGPT | [11](11-seo-optimizaciya.md) |
| `sources/lesson-11-seo-optimizaciya-2.txt` | SEO часть 2 (ДЗ №5): номинование, характеристики только правда, категории/подкатегории, сбор слов, промпт для текста (одежда/товарка) | [11](11-seo-optimizaciya.md) |

> Примечание: во второй партии файлы уроков 007/008/009 пришли повторно (дубли уже обработанных
> lesson-07/08/09) — не дублировались в базе. Новыми были только два урока по SEO (10, 11).

| `sources/lesson-12-wildbox-seo.txt` | Эфир Wildbox: полный цикл сбора/чистки SEO (кластеризатор, поисковые подсказки, SEO AI, группировка, SEO-тексты, анализ характеристик) | [11](11-seo-optimizaciya.md), [08](08-instrumenty-i-servisy.md) |
| `sources/lesson-13-reklama-prinadlezhnost.txt` | Реклама/продвижение (3-й модуль): СПП/ВБ-кошелёк, золотые места, формула акций, персонализация, идентификатор поисковой выдачи, АРК/АУК стратегия, **принадлежность запроса** | [12](12-reklama-prodvizhenie.md), [13](13-prinadlezhnost-zaprosa.md), [05](05-cena-i-cenovaya-segmentaciya.md) |
| `sources/lesson-14-wildbox-podbor-nishi.txt` | Эфир Wildbox: подбор ниши от спроса (Оракул запросов, анализ сезонности/демпинг, ценовые сегменты, нейро-образ товара) | [14](14-podbor-nishi-wildbox.md) |
| `sources/lesson-15-pushka-bot-funkcii.txt` | Функции Пушка-бота: полки-мониторинг, полки-reports (CTR/30 мин), аналитика рекламы через токен, HITS, анализ склейки | [08](08-instrumenty-i-servisy.md), [12](12-reklama-prodvizhenie.md) |
| `sources/lesson-16-ocifrovka-unit-ekonomika.txt` | Оцифровка/юнит-экономика: приход на р/с, поборы WB ~48% (2025), чистая прибыль ~7%, средний чек vs цена клиента, Ozon | [15](15-yunit-ekonomika-benchmarks.md) |

## Заметки по качеству источника

- Это транскрибации речи с вебинаров: есть повторы, оговорки, шум распознавания. При переносе
  в Wiki факты нормализованы и сгруппированы по темам; спорные места помечены «⚠️ уточнить».
- Нумерация файлов источников (001–005) сохранена в префиксах для сверки.

## Ожидаемые темы (из обещаний в уроках)

- ~~SEO-оптимизация карточки~~ — ✅ закрыто (уроки 10–12, файл [11](11-seo-optimizaciya.md)).
- ~~Реклама и продвижение (3-й модуль)~~ — ✅ базово закрыто (урок 13, файл [12](12-reklama-prodvizhenie.md)); ожидаются практические вебинары по стратегиям в Радаре (Шторм-3) с пошаговыми разборами ставок.
- ~~Принадлежность запроса~~ — ✅ закрыто (урок 13, файл [13](13-prinadlezhnost-zaprosa.md)).
- Ожидается: отдельные вебинары по новым стратегиям в Радаре (АРК/АУК автоматизация), ассоциативные конверсии в РК (плагин), готовые ДЗ по принадлежности и рекламе.
- Формула цены для маркетплейса; влияние цены на % выкупа.
- Расширенный вебинар по инфографике; репрайсер; оцифровка/юнит-экономика.

## Процесс добавления новых уроков

1. Положить транскрибацию в `sources/lesson-NN-краткое-имя.txt`.
2. Разнести факты по тематическим файлам (01–08), не создавая дублей; при новой крупной теме —
   завести файл `09-...`, `10-...` и добавить в [README](README.md).
3. Обновить эту таблицу и счётчик уроков в [README](README.md).
