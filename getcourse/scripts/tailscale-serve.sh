#!/usr/bin/env bash
# Expose the GetCourse Downloader UI over Tailscale — SAFELY, without disturbing
# any serve/funnel mapping already configured on this machine.
#
# This Mac already Funnels https://<node>.<tailnet>.ts.net (port 443) to another
# app. Funnel allows ports 443, 8443 and 10000, so by default we attach our app
# to the SAME node on port 8443 — additive, it does NOT touch the existing 443
# mapping. Resulting public URL:
#     https://<node>.<tailnet>.ts.net:8443
#
# Modes:
#   (default) attach to the existing node on FUNNEL_PORT (safe, recommended)
#   MODE=node bring up a dedicated node named "$TS_HOSTNAME" for a custom name
#             like https://getcourse.<tailnet>.ts.net  (needs tailscaled CLI and
#             Funnel enabled for that node in the tailnet ACL)
#
# Usage:
#   ./scripts/tailscale-serve.sh                 # public Funnel on :8443 (safe)
#   PUBLIC=1 ./scripts/tailscale-serve.sh        # same (PUBLIC kept for compat)
#   PRIVATE=1 ./scripts/tailscale-serve.sh       # tailnet-only (serve, no funnel)
#   FUNNEL_PORT=10000 ./scripts/tailscale-serve.sh
#   MODE=node TS_HOSTNAME=getcourse ./scripts/tailscale-serve.sh
set -euo pipefail

APP_PORT="${APP_PORT:-7837}"
FUNNEL_PORT="${FUNNEL_PORT:-8443}"
MODE="${MODE:-attach}"
PRIVATE="${PRIVATE:-0}"

command -v tailscale >/dev/null || { echo "tailscale CLI не найден."; exit 1; }

if [ "$MODE" = "attach" ]; then
  echo "[*] Текущая конфигурация serve/funnel (НЕ будет затронута на :443):"
  tailscale serve status 2>/dev/null || echo "  (пусто)"
  echo
  if lsof -nP -iTCP:"$FUNNEL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "!!! Порт $FUNNEL_PORT уже кем-то слушается локально — выберите другой FUNNEL_PORT (443/8443/10000)."; exit 1
  fi
  echo "[*] Приложение слушает http://127.0.0.1:${APP_PORT}"
  if [ "$PRIVATE" = "1" ]; then
    echo "[*] Приватный доступ (tailnet only) на :${FUNNEL_PORT}..."
    tailscale serve --bg --https="${FUNNEL_PORT}" "http://127.0.0.1:${APP_PORT}"
  else
    echo "[*] Публичный Funnel на :${FUNNEL_PORT} (существующий :443 не трогаем)..."
    tailscale funnel --bg --https="${FUNNEL_PORT}" "http://127.0.0.1:${APP_PORT}"
  fi
  echo
  echo "[*] Итоговая конфигурация:"
  tailscale serve status 2>/dev/null || true
  NODE="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\..*/\1/p' | head -1)"
  DOMAIN="$(tailscale status 2>/dev/null | sed -n 's#.*https://\([a-z0-9-]*\.[a-z0-9.-]*\.ts\.net\).*#\1#p' | head -1)"
  echo
  echo "Готово. Адрес приложения:"
  if [ -n "${DOMAIN:-}" ]; then echo "   https://${DOMAIN}:${FUNNEL_PORT}"; else echo "   https://<node>.<tailnet>.ts.net:${FUNNEL_PORT}"; fi
  echo
  echo "Снять только наш маршрут (не трогая :443):"
  echo "   tailscale serve --https=${FUNNEL_PORT} off"
  exit 0
fi

# --- MODE=node: dedicated node with a custom hostname ---
TS_HOSTNAME="${TS_HOSTNAME:-getcourse}"
STATE_DIR="${STATE_DIR:-$HOME/.${TS_HOSTNAME}-tailscale}"
SOCK="$STATE_DIR/tailscaled.sock"
command -v tailscaled >/dev/null || { echo "Для MODE=node нужен бинарь tailscaled (есть в standalone/brew Tailscale, но не всегда в GUI-версии)."; exit 1; }
mkdir -p "$STATE_DIR"
if ! tailscale --socket="$SOCK" status >/dev/null 2>&1; then
  echo "[*] Запускаю выделенный tailscaled '$TS_HOSTNAME'..."
  nohup tailscaled --tun=userspace-networking --statedir="$STATE_DIR" --socket="$SOCK" >"$STATE_DIR/tailscaled.log" 2>&1 &
  sleep 2
fi
echo "[*] Поднимаю узел (при первом запуске появится ссылка для входа)..."
tailscale --socket="$SOCK" up --hostname="$TS_HOSTNAME"
echo "[*] Публикую приложение..."
tailscale --socket="$SOCK" funnel --bg "http://127.0.0.1:${APP_PORT}"
tailscale --socket="$SOCK" serve status || true
echo
echo "Адрес: https://${TS_HOSTNAME}.<ваш-tailnet>.ts.net"
echo "ВНИМАНИЕ: для Funnel на новом узле может потребоваться включить атрибут"
echo "'funnel' для него в ACL тейлнета (admin console)."
