#!/bin/bash
# macmini-export-sirius.sh — экспорт ЖИВОГО Сириуса (OpenClaw) с Mac Mini для переезда на VPS.
#
# Делает две вещи:
#   1) ~/sirius-export/repo   — знания и структура для приватного git-репозитория `sirius`:
#        workspace (SOUL/IDENTITY/USER/MEMORY, memory/, dreaming, scripts, skills, docs, projects),
#        конфиг OpenClaw с вырезанными секретами, launchd/crontab, СХЕМЫ всех баз + маленькие дампы,
#        INVENTORY.md (что где лежит, размеры, даты).
#   2) ~/sirius-export/sirius-data-<дата>.tar.gz — ПОЛНЫЕ данные для VPS (не в git):
#        все SQLite-базы (консистентные копии), полные дампы Postgres, история сессий (.jsonl).
#
# Секреты (ключи API, service-account, .pgconfig, auth-profiles, скриншоты логина) НЕ попадают
# ни в repo, ни в архив — их переносим руками отдельно.
#
# Запуск на Mac Mini под пользователем openclaw:  bash scripts/macmini-export-sirius.sh
# Ничего не удаляет и не останавливает: Сириус продолжает работать.

set -u

OC="$HOME/.openclaw"
WS="$OC/workspace"
AGENT="$OC/agents/main"
STAMP="$(date '+%Y%m%d_%H%M%S')"
OUT="$HOME/sirius-export"
REPO="$OUT/repo"
DATA="$OUT/data-$STAMP"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }

[ -d "$WS" ] || { warn "Нет $WS — OpenClaw workspace не найден"; exit 1; }

# Postgres может быть в brew-пути
for p in /opt/homebrew/opt/postgresql@*/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done
export PATH

rm -rf "$REPO"; mkdir -p "$REPO" "$DATA"

# ---------------------------------------------------------------- 1. workspace → repo
log "workspace → repo/workspace (без секретов и бинарных баз)"
EXCL="$OUT/.rsync-exclude"
cat > "$EXCL" <<'X'
.git/
node_modules/
backups/
credentials/
*service-account*.json
auth-profiles.json
auth-state.json
.pgconfig
*.pem
*.key
*.png
*.jpg
*.jpeg
*.db
*.sqlite
*.sqlite-*
*.tar.gz
X
rsync -a --exclude-from="$EXCL" "$WS/" "$REPO/workspace/"
ok "$(find "$REPO/workspace" -type f | wc -l | tr -d ' ') файлов"

# ---------------------------------------------------------------- 2. конфиги
log "Конфиг OpenClaw (секреты заменены на <redacted>), launchd, crontab, пакеты"
mkdir -p "$REPO/config/launchd"
if [ -f "$OC/openclaw.json" ]; then
  /usr/bin/python3 - "$OC/openclaw.json" "$REPO/config/openclaw.redacted.json" <<'PY'
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
pat = re.compile(r'(token|secret|password|passwd|api[_-]?key|apikey|private|credential|auth)', re.I)
def walk(o):
    if isinstance(o, dict):
        return {k: ('<redacted>' if pat.search(k) and not isinstance(v, (dict, list)) else walk(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(x) for x in o]
    if isinstance(o, str) and re.match(r'^(sk-|ghp_|xox[abp]-|AKIA|\d{8,}:[A-Za-z0-9_-]{30,})', o):
        return '<redacted>'
    return o
with open(src) as f: data = json.load(f)
with open(dst, 'w') as f: json.dump(walk(data), f, ensure_ascii=False, indent=2)
PY
  ok "config/openclaw.redacted.json"
fi
for pl in "$HOME"/Library/LaunchAgents/*sirius* "$HOME"/Library/LaunchAgents/*openclaw*; do
  [ -f "$pl" ] && cp "$pl" "$REPO/config/launchd/" && ok "launchd: $(basename "$pl")"
done
crontab -l > "$REPO/config/crontab.txt" 2>/dev/null || echo "(пусто)" > "$REPO/config/crontab.txt"
launchctl list 2>/dev/null | grep -iE 'sirius|openclaw|hermes|helios' > "$REPO/config/launchctl.txt" || true
/usr/bin/python3 -m pip freeze > "$REPO/config/pip-packages.txt" 2>/dev/null || true
command -v brew >/dev/null && brew list --versions > "$REPO/config/brew-list.txt" 2>/dev/null || true
command -v openclaw >/dev/null && openclaw --version > "$REPO/config/openclaw-version.txt" 2>&1 || true
ls -la "$OC" > "$REPO/config/openclaw-dir-listing.txt" 2>/dev/null || true

# ---------------------------------------------------------------- 3. Postgres
log "Postgres: схемы, расширения, размеры → repo; полные дампы → data"
mkdir -p "$REPO/db/postgres" "$DATA/postgres"
if command -v psql >/dev/null 2>&1 && psql -lqt >/dev/null 2>&1; then
  psql -lqt | cut -d'|' -f1 | sed 's/ //g' | grep -vE '^(template0|template1|postgres|)$' > "$REPO/db/postgres/databases.txt"
  while read -r db; do
    [ -n "$db" ] || continue
    pg_dump -s "$db" > "$REPO/db/postgres/$db.schema.sql" 2>/dev/null && ok "схема $db"
    {
      echo "== extensions =="; psql -d "$db" -Atc "select extname||' '||extversion from pg_extension"
      echo "== tables (rows, size) =="
      psql -d "$db" -Atc "select n.nspname||'.'||c.relname||' | rows~'||c.reltuples::bigint||' | '||pg_size_pretty(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema') order by pg_total_relation_size(c.oid) desc"
    } > "$REPO/db/postgres/$db.info.txt" 2>/dev/null
    pg_dump "$db" | gzip > "$DATA/postgres/$db.full.sql.gz" 2>/dev/null && ok "полный дамп $db → data"
    # маленькие дампы (< 5 МБ) — и в repo тоже
    if [ "$(stat -f %z "$DATA/postgres/$db.full.sql.gz" 2>/dev/null || echo 0)" -lt 5000000 ]; then
      cp "$DATA/postgres/$db.full.sql.gz" "$REPO/db/postgres/"
    fi
  done < "$REPO/db/postgres/databases.txt"
else
  warn "psql недоступен или сервер не запущен — Postgres пропущен (это важно: tandem_db/memory_db живут там)"
fi

# ---------------------------------------------------------------- 4. SQLite
log "SQLite: схемы → repo; консистентные копии → data"
mkdir -p "$REPO/db/sqlite" "$DATA/sqlite"
SQLITES="
$OC/memory/main.sqlite
$AGENT/agent/openclaw-agent.sqlite
$OC/state/openclaw.sqlite
$OC/kanban.db
$WS/projects/self-awareness-kernel/data/cycles.db
$WS/projects/self-awareness-kernel/data/source_memory.db
$WS/memory/tandem.db
$WS/memory/telegram.db
$WS/memory/mail_notes.db
$WS/data/tasks.db
$WS/data/relay.db
"
for f in $SQLITES; do
  [ -s "$f" ] || continue
  name="$(echo "$f" | sed "s#$OC/##; s#/#__#g")"
  {
    echo "-- $f  ($(stat -f %z "$f") bytes, mtime $(stat -f %Sm "$f"))"
    sqlite3 "$f" .schema
    echo; echo "-- row counts"
    sqlite3 "$f" "select name from sqlite_master where type='table'" | while read -r t; do
      printf '%s\t%s\n' "$t" "$(sqlite3 "$f" "select count(*) from \"$t\"" 2>/dev/null)"
    done
  } > "$REPO/db/sqlite/$name.schema.sql" 2>/dev/null
  sqlite3 "$f" ".backup '$DATA/sqlite/$name'" 2>/dev/null && ok "$name"
done

# ---------------------------------------------------------------- 5. сессии и dreaming → data
log "История сессий и артефакты dreaming → data"
if [ -d "$AGENT/sessions" ]; then
  tar -czf "$DATA/sessions.tar.gz" -C "$AGENT" sessions 2>/dev/null && ok "sessions ($(ls "$AGENT/sessions"/*.jsonl 2>/dev/null | wc -l | tr -d ' ') jsonl)"
fi
[ -d "$WS/memory/.dreams" ] && cp -R "$WS/memory/.dreams" "$DATA/dreams" && ok ".dreams"

# ---------------------------------------------------------------- 6. INVENTORY.md
log "INVENTORY.md"
{
  echo "# Инвентаризация Сириуса на Mac Mini — $STAMP"
  echo; echo "Хост: $(hostname), macOS $(sw_vers -productVersion 2>/dev/null), пользователь $(whoami)"
  echo; echo "## Живые процессы (launchctl)"; echo '```'; cat "$REPO/config/launchctl.txt"; echo '```'
  echo; echo "## Размеры"; echo '```'
  du -sh "$OC" "$WS" "$OC/memory" "$AGENT" "$AGENT/sessions" "$HOME/.hermes" 2>/dev/null
  echo '```'
  echo; echo "## Свежесть ключевых файлов"; echo '```'
  ls -la "$WS"/SOUL.md "$WS"/IDENTITY.md "$WS"/USER.md "$WS"/MEMORY.md "$WS"/AGENTS.md "$WS"/HEARTBEAT.md "$WS"/TOOLS.md 2>/dev/null
  echo; ls -lat "$WS/memory" 2>/dev/null | head -15
  echo; ls -la "$OC/memory" "$OC/state" "$AGENT/agent" 2>/dev/null
  echo '```'
  echo; echo "## Дерево workspace"; echo '```'
  (cd "$WS" && find . -type d -not -path '*/node_modules*' -not -path './.git*' | sort | head -80)
  echo '```'
  echo; echo "## Postgres"; echo '```'; cat "$REPO/db/postgres/databases.txt" 2>/dev/null || echo "(нет)"; echo '```'
  echo; echo "## Другие агенты на машине (не экспортированы, уточнить)"; echo '```'
  ls -la "$HOME/.hermes" 2>/dev/null | head -20; echo; ls -la "$OC/caveman-claw" 2>/dev/null | head
  echo '```'
} > "$REPO/INVENTORY.md"
ok "INVENTORY.md"

# ---------------------------------------------------------------- 7. проверка на секреты
log "Проверка repo на секреты"
cat > "$REPO/.gitignore" <<'G'
credentials/
*service-account*.json
auth-profiles.json
.pgconfig
*.pem
*.key
*.db
*.sqlite
*.sqlite-*
G
HITS="$(grep -rIlE '(sk-ant-|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|[0-9]{8,}:[A-Za-z0-9_-]{35})' "$REPO" 2>/dev/null || true)"
if [ -n "$HITS" ]; then
  warn "Похоже на секреты — ПРОВЕРЬ и вычисти перед push:"; echo "$HITS" | sed 's/^/      /'
else
  ok "явных ключей не найдено"
fi

# ---------------------------------------------------------------- 8. git + архив
log "git-репозиторий"
cd "$REPO" && git init -q -b main 2>/dev/null || git init -q
git add -A && git -c user.name="Sirius export" -c user.email="solexvk@gmail.com" commit -qm "Экспорт Сириуса с Mac Mini $STAMP" && ok "коммит готов ($(git ls-files | wc -l | tr -d ' ') файлов, $(du -sh . | cut -f1))"

log "Архив полных данных"
tar -czf "$OUT/sirius-data-$STAMP.tar.gz" -C "$OUT" "data-$STAMP" && ok "$OUT/sirius-data-$STAMP.tar.gz ($(du -sh "$OUT/sirius-data-$STAMP.tar.gz" | cut -f1))"

cat <<NEXT

Готово. Дальше — две команды:

  # 1) знания → приватный репозиторий (сначала создай ПУСТОЙ приватный репо SolexVK/sirius на GitHub)
  cd $REPO && git remote add origin git@github.com:SolexVK/sirius.git && git push -u origin main

  # 2) полные данные → VPS (не в git)
  ssh deploy@159.195.41.88 'mkdir -p /opt/sirius/memory/import'
  scp $OUT/sirius-data-$STAMP.tar.gz deploy@159.195.41.88:/opt/sirius/memory/import/

Секреты (credentials/, auth-profiles.json, .pgconfig) остались на Mac Mini — перенесём отдельно, руками.
NEXT
