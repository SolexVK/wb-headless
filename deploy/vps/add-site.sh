#!/usr/bin/env bash
# add-site.sh — опубликовать сервис на ОТДЕЛЬНОМ имени (поддомене), а не по пути.
#
#   sudo bash deploy/vps/add-site.sh planner.aidemiko.ru 9100
#
# Когда что использовать:
#   add-route.sh /mytool 9100   — сервис живёт по пути на общем домене (умеет работать под префиксом);
#   add-site.sh  sub.dom.ru 9100 — сервису нужен корень сайта (абсолютные пути /api/…, /admin, cookie).
#
# Блок сайта дописывается в конец /etc/caddy/Caddyfile, конфиг валидируется,
# при ошибке — откат к бэкапу. Сертификат Let's Encrypt Caddy выпишет сам,
# как только имя резолвится в наш IP.
set -euo pipefail

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SITE="${1:-}"
PORT="${2:-}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0 sub.example.com 9100"
[ -n "$SITE" ] && [ -n "$PORT" ] || die "Использование: $0 sub.example.com 9100"
[ -f "$CADDYFILE" ] || die "Нет $CADDYFILE — сначала deploy/vps/20-install-caddy.sh"
case "$SITE" in
  *[!a-zA-Z0-9.-]*|-*|.*|*.) die "Имя сайта выглядит неправильно: $SITE" ;;
  *.*) : ;;
  *) die "Нужно полное имя с доменом, например planner.aidemiko.ru" ;;
esac
case "$PORT" in ''|*[!0-9]*) die "Порт должен быть числом" ;; esac

if grep -qE "(^|[[:space:],])${SITE//./\\.}([[:space:],]|\{)" "$CADDYFILE"; then
  die "Имя $SITE уже упоминается в $CADDYFILE — правь блок вручную"
fi

# DNS: без совпадения A-записи Let's Encrypt сертификат не выдаст.
myip4="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
dnsip="$(getent ahostsv4 "$SITE" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -z "$dnsip" ]; then
  warn "DNS: $SITE пока не резолвится. Блок добавлю, Caddy будет повторять выпуск сертификата."
elif [ -n "$myip4" ] && [ "$myip4" != "$dnsip" ]; then
  warn "DNS: $SITE → $dnsip, а внешний IP сервера $myip4. Сертификат не выпишется, пока A-запись не совпадёт."
else
  log "DNS в порядке: $SITE → $dnsip"
fi

if ! ss -lntp 2>/dev/null | grep -qE "127\.0\.0\.1:${PORT}\b|0\.0\.0\.0:${PORT}\b|\*:${PORT}\b"; then
  warn "Порт $PORT никто не слушает — сначала подними сервис, иначе будет 502"
fi

BACKUP="${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$CADDYFILE" "$BACKUP"
log "Бэкап: $BACKUP"

cat >> "$CADDYFILE" <<EOF

# $SITE → 127.0.0.1:$PORT (отдельный сайт, сервис получает пути от корня), добавлено $(date +%Y-%m-%d)
$SITE {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
chown root:caddy "$CADDYFILE" 2>/dev/null || true
chmod 640 "$CADDYFILE"

log "Проверяю конфиг"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  cp -a "$BACKUP" "$CADDYFILE"
  die "Конфиг невалиден — откатил на $BACKUP, Caddy не перезагружался"
fi

log "Применяю без даунтайма"
systemctl reload caddy
log "Готово: https://$SITE → 127.0.0.1:$PORT"
log "Сертификат выписывается 10–60 секунд: journalctl -u caddy -n 30 --no-pager"
