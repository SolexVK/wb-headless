#!/usr/bin/env bash
# Read-only inspection of the Mac Mini before deploying anything.
# Shows what is already listening, which ports/addresses are taken, key running
# services, Tailscale state and disk space — so the new service does not clash
# with existing projects. Makes NO changes.
set -uo pipefail

line(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

line "Система"
sw_vers 2>/dev/null || uname -a
echo "hostname: $(hostname)"
echo "uptime:  $(uptime)"

line "Слушающие TCP-порты (LISTEN) — что и на каком порту/адресе"
# -i tcp -sTCP:LISTEN: только слушающие сокеты; -P -n: без резолва имён/портов
if command -v lsof >/dev/null; then
  lsof -nP -iTCP -sTCP:LISTEN | awk 'NR==1 || /LISTEN/'
else
  netstat -anv -p tcp | grep LISTEN
fi

line "Занят ли наш порт 7837 (и запасные 7838/8443)?"
for p in 7837 7838 8443; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  порт $p: ЗАНЯТ ->"; lsof -nP -iTCP:"$p" -sTCP:LISTEN | grep LISTEN
  else
    echo "  порт $p: свободен"
  fi
done

line "Порт 8080 (существующий проект wb-headless) — для справки"
lsof -nP -iTCP:8080 -sTCP:LISTEN 2>/dev/null | grep LISTEN || echo "  8080 не слушается"

line "Процессы node / server (уже работающие сервисы)"
ps aux | grep -Ei 'node|puppeteer|playwright|server\.js|server\.mjs' | grep -v grep || echo "  нет"

line "LaunchAgents / LaunchDaemons (автозапуск сервисов пользователя)"
ls -1 ~/Library/LaunchAgents 2>/dev/null || echo "  нет пользовательских LaunchAgents"
launchctl list 2>/dev/null | grep -Ei 'node|getcourse|tailscale|homebrew|com\.' | head -30 || true

line "Tailscale — установлен ли и версия"
if command -v tailscale >/dev/null; then
  tailscale version
  echo "--- статус ---"; tailscale status 2>/dev/null | head -20
  echo "--- текущий serve/funnel ---"; tailscale serve status 2>/dev/null || echo "  serve не настроен"
  tailscale funnel status 2>/dev/null || true
else
  echo "  CLI 'tailscale' не найден в PATH."
  echo "  Проверьте GUI-приложение: ls -d /Applications/Tailscale.app 2>/dev/null"
  ls -d /Applications/Tailscale.app 2>/dev/null && \
    echo "  Найдено приложение Mac App Store. CLI: /Applications/Tailscale.app/Contents/MacOS/Tailscale version"
fi

line "Homebrew / Node / ffmpeg"
command -v brew && brew --version | head -1 || echo "  brew: нет"
command -v node && node --version || echo "  node (системный): нет"
command -v nvm >/dev/null && echo "  nvm: есть" || echo "  nvm: нет (поставит скрипт развёртывания)"
command -v ffmpeg && ffmpeg -version | head -1 || echo "  ffmpeg: нет"

line "Диск (свободно на томе) — важно для спула скачиваний"
df -h / /Users 2>/dev/null | awk 'NR==1 || /\//'

line "Готово"
echo "Ничего не изменено. Разверните сервис скриптом deploy-macmini.sh после проверки выше."
