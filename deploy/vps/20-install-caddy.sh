#!/usr/bin/env bash
# 20-install-caddy.sh — Caddy (обратный прокси + авто-TLS Let's Encrypt) из офиц. репозитория.
# Запускать от root ПОСЛЕ того, как A/AAAA-запись домена смотрит на IP этого сервера.
#
#   bash deploy/vps/20-install-caddy.sh tools.example.com you@example.com
#   (то же через переменные: DOMAIN=... ACME_EMAIL=... bash deploy/vps/20-install-caddy.sh)
#
# Идемпотентен: если /etc/caddy/Caddyfile уже наш и домен тот же — только валидация+reload.
set -euo pipefail

# Домен и почту можно передать позиционно (удобнее и не требует заглавных букв):
#   bash 20-install-caddy.sh tools.example.com you@example.com
DOMAIN="${1:-${DOMAIN:-}}"
ACME_EMAIL="${2:-${ACME_EMAIL:-}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"
[ -n "$DOMAIN" ] || die "Укажи домен первым аргументом: bash $0 tools.example.com you@example.com"
[ -n "$ACME_EMAIL" ] || die "Укажи почту для Let's Encrypt вторым аргументом: bash $0 $DOMAIN you@example.com"
export DEBIAN_FRONTEND=noninteractive

if ! command -v caddy >/dev/null 2>&1; then
  log "Подключаю репозиторий Caddy"
  apt-get update -y
  apt-get install -y --no-install-recommends ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  log "Caddy уже установлен: $(caddy version)"
fi

# Юнит Caddy из пакета идёт с ProtectSystem=full и разрешает запись только в
# /var/lib/caddy — каталог логов ему недоступен даже с верным владельцем.
# LogsDirectory= заставляет systemd создать /var/log/caddy и открыть его на запись.
install -d -m 755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/10-logs.conf <<'EOF'
# ставится deploy/vps/20-install-caddy.sh — доступ Caddy к /var/log/caddy
[Service]
LogsDirectory=caddy
LogsDirectoryMode=0750
EOF
systemctl daemon-reload
install -d -m 750 -o caddy -g caddy /var/log/caddy

# ---------- проверка DNS: без неё Let's Encrypt всё равно не выдаст сертификат ----------
myip4="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
dnsip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -n "$myip4" ] && [ -n "$dnsip" ] && [ "$myip4" != "$dnsip" ]; then
  warn "DNS: $DOMAIN → $dnsip, а внешний IP сервера $myip4. TLS-сертификат не выпишется, пока A-запись не совпадёт."
elif [ -z "$dnsip" ]; then
  warn "DNS: $DOMAIN пока не резолвится. Caddy будет ретраить выпуск сертификата."
fi

CADDYFILE=/etc/caddy/Caddyfile
if [ -f "$CADDYFILE" ] && ! grep -q 'BEGIN ROUTES' "$CADDYFILE"; then
  cp -a "$CADDYFILE" "${CADDYFILE}.orig.$(date +%Y%m%d%H%M%S)"
  log "Старый Caddyfile сохранён рядом (.orig.*)"
fi

if [ -f "$CADDYFILE" ] && grep -q 'BEGIN ROUTES' "$CADDYFILE"; then
  log "Наш Caddyfile уже на месте — не перезаписываю (маршруты сохраняются)"
  grep -qF "$DOMAIN" "$CADDYFILE" || warn "В Caddyfile другой домен — поправь вручную и сделай reload"
else
  log "Ставлю Caddyfile для $DOMAIN"
  sed -e "s|{{DOMAIN}}|$DOMAIN|g" -e "s|{{EMAIL}}|$ACME_EMAIL|g" \
    "$HERE/Caddyfile.template" > "$CADDYFILE"
  chown root:caddy "$CADDYFILE"; chmod 640 "$CADDYFILE"
fi

log "Проверяю конфиг"
caddy validate --config "$CADDYFILE" --adapter caddyfile

systemctl enable caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 2
if ! systemctl is-active --quiet caddy; then
  systemctl --no-pager --lines=20 status caddy || true
  die "Caddy не запустился — смотри journalctl -u caddy -n 50"
fi

log "Caddy поднят. Публичный вход: https://$DOMAIN/  (маршрут /wb → 127.0.0.1:8080)"
echo "Новый сервис добавляй так:  bash deploy/vps/add-route.sh /mytool 9100"
