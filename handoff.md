# Handoff — FBS / Fulfillment

## Цель
Построить в ветке `claude/fbs-fullfilment-branch-cfvgir` инструментарий для работы с продажами
Wildberries по схеме **FBS (Fulfillment by Seller)**: поднять документацию WB API (с акцентом на
лимиты, чтобы не ловить 429/бан), находить наши склады-фулфилменты, собирать остатки и ретроспективу
обработки заказов по каждому складу, и выдавать это **дашбордом (HTML)** и **PDF-отчётами**. В финале —
упаковать всё в скилл, чтобы получать отчёт одной командой.

## Текущее состояние
Работают отдельные инструменты и сквозной конвейер на живом WB API (токен в окружении, лимиты держит
`lib/wbClient.js`).
- **8 складов FBS** найдены (`GET /api/v3/warehouses`), снимок в `config/warehouses.json`.
- **Остатки** (`fbs:stock`) → `reports-output/fbs-stock.json`. Есть два потребителя:
  - единый дашборд `fbs:report` (остатки + ретро) и первый дашборд `fbs:dashboard` (только остатки);
  - **NEW: `fbs:stock:pdf`** — отдельный PDF «остатки, доступные к заказу, по фулфилментам»
    (сводка + детализация позиций). Последний прогон: 11.08.2026 — 2407 шт на 4 активных складах.
- **Ретроспектива заказов** (`fbs:retro`) по фулфилменту: количество/обработано/статусы/время/крит.
  Периоды: `--days N`, `--day YYYY-MM-DD` (по умолч. МСК), `--from/--to`.
- **Единый PDF** (`fbs:pdf`) — остатки + ретроспектива, A4 альбомная.
- Вёрстка PDF проверяется скриншотами print-HTML (столбцы не налезают).
- **Скилл ещё НЕ создан** — ждём согласования (см. открытые вопросы).
- `reports-output/` в `.gitignore` — в git только генераторы, не сами отчёты/снимки.

## Файлы, над которыми работали
- `lib/wbClient.js` — клиент WB API (token-bucket, `X-Ratelimit-*`, ретраи).
- `lib/wbToken.js` — резолвер токена (env `WB_API_TOKEN`/`Wildberries_API` или `.env`).
- `docs/wb-api/README.md`, `limits.md`, `analytics.md`, `reports-statistics.md`, `orders-fbs.md` — снимки/навигация доков WB.
- `docs/wb-api/fbs.md` — рукописный справочник: склады, FBS-методы+лимиты, §3b — методика ретроспективы.
- `docs/wb-api/pages.json` — страницы для еженедельного авто-рефреша (вкл. orders-fbs).
- `scripts/fetch-wb-docs.mjs`, `refresh-wb-docs.mjs`, `wb-token-check.mjs` — фетчер доков (антибот) и проверка токена.
- `scripts/wb-warehouses.mjs` — `GET /api/v3/warehouses` → `config/warehouses.json`.
- `scripts/fbs-stock.mjs` — остатки FBS (content cards → штрихкоды → `POST /api/v3/stocks/{id}`).
- `scripts/fbs-orders-retro.mjs` — ретроспектива заказов (+статусы, +корзины времени, +период day/range).
- `scripts/fbs-report.mjs` — единый HTML-дашборд (остатки+заказы) и `.artifact.html`.
- `scripts/fbs-pdf.mjs` — единый PDF (остатки+ретро), A4 альбомная.
- `scripts/fbs-stock-pdf.mjs` — **NEW**: PDF только по остаткам, доступным к заказу, по фулфилментам.
- `scripts/fbs-dashboard.mjs` — первый дашборд только по остаткам (заменён `fbs-report`, оставлен).
- `package.json` — скрипты `wb:warehouses`, `fbs:stock`, `fbs:dashboard`, `fbs:retro`, `fbs:report`, `fbs:pdf`, **`fbs:stock:pdf`**; devDep `playwright`.
- `config/warehouses.json` — снимок наших складов FBS (закоммичен).
- `handoff.md` — этот файл.

## Что изменилось
- (Прошлые сессии) Инфраструктура доков WB + клиент с лимитами; атрибуция заказов по нашему складу
  через `warehouseId` из `/api/v3/orders`; время обработки — join с `/api/v3/supplies` по `supplyId`
  (`closedAt − createdAt`); разбор `supplierStatus` и корзины времени; единый дашборд и единый PDF;
  произвольный период (`--day`/`--from..--to`, `periodLabel` в отчётах).
- (Эта сессия) Добавлен **отдельный PDF по остаткам** `scripts/fbs-stock-pdf.mjs` (`fbs:stock:pdf`) —
  по запросу «остатки, доступные к заказу, по каждому фулфилменту, в PDF». `amount` из
  `/api/v3/stocks/{warehouseId}` = доступно к заказу. Сводка по складам + детализация позиций
  (артикул/nmID/штрихкод/доступно). Снимок остатков обновляется на «сейчас».

## Что пробовали и НЕ сработало
- **Статистика `GET /api/v1/supplier/orders` для атрибуции по нашему складу — НЕ подходит.** Для FBS
  относит заказ к приёмке/СЦ WB (`warehouseName` вроде «СЦ Чебоксары»); `warehouseType`=«Склад продавца»,
  но наш склад там не виден; `date`→`lastChangeDate` — плохой прокси времени (медиана ~0.1 ч). Обход:
  `warehouseId` из маркетплейсного `/api/v3/orders`, время — из `/api/v3/supplies.closedAt`.
- **`POST /api/v3/orders/status/history` — только трансграничные поставки**; для тайминга обычного FBS не годится.
- **Остатки FBS `POST /api/v3/stocks/{warehouseId}` принимают ШТРИХКОДЫ, не `nmID`.** Строим карту
  `штрихкод→nmID` из Content API (`content/v2/get/cards/list`, пагинация cursor updatedAt+nmID), затем чанки по 1000.
- **Историю остатков WB API не отдаёт** — `fbs:stock`/`fbs:stock:pdf` всегда «на текущий момент»; для
  отчёта «за сегодня» это ок, для «за прошлую дату» остатки будут всё равно текущие.
- **Фетч `dev.wildberries.ru` обычным curl/fetch не работает** (антибот+SPA). Решение в
  `scripts/fetch-wb-docs.mjs`: реальный Chromium + стелс; при `HTTPS_PROXY` — TLS 1.2
  (`--ssl-version-max=tls1.2`) из-за ECH. Каждый фетч ~40–90 с; slug'и не брутфорсить (`work-with-warehouses`=404).
- **Playwright не был установлен**, Chromium в `/opt/pw-browsers`. `npm i playwright`; запуск с
  `executablePath` из `PLAYWRIGHT_BROWSERS_PATH`. **Скрипты из scratchpad не видят `playwright`** — временный
  helper клали в корень репо (`_shot.mjs`) и удаляли.
- **`pdftoppm` в окружении нет** — вёрстку PDF проверяем скриншотами print-HTML через Playwright.
- Чтобы столбцы в PDF не налезали: `table-layout:fixed` + явные `<colgroup>`-ширины; для длинных таблиц
  (детализация Казани ~74 стр.) НЕ ставить `page-break-inside:avoid` на всю таблицу — только на `tr`
  (thead повторяется на каждой странице).

## Команды для проверки
```bash
# синтаксис всех наших скриптов/модулей
for f in scripts/fbs-*.mjs scripts/wb-*.mjs lib/wb*.js; do node --check "$f" && echo "ok $f"; done

npm run token:check           # ожид.: найден ДА, источник env:Wildberries_API

# конвейер (нужен живой WB API; снимки в reports-output/)
npm run fbs:stock             # → reports-output/fbs-stock.json
npm run fbs:stock:pdf         # → reports-output/fbs-stock-report.pdf  (остатки к заказу, по фулфилментам)
npm run fbs:retro -- --day 2026-08-09 --crit 48   # → reports-output/fbs-orders-retro.json
npm run fbs:report            # → reports-output/fbs-report.html (+ .artifact.html)
npm run fbs:pdf               # → reports-output/fbs-report.pdf (остатки + ретро)
```
Формальных тестов нет. «Зелёное»: `node --check` по всем скриптам проходит; `token:check` = найден;
конвейер отрабатывает без ошибок и пишет непустые снимки. **Ожидаемое состояние сейчас:** всё зелёное
на живом API. Последние прогоны: остатки 11.08.2026 — 2407 шт на 4 складах; ретро за 09.08.2026 — 284
заказа, 94% обработано, 0 крит. Если конвейер падает 401/пусто — проблема с токеном
(`WB_API_TOKEN`/`Wildberries_API`), а не с кодом («сломалось за ночь»).

## Открытые вопросы (нужно решение пользователя)
- **Упаковка в скилл — ЖДУ ОТВЕТА.** Задавал уточнения (создавать ли `/fbs-report`; что выдавать —
  PDF/дашборд/оба; период по умолчанию; таймзона), пользователь на форму вопросов не ответил.
  Рекомендация по умолчанию: скилл `/fbs-report [день|период]` → PDF + дашборд; период по умолчанию —
  вчерашний день; таймзона МСК; порог крит. 48 ч. Также возможен отдельный лёгкий `/fbs-stock` →
  только `fbs:stock:pdf`.
- **Часовой пояс «дня»** — сейчас МСК (UTC+3), переопределяется `--tz`. Рекомендация: оставить МСК.
- **История остатков** — сейчас только «на сейчас». Если нужна динамика остатков по дням — завести
  ежедневный снап `fbs-stock.json` (cron/Actions) с датой в имени. Пока не делаем.

## Следующий шаг
Дождаться от пользователя решения по скиллу. По «да» — создать `.claude/skills/fbs-report/` (и/или
`.claude/skills/fbs-stock/`) через `skill-creator`: обёртка запускает нужные `fbs:*` шаги с параметром
периода и отдаёт PDF (+ссылку на артефакт). До подтверждения ничего не ломать — все инструменты рабочие.
