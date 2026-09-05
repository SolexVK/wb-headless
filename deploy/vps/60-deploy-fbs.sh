#!/usr/bin/env bash
# 60-deploy-fbs.sh — развернуть/обновить FBS-аналитику (мульти-тенант отчёты WB).
# Запускать от root. Идемпотентен: повторный запуск = обновление.
#
#   sudo bash deploy/vps/60-deploy-fbs.sh
#
# Что ставится помимо кода:
#   • python3 + openpyxl — Excel-выгрузки отчётов (scripts/*-xlsx.py);
#   • Playwright + Chromium — PDF-отчёты (scripts/fbs-pdf.mjs);
#   • зависимости сервиса (express, helmet, pino…) — чистый JS.
#
# Данные (база кабинетов, снимки остатков, артефакты отчётов) — в service/data,
# как и на Mac Mini. Перенос — см. docs/fbs-migration.md.
#
# Переменные:
#   APP_DIR /opt/fbs · APP_USER fbs · PORT 9110 · BASE_PATH /fbs
#   SKIP_BROWSER=1 — не ставить Chromium (тогда PDF-отчёты работать не будут)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fbs}"
APP_USER="${APP_USER:-fbs}"
REPO_URL="${REPO_URL:-https://github.com/SolexVK/wb-headless.git}"
BRANCH="${BRANCH:-claude/fbs-fullfilment-branch-cfvgir}"
PORT="${PORT:-9110}"
HOST="${HOST:-127.0.0.1}"
BASE_PATH="${BASE_PATH:-/fbs}"
SERVICE=fbs
SVC_DIR="$APP_DIR/service"
DATA_DIR="$SVC_DIR/data"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { runuser -u "$APP_USER" -- "$@"; }
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"
command -v node >/dev/null 2>&1 || die "Нет node — сначала deploy/vps/10-install-node.sh"
node_major="$(node -v)"; node_major="${node_major#v}"; node_major="${node_major%%.*}"
[ "$node_major" -ge 22 ] 2>/dev/null || die "Нужен Node 22+ (сейчас $(node -v))"
export DEBIAN_FRONTEND=noninteractive

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Создаю системного пользователя $APP_USER"
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------- системные пакеты ----------
log "Ставлю python3 и openpyxl (Excel-выгрузки)"
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends python3 python3-openpyxl >/dev/null \
  || die "Не удалось поставить python3-openpyxl"
python3 -c 'import openpyxl' 2>/dev/null || die "openpyxl не импортируется — Excel-отчёты работать не будут"

# ---------- код ----------
if [ -d "$APP_DIR/.git" ]; then
  log "Обновляю код (ветка $BRANCH)"
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  # -f: не спотыкаться о файлы, созданные npm
  git -C "$APP_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"
else
  log "Клонирую $REPO_URL → $APP_DIR (ветка $BRANCH)"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- .env сервиса ----------
ENV_FILE="$SVC_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Создаю $ENV_FILE (секреты генерирую)"
  {
    echo "# создан 60-deploy-fbs.sh $(date +%F)"
    echo "HOST=$HOST"
    echo "PORT=$PORT"
    echo "NODE_ENV=production"
    echo "BASE_PATH=$BASE_PATH"
    echo "SESSION_SECRET=$(rand_hex 48)"
    echo "# ВНИМАНИЕ: этим ключом зашифрованы WB-токены кабинетов в базе."
    echo "# При переносе базы с Mac Mini вписать СЮДА ключ оттуда, иначе кабинеты не расшифруются."
    echo "TOKEN_ENC_KEY=$(rand_hex 32)"
    echo "DB_PATH=./data/app.sqlite"
    echo "WB_PING_ONLINE=1"
    echo "DEFAULT_LICENSE_SEATS=1"
    echo "SUPER_ADMIN_EMAILS=solexvk@gmail.com"
  } > "$ENV_FILE"
  warn "Переносишь базу с Mac Mini? Сначала впиши в $ENV_FILE её TOKEN_ENC_KEY — иначе токены кабинетов пропадут"
else
  log ".env уже есть — не трогаю"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# ---------- зависимости ----------
log "Ставлю зависимости сервиса"
as_app env HOME="/var/lib/$APP_USER" npm --prefix "$SVC_DIR" ci --omit=dev --no-audit --no-fund \
  || as_app env HOME="/var/lib/$APP_USER" npm --prefix "$SVC_DIR" install --omit=dev --no-audit --no-fund

if [ "${SKIP_BROWSER:-0}" != "1" ]; then
  log "Ставлю Playwright и Chromium (PDF-отчёты)"
  # Скрипты отчётов используют только встроенные модули Node; из корневых зависимостей
  # нужен лишь playwright. PUPPETEER_SKIP_DOWNLOAD — чтобы соседний puppeteer не тянул
  # свой Chromium (~150 МБ), он тут не нужен.
  ( cd "$APP_DIR" && as_app env HOME="/var/lib/$APP_USER" PUPPETEER_SKIP_DOWNLOAD=1 \
      npm install --ignore-scripts --no-audit --no-fund --no-package-lock ) \
    || warn "Корневые зависимости не поставились — PDF-отчёты могут не работать"
  # Системные библиотеки Chromium ставит root, сам браузер — пользователь сервиса.
  ( cd "$APP_DIR" && npx --yes playwright install-deps chromium >/dev/null 2>&1 ) \
    || warn "Не поставились системные библиотеки Chromium"
  ( cd "$APP_DIR" && as_app env HOME="/var/lib/$APP_USER" npx --yes playwright install chromium >/dev/null ) \
    || warn "Chromium не скачался — PDF-отчёты работать не будут (остальное будет)"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- systemd ----------
log "Ставлю юнит /etc/systemd/system/$SERVICE.service"
sed -e "s|{{APP_DIR}}|$APP_DIR|g" -e "s|{{APP_USER}}|$APP_USER|g" -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
  "$HERE/fbs.service" > "/etc/systemd/system/$SERVICE.service"
chmod 644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

# ---------- проверка ----------
log "Проверяю /healthz"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  systemctl --no-pager --lines=30 status "$SERVICE" || true
  die "Сервис не ответил на /healthz — смотри journalctl -u $SERVICE -n 50"
fi
curl -fsS "http://127.0.0.1:$PORT/healthz"; echo
log "Сервис поднят: http://127.0.0.1:$PORT (наружу — через Caddy, путь $BASE_PATH)"
log "Опубликовать: sudo bash $HERE/add-route.sh $BASE_PATH $PORT --keep"
