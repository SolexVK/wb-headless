#!/bin/bash
# scripts/night-run.sh — отложенный ночной прогон разбора на Mac Mini.
#
# Ждёт до заданного часа, отодвигает прошлые результаты в архив (в них нет
# шестого вопроса про ткань), запускает разбор кластерами и в конце выгружает
# модель из памяти. Пишет лог, чтобы утром было видно, что происходило.
#
# Запуск (можно закрыть терминал — процесс переживёт):
#   nohup bash scripts/night-run.sh > /dev/null 2>&1 &
#   nohup bash scripts/night-run.sh --at 02:00 > /dev/null 2>&1 &
#
# Посмотреть утром:
#   tail -40 out/night-run.log
#
# Остановить до старта или во время:
#   pkill -f night-run.sh; pkill -f vision-run.mjs

set -u
cd "$(dirname "$0")/.." || exit 1

AT="01:00"
IDS="out/passed.txt"
CLUSTER=25
while [ $# -gt 0 ]; do
  case "$1" in
    --at) AT="$2"; shift 2 ;;
    --ids) IDS="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    *) echo "неизвестный аргумент: $1"; exit 1 ;;
  esac
done

mkdir -p out
LOG="out/night-run.log"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"; }

# Список артикулов пересобираем из результатов гейта — так он всегда совпадает
# с тем, что реально прошло, и не зависит от того, что лежало в файле раньше.
if [ "$IDS" = "out/passed.txt" ] && [ -f out/vision-gate.jsonl ]; then
  node -e "require('fs').readFileSync('out/vision-gate.jsonl','utf8').split('\n')\
.filter(Boolean).map(JSON.parse).filter(r=>r.vision&&r.vision.garment_type==='shirt')\
.forEach(r=>console.log(r.nmId))" > out/passed.txt
fi

if [ ! -s "$IDS" ]; then
  say "ОСТАНОВ: нет файла с артикулами $IDS (или он пуст)"
  exit 1
fi

# ── Ждём до нужного часа ────────────────────────────────────────────────────
# date -j (BSD) есть на macOS; целевое время сегодня, а если оно уже прошло —
# завтра.
today_ts=$(date -j -f "%Y-%m-%d %H:%M" "$(date '+%Y-%m-%d') $AT" "+%s" 2>/dev/null)
if [ -z "$today_ts" ]; then say "ОСТАНОВ: не разобрал время «$AT»"; exit 1; fi
now_ts=$(date "+%s")
target_ts=$today_ts
[ "$target_ts" -le "$now_ts" ] && target_ts=$((target_ts + 86400))
wait_s=$((target_ts - now_ts))

say "старт запланирован на $(date -r "$target_ts" '+%d.%m %H:%M') — ждать $((wait_s / 60)) мин"
sleep "$wait_s"

# ── Архивируем прошлый разбор: в нём пять вопросов, а не шесть ──────────────
if [ -f out/vision-attrs.jsonl ]; then
  stamp=$(date '+%Y%m%d-%H%M')
  mv out/vision-attrs.jsonl "out/vision-attrs-5q-$stamp.jsonl"
  say "прошлый разбор отложен в out/vision-attrs-5q-$stamp.jsonl"
fi

say "запуск разбора: $(wc -l < "$IDS" | tr -d ' ') артикулов, кластер $CLUSTER"
nice -n 10 node scripts/vision-run.mjs \
  --stage attrs --ids "$IDS" --cluster "$CLUSTER" >> "$LOG" 2>&1
code=$?
say "разбор завершён, код $code"

# ── Освобождаем память в любом случае ───────────────────────────────────────
ollama stop gemma3:12b >> "$LOG" 2>&1
say "модель выгружена; своп: $(sysctl -n vm.swapusage)"
say "дальше: node scripts/report-visual.mjs --top 20"
