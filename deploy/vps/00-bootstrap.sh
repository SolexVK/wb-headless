#!/usr/bin/env bash
# 00-bootstrap.sh — базовая настройка чистого VPS (netcup) под наши сервисы.
# Debian 12/13 и Ubuntu 22.04/24.04. Запускать от root на СВЕЖЕМ сервере.
#
#   ssh root@<ip>
#   apt-get update && apt-get install -y git
#   git clone <repo> /opt/wb-headless && cd /opt/wb-headless
#   DEPLOY_USER=deploy TZ_NAME=Europe/Moscow bash deploy/vps/00-bootstrap.sh
#
# Идемпотентен: повторный запуск ничего не ломает.
#
# Переменные:
#   DEPLOY_USER          — какой sudo-пользователь создать (по умолчанию deploy)
#   TZ_NAME              — часовой пояс (Europe/Moscow)
#   SWAP_GB              — размер swap-файла, 0 = не создавать (по умолчанию 2)
#   SKIP_SSH_HARDENING=1 — не трогать sshd (если ещё не залили ssh-ключ)
#   SKIP_FIREWALL=1      — не включать ufw
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
TZ_NAME="${TZ_NAME:-Europe/Moscow}"
SWAP_GB="${SWAP_GB:-2}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"
[ -r /etc/os-release ] || die "Нет /etc/os-release — ОС не поддерживается"
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) : ;;
  *) die "Скрипт рассчитан на Debian/Ubuntu, а тут: ${PRETTY_NAME:-$ID}" ;;
esac
log "ОС: ${PRETTY_NAME:-$ID}"

export DEBIAN_FRONTEND=noninteractive

log "Обновляю пакеты"
apt-get update -y
apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade

log "Ставлю базовый набор"
apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg git rsync jq unzip sudo \
  ufw fail2ban unattended-upgrades chrony htop tmux vim

log "Часовой пояс: $TZ_NAME"
timedatectl set-timezone "$TZ_NAME" || warn "не смог выставить таймзону"
systemctl enable --now chrony 2>/dev/null || systemctl enable --now chronyd 2>/dev/null || true

log "Автоматические security-обновления"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades 2>/dev/null || true

# ---------- пользователь для деплоя ----------
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  log "Пользователь $DEPLOY_USER уже есть"
else
  log "Создаю пользователя $DEPLOY_USER"
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG sudo "$DEPLOY_USER" 2>/dev/null || usermod -aG wheel "$DEPLOY_USER" 2>/dev/null || true

# Пароля у пользователя нет (вход только по ключу), а sudo в Debian по умолчанию
# требует пароль — без этого правила deploy не смог бы ничего администрировать.
# Права даёт ssh-ключ, как в облачных образах Debian/Ubuntu.
SUDOERS="/etc/sudoers.d/90-$DEPLOY_USER"
if [ ! -f "$SUDOERS" ]; then
  log "Разрешаю $DEPLOY_USER sudo без пароля (вход и так только по ключу)"
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" > "$SUDOERS"
  chmod 440 "$SUDOERS"
  if ! visudo -c -q -f "$SUDOERS"; then
    warn "sudoers-файл не прошёл проверку — удаляю, sudo будет требовать пароль"
    rm -f "$SUDOERS"
  fi
fi

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
if [ -s /root/.ssh/authorized_keys ] && [ ! -s "$DEPLOY_HOME/.ssh/authorized_keys" ]; then
  log "Копирую ssh-ключи root → $DEPLOY_USER"
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    /root/.ssh/authorized_keys "$DEPLOY_HOME/.ssh/authorized_keys"
fi

# ---------- sshd ----------
if [ "${SKIP_SSH_HARDENING:-0}" = "1" ]; then
  warn "SSH-хардненинг пропущен (SKIP_SSH_HARDENING=1)"
elif [ ! -s "$DEPLOY_HOME/.ssh/authorized_keys" ]; then
  warn "У $DEPLOY_USER нет authorized_keys — НЕ выключаю вход по паролю, иначе запрёшь себя снаружи."
  warn "Залей ключ:  ssh-copy-id $DEPLOY_USER@<ip>   и перезапусти скрипт."
else
  log "Закрываю ssh: без root-логина и без паролей"
  install -d -m 755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
# ставится deploy/vps/00-bootstrap.sh — правь здесь, не в sshd_config
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
EOF
  # на старых образах include может отсутствовать
  grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config \
    || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    warn "Проверь ВТОРОЙ сессией, что вход по ключу работает, прежде чем закрывать текущую!"
  else
    warn "sshd -t ругается — конфиг не применён, откатываю"
    rm -f /etc/ssh/sshd_config.d/99-hardening.conf
  fi
fi

log "fail2ban на sshd"
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

# ---------- firewall ----------
if [ "${SKIP_FIREWALL:-0}" = "1" ]; then
  warn "ufw пропущен (SKIP_FIREWALL=1)"
else
  log "Firewall: наружу только 22/80/443"
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw allow 80/tcp   comment 'http (caddy, ACME)'
  ufw allow 443/tcp  comment 'https (caddy)'
  ufw --force enable
  ufw status verbose
fi

# ---------- swap ----------
if [ "$SWAP_GB" != "0" ] && ! swapon --show | grep -q .; then
  log "Создаю swap ${SWAP_GB}G (chromium любит память)"
  fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB*1024))
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.d/99-swappiness.conf 2>/dev/null \
    || echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi

log "Готово. Дальше:"
cat <<EOF
  1) deploy/vps/10-install-node.sh    — Node.js LTS
  2) deploy/vps/20-install-caddy.sh   — Caddy + авто-TLS на твой домен
  3) deploy/vps/30-deploy-service.sh  — wb-headless как systemd-сервис
EOF
