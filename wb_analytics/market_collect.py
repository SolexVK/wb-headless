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


# контекст-полосы цен (для таблицы ёмкости)
CONTEXT_BANDS = [('Низкий', '< 1 700 ₽', 0, 1700), ('Средний', '1 700–2 500 ₽', 1700, 2500),
                 ('Выше среднего', '2 500–3 500 ₽', 2500, 3500), ('Высокий', '3 500+ ₽', 3500, 10 ** 9)]


def _scenarios(SEG, lo, hi, days, price_ref=None):
    """3 сценария продаж/мес для карточки в ценовой зоне [lo,hi): по перцентилям
    фактических продаж активных карточек зоны (90-дн. продажи → месяц)."""
    import statistics as st
    sl = lambda r: r.get('sales') or 0
    Z = [r for r in SEG if lo <= (r.get('final_price') or 0) < hi]
    Za = [r for r in Z if sl(r) > 0]
    if not Za:
        return None
    hp = [r.get('final_price') for r in Za]; hs = [sl(r) for r in Za]
    price = price_ref or round(st.median(hp))
    mo = max(1, days / 30.0)
    def scen(name, pctl, note):
        u = round(pctile(hs, pctl) / mo)
        return {'name': name, 'pctl': pctl, 'units_mo': u, 'price': price,
                'revenue_mo': round(u * price), 'note': note}
    return {'lo': lo, 'hi': hi, 'price_median': price,
            'price_p25': pctile(hp, 25), 'price_p75': pctile(hp, 75),
            'card_sales_median': pctile(hs, 50), 'card_sales_p75': pctile(hs, 75), 'card_sales_p90': pctile(hs, 90),
            'scenarios': [scen('Осторожный', 50, 'медиана продаж активной карточки зоны'),
                          scen('Реалистичный', 75, 'уровень сильной карточки (p75 зоны)'),
                          scen('Амбициозный', 90, 'уровень топовой карточки (p90 зоны)')]}


def price_forecast(SEG, days, zone, sub_bands):
    """Прогноз по целевой ценовой зоне (напр. средний+выше-среднего) с разбивкой на
    подсегменты и контекст-таблицей ёмкости. Всё из категорийных строк, без сети."""
    import statistics as st
    rev = lambda r: r.get('revenue') or 0; sl = lambda r: r.get('sales') or 0
    seg_rev = sum(rev(r) for r in SEG) or 1
    lo, hi = zone
    Z = [r for r in SEG if lo <= (r.get('final_price') or 0) < hi]
    Za = [r for r in Z if sl(r) > 0]
    combined = _scenarios(SEG, lo, hi, days)
    subs = []
    for name, a, b in sub_bands:
        f = _scenarios(SEG, a, b, days)
        cs = [r for r in SEG if a <= (r.get('final_price') or 0) < b]
        if f:
            f.update({'name': name, 'sku': len(cs), 'active': len([r for r in cs if sl(r) > 0]),
                      'sales': sum(sl(r) for r in cs), 'revenue': sum(rev(r) for r in cs)})
            subs.append(f)
    context = []
    for nm, rng, a, b in CONTEXT_BANDS:
        cs = [r for r in SEG if a <= (r.get('final_price') or 0) < b]
        act = [r for r in cs if sl(r) > 0]
        context.append({'name': nm, 'range': rng, 'sku': len(cs), 'sales': sum(sl(r) for r in cs),
                        'revenue': sum(rev(r) for r in cs),
                        'avg_card': round(sum(sl(r) for r in act) / len(act)) if act else 0,
                        'target': a >= lo and b <= hi})
    return {'zone': [lo, hi], 'n_sku': len(Z), 'active': len(Za),
            'sales': sum(sl(r) for r in Z), 'revenue': sum(rev(r) for r in Z),
            'share_rev': round(sum(rev(r) for r in Z) / seg_rev * 100),
            'price_median': combined['price_median'] if combined else 0,
            'price_p25': combined['price_p25'] if combined else 0,
            'price_p75': combined['price_p75'] if combined else 0,
            'card_sales_median': combined['card_sales_median'] if combined else 0,
            'card_sales_p90': combined['card_sales_p90'] if combined else 0,
            'scenarios': combined['scenarios'] if combined else [],
            'subs': subs, 'context': context, 'days': days}


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
    fc = cfg.get('forecast', {}) or {}
    fc_zone = fc.get('zone', [1700, 3500])
    fc_subs = fc.get('sub_bands', [['Средний', 1700, 2500], ['Выше среднего', 2500, 3500]])

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
        'forecast': price_forecast(SEG, days, fc_zone, fc_subs)}


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
