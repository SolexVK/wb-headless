#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
market_collect.py — сбор данных рыночного отчёта (market.py) по конфигу.

По категории и правилам сегмента собирает из MPStats: объём рынка и сегмента,
ТОП-N карточек с фото, структуру продаж по цветам (взвешенно по продажам всего
сегмента) и по размерам (на выборке ТОП-конкурентов, размерные сетки нормализуются
к единой лестнице S–4XL+). Результат → market_data.json для market.py.

Сегмент задаётся конфигом (подходит под любую нишу):
  include_any     — в названии есть хотя бы одно слово (например крой/фасон);
  exclude_pattern — узоры → НЕ однотонный (клетка/полоска/принт…);
  exclude_style   — не наш силуэт (оверсайз/пляжное…);
  exclude_sleeve  — исключить (например короткий рукав);
  solid_by_color  — считать однотонным только одиночный цвет (без запятых/мульти).

    MPSTATS_TOKEN=xxx python3 wb_analytics/market_collect.py wb_analytics/configs/shirts_market.example.json
"""
import json, os, sys, statistics as st, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A

SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL+']
FAM_RULES = [
    ('Белый', ['бел']), ('Синий/голубой', ['голуб', 'син']), ('Чёрный', ['чер', 'чёр']),
    ('Бежевый', ['беж']), ('Серый', ['сер']), ('Зелёный/хаки', ['зелен', 'зелён', 'хаки', 'олив']),
    ('Коричневый', ['корич']), ('Красный/бордо', ['борд', 'красн', 'вин'])]


def color_family(c):
    c = (c or '').lower()
    for fam, keys in FAM_RULES:
        if any(k in c for k in keys):
            return fam
    return 'Другое'


def norm_size(origin, name):
    o = (origin or '').upper().replace(' ', '')
    if '/' in o:
        o = o.split('/')[-1]
    tbl = {'XXXS': 'XXS', '3XS': 'XXS', '2XS': 'XXS', 'XXS': 'XXS', 'XS': 'XS', 'S': 'S', 'M': 'M',
           'L': 'L', 'XL': 'XL', 'XXL': '2XL', '2XL': '2XL', 'XXXL': '3XL', '3XL': '3XL',
           '4XL': '4XL+', '5XL': '4XL+', '6XL': '4XL+', '7XL': '4XL+', '8XL': '4XL+'}
    return tbl.get(o, o or '?')


def pctile(v, p):
    v = sorted(v)
    return v[max(0, min(len(v) - 1, round(p / 100 * (len(v) - 1))))] if v else 0


HIGH_BANDS = [('2 500–3 500', 2500, 3500), ('3 500–5 000', 3500, 5000), ('5 000+', 5000, 10 ** 9)]


def high_segment_stats(SEG, threshold, days):
    """Ёмкость и прогноз высокого ценового сегмента (цена >= threshold).
    Прогноз на карточку — по перцентилям фактических продаж активных дорогих карточек
    (90-дн. продажи приводятся к месяцу). Без обращения к сети — из категорийных строк."""
    import statistics as st
    rev = lambda r: r.get('revenue') or 0
    sl = lambda r: r.get('sales') or 0
    seg_rev = sum(rev(r) for r in SEG) or 1
    HI = [r for r in SEG if (r.get('final_price') or 0) >= threshold]
    HIa = [r for r in HI if sl(r) > 0]
    if not HIa:
        return None
    hp = [r.get('final_price') for r in HIa]
    hs = [sl(r) for r in HIa]
    hi_rev = sum(rev(r) for r in HI); hi_sales = sum(sl(r) for r in HI)
    price_ref = round(st.median(hp))
    mo = max(1, days / 30.0)   # делитель 90д→месяц
    def scen(name, units90, price, note):
        u = round(units90 / mo)
        return {'name': name, 'units_mo': u, 'price': price, 'revenue_mo': round(u * price), 'note': note}
    top10 = sorted(HI, key=lambda r: -rev(r))[:10]
    top10_sales = round(st.mean([sl(r) for r in top10])) if top10 else 0
    top10_price = round(st.mean([r.get('final_price') for r in top10])) if top10 else price_ref
    scenarios = [
        scen('Осторожный', pctile(hs, 50), price_ref, 'медиана продаж активной дорогой карточки'),
        scen('Реалистичный', pctile(hs, 75), price_ref, 'уровень сильной карточки (p75 сегмента)'),
        scen('Амбициозный', pctile(hs, 90), price_ref, 'уровень топовой карточки (p90 сегмента)'),
    ]
    bands = []
    for lbl, a, b in HIGH_BANDS:
        cs = [r for r in SEG if a <= (r.get('final_price') or 0) < b]
        act = [r for r in cs if sl(r) > 0]
        bands.append({'label': lbl, 'sku': len(cs), 'active': len(act),
                      'sales': sum(sl(r) for r in cs), 'revenue': sum(rev(r) for r in cs),
                      'avg_card': round(sum(sl(r) for r in act) / len(act)) if act else 0})
    return {'threshold': threshold, 'n_sku': len(HI), 'active': len(HIa),
            'sales': hi_sales, 'revenue': hi_rev, 'share_rev': round(hi_rev / seg_rev * 100),
            'price_median': price_ref, 'price_p25': pctile(hp, 25), 'price_p75': pctile(hp, 75),
            'price_p90': pctile(hp, 90),
            'card_sales_median': pctile(hs, 50), 'card_sales_p75': pctile(hs, 75), 'card_sales_p90': pctile(hs, 90),
            'top10_sales': top10_sales, 'top10_price': top10_price,
            'top10_units_mo': round(top10_sales / mo),
            'top10_rev_mo': round(top10_sales / mo * top10_price),
            'scenarios': scenarios, 'bands': bands, 'days': days}


def collect(cfg):
    per = cfg.get('period', {}) or {}
    days = per.get('days', 90)
    import datetime as dt
    d2 = per.get('d2') or dt.date.today().isoformat()
    d1 = per.get('d1') or (dt.date.fromisoformat(d2) - dt.timedelta(days=days)).isoformat()
    category = cfg['category']
    seg = cfg.get('segment', {}) or {}
    inc = seg.get('include_any', [])
    ex_pat = seg.get('exclude_pattern', [])
    ex_sty = seg.get('exclude_style', [])
    ex_slv = seg.get('exclude_sleeve', [])
    solid_by_color = seg.get('solid_by_color', True)
    top_n = cfg.get('top_n', 20)
    n_sizes = cfg.get('sizes_sample', 150)
    high_threshold = cfg.get('high_price_threshold', 2500)

    rev = lambda r: r.get('revenue') or 0
    sl = lambda r: r.get('sales') or 0

    def is_solid(r):
        if solid_by_color:
            c = (r.get('color') or '').lower()
            if ',' in c or c in ('разноцветный', 'мультиколор', 'мульти'):
                return False
        n = (r.get('name') or '').lower()
        return not any(p in n for p in ex_pat)

    def seg_ok(r):
        n = (r.get('name') or '').lower()
        if inc and not any(f in n for f in inc):
            return False
        if any(s in n for s in ex_sty):
            return False
        if any(sv in n for sv in ex_slv):
            return False
        return is_solid(r)

    print(f'период {d1}…{d2} · категория «{category}»')
    ALL = A.fetch_category(category, d1, d2)
    if not ALL:
        sys.exit('пустой ответ категории — повторите запуск')
    tot_rev = sum(rev(r) for r in ALL); tot_sales = sum(sl(r) for r in ALL)
    SEG = sorted([r for r in ALL if seg_ok(r)], key=lambda r: -rev(r))
    seg_rev = sum(rev(r) for r in SEG); seg_sales = sum(sl(r) for r in SEG)
    print(f'  рынок {len(ALL)} SKU · сегмент {len(SEG)} SKU ({round(len(SEG)/len(ALL)*100)}%)')

    prices = [r.get('final_price') for r in SEG if (r.get('final_price') or 0) > 0 and sl(r) > 0]

    # ---- цвета: полный сегмент, взвешенно по продажам ----
    col_sales = collections.Counter(); fam_sales = collections.Counter()
    for r in SEG:
        col_sales[(r.get('color') or '—')] += sl(r)
        fam_sales[color_family(r.get('color'))] += sl(r)
    tot_col = sum(fam_sales.values()) or 1
    colors_family = [(c, n, round(n / tot_col * 100, 1)) for c, n in fam_sales.most_common()]
    colors_top = [(c, n, round(n / tot_col * 100, 1)) for c, n in col_sales.most_common(12)]

    # ---- ТОП-N с картинками ----
    top = []
    for r in SEG[:top_n]:
        top.append(dict(id=r['id'], name=r.get('name'), brand=r.get('brand'), seller=r.get('seller'),
                        price=r.get('final_price'), base=r.get('basic_price'), sales=sl(r), revenue=rev(r),
                        comments=r.get('comments'), rating=r.get('rating'), color=r.get('color'),
                        days=r.get('days_in_site'), spd=r.get('sales_per_day_average'), image=A.img_b64(r)))
        print(f"  top {r['id']} · {sl(r)} шт")

    # ---- размеры: выборка ТОП-конкурентов ----
    size_sales = collections.Counter(); size_bal = collections.Counter(); nsz = 0
    for r in SEG[:n_sizes]:
        d = A.api(f"/wb/get/item/{r['id']}/sizes", retries=2)
        if not isinstance(d, dict):
            continue
        nsz += 1
        for day, rows in d.items():
            if not isinstance(rows, list):
                continue
            for s in rows:
                b = norm_size(s.get('size_origin'), s.get('size_name'))
                size_sales[b] += s.get('sales') or 0
                size_bal[b] += s.get('balance') or 0
        if nsz % 40 == 0:
            print(f'  ...размеры {nsz}')
    tot_sz = sum(size_sales.values()) or 1
    sizes = [(b, size_sales[b], round(size_sales[b] / tot_sz * 100, 1)) for b in SIZE_ORDER if size_sales[b] > 0]

    return {
        'period': {'d1': d1, 'd2': d2, 'days': days}, 'category': category,
        'segment_name': cfg.get('segment_name', category), 'generated': d2,
        'market': {'n_sku': len(ALL), 'revenue': tot_rev, 'sales': tot_sales},
        'segment': {'n_sku': len(SEG), 'revenue': seg_rev, 'sales': seg_sales,
                    'price_median': round(st.median(prices)) if prices else 0,
                    'p25': pctile(prices, 25), 'p75': pctile(prices, 75),
                    'p10': pctile(prices, 10), 'p90': pctile(prices, 90),
                    'share_rev': round(seg_rev / tot_rev * 100, 1) if tot_rev else 0,
                    'n_brands': len(set((r.get('brand') or '—') for r in SEG)),
                    'n_sellers': len(set((r.get('seller') or '—') for r in SEG)),
                    'top10': round(sum(rev(r) for r in SEG[:10]) / seg_rev * 100) if seg_rev else 0,
                    'top50': round(sum(rev(r) for r in SEG[:50]) / seg_rev * 100) if seg_rev else 0,
                    'top100': round(sum(rev(r) for r in SEG[:100]) / seg_rev * 100) if seg_rev else 0},
        'top20': top, 'colors_family': colors_family, 'colors_top': colors_top, 'colors_sample': len(SEG),
        'sizes': sizes, 'sizes_sample': nsz, 'sizes_total': tot_sz,
        'high_segment': high_segment_stats(SEG, high_threshold, days)}


def main(argv):
    if not argv:
        sys.exit('использование: market_collect.py CONFIG.json [--out data.json]')
    cfg_path = argv[0]
    cfg = json.load(open(cfg_path, encoding='utf-8'))
    out = cfg.get('out') or 'reports-output/market_data.json'
    if '--out' in argv:
        out = argv[argv.index('--out') + 1]
    D = collect(cfg)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(D, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
    print('данные →', out)


if __name__ == '__main__':
    main(sys.argv[1:])
