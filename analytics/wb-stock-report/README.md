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

## Токены — вписывать руками не нужно

Токен ищется автоматически (`lib/resolveWbToken.js`), по очереди:

1. Переменные окружения `WB_API_TOKEN` / `WB_STATS_TOKEN` /
   `WB_MARKETPLACE_TOKEN` / `WB_CONTENT_TOKEN`.
2. Любая «похоже названная» переменная окружения (`WB_TOKEN`,
   `WILDBERRIES_TOKEN`, `WB_API_KEY` …) — кроме MPSTATS.
3. `.env` / `.env.local` в корне репозитория.
4. Файл-токен: путь из `WB_TOKEN_FILE`, либо `~/.wb_token`,
   `~/.config/wb/token`, `<репо>/.wb-token`.
5. **macOS Keychain** (на Mac mini) — по сервисам `wb_api_token`, `wildberries`, `wb`.

Достаточно, чтобы токен лежал **в любом** из этих мест. Значение нигде не
логируется — в консоль печатается только источник и длина. Токен создаётся в
кабинете WB: **Настройки → Доступ к API** (категории «Статистика»,
«Маркетплейс», «Контент»).

Положить токен в Keychain один раз (тогда его нет ни в одном файле):

```bash
security add-generic-password -a "$USER" -s wb_api_token -w 'ВАШ_ТОКЕН'
```

FBS и карточки — best-effort: если токен не закрывает категорию, отчёт всё равно
соберётся по FBO, а в поле `warnings` попадёт причина (FBS покажется как 0).

**GitHub Actions:** токен берётся из секрета репозитория `WB_API_TOKEN`
(Settings → Secrets and variables → Actions). Запуск — вкладка **Actions →
«Отчёт — остатки WB» → Run workflow**; на выходе артефакт с CSV/JSON/XLSX.

## Быстрый старт на Mac mini (одна команда)

Если токен уже есть на маке (переменная окружения, Keychain или файл — см. раздел
«Токены»), вписывать ничего не нужно:

```bash
npm run wb-stock
#   (то же самое: ./scripts/run-wb-stock.sh)
```

Скрипт сам найдёт токен, вызовет API WB, положит `reports-output/wb-stock-<дата>.json`
и `.csv`, соберёт `.xlsx` рядом и откроет его в Excel/Numbers. Внешних npm-зависимостей
для сбора не нужно (встроенный `fetch` Node 18+); для Excel нужен `python3` + `openpyxl`
(скрипт поставит `openpyxl` сам, если его нет).

Если токен ещё нигде не лежит — положите его один раз любым способом, напр. в Keychain:
`security add-generic-password -a "$USER" -s wb_api_token -w 'ВАШ_ТОКЕН'`.

Требования: **Node.js 18+** (`brew install node`) и **Python 3** (`brew install python`).

## Запуск по шагам (если нужно вручную)

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
