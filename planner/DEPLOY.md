# Развёртывание planner на Mac mini

Инструмент — обычное Node.js-приложение. Ниже — путь от нуля до постоянно
работающего сервера с доступом через браузер.

Сценарии:
- **A. Локальная сеть** — доступ с устройств в той же Wi-Fi/сети (проще всего).
- **B. Из интернета** — доступ откуда угодно через защищённый туннель.

Начните с общей части (1–4), затем выберите A или B.

---

## 1. Установить Node.js

Открой «Терминал» на Mac mini.

```bash
# установить Homebrew (если ещё нет)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# установить Node.js
brew install node
node --version   # должно показать v18+ (лучше v20+)
```

## 2. Скачать проект

```bash
cd ~
git clone https://github.com/SolexVK/wb-headless.git
cd wb-headless
git checkout claude/production-plan-twv8ki   # ветка с инструментом
npm install
```

## 3. Первый запуск (проверка)

```bash
npm run planner
```

В терминале появится строка `[planner] локально: http://localhost:8090`.
Открой в браузере на самом Mac mini `http://localhost:8090` — должен
открыться инструмент. Останови сервер: `Ctrl+C`.

## 4. Задать пароль (обязательно для сценария B, желательно всегда)

Пароль включается переменной окружения `PLANNER_PASSWORD`. Проверка:

```bash
PLANNER_PASSWORD=придумай-пароль npm run planner
```

Теперь браузер спросит логин/пароль. Логин по умолчанию — `admin`
(меняется переменной `PLANNER_USER`).

> Без `PLANNER_PASSWORD` сервер открыт всем — это допустимо только в
> доверенной локальной сети (сценарий A).

---

## A. Доступ по локальной сети

### A.1. Узнать IP-адрес Mac mini

```bash
ipconfig getifaddr en0   # проводная сеть/основной Wi-Fi
# или
ipconfig getifaddr en1
```

Получишь что-то вроде `192.168.1.50`. С любого устройства в той же сети
открой `http://192.168.1.50:8090`.

### A.2. Разрешить входящие подключения

При первом запуске macOS может спросить «Разрешить node принимать входящие
подключения?» — ответь «Разрешить». Если брандмауэр включён и блокирует:
Системные настройки → Сеть → Брандмауэр → Параметры → добавить `node`.

Чтобы IP не менялся — закрепи его в роутере (DHCP reservation) по MAC-адресу
Mac mini.

---

## B. Доступ из интернета (рекомендуется Tailscale)

Пробрасывать порт наружу вручную небезопасно. Проще и безопаснее — туннель.

### Вариант B1 — Tailscale (проще всего, приватная сеть)

Даёт приватный доступ: устройства в твоём Tailscale-аккаунте видят Mac mini
по постоянному адресу, снаружи он невидим.

```bash
brew install tailscale
sudo tailscaled install-system-daemon
tailscale up
```

Авторизуйся в браузере. `tailscale ip -4` покажет адрес вида `100.x.y.z`.
С любого своего устройства (где тоже установлен Tailscale) открывай
`http://100.x.y.z:8090`.

Хочешь публичный HTTPS-адрес без установки Tailscale на клиентах —
включи Funnel:

```bash
tailscale funnel 8090
```

Он выдаст https-ссылку вида `https://mac-mini.ваш-tailnet.ts.net`.
**Обязательно задай `PLANNER_PASSWORD`** — по этой ссылке инструмент
доступен из интернета.

### Вариант B2 — Cloudflare Tunnel (публичный домен)

Если нужен собственный домен и публичный HTTPS:

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel --url http://localhost:8090
```

Быстрый режим выдаст временный `https://<случайно>.trycloudflare.com`.
Для постоянного адреса привяжи туннель к своему домену в панели Cloudflare
(named tunnel). Пароль (`PLANNER_PASSWORD`) обязателен.

---

## 5. Автозапуск (чтобы сервер жил после перезагрузки)

Настроим `launchd`-агент — сервер поднимется сам при старте Mac mini и
перезапустится, если упадёт.

```bash
cd ~/wb-headless

# 1) подставить путь к репозиторию и пароль в шаблон
REPO="$HOME/wb-headless"
PASS="придумай-пароль"
sed -e "s#__REPO__#$REPO#g" -e "s#__PASSWORD__#$PASS#g" \
  planner/deploy/com.wbheadless.planner.plist \
  > ~/Library/LaunchAgents/com.wbheadless.planner.plist

# 2) загрузить агент
launchctl load ~/Library/LaunchAgents/com.wbheadless.planner.plist

# 3) проверить, что работает
curl -s -o /dev/null -w "%{http_code}\n" -u admin:$PASS http://localhost:8090/api/health
# 200 — всё ок
```

Управление:

```bash
# остановить
launchctl unload ~/Library/LaunchAgents/com.wbheadless.planner.plist
# запустить снова
launchctl load ~/Library/LaunchAgents/com.wbheadless.planner.plist
# логи
tail -f ~/wb-headless/planner/data/planner.out.log
tail -f ~/wb-headless/planner/data/planner.err.log
```

> Порт по умолчанию 8090 задан в plist (`PLANNER_PORT`). Меняешь порт —
> поправь plist и перезагрузи агент.

## 6. Обновление до новой версии

```bash
cd ~/wb-headless
git pull origin claude/production-plan-twv8ki
npm install
launchctl unload ~/Library/LaunchAgents/com.wbheadless.planner.plist
launchctl load   ~/Library/LaunchAgents/com.wbheadless.planner.plist
```

Данные (`planner/data/state.json`) при обновлении сохраняются — они не в git.

---

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PLANNER_PORT` | `8090` | порт |
| `PLANNER_HOST` | `0.0.0.0` | интерфейс прослушивания (все сети) |
| `PLANNER_USER` | `admin` | логин для входа |
| `PLANNER_PASSWORD` | — (пусто) | пароль; если пусто — доступ без авторизации |

## Рекомендация по безопасности

- Для доступа из интернета (сценарий B) **всегда** задавай `PLANNER_PASSWORD`
  и используй туннель с HTTPS (Tailscale Funnel / Cloudflare) — так пароль и
  данные шифруются в пути.
- Для локальной сети пароль желателен, но не критичен.
- Регулярно делай бэкап `planner/data/state.json` (это все твои данные).
