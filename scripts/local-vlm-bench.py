#!/usr/bin/env python3
"""
scripts/local-vlm-bench.py — проверка локальных vision-моделей Ollama
на размеченном наборе карточек WB.

Зачем: понять, годится ли локальная модель на Mac Mini вместо платного API
для ступеней «грубый фильтр» и «точный разбор» визуального поиска рубашек.

Только чтение чужого: ходит в WB CDN и в локальный Ollama (127.0.0.1:11434).
Ничего не устанавливает, чужие сервисы не трогает. Модели выгружаются после
каждого прогона (keep_alive=0), чтобы не держать память на общей машине.

Запуск:
    python3 scripts/local-vlm-bench.py                 # все vision-модели, оба теста
    python3 scripts/local-vlm-bench.py --models gemma3:4b,qwen-vision:3b
    python3 scripts/local-vlm-bench.py --skip-big      # пропустить модели >8 ГБ
    python3 scripts/local-vlm-bench.py --test gate     # только грубый фильтр

Зависимости: только стандартная библиотека Python 3.
"""

import argparse, base64, json, os, sys, time, urllib.request, urllib.error

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
IMG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bench-images")
UA = {"User-Agent": "Mozilla/5.0"}

# ── Размеченный набор. Метки проставлены вручную по фотографиям. ──────────────
CARDS = {
    237194752: dict(label="марлевка оверсайз — ЦЕЛЕВАЯ",
                    gate=dict(is_womens_shirt=True, full_front_button_placket=True,
                              long_sleeves=True, loose_fit=True),
                    attrs=dict(collar="classic_turn_down", sleeve_length="long", fit="oversize",
                               hem="rounded_shirt_tail", chest_pocket=False,
                               fabric_texture="crinkled_gauze", pattern="solid")),
    227781398: dict(label="муслин оверсайз — ЦЕЛЕВАЯ",
                    gate=dict(is_womens_shirt=True, full_front_button_placket=True,
                              long_sleeves=True, loose_fit=True),
                    attrs=dict(collar="classic_turn_down", sleeve_length="long", fit="oversize",
                               hem="rounded_shirt_tail", chest_pocket=False,
                               fabric_texture="crinkled_gauze", pattern="solid")),
    608341673: dict(label="атлас — крой совпал, ткань противоположна",
                    gate=dict(is_womens_shirt=True, full_front_button_placket=True,
                              long_sleeves=True, loose_fit=True),
                    attrs=dict(collar="classic_turn_down", sleeve_length="long", fit="relaxed",
                               hem="rounded_shirt_tail", chest_pocket=False,
                               fabric_texture="satin_shiny", pattern="solid")),
    328892062: dict(label="клетка/фланель оверсайз — смежное",
                    gate=dict(is_womens_shirt=True, full_front_button_placket=True,
                              long_sleeves=True, loose_fit=True),
                    attrs=dict(collar="classic_turn_down", sleeve_length="long", fit="oversize",
                               hem="unknown", chest_pocket=False,
                               fabric_texture="flannel", pattern="check")),
    179331048: dict(label="приталенная офисная — НЕ подходит",
                    gate=dict(is_womens_shirt=True, full_front_button_placket=True,
                              long_sleeves=True, loose_fit=False),
                    attrs=dict(collar="classic_turn_down", sleeve_length="long", fit="fitted",
                               hem="unknown", chest_pocket=False,
                               fabric_texture="smooth_matte", pattern="solid")),
    327286708: dict(label="блузка, стойка+V, рукав 3/4 — отсев на гейте",
                    gate=dict(is_womens_shirt=False, full_front_button_placket=False,
                              long_sleeves=False, loose_fit=True),
                    attrs=dict(collar="stand", sleeve_length="three_quarter", fit="straight",
                               hem="straight", chest_pocket=False,
                               fabric_texture="smooth_matte", pattern="solid")),
}

GATE_PROMPT = """You are grading one product photo from an online marketplace.
Look only at the garment. Ignore the model, background, text overlays and styling.
Reply with JSON only, no prose:
{"is_womens_shirt": bool,          // women's shirt or shirt-style blouse; false for dress, jacket, t-shirt, knitwear, suit
 "full_front_button_placket": bool,// continuous centre-front opening fastened with buttons
 "long_sleeves": bool,             // sleeves reach the wrist
 "loose_fit": bool,                // relaxed or oversized, not body-hugging
 "photo_usable": bool,             // the garment is actually visible, not just an infographic
 "confidence": "low"|"medium"|"high"}"""

ATTRS_PROMPT = """You are cataloguing one garment from marketplace photos.
Ignore colour, the model, background, text overlays and styling. Judge construction only.
If a feature is hidden by pose or cropping, answer "unknown" — never guess.
Reply with JSON only, no prose:
{"collar": "classic_turn_down"|"stand"|"mandarin"|"polo"|"round_neck"|"v_neck"|"bow"|"lapel"|"unknown",
 "sleeve_length": "long"|"three_quarter"|"short"|"sleeveless"|"unknown",
 "fit": "oversize"|"relaxed"|"straight"|"fitted"|"unknown",
 "cuff": "separate_shirt_cuff"|"elastic"|"folded"|"none"|"unknown",
 "hem": "rounded_shirt_tail"|"straight"|"unknown",
 "chest_pocket": true|false|"unknown",
 "fabric_texture": "crinkled_gauze"|"smooth_matte"|"satin_shiny"|"knit"|"denim"|"flannel"|"unknown",
 "pattern": "solid"|"stripe"|"check"|"floral"|"other"|"unknown"}"""


def http_json(url, payload=None, timeout=600):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def fetch_photos(nm, count=2):
    """Скачивает первые `count` фото карточки, подбирая шард basket. Возвращает пути."""
    os.makedirs(IMG_DIR, exist_ok=True)
    paths = [os.path.join(IMG_DIR, f"{nm}_{i}.webp") for i in range(1, count + 1)]
    if all(os.path.exists(p) and os.path.getsize(p) > 2000 for p in paths):
        return paths
    vol, part = nm // 100000, nm // 1000
    shard = None
    for i in range(1, 41):
        url = f"https://basket-{i:02d}.wbbasket.ru/vol{vol}/part{part}/{nm}/images/c516x688/1.webp"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=6) as r:
                if r.status == 200:
                    shard = i
                    break
        except Exception:
            continue
    if shard is None:
        return []
    out = []
    for i, p in enumerate(paths, start=1):
        url = f"https://basket-{shard:02d}.wbbasket.ru/vol{vol}/part{part}/{nm}/images/c516x688/{i}.webp"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
                open(p, "wb").write(r.read())
            out.append(p)
        except Exception:
            pass
    return out


def b64(path):
    return base64.b64encode(open(path, "rb").read()).decode()


def ask(model, prompt, image_paths):
    """Один запрос к Ollama. Возвращает (dict|None, секунды, сырой текст)."""
    payload = {"model": model, "prompt": prompt,
               "images": [b64(p) for p in image_paths],
               "stream": False, "format": "json",
               "keep_alive": "5m",
               "options": {"temperature": 0, "num_predict": 400}}
    t0 = time.time()
    try:
        resp = http_json(f"{OLLAMA}/api/generate", payload)
    except Exception as e:
        return None, time.time() - t0, f"ОШИБКА: {e}"
    dt = time.time() - t0
    raw = (resp.get("response") or "").strip()
    try:
        return json.loads(raw), dt, raw
    except Exception:
        return None, dt, raw


def unload(model):
    try:
        http_json(f"{OLLAMA}/api/generate",
                  {"model": model, "prompt": "", "keep_alive": 0}, timeout=60)
    except Exception:
        pass


def norm(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower()
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", help="через запятую; по умолчанию — автоподбор vision-моделей")
    ap.add_argument("--test", choices=["gate", "attrs", "both"], default="both")
    ap.add_argument("--skip-big", action="store_true", help="пропустить модели тяжелее 8 ГБ")
    args = ap.parse_args()

    try:
        tags = http_json(f"{OLLAMA}/api/tags", timeout=20).get("models", [])
    except Exception as e:
        sys.exit(f"Ollama не отвечает на {OLLAMA}: {e}")

    known = {m["name"]: m.get("size", 0) for m in tags}
    print(f"Модели в Ollama: {', '.join(sorted(known))}\n")

    if args.models:
        models = [m.strip() for m in args.models.split(",")]
    else:
        # эвристика: мультимодальные семейства
        models = [n for n in known if any(k in n.lower()
                  for k in ("vision", "vl", "llava", "gemma3", "minicpm", "moondream"))]
    if args.skip_big:
        models = [m for m in models if known.get(m, 0) < 8 * 1024**3]
    if not models:
        sys.exit("Не нашёл vision-моделей. Укажите вручную: --models <имя>")

    print("Скачиваю фото набора…")
    photos = {}
    for nm in CARDS:
        p = fetch_photos(nm, 2)
        if not p:
            print(f"  {nm}: фото не найдены, карточка пропущена")
        else:
            photos[nm] = p
    print(f"  готово: {len(photos)} карточек\n")

    tests = [("gate", GATE_PROMPT, 1)] if args.test == "gate" else \
            [("attrs", ATTRS_PROMPT, 2)] if args.test == "attrs" else \
            [("gate", GATE_PROMPT, 1), ("attrs", ATTRS_PROMPT, 2)]

    summary = []
    for model in models:
        gb = known.get(model, 0) / 1024**3
        print("=" * 78)
        print(f"МОДЕЛЬ: {model}   ({gb:.1f} ГБ на диске)")
        print("=" * 78)
        for test_name, prompt, n_img in tests:
            hits = total = 0
            times = []
            bad_json = 0
            print(f"\n--- тест «{test_name}», фото на карточку: {n_img} ---")
            for nm, meta in CARDS.items():
                if nm not in photos:
                    continue
                imgs = photos[nm][:n_img]
                got, dt, raw = ask(model, prompt, imgs)
                times.append(dt)
                exp = meta[test_name]
                if got is None:
                    bad_json += 1
                    print(f"  {nm} {meta['label'][:38]:<38} {dt:5.1f}s  ✗ не JSON: {raw[:70]}")
                    total += len(exp)
                    continue
                ok, wrong = 0, []
                for k, want in exp.items():
                    total += 1
                    if norm(got.get(k)) == norm(want):
                        ok += 1
                        hits += 1
                    else:
                        wrong.append(f"{k}={got.get(k)!r}≠{want!r}")
                print(f"  {nm} {meta['label'][:38]:<38} {dt:5.1f}s  {ok}/{len(exp)}"
                      + (f"   {'; '.join(wrong[:3])}" if wrong else "   ✓"))
            acc = 100 * hits / total if total else 0
            avg = sum(times) / len(times) if times else 0
            print(f"\n  ИТОГ {test_name}: точность {acc:.0f}% ({hits}/{total}), "
                  f"среднее {avg:.1f} с/карточку, не-JSON: {bad_json}")
            summary.append((model, test_name, acc, avg, bad_json))
        unload(model)
        print(f"\n(модель {model} выгружена из памяти)\n")

    print("=" * 78)
    print("СВОДКА")
    print("=" * 78)
    print(f"  {'модель':<22} {'тест':<7} {'точность':>9} {'с/карточку':>12} {'не-JSON':>9}")
    for m, t, a, s, b in summary:
        print(f"  {m:<22} {t:<7} {a:>8.0f}% {s:>11.1f}s {b:>9}")
    print("\nПрогноз времени полного прогона (8 000 карточек, поток 1):")
    for m, t, a, s, b in summary:
        if t == "gate":
            print(f"  {m:<22} грубый фильтр: {8000*s/3600:.1f} ч")
        else:
            print(f"  {m:<22} точный разбор 2000 шт.: {2000*s/3600:.1f} ч")


if __name__ == "__main__":
    main()
