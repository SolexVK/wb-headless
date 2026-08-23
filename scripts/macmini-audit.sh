#!/usr/bin/env bash
# scripts/macmini-audit.sh — полная опись общего Mac Mini ПЕРЕД любыми изменениями.
#
# Что описывает: git-репозитории, launchd-службы, brew services, слушающие порты
# и владеющие ими процессы, Caddy и его маршруты, Tailscale Funnel, cron,
# контейнеры, глобальные пакеты, автозапуск. В конце — сверка живых портов
# с реестром из MACMINI-DEPLOY.md и список расхождений.
#
# ── БЕЗОПАСНОСТЬ ──────────────────────────────────────────────────────────────
# СТРОГО ТОЛЬКО ЧТЕНИЕ. Ничего не ставит, не запускает, не останавливает,
# не выгружает launchd, не трогает Caddy и Tailscale (`caddy validate` только
# читает конфиг). sudo не нужен и не запрашивается.
#
# СЕКРЕТЫ НЕ ПЕЧАТАЮТСЯ. Из plist выводятся только имена переменных окружения
# без значений; из .env-файлов — только имена ключей. Отчёт можно пересылать.
#
# Запуск:  bash scripts/macmini-audit.sh
# Отчёт:   на экран и в ~/macmini-audit.txt

set -uo pipefail
OUT="$HOME/macmini-audit.txt"
exec > >(tee "$OUT") 2>&1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hr(){ printf '\n\033[1m══ %s\033[0m\n' "$1"; }
sub(){ printf '\n  \033[4m%s\033[0m\n' "$1"; }
have(){ command -v "$1" >/dev/null 2>&1; }

echo "Опись Mac Mini · $(hostname) · $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Пользователь: $(whoami)    Аптайм: $(uptime | sed 's/^ *//')"

# ─────────────────────────────────────────────────────────────────────────────
hr "1. Git-репозитории в домашнем каталоге"
found_repos=()
while IFS= read -r g; do
  d="$(dirname "$g")"
  found_repos+=("$d")
  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  remote=$(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's#(https://)[^@/]+@#\1#')
  dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  last=$(git -C "$d" log -1 --format='%h %ad %s' --date=short 2>/dev/null | cut -c1-72)
  ahead=$(git -C "$d" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo '?')
  printf '\n  %s\n' "${d/#$HOME/~}"
  printf '    remote:      %s\n' "${remote:-—}"
  printf '    ветка:       %s   не закоммичено: %s   не отправлено: %s\n' "${branch:-—}" "$dirty" "$ahead"
  printf '    последний:   %s\n' "${last:-—}"
done < <(find "$HOME" -maxdepth 4 -type d -name .git -not -path '*/node_modules/*' 2>/dev/null | sort)
[ ${#found_repos[@]} -eq 0 ] && echo "  репозиториев не найдено"

sub "Переменные окружения, которые ждут репозитории (только ИМЕНА, без значений)"
for d in "${found_repos[@]:-}"; do
  [ -z "${d:-}" ] && continue
  for f in "$d/.env" "$d/.env.local" "$d/.env.production"; do
    [ -f "$f" ] || continue
    keys=$(grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*' "$f" 2>/dev/null | tr -d ' ' | sort -u | tr '\n' ' ')
    printf '    %-46s %s\n' "${f/#$HOME/~}" "$keys"
  done
done

# ─────────────────────────────────────────────────────────────────────────────
hr "2. launchd — пользовательские службы"
sub "Загруженные (PID / код выхода / label)"
launchctl list 2>/dev/null | awk 'NR==1{printf "    %-8s %-6s %s\n","PID","Exit","Label"; next}
  $3 !~ /^com\.apple\./ && $3 !~ /^application\./ {printf "    %-8s %-6s %s\n",$1,$2,$3}' | head -60

sub "Файлы plist в ~/Library/LaunchAgents"
for p in "$HOME"/Library/LaunchAgents/*.plist; do
  [ -e "$p" ] || { echo "    (нет)"; break; }
  lbl=$(plutil -extract Label raw "$p" 2>/dev/null)
  prog=$(plutil -p "$p" 2>/dev/null | awk -F'"' '/ProgramArguments|"Program"/{f=1} f&&/=> *"/{print $4}' | head -3 | tr '\n' ' ')
  wd=$(plutil -extract WorkingDirectory raw "$p" 2>/dev/null)
  runatload=$(plutil -extract RunAtLoad raw "$p" 2>/dev/null)
  # только ИМЕНА переменных окружения, значения не печатаем
  envkeys=$(plutil -p "$p" 2>/dev/null | sed -n '/EnvironmentVariables/,/^  }/p' \
            | awk -F'"' '/=>/{if($2!="")printf "%s ",$2}')
  printf '\n    %s\n' "$(basename "$p")"
  printf '      label:      %s\n' "${lbl:-—}"
  printf '      запускает:  %s\n' "${prog:-—}"
  printf '      рабочий кт: %s   RunAtLoad: %s\n' "${wd:-—}" "${runatload:-—}"
  printf '      env-ключи:  %s\n' "${envkeys:-—}"
  printf '      права:      %s\n' "$(stat -f '%Sp %Su' "$p" 2>/dev/null)"
done

sub "Отключённые службы (launchctl disable) — трогать нельзя"
launchctl print-disabled "gui/$(id -u)" 2>/dev/null | grep -v '=> false' | head -20 || echo "    (не читается без sudo — пропущено)"

# ─────────────────────────────────────────────────────────────────────────────
hr "3. brew services"
have brew && brew services list 2>/dev/null | sed 's/^/    /' || echo "    brew не установлен"

# ─────────────────────────────────────────────────────────────────────────────
hr "4. Слушающие TCP-порты и их владельцы"
printf '    %-7s %-9s %-22s %-10s %s\n' "ПОРТ" "PID" "ПРОЦЕСС" "ЮЗЕР" "АДРЕС"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{
    n=split($9,a,":"); port=a[n];
    key=port"|"$2;
    if(!(key in seen)){seen[key]=1; printf "    %-7s %-9s %-22s %-10s %s\n", port,$2,substr($1,1,22),substr($3,1,10),$9}
  }' | sort -k2 -n

sub "Пути к бинарникам слушающих процессов"
for pid in $(lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  cmd=$(ps -p "$pid" -o comm= 2>/dev/null)
  [ -n "$cmd" ] && printf '    %-9s %s\n' "$pid" "$cmd"
done | sort -u -k2 | head -30

# ─────────────────────────────────────────────────────────────────────────────
hr "5. Процессы: топ по памяти и по CPU"
sub "Топ-12 по памяти"
ps -Ao pid,ppid,%mem,%cpu,etime,comm -r 2>/dev/null | sort -k3 -nr | head -13 \
  | awk '{printf "    %-8s %-8s %6s%% %6s%% %-12s %s\n",$1,$2,$3,$4,$5,substr($6,1,60)}'
sub "Топ-8 по CPU"
ps -Ao pid,%cpu,%mem,etime,comm -r 2>/dev/null | head -9 \
  | awk 'NR>1{printf "    %-8s %6s%% %6s%% %-12s %s\n",$1,$2,$3,$4,substr($5,1,60)}'
sub "Наши подозреваемые (node / python / caddy / ollama / tailscale / docker)"
ps -Axo pid,%mem,etime,command 2>/dev/null \
  | grep -iE 'node |python[0-9.]* |caddy|ollama|tailscale|docker|orbstack|colima' \
  | grep -v grep | cut -c1-150 | sed 's/^/    /' | head -25

# ─────────────────────────────────────────────────────────────────────────────
hr "6. Caddy — конфигурация и маршруты"
CADDYFILE=""
for c in /opt/homebrew/etc/Caddyfile /usr/local/etc/Caddyfile "$HOME/Caddyfile"; do
  [ -f "$c" ] && { CADDYFILE="$c"; break; }
done
if [ -n "$CADDYFILE" ]; then
  echo "    конфиг: $CADDYFILE  ($(stat -f '%Sm' "$CADDYFILE" 2>/dev/null))"
  have caddy && { echo "    валидация:"; caddy validate --config "$CADDYFILE" 2>&1 | sed 's/^/      /' | head -6; }
  sub "Маршруты (handle / reverse_proxy / :порт)"
  grep -nE '^[^#]*(:[0-9]{2,5}|handle|reverse_proxy|root|respond|file_server)' "$CADDYFILE" \
    | sed 's/^/      /' | head -40
else
  echo "    Caddyfile не найден"
fi
have curl && { sub "Caddy admin API (loopback:2019)"; curl -s -m 3 http://127.0.0.1:2019/config/ >/dev/null 2>&1 \
  && echo "      отвечает — Caddy запущен" || echo "      не отвечает"; }

# ─────────────────────────────────────────────────────────────────────────────
hr "7. Tailscale / Funnel  (только чтение, ничего не меняем)"
TS=""
for t in /Applications/Tailscale.app/Contents/MacOS/Tailscale "$(command -v tailscale 2>/dev/null)"; do
  [ -x "$t" ] && { TS="$t"; break; }
done
if [ -n "$TS" ]; then
  echo "    бинарник: $TS"
  "$TS" status 2>&1 | head -6 | sed 's/^/    /'
  sub "serve / funnel"
  "$TS" serve status 2>&1 | head -25 | sed 's/^/      /'
else
  echo "    tailscale не найден"
fi

# ─────────────────────────────────────────────────────────────────────────────
hr "8. Планировщики и контейнеры"
sub "crontab пользователя"
crontab -l 2>/dev/null | grep -v '^#' | sed 's/^/    /' | head -20 || echo "    пусто"
sub "Docker / OrbStack / Colima"
if have docker && docker ps >/dev/null 2>&1; then
  docker ps --format '    {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}' | head -15
else
  echo "    docker не запущен или не установлен"
fi

# ─────────────────────────────────────────────────────────────────────────────
hr "9. Окружение разработки"
for b in node npm python3 git brew caddy ollama; do
  have "$b" && printf '    %-9s %-42s %s\n' "$b" "$(command -v $b)" "$($b --version 2>&1 | head -1 | cut -c1-30)"
done
sub "Глобальные npm-пакеты"
have npm && npm ls -g --depth=0 2>/dev/null | tail -n +2 | sed 's/^/    /' | head -20
sub "Приложения в /Applications"
ls -1 /Applications 2>/dev/null | sed 's/\.app$//' | tr '\n' ' ' | fold -sw 100 | sed 's/^/    /'

# ─────────────────────────────────────────────────────────────────────────────
hr "10. Сверка живых портов с реестром MACMINI-DEPLOY.md"
DOC="$REPO_ROOT/MACMINI-DEPLOY.md"
if [ -f "$DOC" ]; then
  DOCPORTS=$(grep -oE '^\| *[0-9]{3,5} *\|' "$DOC" | tr -dc '0-9\n' | sort -u)
  LIVEPORTS=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{n=split($9,a,":");print a[n]}' | sort -u)
  echo "    В реестре:  $(echo $DOCPORTS | tr '\n' ' ')"
  sub "Занято, но НЕ в реестре (новое с 2026-08-14 — проверьте, что это)"
  comm -13 <(echo "$DOCPORTS") <(echo "$LIVEPORTS") | while read -r p; do
    [ -z "$p" ] && continue
    who=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2", "$3")"}')
    printf '      %-7s %s\n' "$p" "${who:-?}"
  done
  sub "В реестре, но НЕ слушает (служба лежит?)"
  comm -23 <(echo "$DOCPORTS") <(echo "$LIVEPORTS") | sed 's/^/      /'
else
  echo "    MACMINI-DEPLOY.md не найден рядом со скриптом — сверка пропущена"
fi

# ─────────────────────────────────────────────────────────────────────────────
hr "11. Свободные порты для нового сервиса"
for p in 9100 9101 9102 9103 9104 9105; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "    $p — ЗАНЯТ"; else echo "    $p — свободен"; fi
done

echo
echo "Готово. Отчёт: $OUT"
echo "Секреты не выводились: из plist только имена env-переменных, из .env только имена ключей."
