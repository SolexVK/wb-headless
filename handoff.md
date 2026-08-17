# Handoff — FBS-сервис (Wildberries фулфилмент-аналитика)

## Цель
Мультитенантный веб-сервис аналитики FBS по Wildberries: организации/участники,
подключение WB-кабинета (токен шифруется AES-256-GCM), отчёты по фулфилмент-складам.
Хостится на Mac Mini, наружу отдаётся через **Tailscale serve + Caddy**:
**https://mac-mini-vital.tail13d29e.ts.net/fbs/**. Код в `service/`, ветка разработки
`claude/fbs-fullfilment-branch-cfvgir`. Скрипты-пайплайны — в `scripts/`.

## Текущее состояние
Работает и протестировано (все smoke-тесты зелёные). **Пять** отчётов:
- **Подсорт** — рекомендации к дозаказу по складам/размерам + пробный завоз.
- **Остатки** — текущий остаток FBS по складам и артикул+цвет; ежесуточный автоснимок,
  выбор даты из архива, выгрузки.
- **Движение заказов** — принято/передано по дням и складам; ₽ по трём базам.
- **География** — продажи/возвраты по регионам+округам РФ; вкладка «По ФФ отгрузки»
  (FBS-возвраты привязаны к исходному складу отгрузки: srid = rid).
- **Логистика** (НОВОЕ, эта сессия) — вкладки **Сборка** (createdAt → supply.closedAt
  по ФФ: среднее/медиана/p90/макс/критичные) и **Доставка** (closedAt → дата выкупа из
  статистики, привязка к ФФ отгрузки по srid=rid: по ФФ, региону, дням, распределение).

Общее для всех отчётов: KPI-карточки + «Выводы» + панели с иконками, графики с тултипами,
сортируемые таблицы, выгрузки **Excel / JSON / HTML-дашборд / PDF**, общий архив (90 дней),
единый светлый/тёмный дизайн, лёгкий градиентный фон.

**Деплой на Mac Mini уже обновлён и работает.** FBS-сервис здоров: launchd
`com.wbheadless.fbs`, node v24 `--experimental-sqlite`, слушает 127.0.0.1:9110, PID менялся
при рестарте (последний — 62882). Логи: `/Users/openclaw/wb-fbs/service/data/{stdout,stderr}.log`
(stderr пустой = без ошибок). Отчёт «Логистика» задеплоен и виден в интерфейсе.

## Топология Mac Mini (ВАЖНО — тут была вся боль сессии)
- Рабочий каталог FBS — **git worktree** `/Users/openclaw/wb-fbs` (ветка
  `claude/fbs-fullfilment-branch-cfvgir`), общий `.git` с `/Users/openclaw/wb-headless`
  (там ДРУГОЙ проект — ветка `claude/production-plan-twv8ki`, planner). НЕ ПУТАТЬ.
- БД: `/Users/openclaw/wb-fbs/service/data/app.sqlite` (в .gitignore, git её не трогает).
  `.env`: `/Users/openclaw/wb-fbs/service/.env` (ключи HOST/PORT/SESSION_SECRET/
  TOKEN_ENC_KEY/DB_PATH/BASE_PATH/NODE_ENV — есть, новых не требуется).
- Публикация наружу: **443 держит `tailscaled` (io.tailscaled)**, не Caddy напрямую.
  `tailscale serve` (tailnet-only) маршрутизирует пути; Caddy (`127.0.0.1:9000`,
  `auto_https off`) фанит: `/calc→8899`, `/fbs→9110` (+X-Forwarded-Proto https),
  default→8477 (planner). OpenClaw-шлюз — на `127.0.0.1:18789`, публикует себя на `/`.
- Текущий `tailscale serve status`:
  - `:443 /` → 18789 (OpenClaw UI, приватно), `/fbs` → 9000/fbs, `/calc` → 9000/calc
  - `:8443` → 8090 (UNIT-калькулятор), `:10000` → 8787 (китай-калькулятор)
- Локальные бэкенды: 8090 unit_api (`*:8090`), 8787 china-calc (node loopback),
  8899 workspace-калькулятор (loopback), 8477 planner (`*:8477`), 18789 OpenClaw.

## Файлы, над которыми работали (эта сессия — отчёт «Логистика»)
- `scripts/fbs-logistics.mjs` — НОВЫЙ пайплайн: orders + supplies + sales; сборка
  (createdAt→closedAt по warehouseId) и доставка (closedAt→sale.date, srid=rid), медианы/p90,
  отсечка аномалий (t>0 и <60 сут).
- `service/reports-runner.js` — добавлено: logisticsDefaults/normalizeLogistics/fakeLogistics/
  runLogisticsPipeline/logisticsSummary/startLogistics/buildLogisticsXlsx/buildLogisticsDashboardHtml.
- `service/reports.js` — RU_REPORT + логистика в sendDownload (xlsx/html/pdf) + роуты
  page/refresh/download.
- `service/views.js` — logisticsView/logisticsResults/logisticsAssembly/logisticsDelivery/
  logisticsPage; хелпер `fmtHrs`; карточка в reportsPage; reportRu/archive summ/archiveViewPage.
- `scripts/fbs-logistics-dashboard.mjs` — HTML/PDF-дашборд (Сборка + Доставка).
- `scripts/fbs-logistics-xlsx.py` — 5 листов (сборка/долгие/доставка по ФФ/регионам/дням).
- `service/smoke-reports.mjs` — блок тестов логистики (страница/refresh/json/xlsx/html/pdf/вкладка/архив).

## Что изменилось (по сути)
- Новый отчёт «Логистика» по общему паттерну (pipeline→runner→routes→views→dashboard→xlsx→tests).
- Ключевая механика доставки повторяет географию: у FBS `srid` продажи = `rid` заказа (100%),
  что даёт время «уход с ФФ → выкуп» и привязку к исходному ФФ отгрузки.
- Коммит `d85608d` запушен, задеплоен на Mac Mini (worktree `wb-fbs`), сервис перезапущен.
- На Mac Mini `openclaw config set gateway.tailscale.resetOnExit false` (записано, но требует
  рестарта гейтвея, чтобы вступило в силу — см. «Следующий шаг»).

## Что пробовали и НЕ сработало (важнейший раздел — грабли доступа)
Отчёт-код прошёл сразу; вся боль была в **доступе к сайту**, НЕ в FBS. Хронология тупиков:

1. **`ERR_CONNECTION_CLOSED` в браузере после рестарта FBS.** Сначала думали «краш сервиса».
   Диагностика: node жив (`healthz 200`, PID стабилен), stderr пуст, curl локально проходит.
   Вывод: НЕ сервис.

2. **«Протухшие keep-alive/сокеты браузера»** — flush socket pools + clear DNS + Ctrl+F5.
   НЕ помогло. Инкогнито тоже падал → значит не кэш сокетов.

3. **Смена локального IP Mac** (роутер выдал `192.168.1.23`, было другое) — реально было
   (`netcheck: gateway and self IP changed`), но `tailscale ping` в обе стороны шёл ПРЯМОЙ и
   быстрый (8–14 мс), т.е. WireGuard-транспорт исправен. Перезапуск Tailscale на Windows —
   НЕ помог сам по себе.

4. **ГЛАВНАЯ ЛОВУШКА: curl отдавал `200`, и я решил, что FBS доступен снаружи.** На самом деле
   `/` и `/fbs/healthz` возвращали ОДИНАКОВЫЕ 10316 байт — это была HTML-оболочка **OpenClaw**,
   а не FBS (у FBS healthz = 71 байт `{"status":"ok","base":"/fbs"}`). Урок: сверять РАЗМЕР/ТЕЛО
   ответа, не только код.

5. **Корень проблемы доступа:** перезапуск OpenClaw-шлюза (`gateway-supervisor-restart-handoff`
   ~23:01) с настройкой `gateway.tailscale.resetOnExit: true` **делает `tailscale serve reset`**
   и ставит только свой `/ → 18789`, **стирая все прочие маршруты** (`/fbs`, `/calc`, порты
   `:8443`, `:10000`). Поэтому `/fbs` начал отдавать OpenClaw, а не наш сервис. FBS/Caddy при этом
   были 100% исправны (`curl 127.0.0.1:9110/fbs/healthz` = 71 байт ok).
   Починка: `tailscale serve --bg --set-path=/fbs http://127.0.0.1:9000/fbs` (и `/calc`, порты).
   Durable-фикс: `openclaw config set gateway.tailscale.resetOnExit false`.

6. **ПОСЛЕДНИЙ барьер — Chrome, а не сеть.** Даже после восстановления маршрутов Chrome на
   Windows давал `ERR_CONNECTION_CLOSED`, НО `curl.exe` с ТОГО ЖЕ Windows отдавал реальный FBS
   (71 байт ok) и целую страницу калькулятора (`:8443`). Значит виноват Chrome (QUIC/HTTP3 +
   кэш «сломанного origin»). Отключение QUIC (`chrome://flags/#enable-quic`) + flush НЕ
   применялось, т.к. **Chrome на Windows держит фоновые процессы** и флаг не вступал в силу.
   Обход: **Edge открывает сразу**; для Chrome — снять ВСЕ `chrome.exe` в Диспетчере задач,
   потом QUIC off + `chrome://net-internals/#hsts` delete domain. (На момент /handoff —
   пользователь ещё не подтвердил, что Chrome/Edge открыл; сервер доказанно исправен.)

7. **Мелочь:** пользователь один раз вставил PowerShell-команду (`curl.exe`, `` `n ``) в Mac zsh —
   zsh завис на `dquote bquote>`. Выход — Ctrl+C. Для Mac-терминала: `curl` и `\n`, не `curl.exe`.

## Команды для проверки
Локально (в этом контейнере / на Mac в `wb-fbs`):
- Тесты: `cd service && npm test` (smoke-test + smoke-basepath + smoke-reports, PODSORT_FAKE=1,
  офлайн, tmp-БД, случайный порт; PDF-проверка мягкая — пропускается без Chromium).
- Синтаксис: `node --check scripts/fbs-logistics.mjs` (+ dashboard/views/reports/runner).
- Дашборд/Excel вручную: положить фейковый `fbs-logistics-service.json` в
  `REPORTS_OUTPUT_DIR`, затем `REPORTS_OUTPUT_DIR=<dir> node scripts/fbs-logistics-dashboard.mjs`
  и `REPORTS_OUTPUT_DIR=<dir> python3 scripts/fbs-logistics-xlsx.py`.

Проверка доступа на Mac Mini (read-only, различает «сервер» vs «браузер/сеть»):
- `curl -s http://127.0.0.1:9110/fbs/healthz` → должно быть **71 байт** `{"status":"ok","base":"/fbs"}`
  (если ~10316 байт — это OpenClaw перехватил, маршрут слетел).
- `tailscale serve status` → должны быть `/fbs`, `/calc`, `:8443`, `:10000`.
- С Windows: `curl.exe -k -o NUL -w "%{http_code} %{size_download}\n" https://…/fbs/healthz`
  → `200 71`. Если curl=71, а Chrome падает → чинить Chrome (Edge/QUIC), не сервер.

**Ожидаемое состояние на момент /handoff:** `npm test` — ВСЕ зелёные (три набора, включая блок
логистики + PDF при наличии Chrome). FBS-node на Mac — здоров (`healthz 200`, stderr пуст),
«Логистика» задеплоена. Доступ к `/fbs` восстановлен на уровне сети (подтверждено curl с
Windows = 200/71); открытие в Chrome — под вопросом (браузерный QUIC/кэш), Edge работает.

## Открытые вопросы (нужно решение пользователя)
1. **Публично или только tailnet? (ЖДУ ОТВЕТА)** Сейчас всё через `serve` = только устройства
   в Tailscale (Windows пользователя — в нём, работает). Пользователь написал «все сервисы
   должны безопасно работать публично». Уточнить: (A) хватает tailnet — тогда ничего не менять;
   (B) нужен доступ из интернета внешним клиентам — включить `tailscale funnel` на 443/8443/10000.
   **Рекомендация:** OpenClaw (`/`) в интернет НЕ выставлять (пульт управления агентами) —
   оставить приватным; калькуляторы, вероятно, без авторизации → публичны «по ссылке».
2. **`/admin`** — что это за сервис/порт? Отдельного `/admin` в текущей конфигурации нет
   (админка FBS — внутри `/fbs`). ЖДУ описания.
3. **Производственный план (8477)** — дать красивый HTTPS-адрес; предложен путь **`/plan`**
   (→ Caddy → 8477). У planner на `:8477` при прямом доступе — ошибка «Bot domain invalid»
   (проверяет Host/домен) — потребует правки после публикации. ЖДУ подтверждения `/plan`.

## Следующий шаг
**Управляемо активировать durable-фикс OpenClaw**, чтобы апдейт v2026.7.1 не стёр маршруты:
1. Точный рестарт гейтвея OpenClaw (НЕ FBS): `openclaw daemon restart` (или его launchd-label
   `ai.openclaw.gateway` через `launchctl kickstart -k gui/502/<label>`), чтобы применился
   `resetOnExit:false`.
2. Сразу после — один раз повторить маршруты (идемпотентно):
   ```
   tailscale serve --bg --set-path=/fbs  http://127.0.0.1:9000/fbs
   tailscale serve --bg --set-path=/calc http://127.0.0.1:9000/calc
   tailscale serve --bg --https=10000 http://127.0.0.1:8787
   tailscale serve --bg --https=8443  http://127.0.0.1:8090
   ```
3. Подтвердить, что в браузере открывается (Edge — сразу; Chrome — после полного сброса).
4. По ответу на «A/B (публично?)» — при B перевести WB-сервисы на `funnel`, оставив OpenClaw
   приватным; добавить `/plan`→8477 и решить `/admin`.
