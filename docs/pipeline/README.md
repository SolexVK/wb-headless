# Каскад инструментов WB (pipeline) и контракты данных

Идея: не отдельные инструменты, а **конвейер**, где выход одного — вход другого.
Каждый инструмент говорит на общем «контракте данных» (нормализованный JSON,
ключ — `nmId`). Тогда их можно сцеплять в любой цепочке и запускать каскадом.

## Целевой каскад (пример полного анализа)

```
[1] ТОП-10 по ключевому запросу        (вход: запрос) 
        │  → top-rivals.json { query, rivals:[{nmId,...}] }
        ▼
[1a] Фильтр по доп. запросам            (вход: rivals + правила)
        │  → отфильтрованные nmId конкурентов
        ▼
[2] Сравнение карточек  ◀── НАШ артикул (его всегда спрашиваем у пользователя)
        │   вход: { our, rivals[] }
        │   → cards-compare.xlsx  +  cards-compare.json  (метрики воронки по nmId)
        ▼
[3] Конкурентный анализ                 (вход: cards-compare.json + доп. источники)
        │   блок воронки: CTR, конв. в корзину/заказ, % выкупа — из cards-compare.json
        ▼
      итоговый отчёт конкурентного анализа
```

Каждая стрелка — файл-артефакт в общем формате. Любой этап можно запустить
отдельно (если артефакт предыдущего уже есть) или всю цепочку целиком.

## Контракт данных «cards-compare» (готов)

Инструмент «Сравнение карточек» (`lib/wbCardsCompare.js`) при `--submit` или
`--export-existing` кладёт рядом с `*.xlsx` файл `*.json` такого вида
(`lib/wbCardsCompareParse.js`):

```jsonc
{
  "source": "wb-cards-compare",
  "our": "758196168",                     // наш артикул
  "periods": { "current": {"from","to"}, "previous": {"from","to"} },
  "articles": [
    { "nmId":"758196168", "isOur":true, "name","brand","category","subject","createdAt",
      "current": { "showings","cardTransitions","ctrPct","cartAdds","cartConvPct",
                   "orders","orderConvPct","buyouts","buyoutPct","cancels",
                   "avgSearchPosition","cardRating","reviewRating","reviewCount",
                   "priceMin","priceMax","medianPrice","avgDeliveryTime","promoStatus" },
      "previous": { /* те же ключи за предыдущий период */ } }
  ],
  "funnel": [                              // срез для «Конкурентного анализа»
    { "nmId","isOur","name","ctrPct","cartConvPct","orderConvPct","buyoutPct",
      "showings","orders","buyouts" }
  ]
}
```

`funnel` — именно то, что нужно блоку воронки в «Конкурентном анализе»
(CTR → корзина → заказ → выкуп по нам и конкурентам).

## Как сцеплять (программно)

Инструменты — это функции с чётким входом/выходом, поэтому оркестрация — обычный JS:

```js
import { topByKeywords } from './lib/wbTopKeywords.js';        // [2] (будущий)
import { runCardsComparison } from './lib/wbCardsCompare.js';  // [2] (готов)
import { competitiveAnalysis } from './lib/wbCompetitiveAnalysis.js'; // [3] (будущий)

const our = await askUser('наш артикул');                 // наш артикул — всегда у пользователя
const { rivals } = await topByKeywords({ query, topN: 10, filters });
const cmp = await runCardsComparison({ our, rivals: rivals.slice(0,4), submit: true });
// cmp.data — уже разобранный контракт cards-compare (или cmp.json — путь к файлу)
const report = await competitiveAnalysis({ cardsCompare: cmp.data /*, + другие источники */ });
```

Файловая конвенция (для запуска по шагам и переиспользования артефактов):
`reports-output/<run-id>/<stage>.json` — каждый этап читает предыдущий JSON.

## Статус

| Этап | Инструмент | Статус |
|---|---|---|
| [2] Сравнение карточек | `lib/wbCardsCompare.js` + парсер `wbCardsCompareParse.js` | ✅ готов, отдаёт `cards-compare.json` |
| [1] ТОП-10 по запросу + фильтр | `lib/wbTopKeywords.js` | ⏳ проектируется |
| [3] Конкурентный анализ (блок воронки) | `lib/wbCompetitiveAnalysis.js` | ⏳ проектируется |
| Оркестратор каскада | `scripts/wb-pipeline.mjs` | ⏳ проектируется |

Правило: **наш артикул всегда спрашиваем у пользователя**; артикулы конкурентов
приходят из этапа [1] или задаются вручную.
