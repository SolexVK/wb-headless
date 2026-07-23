#!/bin/bash
# Запуск planner-сервера. Используется launchd-агентом и вручную.
# Порт и пароль берутся из окружения (заданы в plist или в shell).
set -e

# перейти в корень репозитория (deploy/ -> planner/ -> repo)
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"

export PLANNER_PORT="${PLANNER_PORT:-8090}"
# PLANNER_PASSWORD и PLANNER_USER задаются снаружи (plist / .env)

# найти node: сначала из PATH, затем типовые места Homebrew
NODE_BIN="$(command -v node || true)"
for p in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -z "$NODE_BIN" ] && [ -x "$p" ] && NODE_BIN="$p"
done
if [ -z "$NODE_BIN" ]; then
  echo "node не найден. Установите Node.js (brew install node)." >&2
  exit 1
fi

exec "$NODE_BIN" --experimental-sqlite planner/server.js
