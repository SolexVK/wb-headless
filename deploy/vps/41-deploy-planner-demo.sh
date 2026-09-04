#!/usr/bin/env bash
# 41-deploy-planner-demo.sh — демо-стенд planner: тот же код, ОТДЕЛЬНАЯ обезличенная база.
# Запускать от root. Идемпотентен.
#
#   sudo bash deploy/vps/41-deploy-planner-demo.sh              # развернуть/обновить код
#   sudo REFRESH_DB=1 bash deploy/vps/41-deploy-planner-demo.sh # ещё и пересобрать базу из боевой
#
# Почему отдельный экземпляр, а не роль внутри боевого: живые данные компании
# (себестоимость, объёмы, поставщики) в демо не попадают физически — их там нет.
#
# Переменные:
#   APP_DIR      — /opt/planner-demo         DEMO_PORT — 9101
#   SRC_DB       — боевая база, откуда берём снимок (/opt/planner/planner/data/planner.db)
#   REFRESH_DB=1 — пересоздать демо-базу из боевой (иначе существующую не трогаем)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/planner-demo}"
APP_USER="${APP_USER:-plannerdemo}"
REPO_URL="${REPO_URL:-https://github.com/SolexVK/wb-headless.git}"
BRANCH="${BRANCH:-claude/production-plan-twv8ki}"
PORT="${PORT:-9101}"
HOST="${HOST:-127.0.0.1}"
SRC_DB="${SRC_DB:-/opt/planner/planner/data/planner.db}"
SERVICE=planner-demo
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

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Создаю системного пользователя $APP_USER"
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------- код ----------
if [ -d "$APP_DIR/.git" ]; then
  log "Обновляю код демо-стенда (ветка $BRANCH)"
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  log "Клонирую $REPO_URL → $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$DATA_DIR/samples"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------- .env ----------
ENV_FILE="$DATA_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  GUEST_CODE="$(rand 24)"
  log "Создаю $ENV_FILE"
  {
    echo "# демо-стенд planner, создан 41-deploy-planner-demo.sh $(date +%F)"
    echo "PLANNER_HOST=$HOST"
    echo "PLANNER_PORT=$PORT"
    echo "PLANNER_INSTANCE_LABEL=ДЕМО"
    echo "GUEST_LINK_CODE=$GUEST_CODE"
    echo "SESSION_SECRET=$(rand 48)"
    echo "# Токен бота нужен только чтобы владельцу приходили уведомления о заходах."
    echo "TELEGRAM_BOT_TOKEN="
    echo "TELEGRAM_BOT_USERNAME="
    echo "OWNER_TELEGRAM_ID="
    echo "# Токенов MPStats и WB здесь НЕТ и быть не должно: демо не ходит во внешние API."
  } > "$ENV_FILE"
  warn "Гостевая ссылка: https://demo.aidemiko.ru/guest?c=$GUEST_CODE"
  warn "Впиши TELEGRAM_BOT_TOKEN/USERNAME и OWNER_TELEGRAM_ID в $ENV_FILE — иначе уведомлений о гостях не будет"
else
  log ".env демо-стенда уже есть — не трогаю"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

# ---------- зависимости ----------
log "npm install в $PLANNER_DIR"
as_app env HOME="/var/lib/$APP_USER" npm --prefix "$PLANNER_DIR" install \
  --omit=dev --ignore-scripts --no-audit --no-fund

# ---------- база ----------
DEMO_DB="$DATA_DIR/planner.db"
if [ -f "$DEMO_DB" ] && [ "${REFRESH_DB:-0}" != "1" ]; then
  log "Демо-база уже есть — оставляю (пересобрать: sudo REFRESH_DB=1 bash $0)"
else
  [ -f "$SRC_DB" ] || die "Нет боевой базы $SRC_DB"
  log "Снимаю копию боевой базы (VACUUM INTO — корректно забирает и WAL-журнал)"
  systemctl stop "$SERVICE" 2>/dev/null || true
  rm -f "$DEMO_DB" "$DEMO_DB-wal" "$DEMO_DB-shm"
  # Снимок делает владелец боевой базы (planner) — иначе пришлось бы менять её права.
  # Но писать в каталог демо-стенда он не может, поэтому кладём во временный каталог,
  # а уже root переносит файл на место и отдаёт пользователю демо.
  SRC_OWNER="$(stat -c %U "$SRC_DB")"
  TMP_SNAP="$(mktemp -d /tmp/planner-demo-snap.XXXXXX)"
  chown "$SRC_OWNER:$SRC_OWNER" "$TMP_SNAP"; chmod 700 "$TMP_SNAP"
  trap 'rm -rf "$TMP_SNAP"' EXIT
  runuser -u "$SRC_OWNER" -- node --experimental-sqlite -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.prepare('VACUUM INTO ?').run(process.argv[2]);
    db.close();
  " "$SRC_DB" "$TMP_SNAP/snapshot.db" || die "Не удалось снять копию базы"
  mv "$TMP_SNAP/snapshot.db" "$DEMO_DB"
  rm -rf "$TMP_SNAP"; trap - EXIT
  chown "$APP_USER:$APP_USER" "$DEMO_DB"

  log "Обезличиваю копию (артикулы, поставщики, цены, токены, пользователи)"
  # Если обезличивание не прошло — копию с настоящими данными УДАЛЯЕМ. Иначе следующий
  # запуск скрипта примет её за готовую демо-базу и опубликует боевые данные наружу.
  if ! as_app env HOME="/var/lib/$APP_USER" node --experimental-sqlite \
      "$PLANNER_DIR/tools/anonymize-db.mjs" "$DEMO_DB"; then
    rm -f "$DEMO_DB" "$DEMO_DB-wal" "$DEMO_DB-shm"
    die "Обезличивание не прошло — копию удалил, демо-стенд НЕ публикуем"
  fi
fi

# ---------- systemd ----------
log "Ставлю юнит /etc/systemd/system/$SERVICE.service"
sed -e "s|{{APP_DIR}}|$APP_DIR|g" -e "s|{{APP_USER}}|$APP_USER|g" -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
    -e "s|{{SERVICE}}|$SERVICE|g" -e "s|{{DESC}}|planner ДЕМО (обезличенная копия)|g" \
  "$HERE/planner.service" > "/etc/systemd/system/$SERVICE.service"
chmod 644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

log "Проверяю"
code=""
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/api/health" || true)"
  case "$code" in 200|401|302) break ;; esac
  sleep 1
done
[ -n "$code" ] && [ "$code" != "000" ] || { systemctl --no-pager --lines=30 status "$SERVICE" || true; die "Демо-стенд не ответил"; }
log "Демо-стенд поднят: http://127.0.0.1:$PORT (ответ /api/health: $code)"
log "Опубликовать: sudo bash $HERE/add-site.sh demo.aidemiko.ru $PORT"
log "Гостевая ссылка — строка GUEST_LINK_CODE в $ENV_FILE"
