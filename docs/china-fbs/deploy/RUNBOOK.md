# RUNBOOK — юнит-калькулятор WB Китай: состояние развёртывания и перенос

Дата фиксации: 2026-08-14. Здесь собрано всё, что настроено, чтобы в будущем спокойно
перенести сервис на отдельный сервер (VPS) или переустановить с нуля.

> **Пароли в этом файле не хранятся.** Логин известен, пароль лежит в plist службы
> (см. раздел «Учётные данные»). В git пароль не попадает.

---

## 1. Ключевые координаты

| Что | Значение |
|---|---|
| Репозиторий | `https://github.com/SolexVK/wb-headless` |
| Ветка | `claude/china-fbs-branch-fuhjhb` |
| Приложение (в репо) | `docs/china-fbs/calculator/` |
| Онлайн-демо (артефакт) | `https://claude.ai/code/artifact/17c33362-dd1f-43c7-b1e8-f0fa3dae2cba` |
| Публичный адрес (прод) | `https://mac-mini-vital.tail13d29e.ts.net:10000` |

---

## 2. Текущее развёртывание (Mac Mini)

| Параметр | Значение |
|---|---|
| Машина | Mac Mini, Apple Silicon (arm64), macOS 26.3 |
| Пользователь | `openclaw` |
| Имя хоста | `Mac-mini-Vital.local` |
| Клон под калькулятор | `/Users/openclaw/wb-china-calc` (ветка `claude/china-fbs-branch-fuhjhb`) |
| Папка приложения | `/Users/openclaw/wb-china-calc/docs/china-fbs/calculator` |
| Node | v24.19.0 (nvm) — путь `/Users/openclaw/.nvm/versions/node/v24.19.0/bin/node`; есть и `node@22` (homebrew) |
| Локальный порт сервера | `8787` (слушает только `127.0.0.1`) |
| Веб-сервер | `serve.cjs` (Node, без зависимостей, HTTP Basic Auth) |
| Логи | `serve.log` и `serve.err.log` в папке приложения |

### Служба автозапуска (LaunchDaemon — стартует при загрузке, без логина)
| Параметр | Значение |
|---|---|
| Label | `com.wbcalc.calculator` |
| plist | `/Library/LaunchDaemons/com.wbcalc.calculator.plist` (root:wheel, права `600`) |
| Запускается как | `UserName = openclaw` |
| Env в plist | `CALC_USER`, `CALC_PASS`, `PORT=8787` |
| Автозапуск | `RunAtLoad=true`, `KeepAlive=true` |
| Питание | `sudo pmset -a autorestart 1` (Mac включается после сбоя питания) |

> Ранее была версия LaunchAgent (`~/Library/LaunchAgents/com.wbcalc.calculator.plist`) — она
> удалена при переносе в LaunchDaemon. Если увидите обе — актуальна только системная (LaunchDaemon).

### Публикация наружу (Tailscale Funnel)
| Параметр | Значение |
|---|---|
| Tailscale | v1.96.5, аккаунт `solexvk@`, бинарник `/Users/openclaw/.local/bin/tailscale` |
| Tailnet | `tail13d29e.ts.net`, узел `mac-mini-vital`, tailnet-IP `100.108.217.93` |
| Наш Funnel | публичный порт **10000** → `127.0.0.1:8787` (создан `tailscale funnel --bg --https=10000 8787`) |

**Funnel уже занят другими сервисами — НЕ ТРОГАТЬ:**
| Публичный порт | → локально | Сервис |
|---|---|---|
| 443 | `127.0.0.1:8477` | node `planner/server.js` |
| 8443 | `127.0.0.1:7837` | node `getcourse/.../server.mjs` |
| **10000** | `127.0.0.1:8787` | **наш калькулятор** |

Funnel даёт всего 3 публичных порта (443/8443/10000) — все заняты. Выключать наш, не трогая
остальные: `tailscale funnel --https=10000 off`. **Никогда** не запускать `tailscale serve reset`
(снесёт все три).

---

## 3. Учётные данные

- Логин: **`SolexVK`**.
- Пароль: хранится в `EnvironmentVariables:CALC_PASS` внутри
  `/Library/LaunchDaemons/com.wbcalc.calculator.plist` (права `600`, только root). В git не попадает.
- Прочитать текущий логин/пароль (для проверки):
  ```bash
  sudo /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CALC_USER" /Library/LaunchDaemons/com.wbcalc.calculator.plist
  sudo /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CALC_PASS" /Library/LaunchDaemons/com.wbcalc.calculator.plist
  ```
- Сменить пароль: отредактировать значение в plist (или переустановить службу через
  `deploy/install-launchd.sh` с новым `CALC_PASS`, затем повторить перенос в LaunchDaemon) и
  перезапустить: `sudo launchctl kickstart -k system/com.wbcalc.calculator`.

---

## 4. Архитектура приложения

Чистый статичный фронтенд (HTML/CSS/JS) + крошечный Node-сервер с авторизацией. Без сборки и
зависимостей.

| Файл | Роль |
|---|---|
| `index.html` / `styles.css` / `app.js` | само приложение (форма из конфига, расчёт `computeUnit`, рендер) |
| `standalone.html` | автосборка «всё в одном файле» (для пересылки/офлайна) |
| `serve.cjs` | Node-сервер: раздаёт папку, HTTP Basic Auth, слушает `127.0.0.1` |
| `tariffs.json` | базовые тарифы логистики + комиссии по категориям + дата (в git) |
| `tariffs.override.json` | runtime-переопределение тарифов (в `.gitignore`), пишет апдейтер |
| `../tools/update-wb-tariffs.py` | скачивает офиц. PDF WB, пишет `tariffs.override.json` |
| `../deploy/*` | скрипты и инструкции развёртывания |

**Тарифы читаются с приоритетом:** `tariffs.override.json` → `tariffs.json` → встроенный слепок
`EMBEDDED` в `app.js` (fallback для офлайна). Обновление тарифов не трогает код и git.

**Расчёт — в юанях (¥)**, цены/прибыль дублируются в рублях. Онлайн-курсы ЦБ (¥ и $) тянутся с
`cbr-xml-daily.ru` (на реальном сервере работает; в песочнице артефакта заблокировано CSP —
тогда ручной ввод).

---

## 5. Управление (шпаргалка, Mac)

```bash
# статус службы
sudo launchctl list | grep wbcalc

# перезапустить сервер
sudo launchctl kickstart -k system/com.wbcalc.calculator

# остановить / снять службу
sudo launchctl bootout system/com.wbcalc.calculator

# логи
tail -f ~/wb-china-calc/docs/china-fbs/calculator/serve.log

# обновить калькулятор из git (перезапуск НЕ нужен — файлы читаются с диска; хватит Cmd+Shift+R в браузере)
cd ~/wb-china-calc && git pull origin claude/china-fbs-branch-fuhjhb

# обновить тарифы WB (пишет tariffs.override.json, код/ git не трогает)
cd ~/wb-china-calc/docs/china-fbs/tools && python3 update-wb-tariffs.py

# funnel: статус / выключить только калькулятор
tailscale funnel status
tailscale funnel --https=10000 off        # НЕ использовать `tailscale serve reset`
```

---

## 6. Что важно сохранить при переносе/бэкапе

1. **Репозиторий** (всё приложение и скрипты) — уже в GitHub, ветка `claude/china-fbs-branch-fuhjhb`.
2. **Логин/пароль** (из plist) — записать в надёжное место (менеджер паролей).
3. **`tariffs.override.json`** — если запускали апдейтер и хотите сохранить актуальные ставки
   (иначе просто перегенерируется скриптом на новом сервере).
4. Знание, что публичный порт Funnel у нас — **10000** (443/8443 заняты planner/getcourse).

Больше состояния нет: база данных не используется, всё вычисляется в браузере.

---

## 7. Чеклист переноса на VPS

Приложение портируется копированием папки. На VPS меняется только «вывод наружу».

### Общие шаги (любой вариант)
```bash
# на VPS (Linux):
sudo apt update && sudo apt install -y git nodejs   # либо nvm/nodesource для свежего Node
git clone https://github.com/SolexVK/wb-headless.git /opt/wb-china-calc
cd /opt/wb-china-calc && git checkout claude/china-fbs-branch-fuhjhb
```

Служба через **systemd** (`/etc/systemd/system/wbcalc.service`):
```ini
[Unit]
Description=WB China unit calculator
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wb-china-calc/docs/china-fbs/calculator
EnvironmentFile=/etc/wbcalc.env
ExecStart=/usr/bin/node serve.cjs
Restart=always
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```
Секреты — в `/etc/wbcalc.env` (права `600`):
```
PORT=8787
CALC_USER=SolexVK
CALC_PASS=ВАШ_ПАРОЛЬ
```
Запуск:
```bash
sudo chmod 600 /etc/wbcalc.env
sudo systemctl daemon-reload
sudo systemctl enable --now wbcalc
sudo systemctl status wbcalc
```

### Вариант А — оставить Tailscale (проще всего)
Поставить Tailscale на VPS, залогиниться тем же аккаунтом и:
```bash
tailscale funnel --bg 443 8787     # на VPS порт 443 свободен → можно без :10000
```
Публичный адрес: `https://<имя-vps>.<tailnet>.ts.net`. Basic Auth уже в `serve.cjs`.

### Вариант Б — свой домен + Caddy (классика для VPS)
Нужен домен, указывающий A-записью на IP VPS. `Caddyfile`:
```
calc.ВАШ-ДОМЕН.ru {
    reverse_proxy 127.0.0.1:8787
}
```
```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile      # вставить блок выше
sudo systemctl reload caddy
```
Caddy сам выпустит и обновит TLS (Let's Encrypt). Авторизация остаётся в `serve.cjs`
(Basic Auth поверх HTTPS). При желании можно перенести авторизацию в Caddy (`basic_auth`).

### После переноса
- Проверить: `curl -u SolexVK:ПАРОЛЬ https://адрес/` → калькулятор.
- Обновление кода: `git pull` в `/opt/wb-china-calc` + `systemctl restart wbcalc` (или просто reload страницы).
- Обновление тарифов: `python3 docs/china-fbs/tools/update-wb-tariffs.py` (нужен `pip install pdfplumber`).
- На Mac Mini после переезда — снять наш Funnel и службу, если сервис там больше не нужен:
  `tailscale funnel --https=10000 off` и `sudo launchctl bootout system/com.wbcalc.calculator`.

---

## 8. Безопасность (памятка)
- Сервер слушает только `127.0.0.1`; наружу — через Funnel/Caddy поверх HTTPS.
- Basic Auth: длинный пароль, без спецсимволов `! $ \` пробел кавычки` (проблемы shell-кавычек).
- Пароль — только в plist/env-файле с правами `600`, в git не коммитить.
- `tariffs.override.json` и `*.log` — в `.gitignore`.

---

## 9. Известные нюансы
- **Node у демона — путь nvm v24.19.0.** Если сменить/удалить эту версию nvm — служба сломается.
  Для стабильности на Mac можно переставить службу на homebrew-node (`/opt/homebrew/bin/node`).
  На VPS в systemd используется системный `/usr/bin/node` — там этой проблемы нет.
- **Funnel-порт 10000** выбран потому, что 443 и 8443 заняты. На чистом VPS берите 443.
- Приложение полностью клиентское: масштабирование/нагрузка не проблема, БД нет.
