#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collect_seller.py — конкурентный анализ ПРОДАВЦА по его артикулам и нише.

Собирает из MPStats API по списку nmId продавца: метрики целевых карточек,
рынок ниши, сопоставимый сегмент (например, комплекты), ТОП-конкурентов,
географию складов (продавец vs конкуренты), оценку потенциала и план
распределения стока по центральным хабам, авто-дорожную карту → seller_data.json
для build_seller.py.

Почему по nmId: MPStats не отдаёт ассортимент продавца по id/имени надёжно
(бренд-сквоттинг, seller-by-id закрыт), а WB catalog/card API за антиботом.
По nmId же item/* и category работают стабильно.

Требуется MPSTATS_TOKEN. Пример:
    MPSTATS_TOKEN=xxx python3 collect_seller.py \
      --sku 707011618 529697243 707008613 ... \
      --category "Дом/Детская/Постельные принадлежности/Для детей/Постельное белье" \
      --niche-name "детское постельное бельё" \
      --comparable постельное_бель кпб \
      --seller-name "ИП Комиренко Т А" --seller-id 4289467 \
      --detailed 3 --out reports-output/seller_data.json
"""
import json, os, sys, ssl, time, base64, argparse, datetime as dt, urllib.parse, urllib.request
import statistics as st
from collections import defaultdict

BASE = os.environ.get('MPSTATS_BASE_URL', 'https://mpstats.io/api').rstrip('/')
CTX = ssl.create_default_context()
STORES_URL = 'https://static-basket-01.wbbasket.ru/vol0/data/stores-data.json'

# Центральные (флагманские) хабы WB — Москва/ЦФО + города-миллионники, куда идёт
# основная масса заказов. PRIORITY — 6 ключевых для сводки.
CENTRAL_IDS = {507, 120762, 206348, 117501, 218623, 301229, 206236, 218210, 312807,
               117986, 2737, 1733, 130744, 686, 208277, 301809}
PRIORITY = [(507, 'Коледино'), (120762, 'Электросталь'), (206348, 'Алексин (Тула)'),
            (117986, 'Казань'), (2737, 'Санкт-Петербург'), (1733, 'Екатеринбург')]

def token():
    t = os.environ.get('MPSTATS_TOKEN')
    if not t: sys.exit('ОШИБКА: не задан MPSTATS_TOKEN')
    return t

def api(path, method='GET', body=None, q=None, retries=3):
    url = BASE + path + ('?' + urllib.parse.urlencode(q) if q else '')
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers={
                'X-Mpstats-TOKEN': token(), 'Accept': 'application/json', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=90, context=CTX) as r:
                raw = r.read().decode(); return json.loads(raw) if raw.strip() else None
        except Exception as e:
            if attempt == retries:
                print(f'  ! {method} {path}: {e}', file=sys.stderr); return None
            time.sleep(2 * (2 ** attempt))

def fetch_url_json(url, timeout=60):
    try:
        with urllib.request.urlopen(url, timeout=timeout, context=CTX) as x:
            return json.loads(x.read().decode())
    except Exception as e:
        print(f'  ! fetch {url}: {e}', file=sys.stderr); return None

def img_b64(catrow):
    u = catrow.get('thumb_middle') or catrow.get('thumb')
    if not u: return ''
    if u.startswith('//'): u = 'https:' + u
    try:
        with urllib.request.urlopen(u, timeout=30, context=CTX) as x:
            return 'data:' + x.headers.get('content-type', 'image/webp') + ';base64,' + base64.b64encode(x.read()).decode()
    except Exception:
        return ''

def pctile(v, p):
    v = sorted(v); return v[max(0, min(len(v) - 1, int(round(p / 100 * (len(v) - 1)))))] if v else None

def wh_footprint(info):
    sas = info.get('sizeandstores', {}) or {}; wh = defaultdict(int)
    for s in sas.values():
        sv = s.get('s', {}); sv = sv if isinstance(sv, dict) else {}
        for w, c in sv.items(): wh[int(w)] += c
    return wh

def sizes_of(info):
    sas = info.get('sizeandstores', {}) or {}; out = []
    for s in sas.values():
        sv = s.get('s', {}); sv = sv if isinstance(sv, dict) else {}
        out.append({'name': s['n'], 'origin': s.get('o', ''), 'qty': sum(sv.values())})
    return out

def fetch_category(path, d1, d2, page=5000):
    rows, start = [], 0
    while True:
        d = api('/wb/get/category', 'POST',
                {'startRow': start, 'endRow': start + page, 'filterModel': {}, 'sortModel': [{'colId': 'revenue', 'sort': 'desc'}]},
                q={'path': path, 'd1': d1, 'd2': d2})
        if not d or not d.get('data'): break
        rows += d['data']; total = d.get('total', len(rows)); start += page
        if start >= total: break
    seen = set(); return [r for r in rows if not (r['id'] in seen or seen.add(r['id']))]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sku', nargs='+', type=int, required=True)
    ap.add_argument('--category', required=True)
    ap.add_argument('--niche-name', required=True)
    ap.add_argument('--comparable', nargs='*', default=['постельное бель', 'кпб', 'комплект бель'],
                    help='подстроки названия, определяющие сопоставимый сегмент (комплекты). "a b" = обе подстроки.')
    ap.add_argument('--seller-name', required=True)
    ap.add_argument('--seller-id', type=int, required=True)
    ap.add_argument('--detailed', type=int, default=3)
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--d1'); ap.add_argument('--d2')
    ap.add_argument('--n-competitors', type=int, default=12)
    ap.add_argument('--out', default='reports-output/seller_data.json')
    a = ap.parse_args()
    d2 = a.d2 or dt.date.today().isoformat()
    d1 = a.d1 or (dt.date.fromisoformat(d2) - dt.timedelta(days=a.days)).isoformat()
    TARGETS = a.sku; DETAILED = TARGETS[:a.detailed]
    rev = lambda r: r.get('revenue') or 0; sl = lambda r: r.get('sales') or 0

    def is_comp(r):
        n = (r.get('name') or '').lower()
        for term in a.comparable:
            if all(t in n for t in term.replace('_', ' ').split()): return True
        return False

    print(f'период {d1}…{d2} · ниша «{a.category}» · артикулов {len(TARGETS)}')
    print('· категория (рынок)…'); ALL = fetch_category(a.category, d1, d2)
    if not ALL: sys.exit('пустой ответ категории — повторите запуск')
    print(f'  {len(ALL)} SKU')
    ALL.sort(key=lambda r: -rev(r)); total_rev = sum(rev(r) for r in ALL); total_sales = sum(sl(r) for r in ALL)
    rankmap = {r['id']: i + 1 for i, r in enumerate(ALL)}; byid = {r['id']: r for r in ALL}
    top100 = sum(rev(r) for r in ALL[:100])

    COMP_SEG = sorted([r for r in ALL if is_comp(r)], key=lambda r: -rev(r))
    kpb_rank = {r['id']: i + 1 for i, r in enumerate(COMP_SEG)}; kpb_rev = sum(rev(r) for r in COMP_SEG)

    # warehouse names dict (official)
    stores = fetch_url_json(STORES_URL) or []
    WMAP = {s['id']: s['name'] for s in stores}
    wname = lambda w: (WMAP.get(int(w), f'#{w}')).replace(' WB', '').strip()

    # ---- targets ----
    targets = {}
    for sku in TARGETS:
        r = byid.get(sku, {}); info = (api(f'/wb/get/item/{sku}') or {}).get('item') or {}
        wh = wh_footprint(info)
        o = dict(sku=sku, name=info.get('name') or r.get('name'), brand=info.get('brand') or '',
                 seller=info.get('seller'), first_date=info.get('first_date') or r.get('sku_first_date'),
                 price=r.get('final_price'), base=info.get('price'), disc=info.get('discount'),
                 sales=sl(r), revenue=rev(r), buyout=r.get('purchase'), buyout_ar=r.get('purchase_after_return'),
                 rank=rankmap.get(sku), kpb_rank=kpb_rank.get(sku), share=round(rev(r) / total_rev * 100, 4) if total_rev else 0,
                 days_in_stock=r.get('days_in_stock'), rating=r.get('rating'), comments=r.get('comments'),
                 warehouses_count=len(wh), lost_profit=r.get('lost_profit'), sales_per_day=r.get('sales_per_day_average'),
                 sizes=sizes_of(info), warehouses_ids=sorted(wh.items(), key=lambda x: -x[1]), image=img_b64(r))
        o['stock'] = sum(s['qty'] for s in o['sizes'])
        if sku in DETAILED:
            ik = api(f'/wb/get/item/{sku}/by_keywords', q={'d1': d1, 'd2': d2}) or {}
            words = ik.get('words', {}) if isinstance(ik, dict) else {}
            kws = [(w, wd.get('avg_pos') or 0, wd.get('avg_organic_pos') or 0, wd.get('total') or 0)
                   for w, wd in words.items() if wd.get('avg_pos')]
            kws.sort(key=lambda k: -k[3])
            o['top_kws'] = [{'q': k[0], 'pos': k[1], 'org': k[2], 'freq': k[3]} for k in kws[:6]]
            o['kw_organic_cnt'] = sum(1 for k in kws if k[2] and k[2] <= 100); o['kw_count'] = len(words)
        targets[str(sku)] = o
        print(f'  target {sku} rank {rankmap.get(sku)} sales {sl(r)}')

    # ---- competitors (comparable segment, exclude our seller) + warehouse footprint ----
    comp_rows = [r for r in COMP_SEG if r['id'] not in TARGETS and (r.get('seller') or '') != a.seller_name][:a.n_competitors]
    competitors = []; central_cov = defaultdict(int); central_qty = defaultdict(int); comp_central_shares = []
    for r in comp_rows:
        info = (api(f"/wb/get/item/{r['id']}") or {}).get('item') or {}
        wh = wh_footprint(info); tot = sum(wh.values()); cent = sum(q for w, q in wh.items() if w in CENTRAL_IDS)
        cnames = sorted({wname(w) for w in wh if w in CENTRAL_IDS})
        for w, q in wh.items():
            if w in CENTRAL_IDS: central_cov[wname(w)] += 1; central_qty[wname(w)] += q
        if tot: comp_central_shares.append(cent / tot * 100)
        competitors.append(dict(id=r['id'], name=r.get('name'), brand=r.get('brand'), seller=r.get('seller'),
            price=r.get('final_price'), sales=sl(r), revenue=rev(r), rating=r.get('rating'), comments=r.get('comments'),
            buyout=r.get('purchase'), share=round(rev(r) / kpb_rev * 100, 3) if kpb_rev else 0,
            rank=rankmap[r['id']], kpb_rank=kpb_rank[r['id']], days=r.get('days_in_site'),
            n_wh=len(wh), central_n=len(cnames), central_names=cnames,
            central_share=round(cent / tot * 100) if tot else 0, image=img_b64(r)))
        print(f"  comp {r['id']} central={len(cnames)} share={round(cent/tot*100) if tot else 0}%")

    # ---- seller warehouse footprint ----
    seller_wh = defaultdict(int)
    for o in targets.values():
        for wid, q in o['warehouses_ids']: seller_wh[int(wid)] += q
    seller_total = sum(seller_wh.values())
    seller_fp = [(wname(w), q, w in CENTRAL_IDS) for w, q in sorted(seller_wh.items(), key=lambda x: -x[1])]
    has_priority = [nm for wid, nm in PRIORITY if wid in seller_wh]
    missing_priority = [nm for wid, nm in PRIORITY if wid not in seller_wh]
    warehouses = {
        'central_priority': [nm for _, nm in PRIORITY],
        'seller': {'footprint': seller_fp, 'n_wh': len(seller_wh), 'total_qty': seller_total,
                   'central_n': sum(1 for w in seller_wh if w in CENTRAL_IDS),
                   'central_share': round(sum(q for w, q in seller_wh.items() if w in CENTRAL_IDS) / seller_total * 100) if seller_total else 0,
                   'has_priority': has_priority, 'missing_priority': missing_priority},
        'competitors': competitors,
        'avg_comp_central_share': round(st.mean(comp_central_shares)) if comp_central_shares else 0,
        'avg_comp_central_n': round(st.mean([c['central_n'] for c in competitors])) if competitors else 0,
        'avg_comp_wh': round(st.mean([c['n_wh'] for c in competitors])) if competitors else 0,
        'central_coverage': dict(sorted(central_cov.items(), key=lambda x: -x[1])),
        'central_qty': dict(sorted(central_qty.items(), key=lambda x: -x[1]))}

    # ---- comparable + niche aggregates ----
    kpb_prices = [r['final_price'] for r in COMP_SEG if (r.get('final_price') or 0) > 0 and sl(r) > 0]
    kpb_top10 = comp_rows[:10]
    ours = [byid[s] for s in TARGETS if s in byid]
    seller_sales = sum(sl(r) for r in ours); seller_rev = sum(rev(r) for r in ours)
    seller_prices = [r.get('final_price') for r in ours if r.get('final_price')]
    comparable = {'n': len(COMP_SEG), 'rev': kpb_rev, 'sales': sum(sl(r) for r in COMP_SEG),
                  'price_median': round(st.median(kpb_prices)) if kpb_prices else None,
                  'price_mean': round(st.mean(kpb_prices)) if kpb_prices else None,
                  'p25': pctile(kpb_prices, 25), 'p75': pctile(kpb_prices, 75),
                  'top10_avg_price': round(st.mean([r.get('final_price') for r in kpb_top10 if r.get('final_price')])) if kpb_top10 else None,
                  'top10_avg_sales': round(st.mean([sl(r) for r in kpb_top10])) if kpb_top10 else None,
                  'top10_avg_comments': round(st.mean([r.get('comments') or 0 for r in kpb_top10])) if kpb_top10 else None}
    prices_all = [r['final_price'] for r in ALL if (r.get('final_price') or 0) > 0 and sl(r) > 0]
    buyout_w = sum((r.get('purchase') or 0) * sl(r) for r in ALL) / max(1, total_sales)
    ref = dt.date.fromisoformat(d2)
    dago = lambda s: ((ref - dt.date(int(str(s)[:4]), int(str(s)[5:7]), int(str(s)[8:10]))).days if s else 9999)
    bd = defaultdict(lambda: [0, 0]); sd = defaultdict(int)
    for r in ALL:
        bd[r.get('brand') or '—'][0] += rev(r); bd[r.get('brand') or '—'][1] += 1; sd[r.get('seller') or '—'] += 1
    brands = sorted(bd.items(), key=lambda kv: -kv[1][0])[:8]
    tsh = lambda k: round(sum(rev(r) for r in ALL[:k]) / max(1, total_rev) * 100, 1)
    bands_def = [('до 1 500', 0, 1500), ('1 500–2 500', 1500, 2500), ('2 500–3 500', 2500, 3500), ('3 500–5 000', 3500, 5000), ('5 000+', 5000, 10 ** 9)]
    niche = {'n_sku': len(ALL), 'n_rev': total_rev, 'n_sales': total_sales,
             'price_median': round(st.median(prices_all)) if prices_all else None, 'buyout': round(buyout_w, 1),
             'with_sales_share': round(len([r for r in ALL if sl(r) > 0]) / len(ALL) * 100, 1),
             'new180_share': round(sum(1 for r in ALL if dago(r.get('sku_first_date')) <= 180) / len(ALL) * 100, 1),
             'fbs_share': round(sum(1 for r in ALL if r.get('is_fbs')) / len(ALL) * 100, 1),
             'top10': tsh(10), 'top50': tsh(50), 'top100': tsh(100), 'n_brands': len(bd), 'n_sellers': len(sd),
             'brands': [(b, round(v[0] / total_rev * 100, 1), v[1]) for b, v in brands],
             'bands': [(l, round(sum(rev(r) for r in ALL if a2 <= (r.get('final_price') or 0) < b2) / max(1, total_rev) * 100, 1)) for l, a2, b2 in bands_def]}

    compare = {'our_avg_price': round(st.mean(seller_prices)) if seller_prices else None,
               'niche_median_price': niche['price_median'], 'kpb_median_price': comparable['price_median'],
               'top10_avg_price': comparable['top10_avg_price'], 'top10_avg_sales': comparable['top10_avg_sales'],
               'top10_avg_comments': comparable['top10_avg_comments'],
               'our_total_sales': seller_sales, 'our_total_rev': seller_rev,
               'our_avg_sales': round(seller_sales / len(ours)) if ours else 0,
               'our_avg_comments': round(st.mean([byid[s].get('comments') or 0 for s in TARGETS if s in byid])) if ours else 0,
               'our_share': round(seller_rev / total_rev * 100, 3) if total_rev else 0,
               'our_share_kpb': round(seller_rev / kpb_rev * 100, 3) if kpb_rev else 0,
               'our_best_rank': min([targets[str(s)]['rank'] for s in TARGETS if targets[str(s)]['rank']] or [0]),
               'our_best_kpb_rank': min([targets[str(s)]['kpb_rank'] for s in TARGETS if targets[str(s)]['kpb_rank']] or [0])}

    # ---- potential (scenario model) + stock distribution plan ----
    price = compare['our_avg_price'] or 0
    base_units = seller_sales
    REAL_MULT, AMB_MULT = 2.5, 4.0   # допущения: выход на центр. склады (+доставка/ранг) + отзывы/консолидация
    scenarios = [
        {'name': 'Сейчас', 'mult': 1, 'units': base_units, 'revenue': base_units * price},
        {'name': 'Реалистичный (выход на центр. склады + отзывы)', 'mult': REAL_MULT,
         'units': round(base_units * REAL_MULT), 'revenue': round(base_units * REAL_MULT * price)},
        {'name': 'Амбициозный (уровень сильного игрока сегмента)', 'mult': AMB_MULT,
         'units': round(base_units * AMB_MULT), 'revenue': round(base_units * AMB_MULT * price)}]
    # веса распределения — по фактическому стоку конкурентов на центральных хабах
    cq = warehouses['central_qty']; cq_tot = sum(cq.values()) or 1
    target_units = scenarios[1]['units']          # план под реалистичный сценарий (мес.)
    dist_plan = [{'hub': h, 'weight': round(q / cq_tot * 100), 'units': round(q / cq_tot * target_units)}
                 for h, q in list(cq.items())[:8]]
    potential = {'base_units': base_units, 'price': price, 'scenarios': scenarios,
                 'assumptions': f'допущения: выход на центральные хабы, набор отзывов, консолидация карточек; цена {price} ₽; при прочих равных',
                 'target_units': target_units, 'dist_plan': dist_plan}

    # ---- auto roadmap ----
    roadmap = []
    if missing_priority:
        roadmap.append(['P1', 'сейчас', 'Распределить поставки на центральные склады',
            f"Корневая причина низких продаж — товар только на регион-складах. Срочно завести FBW-поставки на {', '.join(missing_priority[:4])} — оттуда идёт основная масса заказов. См. план распределения стока."])
    if compare['our_avg_comments'] < comparable['top10_avg_comments'] / 3:
        roadmap.append(['P1', 'сейчас', 'Набрать отзывы на ключевые карточки',
            f"У вас в среднем {compare['our_avg_comments']} отзывов против ≈{comparable['top10_avg_comments']} у ТОП-10 — низкая доказанность бьёт по конверсии. Сбор отзывов на 3–4 лучшие карточки в рамках правил WB."])
    if len(TARGETS) > 4:
        roadmap.append(['P1', 'сейчас', f'Консолидировать {len(TARGETS)} карточек в 2–4 сильные',
            'Почти одинаковые SKU дробят трафик, отзывы и рекламу. Свести дубли в карточки с вариациями размеров/цветов, склеив отзывы и историю.'])
    if not any(o.get('brand') for o in targets.values()):
        roadmap.append(['P2', '2–4 недели', 'Оформить бренд и брендовую линейку',
            'Поле бренда пустое — теряете брендовый трафик и узнаваемость. Указать бренд, единый стиль карточек, витрину.'])
    roadmap.append(['P2', '2–4 недели', 'SEO-заголовки, характеристики и контент',
        'Расширить заголовок/характеристики ключами ниши, добавить инфографику, lifestyle-фото, видео, таблицу размеров — поднять органику и конверсию.'])
    roadmap.append(['P3', '1–2 месяца', 'Реклама и участие в акциях',
        'Автокампании/АРК на топ-запросы и участие в акциях — после набора отзывов и контента.'])

    data = {'meta': {'d1': d1, 'd2': d2, 'days': a.days, 'niche_path': a.category, 'niche_name': a.niche_name,
                     'seller': a.seller_name, 'seller_id': a.seller_id, 'generated': d2,
                     'market_total': total_rev, 'top100_sum': top100, 'n_sku': len(ALL)},
            'target_order': [str(s) for s in TARGETS], 'detailed': [str(s) for s in DETAILED],
            'targets': targets, 'competitors': competitors, 'niche': niche, 'comparable': comparable,
            'warehouses': warehouses, 'compare': compare, 'potential': potential, 'roadmap': roadmap,
            'seller_agg': {'n': len(ours), 'sales': seller_sales, 'revenue': seller_rev,
                           'share': compare['our_share'], 'avg_price': compare['our_avg_price'],
                           'best_rank': compare['our_best_rank']}}
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    json.dump(data, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'✓ {a.out} · рынок {total_rev:,} ₽ · продавец {seller_sales} продаж · центр. хабов {warehouses["seller"]["central_n"]}')

if __name__ == '__main__':
    main()
