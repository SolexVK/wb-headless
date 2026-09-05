#!/usr/bin/env bash
# add-route.sh — добавить новый сервис в общий Caddy, не сломав соседние.
#
#   sudo bash deploy/vps/add-route.sh /mytool 9100          # префикс срезается (сервис живёт на /)
#   sudo bash deploy/vps/add-route.sh /mytool 9100 --keep   # префикс сохраняется (сервис знает про /mytool)
#
# Блок вставляется ВЫШЕ маркера "END ROUTES", т.е. раньше общего handle.
# Конфиг валидируется; если валидация упала — откат к бэкапу, Caddy не трогаем.
set -euo pipefail

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
PREFIX="${1:-}"
PORT="${2:-}"
MODE="${3:-strip}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0 /path 9100"
[ -n "$PREFIX" ] && [ -n "$PORT" ] || die "Использование: $0 /mytool 9100 [--keep]"
[ -f "$CADDYFILE" ] || die "Нет $CADDYFILE — сначала deploy/vps/20-install-caddy.sh"
case "$PREFIX" in /*) : ;; *) die "Путь должен начинаться со слэша: /mytool" ;; esac
case "$PORT" in ''|*[!0-9]*) die "Порт должен быть числом" ;; esac
grep -q 'END ROUTES' "$CADDYFILE" || die "В $CADDYFILE нет маркера 'END ROUTES' — добавь маршрут вручную"

if grep -qE "^[[:space:]]*(handle|handle_path)[[:space:]]+${PREFIX}(/\*)?[[:space:]]*\{" "$CADDYFILE"; then
  die "Маршрут $PREFIX уже есть в $CADDYFILE — правь его вручную"
fi
if ss -lntp 2>/dev/null | grep -qE "127\.0\.0\.1:${PORT}\b|0\.0\.0\.0:${PORT}\b|\*:${PORT}\b"; then
  log "Порт $PORT сейчас слушается — ок, если это как раз твой сервис"
fi

if [ "$MODE" = "--keep" ]; then
  DIRECTIVE="handle ${PREFIX}/*"
  NOTE="префикс ${PREFIX} передаётся сервису как есть"
else
  DIRECTIVE="handle_path ${PREFIX}/*"
  NOTE="префикс ${PREFIX} срезается, сервис получает путь от /"
fi

BACKUP="${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$CADDYFILE" "$BACKUP"
log "Бэкап: $BACKUP"

BLOCK_FILE="$(mktemp)"
trap 'rm -f "$BLOCK_FILE"' EXIT
cat > "$BLOCK_FILE" <<EOF
	# $PREFIX → 127.0.0.1:$PORT ($NOTE), добавлено $(date +%Y-%m-%d)
	redir $PREFIX $PREFIX/
	$DIRECTIVE {
		reverse_proxy 127.0.0.1:$PORT
	}

EOF

awk -v blockfile="$BLOCK_FILE" '
  /END ROUTES/ && !done { while ((getline line < blockfile) > 0) print line; done = 1 }
  { print }
' "$CADDYFILE" > "${CADDYFILE}.new"
mv "${CADDYFILE}.new" "$CADDYFILE"
chown root:caddy "$CADDYFILE" 2>/dev/null || true
chmod 640 "$CADDYFILE"

log "Проверяю конфиг"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  cp -a "$BACKUP" "$CADDYFILE"
  die "Конфиг невалиден — откатил на $BACKUP, Caddy не перезагружался"
fi

log "Применяю без даунтайма"
systemctl reload caddy
log "Готово: $PREFIX → 127.0.0.1:$PORT ($NOTE)"
