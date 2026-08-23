#!/usr/bin/env bash
# scripts/ollama-usage-audit.sh — кто на Mac Mini пользуется Ollama и какими моделями.
#
# Зачем: перед удалением моделей убедиться, что их не дёргает чужая служба.
# Машина общая (см. MACMINI-DEPLOY.md), сломать соседа удалением модели легко.
#
# СТРОГО ТОЛЬКО ЧТЕНИЕ. Ничего не удаляет и не останавливает. В конце печатает
# ГОТОВЫЕ КОМАНДЫ на удаление — но не выполняет их: решение за вами.
#
# Запуск:  bash scripts/ollama-usage-audit.sh

set -uo pipefail
hr(){ printf '\n\033[1m══ %s\033[0m\n' "$1"; }
sub(){ printf '\n  \033[4m%s\033[0m\n' "$1"; }
have(){ command -v "$1" >/dev/null 2>&1; }

# Модели, нужные для визуального поиска рубашек. Остальные — кандидаты на снос.
KEEP_RE='^(gemma3:4b|gemma3:12b|nomic-embed-text)'

echo "Аудит использования Ollama · $(date '+%Y-%m-%d %H:%M:%S')"
have ollama || { echo "ollama не установлен — выходим"; exit 0; }

hr "1. Установленные модели"
ollama list 2>/dev/null | sed 's/^/    /'

hr "2. Загружено в память прямо сейчас"
ollama ps 2>/dev/null | sed 's/^/    /' || echo "    (пусто)"

hr "3. Кто держит соединение с портом 11434"
lsof -nP -iTCP:11434 2>/dev/null | sed 's/^/    /' || echo "    только сам Ollama или соединений нет"

hr "4. Следы обращений в логе сервера Ollama"
LOG=""
for l in "$HOME/.ollama/logs/server.log" "/opt/homebrew/var/log/ollama.log" \
         "$HOME/Library/Logs/Ollama/server.log"; do
  [ -f "$l" ] && { LOG="$l"; break; }
done
if [ -n "$LOG" ]; then
  echo "    лог: $LOG  ($(wc -l < "$LOG" | tr -d ' ') строк, последняя запись $(stat -f '%Sm' "$LOG"))"
  sub "Сколько раз каждая модель встречается в логе"
  while read -r name _; do
    [ -z "$name" ] && continue
    n=$(grep -c -- "$name" "$LOG" 2>/dev/null || echo 0)
    printf '    %-26s упоминаний в логе: %s\n' "$name" "$n"
  done < <(ollama list 2>/dev/null | tail -n +2)
else
  echo "    лог сервера не найден — этот источник пропущен"
fi

hr "5. Упоминания моделей и Ollama в коде и конфигах домашнего каталога"
sub "Файлы, где встречается 11434 или ollama"
grep -rIl --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=bench-images \
     -e '11434' -e 'ollama' -e 'OLLAMA' "$HOME" 2>/dev/null | head -25 | sed 's/^/    /'
sub "Упоминание конкретных моделей по имени"
while read -r name _; do
  [ -z "$name" ] && continue
  hits=$(grep -rIl --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=bench-images \
         -F "$name" "$HOME" 2>/dev/null | grep -v '/bench-images/' | head -4 | tr '\n' ' ')
  printf '    %-26s %s\n' "$name" "${hits:-— следов нет}"
done < <(ollama list 2>/dev/null | tail -n +2)

hr "6. launchd-службы, которые могли бы ходить в Ollama"
grep -lIi -e ollama -e 11434 "$HOME"/Library/LaunchAgents/*.plist 2>/dev/null | sed 's/^/    /' \
  || echo "    ни один LaunchAgent не упоминает Ollama"

hr "7. Вердикт по каждой модели"
printf '    %-26s %-9s %s\n' "МОДЕЛЬ" "РАЗМЕР" "РЕШЕНИЕ"
TO_REMOVE=()
while read -r name size unit _; do
  [ -z "$name" ] && continue
  if [[ "$name" =~ $KEEP_RE ]]; then
    verdict="ОСТАВИТЬ — нужна для визуального поиска"
  else
    used=""
    [ -n "$LOG" ] && [ "$(grep -c -- "$name" "$LOG" 2>/dev/null || echo 0)" -gt 0 ] && used="лог"
    grep -rIlq --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=bench-images \
         -F "$name" "$HOME" 2>/dev/null && used="${used:+$used, }код"
    if [ -n "$used" ]; then
      verdict="ПРОВЕРИТЬ ВРУЧНУЮ — есть следы: $used"
    else
      verdict="можно удалить — следов использования нет"
      TO_REMOVE+=("$name")
    fi
  fi
  printf '    %-26s %-9s %s\n' "$name" "$size$unit" "$verdict"
done < <(ollama list 2>/dev/null | tail -n +2)

hr "8. Готовые команды (НЕ выполнены — скопируйте нужные вручную)"
if [ ${#TO_REMOVE[@]} -eq 0 ]; then
  echo "    Автоматически безопасных к удалению не нашлось — разбирайте вручную по разделу 7."
else
  echo "    Удалить модели без следов использования:"
  for m in "${TO_REMOVE[@]}"; do echo "      ollama rm $m"; done
  echo
  echo "    Сначала посмотрите, сколько это освободит:"
  echo "      du -sh ~/.ollama/models"
fi
echo
echo "Напоминание: удаление модели необратимо, вернуть можно только повторной"
echo "загрузкой (ollama pull <имя>) — это трафик и время, но не потеря данных."
