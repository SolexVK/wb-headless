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
| [1] ТОП-10 по запросу + фильтр | `lib/wbTopKeywords.js` + `scripts/wb-top-keywords.mjs` | ✅ готов, эндпоинт MPStats залочен живым токеном (прогон end-to-end зелёный) |
| [3] Конкурентный анализ (блок воронки) | `lib/wbCompetitiveAnalysis.js` + `scripts/wb-competitive-analysis.mjs` | ✅ готов, отдаёт `analysis.json` + `analysis.md` |
| Оркестратор каскада | `scripts/wb-pipeline.mjs` | ✅ готов, сцепляет [1]→[2]→[3] в `reports-output/<run-id>/` |

Правило: **наш артикул всегда спрашиваем у пользователя**; артикулы конкурентов
приходят из этапа [1] или задаются вручную.

## Контракт данных «top-rivals» (этап [1], источник — MPSTATS)

`lib/wbTopKeywords.js` (`topByKeywords({ query, topN, filters, our })`) по
ключевому запросу берёт поисковую выдачу WB из MPSTATS, фильтрует по «уточнениям»
и отдаёт:

```jsonc
{
  "query": "платье женское",
  "source": "mpstats",
  "filters": { "minRating": 4.5, "minRevenue": 100000, "sortBy": "revenue",
               "excludeNmIds": ["167477208"], "topN": 10 },
  "fetched": 100,                          // сколько строк пришло из выдачи
  "rivals": [
    { "nmId":"185854387", "name","brand","price","rating","reviews",
      "sales","revenue","position" }
  ]
}
```

Массив `rivals` (точнее — `rivals.map(r => r.nmId)`, флаг CLI `--nmids-only`)
пригоден для пайпа прямо в `scripts/wb-cards-compare.mjs` (он читает JSON-массив
nmId из stdin) — так этапы [1] → [2] сцепляются без промежуточного клея.

**Фильтры/«уточнения»** (`filters` / флаги CLI): `minRevenue`, `minRating`,
`minReviews`, `minSales`, `priceMin`, `priceMax`, `excludeBrands`, `excludeNmIds`,
`sortBy` (`position`|`revenue`|`sales`|`rating`).

Доступ: `MPSTATS_TOKEN` (заголовок `X-Mpstats-TOKEN`). **Эндпоинт залочен живым
токеном:** `POST https://mpstats.io/api/analytics/v1/wb/search/items` (новый
versioned API «Товары по поисковой фразе», Laravel 422-валидация). Ключевое слово —
query-параметр **`path`** (обязателен); период `d1`/`d2` (важно: `d2` строго РАНЬШЕ
сегодня, иначе 422 — дефолт ставит d2=вчера); тело — ag-grid `{startRow,endRow}`.
Ответ — `{total, data:[{position,id,...}]}`, где `id` = nmId. Путь и имя параметра
оставлены в env (`MPSTATS_SEARCH_PATH`, `MPSTATS_SEARCH_QUERY_PARAM`) на случай
смены схемы. Старый `/wb/get/search` оказался html-заглушкой (пустой 200) — тупик.

## Контракт данных «competitive-analysis» (этап [3])

`lib/wbCompetitiveAnalysis.js` (`competitiveAnalysis({ cardsCompare })`) сравнивает
нашу карточку с конкурентами и отдаёт:

```jsonc
{
  "source": "wb-competitive-analysis",
  "our": "758196168", "ourName": "...", "periods": {...}, "rivalsCount": 3,
  "rivals": [ { "nmId","name","brand" } ],
  "funnel": {
    "stages": [ { "key":"ctrPct","label","unit","our","rivalsMedian","rivalsBest",
                  "rivalsWorst","gapToMedianPct","percentile","status" } ],  // CTR→корзина→заказ→выкуп
    "bottleneck": "cartConvPct"        // самый слабый этап vs конкуренты (или null)
  },
  "price": { "our","rivalsMedian",...,"tier":"premium|mid|budget" },
  "quality": { "cardRating":{...}, "reviewRating":{...}, "reviewCount":{...} },
  "searchPosition": { "our","rivalsMedian",...,"status" },   // меньше = лучше
  "trend": [ { "key","label","current","previous","deltaPct" } ] | null,  // период-к-периоду
  "findings": [ { "severity","area","message" } ],
  "recommendations": [ "..." ]
}
```

`status` каждого среза: `strong` (обходим ≥66% конкурентов) / `ok` / `weak` (≤34%).
`formatReport(analysis)` рендерит это в markdown-отчёт. CLI:
`node scripts/wb-competitive-analysis.mjs --in <cards-compare.json> [--json] [--out f]`.

## Оркестратор каскада (`scripts/wb-pipeline.mjs`)

Сцепляет всё одной командой; артефакты — в `reports-output/<run-id>/`
(`top-rivals.json`, `cards-compare.*`, `analysis.json`, `analysis.md`):

```bash
# DRY-RUN: [1] + план [2], лимит не тратим (данных для [3] ещё нет)
node scripts/wb-pipeline.mjs --query "платье женское" --our 758196168 --top 4 --min-rating 4.5
# Полный каскад (тратит 1 из лимита «Сравнения карточек», нужна живая сессия кабинета)
node scripts/wb-pipeline.mjs --query "платье женское" --our 758196168 --submit
# [2 готовое]→[3]: переиспользовать ранее посчитанное сравнение бесплатно
node scripts/wb-pipeline.mjs --our 758196168 --export-existing
```
