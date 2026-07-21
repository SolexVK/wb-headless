# Перенос скилла в другую ветку / инструмент

Скилл = playbook (`SKILL.md`), движок = код в `lib/` + `season-plan.js`. Чтобы
получить те же результаты в другой ветке/проекте, перенести и то, и другое.

## Что скопировать (движок)
- `season-plan.js` — CLI-раннер.
- `lib/mpstats.js` — клиент MPStats (категории, графики, дневные ряды).
- `lib/salesPlan.js` — ядро (профиль, ранг, фазы, коэффициенты, OOS, недельный).
- `lib/forecast.js` — прогноз на будущий период + 60-дн дрейф + благоприятность.
- `lib/seasonPlanReport.js` — сбор из MPStats, фильтр, оркестрация, бленд, CSV.
- `lib/reportExport.js`, `lib/xlsxWriter.js` — .xlsx (без зависимостей) и HTML.
- (опц. для «своих») `lib/wbClient.js`, `lib/wbToken.js`, `docs/wb-api/`,
  `scripts/wb-token-check.mjs`.
- (опц.) `report-stock.js` — используется для `loadGroups()` (свои линейки).
- `config/groups.json` — свои линейки (метка → список WB-артикулов), если нужен
  режим `own`.

## Требования
- Node ≥ 18 (используются глобальный `fetch`, ESM). `package.json` c `"type":
  "module"`. Внешних зависимостей у движка плана НЕТ (xlsx пишется своим кодом).
- Переменная `MPSTATS_TOKEN` (и `Wildberries_API` для WB-стороны).
- Тесты: `npm test` (node:test) — `test/*.test.mjs` при переносе тоже полезны.

## Скилл
- Скопировать каталог `.claude/skills/seasonality-sales-plan/` целиком
  (`SKILL.md` + `references/`).
- Триггеры активации — в `description` фронтматтера `SKILL.md`.

## Быстрая проверка после переноса
```bash
node --check season-plan.js && for f in lib/*.js; do node --check "$f"; done
npm test                 # ожидаем зелёные тесты
MPSTATS_TOKEN=xxx node season-plan.js --path "<предмет>" --words "<слово>" \
  --price-min 1000 --price-max 5000 --from 2026-08-01 --to 2027-03-31 --oos --weekly
```
