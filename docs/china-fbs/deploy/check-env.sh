#!/usr/bin/env bash
# ============================================================
# READ-ONLY аудит окружения перед развёртыванием калькулятора.
# Ничего не устанавливает, не запускает и не меняет — только читает.
# Запуск:  bash check-env.sh
# ============================================================
PORT_CHECK="${PORT:-8787}"
line() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

line "Система"
sw_vers 2>/dev/null
echo "hostname: $(hostname 2>/dev/null)"
echo "arch: $(uname -m 2>/dev/null) | user: $(whoami) | uptime:$(uptime 2>/dev/null | sed 's/.*up/ up/')"

line "Инструменты (версии)"
for t in node npm git python3 brew; do
  if command -v "$t" >/dev/null 2>&1; then
    printf '%-8s %s  (%s)\n' "$t" "$($t --version 2>&1 | head -1)" "$(command -v $t)"
  else
    printf '%-8s НЕ НАЙДЕН\n' "$t"
  fi
done

line "Tailscale"
TS="$(command -v tailscale 2>/dev/null)"
[ -z "$TS" ] && [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ] && TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
if [ -n "$TS" ]; then
  echo "бинарник: $TS"
  "$TS" version 2>&1 | head -3
  echo "--- статус ---";       "$TS" status 2>&1 | head -20
  echo "--- IP ---";           "$TS" ip 2>&1
  echo "--- funnel status ---"; "$TS" funnel status 2>&1
  echo "--- serve status ---";  "$TS" serve status 2>&1
else
  echo "Tailscale CLI не найден (проверьте, установлено ли приложение Tailscale)."
fi

line "Слушающие TCP-порты (все процессы)"
# netstat видит все порты без sudo (без имён процессов)
netstat -an -p tcp 2>/dev/null | grep -i 'LISTEN' | awk '{print $4}' | sort -u
echo "--- с именами процессов (свои; для чужих нужен sudo) ---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR==1 || /LISTEN/'

line "Порт $PORT_CHECK (нужен для калькулятора) — свободен?"
if lsof -nP -iTCP:"$PORT_CHECK" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN || netstat -an -p tcp 2>/dev/null | grep -qE "[\.:]$PORT_CHECK .*LISTEN"; then
  echo "ЗАНЯТ порт $PORT_CHECK:"
  lsof -nP -iTCP:"$PORT_CHECK" 2>/dev/null
else
  echo "СВОБОДЕН — порт $PORT_CHECK можно использовать."
fi

line "Запущенные node-процессы"
pgrep -fl node 2>/dev/null || ps aux 2>/dev/null | grep -i '[n]ode' || echo "нет"

line "Запущенные процессы Tailscale"
ps aux 2>/dev/null | grep -i '[t]ailscale' | awk '{$1=$1;print}' || echo "нет"

line "launchd-службы (node / tailscale / wbcalc)"
launchctl list 2>/dev/null | grep -iE 'wbcalc|node|tailscale' || echo "совпадений нет"

line "Уже склонированный репозиторий wb-headless?"
for d in "$HOME/wb-headless" "$HOME/Documents/wb-headless" "$HOME/Projects/wb-headless" "$PWD/wb-headless"; do
  [ -d "$d/.git" ] && echo "найден: $d"
done
[ -d ".git" ] && echo "текущая папка — git-репозиторий: $PWD ($(git -C "$PWD" remote get-url origin 2>/dev/null))"

line "Файрвол приложений macOS"
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null || echo "статус недоступен без sudo"

line "Готово"
echo "Это был read-only аудит — ничего не изменено. Пришлите вывод целиком."
