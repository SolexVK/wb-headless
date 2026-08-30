# Шпаргалка: архивные копии плана + две версии с ноутбука

Постоянная инструкция (для любой будущей сессии). Как заморозить текущий план отдельной копией
и открывать её с ноутбука рядом с рабочей. Всё уже отлажено на Mac mini владельца
(openclaw@Mac-mini-Vital). Пользователь работает НЕ на Mac mini, а с ноутбука через **Tailscale**.

## Архитектура (как устроено сейчас)

- **Рабочая версия:** `~/wb-headless` → `node planner/server.js` на **8477**, launchd `com.wbheadless.planner`
  (homebrew node, `--experimental-sqlite`, KeepAlive). Авторизация Telegram ВКЛ. Публикуется в
  Tailscale на **:8444** (`https://mac-mini-vital.tail13d29e.ts.net:8444`). Здесь РЕДАКТИРУЮТ план.
- **Умные запросы:** мостик `com.vital.proxybridge` (`~/proxy-bridge/bridge.js`) — `http://127.0.0.1:8118`
  → socks5-прокси пользователя (США). Планировщик вызывает `claude -p` через этот прокси (подписка).
- **Архив v1:** `~/wb-headless-ARHIV-2026-08-30` → **8478**, launchd `com.wbheadless.archive`
  (nvm node), авторизация ВЫКЛ (`TELEGRAM_BOT_TOKEN` пусто), метка `PLANNER_INSTANCE_LABEL="АРХИВ · Версия 1"`.
  Публикуется в Tailscale на **:8445**. Только просмотр.

## Ключевые факты / пути (актуальны на 2026-08-30)

- node (nvm): `/Users/openclaw/.nvm/versions/node/v24.19.0/bin/node` (и рядом `bin/claude`).
- База: `planner/data/planner.db` (SQLite, режим **WAL**). Вся модель в ней (app_state, season_plans,
  report_archive, meta, prod_events, кэши). Плюс `planner/data/{samples,plans,.env}`.
- Занятые Tailscale-порты: `:8443→8090`, `:8444→8477 (рабочая)`, `:8445→8478 (архив v1)`, `:10000→8787`,
  `:443→18789 (+/fbs,/calc→9000)`.
- **Следующие свободные порты для Версии 2:** локальный **8479**, Tailscale **:8446**. Для v3 — 8480/:8447 и т.д.
- Подпись экземпляра: переменная `PLANNER_INSTANCE_LABEL` (код это уже умеет с билда
  `instance-label-2026-08-30`, инъекция в `indexHtmlVersioned()` в server.js). Пусто = без метки.

## ПОЧЕМУ так (грабли, которые уже прошли)

- **Копировать папку «на живую» просто `cp -R` нельзя** — база в WAL, копия попадёт на середину записи.
  Базу берём через `sqlite3 ".backup"` (консистентный онлайн-снимок), остальное `cp -Rc` (APFS-клон, быстро/без диска).
- **Cookie-сессии привязаны к ХОСТУ, а не к порту.** У рабочей и архива один хост Tailscale, поэтому
  если на архиве оставить Telegram-вход, логин на одном разлогинивает другой. → архив держим БЕЗ входа
  (`TELEGRAM_BOT_TOKEN=` пусто), он и так только внутри приватного tailnet.
- **launchd даёт урезанный PATH** → в plist прописываем полный PATH и абсолютный путь к node.
- **Telegram-виджет привязан к домену, не к порту** — на том же ts.net-хосте работает на любом порту;
  на `localhost` не грузится (не тот домен, нет HTTPS).
- **Метку раньше правили прямо в HTML архива** — теперь НЕ нужно: задаётся переменной. Если делаете
  git pull в старом архиве, где HTML правили руками — сперва `git checkout -- planner/public/index.html`.

## РЕЦЕПТ: создать новую замороженную версию (шаблон)

Заполнить 4 значения и выдать пользователю блоками. Пример для **Версии 2**
(дата — сегодняшняя; порты 8479 / :8446):

```
# --- параметры новой версии ---
VER="2"                                   # номер версии
ARCH="$HOME/wb-headless-ARHIV-$(date +%Y-%m-%d)"   # папка архива (при коллизии добавить -v2)
LOCAL_PORT="8479"                         # свободный локальный порт
TS_PORT="8446"                            # свободный Tailscale-порт
NODE="/Users/openclaw/.nvm/versions/node/v24.19.0/bin/node"

# 1) консистентная копия папки + базы
cp -Rc "$HOME/wb-headless" "$ARCH" 2>/dev/null || cp -R "$HOME/wb-headless" "$ARCH"
sqlite3 "$HOME/wb-headless/planner/data/planner.db" ".backup '$ARCH/planner/data/planner.db'"
rm -f "$ARCH/planner/data/planner.db-wal" "$ARCH/planner/data/planner.db-shm"
sqlite3 "$ARCH/planner/data/planner.db" "PRAGMA integrity_check;" | head -1   # ждём ok

# 2) launchd-сервис архива (без входа, локально, с меткой)
cat > ~/Library/LaunchAgents/com.wbheadless.archive-v$VER.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wbheadless.archive-v$VER</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ARCH/planner/server.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PLANNER_PORT</key><string>$LOCAL_PORT</string>
    <key>PLANNER_HOST</key><string>127.0.0.1</string>
    <key>TELEGRAM_BOT_TOKEN</key><string></string>
    <key>PLANNER_INSTANCE_LABEL</key><string>АРХИВ · Версия $VER</string>
    <key>PATH</key><string>/Users/openclaw/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$ARCH/planner</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ARCH/archive.log</string>
  <key>StandardErrorPath</key><string>$ARCH/archive.err.log</string>
</dict></plist>
EOF
launchctl unload ~/Library/LaunchAgents/com.wbheadless.archive-v$VER.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.wbheadless.archive-v$VER.plist
sleep 3
curl -s http://localhost:$LOCAL_PORT/api/health ; echo

# 3) публикация в Tailscale
tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$LOCAL_PORT
tailscale serve status
```

Итог: на ноутбуке новая закладка `https://mac-mini-vital.tail13d29e.ts.net:<TS_PORT>` — открывается без входа,
с меткой «АРХИВ · Версия N», отдельная замороженная база. Рабочая (`:8444`) не затронута.

## Открыть/погасить архив вручную (если без launchd)
```
cd <ARCH>/planner && PLANNER_HOST=127.0.0.1 TELEGRAM_BOT_TOKEN= PLANNER_INSTANCE_LABEL="АРХИВ · Версия N" PLANNER_PORT=<LOCAL_PORT> node server.js
```

## Снять/удалить архив-сервис
```
launchctl unload ~/Library/LaunchAgents/com.wbheadless.archive-vN.plist
rm ~/Library/LaunchAgents/com.wbheadless.archive-vN.plist
tailscale serve --https=<TS_PORT> off        # снять публикацию
```

## Идея на будущее (не сделано)
Завернуть рецепт в `archive-service.sh` (аргументы: версия, порты) — архивирование одной командой.
Пользователю предлагали; пока делаем блоками по шаблону выше.
