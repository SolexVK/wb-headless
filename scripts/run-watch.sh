#!/bin/bash
# scripts/run-watch.sh — обёртка для запуска сторожа из launchd/cron.
#
# launchd не читает .env и стартует с пустым PATH, поэтому здесь мы:
#   1) находим корень репозитория относительно самого скрипта;
#   2) подгружаем .env (секреты живут только там, chmod 600);
#   3) ищем node в типовых местах macOS;
#   4) пишем лог с простой ротацией.
#
# Запуск вручную:  ./scripts/run-watch.sh            боевой прогон
#                  ./scripts/run-watch.sh --dry-run  без отправки в Telegram
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

find_node() {
  if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then echo "$NODE_BIN"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local latest
    latest="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    [ -n "$latest" ] && [ -x "$HOME/.nvm/versions/node/$latest/bin/node" ] && {
      echo "$HOME/.nvm/versions/node/$latest/bin/node"; return; }
  fi
  command -v node 2>/dev/null
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo "$(date '+%F %T') Не найден node. Задайте NODE_BIN в .env (путь к бинарю)." >&2
  exit 127
fi

mkdir -p logs
LOG="logs/wb-watch.log"
# Ротация: раз в ~5 МБ отправляем текущий лог в .1, чтобы файл не рос бесконечно.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt 5242880 ]; then
  mv -f "$LOG" "$LOG.1"
fi

{
  echo "──────── $(date '+%F %T %Z') запуск сторожа ${*:-} ────────"
  "$NODE" agent-wb-watch.mjs "$@"
  echo "код возврата: $?"
} >> "$LOG" 2>&1

tail -1 "$LOG"
