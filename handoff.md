# Handoff — planner / Публичный доступ + Telegram-авторизация

Ветка: `claude/production-plan-twv8ki`. Последний коммит: `2f10b76`.
Деплой: Mac mini пользователя, служба под launchd `com.wbheadless.planner`,
порт из `planner/data/.env` (у пользователя 8477). Адрес в тайлнете сейчас
`http://100.108.217.93:8477`; цель — публичный `https://…ts.net` через Tailscale Funnel.

## Цель
Веб-инструмент планирования производства рубашек (`planner/`) — открыть в интернет
через **Tailscale Funnel** с **жёсткой привязкой к Telegram-аккаунту**: пускать только
явно допущенные аккаунты (allowlist), один пользователь = один Telegram-аккаунт,
фундамент под платные подписки, без бесконтрольной выдачи доступа.

## Текущее состояние
Код авторизации написан, синтаксис-чек и офлайн-тесты зелёные, **закоммичен и запушен**.
На Mac mini ещё НЕ активирован (ждёт действий пользователя: создать бота, Funnel, .env).
- Пока `TELEGRAM_BOT_TOKEN` не задан — работает старая защита `PLANNER_PASSWORD`
  (легаси HTTP Basic), сервис не остаётся без защиты во время перехода.
- Как только токен задан и БД доступна — Telegram-вход берёт верх, Basic отключается.
- Предыдущий крупный блок «Ранг сезонности» — ЗАКРЫТ и подтверждён пользователем ранее.
  Юнит-экономика, WB API (габариты/тарифы/логистика), SQLite-БД — тоже готовы (#21–24).

Модель доступа (реализовано):
- Вход только через Telegram Login Widget → подпись проверяется HMAC-SHA256
  (секрет = `SHA256(bot_token)`).
- Пускаем только `users.status='active'` и не просроченных (`expiresAt`).
- **Одна активная сессия на аккаунт** (`users.activeSession` = `sid` из cookie): новый
  вход вытесняет старую сессию — «поделиться» доступом нельзя.
- Права/статус/срок проверяются по БД на КАЖДОМ запросе ⇒ мгновенный отзыв.
- Владелец (`OWNER_TELEGRAM_ID`) сеется админом при старте, доступ бессрочный.
- Незнакомец при попытке входа регистрируется как заявка (`status='blocked'`) и видит
  свой Telegram-ID для передачи админу.

## Файлы, над которыми работали
- `planner/lib/auth.js` (NEW) — `verifyTelegramAuth` (HMAC подписи виджета),
  `signSession`/`verifySession` (компактный подписанный токен), `newSessionId`.
- `planner/lib/authMiddleware.js` (NEW) — `installAuth(app)`: guard всех защищённых
  путей, роуты `/auth/telegram`, `/auth/logout`, `/api/me`, `/api/admin/*`; cookie
  helpers (без внешних зависимостей); секрет сессий из env→БД(meta)→генерация.
- `planner/lib/db.js` (M) — таблица `users` + CRUD (`userGet/List/Upsert/SetStatus/
  SetExpiry/Delete/MarkLogin`). Уже была добавлена в прошлой сессии.
- `planner/public/login.html` (NEW) — страница входа с виджетом Telegram (тянет
  botUsername из `/api/me`, редиректит вошедших на `/`).
- `planner/public/admin.html` (NEW) — админ-панель `/admin`: выдать доступ по ID,
  срок подписки, блок/разблок/удаление.
- `planner/public/index.html` (M) — чип пользователя в топбаре (имя, ссылка `/admin`
  для админа, выход) через `/api/me`.
- `planner/server.js` (M) — `app.set('trust proxy', true)` для Funnel; `express.json`
  поднят выше; `installAuth(app)`; легаси Basic только если `!auth.enabled && PLANNER_PASSWORD`;
  красивые пути `/login` и `/admin`.
- `planner/deploy/AUTH-SETUP.md` (NEW) — пошаговая инструкция (бот, Funnel, .env, выдача).

## Что изменилось (по сути)
1. Замена «пароль на весь сайт» на полноценную авторизацию по Telegram с allowlist,
   ролями (admin), сроком подписки и single-session — с сохранением легаси-Basic как
   фолбэка на время перехода.
2. Guard монтируется ВНУТРИ `installAuth` (app.use) ДО `express.static` и API-роутов —
   поэтому статика (index.html, app.js) и API защищены; публичны только `/login`,
   `/login.html`, `/api/health`, `/auth/telegram`, `/api/me`, `/styles*`, `/favicon.ico`.
3. Секрет подписи сессий: если `SESSION_SECRET` не задан — генерится и хранится в
   `meta.session_secret` (БД). Удаление ключа/смена секрета инвалидирует все сессии.

## Что пробовали и НЕ сработало (важно!)
- **Порядок middleware — главная тонкость.** Guard должен идти ПОСЛЕ `express.json`
  (иначе POST-тела `/auth/logout` и `/api/admin/*` пустые) и ДО `express.static`
  (иначе неаутентифицированный отдаёт index.html/app.js). Решение: в server.js
  сначала `express.json`, потом `installAuth(app)` (внутри регистрирует /auth/*, /api/me,
  затем guard, затем admin-роуты), потом `/login`+`/admin` sendFile, потом static.
  Роуты `/auth/telegram`, `/auth/logout`, `/api/me` регистрируются ДО guard и делают
  собственную проверку — их guard не трогает.
- **`/login` без .html** — `express.static` не отдаёт путь без расширения. Пришлось
  добавить явные `app.get('/login')` и `app.get('/admin')` через `res.sendFile`.
  `/login` в guard помечен публичным; `/admin` — нет (требует сессию), req.user уже есть.
- **Secure-cookie за Funnel.** Cookie ставится `Secure` только если запрос по HTTPS.
  Определяем через `req.secure` ИЛИ `X-Forwarded-Proto: https` — поэтому обязателен
  `app.set('trust proxy', true)`, т.к. Funnel терминирует TLS и проксирует по http.
  Без trust proxy на локальном http Secure-cookie не ставился бы — но там он и не нужен.
- **ESM-тест из scratchpad не резолвил `./lib/auth.js`** (относительный импорт от
  каталога теста, не от planner/). Обошёл абсолютным путём импорта в тесте.
- **node:sqlite требует `--experimental-sqlite`** — все запуски (start.sh, package.json,
  e2e-тест) идут с этим флагом. Без БД авторизация НЕ включается (allowlist негде хранить):
  `installAuth` вернёт `{enabled:false}` и упадёт на легаси-Basic.
- **Тест-прогоны создают `planner/data/planner.db`** в дев-контейнере (gitignored). После
  каждого прогона удалял `data/planner.db*`, чтобы не мусорить. В коммит не попадает.
- **Grale прошлых сессий (всё ещё в силе):** «обновления не видно на Mac mini» — три
  причины: (1) браузер кэшировал app.js/css → анти-кэш в server.js + Cmd+Shift+R;
  (2) служба Node НЕ перезапущена (держит lib/*.js в памяти) → ОБЯЗАТЕЛЬНО
  `launchctl kickstart -k gui/$(id -u)/com.wbheadless.planner` после git pull;
  (3) сохранённые планы хранят старый forecastDaily → кнопка пересборки.
- `cd planner` у пользователя часто падает — он УЖЕ внутри `planner/` (промпт `…planner %`).
  Давать команды без `cd planner`.

## Команды для проверки
```bash
cd planner
# синтаксис
node --check server.js && node --check lib/auth.js && \
  node --experimental-sqlite --check lib/authMiddleware.js && \
  node --experimental-sqlite --check lib/db.js
# офлайн-тест подписи Telegram + сессий (12/12):
#   тест лежал в scratchpad (эфемерный). Логика: собрать checkString из полей,
#   secret=SHA256(botToken), hash=HMAC(secret,checkString) → verifyTelegramAuth==true.
# сквозной e2e (поднимает сервер на :8531 с тестовым ботом, 16/16):
#   имитирует Telegram-callback с валидным HMAC, проверяет 401/редирект/allowlist/
#   admin-grant/заявку/не-админа/отзыв-по-блокировке/single-session.
# поднять сервер локально:
node --experimental-sqlite server.js    # http://localhost:8090 (или PLANNER_PORT)
```
На Mac mini для активации: заполнить `planner/data/.env` (TELEGRAM_BOT_TOKEN,
TELEGRAM_BOT_USERNAME, OWNER_TELEGRAM_ID) → `launchctl kickstart -k
gui/$(id -u)/com.wbheadless.planner`. В `out.log` ждать
`[planner] Telegram-авторизация ВКЛЮЧЕНА (бот @…, владелец …).`

**Ожидаемое состояние (сейчас всё зелёное):** все `node --check` проходят; офлайн-тест
подписи 12/12; e2e-сценарий авторизации 16/16. Формальных автотестов в РЕПО нет
(тесты были в эфемерном scratchpad) — при возобновлении пересоздать при необходимости.
«Красных» нет. На Mac mini авторизация ещё не активирована (ждёт .env + Funnel).

## Открытые вопросы (нужно решение пользователя)
1. **Действия пользователя для активации (ЖДУ):** создать бота у @BotFather (получить
   токен, `/setdomain` = Funnel-домен), узнать свой Telegram-ID (@userinfobot), вписать
   3 переменные в `planner/data/.env`, включить Tailscale Funnel (HTTPS-сертификаты в
   админке + `tailscale funnel --bg 8477`). Всё описано в `planner/deploy/AUTH-SETUP.md`.
   Токен НЕ присылать в чат — проверю по логам запуска без вывода значений.
2. **Срок сессии 30 дней, single-session включён жёстко** — реализовано как решил по
   умолчанию (пользователь просил один аккаунт = один пользователь). Если нужно
   несколько устройств на аккаунт — сказать, ослаблю проверку activeSession.
3. **Отложено пользователем:** связка «Pб-коридор ↔ ранг сезонности» (передавать ценовой
   сегмент под целевой маржой в фильтр аналогов сезонности). Пользователь хотел вернуться
   ПОСЛЕ Tailscale/auth. НЕ начинать без явного старта.
4. **Остаток по #21 (БД):** отчёты/экспорт из БД — по желанию, не начато.

## Следующий шаг
Дождаться, пока пользователь создаст Telegram-бота и включит Funnel, затем помочь
проверить активацию по логам (`out.log`: «Telegram-авторизация ВКЛЮЧЕНА») и первый вход
владельца + выдачу доступа на `/admin`. После подтверждения рабочей авторизации —
вернуться к отложенной связке «Pб-коридор ↔ сезонность» (только по старту пользователя).

## Безопасность
`MPSTATS_TOKEN`, WB-токен (`Wildberries_API`/`WB_API_TOKEN`), `TELEGRAM_BOT_TOKEN`,
`SESSION_SECRET` — НИКОГДА не писать в репозиторий/handoff/коммиты, значения не печатать
в чат. Живут только в окружении службы и в gitignored `planner/data/.env` на Mac mini.
Весь `planner/data/` в .gitignore (.env, plans, wb-cache, planner.db, state.json).
Идентификатор модели в пушимые артефакты не писать (только чат).
