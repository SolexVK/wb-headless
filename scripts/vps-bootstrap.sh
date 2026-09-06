#!/usr/bin/env bash
# vps-bootstrap.sh — одноразовая подготовка VPS (Debian 12/13) под Сириуса:
# Claude Code (подписка Max), Bun (для channel-плагинов), ffmpeg (голос), jq, tmux, python venv.
#
# Запуск от обычного пользователя с sudo (напр. deploy):
#   bash scripts/vps-bootstrap.sh
# Скрипт идемпотентен — повторный запуск ничего не ломает.

set -euo pipefail

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  warn "Запускай от обычного пользователя (deploy), не от root: Claude Code и Bun ставятся в \$HOME."
  exit 1
fi

# --- 1. Системные пакеты ------------------------------------------------------
log "Системные пакеты (apt): ffmpeg, jq, tmux, git, python3-venv, unzip, curl"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ffmpeg jq tmux git curl unzip ca-certificates python3 python3-venv python3-pip >/dev/null
ok "apt готово"

# --- 2. PATH для ~/.local/bin и ~/.bun/bin -----------------------------------
ensure_path_line() {
  local line="$1"
  grep -qxF "$line" "$HOME/.bashrc" 2>/dev/null || echo "$line" >> "$HOME/.bashrc"
}
ensure_path_line 'export PATH="$HOME/.local/bin:$PATH"'
ensure_path_line 'export BUN_INSTALL="$HOME/.bun"'
ensure_path_line 'export PATH="$BUN_INSTALL/bin:$PATH"'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# --- 3. Bun (нужен официальным channel-плагинам: Telegram и т.п.) -------------
log "Bun"
if command -v bun >/dev/null 2>&1; then
  ok "уже установлен: $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash >/dev/null
  ok "установлен: $(bun --version)"
fi

# --- 4. Claude Code (нативный установщик, логин подпиской) --------------------
log "Claude Code"
if command -v claude >/dev/null 2>&1; then
  ok "уже установлен: $(claude --version 2>/dev/null | head -1)"
else
  curl -fsSL https://claude.ai/install.sh | bash
  ok "установлен: $(claude --version 2>/dev/null | head -1)"
fi

# --- 5. git: доверять /opt/wb-headless, даже если владелец другой -------------
log "git safe.directory"
for d in /opt/wb-headless /opt/sirius /opt/sirius/wb-headless; do
  if [ -d "$d" ]; then
    git config --global --add safe.directory "$d" 2>/dev/null || true
    ok "$d"
  fi
done

# --- 6. Дом Сириуса -----------------------------------------------------------
# /opt/sirius            — проект Сириуса (CLAUDE.md, .claude/, voice/), отдельный git-репозиторий
# /opt/sirius/memory     — данные памяти (вне git, бэкапы таймером)
# /opt/sirius/wb-headless — рабочая копия wb-headless (в git Сириуса игнорируется)
# /opt/wb-headless       — боевой сервис (пользователь wbheadless), обновляется ТОЛЬКО deploy/vps/30-deploy-service.sh
log "Дом Сириуса /opt/sirius (память, голос, логи)"
if [ ! -d /opt/sirius ]; then
  sudo mkdir -p /opt/sirius
  sudo chown "$(id -u):$(id -g)" /opt/sirius
fi
mkdir -p /opt/sirius/{memory,voice,logs}
ok "/opt/sirius/{memory,voice,logs}"

# --- 7. Итог ------------------------------------------------------------------
log "Проверка"
ver() { case "$1" in ffmpeg) ffmpeg -version 2>&1 | head -1 ;; tmux) tmux -V ;; *) "$1" --version 2>&1 | head -1 ;; esac; }
for c in node bun claude ffmpeg jq tmux git python3; do
  printf '    %-8s ' "$c"; command -v "$c" >/dev/null 2>&1 && ver "$c" || echo "НЕТ"
done

cat <<'NEXT'

Дальше — руками, один раз (после этого ручной ввод заканчивается):
  1) source ~/.bashrc
  2) tmux new -s sirius            # постоянная сессия
  3) cd /opt/sirius && claude                # дом Сириуса; войти подпиской: /login
  4) внутри Claude Code:
       /plugin marketplace add anthropics/claude-plugins-official
       /plugin install telegram@claude-plugins-official     # scope: user
       /telegram:configure <токен от BotFather>
  5) выйти и перезапустить с каналом и удалённым управлением:
       claude --remote-control "sirius" --channels plugin:telegram@claude-plugins-official
     написать боту в Telegram → получить код → /telegram:access pair <код>
     → /telegram:access policy allowlist
  6) отсоединиться от tmux: Ctrl+B, затем D. Сессия живёт дальше.
NEXT
