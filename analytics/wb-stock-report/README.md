# Сводный отчёт по остаткам WB (FBO / FBS / в пути / возвраты)

Отчёт «на текущий момент» по каждому **артикулу продавца**:

- **FBO** — остаток на складах Wildberries (доступно и всего);
- **FBS** — остаток на фулфилмент-складах продавца;
- **В пути к клиенту** — товар, уехавший к покупателю (логистика FBO);
- **В пути от клиента** — товар, возвращающийся от покупателя (возвраты).

Плюс разрезы по складам FBO и FBS и отдельный лист движения (в пути/возвраты).

Источник — **официальное API Wildberries**:

| Данные | Эндпоинт | Категория токена |
|---|---|---|
| FBO + в пути + возвраты | `GET /api/v1/supplier/stocks` (statistics-api) | Статистика |
| Склады FBS | `GET /api/v3/warehouses` (marketplace-api) | Маркетплейс |
| Остатки FBS | `POST /api/v3/stocks/{warehouseId}` (marketplace-api) | Маркетплейс |
| Карточки (баркод ↔ артикул) | `POST /content/v2/get/cards/list` (content-api) | Контент |

## Токены

Нужен WB API-токен. Достаточно одного `WB_API_TOKEN`, если у него есть все три
категории. Иначе — раздельные `WB_STATS_TOKEN` / `WB_MARKETPLACE_TOKEN` /
`WB_CONTENT_TOKEN` (см. `.env.example`). Токен берётся в кабинете WB:
**Настройки → Доступ к API → создать токен** с нужными категориями.

FBS и карточки — best-effort: если токен не закрывает категорию, отчёт всё равно
соберётся по FBO, а в поле `warnings` попадёт причина (FBS покажется как 0).

## Запуск

**1. Собрать JSON/CSV (Node):**

```bash
WB_API_TOKEN=xxxxx npm run report:wb-stock
# → reports-output/wb-stock-<дата>.csv и .json + сводка в консоль
```

**2. Построить Excel-книгу из JSON (Python):**

```bash
pip install openpyxl
python analytics/wb-stock-report/build_report.py reports-output/wb-stock-<дата>.json wb-stock.xlsx
```

**По HTTP (сервис запущен):**

```bash
curl -H "x-api-key: $API_KEY" "http://localhost:8080/reports/wb-stock"              # JSON
curl -H "x-api-key: $API_KEY" "http://localhost:8080/reports/wb-stock?format=csv" -o wb-stock.csv
```

## Проверка без токена (dry-run)

Логика агрегации проверяется на фикстуре, без сети и токена:

```bash
node report-wb-stock.js --dry-run fixtures/wb-stock.sample.json
python analytics/wb-stock-report/build_report.py reports-output/wb-stock-*.json /tmp/wb.xlsx
```

## Листы Excel-книги

| Лист | Содержимое |
|---|---|
| **Сводка** | По артикулу продавца: FBO дост./всего, FBS, итого доступно, в пути к клиенту, возвраты. KPI-карточки, топ-15 по остатку. |
| **FBO по складам** | Остатки и логистика по складам WB. |
| **FBS по складам** | Остатки по фулфилмент-складам продавца. |
| **В пути и возвраты** | Артикулы с движением: в пути к клиенту и возвраты. |

## Заметки

- «Доступно к продаже сейчас» = `FBO доступно + FBS`. «FBO всего» включает
  зарезервированное и т.п. (`quantityFull` из API).
- Остатки FBS приходят по баркодам — агрегируются до артикула через карточки
  (Контент), с фолбэком на связку баркод↔артикул из ответа FBO.
- У книги выставлен `fullCalcOnLoad` — итоговые формулы пересчитываются при
  открытии в Excel/LibreOffice.
