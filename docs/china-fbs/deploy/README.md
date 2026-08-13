# Развёртывание калькулятора на Mac Mini (публичный доступ + авторизация)

Схема: маленький Node-сервер отдаёт калькулятор с **HTTP Basic Auth** (логин/пароль) и слушает
**только `127.0.0.1`**. Наружу в интернет его выводит **Tailscale Funnel** — даёт публичный
HTTPS-адрес вида `https://<имя-мака>.<tailnet>.ts.net`. Пароль передаётся через переменные
окружения, в коде его нет.

```
Интернет ──HTTPS──▶ Tailscale Funnel ──▶ 127.0.0.1:8787 (Node + Basic Auth) ──▶ статика калькулятора
```

---

## 0. Предпосылки (проверить один раз)

```bash
node -v            # нужен Node.js 18+. Если нет: brew install node
tailscale status   # Tailscale установлен и вы залогинены
```

**Tailscale CLI на macOS.** Если команда `tailscale` не находится (у версии из App Store),
добавьте алиас:
```bash
alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
```

**Funnel должен быть включён для вашего tailnet** (один раз, в админке Tailscale):
- Admin console → **DNS**: включить **MagicDNS** и **HTTPS Certificates**.
- Admin console → **Access controls**: у устройства должен быть атрибут `funnel`, например:
  ```json
  "nodeAttrs": [ { "target": ["autogroup:member"], "attr": ["funnel"] } ]
  ```
Если что-то не включено — первая команда `tailscale funnel` выведет ссылку с инструкцией.

---

## 1. Получить код на Mac Mini

Если репозиторий ещё не склонирован:
```bash
git clone https://github.com/SolexVK/wb-headless.git
cd wb-headless
git checkout claude/china-fbs-branch-fuhjhb
```
Если уже склонирован — обновить:
```bash
cd wb-headless
git fetch origin
git checkout claude/china-fbs-branch-fuhjhb
git pull origin claude/china-fbs-branch-fuhjhb
```

---

## 2. Быстрый тест (в переднем плане)

```bash
cd docs/china-fbs/calculator
CALC_USER="ваш_логин" CALC_PASS="надёжный_пароль" node serve.cjs
```
Увидите: `Калькулятор запущен: http://127.0.0.1:8787`.
Проверьте локально в другом окне: `curl -u ваш_логин:надёжный_пароль http://127.0.0.1:8787/` —
должен вернуться HTML. Остановить: `Ctrl-C`.

---

## 3. Вывести наружу через Tailscale Funnel

В отдельном окне терминала:
```bash
tailscale funnel --bg 8787
tailscale funnel status
```
`status` покажет публичный адрес: **`https://<имя-мака>.<tailnet>.ts.net`**.
Откройте его в браузере → браузер спросит логин/пароль → откроется калькулятор.

> Funnel работает публично: адрес доступен всем в интернете, но за паролем Basic Auth.
> HTTPS обеспечивает сам Tailscale, поэтому пароль идёт по шифрованному каналу.

---

## 4. Автозапуск (чтобы жило после перезагрузки)

Ставит службу launchd, которая держит сервер запущенным:
```bash
cd docs/china-fbs/deploy
CALC_USER="ваш_логин" CALC_PASS="надёжный_пароль" bash install-launchd.sh
```
Funnel через `--bg` уже сохраняется в Tailscale и поднимается сам после перезагрузки — отдельного
автозапуска для него не нужно.

> Служба ставится как **LaunchAgent** и работает, пока пользователь залогинен.

### Автозапуск без входа в систему (LaunchDaemon) — для «безголового» Mac Mini
Чтобы сервер поднимался **при загрузке, без логина**, переносим службу в системные демоны.
Пароль берём из уже установленного LaunchAgent (копируем plist — не нужно вводить заново):
```bash
PL=~/Library/LaunchAgents/com.wbcalc.calculator.plist
TMP=$(mktemp); cp "$PL" "$TMP"
/usr/libexec/PlistBuddy -c "Add :UserName string $(whoami)" "$TMP" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :UserName $(whoami)" "$TMP"
launchctl bootout gui/$(id -u)/com.wbcalc.calculator 2>/dev/null; rm -f "$PL"
sudo cp "$TMP" /Library/LaunchDaemons/com.wbcalc.calculator.plist; rm -f "$TMP"
sudo chown root:wheel /Library/LaunchDaemons/com.wbcalc.calculator.plist
sudo chmod 600 /Library/LaunchDaemons/com.wbcalc.calculator.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.wbcalc.calculator.plist
sudo launchctl kickstart -k system/com.wbcalc.calculator
```
Управление демоном (с `sudo`):
```bash
sudo launchctl list | grep wbcalc                          # статус
sudo launchctl kickstart -k system/com.wbcalc.calculator   # перезапуск
sudo launchctl bootout system/com.wbcalc.calculator        # остановить/снять
```
Плюс включите автозапуск самого Mac после сбоя питания: *System Settings → Energy → Start up
automatically after a power failure* (или `sudo pmset -a autorestart 1`).

---

## Управление

```bash
# статус службы
launchctl list | grep wbcalc

# перезапустить сервер (после git pull или смены пароля)
launchctl unload ~/Library/LaunchAgents/com.wbcalc.calculator.plist
launchctl load   ~/Library/LaunchAgents/com.wbcalc.calculator.plist

# логи сервера
tail -f docs/china-fbs/calculator/serve.log

# статус
tailscale funnel status
# выключить ТОЛЬКО калькулятор (порт 10000) — planner/getcourse на 443/8443 не трогает
tailscale funnel --https=10000 off
# ВНИМАНИЕ: не запускайте `tailscale serve reset` — он снимет ВСЕ Funnel, включая 443/8443

# обновить калькулятор до свежей версии
cd wb-headless && git pull origin claude/china-fbs-branch-fuhjhb
launchctl unload ~/Library/LaunchAgents/com.wbcalc.calculator.plist && \
launchctl load   ~/Library/LaunchAgents/com.wbcalc.calculator.plist
```

## Обновление тарифов WB (при желании)
```bash
cd docs/china-fbs/tools && python3 update-wb-tariffs.py
# затем перезапустить сервер (см. выше)
```

## Безопасность
- Пароль — только в переменных окружения / в plist с правами `600`. В git не коммитится.
- Сервер слушает `127.0.0.1` — напрямую снаружи недоступен, только через Funnel.
- Basic Auth идёт поверх HTTPS (Tailscale). Используйте длинный пароль.
- Сменить пароль: перезапустить службу с новым `CALC_PASS` (шаг 4 заново).

## Возможные проблемы
- **`tailscale funnel` ругается на права/HTTPS** — включите MagicDNS + HTTPS Certificates и атрибут
  `funnel` в админке (раздел 0), перейдите по ссылке из вывода команды.
- **`command not found: tailscale`** — задайте алиас на бинарник в `Tailscale.app` (раздел 0).
- **`command not found: node`** — `brew install node`.
- **Порт занят** — задайте другой: `PORT=9090 ... node serve.cjs` и `tailscale funnel --bg 9090`.
