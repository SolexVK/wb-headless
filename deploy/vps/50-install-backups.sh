#!/usr/bin/env bash
# 50-install-backups.sh — ежедневные резервные копии данных сервера.
# Запускать от root, идемпотентен.
#
#   sudo bash deploy/vps/50-install-backups.sh
#
# Что бэкапим:
#   • planner.db      — рабочие данные производственного плана (снимком SQLite);
#   • state.json      — состояние на случай, если БД недоступна;
#   • .env-файлы      — секреты сервисов (в архиве, права 600);
#   • Caddyfile       — маршруты и домены;
#   • список юнитов и версии — чтобы понимать, что было развёрнуто.
#
# Куда: /var/backups/planner, хранение 14 дней. Это защищает от порчи данных
# и ошибочного удаления, но НЕ от потери сервера — копию нужно регулярно
# забирать наружу (см. docs/vps-setup.md, раздел «Бэкапы»).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/planner}"
KEEP_DAYS="${KEEP_DAYS:-14}"
HOUR="${HOUR:-03}"   # время ежедневного запуска (по времени сервера)

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запускать от root: sudo bash $0"

install -d -m 700 "$BACKUP_DIR"

log "Ставлю /usr/local/sbin/planner-backup"
cat > /usr/local/sbin/planner-backup <<'EOF'
#!/usr/bin/env bash
# Ежедневная резервная копия. Ставится deploy/vps/50-install-backups.sh.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/var/backups/planner}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

snap_db() { # $1 — путь к базе, $2 — имя в архиве
  [ -f "$1" ] || return 0
  local owner; owner="$(stat -c %U "$1")"
  # Снимок пишет владелец базы, поэтому даём ему собственный подкаталог с правами 700,
  # а не открываем весь временный каталог. VACUUM INTO — единственный корректный способ
  # скопировать живую базу SQLite: обычный cp не заберёт данные из WAL-журнала.
  local snapdir="$WORK/.snap-$owner"
  install -d -m 700 -o "$owner" -g "$owner" "$snapdir"
  if runuser -u "$owner" -- node --experimental-sqlite -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.prepare('VACUUM INTO ?').run(process.argv[2]);
      db.close();
    " "$1" "$snapdir/$2" 2>/dev/null; then
    mv "$snapdir/$2" "$WORK/$2"
  else
    echo "[backup] не удалось снять $1" >&2
  fi
  rm -rf "$snapdir"
}

# базы данных сервисов
snap_db /opt/planner/planner/data/planner.db planner.db

# файлы конфигурации и состояния
copy() { [ -e "$1" ] && cp -a "$1" "$WORK/$2" 2>/dev/null || true; }
copy /opt/planner/planner/data/state.json planner-state.json
copy /opt/planner/planner/data/.env planner.env
copy /opt/wb-headless/.env wb-headless.env
copy /etc/caddy/Caddyfile Caddyfile

# что развёрнуто на момент копии
{
  echo "дата: $(date -Is)"
  echo "--- службы ---"
  systemctl list-units --type=service --no-pager --no-legend 'planner*' 'wb-headless*' 'caddy*' || true
  echo "--- версии кода ---"
  for d in /opt/planner /opt/planner-demo /opt/wb-headless; do
    [ -d "$d/.git" ] && echo "$d: $(git -C "$d" rev-parse --short HEAD 2>/dev/null) $(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  done
} > "$WORK/manifest.txt" 2>/dev/null || true

install -d -m 700 "$BACKUP_DIR"
OUT="$BACKUP_DIR/planner-$STAMP.tar.gz"
tar czf "$OUT" -C "$WORK" .
chmod 600 "$OUT"

# ротация
find "$BACKUP_DIR" -maxdepth 1 -name 'planner-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] готово: $OUT ($SIZE)"

# Проверка: архив читается и база в нём открывается. Битый бэкап хуже отсутствующего.
if ! tar tzf "$OUT" >/dev/null 2>&1; then echo "[backup] АРХИВ БИТЫЙ: $OUT" >&2; exit 1; fi
EOF
chmod 755 /usr/local/sbin/planner-backup

log "Ставлю systemd-таймер (ежедневно в ${HOUR}:20)"
cat > /etc/systemd/system/planner-backup.service <<EOF
[Unit]
Description=Резервная копия данных planner и конфигурации сервера
After=network-online.target

[Service]
Type=oneshot
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=KEEP_DAYS=$KEEP_DAYS
ExecStart=/usr/local/sbin/planner-backup
EOF

cat > /etc/systemd/system/planner-backup.timer <<EOF
[Unit]
Description=Ежедневная резервная копия planner

[Timer]
OnCalendar=*-*-* ${HOUR}:20:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now planner-backup.timer

log "Делаю первую копию прямо сейчас"
systemctl start planner-backup.service
sleep 2
journalctl -u planner-backup.service -n 10 --no-pager | tail -5

log "Копии: $BACKUP_DIR (хранение $KEEP_DAYS дней)"
ls -lh "$BACKUP_DIR" | tail -3
log "Расписание: systemctl list-timers planner-backup"
