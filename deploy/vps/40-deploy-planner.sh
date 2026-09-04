#!/usr/bin/env bash
# 40-deploy-planner.sh — развернуть/обновить planner («производственный план») как systemd-сервис.
# Запускать от root. Идемпотентен: повторный запуск = обновление (git fetch + npm install + restart).
#
#   sudo bash deploy/vps/40-deploy-planner.sh
#
# Переменные (все со значениями по умолчанию):
#   APP_DIR   — куда ставим репозиторий (по умолчанию /opt/planner; приложение в $APP_DIR/planner)
#   APP_USER  — системный пользователь сервиса (planner)
#   REPO_URL  — откуда клонировать
#   BRANCH    — ветка с инструментом (claude/production-plan-twv8ki)
#   PORT/HOST — что слушать (9100 / 127.0.0.1 — наружу только через Caddy)
#   SKIP_PULL=1 — не трогать git (деплой из уже залитых файлов)
#
# ВАЖНО: npm ставится ТОЛЬКО в подкаталоге planner/ (там одна зависимость — express).
# В корне репозитория лежит puppeteer, планировщику он не нужен и тянет Chromium.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/planner}"
APP_USER="${APP_USER:-planner}"
REPO_URL="${REPO_URL:-https://github.com/SolexVK/wb-headless.git}"
BRANCH="${BRANCH:-claude/production-plan-twv8ki}"
PORT="${PORT:-9100}"
HOST="${HOST:-127.0.0.1}"
SERVICE=planner
PLANNER_DIR="$APP_DIR/planner"
DATA_DIR="$PLANNER_DIR/data"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { runuser -u "$APP_USER" -- "$@"; }
rand() { head -c 48 /dev/urandom | base64 | tr -d '/+=' | cut -c1-"${1:-32}"; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"
command -v node >/dev/null 2>&1 || die "Нет node — сначала deploy/vps/10-install-node.sh"
node_major="$(node -v)"; node_major="${node_major#v}"; node_major="${node_major%%.*}"
[ "$node_major" -ge 22 ] 2>/dev/null || die "Нужен Node 22+ (сейчас $(node -v)): planner использует встроенный node:sqlite"
export DEBIAN_FRONTEND=noninteractive

# ---------- пользователь ----------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Создаю системного пользователя $APP_USER (без логина)"
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------- код ----------
if [ "${SKIP_PULL:-0}" = "1" ]; then
  log "SKIP_PULL=1 — код в $APP_DIR беру как есть"
  [ -d "$PLANNER_DIR" ] || die "Нет каталога $PLANNER_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  log "Обновляю код в $APP_DIR (ветка $BRANCH)"
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  # -f: не спотыкаться о файлы, созданные npm (package-lock.json)
  git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
else
  log "Клонирую $REPO_URL → $APP_DIR (ветка $BRANCH)"
  install -d -m 755 "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$DATA_DIR/samples"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- .env ----------
# Один файл на всех: его читает systemd (EnvironmentFile) и сам server.js (loadDotenv).
ENV_FILE="$DATA_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  GEN_PASS="$(rand 24)"
  log "Создаю $ENV_FILE (пароль сгенерирован случайно)"
  {
    echo "# создан 40-deploy-planner.sh $(date +%F). Формат KEY=VALUE (без кавычек и пробелов)."
    echo "PLANNER_HOST=$HOST"
    echo "PLANNER_PORT=$PORT"
    echo "PLANNER_USER=admin"
    echo "PLANNER_PASSWORD=$GEN_PASS"
    echo "SESSION_SECRET=$(rand 48)"
    echo "# Токен MPStats для раздела «Ранг сезонности» (можно оставить пустым)"
    echo "MPSTATS_TOKEN="
    echo "# Telegram-авторизация (когда настроим бота) — тогда пароль выше перестанет использоваться:"
    echo "# TELEGRAM_BOT_TOKEN="
    echo "# TELEGRAM_BOT_USERNAME="
    echo "# OWNER_TELEGRAM_ID="
  } > "$ENV_FILE"
  warn "Логин admin, пароль: $GEN_PASS  (лежит в $ENV_FILE, поменять — nano + systemctl restart $SERVICE)"
else
  log ".env уже есть — не трогаю (проверю только порт и хост)"
  grep -q '^PLANNER_HOST=' "$ENV_FILE" || echo "PLANNER_HOST=$HOST" >> "$ENV_FILE"
  grep -q '^PLANNER_PORT=' "$ENV_FILE" || echo "PLANNER_PORT=$PORT" >> "$ENV_FILE"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# ---------- зависимости ----------
log "npm install в $PLANNER_DIR (только express, без скриптов установки)"
as_app env HOME="/var/lib/$APP_USER" npm --prefix "$PLANNER_DIR" install \
  --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock

# ---------- systemd ----------
log "Ставлю юнит /etc/systemd/system/$SERVICE.service"
sed -e "s|{{APP_DIR}}|$APP_DIR|g" -e "s|{{APP_USER}}|$APP_USER|g" -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
    -e "s|{{SERVICE}}|$SERVICE|g" -e "s|{{DESC}}|planner (производственный план)|g" \
  "$HERE/planner.service" > "/etc/systemd/system/$SERVICE.service"
chmod 644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

# ---------- проверка ----------
log "Проверяю, что сервис отвечает"
# /api/health закрыт паролем, поэтому 401 — тоже успех: сервер жив и защищён.
code=""
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/health" || true)"
  case "$code" in 200|401) break ;; esac
  sleep 1
done
case "$code" in
  200) warn "Ответ 200 без пароля — авторизация ВЫКЛЮЧЕНА. Впиши PLANNER_PASSWORD в $ENV_FILE и перезапусти." ;;
  401) log "Сервис поднят и закрыт паролем: http://127.0.0.1:$PORT" ;;
  *)   systemctl --no-pager --lines=30 status "$SERVICE" || true
       die "Сервис не ответил (код «$code») — смотри journalctl -u $SERVICE -n 50" ;;
esac

# База открывается при старте (авто-снимок состояния) — значит файл должен появиться.
if [ -f "$DATA_DIR/planner.db" ]; then
  log "SQLite работает: $DATA_DIR/planner.db ($(du -h "$DATA_DIR/planner.db" | cut -f1))"
else
  warn "Нет $DATA_DIR/planner.db — SQLite не поднялся, planner работает на JSON-файлах."
  warn "Проверь: journalctl -u $SERVICE -n 50 --no-pager"
fi
log "Дальше: опубликовать снаружи — sudo bash $HERE/add-site.sh planner.aidemiko.ru $PORT"
