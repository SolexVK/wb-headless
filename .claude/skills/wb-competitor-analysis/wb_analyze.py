#!/usr/bin/env python3
"""
WB competitor analysis via MPStats — движок конкурентного анализа для доработки карточек.

Реализует методику из базы знаний (главы 04 «Методика конкурентного анализа»,
13 «Принадлежность запроса», 18 «Анализ полок и инфографики», 05 «Цена», 19 «Новые
механики») в той части, которую можно автоматизировать по данным MPStats, и честно
размечает то, что требует Wildbox/Gem/визуального разбора.

На выходе — многоблочный отчёт, из которого напрямую строится план доработки карточки:
  A. Ёмкость и концентрация ниши (+ сезонность/тренд)
  B. ТОП-N конкурентов (деньги: выручка/продажи/цена/рейтинг/упущенная выручка)
  C. Ценовой анализ: коридор, медиана, «привлекательная цена» (зона максимума выручки)
  D. Принадлежность (прокси): распределение цветов у топа + доминирующие признаки
  E. Контент-бенчмарк: фото/видео/3D/описание/рейтинг/отзивы/негатив/SEO-видимость
  F. Карточки для ручного разбора (ссылки на WB — под скриншоты листинга/Gem/полки)
  G. Разбор своей карточки (--my-sku): гэпы против медианы/лидеров ниши
  H. План доработки карточки: конкретные цифры-цели + пункты ручного слоя

HTTP через curl (надёжно и в облаке через egress-прокси, и локально). Токен — из env
MPSTATS_TOKEN или из .env (никогда не хардкодить).

Примеры:
  python3 wb_analyze.py --gender women --item рубашка --pattern полоска --top 10 --days 30
  python3 wb_analyze.py --path "Женщинам/Блузки и рубашки/Рубашки" --my-sku 123456789
  python3 wb_analyze.py --selftest         # прогон сборки отчёта без сети (на синтетике)
"""
import argparse, html as _html, json, os, subprocess, sys, tempfile, time, urllib.parse
from collections import defaultdict
from datetime import date, timedelta

API = "https://mpstats.io/api"
WB_CARD = "https://www.wildberries.ru/catalog/{}/detail.aspx"

# ---------- config / mappings ----------
GENDER_ROOT = {"women": "Женщинам", "men": "Мужчинам", "kids": "Детям", "all": None}

PATTERN_STEMS = {
    "полос": "полос", "полоска": "полос", "в полоску": "полос", "полосат": "полос", "stripe": "полос",
    "клетк": "клетк", "клетка": "клетк", "в клетку": "клетк", "клетчат": "клетк", "check": "клетк", "plaid": "клетк",
    "однотон": "однотон", "цветочн": "цветочн", "принт": "принт",
}

# «шумные» под-папки категорий, которые не должны перебивать каноничный путь
NOISE_SEG = ["больш", "будущие мам", "для высок", "для невысок", "одежда для дома",
             "офис", "плюс сайз", "пляжн", "спортивн"]
NOISE_ROOT = ["акци", "sale", "распрод", "хиты"]

FIELDS_KEEP = ["id", "name", "brand", "seller", "color", "final_price", "revenue", "sales",
               "rating", "comments", "picscount", "hasvideo", "has3d", "description_length",
               "balance", "lost_profit", "turnover_days", "search_words_count"]


# ======================= инфраструктура =======================
def load_token():
    tok = os.environ.get("MPSTATS_TOKEN", "").strip()
    if tok:
        return tok
    seen = set()
    for base in [os.getcwd(), os.path.dirname(os.path.abspath(__file__))]:
        d = base
        for _ in range(6):
            if d in seen:
                break
            seen.add(d)
            envp = os.path.join(d, ".env")
            if os.path.isfile(envp):
                for line in open(envp, encoding="utf-8"):
                    line = line.strip()
                    if line.startswith("MPSTATS_TOKEN="):
                        return line.split("=", 1)[1].strip()
            d = os.path.dirname(d)
    return ""


def curl_json(method, path, params=None, body=None, token=""):
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    cmd = ["curl", "-sS", "-m", "90", "-X", method, url,
           "-H", f"X-Mpstats-TOKEN: {token}", "-H", "Accept: application/json"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"curl failed ({out.returncode}): {out.stderr.strip()[:300]}")
    txt = out.stdout.strip()
    if not txt:
        raise RuntimeError(f"пустой ответ от {path} (проверьте параметры/лимиты)")
    try:
        data = json.loads(txt)
    except json.JSONDecodeError:
        raise RuntimeError(f"не JSON от {path}: {txt[:300]}")
    # MPStats отдаёт ошибки конвертом {code, message} — не путать с пустыми данными
    if isinstance(data, dict) and isinstance(data.get("code"), int) and data["code"] >= 400:
        raise MpstatsError(data["code"], data.get("message", ""), path)
    return data


class MpstatsError(RuntimeError):
    def __init__(self, code, message, path=""):
        self.code = code
        self.message = message
        super().__init__(f"MPStats API {code} на {path}: {message}")


def find_chromium():
    import shutil
    cands = [os.environ.get("CHROMIUM_BIN"), "/opt/pw-browsers/chromium",
             "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]
    for c in cands:
        if not c:
            continue
        p = c if (os.path.isabs(c) and os.path.exists(c)) else shutil.which(c)
        if p:
            return p
    return None


def html_to_pdf(html, pdf_path):
    """Печать HTML в кликабельный PDF через headless Chromium (ссылки сохраняются)."""
    chrome = find_chromium()
    if not chrome:
        raise RuntimeError("Chromium не найден. Укажи путь в env CHROMIUM_BIN — PDF не создан.")
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html)
        tmp = f.name
    try:
        cmd = [chrome, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
               f"--print-to-pdf={pdf_path}", "file://" + tmp]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if not (os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000):
            raise RuntimeError("Chromium не отрендерил PDF: " + (r.stderr or "")[-200:])
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def die_api(e):
    """Понятно сообщить об ошибке MPStats и выйти."""
    hint = ""
    if getattr(e, "code", None) == 429:
        hint = ("\n  → Исчерпан дневной лимит запросов MPStats. Подождите до завтра "
                "или поднимите тариф. Дерево категорий кэшируется, но срезы ниши требуют вызовов.")
    elif getattr(e, "code", None) in (401, 403):
        hint = ("\n  → Проверьте MPSTATS_TOKEN в .env и что домен mpstats.io разрешён "
                "сетевой политикой окружения.")
    print(f"ОШИБКА MPStats: {getattr(e,'code','?')} — {getattr(e,'message',str(e))}{hint}",
          file=sys.stderr)
    sys.exit(5)


def try_json(method, path, token, params=None, body=None):
    """Мягкий вызов: возвращает (data, None) или (None, 'текст ошибки')."""
    try:
        return curl_json(method, path, params=params, body=body, token=token), None
    except Exception as e:
        return None, str(e)[:200]


def get_categories(token):
    cache = os.path.join(tempfile.gettempdir(), "mpstats_wb_categories.json")
    if os.path.isfile(cache) and os.path.getsize(cache) > 1000:
        try:
            return json.load(open(cache, encoding="utf-8"))
        except Exception:
            pass
    data = curl_json("GET", "wb/get/categories", token=token)
    json.dump(data, open(cache, "w", encoding="utf-8"), ensure_ascii=False)
    return data


def resolve_path(cats, gender, item_kw, explicit=None):
    if explicit:
        return explicit, "задан явно", []
    root = GENDER_ROOT.get(gender)
    stem = item_kw.lower().strip()[:5]
    cands = []
    for c in cats:
        p = c.get("path", "")
        pl = p.lower()
        if root and not p.startswith(root):
            continue
        if stem not in pl:
            continue
        if any(n in pl for n in NOISE_ROOT):
            continue
        cands.append(p)
    if not cands:
        return None, f"категория под '{item_kw}' ({gender}) не найдена", []

    def score(p):
        segs = p.split("/")
        leaf = segs[-1].lower()
        exact_leaf = 0 if (leaf.startswith(stem) and len(leaf) <= len(stem) + 3) else 1
        last_match = 0 if stem in leaf else 1
        penalty = sum(1 for w in NOISE_SEG if w in p.lower())
        return (exact_leaf, last_match, penalty, len(segs), len(p))

    cands.sort(key=score)
    return cands[0], "подобрано автоматически", cands[1:5]


def pattern_stem(p):
    if not p:
        return None, None
    pl = p.lower().strip()
    for k, v in PATTERN_STEMS.items():
        if k in pl:
            return v, pl
    return pl, pl


def fetch_items(token, path, d1, d2, name_filter=None):
    params = {"path": path, "d1": d1, "d2": d2}
    fm = {}
    if name_filter:
        fm["name"] = {"filterType": "text", "type": "contains", "filter": name_filter}
    items, start, page = [], 0, 5000
    total = None
    while True:
        body = {"startRow": start, "endRow": start + page,
                "sort": [{"colId": "revenue", "sort": "desc"}], "filterModel": fm}
        r = curl_json("POST", "wb/get/category", params=params, body=body, token=token)
        chunk = r.get("data") or []
        total = r.get("total", len(chunk))
        items.extend(chunk)
        if len(chunk) < page or len(items) >= (total or 0):
            break
        start += page
    return items, total


# ======================= публичные API Wildberries (без квоты MPStats) =======================
# Фаза 2: слой данных. search.wb.ru — выдача по запросу; basket card.json — характеристики/слайды.
WB_UA = "Mozilla/5.0 (compatible; wb-analyze/1.0)"
WB_DEST = -1257786  # обобщённый регион доставки
_WB_CACHE = {}      # in-process кэш на время запуска


def _wb_curl(url, tries=4):
    """GET с распаковкой; ретраи на 429/пусто/HTML. Возвращает текст или None."""
    for i in range(tries):
        r = subprocess.run(["curl", "-sS", "-m", "20", "--compressed", "-H", f"User-Agent: {WB_UA}", url],
                           capture_output=True, text=True)
        t = (r.stdout or "").strip()
        if r.returncode == 0 and t and t[:1] in "{[":
            return t
        time.sleep(1.2 * (i + 1))
    return None


def wb_search(query, limit=30):
    """Выдача WB по запросу → нормализованные карточки конкурентов (без MPStats)."""
    ck = ("search", query, limit)
    if ck in _WB_CACHE:
        return _WB_CACHE[ck]
    q = urllib.parse.quote(query)
    url = (f"https://search.wb.ru/exactmatch/ru/common/v5/search?appType=1&curr=rub&dest={WB_DEST}"
           f"&query={q}&resultset=catalog&sort=popular&spp=30&limit={limit}")
    t = _wb_curl(url)
    out = []
    if t:
        try:
            d = json.loads(t)
            prods = (d.get("data") or {}).get("products") or d.get("products") or []
        except json.JSONDecodeError:
            prods = []
        for p in prods[:limit]:
            szs = p.get("sizes") or []
            price = (szs[0]["price"].get("product") / 100) if (szs and szs[0].get("price")) else 0
            out.append({"id": p.get("id"), "name": p.get("name"), "brand": p.get("brand"),
                        "seller": p.get("supplier"), "seller_id": p.get("supplierId"),
                        "colors": [c.get("name") for c in (p.get("colors") or [])],
                        "pics": p.get("pics"), "rating": p.get("reviewRating") or p.get("rating"),
                        "feedbacks": p.get("feedbacks"), "price": price, "root": p.get("root")})
    _WB_CACHE[ck] = out
    return out


# basket-хосты WB по vol (nm//100000); при промахе пробуем соседние
BASKET_RANGES = [(0, 143, '01'), (144, 287, '02'), (288, 431, '03'), (432, 719, '04'),
                 (720, 1007, '05'), (1008, 1061, '06'), (1062, 1115, '07'), (1116, 1169, '08'),
                 (1170, 1313, '09'), (1314, 1601, '10'), (1602, 1655, '11'), (1656, 1919, '12'),
                 (1920, 2045, '13'), (2046, 2189, '14'), (2190, 2405, '15'), (2406, 2621, '16'),
                 (2622, 2837, '17'), (2838, 3053, '18'), (3054, 3269, '19'), (3270, 3485, '20'),
                 (3486, 3701, '21'), (3702, 3917, '22'), (3918, 4133, '23'), (4134, 4349, '24'),
                 (4350, 4565, '25'), (4566, 4877, '26'), (4878, 5189, '27')]


def wb_basket_host(vol):
    for a, b, h in BASKET_RANGES:
        if a <= vol <= b:
            return h
    # новые (высокие) vol за пределами таблицы — экстраполируем ~250 vol на хост
    # (точный хост уточняется перебором соседей ±N в wb_basket_card)
    if vol > 5189:
        return str(28 + (vol - 5190) // 250)
    return '28'


def wb_basket_card(nm):
    """card.json карточки: характеристики (options), описание, цвета склейки, слайды. Кэш + фолбэк хостов."""
    ck = ("card", int(nm))
    if ck in _WB_CACHE:
        return _WB_CACHE[ck]
    nm = int(nm)
    vol, part = nm // 100000, nm // 1000
    h0 = int(wb_basket_host(vol))
    # правильный хост пробуем с ретраями (пережить 429), соседние — по разу.
    # Для новых (высоких) vol экстраполяция может промахнуться → шире соседи и выше потолок.
    order = [(f"{h0:02d}", 3)] + [(f"{h:02d}", 1)
                                  for h in (h0 - 1, h0 + 1, h0 - 2, h0 + 2, h0 - 3, h0 + 3) if 1 <= h <= 60]
    res = None
    for h, tries in order:
        t = _wb_curl(f"https://basket-{h}.wbbasket.ru/vol{vol}/part{part}/{nm}/info/ru/card.json", tries=tries)
        if t and t[:1] == "{":
            try:
                d = json.loads(t)
                d["_host"], d["_vol"], d["_part"] = h, vol, part
                res = d
                break
            except json.JSONDecodeError:
                pass
    _WB_CACHE[ck] = res
    return res


def wb_slide_urls(card, limit=5):
    if not card:
        return []
    nm = card.get("nm_id") or card.get("_nm")
    media = card.get("media") or {}
    n = media.get("photo_count") or limit
    h, vol, part = card["_host"], card["_vol"], card["_part"]
    return [f"https://basket-{h}.wbbasket.ru/vol{vol}/part{part}/{nm}/images/big/{i}.webp"
            for i in range(1, min(int(n or limit), limit) + 1)]


def wb_characteristics(card):
    """Плоский список видимых характеристик [(name,value)] из card.json."""
    if not card:
        return []
    opts = card.get("options")
    if isinstance(opts, list) and opts:
        return [(o.get("name"), o.get("value")) for o in opts if o.get("name")]
    out = []
    for g in (card.get("grouped_options") or []):
        for o in g.get("options", []):
            if o.get("name"):
                out.append((o.get("name"), o.get("value")))
    return out


def enrich_cards(cards):
    """Дотянуть по каждой карточке (по id) характеристики + слайды из WB. Best-effort, изменяет на месте."""
    got = 0
    for i, it in enumerate(cards):
        if not it.get("id"):
            continue
        if i:
            time.sleep(0.4)  # вежливость к CDN, чтобы не ловить 429
        card = wb_basket_card(it["id"])
        if card:
            it["_chars"] = wb_characteristics(card)
            it["_slides"] = wb_slide_urls(card)
            it["_descr"] = (card.get("description") or "")[:400]
            got += 1
    return got


import re as _re

TAIL_GENERIC = {"для", "в", "и", "с", "на", "из", "по", "от", "до", "не", "the", "a"}
TAIL_CATEGORY = {"рубашка", "рубашки", "рубашку", "блузка", "платье", "футболка", "джинсы",
                 "женская", "женский", "женские", "мужская", "мужской", "детская", "детский", "унисекс"}


def tail_words(cards, item, top_n=12):
    """Теги смыслов = частотные слова из НАЗВАНИЙ топ-карточек, кроме категории/пола/связок."""
    stop = set(TAIL_GENERIC) | set(TAIL_CATEGORY) | set((item or "").lower().split())
    cnt = defaultdict(int)
    for c in cards:
        for w in _re.findall(r"[а-яёa-z0-9]+", (c.get("name") or "").lower()):
            if len(w) >= 3 and w not in stop:
                cnt[w] += 1
    return sorted(cnt.items(), key=lambda kv: kv[1], reverse=True)[:top_n]


def char_matrix(cards, max_rows=12, max_cols=5):
    """Сравнение видимых характеристик топов: строки=характеристика, столбцы=карточки, +доминанта."""
    from collections import Counter
    per = []
    name_freq = Counter()
    for c in cards[:max_cols]:
        d = {n: v for n, v in (c.get("_chars") or []) if n}
        if not d:
            continue
        per.append(((c.get("name") or "—")[:22], d))
        for n in d:
            name_freq[n] += 1
    if not per:
        return None
    rows = [n for n, _ in name_freq.most_common(max_rows)]
    matrix = []
    for n in rows:
        vals = [d.get(n, "") for _, d in per]
        dom = Counter([v for v in vals if v]).most_common(1)
        matrix.append({"name": n, "values": vals, "dominant": dom[0][0] if dom else ""})
    return {"cols": [lbl for lbl, _ in per], "rows": matrix}


# ======================= утилиты чисел/форматов =======================
def num(x):
    try:
        return float(x) or 0.0
    except (TypeError, ValueError):
        return 0.0


def truthy(x):
    if isinstance(x, str):
        return x.strip().lower() not in ("", "0", "false", "нет", "no")
    return bool(x)


def median(xs):
    xs = sorted(v for v in xs if v is not None)
    n = len(xs)
    if not n:
        return 0.0
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def fmt_money(v):
    v = num(v)
    if v >= 1e6:
        return f"{v/1e6:.1f} млн ₽"
    if v >= 1e3:
        return f"{v/1e3:.0f} тыс ₽"
    return f"{v:.0f} ₽"


def fmt_int(v):
    return f"{num(v):,.0f}".replace(",", " ")


def esc_md(s):
    """Экранировать спецсимволы markdown-таблицы в ячейке."""
    return str(s if s is not None else "").replace("|", "\\|").replace("\n", " ").strip()


# ======================= аналитические блоки =======================
def aggregate(items, by):
    key = "seller" if by == "seller" else "brand"
    agg = defaultdict(lambda: {"rev": 0.0, "sales": 0.0, "items": 0, "lost": 0.0,
                               "stock": 0.0, "rating_w": 0.0, "comments": 0.0,
                               "brands": set(), "top_item": None})
    tot_rev = 0.0
    for it in items:
        k = (it.get(key) or "—").strip()
        a = agg[k]
        rev, sales = num(it.get("revenue")), num(it.get("sales"))
        a["rev"] += rev
        a["sales"] += sales
        a["items"] += 1
        a["lost"] += num(it.get("lost_profit"))
        a["stock"] += num(it.get("balance"))
        cm = num(it.get("comments"))
        a["comments"] += cm
        a["rating_w"] += num(it.get("rating")) * cm
        if it.get("brand"):
            a["brands"].add(it["brand"])
        if a["top_item"] is None or rev > num(a["top_item"].get("revenue")):
            a["top_item"] = it
        tot_rev += rev
    return agg, tot_rev


def price_zone(items):
    """«Привлекательная цена» = ценовой диапазон, собирающий максимум ВЫРУЧКИ.
    Возвращает медиану цены (по выручке), коридор и топ-ведро."""
    pr = [(num(it.get("final_price")), num(it.get("revenue"))) for it in items
          if num(it.get("final_price")) > 0]
    if not pr:
        return None
    prices = sorted(p for p, _ in pr)
    lo, hi = prices[int(len(prices) * 0.1)], prices[int(len(prices) * 0.9)]
    # ведро шириной ~15% от размаха, ищем окно с максимальной суммарной выручкой
    width = max((hi - lo) / 6.0, 1.0)
    buckets = defaultdict(float)
    for p, r in pr:
        buckets[int(p // width)] += r
    best_b = max(buckets, key=buckets.get)
    band = (best_b * width, (best_b + 1) * width)
    # медиана цены, взвешенная по выручке
    order = sorted(pr, key=lambda x: x[0])
    tot = sum(r for _, r in order) or 1.0
    acc, wmed = 0.0, order[-1][0]
    for p, r in order:
        acc += r
        if acc >= tot / 2:
            wmed = p
            break
    return {"lo": lo, "hi": hi, "wmedian": wmed, "band": band,
            "band_share": buckets[best_b] / (tot or 1) * 100}


def content_benchmark(items, k):
    """Медиана и лидер по контент/качественным метрикам среди топ-k SKU по выручке.
    Метрики без данных (ни у одной карточки поля нет) пропускаются — важно для каскадного
    режима, где часть контент-полей добирается по nmId, а часть недоступна."""
    top = sorted(items, key=lambda it: num(it.get("revenue")), reverse=True)[:k]
    if not top:
        return None
    def has(f):
        return any(it.get(f) is not None for it in top)
    def col(f):
        return [num(it.get(f)) for it in top]
    def leader(f):
        best = max(top, key=lambda it: num(it.get(f)))
        return num(best.get(f)), (best.get("name") or "")[:40], best.get("id")
    metrics = {"final_price": {"label": "Цена, ₽", "median": median(col("final_price"))}}
    if has("picscount"):
        metrics["picscount"] = {"label": "Фото, шт", "median": median(col("picscount")), "leader": leader("picscount")}
    if has("hasvideo"):
        metrics["hasvideo"] = {"label": "С видео, %", "share": 100 * sum(truthy(it.get("hasvideo")) for it in top) / len(top)}
    if has("has3d"):
        metrics["has3d"] = {"label": "С 3D, %", "share": 100 * sum(truthy(it.get("has3d")) for it in top) / len(top)}
    if has("description_length"):
        metrics["description_length"] = {"label": "Длина описания", "median": median(col("description_length"))}
    if has("rating"):
        metrics["rating"] = {"label": "Рейтинг", "median": median(col("rating")), "leader": leader("rating")}
    if has("comments"):
        metrics["comments"] = {"label": "Отзывов, шт", "median": median(col("comments")), "leader": leader("comments")}
    if has("latest_negative_comments_percent"):
        metrics["latest_negative_comments_percent"] = {"label": "Негатив, %", "median": median(col("latest_negative_comments_percent"))}
    if has("search_words_count"):
        metrics["search_words_count"] = {"label": "SEO-слов", "median": median(col("search_words_count")), "leader": leader("search_words_count")}
    return {"k": len(top), "metrics": metrics}


def color_distribution(items, agg, by, players_n, top_n=8):
    """Реальная раскладка цветов по СКЛЕЙКАМ выбранных ТОП-игроков.

    Берём все SKU (цветовые вариации) топ-N продавцов/брендов из блока B и агрегируем цвет по
    ВЫРУЧКЕ. Возвращаем top_n цветов + сколько из топ-игроков предлагают каждый цвет (широта)."""
    key = "seller" if by == "seller" else "brand"
    top_names = {n for n, _ in sorted(agg.items(), key=lambda kv: kv[1]["rev"], reverse=True)[:players_n]}
    rev = defaultdict(float)
    cnt = defaultdict(int)
    who = defaultdict(set)
    tot = 0.0
    for it in items:
        owner = (it.get(key) or "—").strip()
        if owner not in top_names:
            continue
        c = (it.get("color") or "—").strip() or "—"
        r = num(it.get("revenue"))
        rev[c] += r
        cnt[c] += 1
        who[c].add(owner)
        tot += r
    ranked = sorted(rev.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    return [{"color": c, "rev_share": (r / tot * 100 if tot else 0),
             "skus": cnt[c], "players": len(who[c])} for c, r in ranked]


def seasonality(trend):
    """Из wb/get/category/trends оценить динамику (2-я половина периода vs 1-я)."""
    rows = trend.get("data") if isinstance(trend, dict) else trend
    if not isinstance(rows, list) or len(rows) < 4:
        return None
    def rev(r):
        for f in ("revenue", "sales", "sum", "orders"):
            if f in r:
                return num(r[f])
        return 0.0
    vals = [rev(r) for r in rows if isinstance(r, dict)]
    vals = [v for v in vals if v]
    if len(vals) < 4:
        return None
    h = len(vals) // 2
    first, second = sum(vals[:h]), sum(vals[h:])
    if not first:
        return None
    return {"delta_pct": (second - first) / first * 100}


def cards_for_review(items, agg, by, n):
    """Топ-N уникальных карточек (по одному хиту на игрока) под ручной разбор листинга."""
    ranked = sorted(agg.items(), key=lambda kv: kv[1]["rev"], reverse=True)
    out, seen = [], set()
    for name, v in ranked:
        it = v.get("top_item") or {}
        sid = it.get("id")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(it)
        if len(out) >= n:
            break
    return out


def profile_sku(items, sku):
    for it in items:
        if str(it.get("id")) == str(sku):
            return it
    return None


# ======================= каскадный вход ([1] ТОП по фразе + [2] воронка) =======================
def load_items_json(pathfile):
    """Читает отчёт инструмента [1] (ТОП по фразе, wb-top-keywords) и маппит его в форму item
    движка. Возвращает (items, meta). meta = {query, d1, d2, total, seasonality_delta}."""
    with open(pathfile, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):          # на случай голого массива rivals
        rivals, meta = data, {}
    else:
        rivals = data.get("rivals") or data.get("items") or []
        meta = data
    items = []
    for r in rivals:
        price = num(r.get("price")) or num(r.get("avgSalePrice"))
        items.append({
            "id": str(r.get("nmId") or r.get("id") or ""),
            "name": r.get("name"), "brand": r.get("brand"),
            "seller": r.get("brand"),        # у [1] нет продавца — владельца берём по бренду
            "color": r.get("color"),
            "final_price": price, "revenue": num(r.get("revenue")), "sales": num(r.get("sales")),
            "rating": num(r.get("rating")), "comments": num(r.get("reviews")),
            "lost_profit": num(r.get("lostProfit")), "_thumb": r.get("thumb"),
            # picscount/hasvideo/description_length дозаполняются enrich_content по nmId
        })
    period = meta.get("period") or {}
    seas = (meta.get("_meta") or {}).get("seasonality") or meta.get("seasonality") or {}
    return items, {
        "query": meta.get("query"), "d1": period.get("d1"), "d2": period.get("d2"),
        "total": meta.get("total"),
        "seasonality_delta": seas.get("delta_pct") if isinstance(seas, dict) else None,
    }


def enrich_content(items, n):
    """Дозаполняет контентные поля топ-n item-ов из card.json WB (picscount, hasvideo,
    description_length) + характеристики/слайды. Best-effort, изменяет на месте. Счётчик успехов."""
    top = sorted(items, key=lambda it: num(it.get("revenue")), reverse=True)[:n]
    got = 0
    for i, it in enumerate(top):
        if not it.get("id"):
            continue
        if i:
            time.sleep(0.4)  # вежливость к CDN
        card = wb_basket_card(it["id"])
        if not card:
            continue
        media = card.get("media") or {}
        photos = media.get("photo_count") or len(media.get("photos") or [])
        it["picscount"] = photos or None
        it["hasvideo"] = 1 if media.get("has_video") else 0
        it["description_length"] = len(card.get("description") or "")
        it["_chars"] = wb_characteristics(card)
        it["_slides"] = wb_slide_urls(card)
        it["_descr"] = (card.get("description") or "")[:400]
        got += 1
    return got


FUNNEL_LABELS = {"ctr": "CTR (клик по показу)", "cart": "Конв. в корзину",
                 "order": "Конв. в заказ", "buyout": "Выкуп"}


def load_funnel_json(pathfile):
    """Читает отчёт инструмента [2] (Сравнение карточек, wb-cards-compare) → воронка наш vs
    конкуренты. Возвращает dict: строки, планка (медиана конкурентов), наша карточка (для блока G)."""
    with open(pathfile, encoding="utf-8") as f:
        data = json.load(f)
    rows, rivals, our = [], [], None
    for a in (data.get("articles") or []):
        cur = a.get("current") or {}
        row = {
            "nm": str(a.get("nmId") or ""), "name": a.get("name") or "", "is_our": bool(a.get("isOur")),
            "showings": num(cur.get("showings")), "ctr": num(cur.get("ctrPct")),
            "cart": num(cur.get("cartConvPct")), "order": num(cur.get("orderConvPct")),
            "buyout": num(cur.get("buyoutPct")), "position": num(cur.get("avgSearchPosition")),
            "price": num(cur.get("medianPrice")),
            "rating": num(cur.get("reviewRating")) or num(cur.get("cardRating")),
            "reviews": num(cur.get("reviewCount")),
        }
        rows.append(row)
        (rivals if not row["is_our"] else []).append(row)
        if row["is_our"]:
            our = row
    def med(key):
        vals = [r[key] for r in rivals if r.get(key)]
        return median(vals) if vals else 0
    planka = {k: med(k) for k in ("ctr", "cart", "order", "buyout", "showings", "position")}
    mine = None
    if our:
        mine = {"id": our["nm"], "name": our["name"], "final_price": our["price"], "color": None,
                "rating": our["rating"], "comments": our["reviews"], "_funnel": our}
    return {"rows": rows, "our": our, "rivals": rivals, "planka": planka,
            "mine": mine, "periods": data.get("periods")}


def funnel_gaps(our, planka):
    """Гэпы воронки: где наша конверсия/видимость ниже медианы конкурентов → цель дотянуть."""
    if not our:
        return []
    out = []
    for key in ("ctr", "cart", "order", "buyout"):
        mine_v, plan_v = our.get(key, 0), planka.get(key, 0)
        if plan_v and mine_v < plan_v:
            out.append(f"{FUNNEL_LABELS[key]}: {mine_v:.0f}% < медианы ниши {plan_v:.0f}% — цель ≥ {plan_v:.0f}%")
    if planka.get("showings") and our.get("showings", 0) < planka["showings"]:
        pos_txt = (f" (позиция {fmt_int(our.get('position'))} → цель ≤ {fmt_int(planka.get('position'))})"
                   if our.get("position") and planka.get("position") else "")
        out.append(f"Показов {fmt_int(our['showings'])} < медианы ниши {fmt_int(planka['showings'])} "
                   f"— поднять видимость{pos_txt}")
    return out


# ======================= юнит-экономика (ядро, база под UNIT-калькулятор) =======================
# Модель (со слов пользователя, подтверждено):
#   S — цена продавца БЕЗ СПП (наша база маржи и комиссии).  P — цена покупателя С СПП (как в MPStats).
#   P = S·(1 − спп)  ⇔  S = P / (1 − спп).
#   Комиссия ВБ (до СПП) — от S.  Эквайринг, налог, ДРР — от P (с СПП).  Брак — от себестоимости.
#   Логистика/хранение = 0 (индивидуальные условия).  Маржа % = операционная прибыль / S.
ECON_DEFAULTS = dict(
    commission=0.357,   # комиссия ВБ до СПП
    spp=0.04,           # средняя СПП
    acquiring=0.047,    # эквайринг
    tax=0.02,           # налог (от цены с СПП)
    drr_launch=0.30,    # ДРР первые недели
    drr_steady=0.08,    # ДРР на выходе
    defect=0.025,       # брак (от себестоимости)
    redemption=0.36,    # выкуп (для оценки объёма, не статья затрат)
    logistics=0.0, storage=0.0,   # ₽/ед (общий вид, у нас 0)
    m_min=0.25, m_max=0.30,       # целевой коридор маржи
)


def econ_params(**over):
    p = dict(ECON_DEFAULTS)
    p.update({k: v for k, v in over.items() if v is not None})
    return p


def unit_calc(P_buyer, cost, pr, drr):
    """Разложение экономики на единицу при цене покупателя P_buyer (с СПП) и данном ДРР."""
    P = num(P_buyer)
    S = P / (1 - pr["spp"]) if (1 - pr["spp"]) else P          # цена продавца без СПП
    commission = pr["commission"] * S
    acquiring = pr["acquiring"] * P
    tax = pr["tax"] * P
    ad = drr * P
    defect = pr["defect"] * cost
    fixed = pr["logistics"] + pr["storage"]
    profit = S - commission - acquiring - tax - ad - defect - cost - fixed
    return {"P": P, "S": S, "commission": commission, "acquiring": acquiring, "tax": tax,
            "ad": ad, "defect": defect, "cost": cost, "fixed": fixed,
            "profit": profit, "margin": (profit / S if S else 0.0)}


def price_buyer_for_margin(cost, pr, m, drr):
    """Цена покупателя P (с СПП), при которой маржа = m при данном ДРР. None — недостижимо."""
    k = 1 - pr["commission"] - (pr["acquiring"] + pr["tax"] + drr) * (1 - pr["spp"])
    fixedc = cost * (1 + pr["defect"]) + pr["logistics"] + pr["storage"]
    denom = k - m
    if denom <= 0:
        return None
    S = fixedc / denom
    return S * (1 - pr["spp"])


def price_segments(items, cost, pr, n=6):
    """Ниша по ценовым сегментам + наша маржа/прибыль в каждом (фаза «выход»)."""
    rows = [(num(it.get("final_price")), num(it.get("sales")), num(it.get("revenue")),
             num(it.get("rating")), num(it.get("comments")))
            for it in items if num(it.get("final_price")) > 0]
    rows.sort(key=lambda x: x[0])
    m = len(rows)
    if m == 0:
        return []
    n = min(n, m)
    total_rev = sum(r[2] for r in rows) or 1.0
    segs = []
    for i in range(n):
        grp = rows[i * m // n:(i + 1) * m // n]
        if not grp:
            continue
        prices = [g[0] for g in grp]
        orders = [g[1] for g in grp]
        cw = sum(g[4] for g in grp)
        rat = (sum(g[3] * g[4] for g in grp) / cw) if cw else (sum(g[3] for g in grp) / len(grp))
        rep = median(prices)
        c = unit_calc(rep, cost, pr, pr["drr_steady"])
        redeemed = median(orders) * pr["redemption"]
        segs.append({"p_lo": min(prices), "p_hi": max(prices), "skus": len(grp),
                     "rev_share": sum(g[2] for g in grp) / total_rev * 100,
                     "median_orders": median(orders), "rating": rat, "rep_price": rep,
                     "margin": c["margin"], "profit_unit": c["profit"],
                     "proj_profit": c["profit"] * redeemed})
    return segs


def compute_economics(items, cost, pr):
    """Всё для блока C и (позже) UNIT-калькулятора. cost — себестоимость (landed до склада WB)."""
    d = pr["drr_steady"]
    corridor = (price_buyer_for_margin(cost, pr, pr["m_min"], d),
                price_buyer_for_margin(cost, pr, pr["m_max"], d))
    # маржа в фазе запуска при ценах целевого коридора
    launch_at = []
    for P in corridor:
        launch_at.append(unit_calc(P, cost, pr, pr["drr_launch"])["margin"] if P else None)
    segs = price_segments(items, cost, pr)
    good = [s for s in segs if s["margin"] >= pr["m_min"] and s["median_orders"] > 0]
    # заработок за период в целевом сегменте: берём прибыльный сегмент с макс. прогнозом
    best = max(good, key=lambda s: s["proj_profit"]) if good else None
    target_earnings = None
    if best:
        redeemed = best["median_orders"] * pr["redemption"]
        target_earnings = {
            "p_lo": best["p_lo"], "p_hi": best["p_hi"], "median_orders": best["median_orders"],
            "redeemed_units": redeemed, "profit_unit": best["profit_unit"],
            "proj_profit": best["proj_profit"], "proj_revenue": best["rep_price"] * redeemed,
        }
    return {"cost": cost, "pr": pr,
            "breakeven": price_buyer_for_margin(cost, pr, 0.0, d),
            "breakeven_launch": price_buyer_for_margin(cost, pr, 0.0, pr["drr_launch"]),
            "corridor": corridor, "launch_margin_at_corridor": launch_at,
            "stack": unit_calc(corridor[0] or median([num(it.get("final_price")) for it in items]),
                               cost, pr, d),
            "segments": segs, "good_segments": good, "target_earnings": target_earnings}


# ======================= сборка отчёта =======================
def build_report(args, path, path_note, name_filter, items, total, agg, tot_rev,
                 pz, cb, colors, seas, review, mine, notes, econ=None, kw=None, wbd=None, funnel=None):
    by_label = "продавцам" if args.by == "seller" else "брендам"
    ranked = sorted(agg.items(), key=lambda kv: kv[1]["rev"], reverse=True)
    top = ranked[:args.top]
    top_share = sum(v["rev"] for _, v in top) / tot_rev * 100 if tot_rev else 0
    L = []

    # --- шапка ---
    title = args.query or (name_filter or path.split('/')[-1])
    L += [f"# Конкурентный анализ WB — {title}", "",
          f"**Ниша:** `{path}`  ",
          (f"**Фильтр (принт/паттерн):** название содержит «{name_filter}»  " if name_filter else ""),
          f"**Период:** {args.d1} — {args.d2} ({args.days} дн) · **срез:** ТОП-{args.top} по {by_label}", ""]

    # --- A. Ёмкость / концентрация / сезонность ---
    conc = ("высокая концентрация — вход тесный" if top_share >= 60
            else "ниша раздроблена — есть вход" if top_share < 40 else "умеренная концентрация")
    L += ["## A. Ёмкость и концентрация",
          f"- SKU в срезе: **{fmt_int(len(items))}** · {'продавцов' if args.by=='seller' else 'брендов'}: **{fmt_int(len(agg))}**",
          f"- Суммарная выручка: **{fmt_money(tot_rev)}** за период",
          f"- Доля ТОП-{args.top}: **{top_share:.1f}%** ({conc})"]
    if seas:
        d = seas["delta_pct"]
        arrow = "растёт ↑" if d > 8 else "падает ↓" if d < -8 else "стабильна →"
        L.append(f"- Динамика спроса в периоде: **{arrow}** ({d:+.0f}% 2-я половина к 1-й) — учитывать сезон")
    L.append("")

    # --- B. ТОП конкурентов ---
    L += [f"## B. ТОП-{args.top} конкурентов (деньги)", "",
          "| # | " + ("Продавец" if args.by == "seller" else "Бренд") +
          " | Выручка | Доля | Продажи | Ср. цена | SKU | Рейтинг | Упущено |",
          "|---|---|--:|:--:|--:|--:|--:|--:|--:|"]
    for i, (name, v) in enumerate(top, 1):
        avg_price = v["rev"] / v["sales"] if v["sales"] else 0
        rating = v["rating_w"] / v["comments"] if v["comments"] else 0
        share = v["rev"] / tot_rev * 100 if tot_rev else 0
        L.append(f"| {i} | **{name}** | {fmt_money(v['rev'])} | {share:.1f}% | {fmt_int(v['sales'])} "
                 f"| {fmt_int(avg_price)} ₽ | {v['items']} | {rating:.2f} | {fmt_money(v['lost'])} |")
    L.append("")

    # --- B2. Конкуренты по ключевым запросам (выдача WB) ---
    if kw:
        top_sellers = {n for n, _ in top}
        L.append("## B2. Конкуренты из поиска по запросам (WB)")
        for q, cards in kw.items():
            if not cards:
                L += [f"**«{q}»** — выдача недоступна (429/пусто), повторить позже.", ""]
                continue
            L += [f"**«{q}»** — топ выдачи:", ""]
            for c in cards:
                new = " 🆕" if c.get("seller") not in top_sellers else ""
                L.append(f"- {(c.get('name') or '—')[:52]} — {c.get('seller') or '—'}{new} · "
                         f"{fmt_int(c.get('price'))} ₽ · ⭐{num(c.get('rating')):.1f} "
                         f"({fmt_int(c.get('feedbacks'))}) · фото {fmt_int(c.get('pics'))} · "
                         f"[карточка]({WB_CARD.format(c.get('id'))})")
            L.append("")
        L += ["> 🆕 = продавца нет в ТОП категории (блок B) — конкурент, которого «вниз по категории» "
              "не видно. Данные из публичной выдачи WB (популярность), без учёта СПП-фильтра.", ""]

    # --- C. Цена × юнит-экономика ---
    if econ:
        pr = econ["pr"]
        cor = econ["corridor"]
        cor_txt = (f"{fmt_int(cor[0])}–{fmt_int(cor[1])} ₽" if cor[0] and cor[1] else "недостижимо")
        lm = econ["launch_margin_at_corridor"]
        lm_txt = (f"{lm[0]*100:.0f}–{lm[1]*100:.0f}%" if lm[0] is not None and lm[1] is not None else "—")
        L += [f"## C. Цена × юнит-экономика (себестоимость {fmt_int(econ['cost'])} ₽)",
              f"- **Выгодный коридор цены (маржа {pr['m_min']*100:.0f}–{pr['m_max']*100:.0f}%, "
              f"ДРР {pr['drr_steady']*100:.0f}%): {cor_txt}** — цена на витрине (с СПП).",
              f"- Точка безубыточности: **{fmt_int(econ['breakeven'])} ₽** (ниже — минус на выходе).",
              f"- В фазе запуска (ДРР {pr['drr_launch']*100:.0f}%) маржа в этом коридоре ≈ **{lm_txt}** "
              f"(плановый инвест-период — «первые недели в ноль»).",
              f"- Для справки, «зона объёма» (где крутится максимум выручки): "
              f"**{fmt_int(pz['band'][0])}–{fmt_int(pz['band'][1])} ₽** ({pz['band_share']:.0f}% выручки) — "
              f"это НЕ цель, там объём, но не маржа." if pz else "", ""]
        # таблица сегментов
        if econ["segments"]:
            L += ["**Ценовые сегменты ниши × наша маржа** (фаза «выход»):", "",
                  "| Цена (с СПП) | SKU | Выручка | Заказов/SKU | Рейтинг | Наша маржа | Прибыль/ед | Прогноз ₽/период* |",
                  "|---|--:|--:|--:|--:|--:|--:|--:|"]
            for s in econ["segments"]:
                flag = "✅" if s["margin"] >= pr["m_min"] else ("⚠️" if s["margin"] >= 0 else "🔴")
                L.append(f"| {fmt_int(s['p_lo'])}–{fmt_int(s['p_hi'])} | {s['skus']} | "
                         f"{s['rev_share']:.0f}% | {fmt_int(s['median_orders'])} | {s['rating']:.2f} | "
                         f"{flag} {s['margin']*100:.0f}% | {fmt_int(s['profit_unit'])} ₽ | "
                         f"{fmt_int(s['proj_profit'])} ₽ |")
            L.append("")
        # вердикт
        good = econ["good_segments"]
        if good:
            lo = min(s["p_lo"] for s in good)
            hi = max(s["p_hi"] for s in good)
            best = max(good, key=lambda s: s["proj_profit"])
            L.append(f"> **Вердикт:** целиться в **{fmt_int(lo)}–{fmt_int(hi)} ₽** — тут маржа ≥ "
                     f"{pr['m_min']*100:.0f}% и есть спрос. Максимум прогнозной прибыли — сегмент "
                     f"**{fmt_int(best['p_lo'])}–{fmt_int(best['p_hi'])} ₽** "
                     f"({fmt_int(best['proj_profit'])} ₽/период на карточку).")
        else:
            L.append(f"> **Вердикт:** ни один сегмент со спросом не даёт маржу ≥ {pr['m_min']*100:.0f}% "
                     f"при себестоимости {fmt_int(econ['cost'])} ₽. Спрос сосредоточен ниже вашего порога. "
                     f"Варианты: снизить себестоимость, добавить ценность/премиум-позиционирование, "
                     f"или пересмотреть нишу.")
        te = econ.get("target_earnings")
        if te:
            L.append(f"- **Потенциальный заработок в целевом сегменте {fmt_int(te['p_lo'])}–{fmt_int(te['p_hi'])} ₽:** "
                     f"≈ **{fmt_money(te['proj_profit'])} прибыли за период** на карточку "
                     f"(при ~{fmt_int(te['median_orders'])} заказах → выкуп {pr['redemption']*100:.0f}% ≈ "
                     f"{fmt_int(te['redeemed_units'])} шт; выручка ≈ {fmt_money(te['proj_revenue'])}).")
        L += ["", "_*Прогноз = прибыль/ед × (заказы/SKU × выкуп "
              f"{pr['redemption']*100:.0f}%). MPStats-«продажи» приняты за ЗАКАЗЫ; перепроверить на живых данных._", ""]
    elif pz:
        L += ["## C. Цена (без юнит-экономики)",
              f"- Ценовой коридор ниши (10–90 перцентиль): **{fmt_int(pz['lo'])}–{fmt_int(pz['hi'])} ₽**",
              f"- Медиана по выручке (зона объёма): **{fmt_int(pz['wmedian'])} ₽**",
              "- ⚠️ Задай себестоимость (`--cost <руб>`), чтобы посчитать выгодный ценовой коридор по марже.", ""]

    # --- D. Принадлежность (прокси по цвету) ---
    if colors:
        L += [f"## D. Доминирующие цвета по склейкам ТОП-{args.top} (реальные продажи)",
              "| Цвет | Доля выручки | SKU | У скольких топов |", "|---|--:|--:|--:|"]
        for c in colors:
            L.append(f"| {c['color']} | {c['rev_share']:.0f}% | {c['skus']} | {c['players']} |")
        L += ["", "> Считается по всем цветовым вариациям (склейкам) выбранных ТОП-игроков, взвешенно по "
              "выручке. Цвет — важнейший критерий принадлежности (глава 13); «у скольких топов» = широта "
              "цвета в нише. Полный %-анализ признаков (капюшон/состав/размер) — Wildbox «топы поиска».", ""]

    # --- E. Контент-бенчмарк ---
    if cb:
        m = cb["metrics"]
        L += [f"## E. Контент-бенчмарк топа (по {cb['k']} сильнейшим SKU)",
              "| Метрика | Медиана топа | Лидер |", "|---|--:|---|"]
        dec = {"rating", "latest_negative_comments_percent"}  # метрики с десятыми

        def numf(key, v):
            return f"{num(v):.1f}" if key in dec else fmt_int(v)

        def row(key):
            d = m.get(key, {})
            if "share" in d:
                med = f"{d['share']:.0f}%"
                lead = "—"
            else:
                med = numf(key, d.get("median", 0))
                ld = d.get("leader")
                lead = f"{numf(key, ld[0])} · {ld[1]}" if ld else "—"
            return f"| {d.get('label', key)} | {med} | {lead} |"
        for key in ("picscount", "hasvideo", "has3d", "description_length",
                    "rating", "comments", "latest_negative_comments_percent", "search_words_count"):
            if key in m:
                L.append(row(key))
        L.append("")

    # --- F. Карточки под ручной разбор ---
    if review:
        L += ["## F. Карточки под ручной разбор (листинг/смыслы/полки)",
              "Скриншоты слайдов этих карточек — в таблицу-линейку (глава 04, ДЗ №2); "
              "инфографику — через метод полок/доски (глава 18).", ""]
        for it in review:
            sid = it.get("id")
            L.append(f"- **{(it.get('name') or '—')[:60]}** — {it.get('brand') or ''} · "
                     f"{fmt_int(it.get('final_price'))} ₽ · ⭐{num(it.get('rating')):.1f} "
                     f"({fmt_int(it.get('comments'))} отз.) · [карточка]({WB_CARD.format(sid)})")
        L.append("")

    # --- F2. Готовые данные по топам (смыслы · листинг · характеристики) ---
    if wbd:
        L.append("## F2. Готовые данные по топам (смыслы · листинг · характеристики)")
        if wbd.get("tails"):
            tags = ", ".join(f"{w} ({n})" for w, n in wbd["tails"])
            L += ["", f"**Смыслы — теги из хвостов запросов топов:** {tags}",
                  "> Частотные слова из названий топ-карточек (кроме категории/пола) = смыслы, на которые "
                  "они опираются. Частотные — выносить ВЫШЕ в листинге (глава 04)."]
        if any(it.get("_slides") for it in review):
            L += ["", "**Листинг топов — слайды (кликабельно):**"]
            for it in review:
                sl = it.get("_slides") or []
                if not sl:
                    continue
                links = " · ".join(f"[{i+1}]({u})" for i, u in enumerate(sl))
                L.append(f"- {(it.get('name') or '—')[:44]}: {links}")
        cm = wbd.get("charmatrix")
        if cm:
            L += ["", "**Характеристики топов (заполнить как доминанта):**", "",
                  "| Характеристика | " + " | ".join(esc_md(c) for c in cm["cols"]) + " | Доминанта |",
                  "|---" * (len(cm["cols"]) + 2) + "|"]
            for r in cm["rows"]:
                vals = " | ".join(esc_md((v or "—")[:20]) for v in r["values"])
                L.append(f"| {esc_md(r['name'])} | {vals} | **{esc_md((r['dominant'] or '—')[:20])}** |")
        L.append("")

    # --- G. Разбор своей карточки ---
    gaps = []
    if args.my_sku:
        L.append("## G. Ваша карточка против ниши")
        if not mine:
            L.append(f"- ⚠️ SKU `{args.my_sku}` не найден в этом срезе — проверьте артикул/категорию "
                     f"или задайте `--path` вручную. Гэп-анализ пропущен.")
        else:
            med_price = pz["wmedian"] if pz else 0
            cbm = cb["metrics"] if cb else {}
            med_pics = cbm.get("picscount", {}).get("median", 0)
            med_rating = cbm.get("rating", {}).get("median", 0)
            med_comments = cbm.get("comments", {}).get("median", 0)
            med_words = cbm.get("search_words_count", {}).get("median", 0)
            my_price = num(mine.get("final_price"))
            pics_txt = fmt_int(mine.get("picscount")) if mine.get("picscount") is not None else "н/д"
            vid_txt = ("да" if truthy(mine.get("hasvideo")) else "нет") if mine.get("hasvideo") is not None else "н/д"
            L += [f"- Название: {(mine.get('name') or '')[:70]}",
                  f"- Цена: **{fmt_int(my_price)} ₽** (медиана ниши {fmt_int(med_price)} ₽) · "
                  f"цвет: {mine.get('color') or '—'} · ⭐{num(mine.get('rating')):.1f} "
                  f"({fmt_int(mine.get('comments'))} отз.) · фото {pics_txt} · видео {vid_txt}"]
            # маржа при текущей цене
            if econ and my_price:
                pr = econ["pr"]
                u = unit_calc(my_price, econ["cost"], pr, pr["drr_steady"])
                mm = u["margin"] * 100
                L.append(f"- **Маржа при текущей цене: {mm:.0f}%** (прибыль {fmt_int(u['profit'])} ₽/ед, "
                         f"цель {pr['m_min']*100:.0f}–{pr['m_max']*100:.0f}%; ДРР {pr['drr_steady']*100:.0f}%).")
                if u["margin"] < pr["m_min"]:
                    if u["profit"] < 0:
                        gaps.append(f"Убыток при текущей цене ({fmt_int(u['profit'])} ₽/ед) — цена ниже "
                                    f"безубыточности {fmt_int(econ['breakeven'])} ₽")
                    else:
                        gaps.append(f"Маржа {mm:.0f}% < цели {pr['m_min']*100:.0f}% — поднять цену к коридору "
                                    f"{fmt_int(econ['corridor'][0])}–{fmt_int(econ['corridor'][1])} ₽ или снизить себестоимость")
            elif pz and my_price and not (pz["band"][0] <= my_price <= pz["band"][1]):
                where = "выше" if my_price > pz["band"][1] else "ниже"
                gaps.append(f"Цена {where} зоны объёма ({fmt_int(pz['band'][0])}–{fmt_int(pz['band'][1])} ₽) "
                            f"— задай --cost для расчёта по марже")
            if med_pics and mine.get("picscount") is not None and num(mine.get("picscount")) < med_pics:
                gaps.append(f"Фото {fmt_int(mine.get('picscount'))} < медианы {fmt_int(med_pics)} — довести листинг")
            hv_share = cbm.get("hasvideo", {}).get("share")
            if (hv_share is not None and mine.get("hasvideo") is not None
                    and not truthy(mine.get("hasvideo")) and hv_share >= 40):
                gaps.append(f"Нет видео, а у {hv_share:.0f}% топа оно есть — добавить")
            if med_rating and num(mine.get("rating")) and num(mine.get("rating")) < med_rating:
                gaps.append(f"Рейтинг {num(mine.get('rating')):.1f} < медианы {med_rating:.1f} — работать с отзывами/качеством")
            if med_comments and num(mine.get("comments")) < med_comments:
                gaps.append(f"Отзывов {fmt_int(mine.get('comments'))} < медианы {fmt_int(med_comments)} — набирать (глава 06)")
            if cb and med_words and num(mine.get("search_words_count")) < med_words:
                gaps.append(f"SEO-слов {fmt_int(mine.get('search_words_count'))} < медианы {fmt_int(med_words)} — расширить ядро (глава 11)")
            if colors:
                dom = {c["color"].lower() for c in colors[:3]}
                mc = (mine.get("color") or "").lower()
                if mc and mc not in dom:
                    gaps.append(f"Цвет «{mine.get('color')}» вне топ-3 ниши ({', '.join(c['color'] for c in colors[:3])}) "
                                f"— проверить принадлежность/оттенок (глава 13)")
            if not gaps:
                L.append("- ✅ По оцифрованным метрикам карточка на уровне ниши — фокус на визуал/смыслы (блок H).")
        L.append("")

    # --- G2. Сравнение карточек (воронка Шага 2) — перед планом ---
    if funnel and funnel.get("rows"):
        pk = funnel["planka"]
        L += ["## G2. Сравнение карточек — воронка (наш vs конкуренты)", "",
              "| Карточка | Показы | CTR | В корзину | В заказ | Выкуп | Позиция |",
              "|---|--:|--:|--:|--:|--:|--:|"]
        for r in funnel["rows"]:
            mark = " ⬅ наш" if r["is_our"] else ""
            nm = (r["name"] or r["nm"])[:32]
            L.append(f"| {nm}{mark} | {fmt_int(r['showings'])} | {r['ctr']:.0f}% | {r['cart']:.0f}% "
                     f"| {r['order']:.0f}% | {r['buyout']:.0f}% | {fmt_int(r['position'])} |")
        L.append(f"| **Медиана конкурентов (планка)** | {fmt_int(pk['showings'])} | {pk['ctr']:.0f}% "
                 f"| {pk['cart']:.0f}% | {pk['order']:.0f}% | {pk['buyout']:.0f}% | {fmt_int(pk['position'])} |")
        L += ["", "> Планка = медиана конкурентов по этапу. Цель — быть не ниже планки на каждом шаге "
              "воронки. Данные из кабинета WB (Сравнение карточек, инструмент [2]).", ""]
        # вороночные гэпы → в план (подраздел «Гэпы карточки»)
        gaps.extend(funnel_gaps(funnel.get("our"), pk))

    # --- H. План доработки ---
    L += ["## H. План доработки карточки", "",
          "### Гэпы карточки (метрики ниши + воронка [2])"]
    if args.my_sku and gaps:
        for g in gaps:
            L.append(f"- [ ] {g}")
    elif args.my_sku and mine:
        L.append("- Оцифрованных гэпов нет — см. ручной слой ниже.")
    else:
        L.append("- Не задан `--my-sku`: цели по цене/контенту берите из блоков C и E как бенчмарк.")
    if econ and econ["corridor"][0]:
        L.append(f"- [ ] Цена-цель: **{fmt_int(econ['corridor'][0])}–{fmt_int(econ['corridor'][1])} ₽** "
                 f"(маржа {econ['pr']['m_min']*100:.0f}–{econ['pr']['m_max']*100:.0f}%, не «зона объёма»)")
    elif pz:
        L.append(f"- [ ] Цена-цель: коридор **{fmt_int(pz['band'][0])}–{fmt_int(pz['band'][1])} ₽** "
                 f"(зона объёма — задай --cost для маржинального коридора)")
    if cb:
        cbm2 = cb["metrics"]
        parts = []
        if cbm2.get("picscount"):
            parts.append(f"фото ≥ **{fmt_int(cbm2['picscount']['median'])}**")
        if cbm2.get("hasvideo") is not None and "hasvideo" in cbm2:
            parts.append(f"видео {'обязательно' if cbm2['hasvideo']['share'] >= 40 else 'желательно'}")
        if cbm2.get("rating"):
            parts.append(f"рейтинг ≥ **{cbm2['rating']['median']:.1f}**")
        if parts:
            L.append("- [ ] Контент-цель: " + ", ".join(parts))

    f2 = " ✅ данные в блоке F2" if wbd else ""
    L += ["", "### Ручной слой",
          f"- [ ] **Смыслы/листинг**{f2} — взять теги хвостов и слайды топов (блок F2), "
          "перенести частотные смыслы выше в свой листинг (глава 04)",
          f"- [ ] **Характеристики**{f2} — заполнить как доминанта топов (блок F2); "
          "состав/конструктив 1-в-1 (главы 13/18)",
          "- [ ] **Принадлежность %** — Wildbox «топы поиска»: разложить товар на сегменты/подсегменты, "
          "проверить % присутствия признаков; < ~30% = вход в запрос закрыт (глава 13)",
          "- [ ] **Конверсии по запросам (ДЖЕМ)** — ДЖЕМ Competition (до 5 карточек): где конкурент "
          "сильнее в корзину/заказ → зайти в его листинг → повторить смысл (глава 04). "
          "Импорт выгрузки в отчёт — на след. шаге инструмента",
          "- [ ] **Полки/доска** — метод главы 18: кто чаще всех в полках топов = супер-карточка; "
          "брать её смыслы/инфографику. (авто-сбор похожих — планируется)",
          ""]

    # --- футер ---
    foot = ["---",
            "_Данные MPStats оценочные (восстановление продаж по остаткам/выкупам). "
            f"Фильтр по названию мог упустить карточки, где принт только на фото. Путь категории {path_note}._"]
    if notes:
        foot.append("_Недоступные срезы: " + "; ".join(notes) + "._")
    L += foot
    return "\n".join(x for x in L if x is not None), top, gaps


# ======================= HTML-отчёт (кликабельный, self-contained) =======================
def esc(s):
    return _html.escape("" if s is None else str(s))


CSS_REPORT = """
:root{--paper:#F5F0F1;--panel:#FDFAFB;--ink:#241C24;--muted:#7C6A75;--hair:#E7DBE1;
--accent:#B21E68;--accent2:#8E1651;--soft:rgba(178,30,104,.07);
--good:#3E7A55;--warn:#9A6A16;--bad:#B3402E;--shadow:rgba(40,20,35,.07);}
@media (prefers-color-scheme:dark){:root{--paper:#161019;--panel:#1E1623;--ink:#ECE3EA;
--muted:#A292A0;--hair:#352A39;--accent:#EA5DA0;--accent2:#F07FB6;--soft:rgba(234,93,160,.11);
--good:#6FB98A;--warn:#D8A24B;--bad:#E0745F;--shadow:rgba(0,0,0,.28);}}
:root[data-theme="light"]{--paper:#F5F0F1;--panel:#FDFAFB;--ink:#241C24;--muted:#7C6A75;--hair:#E7DBE1;--accent:#B21E68;--accent2:#8E1651;--soft:rgba(178,30,104,.07);--good:#3E7A55;--warn:#9A6A16;--bad:#B3402E;--shadow:rgba(40,20,35,.07);}
:root[data-theme="dark"]{--paper:#161019;--panel:#1E1623;--ink:#ECE3EA;--muted:#A292A0;--hair:#352A39;--accent:#EA5DA0;--accent2:#F07FB6;--soft:rgba(234,93,160,.11);--good:#6FB98A;--warn:#D8A24B;--bad:#E0745F;--shadow:rgba(0,0,0,.28);}
*{box-sizing:border-box;}
body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.55;-webkit-font-smoothing:antialiased;}
.wca{max-width:1080px;margin:0 auto;padding:clamp(18px,4vw,40px);}
.num{font-variant-numeric:tabular-nums;}
h1{font-family:Georgia,serif;font-size:clamp(1.55rem,4vw,2.3rem);line-height:1.1;margin:.15em 0 .1em;text-wrap:balance;}
h2{font-family:Georgia,serif;font-size:clamp(1.12rem,2.6vw,1.35rem);margin:0 0 .55rem;}
.eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin:0;}
.meta{color:var(--muted);font-size:.88rem;margin:.3rem 0 0;}
.meta code{background:var(--soft);padding:1px 6px;border-radius:5px;color:var(--ink);font-size:.85em;}
header.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:1px solid var(--hair);padding-bottom:16px;}
.toggle{font:inherit;font-size:.78rem;color:var(--muted);background:var(--panel);border:1px solid var(--hair);border-radius:99px;padding:6px 12px;cursor:pointer;white-space:nowrap;}
.toggle:hover{color:var(--accent);border-color:var(--accent);}
section{margin-top:clamp(24px,4vw,38px);}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--hair);border:1px solid var(--hair);border-radius:12px;overflow:hidden;}
.tile{background:var(--panel);padding:14px 16px;}
.tile .v{font-family:Georgia,serif;font-size:clamp(1.25rem,3vw,1.65rem);line-height:1;}
.tile .l{font-size:.71rem;color:var(--muted);margin-top:6px;}
.tbl-wrap{overflow-x:auto;border:1px solid var(--hair);border-radius:12px;}
table{border-collapse:collapse;width:100%;font-size:.87rem;}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--hair);white-space:nowrap;}
th{font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:600;background:var(--panel);}
tbody tr:last-child td{border-bottom:none;}
td.r,th.r{text-align:right;}
tr:hover td{background:var(--soft);}
.rank{color:var(--accent);font-weight:700;}
.callouts{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;}
.callout{background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:15px 16px;box-shadow:0 1px 2px var(--shadow);}
.callout.hl{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset;}
.callout .k{font-size:.74rem;color:var(--muted);}
.callout .b{font-family:Georgia,serif;font-size:1.3rem;margin-top:4px;}
.callout .s{font-size:.76rem;color:var(--muted);margin-top:3px;}
.bars{display:flex;flex-direction:column;gap:8px;}
.bar-row{display:grid;grid-template-columns:110px 1fr 64px;gap:10px;align-items:center;font-size:.85rem;}
.bar{height:12px;background:var(--soft);border-radius:6px;overflow:hidden;}
.bar>span{display:block;height:100%;background:var(--accent);border-radius:6px;}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;}
a.pcard{display:flex;flex-direction:column;gap:6px;background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:14px;text-decoration:none;color:inherit;box-shadow:0 1px 2px var(--shadow);transition:border-color .15s,transform .15s;}
a.pcard:hover{border-color:var(--accent);transform:translateY(-2px);}
a.pcard .nm{font-weight:600;font-size:.88rem;line-height:1.3;}
a.pcard .st{font-size:.79rem;color:var(--muted);}
a.pcard .go{font-size:.74rem;color:var(--accent);margin-top:auto;}
.mycard{background:var(--panel);border:1px solid var(--hair);border-radius:12px;padding:16px 18px;}
.mycard .facts{font-size:.88rem;color:var(--muted);}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.chip{font-size:.8rem;padding:5px 11px;border-radius:99px;border:1px solid var(--hair);}
.chip.bad{color:var(--bad);border-color:var(--bad);}
.chip.ok{color:var(--good);border-color:var(--good);}
.val-bad{color:var(--bad);font-weight:600;}
.val-ok{color:var(--good);font-weight:600;}
.val-warn{color:var(--warn);font-weight:600;}
.tags{display:flex;flex-wrap:wrap;gap:7px;margin:6px 0 4px;}
.tag{font-size:.82rem;padding:4px 10px;border-radius:99px;background:var(--soft);border:1px solid var(--hair);}
.tag b{color:var(--accent);}
.listing{display:flex;flex-direction:column;gap:12px;margin-top:6px;}
.lrow .cap{font-size:.82rem;color:var(--muted);margin-bottom:5px;}
.slides{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;}
.slides a{flex:none;}
.slides img{height:120px;width:auto;border-radius:8px;border:1px solid var(--hair);display:block;}
.slides .slink{display:flex;align-items:center;justify-content:center;height:120px;min-width:56px;border:1px solid var(--hair);border-radius:8px;color:var(--accent);text-decoration:none;font-size:.85rem;background:var(--panel);}
.verdict{margin-top:12px;padding:12px 15px;border-radius:10px;border:1px solid var(--accent);background:var(--soft);font-size:.9rem;}
.verdict.bad{border-color:var(--bad);}
.mrow td{border-left:3px solid transparent;}
.mrow.ok td:first-child{border-left-color:var(--good);}
.mrow.warn td:first-child{border-left-color:var(--warn);}
.mrow.bad td:first-child{border-left-color:var(--bad);}
.plan{display:flex;flex-direction:column;gap:20px;}
.plan h3{font-size:.76rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 4px;display:flex;align-items:center;gap:8px;}
.plan h3::before{content:"";width:18px;height:2px;background:var(--accent);border-radius:2px;}
.check{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;}
.check li{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;}
.check li:hover{background:var(--soft);}
.check input{margin-top:2px;width:16px;height:16px;accent-color:var(--accent);flex:none;cursor:pointer;}
.check label{font-size:.9rem;cursor:pointer;}
.check label.done{text-decoration:line-through;color:var(--muted);}
.check .g{color:var(--muted);font-size:.82em;}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--hair);color:var(--muted);font-size:.8rem;}
@media (prefers-reduced-motion:reduce){*{transition:none!important;}}
@media print{
  :root{--paper:#fff;--panel:#fff;--ink:#1a141a;--muted:#5c5058;--hair:#d8ccd2;--soft:#faf3f7;}
  body{background:#fff;} .toggle{display:none;} .wca{max-width:none;padding:0;}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  section{break-inside:avoid;} .callout,.mycard,.tbl-wrap,a.pcard,.verdict,.plan>div{break-inside:avoid;}
  tr:hover td{background:none;} a{color:var(--accent2);}
}
"""

JS_REPORT = """
(function(){
  var host=document.querySelector('[data-report]'); if(!host) return;
  try{
    var K='wbca:'+host.getAttribute('data-report');
    var s=JSON.parse(localStorage.getItem(K)||'{}');
    host.querySelectorAll('.check input').forEach(function(b){
      var lab=document.querySelector('label[for="'+b.id+'"]');
      if(s[b.id]){b.checked=true; if(lab)lab.classList.add('done');}
      b.addEventListener('change',function(){
        s[b.id]=b.checked; localStorage.setItem(K,JSON.stringify(s));
        if(lab)lab.classList.toggle('done',b.checked);
      });
    });
  }catch(e){}
  var t=document.getElementById('wcaTheme');
  if(t)t.addEventListener('click',function(){
    var r=document.documentElement;
    var cur=r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
    r.setAttribute('data-theme',cur==='dark'?'light':'dark');
    t.textContent=cur==='dark'?'☀ Тема':'☾ Тема';
  });
})();
"""


def build_html(args, path, path_note, name_filter, items, agg, tot_rev, top,
               pz, cb, colors, seas, review, mine, gaps, notes, econ=None, kw=None, wbd=None,
               funnel=None, embed=False):
    title = args.query or (name_filter or path.split('/')[-1])
    by_label = "Продавец" if args.by == "seller" else "Бренд"
    top_share = sum(v["rev"] for _, v in top) / tot_rev * 100 if tot_rev else 0
    P = []

    # header
    toggle = "" if embed else '<button class="toggle" id="wcaTheme">☾ Тема</button>'
    P.append('<header class="top"><div>'
             '<p class="eyebrow">Конкурентный анализ · Wildberries</p>'
             f'<h1>{esc(title)}</h1>'
             f'<p class="meta">Ниша <code>{esc(path)}</code> · {esc(args.d1)}—{esc(args.d2)} '
             f'({args.days} дн) · срез по {"продавцам" if args.by=="seller" else "брендам"}</p>'
             f'</div>{toggle}</header>')

    # A. summary tiles
    tiles = [(fmt_int(len(items)), "SKU в срезе"),
             (fmt_int(len(agg)), "продавцов" if args.by == "seller" else "брендов"),
             (fmt_money(tot_rev), "выручка за период"),
             (f"{top_share:.0f}%", f"доля ТОП-{args.top}")]
    if seas:
        d = seas["delta_pct"]
        arrow = "↑" if d > 8 else "↓" if d < -8 else "→"
        cls = "val-ok" if d > 8 else "val-bad" if d < -8 else ""
        tiles.append((f'<span class="{cls}">{arrow} {d:+.0f}%</span>', "динамика спроса"))
    P.append('<section><div class="tiles">' +
             "".join(f'<div class="tile"><div class="v num">{v}</div><div class="l">{esc(l)}</div></div>'
                     for v, l in tiles) + '</div></section>')

    # B. top competitors
    rows = []
    for i, (name, v) in enumerate(top, 1):
        avg_price = v["rev"] / v["sales"] if v["sales"] else 0
        rating = v["rating_w"] / v["comments"] if v["comments"] else 0
        share = v["rev"] / tot_rev * 100 if tot_rev else 0
        rows.append(
            f'<tr><td class="rank">{i}</td><td>{esc(name)}</td>'
            f'<td class="r num">{fmt_money(v["rev"])}</td><td class="r num">{share:.1f}%</td>'
            f'<td class="r num">{fmt_int(v["sales"])}</td><td class="r num">{fmt_int(avg_price)} ₽</td>'
            f'<td class="r num">{v["items"]}</td><td class="r num">{rating:.2f}</td>'
            f'<td class="r num">{fmt_money(v["lost"])}</td></tr>')
    P.append('<section><h2>ТОП-{0} конкурентов</h2><div class="tbl-wrap"><table><thead><tr>'
             '<th class="r">#</th><th>{1}</th><th class="r">Выручка</th><th class="r">Доля</th>'
             '<th class="r">Продажи</th><th class="r">Ср. цена</th><th class="r">SKU</th>'
             '<th class="r">Рейтинг</th><th class="r">Упущено</th></tr></thead><tbody>'
             .format(args.top, by_label) + "".join(rows) + '</tbody></table></div></section>')

    # B2. keyword competitors (WB search)
    if kw:
        top_sellers = {n for n, _ in top}
        blocks = []
        for q, cards in kw.items():
            if not cards:
                blocks.append(f'<div><h3 style="margin:0 0 8px">«{esc(q)}»</h3>'
                              '<p class="meta">Выдача недоступна (429/пусто), повторить позже.</p></div>')
                continue
            cc = []
            for c in cards:
                new = '<span class="chip bad" style="padding:1px 7px;font-size:.7rem">🆕 не в ТОП</span>' \
                    if c.get("seller") not in top_sellers else ""
                cc.append(
                    f'<a class="pcard" href="{esc(WB_CARD.format(c.get("id")))}" target="_blank" rel="noopener">'
                    f'<div class="nm">{esc((c.get("name") or "—")[:60])}</div>'
                    f'<div class="st">{esc(c.get("seller") or "—")} · {fmt_int(c.get("price"))} ₽ · '
                    f'⭐{num(c.get("rating")):.1f} ({fmt_int(c.get("feedbacks"))}) · фото {fmt_int(c.get("pics"))}</div>'
                    f'<div class="go">{new} Открыть ↗</div></a>')
            blocks.append(f'<div style="margin-top:10px"><h3 style="margin:0 0 8px">«{esc(q)}»</h3>'
                          f'<div class="cards">{"".join(cc)}</div></div>')
        P.append('<section><h2>Конкуренты из поиска по запросам (WB)</h2>'
                 '<p class="meta">🆕 = продавца нет в ТОП категории (блок B) — тех, кого «вниз по категории» '
                 'не видно. Из публичной выдачи WB по популярности.</p>'
                 + "".join(blocks) + '</section>')

    # C. price × unit-economics
    if econ:
        pr = econ["pr"]
        cor = econ["corridor"]
        lm = econ["launch_margin_at_corridor"]
        cor_txt = f'{fmt_int(cor[0])}–{fmt_int(cor[1])} ₽' if cor[0] and cor[1] else "недостижимо"
        lm_txt = f'{lm[0]*100:.0f}–{lm[1]*100:.0f}%' if lm[0] is not None and lm[1] is not None else "—"
        vol = (f'{fmt_int(pz["band"][0])}–{fmt_int(pz["band"][1])} ₽' if pz else "—")
        callouts = (
            f'<div class="callout hl"><div class="k">Выгодный коридор · маржа '
            f'{pr["m_min"]*100:.0f}–{pr["m_max"]*100:.0f}% (ДРР {pr["drr_steady"]*100:.0f}%)</div>'
            f'<div class="b num">{cor_txt}</div><div class="s">цена на витрине (с СПП) · цель</div></div>'
            f'<div class="callout"><div class="k">Точка безубыточности</div>'
            f'<div class="b num">{fmt_int(econ["breakeven"])} ₽</div>'
            f'<div class="s">ниже — минус на выходе</div></div>'
            f'<div class="callout"><div class="k">Маржа в запуске (ДРР {pr["drr_launch"]*100:.0f}%)</div>'
            f'<div class="b num">{lm_txt}</div><div class="s">инвест-период, «первые недели в ноль»</div></div>'
            f'<div class="callout"><div class="k">Зона объёма (не цель)</div>'
            f'<div class="b num">{vol}</div><div class="s">где выручка, но не маржа</div></div>')
        te = econ.get("target_earnings")
        if te:
            callouts += (f'<div class="callout hl"><div class="k">Заработок в целевом сегменте '
                         f'{fmt_int(te["p_lo"])}–{fmt_int(te["p_hi"])} ₽</div>'
                         f'<div class="b num">{fmt_money(te["proj_profit"])}/период</div>'
                         f'<div class="s">≈{fmt_int(te["median_orders"])} заказов · выручка ≈ '
                         f'{fmt_money(te["proj_revenue"])}</div></div>')
        # сегменты
        seg_html = ""
        if econ["segments"]:
            trs = []
            for s in econ["segments"]:
                cls = "ok" if s["margin"] >= pr["m_min"] else ("warn" if s["margin"] >= 0 else "bad")
                mcls = "val-ok" if cls == "ok" else ("val-warn" if cls == "warn" else "val-bad")
                trs.append(
                    f'<tr class="mrow {cls}"><td class="num">{fmt_int(s["p_lo"])}–{fmt_int(s["p_hi"])}</td>'
                    f'<td class="r num">{s["skus"]}</td><td class="r num">{s["rev_share"]:.0f}%</td>'
                    f'<td class="r num">{fmt_int(s["median_orders"])}</td><td class="r num">{s["rating"]:.2f}</td>'
                    f'<td class="r num {mcls}">{s["margin"]*100:.0f}%</td>'
                    f'<td class="r num">{fmt_int(s["profit_unit"])} ₽</td>'
                    f'<td class="r num">{fmt_int(s["proj_profit"])} ₽</td></tr>')
            seg_html = ('<div class="tbl-wrap" style="margin-top:14px"><table><thead><tr>'
                        '<th>Цена (с СПП)</th><th class="r">SKU</th><th class="r">Выручка</th>'
                        '<th class="r">Заказов/SKU</th><th class="r">Рейтинг</th><th class="r">Маржа</th>'
                        '<th class="r">Прибыль/ед</th><th class="r">Прогноз/период</th></tr></thead>'
                        f'<tbody>{"".join(trs)}</tbody></table></div>')
        # вердикт
        good = econ["good_segments"]
        if good:
            lo = min(s["p_lo"] for s in good); hi = max(s["p_hi"] for s in good)
            best = max(good, key=lambda s: s["proj_profit"])
            verdict = (f'<div class="verdict"><b>Вердикт:</b> целиться в <b>{fmt_int(lo)}–{fmt_int(hi)} ₽</b> '
                       f'— маржа ≥ {pr["m_min"]*100:.0f}% и есть спрос. Максимум прогнозной прибыли — сегмент '
                       f'<b>{fmt_int(best["p_lo"])}–{fmt_int(best["p_hi"])} ₽</b> '
                       f'({fmt_int(best["proj_profit"])} ₽/период на карточку).</div>')
        else:
            verdict = (f'<div class="verdict bad"><b>Вердикт:</b> ни один сегмент со спросом не даёт маржу '
                       f'≥ {pr["m_min"]*100:.0f}% при себестоимости {fmt_int(econ["cost"])} ₽. Спрос ниже вашего '
                       f'порога. Варианты: снизить себестоимость, добавить ценность/премиум или сменить нишу.</div>')
        P.append(f'<section><h2>Цена × юнит-экономика (себестоимость {fmt_int(econ["cost"])} ₽)</h2>'
                 f'<div class="callouts">{callouts}</div>{seg_html}{verdict}'
                 f'<p class="meta">Прогноз = прибыль/ед × (заказы/SKU × выкуп {pr["redemption"]*100:.0f}%). '
                 f'MPStats-«продажи» приняты за заказы — перепроверить на живых данных.</p></section>')
    elif pz:
        P.append('<section><h2>Цена</h2><div class="callouts">'
                 f'<div class="callout"><div class="k">Ценовой коридор (10–90 перцентиль)</div>'
                 f'<div class="b num">{fmt_int(pz["lo"])}–{fmt_int(pz["hi"])} ₽</div></div>'
                 f'<div class="callout"><div class="k">Медиана по выручке (зона объёма)</div>'
                 f'<div class="b num">{fmt_int(pz["wmedian"])} ₽</div></div></div>'
                 '<p class="meta">⚠️ Задай себестоимость (--cost), чтобы посчитать выгодный ценовой коридор '
                 'по марже.</p></section>')

    # D. colors — по склейкам выбранных топов (реальные продажи)
    if colors:
        mx = max((c["rev_share"] for c in colors), default=1) or 1
        bars = "".join(
            f'<div class="bar-row"><span>{esc(c["color"])}</span>'
            f'<span class="bar"><span style="width:{c["rev_share"]/mx*100:.0f}%"></span></span>'
            f'<span class="num" style="text-align:right">{c["rev_share"]:.0f}% · {c["skus"]} SKU · '
            f'{c["players"]}/{args.top} топ</span></div>'
            for c in colors)
        P.append(f'<section><h2>Доминирующие цвета по склейкам ТОП-{args.top} (реальные продажи)</h2>'
                 f'<div class="bars">{bars}</div>'
                 '<p class="meta">По всем цветовым вариациям склеек выбранных топов, взвешенно по выручке. '
                 '«N/топ» = у скольких топ-игроков есть цвет (широта). Полный %-анализ признаков — '
                 'Wildbox «топы поиска» (см. план).</p></section>')

    # E. content benchmark (+ Ваше if mine)
    if cb:
        m = cb["metrics"]
        dec = {"rating", "latest_negative_comments_percent"}
        specs = [("picscount", "hi"), ("hasvideo", "bool"), ("has3d", "bool"),
                 ("description_length", None), ("rating", "hi"), ("comments", "hi"),
                 ("latest_negative_comments_percent", "lo"), ("search_words_count", "hi")]
        head = '<th>Метрика</th><th class="r">Медиана топа</th><th>Лидер</th>'
        if mine:
            head += '<th class="r">Ваше</th>'
        trs = []
        for key, direction in specs:
            d = m.get(key)
            if not d:
                continue
            fmtv = (lambda x: f"{num(x):.1f}") if key in dec else (lambda x: fmt_int(x))
            if "share" in d:
                med = f'{d["share"]:.0f}%'
                lead = "—"
            else:
                med = fmtv(d.get("median", 0))
                ld = d.get("leader")
                lead = f'{fmtv(ld[0])} · {esc(ld[1])}' if ld else "—"
            cell = ""
            if mine:
                if d.get("share") is not None:  # bool metric
                    yes = truthy(mine.get(key))
                    good = yes if d["share"] >= 40 else True
                    cell = f'<td class="r {"val-ok" if yes else ("val-bad" if not good else "")}">{"да" if yes else "нет"}</td>'
                elif mine.get(key) is None:
                    cell = '<td class="r num">н/д</td>'
                else:
                    mv = num(mine.get(key))
                    med_v = num(d.get("median", 0))
                    bad = (direction == "hi" and mv < med_v) or (direction == "lo" and mv > med_v)
                    cls = "val-bad" if bad else ("val-ok" if direction and mv else "")
                    cell = f'<td class="r num {cls}">{fmtv(mv)}</td>'
            trs.append(f'<tr><td>{esc(d.get("label", key))}</td><td class="r num">{med}</td>'
                       f'<td class="num">{lead}</td>{cell}</tr>')
        P.append(f'<section><h2>Контент-бенчмарк топа (по {cb["k"]} SKU)</h2>'
                 f'<div class="tbl-wrap"><table><thead><tr>{head}</tr></thead>'
                 f'<tbody>{"".join(trs)}</tbody></table></div></section>')

    # G. my card
    if args.my_sku:
        if mine:
            pics_t = fmt_int(mine.get("picscount")) if mine.get("picscount") is not None else "н/д"
            vid_t = ("да" if truthy(mine.get("hasvideo")) else "нет") if mine.get("hasvideo") is not None else "н/д"
            facts = (f'Цена {fmt_int(mine.get("final_price"))} ₽ · цвет {esc(mine.get("color") or "—")} · '
                     f'⭐{num(mine.get("rating")):.1f} ({fmt_int(mine.get("comments"))} отз.) · '
                     f'фото {pics_t} · видео {vid_t}')
            marg = ""
            if econ and num(mine.get("final_price")):
                pr = econ["pr"]
                u = unit_calc(num(mine.get("final_price")), econ["cost"], pr, pr["drr_steady"])
                mcls = "val-ok" if u["margin"] >= pr["m_min"] else ("val-warn" if u["margin"] >= 0 else "val-bad")
                marg = (f'<div class="facts" style="margin-top:6px">Маржа при текущей цене: '
                        f'<span class="{mcls}">{u["margin"]*100:.0f}%</span> '
                        f'(прибыль {fmt_int(u["profit"])} ₽/ед · цель {pr["m_min"]*100:.0f}–{pr["m_max"]*100:.0f}%)</div>')
            if gaps:
                chips = "".join(f'<span class="chip bad">{esc(g.split(" —")[0].split(" (")[0])}</span>' for g in gaps)
            else:
                chips = '<span class="chip ok">По метрикам на уровне ниши</span>'
            P.append('<section><h2>Ваша карточка против ниши</h2><div class="mycard">'
                     f'<div style="font-weight:600">{esc((mine.get("name") or "")[:80])}</div>'
                     f'<div class="facts">{facts}</div>{marg}<div class="chips">{chips}</div></div></section>')
        else:
            P.append(f'<section><h2>Ваша карточка</h2><div class="mycard">'
                     f'<div class="facts">⚠️ SKU <b>{esc(args.my_sku)}</b> не найден в этом срезе — '
                     f'проверьте артикул/категорию (--path).</div></div></section>')

    # F. review cards
    if review:
        cards = []
        for it in review:
            url = WB_CARD.format(it.get("id"))
            cards.append(
                f'<a class="pcard" href="{esc(url)}" target="_blank" rel="noopener">'
                f'<div class="nm">{esc((it.get("name") or "—")[:70])}</div>'
                f'<div class="st">{esc(it.get("brand") or "")} · {fmt_int(it.get("final_price"))} ₽ · '
                f'⭐{num(it.get("rating")):.1f} ({fmt_int(it.get("comments"))})</div>'
                f'<div class="go">Открыть на WB ↗</div></a>')
        P.append('<section><h2>Карточки под ручной разбор</h2>'
                 '<p class="meta">Скриншоты слайдов — в таблицу-линейку (гл. 04); инфографику — методом '
                 'полок/доски (гл. 18).</p>'
                 f'<div class="cards">{"".join(cards)}</div></section>')

    # F2. готовые данные по топам (смыслы / листинг / характеристики)
    if wbd:
        parts = ['<section><h2>Готовые данные по топам — смыслы · листинг · характеристики</h2>']
        if wbd.get("tails"):
            tags = "".join(f'<span class="tag">{esc(w)} <b>{n}</b></span>' for w, n in wbd["tails"])
            parts.append('<p class="meta" style="margin-bottom:2px">Смыслы — теги из хвостов запросов '
                         'топов (частотные выносить выше в листинге):</p>'
                         f'<div class="tags">{tags}</div>')
        if any(it.get("_slides") for it in review):
            rows = []
            for it in review:
                sl = it.get("_slides") or []
                if not sl:
                    continue
                if embed:  # в Artifact внешние картинки блокируются CSP → ссылки
                    thumbs = "".join(f'<a class="slink" href="{esc(u)}" target="_blank" rel="noopener">{i+1}</a>'
                                     for i, u in enumerate(sl))
                else:      # в standalone HTML/PDF реальные слайды подгружаются
                    thumbs = "".join(f'<a href="{esc(u)}" target="_blank" rel="noopener">'
                                     f'<img src="{esc(u)}" loading="lazy" alt="слайд {i+1}"></a>'
                                     for i, u in enumerate(sl))
                rows.append(f'<div class="lrow"><div class="cap">{esc((it.get("name") or "—")[:60])}</div>'
                            f'<div class="slides">{thumbs}</div></div>')
            if rows:
                parts.append('<h3 style="margin:16px 0 4px;font-family:Georgia,serif">Листинг топов (слайды)</h3>'
                             f'<div class="listing">{"".join(rows)}</div>')
        cm = wbd.get("charmatrix")
        if cm:
            head = '<th>Характеристика</th>' + "".join(f'<th>{esc(c)}</th>' for c in cm["cols"]) + '<th>Доминанта</th>'
            trs = []
            for r in cm["rows"]:
                cells = "".join(f'<td>{esc((v or "—")[:22])}</td>' for v in r["values"])
                trs.append(f'<tr><td><b>{esc(r["name"])}</b></td>{cells}'
                           f'<td class="val-ok">{esc((r["dominant"] or "—")[:22])}</td></tr>')
            parts.append('<h3 style="margin:16px 0 4px;font-family:Georgia,serif">Характеристики топов '
                         '(заполнить как доминанта)</h3>'
                         f'<div class="tbl-wrap"><table><thead><tr>{head}</tr></thead>'
                         f'<tbody>{"".join(trs)}</tbody></table></div>')
        parts.append('</section>')
        P.append("".join(parts))

    # G2. funnel comparison (Step 2) — перед планом
    if funnel and funnel.get("rows"):
        pk = funnel["planka"]
        def fcell(v, plan, is_our):
            cls = "val-bad" if (is_our and plan and v < plan) else ""
            return f'<td class="r num {cls}">{v:.0f}%</td>'
        trs = []
        for r in funnel["rows"]:
            rowcls = ' class="mrow ok"' if r["is_our"] else ""
            mark = " ⬅ наш" if r["is_our"] else ""
            trs.append(f'<tr{rowcls}><td>{esc((r["name"] or r["nm"])[:44])}{mark}</td>'
                       f'<td class="r num">{fmt_int(r["showings"])}</td>'
                       f'{fcell(r["ctr"], pk["ctr"], r["is_our"])}{fcell(r["cart"], pk["cart"], r["is_our"])}'
                       f'{fcell(r["order"], pk["order"], r["is_our"])}{fcell(r["buyout"], pk["buyout"], r["is_our"])}'
                       f'<td class="r num">{fmt_int(r["position"])}</td></tr>')
        trs.append(f'<tr class="mrow"><td><b>Медиана конкурентов (планка)</b></td>'
                   f'<td class="r num">{fmt_int(pk["showings"])}</td>'
                   f'<td class="r num">{pk["ctr"]:.0f}%</td><td class="r num">{pk["cart"]:.0f}%</td>'
                   f'<td class="r num">{pk["order"]:.0f}%</td><td class="r num">{pk["buyout"]:.0f}%</td>'
                   f'<td class="r num">{fmt_int(pk["position"])}</td></tr>')
        P.append('<section><h2>Сравнение карточек — воронка (наш vs конкуренты)</h2>'
                 '<div class="tbl-wrap"><table><thead><tr><th>Карточка</th><th class="r">Показы</th>'
                 '<th class="r">CTR</th><th class="r">В корзину</th><th class="r">В заказ</th>'
                 '<th class="r">Выкуп</th><th class="r">Позиция</th></tr></thead>'
                 f'<tbody>{"".join(trs)}</tbody></table></div>'
                 '<p class="meta">Планка = медиана конкурентов по этапу; красным — где наша карточка ниже '
                 'планки. Цель — быть не ниже планки на каждом шаге. Данные из кабинета WB (Сравнение карточек, [2]).'
                 '</p></section>')

    # H. plan (interactive)
    groups = []
    if args.my_sku and gaps:
        groups.append(("Гэпы карточки (метрики ниши + воронка [2])", [(g, None) for g in gaps]))
    elif args.my_sku and mine:
        groups.append(("Гэпы карточки", [("Оцифрованных гэпов нет — фокус на ручной слой", None)]))
    targets = []
    if econ and econ["corridor"][0]:
        targets.append((f"Цена-цель: {fmt_int(econ['corridor'][0])}–{fmt_int(econ['corridor'][1])} ₽",
                        f"маржа {econ['pr']['m_min']*100:.0f}–{econ['pr']['m_max']*100:.0f}%, не «зона объёма»"))
    elif pz:
        targets.append((f"Цена-цель: {fmt_int(pz['band'][0])}–{fmt_int(pz['band'][1])} ₽",
                        "зона объёма — задай --cost для маржинального коридора"))
    if cb:
        cbm2 = cb["metrics"]
        ct = []
        if cbm2.get("picscount"):
            ct.append(f"фото ≥ {fmt_int(cbm2['picscount']['median'])}")
        if "hasvideo" in cbm2:
            ct.append("видео " + ("обязательно" if cbm2["hasvideo"]["share"] >= 40 else "желательно"))
        if cbm2.get("rating"):
            ct.append(f"рейтинг ≥ {cbm2['rating']['median']:.1f}")
        if ct:
            targets.append(("Контент-цель: " + ", ".join(ct), None))
    if targets:
        groups.append(("Цели ниши", targets))
    f2 = " ✅ данные в блоке F2" if wbd else ""
    groups.append(("Ручной слой", [
        ("Смыслы / листинг" + f2, "перенести частотные теги хвостов и удачные слайды топов (F2) в свой листинг (гл. 04)"),
        ("Характеристики" + f2, "заполнить как доминанта топов (F2); состав/конструктив 1-в-1 (гл. 13/18)"),
        ("Принадлежность %", "Wildbox «топы поиска»: сегменты/подсегменты, % присутствия; <30% = вход закрыт (гл. 13)"),
        ("Конверсии по запросам (ДЖЕМ)", "ДЖЕМ Competition (до 5 карт.): где конкурент сильнее в корзину/заказ → повторить (гл. 04)"),
        ("Полки / доска", "кто чаще всех в полках топов = супер-карточка → брать её смыслы (гл. 18)"),
    ]))
    idx = 0
    gblocks = []
    for gt, gi in groups:
        lis = []
        for main_txt, hint in gi:
            cid = f"wc{idx}"; idx += 1
            hint_html = f' <span class="g">— {esc(hint)}</span>' if hint else ""
            lis.append(f'<li><input type="checkbox" id="{cid}">'
                       f'<label for="{cid}">{esc(main_txt)}{hint_html}</label></li>')
        gblocks.append(f'<div><h3>{esc(gt)}</h3><ul class="check">{"".join(lis)}</ul></div>')
    P.append(f'<section><h2>План доработки карточки</h2><div class="plan">{"".join(gblocks)}</div></section>')

    # footer
    note = ""
    if notes:
        note = " Недоступные срезы: " + esc("; ".join(notes)) + "."
    P.append('<footer>Данные MPStats оценочные (восстановление по остаткам/выкупам) — для сравнения, '
             'не как бухгалтерия. Конверсии по слайду, «покупают также», принадлежность % — не из MPStats. '
             f'Путь категории {esc(path_note)}.{note}</footer>')

    report_id = f"{path}|{args.d1}|{args.my_sku or '-'}"
    inner = f'<div class="wca" data-report="{esc(report_id)}">' + "".join(P) + \
            f'</div><script>{JS_REPORT}</script>'
    if embed:
        return f"<style>{CSS_REPORT}</style>" + inner
    return ('<!doctype html><html lang="ru"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Конкурентный анализ WB — {esc(title)}</title>'
            f'<style>{CSS_REPORT}</style></head><body>{inner}</body></html>')


# ======================= self-test (без сети) =======================
def _demo_inputs():
    """Синтетические данные для проверки сборки отчётов без сети."""
    import random
    random.seed(7)
    pal = ["чёрный", "белый", "синий", "красный", "бежевый"]
    items = []
    for i in range(120):
        rev = max(0, random.gauss(400000, 250000))
        items.append({
            "id": 1000000 + i, "name": f"Рубашка полоска {i}", "brand": f"Brand{i%12}",
            "seller": f"ИП Продавец {i%18}", "color": random.choice(pal),
            "final_price": random.choice([990, 1290, 1490, 1790, 2190, 2790]),
            "revenue": rev, "sales": rev / 1500, "rating": round(random.uniform(4.2, 5.0), 1),
            "comments": random.randint(0, 900), "picscount": random.randint(3, 12),
            "hasvideo": random.random() > 0.5, "has3d": random.random() > 0.85,
            "description_length": random.randint(200, 1800),
            "latest_negative_comments_percent": round(random.uniform(0, 12), 1),
            "search_words_count": random.randint(20, 400), "lost_profit": rev * random.uniform(0, .3),
            "balance": random.randint(0, 3000),
        })
    my = dict(items[3]); my["id"] = 777; my["picscount"] = 4; my["hasvideo"] = False
    my["final_price"] = 3290; my["color"] = "фиолетовый"; my["comments"] = 12; my["rating"] = 4.3
    items.append(my)

    class A:
        query = "рубашка женская в полоску"; by = "seller"; top = 10; days = 30
        d1 = "2025-06-04"; d2 = "2025-07-04"; my_sku = 777
    agg, tot = aggregate(items, "seller")
    path = "Женщинам/Блузки и рубашки/Рубашка"
    econ = compute_economics(items, 536, econ_params())   # себестоимость 536 ₽ (демо)
    kw = {"рубашка в полоску оверсайз": [
              {"id": 239612805, "name": "Хлопковая рубашка в полоску оверсайз", "seller": "NA_SEBE_FOCUS",
               "price": 2792, "rating": 4.8, "feedbacks": 640, "pics": 11, "colors": ["голубой", "синий"]},
              {"id": 804478782, "name": "Летняя рубашка в полоску", "seller": "ИП Продавец 6",
               "price": 1312, "rating": 4.7, "feedbacks": 218, "pics": 18, "colors": ["голубой"]}]}
    review = cards_for_review(items, agg, "seller", 6)
    # синтетическое WB-обогащение (без сети): характеристики + слайды
    demo_names = ["Рубашка оверсайз в полоску льняная", "Рубашка прозрачная летняя хлопковая",
                  "Рубашка в полоску оверсайз", "Блузка полоска офисная", "Рубашка летняя лён", "Рубашка полоска"]
    demo_chars = [[("Состав", "хлопок 100%"), ("Покрой", "оверсайз"), ("Вид застёжки", "пуговицы"),
                   ("Тип карманов", "без карманов"), ("Фактура материала", "полупрозрачная")],
                  [("Состав", "хлопок; лён"), ("Покрой", "оверсайз"), ("Вид застёжки", "пуговицы"),
                   ("Тип карманов", "один карман"), ("Фактура материала", "плотная")]]
    for i, it in enumerate(review):
        it["name"] = demo_names[i % len(demo_names)]
        it["_chars"] = demo_chars[i % len(demo_chars)]
        it["_slides"] = [f"https://basket-15.wbbasket.ru/vol0/part0/{it['id']}/images/big/{j}.webp"
                         for j in range(1, 6)]
    pool = list(review) + [c for cs in kw.values() for c in cs]
    wbd = {"tails": tail_words(pool, "рубашка"), "charmatrix": char_matrix(review)}
    return dict(A=A, path=path, path_note="синтетика (демо)", nfilter="полос", items=items,
                agg=agg, tot=tot, pz=price_zone(items), cb=content_benchmark(items, 20),
                colors=color_distribution(items, agg, "seller", 10), seas={"delta_pct": 14.0},
                review=review, mine=profile_sku(items, 777),
                econ=econ, kw=kw, wbd=wbd, notes=["trends (демо)"])


def selftest(html_out=None, pdf_out=None):
    d = _demo_inputs()
    rep, top, gaps = build_report(d["A"], d["path"], d["path_note"], d["nfilter"], d["items"],
                                  len(d["items"]), d["agg"], d["tot"], d["pz"], d["cb"], d["colors"],
                                  d["seas"], d["review"], d["mine"], d["notes"], d["econ"], d["kw"], d["wbd"])
    print(rep)
    if html_out or pdf_out:
        html = build_html(d["A"], d["path"], d["path_note"], d["nfilter"], d["items"], d["agg"],
                          d["tot"], top, d["pz"], d["cb"], d["colors"], d["seas"], d["review"],
                          d["mine"], gaps, d["notes"], d["econ"], d["kw"], d["wbd"])
        if html_out:
            open(html_out, "w", encoding="utf-8").write(html)
            print(f"[selftest] HTML → {html_out}", file=sys.stderr)
        if pdf_out:
            html_to_pdf(html, pdf_out)
            print(f"[selftest] PDF → {pdf_out}", file=sys.stderr)
    print("\n[selftest] OK — секций собрано, гэпов:", len(gaps), file=sys.stderr)


# ======================= main =======================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gender", default="women", choices=list(GENDER_ROOT))
    ap.add_argument("--item", default="рубашка")
    ap.add_argument("--pattern", default=None)
    ap.add_argument("--path", default=None, help="явный путь категории MPStats")
    ap.add_argument("--query", default=None, help="фраза ниши для шапки отчёта")
    ap.add_argument("--my-sku", dest="my_sku", default=None, help="ваш артикул WB для гэп-анализа")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--bench", type=int, default=20, help="сколько топ-SKU брать в контент-бенчмарк")
    ap.add_argument("--cards", type=int, default=6, help="сколько карточек вывести под ручной разбор")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--by", default="seller", choices=["seller", "brand"])
    ap.add_argument("--out", default=None, help="файл для markdown-отчёта")
    ap.add_argument("--json-out", default=None, help="файл для JSON с агрегатами")
    ap.add_argument("--html-out", dest="html_out", default=None, help="файл для HTML-отчёта (кликабельный)")
    ap.add_argument("--pdf-out", dest="pdf_out", default=None, help="файл для PDF-отчёта (кликабельные ссылки, через Chromium)")
    # --- каскадный вход [1]→[2]→[3] ---
    ap.add_argument("--items-json", dest="items_json", default=None,
                    help="отчёт инструмента [1] (ТОП по фразе, wb-top-keywords) — источник ниши вместо MPStats-категории")
    ap.add_argument("--funnel-json", dest="funnel_json", default=None,
                    help="отчёт инструмента [2] (Сравнение карточек) — воронка наш vs конкуренты (блок G/воронка/цели)")
    ap.add_argument("--seasonality-delta", dest="seas_delta", type=float, default=None,
                    help="сезонность (Δ%% 2-я половина периода к 1-й), если посчитана оркестратором из ряда MPStats")
    ap.add_argument("--keywords", default=None, help="ключевые запросы через запятую — искать конкурентов в выдаче WB")
    ap.add_argument("--kw-limit", dest="kw_limit", type=int, default=8, help="сколько карточек брать из выдачи на запрос")
    ap.add_argument("--no-wb", dest="no_wb", action="store_true", help="не тянуть характеристики/слайды из WB (быстрее/офлайн)")
    ap.add_argument("--selftest", action="store_true", help="прогон сборки отчёта на синтетике (без сети)")
    # --- юнит-экономика (дефолты = подтверждённые пользователем цифры; себестоимость обязательна) ---
    ap.add_argument("--cost", type=float, default=None,
                    help="СЕБЕСТОИМОСТЬ единицы, ₽ (landed до склада WB) — спрашивать каждый раз")
    ap.add_argument("--commission-pct", dest="commission_pct", type=float, default=35.7)
    ap.add_argument("--spp-pct", dest="spp_pct", type=float, default=4.0)
    ap.add_argument("--acquiring-pct", dest="acquiring_pct", type=float, default=4.7)
    ap.add_argument("--tax-pct", dest="tax_pct", type=float, default=2.0)
    ap.add_argument("--drr-launch-pct", dest="drr_launch_pct", type=float, default=30.0)
    ap.add_argument("--drr-steady-pct", dest="drr_steady_pct", type=float, default=8.0)
    ap.add_argument("--defect-pct", dest="defect_pct", type=float, default=2.5)
    ap.add_argument("--redemption-pct", dest="redemption_pct", type=float, default=36.0)
    ap.add_argument("--logistics", type=float, default=0.0, help="логистика ₽/ед (у нас 0)")
    ap.add_argument("--storage", type=float, default=0.0, help="хранение ₽/ед (у нас 0)")
    ap.add_argument("--target-margin-min", dest="tm_min", type=float, default=25.0)
    ap.add_argument("--target-margin-max", dest="tm_max", type=float, default=30.0)
    args = ap.parse_args()

    if args.selftest:
        selftest(args.html_out, args.pdf_out)
        return

    today = date.today()
    args.d2 = today.isoformat()
    args.d1 = (today - timedelta(days=args.days)).isoformat()

    notes = []
    alts = []
    token = None
    seas = None
    # ── источник ниши: каскад ([1] items-json) ИЛИ MPStats-категория ──
    if args.items_json:
        items, imeta = load_items_json(args.items_json)
        if not items:
            print(f"Пусто: в отчёте [1] '{args.items_json}' нет карточек.", file=sys.stderr)
            sys.exit(4)
        path = args.query or imeta.get("query") or "каскад [1]"
        path_note = "из инструмента [1] (ТОП по фразе)"
        nfilter = None
        args.by = "brand"                        # у [1] нет продавца — владельца берём по бренду
        total = imeta.get("total") or len(items)
        if imeta.get("d1"):
            args.d1, args.d2 = imeta["d1"], imeta["d2"]
        # контент (фото/видео/описание/слайды/характеристики) — по nmId из публичного API WB
        if not args.no_wb:
            try:
                enrich_content(items, args.bench)
            except Exception as e:
                notes.append(f"WB-обогащение контента недоступно ({str(e)[:40]})")
        # сезонность: Δ% из ряда MPStats — посчитана оркестратором (CLI-флаг или _meta отчёта [1])
        sd = args.seas_delta if args.seas_delta is not None else imeta.get("seasonality_delta")
        if sd is not None:
            seas = {"delta_pct": sd}
        else:
            notes.append("сезонность не передана (--seasonality-delta / _meta.seasonality)")
    else:
        token = load_token()
        if not token:
            print("ОШИБКА: не найден MPSTATS_TOKEN (env или .env).", file=sys.stderr)
            sys.exit(2)
        try:
            cats = get_categories(token)
        except MpstatsError as e:
            die_api(e)
        path, path_note, alts = resolve_path(cats, args.gender, args.item, args.path)
        if not path:
            print(f"ОШИБКА: {path_note}", file=sys.stderr)
            sys.exit(3)
        print(f"[path] выбрано: {path}  ({path_note})", file=sys.stderr)
        for a in alts:
            print(f"[path] альтернатива: {a}", file=sys.stderr)
        nfilter, _ = pattern_stem(args.pattern)
        try:
            items, total = fetch_items(token, path, args.d1, args.d2, nfilter)
        except MpstatsError as e:
            die_api(e)
        if not items:
            print(f"Пусто: по нише '{path}' с фильтром '{nfilter}' за период {args.d1}—{args.d2} "
                  f"данных нет. Проверьте: (1) путь категории (--path), (2) период (за будущие даты "
                  f"MPStats пусто), (3) слишком узкий фильтр принта.", file=sys.stderr)
            sys.exit(4)

    agg, tot_rev = aggregate(items, args.by)
    pz = price_zone(items)
    cb = content_benchmark(items, args.bench)
    colors = color_distribution(items, agg, args.by, args.top, top_n=10)
    review = cards_for_review(items, agg, args.by, args.cards)

    # сезонность в категорийном режиме — из ряда MPStats category/trends
    if not args.items_json:
        trend, err = try_json("GET", "wb/get/category/trends", token, params={"path": path, "d1": args.d1, "d2": args.d2})
        if err:
            notes.append(f"trends ({err.split(':')[0]})")
        else:
            seas = seasonality(trend)

    # ── воронка [2] (funnel-json): наша карточка + планка конкурентов ──
    funnel = None
    if args.funnel_json:
        try:
            funnel = load_funnel_json(args.funnel_json)
            if funnel.get("our") and not args.my_sku:
                args.my_sku = funnel["our"]["nm"]      # включает блок G и план по нашей карточке
        except Exception as e:
            notes.append(f"воронка [2] не прочитана ({str(e)[:40]})")

    # своя карточка (mine): из воронки [2] → иначе из среза ниши
    if funnel and funnel.get("mine"):
        mine = dict(funnel["mine"])
        if not args.no_wb and mine.get("id"):
            try:
                enrich_content([mine], 1)              # фото/видео/описание нашей карточки по nmId
            except Exception:
                pass
    else:
        mine = profile_sku(items, args.my_sku) if args.my_sku else None
        if args.my_sku and not mine and not args.items_json and nfilter:
            try:
                wide, _ = fetch_items(token, path, args.d1, args.d2, None)
                mine = profile_sku(wide, args.my_sku)
            except MpstatsError as e:
                notes.append(f"поиск своей карточки без фильтра ({e.code})")

    # юнит-экономика — только если задана себестоимость
    econ = None
    if args.cost:
        pr = econ_params(commission=args.commission_pct / 100, spp=args.spp_pct / 100,
                         acquiring=args.acquiring_pct / 100, tax=args.tax_pct / 100,
                         drr_launch=args.drr_launch_pct / 100, drr_steady=args.drr_steady_pct / 100,
                         defect=args.defect_pct / 100, redemption=args.redemption_pct / 100,
                         logistics=args.logistics, storage=args.storage,
                         m_min=args.tm_min / 100, m_max=args.tm_max / 100)
        econ = compute_economics(items, args.cost, pr)
    else:
        notes.append("юнит-экономика пропущена — не задан --cost")

    # конкуренты по ключевым запросам (публичный API WB, не тратит квоту MPStats)
    kw = None
    if args.keywords:
        qs = [q.strip() for q in args.keywords.split(",") if q.strip()]
        kw = {q: wb_search(q, args.kw_limit) for q in qs}
        if not any(kw.values()):
            notes.append("поиск WB по запросам недоступен (429/пусто)")

    # Фаза 5: ручной слой → готовые данные (характеристики/слайды/смыслы из публичного API WB)
    wbd = None
    if not args.no_wb:
        try:
            got = enrich_cards(review)
            pool = list(review) + [c for cs in (kw or {}).values() for c in cs]
            wbd = {"tails": tail_words(pool, args.item), "charmatrix": char_matrix(review)}
            if not got:
                notes.append("WB-карточки топов не загрузились (429) — блок F2 частичный")
        except Exception as e:
            notes.append(f"WB-обогащение недоступно ({str(e)[:40]})")

    report, top, gaps = build_report(args, path, path_note, nfilter, items, total, agg,
                                     tot_rev, pz, cb, colors, seas, review, mine, notes, econ, kw, wbd, funnel)
    if alts:
        report += "\n\n_Альтернативные категории (перезапуск с `--path`): " + \
                  "; ".join(f"`{a}`" for a in alts) + "._"

    print(report)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(report)
    if args.html_out or args.pdf_out:
        html = build_html(args, path, path_note, nfilter, items, agg, tot_rev, top,
                          pz, cb, colors, seas, review, mine, gaps, notes, econ, kw, wbd, funnel)
        if args.html_out:
            open(args.html_out, "w", encoding="utf-8").write(html)
            print(f"[html] отчёт → {args.html_out}", file=sys.stderr)
        if args.pdf_out:
            try:
                html_to_pdf(html, args.pdf_out)
                print(f"[pdf] отчёт → {args.pdf_out}", file=sys.stderr)
            except Exception as e:
                print(f"[pdf] не удалось: {e}", file=sys.stderr)
    if args.json_out:
        payload = {
            "query": {"query": args.query, "gender": args.gender, "item": args.item,
                      "pattern": args.pattern, "path": path, "name_filter": nfilter,
                      "d1": args.d1, "d2": args.d2, "by": args.by, "top": args.top,
                      "my_sku": args.my_sku},
            "niche": {"skus": len(items), "players": len(agg), "total_revenue": tot_rev,
                      "seasonality_delta_pct": (seas or {}).get("delta_pct")},
            "price_zone": pz,
            "economics": econ,
            "content_benchmark": cb,
            "colors": colors,
            "top": [{
                "rank": i, "name": n, "revenue": v["rev"], "sales": v["sales"], "items": v["items"],
                "avg_price": (v["rev"] / v["sales"] if v["sales"] else 0),
                "rating": (v["rating_w"] / v["comments"] if v["comments"] else 0),
                "lost_profit": v["lost"], "stock": v["stock"], "brands": sorted(v["brands"])[:6],
                "top_item": {k: (v["top_item"] or {}).get(k) for k in FIELDS_KEEP},
            } for i, (n, v) in enumerate(top, 1)],
            "keyword_competitors": kw,
            "review_cards": [{k: it.get(k) for k in FIELDS_KEEP} for it in review],
            "my_card": ({k: mine.get(k) for k in FIELDS_KEEP} if mine else None),
            "funnel": funnel,
            "gaps": gaps,
            "notes": notes,
        }
        json.dump(payload, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
