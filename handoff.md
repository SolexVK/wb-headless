# Handoff — GetCourse Downloader

## Цель
Сделать систему для скачивания видеоуроков из курсов на GetCourse: находить
подписанные HLS-плейлисты, качать сегменты и склеивать их в **бесшовный MP4** без
«иканья». Поверх — веб-сервис (Node/Express) с личными кабинетами, подпиской,
режимами хранения и удобным выбором курса/уроков, развёрнутый на **Mac Mini** и
доступный снаружи через **Tailscale Funnel**. Конечная цель — платный сервис
(подписка, позже оплата через ЮKassa).

Весь проект живёт в подкаталоге `getcourse/` этого репозитория. Ветка разработки:
`claude/getcourse-branch-4g4g40`.

## Текущее состояние
Работает и развёрнуто на Mac Mini (пользователь подтвердил). Последние правки
(кэш структуры, полные имена файлов, плашки статусов, очистка истории) запушены;
пользователю осталось `git pull` + `kickstart`, чтобы их подхватить.

Что готово и проверено end-to-end:
- Скачивание одного/нескольких/всех уроков; ремукс в MP4 через ffmpeg `-c copy`
  (гэплесс, 0 ошибок при декодировании).
- Логин на GetCourse из headless-Chromium (нужен обход анти-бота, см. ниже).
- Веб-UI: вход, **регистрация**, сброс пароля, (опц.) вход через Google,
  подписка (ключи активны; ЮKassa реализована, но **выключена/заглушена**).
- Два режима хранения: **admin/owner (localAccess)** сохраняет на диск Mac и
  видит папки; **подписчик (delivery)** качает во временный спул, забирает файлы
  в браузер, есть дневные квоты и авто-очистка (janitor).
- Мастер выбора: доступ → список курсов → дерево уроков с чекбоксами → скачать
  выбранное/всё. Пароль GetCourse запоминается (AES-GCM).
- Кэш структуры в localStorage; полные имена файлов (блок + урок, запрещённые
  символы → `_`); плашки «Скачано успешно»/«Ошибка»; кнопка очистки истории.

Не сделано/выключено намеренно: реальная оплата ЮKassa (заглушка), Google-вход
(нет OAuth-кред), SMTP для писем сброса пароля (сейчас админ отдаёт ссылку
вручную из админ-панели).

## Файлы, над которыми работали
CLI-движок:
- `getcourse/src/index.mjs` — CLI-обёртка над движком.
- `getcourse/src/run.mjs` — движок: логин→обход/или plan→скачать; событийные
  колбэки; кидает понятную ошибку при 0 уроков; принимает `plan` (выбор уроков).
- `getcourse/src/map.mjs` — предпросмотр структуры (CLI).
- `getcourse/src/lib/browser.mjs` — запуск Chromium (прокси/пути из env; обход
  анти-бота TLS1.2+HTTP/1.1) и логин на GetCourse.
- `getcourse/src/lib/crawl.mjs` — обход курса; поддержка URL блока/урока/страницы;
  фан-аут по соседним блокам только со страницы блока.
- `getcourse/src/lib/extract.mjs` — перехват master-плейлиста урока (в т.ч.
  несколько видео).
- `getcourse/src/lib/hls.mjs` — парсинг master/media, скачивание сегментов
  (curl, параллельно), ремукс в MP4 через ffmpeg; прогресс по сегментам.
- `getcourse/src/lib/util.mjs` — sanitize/pad/pool/run.

Веб-сервер:
- `getcourse/web/server.mjs` — Express-роуты (auth, register, reset, google,
  billing, admin, fs, jobs, gc/courses, gc/tree, report, DELETE /api/jobs).
- `getcourse/web/lib/loadenv.mjs` — грузит `.env` ДО построения конфига (важно!).
- `getcourse/web/lib/config.mjs` — все настройки из env.
- `getcourse/web/lib/db.mjs` — JSON-хранилище (users/sessions/jobs/resets/reports).
- `getcourse/web/lib/auth.mjs` — scrypt-пароли, сессии-cookie, регистрация,
  авто-лицензия, сброс пароля, Google-upsert, гейты подписки/админа.
- `getcourse/web/lib/crypto.mjs` — AES-256-GCM для сохранённого пароля GetCourse.
- `getcourse/web/lib/gccreds.mjs` — сохранение/чтение кред GetCourse у юзера.
- `getcourse/web/lib/gcbrowse.mjs` — listCourses/courseTree (сериализовано).
- `getcourse/web/lib/google.mjs` — OAuth2 (включается кредами).
- `getcourse/web/lib/jobs.mjs` — очередь задач, SSE-прогресс, режимы local/
  delivery, квоты, plan, файлы+downloadName, failures, clearHistory.
- `getcourse/web/lib/quota.mjs` — дневные лимиты объёма/файлов.
- `getcourse/web/lib/janitor.mjs` — очистка спула по времени/квоте.
- `getcourse/web/lib/reports.mjs` — логи-обращения пользователей (файлы + индекс).
- `getcourse/web/lib/billing_yookassa.mjs` — ЮKassa (реализовано, выключено).
- `getcourse/web/public/{index.html,app.js,styles.css}` — фронтенд (SPA).

Инфраструктура/доки:
- `getcourse/scripts/inspect-macmini.sh` — аудит портов/процессов/Tailscale.
- `getcourse/scripts/deploy-macmini.sh` — nvm+Node, npm i (IPv4/mirror), Chromium.
- `getcourse/scripts/tailscale-serve.sh` — Funnel на :8443 (не трогает :443).
- `getcourse/scripts/com.getcourse.downloader.plist.example` — LaunchAgent.
- `getcourse/.env.example`, `getcourse/README.md`, `getcourse/.gitignore`.

## Что изменилось
- Реализован механизм скачивания GetCourse (сегменты `.bin`=TS → ffmpeg remux).
- Построен полноценный веб-сервис с аккаунтами, подпиской, квотами, доставкой
  файлов подписчикам, мастером выбора курса/уроков, кэшем, отчётами об ошибках.
- Развёрнуто на Mac Mini: изолированный Node (nvm), автозапуск (LaunchAgent),
  публичный адрес `https://mac-mini-vital.tail13d29e.ts.net:8443` (Funnel на
  порту 8443, чтобы не конфликтовать с существующим Funnel `:443→8477`).

## Что пробовали и НЕ сработало (важно — читать перед правками)
1. **Chromium через прокси песочницы = ERR_CONNECTION_RESET.** GetCourse-CDN
   сбрасывает «слишком новый» TLS-фингерпринт headless-хрома. Обход:
   `--ssl-version-max=tls1.2 --disable-http2` (в `browser.mjs`, флаг
   `GC_NO_TLS_WORKAROUND` чтобы отключить). curl/openssl работали и без этого —
   проблема только у Chromium. На Mac (без прокси) флаги безвредны.
2. **Порт прокси песочницы меняется между вызовами.** Нельзя хардкодить —
   только `process.env.HTTPS_PROXY`. На Mac прокси нет вовсе.
3. **Побайтовая склейка TS-сегментов → «икание».** ffmpeg показывал `Packet
   corrupt` на КАЖДОЙ границе сегмента (рвутся PES). Решение — не `cat`, а
   ffmpeg с локальным m3u8: `-c copy -bsf:a aac_adtstoasc`. Итог гэплесс
   (проверено: 0 ошибок при `-f null`, кадры ровно 24fps). Bundled ffmpeg
   Playwright — урезанный (webm), не подходит; ставили системный ffmpeg.
   johnvansickle static ffmpeg в песочнице падал segfault — не использовать.
4. **`.env` грузился ПОСЛЕ импорта config.mjs** → лимиты/ключи из .env
   игнорировались (в логе было «200 ГБ» вместо 50). Исправлено `loadenv.mjs`,
   импортируется ПЕРВЫМ в config.mjs и server.mjs. Правило: любой модуль,
   читающий env на этапе импорта, должен идти ПОСЛЕ loadenv.
5. **npm install на Mac падал ETIMEDOUT** — реестр по IPv6 «висит». Обход:
   `--dns-result-order=ipv4first`, `--maxsockets 3`, повышенные таймауты,
   fallback на `registry.npmmirror.com`, Chromium ставим отдельным шагом
   (postinstall убран, есть `npm run browser`).
6. **Tailscale Funnel на :443 уже занят** другим проектом (`→127.0.0.1:8477`).
   НЕЛЬЗЯ вешать наш сервис на :443 — затрёт planner. Решение: Funnel на
   **:8443** того же узла (аддитивно). `tailscale-serve.sh` по умолчанию так и
   делает; MODE=node (отдельный узел `getcourse.<tailnet>`) оставлен опцией.
7. **Пустой результат «Готово, 0»** — пользователь вставлял ссылку на общий
   список `/teach/control/stream` (там нет уроков). Теперь crawl поддерживает
   разные формы URL и кидает понятную ошибку; в форме есть подсказка.
8. **plan-задача давала «Invalid URL»** — `job.startUrl` был подписью «Выбранные
   уроки: N». Разделили `realStartUrl` (реальный URL/undefined) и `startUrl`
   (подпись). Движок берёт origin из первого урока плана.
9. **`db.resets = ...` не работало** — `db.resets` это геттер. Мутировать массив
   на месте (splice/push), не переприсваивать.
10. **zsh у пользователя не считает `#` инлайн-комментарием** — в командах для
    Терминала НЕ давать хвостовые `# коммент` (ломает разбор `)`), команды
    давать чистыми, по одной на строку.
11. **Тестовый сервер иногда не поднимался за `sleep 2`** — давать `sleep 3` и
    проверять `kill -0 $PID` перед curl (это артефакт тестов, не баг кода).

## Команды для проверки
Все — из каталога `getcourse/`.
```
cd getcourse
# синтаксис всех модулей
for f in web/server.mjs web/lib/*.mjs src/*.mjs src/lib/*.mjs web/public/app.js; do node --check "$f" || echo "FAIL $f"; done
```
Локальный прогон веб-сервера (в песочнице нужен CHROMIUM_PATH; на Mac — нет):
```
GCUI_ADMIN_USER=admin GCUI_ADMIN_PASS=secret123 GCUI_COOKIE_INSECURE=1 \
GCUI_PORT=7847 GCUI_DATA=/tmp/gcd GCUI_SPOOL_ROOT=/tmp/gcs GCUI_BROWSE_ROOT=/tmp \
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
node web/server.mjs
# затем curl -sS 127.0.0.1:7847/api/me  ->  {"user":null,...}
```
CLI-скачивание (нужны GC_* в env/.env):
```
node src/index.mjs "https://<school>.getcourse.ru/teach/control/stream/view/id/<N>"
```
На Mac Mini (боевое): обновить и перезапустить сервис —
```
cd ~/getcourse-app/getcourse
git pull
launchctl kickstart -k gui/$(id -u)/com.getcourse.downloader
sleep 2 && tail -6 /tmp/getcourse-downloader.out
```
Тестового фреймворка нет — «зелёное» = `node --check` без FAIL И сервер отвечает
на `/api/me`. Ожидаемое состояние СЕЙЧАС: `node --check` по всем файлам —
зелёно; веб-сервер стартует и отвечает 200 на `/api/me`; реальные скачивания
проверялись вручную на курсе `influencezakupka` (15 уроков, 3 блока) и проходят.
Красных автотестов нет (их просто нет как класса).

## Открытые вопросы (нужно решение пользователя)
1. **ЮKassa** — включать как основной способ оплаты? Нужны `GCUI_YOOKASSA_SHOP_ID`
   и `GCUI_YOOKASSA_SECRET` + `GCUI_YOOKASSA_ENABLED=1`; после включения стоит
   выключить авто-лицензию (`GCUI_SIGNUP_LICENSE_DAYS=0`). ЖДУ ОТВЕТА.
2. **Google-вход** — заводить OAuth-клиент? Нужны `GCUI_GOOGLE_CLIENT_ID/SECRET`
   и redirect URI `<publicUrl>/api/auth/google/callback`. ЖДУ ОТВЕТА.
3. **Открытая регистрация + авто-лицензия сейчас включены**, сервис публичный
   (Funnel). Пока по просьбе пользователя это ок; при запуске оплаты — сузить
   (`GCUI_ALLOW_SIGNUP=0` или `GCUI_SIGNUP_LICENSE_DAYS=0`). Рекомендация: сузить
   до подключения оплаты. ЖДУ ОТВЕТА.
4. **Сброс пароля без SMTP** — сейчас админ отдаёт ссылку вручную. Настраивать
   SMTP (`GCUI_SMTP_*`) для авто-писем? Рекомендация: да, когда будут клиенты.
5. **Дефолтные лимиты** сейчас 50 ГБ/сут и 50 ГБ квоты (диск Mac ~246 ГБ свободно).
   При росте числа клиентов пересмотреть. Инфо, не блокер.

## Следующий шаг
Дождаться отчёта пользователя, что после `git pull`+`kickstart` четыре последних
улучшения работают на боевом Mac Mini (кэш структуры, полные имена файлов,
плашки статусов, очистка истории). Если да — предложить включить ЮKassa и/или
Google-вход (вопросы 1–2) и, при запуске оплаты, сузить открытую регистрацию.
