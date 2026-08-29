#!/bin/bash
# scripts/mac-mini-install.sh — установка сторожа удержаний на Mac Mini.
#
# Что делает (идемпотентно, можно запускать повторно):
#   1) проверяет node и зависимости;
#   2) создаёт .env из шаблона, если его нет, и ставит права 600;
#   3) ставит LaunchAgent com.wbheadless.finewatch на 07:00 и 18:00;
#   4) печатает следующие шаги.
#
# Чего НЕ делает: не трогает чужие launchd, не занимает порты, не касается
# Caddy и Tailscale Funnel — сторожу сеть наружу не нужна (см. MACMINI-DEPLOY.md).
set -uo pipefail

LABEL="com.wbheadless.finewatch"
HOUR_MORNING="${WATCH_HOUR_MORNING:-7}"
HOUR_EVENING="${WATCH_HOUR_EVENING:-18}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"

say()  { printf '%s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }
okay() { printf '  ✅ %s\n' "$*"; }
nope() { printf '  ❌ %s\n' "$*"; }
note() { printf '  ⚠️  %s\n' "$*"; }

head2 "1. Проверка окружения"
say "  Репозиторий: $ROOT"
[ "$(uname -s)" = "Darwin" ] || note "это не macOS — LaunchAgent не поставится, остальное сработает"

NODE=""
for c in "${NODE_BIN:-}" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && { NODE="$c"; break; }
done
if [ -z "$NODE" ]; then
  nope "node не найден. Поставьте: brew install node — затем запустите скрипт снова."
  exit 1
fi
okay "node: $NODE ($("$NODE" -v))"

if [ ! -d "$ROOT/node_modules" ]; then
  say "  Ставлю зависимости (npm ci)…"
  (cd "$ROOT" && npm ci --omit=dev >/dev/null 2>&1) && okay "зависимости установлены" || note "npm ci не прошёл — сторож работает и без них, но PDF собираться не будет"
else
  okay "зависимости на месте"
fi

head2 "2. Файл секретов .env"
if [ -f "$ROOT/.env" ]; then
  okay ".env уже есть — не трогаю"
else
  cat > "$ROOT/.env" <<'ENVEOF'
Wildberries_API=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT=
ENVEOF
  okay ".env создан (пустой)"
fi
chmod 600 "$ROOT/.env"
okay "права 600 — файл читает только владелец"
grep -qx '.env' "$ROOT/.gitignore" 2>/dev/null && okay ".env в .gitignore — в репозиторий не попадёт" \
  || nope ".env НЕ в .gitignore — добавьте строку .env, иначе секреты уедут в git"

MISSING=""
for k in Wildberries_API TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_CHAT; do
  grep -qE "^$k=.+" "$ROOT/.env" 2>/dev/null || MISSING="$MISSING $k"
done
if [ -n "$MISSING" ]; then
  note "не заполнены:$MISSING"
  say "     Откройте файл и впишите значения:  nano $ROOT/.env"
  say "     Значения нигде не печатаются и в git не попадают."
fi

head2 "3. Расписание (LaunchAgent $LABEL)"
if [ "$(uname -s)" = "Darwin" ]; then
  mkdir -p "$AGENTS" "$ROOT/logs"
  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__HOUR_MORNING__|$HOUR_MORNING|g" \
      -e "s|__HOUR_EVENING__|$HOUR_EVENING|g" \
      "$ROOT/deploy/com.wbheadless.finewatch.plist.template" > "$PLIST"
  chmod 644 "$PLIST"
  okay "plist записан: $PLIST"

  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null
  if launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
    okay "агент загружен (bootstrap)"
  elif launchctl load -w "$PLIST" 2>/dev/null; then
    okay "агент загружен (load -w)"
  else
    nope "не удалось загрузить агент — проверьте: launchctl error"
  fi
  launchctl list | grep -q "$LABEL" && okay "агент виден в launchctl list" || note "агента нет в списке — перезайдите в систему и повторите"
  say "  Время запусков: ${HOUR_MORNING}:00 и ${HOUR_EVENING}:00 по времени машины ($(date '+%Z, сейчас %H:%M'))"
  [ "$(date '+%Z')" = "MSK" ] || note "часовой пояс машины не МСК — при необходимости задайте WATCH_HOUR_MORNING/WATCH_HOUR_EVENING и запустите скрипт снова"
else
  note "не macOS — шаг пропущен"
fi

head2 "4. Что дальше"
say "  1) Впишите секреты:            nano $ROOT/.env"
say "  2) Проверьте настройку:        cd $ROOT && node scripts/wb-watch-selftest.mjs"
say "  3) Тестовое сообщение в чат:   node scripts/wb-watch-selftest.mjs --send"
say "  4) Прогон без отправки:        node agent-wb-watch.mjs --dry-run"
say "  5) Боевой прогон вручную:      ./scripts/run-watch.sh"
say ""
say "  Логи:        tail -f $ROOT/logs/wb-watch.log"
say "  Выключить:   launchctl bootout gui/\$UID/$LABEL"
say "  Включить:    launchctl bootstrap gui/\$UID $PLIST"
