#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Обновление тарифов логистики WB для Китая в калькуляторе.

Скачивает официальный тарифный PDF WB и перегенерирует блок между маркерами
  // TARIFFS_AUTOGEN_START ... // TARIFFS_AUTOGEN_END
в файле ../calculator/app.js, а также пишет wb_tariffs.json для истории.

Запуск:
    python3 update-wb-tariffs.py [URL_PDF]

Если URL не указан — берётся текущий известный. Когда WB публикует новый тариф
(меняется имя файла PDF), передайте новый URL первым аргументом.

Зависимости: pdfplumber (pip install pdfplumber), curl в PATH.
"""
import sys, os, re, json, subprocess, datetime, tempfile

DEFAULT_URL = "https://static-basket-02.wbbasket.ru/vol20/China/warehouse_and_tarrifs/0726.pdf"
HERE = os.path.dirname(os.path.abspath(__file__))
APP_JS = os.path.normpath(os.path.join(HERE, "..", "calculator", "app.js"))
JSON_OUT = os.path.join(HERE, "wb_tariffs.json")
START = "// TARIFFS_AUTOGEN_START"
END = "// TARIFFS_AUTOGEN_END"

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


def js_block(logistics, url, effective):
    today = datetime.date.today().isoformat()
    lines = [START + " — блок регенерируется скриптом tools/update-wb-tariffs.py из официального тарифа WB"]
    lines.append("const TARIFFS_META = {")
    lines.append(f"  updated:  '{today}',")
    lines.append(f"  effective:'{effective}',")
    lines.append(f"  source:   '{url}',")
    lines.append("};")
    lines.append("const LOGISTICS = {")
    for key, (name, r) in logistics.items():
        lines.append(
            f"  {key + ':':<9} {{ name: '{name}', "
            f"light: {{ kg: {r['light']['kg']:g}, item: {r['light']['item']:g} }}, "
            f"heavy: {{ kg: {r['heavy']['kg']:g}, item: {r['heavy']['item']:g} }}, "
            f"limitSum: {r['limitSum']}, limitSide: {r['limitSide']} }},"
        )
    lines.append("};")
    lines.append(END)
    return "\n".join(lines)


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    print(f"Скачиваю тариф: {url}")
    pdf = download(url)
    rows, effective = parse(pdf)
    logistics = build_logistics(rows)
    print(f"Найдено способов доставки: {', '.join(logistics.keys())}; действует с: {effective}")

    block = js_block(logistics, url, effective)

    # Обновляем app.js между маркерами
    with open(APP_JS, encoding="utf-8") as f:
        src = f.read()
    if START not in src or END not in src:
        raise SystemExit(f"Маркеры {START}/{END} не найдены в {APP_JS}")
    new = re.sub(re.escape(START) + r".*?" + re.escape(END), block, src, flags=re.S)
    with open(APP_JS, "w", encoding="utf-8") as f:
        f.write(new)

    # Пишем json для истории
    with open(JSON_OUT, "w", encoding="utf-8") as f:
        json.dump({
            "updated": datetime.date.today().isoformat(),
            "effective": effective, "source": url,
            "logistics": {k: {"name": n, **{kk: vv for kk, vv in r.items() if kk in ("light", "heavy", "limitSum", "limitSide")}}
                          for k, (n, r) in logistics.items()},
        }, f, ensure_ascii=False, indent=2)

    print(f"Обновлён: {APP_JS}")
    print(f"Записан:  {JSON_OUT}")
    print("Далее пересоберите standalone.html/артефакт (см. README).")


if __name__ == "__main__":
    main()
