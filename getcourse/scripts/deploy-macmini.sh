#!/usr/bin/env bash
# Deploy the GetCourse Downloader on a Mac Mini into an ISOLATED environment,
# without disturbing other projects. It:
#   1. ensures Homebrew, ffmpeg, tailscale
#   2. installs nvm and a project-local Node (LTS) — system Node is untouched
#   3. "enters" that environment (nvm use) and installs dependencies + Chromium
#   4. prepares .env (admin login) and the download spool folder
#
# Run it from the getcourse/ directory:  bash scripts/deploy-macmini.sh
# Re-runnable (idempotent). Makes no changes to other services or ports.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-lts/*}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
echo "[*] Проект: $PROJECT_DIR"

# --- 1. Homebrew ---
if ! command -v brew >/dev/null; then
  echo "[*] Homebrew не найден. Устанавливаю..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # add brew to PATH for this shell (Apple Silicon vs Intel)
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
fi
echo "[*] brew: $(brew --version | head -1)"

# --- 2. ffmpeg + tailscale (only if the command is missing) ---
# Checked by command presence, NOT `brew list`: Tailscale may already be present
# as the standalone/GUI app — we must not install a duplicate brew CLI over it.
if ! command -v ffmpeg >/dev/null; then echo "[*] brew install ffmpeg"; brew install ffmpeg; fi
if ! command -v tailscale >/dev/null; then
  echo "[*] tailscale не найден — установите приложение Tailscale или 'brew install tailscale'";
else
  echo "[*] tailscale уже установлен: $(tailscale version | head -1)"
fi
echo "[*] ffmpeg: $(ffmpeg -version | head -1)"

# --- 3. nvm + isolated Node ---
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "[*] Устанавливаю nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"

echo "[*] Устанавливаю и активирую изолированный Node ($NODE_VERSION)..."
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
# pin the version for this project so `nvm use` here always picks it
node -v > "$PROJECT_DIR/.nvmrc"
echo "[*] Node (изолированный): $(node -v)  npm: $(npm -v)"
echo "[*] .nvmrc зафиксирован: $(cat "$PROJECT_DIR/.nvmrc")"

# --- 4. dependencies (+ Chromium for Playwright) ---
# Slow/flaky links time out mid-install; use generous timeouts + retries and
# fetch the (large) Chromium separately so a hiccup there doesn't fail npm.
echo "[*] Устанавливаю зависимости проекта..."
npm config set fetch-timeout 600000 >/dev/null 2>&1 || true
npm config set fetch-retries 8 >/dev/null 2>&1 || true
for i in 1 2 3; do npm install --ignore-scripts --no-audit --no-fund && break; echo "  npm повтор $i..."; sleep 5; done
echo "[*] Устанавливаю Chromium для Playwright (может занять время на медленной сети)..."
for i in 1 2 3 4 5; do npx playwright install chromium && break; echo "  Chromium повтор $i..."; sleep 5; done

# --- 5. .env + spool ---
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[*] Создан .env из примера — ОТРЕДАКТИРУЙТЕ GCUI_ADMIN_PASS и лимиты."
fi
mkdir -p "${GCUI_SPOOL_ROOT:-$PROJECT_DIR/web/spool}"

cat <<EOF

────────────────────────────────────────────────────────
Окружение готово (изолированный Node через nvm).
Каждый раз перед запуском входите в окружение:

    cd "$PROJECT_DIR"
    export NVM_DIR="\$HOME/.nvm" && . "\$NVM_DIR/nvm.sh"
    nvm use            # активирует Node из .nvmrc

Запуск веб-интерфейса:
    npm run web        # http://127.0.0.1:7837

Внешний публичный доступ (Funnel) для клиентов:
    PUBLIC=1 ./scripts/tailscale-serve.sh

Автозапуск (LaunchAgent): см. README, раздел «Автозапуск».
────────────────────────────────────────────────────────
EOF
