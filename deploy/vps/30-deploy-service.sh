#!/usr/bin/env bash
# 30-deploy-service.sh — развернуть/обновить wb-headless как systemd-сервис.
# Запускать от root. Идемпотентен: повторный запуск = обновление (git pull + npm ci + restart).
#
#   REPO_URL=https://github.com/SolexVK/wb-headless.git BRANCH=main \
#   PORT=8080 bash deploy/vps/30-deploy-service.sh
#
# Переменные:
#   APP_DIR     — куда ставим (по умолчанию /opt/wb-headless)
#   APP_USER    — системный пользователь сервиса (wbheadless)
#   REPO_URL    — откуда клонировать, если APP_DIR ещё не git-репозиторий
#   BRANCH      — ветка (по умолчанию текущая ветка в APP_DIR, для нового клона main)
#   PORT/HOST   — что слушать (8080 / 127.0.0.1 — наружу только через Caddy)
#   SKIP_CHROME=1 — не качать Chrome for Testing (нужен для /start, /verify и PDF-отчётов)
#   SKIP_PULL=1   — не трогать git (деплой из уже залитых файлов, например по rsync)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wb-headless}"
APP_USER="${APP_USER:-wbheadless}"
REPO_URL="${REPO_URL:-https://github.com/SolexVK/wb-headless.git}"
# Ветка: по умолчанию та, что уже развёрнута в APP_DIR (чтобы обновление не
# перекидывало сервер на main), а для чистой установки — main.
BRANCH="${BRANCH:-$(git -C "${APP_DIR:-/opt/wb-headless}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
SERVICE=wb-headless
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { runuser -u "$APP_USER" -- "$@"; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"
command -v node >/dev/null 2>&1 || die "Нет node — сначала deploy/vps/10-install-node.sh"
export DEBIAN_FRONTEND=noninteractive

# ---------- пользователь ----------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Создаю системного пользователя $APP_USER (без логина)"
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------- зависимости chromium ----------
if [ "${SKIP_CHROME:-0}" != "1" ]; then
  log "Ставлю системные библиотеки для headless Chrome"
  apt-get update -y
  # на Ubuntu 24.04 часть пакетов переименована в *t64 — пробуем оба имени
  for pkg in ca-certificates fonts-liberation fonts-noto-color-emoji libasound2 libatk-bridge2.0-0 \
             libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
             libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
             libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
             libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxtst6 xdg-utils; do
    apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1 \
      || apt-get install -y --no-install-recommends "${pkg}t64" >/dev/null 2>&1 \
      || warn "пакет $pkg не найден — пропускаю"
  done
fi

# ---------- код ----------
if [ "${SKIP_PULL:-0}" = "1" ]; then
  log "SKIP_PULL=1 — код в $APP_DIR беру как есть"
  [ -d "$APP_DIR" ] || die "Нет каталога $APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  log "Обновляю код в $APP_DIR (ветка $BRANCH)"
  git -C "$APP_DIR" config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  log "Клонирую $REPO_URL → $APP_DIR"
  install -d -m 755 "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/reports-output"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- .env ----------
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Создаю $ENV_FILE (API_KEY генерирую случайный)"
  API_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32)"
  {
    echo "# создан 30-deploy-service.sh $(date +%F). Токены вписать вручную."
    echo "HOST=$HOST"
    echo "PORT=$PORT"
    echo "API_KEY=$API_KEY"
    echo "MPSTATS_TOKEN="
  } > "$ENV_FILE"
  warn "Впиши MPSTATS_TOKEN в $ENV_FILE и перезапусти: systemctl restart $SERVICE"
  warn "Ключ доступа к API: $API_KEY  (заголовок x-api-key)"
else
  log ".env уже есть — не трогаю"
  grep -q '^HOST=' "$ENV_FILE" || echo "HOST=$HOST" >> "$ENV_FILE"
  grep -q '^PORT=' "$ENV_FILE" || echo "PORT=$PORT" >> "$ENV_FILE"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# ---------- зависимости приложения ----------
log "npm ci (только prod-зависимости)"
as_app env HOME="/var/lib/$APP_USER" npm --prefix "$APP_DIR" ci --omit=dev

if [ "${SKIP_CHROME:-0}" != "1" ]; then
  if [ -d "$APP_DIR/chrome" ] && find "$APP_DIR/chrome" -name chrome -type f -print -quit | grep -q .; then
    log "Chrome for Testing уже скачан — пропускаю"
  else
    log "Качаю Chrome for Testing в $APP_DIR/chrome (~150 МБ)"
    ( cd "$APP_DIR" && as_app env HOME="/var/lib/$APP_USER" npm run build:chrome ) \
      || warn "Не скачался Chrome — /start, /verify и PDF работать не будут (отчёты в CSV/JSON будут)"
  fi
fi

# ---------- systemd ----------
log "Ставлю юнит /etc/systemd/system/$SERVICE.service"
sed -e "s|{{APP_DIR}}|$APP_DIR|g" -e "s|{{APP_USER}}|$APP_USER|g" \
  "$HERE/wb-headless.service" > "/etc/systemd/system/$SERVICE.service"
chmod 644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

log "Проверяю health"
ok=""
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -n "$ok" ]; then
  curl -fsS "http://127.0.0.1:$PORT/health"; echo
  log "Сервис поднят: http://127.0.0.1:$PORT (наружу — через Caddy, путь /wb)"
else
  systemctl --no-pager --lines=30 status "$SERVICE" || true
  die "Сервис не ответил на /health — смотри journalctl -u $SERVICE -n 50"
fi
