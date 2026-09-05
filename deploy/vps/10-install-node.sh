#!/usr/bin/env bash
# 10-install-node.sh — Node.js LTS из репозитория NodeSource (Debian/Ubuntu).
# Запускать от root. Идемпотентен.
#   NODE_MAJOR=22 bash deploy/vps/10-install-node.sh
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-22}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"
export DEBIAN_FRONTEND=noninteractive

if command -v node >/dev/null 2>&1; then
  have="$(node -v)"                 # например v22.11.0
  have_major="${have#v}"; have_major="${have_major%%.*}"
  if [ "${have_major:-0}" -ge "$NODE_MAJOR" ]; then
    log "Node уже стоит: $have — пропускаю установку"
    node -v; npm -v
    exit 0
  fi
  log "Стоит $have, ставлю ${NODE_MAJOR}.x поверх"
fi

log "Подключаю репозиторий NodeSource node_${NODE_MAJOR}.x"
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg
install -d -m 755 /usr/share/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
chmod 644 /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

log "Ставлю nodejs"
apt-get update -y
apt-get install -y nodejs

node -v
npm -v
log "Node готов"
