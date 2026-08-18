#!/usr/bin/env bash
#
# run-wb-stock.sh — живой прогон сводки по остаткам WB одной командой (macOS/Linux).
#
# Делает всё: собирает данные из API WB → пишет JSON/CSV → строит Excel-книгу →
# открывает её. Токен берётся из .env (или из окружения).
#
# Использование:
#   1) один раз:  cp .env.example .env  и впишите WB_API_TOKEN=...
#   2) запуск:    ./scripts/run-wb-stock.sh
#                 npm run wb-stock
#
set -euo pipefail

# Перейти в корень репозитория (скрипт лежит в scripts/).
cd "$(cd "$(dirname "$0")/.." && pwd)"

# 1) .env (значения из реального окружения имеют приоритет — их не трогаем).
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

if [ -z "${WB_API_TOKEN:-}" ] && [ -z "${WB_STATS_TOKEN:-}" ]; then
  echo "❌ Не задан WB_API_TOKEN."
  echo "   Впишите его в .env  (cp .env.example .env, затем WB_API_TOKEN=ваш_токен)"
  echo "   или экспортируйте:  export WB_API_TOKEN=ваш_токен"
  echo "   Токен: кабинет WB → Настройки → Доступ к API, категории"
  echo "          «Статистика», «Маркетплейс», «Контент»."
  exit 1
fi

# 2) Node 18+ (нужен встроенный fetch; внешние зависимости не требуются).
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js не найден. Установите: brew install node"; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Нужен Node.js 18+. Сейчас: $(node -v). Обновите: brew upgrade node"; exit 1
fi

echo "▶ Собираю сводку по остаткам WB из API…"
node report-wb-stock.js

# 3) Найти свежий JSON.
JSON="$(ls -t reports-output/wb-stock-*.json 2>/dev/null | head -1 || true)"
if [ -z "$JSON" ]; then
  echo "⚠ JSON не найден — что-то пошло не так на шаге сбора."; exit 1
fi
echo "  JSON: $JSON"

# 4) Excel-книга (нужен python3 + openpyxl).
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import openpyxl" >/dev/null 2>&1; then
    echo "▶ Ставлю openpyxl…"
    python3 -m pip install --quiet openpyxl
  fi
  XLSX="${JSON%.json}.xlsx"
  python3 analytics/wb-stock-report/build_report.py "$JSON" "$XLSX"
  echo "  XLSX: $XLSX"
  # Открыть книгу (macOS: open; Linux: xdg-open).
  if command -v open >/dev/null 2>&1; then open "$XLSX" || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$XLSX" || true
  fi
else
  echo "⚠ python3 не найден — Excel не собран, но CSV/JSON готовы."
  echo "  Установите: brew install python  (затем pip3 install openpyxl)"
fi

echo "✅ Готово."
