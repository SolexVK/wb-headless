#!/usr/bin/env bash
# Expose the GetCourse Downloader UI over Tailscale with a friendly hostname,
# without colliding with other projects already running on this Mac Mini.
#
# It brings up a DEDICATED userspace Tailscale node named "$TS_HOSTNAME" (default
# "getcourse"), so the app gets its own clean URL:
#     https://getcourse.<your-tailnet>.ts.net
# separate from the machine's main Tailscale node and its :443.
#
# Requires the open-source Tailscale CLI (brew install tailscale). If you use the
# Mac App Store Tailscale instead, see the note at the bottom.
#
# Usage:
#   ./scripts/tailscale-serve.sh              # private: only your tailnet
#   PUBLIC=1 ./scripts/tailscale-serve.sh     # public internet (Funnel) for paid clients
#   TS_HOSTNAME=my-name APP_PORT=7837 ./scripts/tailscale-serve.sh
set -euo pipefail

TS_HOSTNAME="${TS_HOSTNAME:-getcourse}"
APP_PORT="${APP_PORT:-7837}"
STATE_DIR="${STATE_DIR:-$HOME/.${TS_HOSTNAME}-tailscale}"
SOCK="$STATE_DIR/tailscaled.sock"
PUBLIC="${PUBLIC:-0}"

command -v tailscaled >/dev/null || { echo "tailscaled not found. Install: brew install tailscale"; exit 1; }
command -v tailscale  >/dev/null || { echo "tailscale not found. Install: brew install tailscale"; exit 1; }

mkdir -p "$STATE_DIR"

# Start a dedicated userspace tailscaled if not already running for this node.
if ! tailscale --socket="$SOCK" status >/dev/null 2>&1; then
  echo "[*] starting dedicated tailscaled node '$TS_HOSTNAME'..."
  nohup tailscaled \
    --tun=userspace-networking \
    --statedir="$STATE_DIR" \
    --socket="$SOCK" \
    >"$STATE_DIR/tailscaled.log" 2>&1 &
  sleep 2
fi

echo "[*] bringing the node up (a login URL will be printed on first run)..."
tailscale --socket="$SOCK" up --hostname="$TS_HOSTNAME"

echo "[*] serving app (127.0.0.1:$APP_PORT) over HTTPS..."
tailscale --socket="$SOCK" serve --bg --https=443 "http://127.0.0.1:${APP_PORT}"

if [ "$PUBLIC" = "1" ]; then
  echo "[*] enabling public Funnel..."
  tailscale --socket="$SOCK" funnel --bg 443
fi

echo
tailscale --socket="$SOCK" serve status || true
echo
echo "Готово. Адрес приложения:"
echo "   https://${TS_HOSTNAME}.<ваш-tailnet>.ts.net"
echo "(точный tailnet-суффикс покажет: tailscale --socket=$SOCK status)"
echo
echo "Остановить:  tailscale --socket=$SOCK down"
echo
cat <<'NOTE'
--- Если установлен Tailscale из Mac App Store (без CLI tailscaled) ---
Выделенный узел через этот скрипт не поднять. Тогда используйте основной узел:
   tailscale serve --bg --https=8443 http://127.0.0.1:7837
Адрес будет:  https://<имя-мака>.<tailnet>.ts.net:8443
(имя мака — это уже понятное имя, а не IP). Публичный доступ: tailscale funnel 8443
NOTE
