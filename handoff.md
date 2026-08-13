# Handoff — Юнит-калькулятор WB Китай (FBS)

## Цель
Инструмент предварительного расчёта юнит-экономики для трансграничной модели
**Китай → РФ (FBS)** на Wildberries: продавец из КНР, товар едет со склада в Китае, WB везёт
покупателю в РФ. Пользователь пока **без кабинета продавца** (планирует регистрацию) — расчёт по
открытым данным и оферте. Реализовано как **веб-приложение** (vanilla HTML/CSS/JS), задеплоено на
**Mac Mini** пользователя с публичным доступом через **Tailscale Funnel** и авторизацией по аккаунтам.

## Текущее состояние
Калькулятор готов, задеплоен и работает. Считает корректно, JS без ошибок, обе темы читаемы.

- **Ветка:** `claude/china-fbs-branch-fuhjhb` (запушена; последний коммит — система аккаунтов).
- **Расчёт:** логистика по реальному весовому тарифу WB China; комиссии — ориентир China POP (~10%,
  точные только в кабинете за авторизацией).
- **Деплой:** Node-сервер `serve.cjs` слушает `127.0.0.1:8787`, наружу выведен Tailscale Funnel
  на порт **10000**. Автозапуск через launchd (`com.wbcalc.calculator`).
- **Аккаунты:** вход по cookie-сессии (HMAC), регистрация **с одобрением админа**, восстановление по
  **коду** (без email), хранение в `users.json` (gitignored). Формы `/login /register /forgot /admin`.
- **Тарифы вынесены** в `tariffs.json` (+ `tariffs.override.json` из скрипта обновления, gitignored)
  — обновление тарифов не трогает код и не конфликтует с `git pull`.

### ⚠️ Незакрытый инцидент на Mac Mini (ГЛАВНОЕ на сейчас)
После запуска калькулятора **сломался соседний сервис** — маршрут Tailscale Funnel `/calc`
(TandemTrace, `127.0.0.1:8899`). Диагностика показала: служба `com.tandem.funnel` при старте зовёт
**`/usr/local/bin/tailscale`, которого НЕ существует** (реальный бинарник — `~/.local/bin/tailscale`),
плюс funnel-конфиг **глобальный и общий** для всех сервисов — новые команды затирают чужие маршруты.

- **Временно восстановлено** (Шаг 4): `tailscale funnel --bg --https=443 --set-path=/calc 127.0.0.1:8899`
  — сейчас активны 4 маршрута: `443 /`→8477 (planner), `443 /calc`→8899 (tandemtrace),
  `8443`→7837 (getcourse), `10000`→8787 (наш калькулятор). Публичный `/calc` отвечает 302 = ок.
- **НО это слетит после перезагрузки** — постоянный фикс ещё не применён (см. «Следующий шаг»).

## Файлы, над которыми работали
- `docs/china-fbs/calculator/app.js` — модель `computeUnit()`, `FIELDS`, `loadConfig()` (fetch
  tariffs.json + override → EMBEDDED fallback), localStorage persist/restore, онлайн-курс ЦБ (¥ и $).
- `docs/china-fbs/calculator/serve.cjs` — Node-сервер БЕЗ зависимостей: аккаунты (scrypt-хэш,
  timingSafeEqual, HMAC-cookie), seedAdmin из `CALC_USER/CALC_PASS`, коды восстановления,
  роуты login/register/forgot/admin/logout, инъекция authslot в index.html, слушает 127.0.0.1:8787.
- `docs/china-fbs/calculator/index.html` — разметка + `<span id="authslot">` в топбаре.
- `docs/china-fbs/calculator/styles.css` — оформление, тултипы, 2 темы.
- `docs/china-fbs/calculator/tariffs.json` — meta + logistics (standard/plus/hk/express) + 16 категорий кВВ.
- `docs/china-fbs/calculator/standalone.html` — автосборка «всё в одном файле».
- `docs/china-fbs/tools/update-wb-tariffs.py` — качает PDF тарифов WB, пишет `tariffs.override.json`.
- `docs/china-fbs/deploy/README.md` — инструкция деплоя (шаги 0–4, LaunchDaemon, управление, безопасность).
- `docs/china-fbs/deploy/RUNBOOK.md` — полное состояние деплоя для переноса на VPS (tailnet, IP, порты).
- `docs/china-fbs/deploy/install-launchd.sh`, `check-env.sh` — установка службы, аудит окружения.
- `docs/china-fbs/sources/wb_china_logistics_tariff_0726.pdf` — официальный тариф-первоисточник.
- `.gitignore` — `tariffs.override.json`, `users.json`, `.auth-secret`.

## Что изменилось
- **Расчёт:** цепочка цен в ₽ (база→скидка→Рц→СПП→покупателю), прибыль/себестоимость в ¥ и ₽;
  два курса (ВБ = ЦБ+надбавка, и ЦБ); логистика **по ВЕСУ** (`ставка_кг × вес(округл.100г) + фикс`),
  без двойного счёта хранения/возврата (включено в весовой тариф, масштаб через % выкупа);
  фулфилмент учитывается **только** в режиме «доставка силами селлера»; НДС РФ выкл. по умолчанию.
- **Деплой:** сервер 127.0.0.1 + Funnel (публичный HTTPS от Tailscale), автозапуск launchd,
  вариант LaunchDaemon (старт без логина) для headless Mac Mini.
- **Аккаунты:** заменили Basic Auth на полноценную сессионную авторизацию с регистрацией/одобрением/
  восстановлением; данные форм калькулятора переживают перезагрузку (localStorage); кнопка «Выход».
- **Тарифы:** вынесены в JSON, обновляются скриптом в override-файл без правки кода/git.

## Что пробовали и НЕ сработало
- **`serve.js` падал «require is not defined in ES module scope»** — в корневом `package.json`
  стоит `"type":"module"`, поэтому CommonJS-файл переименован в **`serve.cjs`**. Урок: любые
  require-скрипты в этом репо — только `.cjs`.
- **Голый `tailscale funnel <порт>` и `tailscale serve reset` СТИРАЮТ чужие маршруты.** Funnel-конфиг
  один на все сервисы. Именно это уронило `/calc`. ПРАВИЛО: только **аддитивные** команды
  `tailscale funnel --bg --https=<порт> [--set-path=/x] <target>`; **никогда** `serve reset` и
  **никогда** голый `funnel <порт>` (сбрасывает путь `/`). Funnel ограничен **3 портами** (443/8443/10000).
- **`com.tandem.funnel.plist` зовёт `/usr/local/bin/tailscale`** — такого пути НЕТ (Tailscale ставился
  не через brew). Реальный бинарник: `/Users/openclaw/.local/bin/tailscale` (или `$(command -v tailscale)`).
  Из-за этого служба падает при загрузке и не поднимает `/calc`. Фикс пути ещё не закоммичен на Mac.
- **LaunchDaemon-конверсия:** первый тест дал 401 — оказалось, пользователь оставил в команде
  литерал-заглушку `НОВЫЙ_ПАРОЛЬ`. Проверять реально сохранённые креды через `PlistBuddy -c Print`.
- **LibreOffice recalc для xlsx** — таймауты; ушли на пакет `formulas` (описано в старых итерациях).
  xlsx-версия осталась артефактом, НЕ основная. Playwright — python-версия с `executable_path` на
  `/opt/pw-browsers`.
- **Точный каталог комиссий по категориям** — за авторизацией в кабинете; открытые агрегаторы % не
  отдают. Оставлен ориентир + ручная правка в `tariffs.json`.

## Команды для проверки
Синтаксис и модель (в репо-контейнере):
```
cd /home/user/wb-headless/docs/china-fbs/calculator
node --check app.js
node --check serve.cjs
```
Прогон модели на дефолтах (ожидаемо profit ≈ 44,31 ¥, margin ≈ 26,6%):
```
cd /home/user/wb-headless/docs/china-fbs/calculator
printf 'global.document={addEventListener(){},getElementById(){return null;}};\n' > /tmp/t.js
cat app.js >> /tmp/t.js
cat >> /tmp/t.js <<'EOF'
const v={}; for(const f of FIELDS){ v[f.id]= f.type==='check'?f.def : f.type==='category'?CATEGORIES[0].name : f.type==='logistics'?'standard' : (f.type==='pct'?f.def/100:f.def);}
const r=computeUnit(v); console.log('profit',r.profit.toFixed(2),'margin',(r.margin*100).toFixed(1)+'%');
EOF
node /tmp/t.js
```
Локальный тест сервера аккаунтов (на Mac Mini):
```
cd docs/china-fbs/calculator
CALC_USER="логин" CALC_PASS="пароль" node serve.cjs
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8787/   # ждём 302 …/login
```
Проверка Funnel-маршрутов на Mac Mini:
```
tailscale funnel status     # должно быть 4 маршрута: 443 / , 443 /calc , 8443 , 10000
```
**Ожидаемое состояние (сейчас):** `node --check` обоих файлов — ок; прогон модели → `profit 44.31
margin 26.6%`. На Mac Mini funnel показывает **4 маршрута**, публичный `/calc` = 302 (восстановлен
временно). Формальных тестов в проекте нет; «зелёным» считается совпадение чисел модели и наличие
всех 4 funnel-маршрутов. **КРАСНОЕ до фикса:** плист `com.tandem.funnel` с неправильным путём —
после перезагрузки Mac `/calc` снова упадёт.

## Открытые вопросы (нужно решение пользователя)
1. **Постоянный фикс vs единый прокси.** Быстро: пропатчить путь в `com.tandem.funnel.plist`
   (`/usr/local/bin/tailscale` → `$HOME/.local/bin/tailscale`). Правильно: поставить **единый Caddy**
   за одним funnel-входом, маршрутизация по путям (снимает лимит в 3 порта и гонки за общий конфиг).
   Рекомендация: сейчас — быстрый фикс плиста; Caddy — отдельной сессией. **ЖДУ подтверждения**, что
   сломанным считался именно `/calc` (TandemTrace), и согласия на быстрый фикс.
2. **Старый python-калькулятор `com.wb.unit-calc` (порт 8090)** — оставить или снять? Рекомендация:
   снять, если не используется (это ранняя итерация). **ЖДУ решения.**
3. **Каталог комиссий кВВ / формула возврата / надбавка «Курс ВБ»** — точные значения только из
   кабинета WB, которого пока нет. **ЖДУ** данные после регистрации.

## Следующий шаг
**Шаг 5 (уже подготовлен):** сделать восстановление `/calc` постоянным — пропатчить
`~/Library/LaunchAgents/com.tandem.funnel.plist`, заменив `/usr/local/bin/tailscale` на реальный путь
`$(command -v tailscale)` (≈ `/Users/openclaw/.local/bin/tailscale`), сделать бэкап плиста, перезагрузить
службу через `launchctl bootout`/`bootstrap` и проверить `launchctl list | grep tandem`. Выдать
пользователю **одним блоком команд для Терминала** (он работает по шагам). Перед этим — получить
подтверждение по открытому вопросу №1. Затем **Шаг 6:** зафиксировать правило «не запускать
`serve reset` / голый `funnel <порт>`» и предложить единый Caddy.
