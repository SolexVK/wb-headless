#!/usr/bin/env bash
# scripts/macmini-inspect.sh — паспорт Mac Mini для локального CV/VLM-слоя.
#
# СТРОГО ТОЛЬКО ЧТЕНИЕ: ничего не ставит, не запускает, не останавливает,
# не трогает launchd, Caddy и чужие сервисы (см. MACMINI-DEPLOY.md).
# sudo не нужен.
#
# Запуск:  bash scripts/macmini-inspect.sh
# Отчёт дублируется в  ~/macmini-report.txt  — его можно прислать целиком.

set -uo pipefail
OUT="$HOME/macmini-report.txt"
exec > >(tee "$OUT") 2>&1

hr(){ printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }
kv(){ printf '  %-34s %s\n' "$1" "${2:-—}"; }
have(){ command -v "$1" >/dev/null 2>&1; }
# du -sh, но без падения, если пути нет
dush(){ [ -e "$1" ] && du -sh "$1" 2>/dev/null | awk '{print $1}' || echo "нет"; }

echo "Паспорт Mac Mini · $(date '+%Y-%m-%d %H:%M:%S %Z')"

hr "Железо"
kv "Модель"            "$(sysctl -n hw.model 2>/dev/null)"
kv "Чип"               "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
kv "Архитектура"       "$(uname -m)"
kv "Ядра всего"        "$(sysctl -n hw.ncpu 2>/dev/null)"
kv "  производительных" "$(sysctl -n hw.perflevel0.logicalcpu 2>/dev/null)"
kv "  энергоэффективных" "$(sysctl -n hw.perflevel1.logicalcpu 2>/dev/null)"
MEM_B=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
kv "Оперативная память" "$(awk -v b="$MEM_B" 'BEGIN{printf "%.0f ГБ", b/1073741824}')"
kv "GPU-ядер"          "$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Total Number of Cores/{print $2; exit}')"
kv "macOS"             "$(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
kv "Аптайм"            "$(uptime | sed 's/^ *//')"

hr "Диск"
df -h / /System/Volumes/Data 2>/dev/null | awk 'NR==1||/\/$|Data/{printf "  %s\n",$0}'
kv "Свободно в контейнере" "$(diskutil info /System/Volumes/Data 2>/dev/null | awk -F': *' '/Container Free Space/{print $2; exit}')"
echo "  Крупные каталоги в \$HOME (топ-8):"
du -sh "$HOME"/* 2>/dev/null | sort -hr | head -8 | sed 's/^/    /'

hr "Память сейчас"
PS=$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)
vm_stat 2>/dev/null | awk -v ps="$PS" '
 /Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3}
 END{gsub(/\./,"",f);gsub(/\./,"",i);gsub(/\./,"",s);
     printf "  %-34s %.1f ГБ\n","Свободно + неактивно",(f+i+s)*ps/1073741824}'
kv "Своп" "$(sysctl -n vm.swapusage 2>/dev/null)"

hr "Уже установленные нейросети и ML-стек"

if have ollama; then
  kv "Ollama" "$(ollama --version 2>/dev/null | head -1)"
  echo "  Модели Ollama:"
  ollama list 2>/dev/null | sed 's/^/    /' || echo "    (демон не отвечает — модели на диске ниже)"
  kv "  размер ~/.ollama/models" "$(dush "$HOME/.ollama/models")"
else
  kv "Ollama" "не установлен"
fi

for d in "$HOME/.lmstudio" "$HOME/.cache/lm-studio" "/Applications/LM Studio.app"; do
  [ -e "$d" ] && kv "LM Studio" "найден: $d ($(dush "$d"))" && break
done
[ -e "$HOME/.lmstudio" ] || [ -e "/Applications/LM Studio.app" ] || kv "LM Studio" "не найден"

kv "HuggingFace-кэш"  "$(dush "$HOME/.cache/huggingface")"
[ -d "$HOME/.cache/huggingface/hub" ] && \
  ls -1 "$HOME/.cache/huggingface/hub" 2>/dev/null | grep '^models--' | sed 's/^models--//;s/--/\//g;s/^/    /' | head -20

for tool in llama-cli llama-server whisper mlx_lm.generate; do
  have "$tool" && kv "$tool" "$(command -v "$tool")"
done

hr "Питон и пакеты"
for py in python3 /usr/bin/python3 /opt/homebrew/bin/python3; do
  have "$py" && kv "$py" "$("$py" -V 2>&1)"
done
have python3 && python3 - <<'PY' 2>/dev/null
import importlib.metadata as md
pkgs = ["torch","torchvision","mlx","mlx-lm","transformers","onnxruntime",
        "open_clip_torch","sentence-transformers","clip-anytorch","pillow",
        "numpy","opencv-python","imagehash","ultralytics","timm","accelerate"]
print("  Пакеты в текущем python3:")
for p in pkgs:
    try: print(f"    ✓ {p:<22} {md.version(p)}")
    except Exception: print(f"    · {p:<22} нет")
try:
    import torch
    print(f"  torch: MPS доступен = {torch.backends.mps.is_available()}")
except Exception: pass
PY
have conda && kv "conda" "$(conda --version 2>/dev/null)"
have pyenv && kv "pyenv" "$(pyenv versions --bare 2>/dev/null | tr '\n' ' ')"

hr "Прочее окружение"
have node && kv "node" "$(node -v)"
have brew && kv "brew" "$(brew --version 2>/dev/null | head -1)"
have brew && echo "  brew-пакеты по теме:" && \
  brew list --formula 2>/dev/null | grep -iE 'python|ffmpeg|webp|opencv|onnx|cmake|libomp|caddy|node' | sed 's/^/    /'

hr "Занятые порты (чтобы не занять чужое)"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)], $1}' \
  | sort -n -u | head -30 | awk '{printf "  %-8s %s\n",$1,$2}'

hr "Пригодность под локальный CV/VLM"
awk -v b="$MEM_B" 'BEGIN{
  g=b/1073741824;
  printf "  Оперативной памяти: %.0f ГБ\n", g;
  if (g>=32) print "  → 7B-VLM в 4-bit пойдёт свободно, можно и 13B. FashionCLIP — без вопросов.";
  else if (g>=16) print "  → 7B-VLM в 4-bit пойдёт, но впритык рядом с другими сервисами. FashionCLIP — легко.";
  else print "  → Для 7B-VLM мало. Реально только CLIP/SigLIP-класс (сотни МБ) — этого может хватить.";
}'
echo
echo "Отчёт сохранён: $OUT"
