# Handoff — потери Wildberries от пожаров на складах

Ветка: `claude/losses-wildberries-p8dhw6` (всё запушено в origin).
Токен WB: env `Wildberries_API` (JWT ~424 симв., персональный). Себестоимость 620 ₽/ед.

## Цель
Оценить убытки продавца от утраты товара на складах Wildberries, сгоревших/
повреждённых при атаках БПЛА (18.07–16.08.2026), и подать это в отчётах
(инфографика, карта, дашборд, поштучная таблица NMID×склад) в PDF и Excel.
Плюс: документация по WB API и лимиты (чтобы не ловить бан).

## Текущее состояние
Всё работает, прогнано на живом аккаунте. Основные сущности:
- **Потери** считаются по остаткам на сгоревших складах (× 620 ₽). Список складов —
  `config/fire-warehouses.json` (18 паттернов, из открытых источников).
- **⚠️ Ключевой факт:** WB прогрессивно **списывает** сгоревший товар — за ~4 дня
  обнулил 11 из 18 складов в `warehouse_remains`. Значит «текущие остатки» занижают
  потери. Поэтому для поштучной таблицы делаем МЕРЖ: свежий пул + последний снимок
  report:fire, пик по ячейке (NMID×склад). Снимки надо снимать регулярно.
- Готовые генераторы (все пишут в `reports-output/`, который в .gitignore):
  - `report:fire` → потери по складам (+ per-article), JSON/CSV.
  - `report:cabinet` → сводка: потери / FBO / FBS / в пути, JSON.
  - `report:matrix` → матрица NMID×склад (пик-мерж), JSON/CSV.
  - `pdf:fire` → PDF-инфографика потерь + страница-карта (bubble map).
  - `pdf:cabinet` → PDF-дашборд кабинета (2 стр.).
  - `xlsx:matrix` (Python/openpyxl) → Excel матрицы NMID×склад (+ лист «Итоги по складам»).
  - `pdf:matrix` → PDF (альбом) матрицы NMID×склад.
- Документация WB API втянута (лимиты, методы, финотчёты). Актуальный метод
  компенсаций — `POST finance-api /api/finance/v1/sales-reports/detailed`.

Последние цифры (снимок 2026-08-17, пик-мерж): **159 арт · 18 складов · 30 258 ед /
18 759 960 ₽**. Цифры плавают: стоящие склады растут, обнулённые выпадают.

## Файлы, над которыми работали (эта сессия — отчёт NMID×склад)
- `report-burned-matrix.mjs` — НОВЫЙ. Матрица NMID×склад: warehouse_remains (сейчас)
  + мерж с последним fire-losses снимком (обнулённые склады), пик по ячейке; ×620 ₽.
- `scripts/build-matrix-xlsx.py` — НОВЫЙ. Excel через openpyxl (2 листа, фильтры,
  закрепление, итоги). Требует `pip3 install openpyxl` (в этой сессии установлен).
- `scripts/build-matrix-pdf.mjs` — НОВЫЙ. PDF (A4 landscape), вертикальные заголовки
  складов, повтор шапки (thead), строка ИТОГО.
- `package.json` — добавлены report:matrix, xlsx:matrix, pdf:matrix.
- (ранее в проекте) report-fire-losses.mjs, report-cabinet.mjs, scripts/build-fire-pdf.mjs,
  scripts/build-cabinet-pdf.mjs, config/fire-warehouses.json, docs/wb-api/*, lib/wbClient.js.

## Что изменилось
- Появился поштучный отчёт (NMID×склад) в двух форматах — Excel и PDF — с колонкой
  по каждому складу, ×620 и суммой. Включён Коледино (обнулён в текущем remains,
  восстановлен из снимка 13.08 через пик-мерж).
- Источник per-NMID×склад для обнулённых складов — строка `articles[].warehouses`
  в fire-losses JSON (формат «Склад:qty; Склад:qty»), парсится в матрице.

## Что пробовали и НЕ сработало (грабли — читать!)
- **warehouse_remains — снимок «на сейчас».** WB обнуляет сгоревшее (за 4 дня −11
  складов из 18). Поэтому «потери по текущим остаткам» ЗАНИЖАЮТСЯ, а Коледино/
  Невинномысск/Рязань/Екатеринбург/Воронеж/Владимир/Котовск/Тверь/Красный Бор/
  Подольск уже НЕ видны. Обход: пик-мерж с последним снимком (max по ячейке).
  Побочный риск: если товар ПЕРЕМЕЩАли между складами, пик-сумма слегка ЗАВЫШАЕТ
  (double-count) — это верхняя граница; «сейчас» — нижняя. Честно помечено в отчётах.
- **FBS-остатки НЕ берутся из warehouse_remains** (там только FBO). FBS = свои склады
  продавца: `GET marketplace /api/v3/warehouses` (8 складов) + баркоды из
  `POST content /content/v2/get/cards/list` (пагинация курсором updatedAt+nmID) +
  `POST marketplace /api/v3/stocks/{warehouseId}` чанками по баркодам. barcode в
  warehouse_remains ПУСТОЙ — берём баркоды только из content.
- **Антибот dev.wildberries.ru** был непроходим (HTTP 498) в ранних сессиях; позже
  ПРОШЁЛ. Слаг финраздела — `financial-reports-and-accounting` (НЕ `financial-reports`,
  тот 498/404). Слаги в SPA не в href — искали перебором кандидатов в одной сессии.
- **openpyxl не был установлен** — `pip3 install openpyxl` (сеть через прокси, ок).
  Node-библиотек xlsx нет; Excel строим Python-ом.
- **require относительного пути / file:// относительного** в Node/Playwright падают —
  нужны абсолютные пути ($PWD).
- **Себестоимость** единая 620 ₽ (по решению пользователя), переопределяется `--cost`.
- **Казань/Зеленодольск** намеренно НЕ в сгоревших (uncertain в конфиге).

## Команды для проверки
```bash
# синтаксис всех генераторов
node --check report-burned-matrix.mjs && node --check scripts/build-matrix-pdf.mjs
node --check report-fire-losses.mjs && node --check report-cabinet.mjs
node --check scripts/build-fire-pdf.mjs && node --check scripts/build-cabinet-pdf.mjs
python3 -c "import openpyxl; print('openpyxl ok')"

# JSON-конфиги валидны
node -e "JSON.parse(require('fs').readFileSync('config/fire-warehouses.json','utf8'));console.log('cfg OK')"

# ПОЛНЫЙ пайплайн отчёта NMID×склад (нужен env Wildberries_API; бьёт живой WB API, read-only)
npm run report:matrix   # → reports-output/burned-matrix-<ts>.json/.csv
npm run xlsx:matrix     # → burned-matrix-<ts>.xlsx
npm run pdf:matrix      # → burned-matrix-pdf-<ts>.pdf
# прочие: report:fire→pdf:fire ; report:cabinet→pdf:cabinet
```
Ожидаемое состояние: все `node --check` и openpyxl-импорт — ЗЕЛЁНЫЕ. Полные прогоны
(report:*/xlsx:*/pdf:*) — ЗЕЛЁНЫЕ, дают непустые файлы (последний matrix: 159 арт /
30 258 ед / 18 759 960 ₽; цифры плавают). Формальных unit-тестов нет — «зелёное» =
скрипт отработал без ошибок и файл непустой. Красных нет.

## Автоснимок и персистентность (сделано в resume-сессии 2026-08-18)
- **peak-ledger:** `snapshots/peak-ledger.json` — КОММИТИТСЯ в git (в отличие от
  reports-output/), хранит пик остатков по каждой ячейке NMID×склад + history по
  датам. Это 3-й источник пик-мержа в `report-burned-matrix.mjs` (читается на старте,
  обновляется в конце). Нужен, т.к. контейнер эфемерный: без него история потерь
  (обнулённые склады) терялась бы между сессиями. Содержит данные продавца (private repo).
- **Ежедневный Routine:** `trig_014jAG9ucu5dyLoaqgkqKcSJ` — каждый день 07:00 МСК
  (cron `0 4 * * *` UTC), fresh-session, push-уведомление. Делает: checkout ветки →
  `node report-burned-matrix.mjs` → если ledger изменился, коммит+пуш только
  `snapshots/peak-ledger.json`. Управление: mcp Claude_Code_Remote (list_triggers /
  update_trigger / delete_trigger / fire_trigger). Первый запуск: 2026-08-19 04:01 UTC.

## Открытые вопросы (нужно решение пользователя)
Оба прежних вопроса РЕШЕНЫ: пик-мерж оставляем; ежедневный автоснимок настроен (см. выше).
Новых открытых развилок нет.

## Следующий шаг
После первого срабатывания Routine (2026-08-19 ~07:00 МСК) проверить, что fresh-сессия
успешно обновила и запушила `snapshots/peak-ledger.json` (git log ветки; history в
ledger должна получить запись за 2026-08-19). Если fresh-сессия падает на git/токене —
поправить промпт триггера (update_trigger). Иначе — по желанию пользователя доработки
форматов отчётов.
