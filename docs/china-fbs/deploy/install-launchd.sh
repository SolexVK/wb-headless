#!/usr/bin/env bash
# ============================================================
# Установка калькулятора как службы launchd (автозапуск на macOS).
# Сервер поднимается на 127.0.0.1:$PORT и переживает перезагрузку
# (при входе пользователя в систему).
#
# Запуск:
#   CALC_USER="логин" CALC_PASS="пароль" bash install-launchd.sh
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../calculator" && pwd)"
NODE="$(command -v node || true)"
LABEL="com.wbcalc.calculator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-8787}"

[ -z "$NODE" ] && { echo "Node.js не найден в PATH. Установите: brew install node"; exit 1; }
: "${CALC_USER:?Задайте переменную CALC_USER (логин)}"
: "${CALC_PASS:?Задайте переменную CALC_PASS (пароль)}"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/serve.cjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CALC_USER</key><string>$CALC_USER</string>
    <key>CALC_PASS</key><string>$CALC_PASS</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/serve.log</string>
  <key>StandardErrorPath</key><string>$DIR/serve.err.log</string>
</dict>
</plist>
PLIST

chmod 600 "$PLIST"   # пароль в plist — только для владельца

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Служба установлена: $PLIST"
echo "Сервер: http://127.0.0.1:$PORT (логин: $CALC_USER)"
echo "Логи:   $DIR/serve.log  и  $DIR/serve.err.log"
echo
echo "Дальше выведите наружу через Tailscale Funnel:"
echo "  tailscale funnel --bg $PORT"
