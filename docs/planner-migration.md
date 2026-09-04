# Переезд planner («производственный план») с Mac Mini на VPS

Первый сервис, который переезжает по схеме из [`docs/netcup-server.md`](netcup-server.md).
Адрес после переезда: **https://planner.aidemiko.ru/** (отдельный поддомен, а не путь —
во фронтенде planner зашиты абсолютные пути `/api/…` и `/admin`, под префиксом он не заработает).

| Что | Где было (Mac Mini) | Где стало (VPS) |
|---|---|---|
| Код | `~/wb-headless`, ветка `claude/production-plan-twv8ki` | `/opt/planner`, та же ветка |
| Запуск | launchd `com.wbheadless.planner` | systemd `planner.service` |
| Порт | `0.0.0.0:8090` (виден в сети) | `127.0.0.1:9100` (наружу только через Caddy) |
| Данные | `planner/data/` (`planner.db`, `state.json`, `samples/`) | `/opt/planner/planner/data/` |
| Секреты | переменные в `.plist` | `/opt/planner/planner/data/.env` (0600, владелец `planner`) |
| Снаружи | Tailscale Funnel | Caddy + Let's Encrypt |

Порядок важен: сначала поднимаем копию на сервере, переносим базу, проверяем — и только
потом гасим planner на Mac Mini. Откат на любом шаге: launchd-агент на Mac Mini ещё жив.

---

## Шаг 1. DNS: завести имя planner.aidemiko.ru

В RU-CENTER → DNS-master → зона `aidemiko.ru` → добавить две записи:

| Тип | Имя | Значение |
|---|---|---|
| `A` | `planner` | `159.195.41.88` |
| `AAAA` | `planner` | `2a0a:4cc0:c1:8fbd:d44a:5eff:fe71:f3cf` |

Опубликовать зону (кнопка публикации — без неё правки не уезжают на серверы имён).

**Проверка** (в браузере, домен должен резолвиться в наш IP):
`https://dns.google/resolve?name=planner.aidemiko.ru&type=A` → в ответе `"data":"159.195.41.88"`.
Обычно 5–15 минут. Не идём дальше шага 4, пока не отвечает; шаги 2–3 можно делать параллельно.

## Шаг 2. Поднять planner на сервере

На сервере (`ssh deploy@159.195.41.88`):

```bash
sudo git config --global --add safe.directory /opt/wb-headless   # один раз на сервер
sudo git -C /opt/wb-headless pull
sudo chown -R wbheadless:wbheadless /opt/wb-headless
sudo bash /opt/wb-headless/deploy/vps/40-deploy-planner.sh
```

> Почему не просто `git pull`: каталог принадлежит системному пользователю `wbheadless`,
> а мы под `deploy`. Git на такое ругается («dubious ownership») и ничего не скачивает,
> да и писать в чужой каталог мы не можем. Поэтому обновляемся от root и возвращаем
> владельца — иначе `wb-headless.service` потеряет доступ к своим файлам.

Скрипт: заведёт системного пользователя `planner`, склонирует ветку в `/opt/planner`,
поставит `express` (только в `planner/`, без puppeteer), создаст `.env` со случайным паролем,
поставит и запустит `planner.service`.

**Запиши пароль, который он напечатает** — это вход в интерфейс (логин `admin`).

**Проверка:**
```bash
systemctl status planner --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9100/api/health   # 401 = живой и под паролем
curl -s -u admin:ПАРОЛЬ http://127.0.0.1:9100/api/health                    # {"ok":true,...}
```

## Шаг 3. Перенести базу с Mac Mini

Вход на сервер — только по ключу, а у Mac Mini своего ключа не было. Сначала заводим его
(пригодится и для переезда остальных сервисов).

**На Mac Mini:**
```bash
ssh-keygen -t ed25519 -C "macmini" -f ~/.ssh/id_ed25519 -N ""   # если есть — скажет already exists
cat ~/.ssh/id_ed25519.pub                                       # скопировать строку целиком
```
**На сервере** (в открытой ssh-сессии) — дописать ключ в конец файла:
```bash
nano ~/.ssh/authorized_keys      # вставлять ПРАВЫМ КЛИКОМ: Ctrl+V в PowerShell теряет заглавные
```

**На Mac Mini** — остановить сервис, чтобы SQLite дописал всё на диск:

```bash
launchctl unload ~/Library/LaunchAgents/com.wbheadless.planner.plist
cd ~/wb-headless/planner/data && ls -la          # убедиться, что здесь planner.db и state.json
```

Отправить данные на сервер (архивом — сохранятся `samples/` и права):

```bash
cd ~/wb-headless/planner
tar czf /tmp/planner-data.tgz --exclude='*.log' --exclude='.env*' data
scp /tmp/planner-data.tgz deploy@159.195.41.88:/tmp/
```

**На сервере** — распаковать поверх и вернуть владельца:

```bash
sudo systemctl stop planner
sudo tar xzf /tmp/planner-data.tgz -C /opt/planner/planner
sudo chown -R planner:planner /opt/planner/planner/data
sudo rm -f /opt/planner/planner/data/.env.bak /opt/planner/planner/data/.env.save /tmp/planner-data.tgz
sudo systemctl start planner
sudo -u planner ls -la /opt/planner/planner/data
```

Маска `--exclude='.env*'` важна: рядом с `.env` на Mac Mini лежали `.env.bak` и `.env.save`
со старыми секретами. Маска `--exclude='.env'` их не ловит — при первом переезде они уехали
на сервер и их пришлось удалять руками (команда `rm` выше осталась как страховка).

Исключаем `.env*` при упаковке, чтобы серверный `.env` (свой пароль, порт `9100`,
`PLANNER_HOST=127.0.0.1`) не затёрся файлом с Mac Mini. Всё остальное распаковывается
поверх: `state.json`, который сервер создал пустым при первом старте, должен замениться
настоящим — поэтому распаковываем без `--keep-newer-files`.

Если в разделе «Ранг сезонности» нужен MPStats — перенести токен вручную: посмотреть его
на Mac Mini (`grep MPSTATS ~/wb-headless/planner/data/.env`) и вписать на сервере в
`sudo nano /opt/planner/planner/data/.env`, затем `sudo systemctl restart planner`.
Токен — секрет: в git и в переписку не попадает.

**Проверка:** `curl -s -u admin:ПАРОЛЬ http://127.0.0.1:9100/api/health` → `{"ok":true,...}`,
`journalctl -u planner -n 30 --no-pager` — без ошибок SQLite. Полнота данных: размер
`planner.db` совпадает с оригиналом, число файлов в `data/samples` — тоже.

> Листинг `ls -l` на Linux и macOS считает ссылки каталогов по-разному (APFS показывает
> число элементов, ext4 — число подкаталогов), поэтому «`2`» напротив `samples` на сервере
> ничего не значит. Считать надо содержимое: `ls data/samples | wc -l`.

## Шаг 4. Опубликовать наружу

Когда DNS из шага 1 резолвится:

```bash
sudo bash /opt/wb-headless/deploy/vps/add-site.sh planner.aidemiko.ru 9100
journalctl -u caddy -n 30 --no-pager      # ищем «certificate obtained successfully»
```

**Проверка (с любого устройства):** открыть `https://planner.aidemiko.ru/` — браузер спросит
логин/пароль (`admin` + пароль из шага 2), дальше открывается инструмент со всеми данными
с Mac Mini. Замок в адресной строке — сертификат Let's Encrypt.

## Шаг 5. Погасить planner на Mac Mini

Только после того, как шаг 4 зелёный и данные на месте:

```bash
launchctl unload ~/Library/LaunchAgents/com.wbheadless.planner.plist
mv ~/Library/LaunchAgents/com.wbheadless.planner.plist ~/Library/LaunchAgents/com.wbheadless.planner.plist.off
```

Каталог `~/wb-headless/planner/data` на Mac Mini оставляем как резервную копию на момент переезда —
удалять его не нужно.

## Шаг 6. Сменить пароль

Пароль из `.plist` на Mac Mini мы считаем скомпрометированным (он засветился в переписке).
На сервере он и так другой — сгенерированный скриптом. Если хочется свой:

```bash
sudo nano /opt/planner/planner/data/.env      # строка PLANNER_PASSWORD=…
sudo systemctl restart planner
```

Дальше по плану — Telegram-авторизация вместо пароля (`TELEGRAM_BOT_TOKEN`,
`OWNER_TELEGRAM_ID` в том же `.env`, см. `planner/deploy/AUTH-SETUP.md`): пароль тогда
отключится сам, а доступ будет по списку разрешённых аккаунтов.

---

## Если что-то пошло не так

| Симптом | Что делать |
|---|---|
| `502 Bad Gateway` | Сервис лежит: `systemctl status planner`, `journalctl -u planner -n 50` |
| Сертификат не выписался | DNS ещё не резолвится или указывает не на нас: `getent ahostsv4 planner.aidemiko.ru` |
| Пустой интерфейс, данных нет | База не доехала: `ls -la /opt/planner/planner/data/planner.db`, права `planner:planner` |
| `SQLite is an experimental feature` в логе | Норма для Node 22 — предупреждение, не ошибка |
| Нужен откат | На Mac Mini: `launchctl load ~/Library/LaunchAgents/com.wbheadless.planner.plist` |
