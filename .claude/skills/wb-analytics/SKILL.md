---
name: wb-analytics
description: Единый конфиг-управляемый анализ товаров/ниш/продавцов на Wildberries по данным MPStats API с рендером в стильный многостраничный PDF. Подходит под любой тип товара и нишу — всё задаётся JSON-конфигом. Триггеры — «/wb-analytics», «проанализируй нишу/карточку/конкурента на WB», «конкурентный анализ продавца», «собери PDF-отчёт по MPStats».
---

# wb-analytics — единый анализ WB × MPStats → PDF

Единая аналитическая система живёт в `wb_analytics/` (см. `wb_analytics/README.md`).
Один шаблон покрывает все прежние навыки: анализ карточки конкурента, анализ ниши,
конкурентный анализ продавца и сборку красивого PDF. Тип товара и ниша задаются
**конфигом**, код/вёрстка не меняются.

## Как выполнять запрос

1. **Собери конфиг** под задачу пользователя (за образец — `wb_analytics/configs/*.example.json`):
   - `category` — путь категории MPStats (при необходимости найди точный путь через дерево
     `/wb/get/categories`).
   - `niche_name`, `segment_name`, `segment_note`, `comparable` (подстроки названия,
     выделяющие сопоставимый сегмент; `"a b"` = обе подстроки в названии).
   - `seller` `{id, name}` — если разбор продавца; `targets` — список nmId
     (MPStats не отдаёт ассортимент продавца надёжно — nmId берём у пользователя).
   - `sections` — какие страницы рендерить и в каком порядке
     (`cover`, `target_cards`, `competitors`, `warehouses`, `potential`, `niche`, `roadmap`).
   - `period`, `detailed`, `n_competitors` — по умолчанию 30 дней / 3 / 12.
   Сохрани конфиг в `wb_analytics/configs/<кейс>.json`.

2. **Запусти** (нужны `MPSTATS_TOKEN` и Chromium):
   ```bash
   MPSTATS_TOKEN=*** python3 wb_analytics/run.py wb_analytics/configs/<кейс>.json \
     --data reports-output/<кейс>.json --pdf reports-output/<кейс>.pdf
   ```
   Повторная вёрстка без сети — `--from-data reports-output/<кейс>.json`.

3. **Проверь результат:** число страниц PDF = длине `sections` (плюс лишние карточки из
   `target_cards`); отсутствие обрезки контента — скриншотом 794×1123 через Chromium
   `--screenshot`. Отдай PDF пользователю.

## Границы и грабли

- MPStats: `/wb/get/seller/{id}` → 405, `/wb/get/warehouses` → 500, SEO-выдача может быть
  закрыта на токене; footprint складов — из `item/{sku}` `sizeandstores.s`.
- Названия складов — из `reference/wb_warehouses.json` (WB-Тула = Алексин 206348;
  130744 = Краснодар). Не хардкодить.
- Потенциал/распределение — оценочные (коэффициенты в конфиге `capture`/`content_factor`,
  веса регионов в `reference/wb_region_demand.json`).
- Выходы в `reports-output/` — в `.gitignore` (эфемерны); скрипты и конфиги — коммить.

Подробности API, схемы конфига и ограничений — в `wb_analytics/README.md`.
