#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — собирает единый многостраничный PDF-отчёт из data.json:
    страница 1 — титульная сводка,
    страница N — карточка каждого артикула,
    последняя  — анализ ниши.

Использование:
    python3 build.py [data.json] [--html out.html] [--pdf out.pdf]

data.json готовит collect.py. Рендер в PDF — системным Chromium
(--print-to-pdf), путь берётся из $CHROME или автопоиском.
Все страницы в одном HTML-документе; акцентные цвета разведены через
CSS-переменные (--accent/--accent2/--tint/--soft), заданные на каждой .page.
"""
import json, sys, os, subprocess, glob

# ---------- helpers ----------
def nf(x, d=0):
    if x is None: return '—'
    return f"{x:,.{d}f}".replace(',', ' ')
def money_short(x):
    if x >= 1e9: return f"{x/1e9:.2f} млрд"
    if x >= 1e6: return f"{nf(round(x/1e6))} млн"
    return nf(round(x))
def vars_style(pal):
    return f"--accent:{pal[0]};--accent2:{pal[1]};--tint:{pal[2]};--soft:{pal[3]}"

# ---- WB deep links (кликабельные ссылки в PDF) ----
import urllib.parse as _up
def wb_item(sku): return f"https://www.wildberries.ru/catalog/{sku}/detail.aspx"
def wb_brand(b):  return "https://www.wildberries.ru/catalog/0/search.aspx?search=" + _up.quote(str(b))
def a_item(sku, text=None, cls='lnk'):  return f'<a class="{cls}" href="{wb_item(sku)}">{sku if text is None else text}</a>'
def a_brand(b, text=None, cls='lnk'):   return f'<a class="{cls}" href="{wb_brand(b)}">{b if text is None else text}</a>'

WH_NAMES = {'507':'Коледино','117986':'Казань','120762':'Электросталь','130744':'Тула',
            '206348':'СПб · Уткина Заводь','208277':'Невинномысск','300571':'Обухово'}
def wh_label(wid): return WH_NAMES.get(str(wid), f'СЦ · {wid}')

# ---------- shared CSS (var-driven accents) ----------
CSS = r"""
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'Liberation Sans','DejaVu Sans',Arial,sans-serif; color:#1c2230;
  -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.page { width:210mm; height:297mm; padding:10mm 13mm 9mm; position:relative; overflow:hidden; background:#fff; }
.page:not(:last-child) { break-after:page; page-break-after:always; }
.accbar { position:absolute; top:0; left:0; right:0; height:7px; background:var(--accent); }
.eyebrow { font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:var(--accent2); font-weight:700; }
h1 { font-size:20px; line-height:1.12; margin:2px 0 4px; color:#141a26; }
.chips { display:flex; gap:7px; flex-wrap:wrap; }
.chip { font-size:9.5px; padding:3px 9px; border-radius:20px; background:var(--tint); color:var(--accent2);
  font-weight:700; border:1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
.kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:11px; }
.kpi { border:1px solid #e6e9f0; border-radius:10px; padding:9px 12px; background:#fff; border-top:4px solid var(--accent); min-height:60px; }
.kpi.hero { background:var(--soft); border-color:var(--accent); }
.kpi .lbl { font-size:9px; letter-spacing:.05em; text-transform:uppercase; color:#8a93a6; font-weight:700; }
.kpi .val { font-size:18px; font-weight:800; color:#141a26; margin-top:4px; line-height:1; }
.kpi .val small { font-size:11px; font-weight:700; color:#6b7488; }
.kpi .sub { font-size:9.3px; color:#8a93a6; margin-top:4px; line-height:1.35; }
.card { border:1px solid #e6e9f0; border-radius:10px; padding:11px 13px; }
.card h3 { font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent2); margin-bottom:8px;
  display:flex; justify-content:space-between; align-items:baseline; }
.card h3 span { color:#9aa2b3; font-weight:600; letter-spacing:0; text-transform:none; font-size:9.2px; }
.assess { border-left:5px solid var(--accent); background:var(--soft); border-radius:0 10px 10px 0; padding:11px 14px; }
.assess h3 { font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent2); margin-bottom:6px; }
.assess p { font-size:9.6px; line-height:1.5; color:#33405a; }
.assess p + p { margin-top:5px; }
.foot { position:absolute; bottom:7mm; left:13mm; right:13mm; display:flex; justify-content:space-between; gap:16px;
  font-size:8px; color:#aab0be; border-top:1px solid #eceef3; padding-top:6px; }
/* ---- card report ---- */
.hd { display:flex; gap:14px; align-items:flex-start; }
.hd .ph { width:74px; height:99px; border-radius:9px; object-fit:cover; flex:0 0 auto;
  border:2px solid var(--accent); box-shadow:0 4px 10px rgba(0,0,0,.15); }
.hd .main { flex:1; min-width:0; }
.artno { font-size:12.5px; color:#5a6478; font-weight:700; }
.artno b { color:var(--accent2); }
.role { margin-top:6px; font-size:10.5px; color:#5a6478; }
.role b { color:var(--accent2); }
.mid { display:grid; grid-template-columns:1.08fr 1fr; gap:12px; margin-top:11px; }
.srow { display:flex; align-items:center; gap:9px; margin:3.5px 0; }
.sname { width:38px; font-weight:800; font-size:11px; flex:0 0 auto; }
.sname i { display:block; font-style:normal; font-weight:600; font-size:8.4px; color:#9aa2b3; }
.btrack { flex:1; height:11px; background:#eef0f4; border-radius:7px; overflow:hidden; }
.btrack.zero { background:#fdecec; }
.bar { height:100%; border-radius:7px; }
.qty { width:30px; text-align:right; font-weight:800; font-size:11px; flex:0 0 auto; }
.qty.zeroq { color:#e5484d; }
.wrow { display:flex; align-items:center; gap:9px; margin:4px 0; }
.wname { width:108px; font-size:9.6px; font-weight:600; color:#3a445a; flex:0 0 auto; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.wtrack { flex:1; height:10px; background:#eef0f4; border-radius:6px; overflow:hidden; }
.wbar { height:100%; border-radius:6px; }
.wqty { width:28px; text-align:right; font-weight:800; font-size:10px; flex:0 0 auto; }
.whmore { font-size:9px; color:#9aa2b3; margin-top:8px; }
.mkt { margin-top:11px; }
.mkwrap { padding-top:17px; }
.mktbar { position:relative; height:22px; border-radius:8px; background:#eef0f4; }
.mktbar .top100 { position:absolute; top:0; bottom:0; left:0; width:0.91%; background:var(--accent); border-radius:8px 0 0 8px; }
.mkmark { position:absolute; top:-5px; bottom:-5px; width:3px; background:#141a26; border-radius:2px; z-index:2; }
.mklabel { position:absolute; top:-19px; font-size:10px; font-weight:800; color:#141a26; white-space:nowrap; }
.mklabels { display:flex; justify-content:space-between; font-size:9px; color:#9aa2b3; margin-top:7px; }
.mkstat { display:flex; gap:22px; margin-top:9px; padding-top:9px; border-top:1px solid #eef0f4; }
.mkstat div b { font-size:16px; color:var(--accent2); }
.mkstat div span { font-size:9.2px; color:#8a93a6; display:block; margin-top:2px; }
table.kw { width:100%; border-collapse:collapse; margin-top:4px; }
table.kw th { font-size:9px; text-transform:uppercase; letter-spacing:.05em; color:#9aa2b3; text-align:left; padding:5px 7px; border-bottom:1px solid #e6e9f0; }
table.kw td { font-size:10px; padding:6px 7px; border-bottom:1px solid #f0f2f6; }
table.kw td.q { font-weight:600; }
table.kw td.pos, table.kw td.fr { font-weight:800; text-align:right; white-space:nowrap; }
table.kw tr.bad td.q, table.kw tr.bad td.pos { color:#b23; }
.kbadge { font-size:9px; padding:3px 9px; border-radius:12px; font-weight:800; }
.kbadge.ad { background:var(--tint); color:var(--accent2); }
.kbadge.none { background:#fdecec; color:#e5484d; }
.bot { display:grid; grid-template-columns:1.9fr 1fr; gap:12px; margin-top:11px; }
.sigbox { border:1px solid #e6e9f0; border-radius:10px; padding:12px 13px; }
.sigbox h3 { font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent2); margin-bottom:9px; }
.sig { display:flex; gap:8px; align-items:flex-start; font-size:9.6px; line-height:1.3; margin:7px 0; color:#33405a; }
.sig .ico { font-size:9px; font-weight:900; flex:0 0 auto; margin-top:1px; }
.sig.ok .ico { color:#12946a; }
.sig.risk .ico { color:#e5484d; }
/* ---- niche report ---- */
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:10px; }
.hb { display:flex; align-items:center; gap:9px; margin:4px 0; }
.hbl { width:96px; font-size:9.4px; font-weight:600; color:#3a445a; flex:0 0 auto; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.hbt { flex:1; height:11px; background:#eef0f4; border-radius:6px; overflow:hidden; }
.hbf { height:100%; border-radius:6px; }
.hbv { width:78px; text-align:right; font-size:9.2px; font-weight:800; color:#3a445a; flex:0 0 auto; }
.concstat { display:flex; gap:16px; margin-bottom:10px; }
.concstat div b { font-size:17px; color:var(--accent2); }
.concstat div span { font-size:8.8px; color:#8a93a6; display:block; margin-top:1px; }
.callout { background:var(--soft); border-radius:8px; padding:9px 11px; font-size:9.6px; color:#33405a; line-height:1.4; }
.callout b { color:var(--accent2); }
table.lt { width:100%; border-collapse:collapse; }
table.lt th { font-size:8.4px; text-transform:uppercase; letter-spacing:.04em; color:#9aa2b3; text-align:right; padding:4px 5px; border-bottom:1px solid #e6e9f0; }
table.lt th:first-child { text-align:left; }
table.lt td { font-size:8.8px; padding:2.5px 5px; border-bottom:1px solid #f2f3f7; }
table.lt td.q { font-weight:700; color:#1c2230; }
table.lt td.q i { display:block; font-style:normal; font-weight:600; font-size:8px; color:#9aa2b3; }
table.lt td.num { text-align:right; font-weight:700; white-space:nowrap; }
.ours { display:flex; gap:10px; }
.ocard { flex:1; border:1px solid #e6e9f0; border-left:4px solid #999; border-radius:8px; padding:9px 11px; }
.osku { font-size:9px; font-weight:700; color:#5a6478; }
.orank { font-size:17px; font-weight:800; margin-top:3px; color:#141a26; }
.orank span { font-size:10px; font-weight:700; color:#9aa2b3; }
.osub { font-size:8.8px; color:#8a93a6; margin-top:3px; }
/* ---- cover ---- */
.cover h1 { font-size:30px; line-height:1.1; margin:8px 0 6px; }
.cover .lead { font-size:12px; color:#5a6478; max-width:150mm; line-height:1.5; }
.cvcards { display:grid; grid-template-columns:1fr 1fr 1fr; gap:11px; margin-top:20px; }
.cvcard { border:1px solid #e6e9f0; border-radius:12px; padding:14px; border-top:5px solid var(--c); }
.cvcard .tag { font-size:9px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--c); }
.cvcard .nm { font-size:13px; font-weight:800; margin-top:5px; color:#141a26; line-height:1.2; }
.cvcard .big { font-size:22px; font-weight:800; margin-top:9px; color:#141a26; }
.cvcard .big small { font-size:11px; color:#6b7488; font-weight:700; }
.cvcard ul { list-style:none; margin-top:9px; }
.cvcard li { font-size:9.6px; color:#4a556b; line-height:1.5; padding-left:13px; position:relative; }
.cvcard li::before { content:'▪'; position:absolute; left:0; color:var(--c); }
.tak { margin-top:20px; border-radius:12px; background:var(--soft); padding:15px 17px; }
.tak h3 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent2); margin-bottom:9px; }
.tak li { font-size:10.5px; color:#33405a; line-height:1.6; padding-left:16px; position:relative; list-style:none; }
.tak li::before { content:'→'; position:absolute; left:0; color:var(--accent2); font-weight:800; }
.toc { margin-top:18px; display:flex; gap:9px; }
.toc a { flex:1; border:1px solid #e6e9f0; border-radius:9px; padding:9px 11px; font-size:9.5px; color:#5a6478; display:block; }
.toc a b { display:block; font-size:11px; color:#141a26; margin-bottom:2px; }
.toc .pg { float:right; font-weight:800; color:var(--accent2); }
.cvhead { display:flex; gap:10px; align-items:flex-start; }
.cvph { width:44px; height:59px; border-radius:7px; object-fit:cover; border:1.5px solid var(--c); flex:0 0 auto; }
.cvmeta { min-width:0; }
.cvart { font-size:10px; color:#5a6478; font-weight:700; margin-top:3px; }
/* links */
a { color:inherit; text-decoration:none; }
.lnk { color:var(--accent2); text-decoration:none; border-bottom:1px dotted color-mix(in srgb, var(--accent2) 50%, transparent); }
.lnk.b { font-weight:800; }
/* niche leader thumbnails */
.ltprod { display:flex; gap:7px; align-items:center; }
.ltprod > div { min-width:0; line-height:1.15; }
.ltph { width:23px; height:30px; border-radius:4px; object-fit:cover; border:1px solid #e6e9f0; flex:0 0 auto; }
.ocph { width:30px; height:40px; border-radius:6px; object-fit:cover; border:1px solid #e6e9f0; flex:0 0 auto; }
.ohead { display:flex; gap:9px; align-items:flex-start; }
"""

# ---------- fragment builders ----------
def size_bars(sizes):
    mx = max([s['qty'] for s in sizes] + [1])
    out = ''
    for s in sizes:
        q = s['qty']
        if q == 0:
            bar = '<div class="btrack zero"></div>'; val = '<span class="qty zeroq">0</span>'
        else:
            w = max(4, q/mx*100)
            bar = f'<div class="btrack"><div class="bar" style="width:{w:.0f}%;background:var(--accent)"></div></div>'
            val = f'<span class="qty">{q}</span>'
        out += f'<div class="srow"><span class="sname">{s["name"]}<i>{s["origin"]}</i></span>{bar}{val}</div>'
    return out

def wh_bars(whlist):
    top = whlist[:6]; mx = max([q for _, q in top] + [1])
    out = ''
    for wid, q in top:
        w = max(4, q/mx*100)
        out += (f'<div class="wrow"><span class="wname">{wh_label(wid)}</span>'
                f'<div class="wtrack"><div class="wbar" style="width:{w:.0f}%;background:var(--accent)"></div></div>'
                f'<span class="wqty">{q}</span></div>')
    return out

def kw_rows(kw):
    out = ''
    for q in ['рубашка мужская с длинным рукавом', 'рубашка мужская однотонная']:
        d = kw.get(q)
        if d:
            posv = f'~{d.get("avg_pos")}' if d.get('avg_pos') else '—'
            out += (f'<tr><td class="q">{q}</td><td class="pos">{posv}</td>'
                    f'<td><span class="kbadge ad">реклама</span></td><td class="fr">{nf(d.get("total"))}</td></tr>')
        else:
            out += (f'<tr class="bad"><td class="q">{q}</td><td class="pos">не ранж.</td>'
                    f'<td><span class="kbadge none">нет</span></td><td class="fr">—</td></tr>')
    return out

def card_fragment(sku, o, meta, market_total, top100_sum, n_sku, anchor=''):
    pal = o['palette']; c = o['cat_row']
    orders = c['sales']; rev = c['revenue']
    avg_price = round(rev/orders) if orders else o['final_price']
    est = round(orders*c['purchase']/100)
    share = o['market']['share_pct']; rank = o['market']['rank']
    mkpos = min(99.0, max(0.4, rank/n_sku*100))
    mktf = 'translateX(0)' if mkpos < 10 else ('translateX(-100%)' if mkpos > 90 else 'translateX(-50%)')
    vs = rev/(top100_sum/100); vs_top100 = f"×{vs:.1f}" if vs >= 1 else f"{vs*100:.0f}%"
    lost = '0 ₽' if c['lost_profit'] in (0, None) else f"{nf(c['lost_profit'])} ₽"
    zeros = [s['name'] for s in o['sizes'] if s['qty'] == 0]; low = [s['name'] for s in o['sizes'] if 0 < s['qty'] <= 3]
    lost_sub = ('дефицит размеров: ' + ', '.join(zeros+low)) if (zeros or low) else 'карточка не уходила в ноль'
    wh_more = f"+ ещё {o['warehouses_count']-6} складов с меньшими остатками" if o['warehouses_count'] > 6 else ''
    sigs = ''.join(f'<div class="sig {st}"><span class="ico">{"▲" if st=="ok" else "▼"}</span>{t}</div>' for t, st in o['signals'])
    return f"""<div class="page card-report" id="{anchor}" style="{vars_style(pal)}">
<div class="accbar"></div>
<div class="hd"><a href="{wb_item(sku)}"><img class="ph" src="{o.get('image','')}"/></a>
  <div class="main"><div class="eyebrow">Анализ карточки конкурента · Wildberries</div>
    <h1><a class="lnk" href="{wb_item(sku)}">{o['name']}</a></h1>
    <div class="artno">Артикул {a_item(sku, cls='lnk b')} · {a_brand(o['brand'], f"<b>{o['brand']}</b>")}</div>
    <div class="chips" style="margin-top:6px">
      <span class="chip">{o['seller']}</span><span class="chip">★ {o['rating']} · {o['comments']} отзывов</span>
      <span class="chip">На ВБ с {o['first_date']}</span><span class="chip">{c['days_in_site']} дн. на площадке</span></div>
    <div class="role"><b>Роль:</b> {o['role']}</div></div></div>
<div class="kpis">
  <div class="kpi hero"><div class="lbl">Заказы за 30 дней</div><div class="val">{nf(rev)} <small>₽</small></div><div class="sub">{nf(orders)} заказов · {c['sales_per_day_average']:.1f} шт/день</div></div>
  <div class="kpi"><div class="lbl">Средняя цена</div><div class="val">{nf(avg_price)} <small>₽</small></div><div class="sub">текущая {nf(o['final_price'])} ₽ · скидка −{o['discount']}%</div></div>
  <div class="kpi"><div class="lbl">Процент выкупа</div><div class="val">{c['purchase']}%</div><div class="sub">после возвратов {c['purchase_after_return']}% · ≈{nf(est)} шт</div></div>
  <div class="kpi hero"><div class="lbl">Доля рынка · ранг</div><div class="val">{share}%</div><div class="sub">место {nf(rank)} из {nf(n_sku)} SKU</div></div>
  <div class="kpi"><div class="lbl">Остатки · склады</div><div class="val">{nf(o['stock_total'])} <small>шт</small></div><div class="sub">{o['warehouses_count']} складов · в наличии {c['days_in_stock']}/30 дней</div></div>
  <div class="kpi"><div class="lbl">Упущенная выручка</div><div class="val">{lost}</div><div class="sub">{lost_sub}</div></div></div>
<div class="mid">
  <div class="card"><h3>Остатки по размерам <span>всего {nf(o['stock_total'])} шт</span></h3>{size_bars(o['sizes'])}</div>
  <div class="card"><h3>Склады присутствия <span>{o['warehouses_count']} складов</span></h3>{wh_bars(o['warehouses_ids'])}<div class="whmore">{wh_more}</div></div></div>
<div class="card mkt"><h3>Позиция на рынке мужских рубашек <span>{nf(n_sku)} SKU · рынок {money_short(market_total)} ₽ / 30 дн</span></h3>
  <div class="mkwrap"><div class="mktbar"><div class="top100"></div><div class="mkmark" style="left:{mkpos:.2f}%"></div>
    <div class="mklabel" style="left:{mkpos:.2f}%;transform:{mktf}">ранг {nf(rank)}</div></div></div>
  <div class="mklabels"><span>◄ ТОП-100 (17% рынка)</span><span>лидеры ← · → аутсайдеры</span><span>{nf(n_sku)}</span></div>
  <div class="mkstat"><div><b>{share}%</b><span>доля в выручке категории</span></div><div><b>#{nf(rank)}</b><span>место по выручке</span></div><div><b>{vs_top100}</b><span>к средней выручке SKU из ТОП-100</span></div></div></div>
<div class="card" style="margin-top:11px"><h3>Видимость по запросам <span>позиция · тип трафика · частотность/мес</span></h3>
  <table class="kw"><tr><th>Поисковый запрос</th><th style="text-align:right">Позиция</th><th>Трафик</th><th style="text-align:right">Частотность</th></tr>{kw_rows(o['kw'])}</table></div>
<div class="bot"><div class="assess"><h3>Оценка состояния артикула</h3><p>{o['assessment']}</p></div>
  <div class="sigbox"><h3>Ключевые сигналы</h3>{sigs}</div></div>
<div class="foot"><span>Источник: MPStats API · период {meta['d1']}–{meta['d2']} ({meta['days']} дней)</span>
  <span>Доля рынка — по выручке категории «{meta['category']}». Позиция по запросу — из SEO-модуля позиций.</span></div>
</div>"""

def hbars(items):
    mx = max([v for _, v, _ in items] + [1])
    return ''.join(f'<div class="hb"><span class="hbl">{l}</span><div class="hbt"><div class="hbf" style="width:{max(3,v/mx*100):.0f}%;background:var(--accent)"></div></div><span class="hbv">{rt}</span></div>' for l, v, rt in items)

def niche_fragment(D, meta, articles=None, anchor=''):
    articles = articles or {}
    pal = D['palette']
    price_bars = hbars([(l, s, f'{s}%') for (l, _, s, _) in D['bands']])
    brand_bars = hbars([(a_brand(b, (b if len(b) <= 18 else b[:17]+'…')), s, f'<b>{s}%</b> · {cnt} SKU') for (b, _, s, cnt) in D['brands'][:6]])
    lead = ''
    for r in D['leaders'][:5]:
        nm = r['name']; nm = nm if len(nm) <= 30 else nm[:29]+'…'
        iid = r.get('id')
        ph = f"<a href='{wb_item(iid)}'><img class='ltph' src='{r.get('image','')}'/></a>" if iid else ''
        nm_h = a_item(iid, nm) if iid else nm
        br_h = a_brand(r['brand']) if r.get('brand') else ''
        lead += (f"<tr><td class='q'><div class='ltprod'>{ph}<div>{nm_h}<i>{br_h}</i></div></div></td>"
                 f"<td class='num'>{nf(r['rev'])}</td><td class='num'><b>{r['share']}%</b></td>"
                 f"<td class='num'>{nf(r['price'])}</td><td class='num'>{r['buyout']}%</td></tr>")
    ocards = ''
    meta_o = {'447156582': ('#0E9488', 'Классическая'), '428365795': ('#C7891B', 'Приталенная (флагман)')}
    for sku, (col, lab) in meta_o.items():
        o = D['ours'].get(sku) or D['ours'].get(int(sku))
        if isinstance(o, dict):
            img = (articles.get(sku) or {}).get('image', '')
            ph = f"<a href='{wb_item(sku)}'><img class='ocph' src='{img}'/></a>" if img else ''
            ocards += (f"<div class='ocard' style='border-left-color:{col}'><div class='ohead'>{ph}<div>"
                       f"<div class='osku'>{lab} · {a_item(sku, cls='lnk b')}</div>"
                       f"<div class='orank'>ранг <b>{o['rank']}</b><span>/ {nf(D['n_n'])}</span></div>"
                       f"<div class='osub'>доля <b>{o['share']}%</b> · {nf(o['revenue'])} ₽ · {o['sales']} заказов</div></div></div></div>")
    ap = ''.join(f'<p>{p}</p>' for p in D['assessment'])
    return f"""<div class="page niche-report" id="{anchor}" style="{vars_style(pal)}">
<div class="accbar"></div>
<div class="eyebrow">Аналитика ниши · Wildberries</div>
<h1 style="font-size:22px;margin:4px 0 7px">Ниша: «<span style="color:var(--accent)">{D['query']}</span>»</h1>
<div class="chips"><span class="chip">Период {meta['d1']}–{meta['d2']} · {meta['days']} дней</span>
  <span class="chip">Сегмент категории «{meta['category']}»</span><span class="chip">Классические однотонные, длинный рукав</span></div>
<div class="kpis">
  <div class="kpi hero"><div class="lbl">Объём ниши · выручка</div><div class="val">{money_short(D['n_rev'])} <small>₽</small></div><div class="sub">{nf(D['n_n'])} SKU · {D['niche_rev_share']}% рынка рубашек · {nf(D['n_sales'])} продаж</div></div>
  <div class="kpi"><div class="lbl">Медианная цена</div><div class="val">{nf(D['price_median'])} <small>₽</small></div><div class="sub">коридор {nf(D['price_p25'])}–{nf(D['price_p75'])} ₽ · средняя {nf(D['price_mean'])}</div></div>
  <div class="kpi"><div class="lbl">Средний выкуп</div><div class="val">{D['buyout']}%</div><div class="sub">типично для одежды · зона роста</div></div>
  <div class="kpi hero"><div class="lbl">Концентрация · ТОП-100</div><div class="val">{D['top100']}%</div><div class="sub">выручки у ТОП-100 · рынок раздроблен</div></div>
  <div class="kpi"><div class="lbl">Активные карточки</div><div class="val">{D['with_sales_share']}%</div><div class="sub">{nf(D['with_sales'])} с продажами · «мёртвых» {D['dead_share']}%</div></div>
  <div class="kpi"><div class="lbl">Приток новинок</div><div class="val">{D['new180_share']}%</div><div class="sub">новых за 180 дн · за 90 дн {D['new90_share']}% · FBS {D['fbs_share']}%</div></div></div>
<div class="grid2">
  <div class="card"><h3>Ценовая структура <span>доля выручки по цене</span></h3>{price_bars}
    <div class="callout" style="margin-top:9px">Ядро спроса — <b>1 500–2 500 ₽</b> (≈52% выручки). Ниже 1 500 ₽ — ещё 20%. Премиум 4 000+ ₽ почти пуст (3%).</div></div>
  <div class="card"><h3>Концентрация и конкуренция <span>{nf(D['n_brands'])} брендов · {nf(D['n_sellers'])} продавцов</span></h3>
    <div class="concstat"><div><b>{D['top10']}%</b><span>ТОП-10 выручки</span></div><div><b>{D['top50']}%</b><span>ТОП-50 выручки</span></div><div><b>{D['top100']}%</b><span>ТОП-100 выручки</span></div></div>
    <div class="callout"><b>80% выручки</b> дают <b>{nf(D['n80'])} карточек ({D['n80_share']}%)</b> — «длинный хвост». Ни один лидер не держит и 1% ниши: рынок <b>раздроблен и конкурентен</b>, вход открыт, но и лидеры не защищены.</div></div></div>
<div class="grid2">
  <div class="card"><h3>Лидеры по брендам <span>доля выручки · число SKU</span></h3>{brand_bars}</div>
  <div class="card"><h3>ТОП-карточки ниши <span>выручка · доля · цена · выкуп</span></h3>
    <table class="lt"><tr><th>Товар / бренд</th><th>Выручка ₽</th><th>Доля</th><th>Цена</th><th>Выкуп</th></tr>{lead}</table></div></div>
<div class="card" style="margin-top:8px;padding:9px 13px"><h3>Наши анализируемые артикулы в этой нише <span>место среди {nf(D['n_n'])} SKU</span></h3><div class="ours">{ocards}</div></div>
<div class="assess" style="margin-top:8px"><h3>Оценка ниши</h3>{ap}</div>
<div class="foot"><span>Источник: MPStats API · сегмент категории «{meta['category']}» · период {meta['d1']}–{meta['d2']} ({meta['days']} дней)</span>
  <span>Ниша выделена фильтром по однотонности и длинному рукаву (исключены принты, короткий рукав, оверсайз/пляжные).</span></div>
</div>"""

def cover_fragment(data):
    meta = data['meta']; arts = data['articles']; D = data['niche']
    pal = ['#2B3350', '#1C2238', '#EEF0F6', '#F6F7FB']
    cv = ''
    for sku in data['order']:
        o = arts[sku]; c = o['cat_row']; col = o['palette'][0]
        ph = f"<a href='{wb_item(sku)}'><img class='cvph' src='{o.get('image','')}'/></a>"
        cv += (f"<div class='cvcard' style='--c:{col}'>"
               f"<div class='cvhead'>{ph}<div class='cvmeta'><div class='tag'>Артикул · карточка</div>"
               f"<div class='nm'><a class='lnk' href='{wb_item(sku)}'>{o['name']}</a></div>"
               f"<div class='cvart'>Арт. {a_item(sku, cls='lnk b')}</div></div></div>"
               f"<div class='big'>{money_short(c['revenue'])} <small>₽/30д</small></div>"
               f"<ul><li>{a_brand(o['brand'])} · ранг <b>{nf(o['market']['rank'])}</b> из {nf(meta['n_sku'])}</li>"
               f"<li>доля рынка <b>{o['market']['share_pct']}%</b> · выкуп <b>{c['purchase']}%</b></li>"
               f"<li>{o['role']}</li></ul></div>")
    col = D['palette'][0]
    cv += (f"<div class='cvcard' style='--c:{col}'>"
           f"<div class='cvhead'><div class='cvmeta'><div class='tag'>Ниша · рынок</div>"
           f"<div class='nm'>{D['query']}</div></div></div>"
           f"<div class='big'>{money_short(D['n_rev'])} <small>₽/30д</small></div>"
           f"<ul><li><b>{nf(D['n_n'])} SKU</b> · {D['niche_rev_share']}% рынка рубашек</li>"
           f"<li>медиана <b>{nf(D['price_median'])} ₽</b> · выкуп <b>{D['buyout']}%</b></li>"
           f"<li>раздроблен: ТОП-100 = <b>{D['top100']}%</b> выручки</li></ul></div>")
    return f"""<div class="page cover" style="{vars_style(pal)}">
<div class="accbar" style="background:linear-gradient(90deg,{arts[data['order'][0]]['palette'][0]},{arts[data['order'][1]]['palette'][0]},{D['palette'][0]})"></div>
<div class="eyebrow">Аналитический отчёт · MPStats × Wildberries</div>
<h1>Анализ конкурентов и ниши<br>мужских рубашек на Wildberries</h1>
<div class="lead">Сводный отчёт по двум карточкам конкурента и нише «{D['query']}». Данные MPStats API за период {meta['d1']} – {meta['d2']} ({meta['days']} дней). Дата формирования: {meta['generated']}.</div>
<div class="cvcards">{cv}</div>
<div class="tak"><h3>Ключевые выводы</h3><ul>
  <li>Оба артикула — одного продавца (ООО Вандер Текстайл, бренд {a_brand('Marco Santoni')}): приталенная модель — флагман, классическая — второстепенная.</li>
  <li>Флагман {a_item(data['order'][1], cls='lnk b')} входит в <b>ТОП-100</b> категории (ранг {nf(arts[data['order'][1]]['market']['rank'])}) и ТОП-25 профильной ниши, но вымыл ядро размеров S/M/L — риск упущенных продаж.</li>
  <li>Классическая {a_item(data['order'][0], cls='lnk b')} — среднего хвоста (ранг {nf(arts[data['order'][0]]['market']['rank'])}): стабильна, но слабая поисковая видимость и затоварка.</li>
  <li>Ниша крупная (<b>{money_short(D['n_rev'])} ₽/мес</b>) и раздробленная: вход открыт, но без рекламы и SEO карточка тонет; ценовое ядро <b>1 500–2 500 ₽</b>.</li>
  <li>Общая слабость обеих карточек — <b>нет органики в поиске</b>: показы идут только через рекламу.</li>
</ul></div>
<div class="toc">
  <a href="#p2"><span class="pg">стр. 2</span><b>Артикул {data['order'][0]}</b>Классическая рубашка · карточка конкурента</a>
  <a href="#p3"><span class="pg">стр. 3</span><b>Артикул {data['order'][1]}</b>Приталенная рубашка · карточка конкурента</a>
  <a href="#p4"><span class="pg">стр. 4</span><b>Анализ ниши</b>Рубашка мужская однотонная, длинный рукав</a>
</div>
<div class="foot"><span>Источник данных: MPStats API</span><span>Конфиденциально · подготовлено для внутреннего анализа</span></div>
</div>"""

# ---------- assembly / render ----------
def build_html(data):
    pages = [cover_fragment(data)]
    for i, sku in enumerate(data['order']):
        pages.append(card_fragment(sku, data['articles'][sku], data['meta'],
                                   data['meta']['market_total_revenue'], data['meta']['top100_sum'],
                                   data['meta']['n_sku'], anchor=f'p{i+2}'))
    pages.append(niche_fragment(data['niche'], data['meta'], data['articles'], anchor=f'p{len(data["order"])+2}'))
    return ("<!doctype html><html><head><meta charset='utf-8'><style>@page{size:A4;margin:0}"
            + CSS + "</style></head><body>" + "\n".join(pages) + "</body></html>")

def find_chrome():
    if os.environ.get('CHROME') and os.path.exists(os.environ['CHROME']):
        return os.environ['CHROME']
    for pat in ['/opt/pw-browsers/chromium-*/chrome-linux/chrome',
                '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']:
        hits = sorted(glob.glob(pat))
        if hits: return hits[-1]
    return None

def render_pdf(html_path, pdf_path):
    chrome = find_chrome()
    if not chrome:
        print('! Chromium не найден — PDF не собран. Задайте $CHROME.', file=sys.stderr); return False
    subprocess.run([chrome, '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
                    f'--print-to-pdf={pdf_path}', f'file://{os.path.abspath(html_path)}'],
                   check=True, stderr=subprocess.DEVNULL)
    return True

def main(argv):
    data_path = 'reports-output/data.json'; html_out = None; pdf_out = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--html': html_out = argv[i+1]; i += 2
        elif a == '--pdf': pdf_out = argv[i+1]; i += 2
        else: data_path = a; i += 1
    data = json.load(open(data_path, encoding='utf-8'))
    html = build_html(data)
    html_out = html_out or 'reports-output/combined.html'
    open(html_out, 'w', encoding='utf-8').write(html)
    print('HTML →', html_out)
    if pdf_out:
        if render_pdf(html_out, pdf_out): print('PDF  →', pdf_out)

if __name__ == '__main__':
    main(sys.argv[1:])
