#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collect.py — собирает данные из MPStats API и пишет data.json для build.py.

Тянет по каждому артикулу: карточку (первая дата, бренд, цены, остатки по
размерам и складам), продажи по дням, позиции по ключевым запросам; по всей
категории — рынок (выручка, ранги, доли); по подсегменту запроса — аналитику
ниши. Качественные вердикты (role/assessment/signals) генерируются
автоматически по эвристикам — их можно поправить руками в data.json.

Требуется переменная окружения MPSTATS_TOKEN.

Примеры:
    MPSTATS_TOKEN=xxx python3 collect.py --sku 447156582 428365795 \
        --category "Мужчинам/Рубашки" \
        --query "рубашка мужская однотонная с длинным рукавом" \
        --out reports-output/data.json
    # период по умолчанию — последние 30 дней (--days N или --d1/--d2)
"""
import json, os, sys, ssl, time, base64, argparse, datetime as dt, urllib.parse, urllib.request
from collections import defaultdict

BASE = os.environ.get('MPSTATS_BASE_URL', 'https://mpstats.io/api').rstrip('/')
CTX = ssl.create_default_context()
PALETTES = [
    ['#0E9488', '#0B7C72', '#E8F6F4', '#F3FAF9'],   # teal
    ['#C7891B', '#9A6A10', '#FBF2DF', '#FDF9F0'],   # gold
    ['#8A3FFC', '#6425C0', '#F0E9FC', '#F8F5FE'],   # violet
    ['#C0392B', '#94271B', '#FBEAE7', '#FDF4F2'],   # red
    ['#1F7A4D', '#155C39', '#E6F4EC', '#F2FAF6'],   # green
]
NICHE_PALETTE = ['#3B4CA8', '#2A377E', '#EBEDFA', '#F5F6FC']

WH_NAMES = {'507': 'Коледино', '117986': 'Казань', '120762': 'Электросталь', '130744': 'Тула',
            '206348': 'СПб · Уткина Заводь', '208277': 'Невинномысск', '300571': 'Обухово'}

# ---- HTTP ----
def token():
    t = os.environ.get('MPSTATS_TOKEN')
    if not t:
        sys.exit('ОШИБКА: не задан MPSTATS_TOKEN в переменных окружения')
    return t

def api(path, method='GET', body=None, q=None, retries=3):
    url = BASE + path + ('?' + urllib.parse.urlencode(q) if q else '')
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers={
                'X-Mpstats-TOKEN': token(), 'Accept': 'application/json', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=90, context=CTX) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw.strip() else None
        except Exception as e:
            if attempt == retries:
                print(f'  ! {method} {path}: {e}', file=sys.stderr); return None
            time.sleep(2 * (2 ** attempt))

# ---- dates ----
def default_period(days):
    d2 = dt.date(2026, 7, 7)  # фиксируйте «сегодня» через --d2, если нужно
    try: d2 = dt.date.today()
    except Exception: pass
    return (d2 - dt.timedelta(days=days)).isoformat(), (d2 - dt.timedelta(days=1)).isoformat()

def days_ago(s, ref):
    if not s: return None
    try:
        y, m, d = int(str(s)[:4]), int(str(s)[5:7]), int(str(s)[8:10])
        return (ref - dt.date(y, m, d)).days
    except Exception: return None

# ---- per-article ----
def collect_article(sku, d1, d2):
    info = (api(f'/wb/get/item/{sku}') or {}).get('item')
    if not info:
        print(f'  ! артикул {sku}: карточка не найдена', file=sys.stderr); return None
    sas = info.get('sizeandstores', {}) or {}
    sizes, wh_qty = [], defaultdict(int)
    for s in sas.values():
        sv = s.get('s', {}); sv = sv if isinstance(sv, dict) else {}
        sizes.append({'name': s['n'], 'origin': s['o'], 'qty': sum(sv.values())})
        for w, c in sv.items(): wh_qty[w] += c
    sales = api(f'/wb/get/item/{sku}/sales', q={'d1': d1, 'd2': d2}) or []
    days_instock = sum(1 for r in sales if (r.get('balance') or 0) > 0)
    # category row (buyout, revenue, lost_profit, ...) via filter
    o = {'name': info['name'], 'brand': info['brand'], 'seller': info['seller'],
         'first_date': info.get('first_date'), 'final_price': info['final_price'],
         'price': info['price'], 'discount': info['discount'], 'rating': info['rating'],
         'comments': info['comments'], 'sizes': sizes,
         'warehouses_ids': sorted(wh_qty.items(), key=lambda x: -x[1]),
         'warehouses_count': len(wh_qty), 'stock_total': sum(x['qty'] for x in sizes),
         'days_in_stock_30': days_instock}
    # keywords
    ik = api(f'/wb/get/item/{sku}/by_keywords', q={'d1': d1, 'd2': d2}) or {}
    words = ik.get('words', {}) if isinstance(ik, dict) else {}
    o['kw'] = {}
    for tq in TARGET_QUERIES:
        w = words.get(tq)
        o['kw'][tq] = ({'avg_pos': w.get('avg_pos'), 'avg_organic': w.get('avg_organic_pos'),
                        'avg_ad': w.get('avg_ad_pos'), 'total': w.get('total')} if w else None)
    return o

# ---- category (market) ----
def collect_category(path, d1, d2, page=5000):
    rows, start = [], 0
    while True:
        d = api('/wb/get/category', 'POST',
                {'startRow': start, 'endRow': start + page, 'filterModel': {},
                 'sortModel': [{'colId': 'revenue', 'sort': 'desc'}]},
                q={'path': path, 'd1': d1, 'd2': d2})
        if not d or not d.get('data'): break
        rows += d['data']; total = d.get('total', len(rows))
        start += page
        if start >= total: break
    seen = set()
    return [r for r in rows if not (r['id'] in seen or seen.add(r['id']))]

# ---- niche filter ----
PAT = ['клет', 'полос', 'принт', 'цветочн', 'узор', 'гавай', 'пейсли', 'камуфляж', 'лого', 'тай-дай', 'абстрак', 'рисунок', 'орнам']
NONCLASSIC = ['оверсайз', 'пляжн', 'капюшон', 'джинсов', 'вельвет', 'фланел', 'поло ', 'рубашка-поло', 'терм', 'утепл', 'худи', 'лонгслив', 'футбол', 'куртка', 'махров']
SHORT = ['коротк']

def in_niche(r):
    name = (r.get('name') or '').lower(); color = (r.get('color') or '').lower()
    if any(w in name for w in SHORT): return False
    if any(w in name or w in color for w in PAT): return False
    if any(w in name for w in NONCLASSIC): return False
    return True

def pctile(vals, p):
    vals = sorted(vals); i = max(0, min(len(vals) - 1, int(round(p / 100 * (len(vals) - 1))))); return vals[i]

def compute_niche(all_rows, query, ref, ours_ids):
    NICHE = [r for r in all_rows if in_niche(r)]
    rev = lambda r: r.get('revenue') or 0; sl = lambda r: r.get('sales') or 0
    n_rev = sum(rev(r) for r in NICHE); n_sales = sum(sl(r) for r in NICHE); n_n = len(NICHE)
    cat_rev = sum(rev(r) for r in all_rows)
    prices = [r['final_price'] for r in NICHE if (r.get('final_price') or 0) > 0 and sl(r) > 0]
    buyout = sum((r.get('purchase') or 0) * sl(r) for r in NICHE) / max(1, n_sales)
    dead = sum(1 for r in NICHE if sl(r) == 0)
    with_sales = [r for r in NICHE if sl(r) > 0]
    new90 = sum(1 for r in NICHE if (days_ago(r.get('sku_first_date'), ref) or 9999) <= 90)
    new180 = sum(1 for r in NICHE if (days_ago(r.get('sku_first_date'), ref) or 9999) <= 180)
    fbs = sum(1 for r in NICHE if r.get('is_fbs'))
    srt = sorted(NICHE, key=lambda r: -rev(r))
    tsh = lambda k: round(sum(rev(r) for r in srt[:k]) / max(1, n_rev) * 100, 1)
    cum = 0; n80 = 0
    for r in srt:
        cum += rev(r); n80 += 1
        if cum >= 0.8 * n_rev: break
    bd = defaultdict(lambda: [0, 0, 0])
    for r in NICHE:
        b = r.get('brand') or '—'; bd[b][0] += rev(r); bd[b][2] += 1
    brands = sorted(bd.items(), key=lambda kv: -kv[1][0])[:8]
    sd = defaultdict(int)
    for r in NICHE: sd[r.get('seller') or '—'] += 1
    bands = [('до 1 500', 0, 1500), ('1 500–2 000', 1500, 2000), ('2 000–2 500', 2000, 2500),
             ('2 500–3 000', 2500, 3000), ('3 000–4 000', 3000, 4000), ('4 000+', 4000, 10 ** 9)]
    band_out = [(l, round(sum(rev(r) for r in NICHE if a <= (r.get('final_price') or 0) < b)),
                 round(sum(rev(r) for r in NICHE if a <= (r.get('final_price') or 0) < b) / max(1, n_rev) * 100, 1),
                 sum(1 for r in NICHE if a <= (r.get('final_price') or 0) < b and sl(r) > 0)) for l, a, b in bands]
    rankmap = {r['id']: i + 1 for i, r in enumerate(srt)}
    ours = {}
    for sku in ours_ids:
        r = next((x for x in NICHE if x['id'] == int(sku)), None)
        if r: ours[str(sku)] = dict(rank=rankmap[int(sku)], revenue=rev(r), sales=sl(r), share=round(rev(r) / n_rev * 100, 3))
    leaders = [dict(id=r['id'], name=r['name'][:46], brand=r.get('brand'), rev=rev(r), sales=sl(r),
                    price=r.get('final_price'), buyout=r.get('purchase'),
                    share=round(rev(r) / n_rev * 100, 2), image=fetch_image(r)) for r in srt[:6]]
    return dict(
        query=query, palette=NICHE_PALETTE, n_n=n_n, n_rev=n_rev, n_sales=n_sales,
        niche_rev_share=round(n_rev / cat_rev * 100, 1), niche_n_share=round(n_n / len(all_rows) * 100, 1),
        price_median=round(__import__('statistics').median(prices)) if prices else None,
        price_mean=round(sum(prices) / len(prices)) if prices else None,
        price_p25=pctile(prices, 25) if prices else None, price_p75=pctile(prices, 75) if prices else None,
        buyout=round(buyout, 1), dead=dead, dead_share=round(dead / n_n * 100, 1),
        with_sales=len(with_sales), with_sales_share=round(len(with_sales) / n_n * 100, 1),
        new90_share=round(new90 / n_n * 100, 1), new180_share=round(new180 / n_n * 100, 1),
        fbs_share=round(fbs / n_n * 100, 1),
        top10=tsh(10), top50=tsh(50), top100=tsh(100), n80=n80, n80_share=round(n80 / n_n * 100, 1),
        n_brands=len(bd), n_sellers=len(sd),
        brands=[(b, round(v[0]), round(v[0] / n_rev * 100, 1), v[2]) for b, v in brands],
        bands=band_out, leaders=leaders, ours=ours,
        assessment=[
            f"Крупная ниша: {money(n_rev)} ₽/30д и {n_n} SKU ({round(n_rev/cat_rev*100,1)}% рынка категории). "
            f"Активных карточек {round(len(with_sales)/n_n*100,1)}%, средний выкуп {round(buyout,1)}%.",
            f"Концентрация: ТОП-100 держит {tsh(100)}% выручки, 80% дают {n80} карточек — "
            f"{'рынок раздроблен, вход открыт' if tsh(100) < 50 else 'рынок концентрирован'}. "
            f"Медианная цена {round(__import__('statistics').median(prices)) if prices else '—'} ₽."],
    )

# ---- auto verdicts for articles ----
def money(x):
    if x >= 1e9: return f"{x/1e9:.2f} млрд"
    if x >= 1e6: return f"{round(x/1e6):,}".replace(',', ' ') + ' млн'
    return f"{round(x):,}".replace(',', ' ')

def fetch_image(catrow):
    """Тянет миниатюру товара (thumb_middle из строки категории) и кодирует в data-URI."""
    u = catrow.get('thumb_middle') or catrow.get('thumb')
    if not u: return ''
    if u.startswith('//'): u = 'https:' + u
    try:
        with urllib.request.urlopen(u, timeout=30, context=CTX) as r:
            ct = r.headers.get('content-type', 'image/webp')
            return f'data:{ct};base64,' + base64.b64encode(r.read()).decode()
    except Exception:
        return ''

def enrich_article(sku, o, catrow, market, idx):
    o['palette'] = PALETTES[idx % len(PALETTES)]
    o['image'] = fetch_image(catrow)
    o['cat_row'] = {k: catrow.get(k) for k in ['sales', 'revenue', 'purchase', 'purchase_after_return',
                    'lost_profit', 'lost_profit_percent', 'days_in_stock', 'days_in_site', 'sales_estimated',
                    'warehouses_count', 'balance', 'sku_first_date', 'sales_per_day_average',
                    'search_words_count', 'search_visibility']}
    o['market'] = market
    rank = market['rank']; ntot = market['of']
    if rank <= 100: role = 'Сильная карточка · ТОП-100 категории'
    elif rank <= ntot * 0.1: role = 'Крепкий середняк'
    else: role = 'Карточка среднего/нижнего хвоста'
    o['role'] = role
    sig = []
    if catrow.get('days_in_stock') and catrow['days_in_stock'] >= 28:
        sig.append(['Товар практически не уходил в ноль', 'ok'])
    else:
        sig.append(['Были стоковые простои', 'risk'])
    zeros = [s['name'] for s in o['sizes'] if s['qty'] == 0]
    if zeros: sig.append([f"Нулевые размеры: {', '.join(zeros[:4])}", 'risk'])
    organic = all((o['kw'].get(q) or {}).get('avg_organic') in (0, None) for q in TARGET_QUERIES if o['kw'].get(q))
    if organic: sig.append(['Нет органики в поиске (только реклама)', 'risk'])
    o['signals'] = sig[:3]
    o['assessment'] = (
        f"{role}. Заказы за 30 дней: {money(catrow.get('revenue') or 0)} ₽ "
        f"({catrow.get('sales')} шт), выкуп {catrow.get('purchase')}%, доля рынка {market['share_pct']}% "
        f"(ранг {rank} из {ntot}). Остатки {o['stock_total']} шт на {o['warehouses_count']} складах. "
        + ("Внимание: есть нулевые размеры — риск упущенных продаж. " if zeros else "")
        + ("Поисковая видимость держится на рекламе, органики нет — зона роста через SEO." if organic else ""))
    return o

# ---- main ----
TARGET_QUERIES = ['рубашка мужская с длинным рукавом', 'рубашка мужская однотонная']

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sku', nargs='+', required=True, help='WB-артикулы (nmId)')
    ap.add_argument('--category', required=True, help='путь категории MPStats, напр. "Мужчинам/Рубашки"')
    ap.add_argument('--query', required=True, help='поисковый запрос ниши (для заголовка/фильтра)')
    ap.add_argument('--queries', nargs='*', help='целевые запросы для позиций (по умолчанию 2 встроенных)')
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--d1'); ap.add_argument('--d2')
    ap.add_argument('--out', default='reports-output/data.json')
    a = ap.parse_args()
    global TARGET_QUERIES
    if a.queries: TARGET_QUERIES = a.queries
    d1, d2 = (a.d1, a.d2) if (a.d1 and a.d2) else default_period(a.days)
    ref = dt.date(*map(int, d2.split('-')))
    print(f'Период {d1} … {d2} · категория «{a.category}» · артикулы {a.sku}')

    print('· категория (рынок)…')
    all_rows = collect_category(a.category, d1, d2)
    print(f'  получено {len(all_rows)} SKU')
    srt = sorted(all_rows, key=lambda r: -(r.get('revenue') or 0))
    total_rev = sum((r.get('revenue') or 0) for r in srt)
    top100 = sum((r.get('revenue') or 0) for r in srt[:100])
    rankmap = {r['id']: i + 1 for i, r in enumerate(srt)}
    catrows = {r['id']: r for r in all_rows}

    data = {'meta': {'d1': d1, 'd2': d2, 'days': a.days, 'category': a.category, 'query': a.query,
                     'market_total_revenue': total_rev, 'top100_sum': top100, 'n_sku': len(all_rows),
                     'generated': d2},
            'order': [str(s) for s in a.sku], 'articles': {}, 'niche': {}}

    for idx, sku in enumerate(a.sku):
        print(f'· артикул {sku}…')
        o = collect_article(sku, d1, d2)
        if not o: continue
        cr = catrows.get(int(sku), {})
        market = {'rank': rankmap.get(int(sku)), 'of': len(all_rows),
                  'share_pct': round((cr.get('revenue') or 0) / total_rev * 100, 4)}
        data['articles'][str(sku)] = enrich_article(sku, o, cr, market, idx)

    print('· ниша…')
    data['niche'] = compute_niche(all_rows, a.query, ref, a.sku)

    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump(data, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'✓ {a.out}')

if __name__ == '__main__':
    main()
