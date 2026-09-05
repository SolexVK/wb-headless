# Переезд FBS-аналитики с Mac Mini на VPS

Второй сервис после planner. Мульти-тенантный: продавцы подключают свои кабинеты WB,
сервис считает пять отчётов (Подсорт, Остатки, Движение заказов, География, Логистика)
с выгрузкой в Excel и PDF.

| | Было (Mac Mini) | Стало (VPS) |
|---|---|---|
| Код | `/Users/openclaw/wb-fbs`, ветка `claude/fbs-fullfilment-branch-cfvgir` | `/opt/fbs`, та же ветка |
| Запуск | launchd `com.wbheadless.fbs` | systemd `fbs.service` |
| Порт | `127.0.0.1:9110` | `127.0.0.1:9110` |
| Снаружи | Tailscale + Caddy, `/fbs/` | `https://tools.aidemiko.ru/fbs/` |
| Данные | `service/data/` | то же |

Адрес — путь, а не поддомен: сервис умеет работать под префиксом (`BASE_PATH`, на это
есть отдельный тест), новых записей DNS не требуется.

## Ключ шифрования — главное, что нельзя потерять

WB-токены кабинетов лежат в базе **зашифрованными** ключом `TOKEN_ENC_KEY`. Если
перенести базу, но не перенести ключ, кабинеты не расшифруются и продавцам придётся
подключать их заново. Порядок такой: сначала ключ в `.env` сервера, потом база.

## Шаг 1. Развернуть код

```bash
sudo bash /opt/wb-headless/deploy/vps/60-deploy-fbs.sh 2>&1 | tail -20
```

Скрипт ставит python3 с `openpyxl` (Excel), Playwright с Chromium (PDF), зависимости
сервиса, создаёт `.env` со случайными секретами, юнит `fbs.service` и проверяет
`/healthz`. Chromium весит порядка 150 МБ — первый запуск идёт несколько минут.

## Шаг 2. Перенести ключ и данные

**На Mac Mini** — остановить сервис и посмотреть ключи:

```bash
launchctl unload ~/Library/LaunchAgents/com.wbheadless.fbs.plist
grep -E '^(TOKEN_ENC_KEY|SESSION_SECRET)=' /Users/openclaw/wb-fbs/service/.env
```

**На сервере** — вписать оба значения в `.env` (строки уже есть, заменить значения):

```bash
sudo nano /opt/fbs/service/.env
```

`TOKEN_ENC_KEY` обязателен; `SESSION_SECRET` переносить не нужно — с новым просто
все разлогинятся один раз.

**На Mac Mini** — упаковать и отправить данные (исключаем `.env`, у сервера свой):

```bash
cd /Users/openclaw/wb-fbs/service
tar czf /tmp/fbs-data.tgz --exclude='.env*' --exclude='*.log' data
scp /tmp/fbs-data.tgz deploy@159.195.41.88:/tmp/
```

**На сервере** — распаковать поверх:

```bash
sudo systemctl stop fbs
sudo tar xzf /tmp/fbs-data.tgz -C /opt/fbs/service
sudo chown -R fbs:fbs /opt/fbs/service/data
sudo rm -f /tmp/fbs-data.tgz
sudo systemctl start fbs
sudo -u fbs ls -la /opt/fbs/service/data
```

**Проверка:** `curl -s http://127.0.0.1:9110/healthz` → `{"status":"ok",…}`,
в `data/` лежит `app.sqlite` и каталог `cabinets/`.

## Шаг 3. Опубликовать наружу

```bash
sudo bash /opt/wb-headless/deploy/vps/add-route.sh /fbs 9110 --keep
```

`--keep` обязателен: сервис сам знает про префикс `/fbs` (он в `BASE_PATH`), срезать
его нельзя — иначе ссылки внутри интерфейса поедут.

**Проверка:** `https://tools.aidemiko.ru/fbs/` открывает страницу входа, кабинеты на
месте, отчёт строится, Excel и PDF скачиваются.

## Шаг 4. Погасить на Mac Mini

Только после того, как всё проверено:

```bash
mv ~/Library/LaunchAgents/com.wbheadless.fbs.plist ~/Library/LaunchAgents/com.wbheadless.fbs.plist.off
```

Каталог `/Users/openclaw/wb-fbs/service/data` оставляем как резервную копию на момент переезда.

## Если что-то пошло не так

| Симптом | Причина и что делать |
|---|---|
| Кабинеты не открываются, ошибка расшифровки | В `.env` не тот `TOKEN_ENC_KEY`. Взять с Mac Mini, перезапустить |
| Excel не формируется | `python3 -c 'import openpyxl'` — если ошибка, `sudo apt-get install python3-openpyxl` |
| PDF не формируется | Chromium не встал: `sudo -u fbs npx playwright install chromium` в `/opt/fbs` |
| `502` на `/fbs/` | Служба лежит: `systemctl status fbs`, `journalctl -u fbs -n 50` |
| Ссылки внутри ведут не туда | Маршрут добавлен без `--keep` — префикс срезается, а сервис его ждёт |
