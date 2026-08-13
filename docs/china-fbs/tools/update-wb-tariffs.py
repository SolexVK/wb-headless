#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Обновление тарифов логистики WB для Китая — БЕЗ правки кода.

Скачивает официальный тарифный PDF WB, парсит ставки и пишет их в
  ../calculator/tariffs.override.json   (этот файл в .gitignore)
Калькулятор читает override поверх tariffs.json при загрузке страницы —
поэтому обновление тарифов не трогает код и не конфликтует с git.

Запуск:
    python3 update-wb-tariffs.py [URL_PDF]

Если URL не указан — берётся текущий известный. Когда WB публикует новый тариф
(меняется имя файла PDF), передайте новый URL первым аргументом.

Зависимости: pdfplumber (pip install pdfplumber), curl в PATH.
"""
import sys, os, re, json, subprocess, datetime, tempfile

DEFAULT_URL = "https://static-basket-02.wbbasket.ru/vol20/China/warehouse_and_tarrifs/0726.pdf"
HERE = os.path.dirname(os.path.abspath(__file__))
OVERRIDE_OUT = os.path.normpath(os.path.join(HERE, "..", "calculator", "tariffs.override.json"))

# Строка PDF: № | продукт | склад-описание | 4 ставки (X,XX) | лимиты+локация
ROW_RE = re.compile(
    r'(WB Express|WB Standard|WB Plus)\s+(.*?)\s+'
    r'(\d+,\d+)\s+(\d+,\d+)\s+(\d+,\d+)\s+(\d+,\d+)\s+(.*)$'
)


def num(s):
    return float(s.replace(',', '.'))


def download(url):
    tmp = os.path.join(tempfile.gettempdir(), "wb_tariff.pdf")
    r = subprocess.run(["curl", "-sS", "--max-time", "60", "-o", tmp, url],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) < 1000:
        raise SystemExit(f"Не удалось скачать PDF: {url}\n{r.stderr}")
    return tmp


def parse(pdf_path):
    import pdfplumber
    text = ""
    with pdfplumber.open(pdf_path) as pdf:
        for p in pdf.pages:
            text += (p.extract_text() or "") + "\n"

    # Дата вступления в силу
    eff = re.search(r'take effect from\s+([A-Za-z]+ \d{1,2},\s*\d{4})', text)
    effective = eff.group(1) if eff else "н/д"

    rows = []
    for line in text.splitlines():
        m = ROW_RE.search(line)
        if not m:
            continue
        product, wh, lk, li, hk_, hi, rest = m.groups()
        limits = re.findall(r'exceed\s+(\d+)\s*cm', rest)
        limit_sum = int(limits[0]) if len(limits) >= 1 else 0
        limit_side = int(limits[1]) if len(limits) >= 2 else 0
        is_hk = 'Hong Kong' in rest or 'Hong Kong' in wh
        rows.append({
            "product": product, "wh": wh.strip(), "is_hk": is_hk,
            "light": {"kg": num(lk), "item": num(li)},
            "heavy": {"kg": num(hk_), "item": num(hi)},
            "limitSum": limit_sum, "limitSide": limit_side,
        })
    if not rows:
        raise SystemExit("Не удалось распарсить ни одной строки тарифа — проверьте формат PDF.")
    return rows, effective


# Лимиты габаритов стабильны (в PDF текст переносится на след. строку и парсится
# ненадёжно). Ставки — волатильная часть — берутся из PDF; лимиты фиксируем здесь.
KNOWN = {
    "standard": ("WB Standard — авто, 15–30 дн (большинство складов КНР)", 200, 120),
    "plus":     ("WB Plus — авиа+авто, 6–7 дн (Хуньчунь/Дунгуань/Дуннин)",  200, 120),
    "hk":       ("WB Express — Гонконг, авиа, 10 дн",                        90,  60),
    "express":  ("WB Express — Дунгуань, авиа, 10 дн",                       200, 100),
}


def pick(rows, product, hk=None):
    for r in rows:
        if r["product"] == product and (hk is None or r["is_hk"] == hk):
            return r
    return None


def build_logistics(rows):
    sel = {
        "standard": pick(rows, "WB Standard"),
        "plus":     pick(rows, "WB Plus"),
        "hk":       pick(rows, "WB Express", hk=True),
        "express":  pick(rows, "WB Express", hk=False),
    }
    out = {}
    for key, r in sel.items():
        if not r:
            continue
        name, ls, lside = KNOWN[key]
        r["limitSum"], r["limitSide"] = ls, lside
        out[key] = (name, r)
    return out


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    print(f"Скачиваю тариф: {url}")
    pdf = download(url)
    rows, effective = parse(pdf)
    logistics = build_logistics(rows)
    print(f"Найдено способов доставки: {', '.join(logistics.keys())}; действует с: {effective}")

    payload = {
        "meta": {
            "updated": datetime.date.today().isoformat(),
            "effective": effective,
            "source": url,
        },
        "logistics": {
            k: {
                "name": n,
                "light": r["light"], "heavy": r["heavy"],
                "limitSum": r["limitSum"], "limitSide": r["limitSide"],
            } for k, (n, r) in logistics.items()
        },
    }

    # Пишем ТОЛЬКО tariffs.override.json (gitignored) — код и git не трогаются.
    # Категории (комиссии) сюда не пишем: калькулятор берёт их из tariffs.json (merge поверх).
    with open(OVERRIDE_OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"Записан: {OVERRIDE_OUT}")
    print("Калькулятор подхватит новые тарифы сам (перезапуск сервера не обязателен —")
    print("файл читается при загрузке страницы). Код не изменён, git-конфликтов не будет.")


if __name__ == "__main__":
    main()
