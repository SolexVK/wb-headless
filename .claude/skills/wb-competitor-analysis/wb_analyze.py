#!/usr/bin/env python3
"""
WB competitor analysis via MPStats API.

Тянет данные категории Wildberries из MPStats, фильтрует по нише (пол + предмет +
паттерн/принт), агрегирует по продавцам или брендам и печатает готовый отчёт
(markdown) + машиночитаемый JSON.

HTTP выполняется через curl (надёжно работает и в облачной сессии через egress-прокси,
и на локальной машине). Токен берётся из env MPSTATS_TOKEN либо из .env.

Пример:
  python3 wb_analyze.py --gender women --item рубашка --pattern полоска --top 10 --days 30 --by seller
"""
import argparse, json, os, subprocess, sys, tempfile, urllib.parse
from collections import defaultdict
from datetime import date, timedelta

API = "https://mpstats.io/api"

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

FIELDS_KEEP = ["id", "name", "brand", "seller", "color", "revenue", "sales",
               "final_price", "rating", "comments", "balance", "lost_profit",
               "turnover_days", "sales_per_day_average"]


def load_token():
    tok = os.environ.get("MPSTATS_TOKEN", "").strip()
    if tok:
        return tok
    # ищем .env вверх по дереву от cwd и от каталога скрипта
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
        return json.loads(txt)
    except json.JSONDecodeError:
        raise RuntimeError(f"не JSON от {path}: {txt[:300]}")


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
    # короткий корень, чтобы ловить словоформы (рубашка/рубашки, платье/платья)
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
        # 1) точный лист: последний сегмент — сам предмет (рубашка/рубашки), а не «блузки и рубашки»
        exact_leaf = 0 if (leaf.startswith(stem) and len(leaf) <= len(stem) + 3) else 1
        # 2) лист хотя бы содержит предмет
        last_match = 0 if stem in leaf else 1
        penalty = sum(1 for w in NOISE_SEG if w in p.lower())
        return (exact_leaf, last_match, penalty, len(segs), len(p))

    cands.sort(key=score)
    alts = cands[1:5]
    return cands[0], "подобрано автоматически", alts


def pattern_stem(p):
    if not p:
        return None, None
    pl = p.lower().strip()
    for k, v in PATTERN_STEMS.items():
        if k in pl:
            return v, pl
    return pl, pl  # неизвестный паттерн — используем как подстроку


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


def num(x):
    try:
        return float(x) or 0.0
    except (TypeError, ValueError):
        return 0.0


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


def fmt_money(v):
    if v >= 1e6:
        return f"{v/1e6:.1f} млн ₽"
    if v >= 1e3:
        return f"{v/1e3:.0f} тыс ₽"
    return f"{v:.0f} ₽"


def build_report(args, path, path_note, name_filter, items, total, agg, tot_rev):
    by_label = "продавцам" if args.by == "seller" else "брендам"
    ranked = sorted(agg.items(), key=lambda kv: kv[1]["rev"], reverse=True)
    top = ranked[:args.top]
    top_share = sum(v["rev"] for _, v in top) / tot_rev * 100 if tot_rev else 0

    L = []
    L.append(f"# Конкурентный анализ WB — {path.split('/')[-1]} · {name_filter or 'вся категория'}")
    L.append("")
    L.append(f"**Ниша:** `{path}`  ")
    if name_filter:
        L.append(f"**Фильтр (принт/паттерн):** название содержит «{name_filter}»  ")
    L.append(f"**Период:** {args.d1} — {args.d2} ({args.days} дн)  ")
    L.append(f"**Срез:** ТОП-{args.top} по {by_label}, ранжирование по выручке  ")
    L.append("")
    L.append("## Ёмкость и концентрация ниши")
    L.append(f"- Товаров (SKU) в срезе: **{len(items):,}**".replace(",", " "))
    L.append(f"- {'Продавцов' if args.by=='seller' else 'Брендов'}: **{len(agg):,}**".replace(",", " "))
    L.append(f"- Суммарная выручка: **{fmt_money(tot_rev)}** за период")
    L.append(f"- Доля ТОП-{args.top}: **{top_share:.1f}%** выручки ниши "
             f"({'высокая концентрация — тесно' if top_share>=60 else 'ниша раздроблена — есть вход' if top_share<40 else 'умеренная концентрация'})")
    L.append("")
    L.append(f"## ТОП-{args.top} конкурентов")
    L.append("")
    L.append("| # | " + ("Продавец" if args.by == "seller" else "Бренд") +
             " | Выручка | Доля | Продажи, шт | Ср. цена | SKU | Рейтинг | Упущ. выручка |")
    L.append("|---|---|--:|:--:|--:|--:|--:|--:|--:|")
    for i, (name, v) in enumerate(top, 1):
        avg_price = v["rev"] / v["sales"] if v["sales"] else 0
        rating = v["rating_w"] / v["comments"] if v["comments"] else 0
        share = v["rev"] / tot_rev * 100 if tot_rev else 0
        L.append(f"| {i} | **{name}** | {fmt_money(v['rev'])} | {share:.1f}% | "
                 f"{v['sales']:,.0f} | {avg_price:,.0f} ₽ | {v['items']} | "
                 f"{rating:.2f} | {fmt_money(v['lost'])} |".replace(",", " "))
    L.append("")

    # инсайты
    L.append("## Выводы")
    lead_name, lead = top[0]
    lead_eff = lead["rev"] / lead["items"] if lead["items"] else 0
    L.append(f"- **Лидер — {lead_name}**: {fmt_money(lead['rev'])} на {lead['items']} SKU "
             f"(≈ {fmt_money(lead_eff)} на карточку). Топ-хит: «{(lead['top_item'] or {}).get('name','')}» "
             f"— {fmt_money(num((lead['top_item'] or {}).get('revenue')))}.")
    # кто теряет больше всех на остатках
    lost_rank = sorted(top, key=lambda kv: kv[1]["lost"], reverse=True)[0]
    if lost_rank[1]["lost"] > 0:
        L.append(f"- **Точка для перехвата:** {lost_rank[0]} упускает ≈ {fmt_money(lost_rank[1]['lost'])} "
                 f"из-за нехватки остатков — этот спрос можно забрать наличием на складе.")
    # ценовой разброс
    prices = [v["rev"] / v["sales"] for _, v in top if v["sales"]]
    if prices:
        L.append(f"- **Ценовой коридор ТОП-{args.top}:** {min(prices):,.0f}–{max(prices):,.0f} ₽ "
                 f"(медиана ≈ {sorted(prices)[len(prices)//2]:,.0f} ₽).".replace(",", " "))
    L.append("")
    L.append("---")
    L.append("_Данные MPStats оценочные (восстановление продаж по остаткам/выкупам). "
             f"Фильтр по названию мог не учесть карточки, где принт указан только на фото. "
             f"Путь категории {path_note}._")
    return "\n".join(L), top


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gender", default="women", choices=list(GENDER_ROOT))
    ap.add_argument("--item", default="рубашка", help="предмет: рубашка, платье, футболка…")
    ap.add_argument("--pattern", default=None, help="принт: полоска, клетка… (опционально)")
    ap.add_argument("--path", default=None, help="явный путь категории MPStats (переопределяет резолвер)")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--by", default="seller", choices=["seller", "brand"])
    ap.add_argument("--out", default=None, help="файл для markdown-отчёта")
    ap.add_argument("--json-out", default=None, help="файл для JSON с агрегатами")
    args = ap.parse_args()

    token = load_token()
    if not token:
        print("ОШИБКА: не найден MPSTATS_TOKEN (env или .env).", file=sys.stderr)
        sys.exit(2)

    today = date.today()
    args.d2 = today.isoformat()
    args.d1 = (today - timedelta(days=args.days)).isoformat()

    cats = get_categories(token)
    path, path_note, alts = resolve_path(cats, args.gender, args.item, args.path)
    if not path:
        print(f"ОШИБКА: {path_note}", file=sys.stderr)
        sys.exit(3)
    # выводим выбор и альтернативы в stderr, чтобы оператор мог проверить/переопределить --path
    print(f"[path] выбрано: {path}  ({path_note})", file=sys.stderr)
    for a in alts:
        print(f"[path] альтернатива: {a}", file=sys.stderr)
    nfilter, _raw = pattern_stem(args.pattern)

    items, total = fetch_items(token, path, args.d1, args.d2, nfilter)
    if not items:
        print(f"Пусто: по нише '{path}' с фильтром '{nfilter}' за период данных нет.", file=sys.stderr)
        sys.exit(4)

    agg, tot_rev = aggregate(items, args.by)
    report, top = build_report(args, path, path_note, nfilter, items, total, agg, tot_rev)
    if alts:
        report += "\n\n_Альтернативные категории (если срез не тот — перезапуск с `--path`): " + \
                  "; ".join(f"`{a}`" for a in alts) + "._"

    print(report)
    if args.out:
        open(args.out, "w", encoding="utf-8").write(report)
    if args.json_out:
        payload = {
            "query": {"gender": args.gender, "item": args.item, "pattern": args.pattern,
                      "path": path, "name_filter": nfilter, "d1": args.d1, "d2": args.d2,
                      "by": args.by, "top": args.top},
            "niche": {"skus": len(items), "players": len(agg), "total_revenue": tot_rev},
            "top": [{
                "rank": i, "name": n, "revenue": v["rev"], "sales": v["sales"],
                "items": v["items"], "avg_price": (v["rev"]/v["sales"] if v["sales"] else 0),
                "rating": (v["rating_w"]/v["comments"] if v["comments"] else 0),
                "lost_profit": v["lost"], "stock": v["stock"],
                "brands": sorted(v["brands"])[:6],
                "top_item": {k: (v["top_item"] or {}).get(k) for k in FIELDS_KEEP},
            } for i, (n, v) in enumerate(top, 1)],
        }
        json.dump(payload, open(args.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
