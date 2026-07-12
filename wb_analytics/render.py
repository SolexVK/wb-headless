#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render.py — слой рендера единой аналитической системы wb_analytics.

Превращает отчёт (dict от analyze.py или загруженный JSON) в единый
многостраничный HTML → PDF. Секции берутся из реестра SECTIONS и рисуются в
порядке, заданном в cfg['sections'] (или в meta.sections отчёта). Один HTML-
документ, акценты страниц разведены CSS-переменными (см. theme.py), рендер —
системным Chromium (theme.render_pdf).

Все тексты сегмента («комплекты»/«КПБ»/…) параметризованы: короткая метка
сегмента берётся из meta.segment_name — поэтому шаблон подходит под любую нишу.
"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import theme as T
nf, money_short, wb_item, wb_brand, a_item, a_brand, wh_label, vars_style = (
    T.nf, T.money_short, T.wb_item, T.wb_brand, T.a_item, T.a_brand, T.wh_label, T.vars_style)

CENTRAL_IDS = {507, 120762, 206348, 117501, 218623, 301229, 206236, 218210, 312807,
               117986, 2737, 1733, 130744, 686, 208277, 301809}
def is_central(wid): return int(wid) in CENTRAL_IDS

# палитры по умолчанию (акценты страниц); можно переопределить в cfg['palettes']
P_COVER = ['#2B3350', '#1C2238', '#EEF0F6', '#F6F7FB']
P_CARDS = [['#0E9488', '#0B7C72', '#E8F6F4', '#F3FAF9'], ['#6D5AE6', '#4C3BC0', '#EDEAFB', '#F7F5FE'],
           ['#E8663D', '#B84A28', '#FCEBE4', '#FEF6F2']]
P_COMP = ['#C7891B', '#9A6A10', '#FBF2DF', '#FDF9F0']
P_WH = ['#0891B2', '#0E6E86', '#E4F4F9', '#F3FBFD']
P_POT = ['#7C3AED', '#5B21B6', '#EFE9FB', '#F8F5FE']
P_NICHE = ['#3B4CA8', '#2A377E', '#EBEDFA', '#F5F6FC']
P_ROAD = ['#1F7A4D', '#155C39', '#E6F4EC', '#F2FAF6']

EXTRA_CSS = """
.lead2 { font-size:11px; color:#5a6478; line-height:1.5; max-width:170mm; }
.tsum { width:100%; border-collapse:collapse; margin-top:6px; }
.tsum th { font-size:8px; text-transform:uppercase; letter-spacing:.03em; color:#9aa2b3; padding:4px 5px; border-bottom:1px solid #e6e9f0; text-align:right; }
.tsum th:first-child { text-align:left; }
.tsum td { font-size:8.6px; padding:3px 5px; border-bottom:1px solid #f2f3f7; text-align:right; white-space:nowrap; }
.tsum td:first-child { text-align:left; font-weight:600; }
.cmpbar { display:flex; align-items:center; gap:8px; margin:5px 0; }
.cmpbar .lb { width:150px; font-size:9.5px; font-weight:600; color:#3a445a; flex:0 0 auto; }
.cmpbar .tk { flex:1; height:16px; background:#eef0f4; border-radius:5px; overflow:hidden; }
.cmpbar .fl { height:100%; border-radius:5px; display:flex; align-items:center; justify-content:flex-end; padding-right:6px; color:#fff; font-size:9px; font-weight:800; }
.road { display:flex; gap:11px; margin:9px 0; align-items:flex-start; }
.road .pr { flex:0 0 auto; width:64px; text-align:center; }
.road .pr b { display:block; font-size:9px; font-weight:800; color:#fff; background:var(--accent); border-radius:6px; padding:3px 0; }
.road .pr span { font-size:7.6px; color:#9aa2b3; }
.road .bd h4 { font-size:11px; color:#141a26; margin-bottom:2px; }
.road .bd p { font-size:9.4px; color:#4a556b; line-height:1.45; }
.verdict { display:flex; gap:10px; margin-top:12px; }
.vbox { flex:1; border:1px solid #e6e9f0; border-radius:10px; padding:11px 13px; border-top:4px solid var(--c); }
.vbox .t { font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:var(--c); }
.vbox .n { font-size:20px; font-weight:800; margin-top:5px; color:#141a26; }
.vbox .n small { font-size:10px; color:#6b7488; font-weight:700; }
.vbox p { font-size:9px; color:#5a6478; margin-top:4px; line-height:1.4; }
.scen { display:flex; gap:10px; margin-top:4px; }
.sbox { flex:1; border:1px solid #e6e9f0; border-radius:10px; padding:12px; border-top:5px solid var(--c); }
.sbox .t { font-size:9.5px; font-weight:800; color:var(--c); line-height:1.2; min-height:24px; }
.sbox .n { font-size:22px; font-weight:800; color:#141a26; margin-top:6px; }
.sbox .n small { font-size:10px; color:#6b7488; }
.sbox .d { font-size:9px; color:#5a6478; margin-top:4px; }
.plan { width:100%; border-collapse:collapse; margin-top:4px; }
.plan th { font-size:8.4px; text-transform:uppercase; color:#9aa2b3; text-align:right; padding:4px 6px; border-bottom:1px solid #e6e9f0; }
.plan th:first-child { text-align:left; }
.plan td { font-size:9.6px; padding:5px 6px; border-bottom:1px solid #f2f3f7; text-align:right; }
.plan td:first-child { text-align:left; font-weight:700; }
"""


def page(cls, pal, inner, anchor=''):
    return f'<div class="page {cls}" id="{anchor}" style="{vars_style(pal)}"><div class="accbar"></div>{inner}</div>'
def kpi(lbl, val, sub, hero=False):
    return f'<div class="kpi{" hero" if hero else ""}"><div class="lbl">{lbl}</div><div class="val">{val}</div><div class="sub">{sub}</div></div>'


# ---------- section builders ----------
# Каждый билдер: (D, ctx) -> html одной .page. ctx = {'pal', 'anchor', 'idx', 'SEG', 'SEGU'}.
# SEG — короткая метка сопоставимого сегмента (напр. «комплекты»), SEGU — с заглавной.

def _cover(D, ctx):
    M = D['meta']; CM = D['comparable']; CP = D['compare']; WH = D['warehouses']; POT = D['potential']; SEG = ctx['SEG']
    SELLER_URL = f"https://www.wildberries.ru/seller/{M['seller_id']}"
    pal = ctx['pal']
    rows = ''.join(
        f"<tr><td>{a_item(s, cls='lnk')}</td><td>{nf(D['targets'][s]['price'])}</td><td>{D['targets'][s]['sales']}</td>"
        f"<td>{nf(D['targets'][s]['revenue'])}</td><td>{D['targets'][s]['comments']}</td><td>{D['targets'][s]['rank']}</td></tr>"
        for s in D['target_order'])
    verdict = f"""<div class="verdict">
      <div class="vbox" style="--c:#1F7A4D"><div class="t">Центральные склады</div><div class="n">{len(WH['seller']['has_priority'])} <small>из 6</small></div><p>вы на регион-складах; у ТОП-конкурентов ср. <b>{WH['avg_comp_central_n']}</b> центр. хаба — <b>ключевая причина</b></p></div>
      <div class="vbox" style="--c:#0E9488"><div class="t">Ассортимент</div><div class="n">{D['seller_agg']['sales']} <small>шт/30д</small></div><p>{D['seller_agg']['n']} карточек · {money_short(D['seller_agg']['revenue'])} ₽ · доля {D['seller_agg']['share']}%</p></div>
      <div class="vbox" style="--c:#E8663D"><div class="t">Цена vs рынок</div><div class="n">{nf(CP['our_avg_price'])} <small>₽</small></div><p>медиана сегмента {nf(CP['kpb_median_price'])} ₽ — вы <b>не дешёвые</b></p></div>
      <div class="vbox" style="--c:#6D5AE6"><div class="t">Отзывы vs ТОП-10</div><div class="n">{CP['our_avg_comments']} <small>ср.</small></div><p>у ТОП-10 ≈ {nf(CP['top10_avg_comments'])} — разрыв ×{round(CP['top10_avg_comments']/max(1,CP['our_avg_comments']))}</p></div>
    </div>"""
    inner = f"""
    <div class="eyebrow">Конкурентный анализ · Wildberries × MPStats</div>
    <h1 style="font-size:26px;margin:8px 0 6px">{M['niche_name'].capitalize()}<br>продавец {a_brand(M['seller'], M['seller'], cls='lnk')} · <a class="lnk" href="{SELLER_URL}">id {M['seller_id']}</a></h1>
    <div class="lead2">Почему у карточек низкие продажи и что усилить. Данные MPStats API за {M['d1']} – {M['d2']} ({M['days']} дней). Ниша — {nf(M['n_sku'])} SKU, {SEG} — {nf(CM['n'])}. Дата: {M['generated']}.</div>
    {verdict}
    <div class="tak"><h3>Главные выводы</h3><ul>
      <li><b>Главная причина — география складов.</b> Товар на <b>региональных</b> складах; на центральных хабах ({', '.join(WH['seller']['missing_priority'][:6])}) его <b>нет</b>. Долгая доставка в ядро спроса роняет и ранжирование, и конверсию. У ТОП-конкурентов ср. <b>{WH['avg_comp_central_n']}</b> центральных хаба.</li>
      <li><b>Дело не в цене.</b> Средняя цена <b>{nf(CP['our_avg_price'])} ₽</b> — выше медианы сегмента ({nf(CP['kpb_median_price'])} ₽). Демпинг не обязателен.</li>
      <li><b>Разрыв в доверии.</b> Ср. <b>{CP['our_avg_comments']}</b> отзывов против ≈<b>{nf(CP['top10_avg_comments'])}</b> у ТОП-10.</li>
      <li><b>Дробление.</b> {len(D['target_order'])} схожих карточек делят трафик; лучший ранг <b>{nf(CP['our_best_rank'])}</b> из {nf(M['n_sku'])}.</li>
      <li><b>Потенциал:</b> при выходе на центральные склады и наборе отзывов — оценочно до <b>{money_short(POT['scenarios'][1]['revenue'])} ₽/мес</b> (см. стр. «Потенциал»).</li>
    </ul></div>
    <div class="card" style="margin-top:14px"><h3>Целевые артикулы ({len(D['target_order'])}) <span>цена · продажи 30д · выручка · отзывы · ранг</span></h3>
      <table class="tsum"><tr><th>Артикул</th><th>Цена ₽</th><th>Продажи</th><th>Выручка ₽</th><th>Отзывы</th><th>Ранг</th></tr>{rows}</table></div>
    <div class="foot"><span>Источник: MPStats API · продавец id {M['seller_id']} ({M['seller']})</span><span>Конфиденциально · для внутреннего анализа</span></div>"""
    return page('cover', pal, inner, ctx['anchor'])


def _target_card(D, ctx):
    M = D['meta']; CP = D['compare']; SEG = ctx['SEG']; sku = ctx['sku']; idx = ctx['idx']; pal = ctx['pal']
    t = D['targets'][sku]; price = t['price'] or 0
    vs_med = f"+{round((price/CP['kpb_median_price']-1)*100)}%" if CP['kpb_median_price'] else '—'
    lost = '0 ₽' if (t.get('lost_profit') in (0, None)) else f"{nf(t['lost_profit'])} ₽"
    zeros = [s['name'] for s in t['sizes'] if s['qty'] == 0]
    lost_sub = ('нулевые размеры: ' + ', '.join(zeros[:4])) if zeros else ('были простои' if (t.get('lost_profit') or 0) > 0 else 'в наличии стабильно')
    mx = max([x['qty'] for x in t['sizes']] + [1])
    sizes = ''.join((f'<div class="srow"><span class="sname">{s["name"][:10]}</span>'
                     + ('<div class="btrack zero"></div><span class="qty zeroq">0</span>' if s['qty'] == 0 else
                        f'<div class="btrack"><div class="bar" style="width:{max(4,min(100,s["qty"]/mx*100)):.0f}%;background:var(--accent)"></div></div><span class="qty">{s["qty"]}</span>')
                     + '</div>') for s in t['sizes'][:7])
    whs = t['warehouses_ids'][:6]; wmx = max([q for _, q in whs] + [1])
    wh = ''.join(f'<div class="wrow"><span class="wname" style="{"color:#1f7a4d;font-weight:800" if is_central(w) else ""}">{"● " if is_central(w) else ""}{wh_label(w)}</span><div class="wtrack"><div class="wbar" style="width:{max(4,q/wmx*100):.0f}%;background:var(--accent)"></div></div><span class="wqty">{q}</span></div>' for w, q in whs)
    kwrows = ''
    for k in (t.get('top_kws') or [])[:5]:
        typ = '<span class="kbadge ad">реклама</span>' if not k['org'] else '<span class="kbadge" style="background:var(--tint);color:var(--accent2)">органика</span>'
        kwrows += f'<tr><td class="q">{k["q"][:40]}</td><td class="pos">~{k["pos"]}</td><td>{typ}</td><td class="fr">{nf(k["freq"])}</td></tr>'
    if not kwrows: kwrows = '<tr><td class="q" colspan="4" style="color:#9aa2b3">нет данных по запросам</td></tr>'
    assess = (f"Цена <b>{nf(price)} ₽</b> ({vs_med} к медиане сегмента) — <b>не дешёвая</b>. Продажи <b>{t['sales']} шт/30д</b> "
              f"({money_short(t['revenue'])} ₽), ранг <b>{nf(t['rank'])}</b> ({SEG} <b>{nf(t.get('kpb_rank'))}</b>). "
              f"Рейтинг {t['rating']}, но всего <b>{t['comments']} отзывов</b>. "
              + ("Есть нулевые размеры. " if zeros else "")
              + ("Склады только региональные — доставка в центр медленная. " if not any(is_central(w) for w, _ in whs) else "")
              + "Рост — центральные склады, отзывы, SEO-заголовок, реклама.")
    inner = f"""
    <div class="hd"><a href="{wb_item(sku)}"><img class="ph" src="{t.get('image','')}"/></a>
      <div class="main"><div class="eyebrow">Разбор целевой карточки · {idx+1} из {len(D['detailed'])}</div>
      <h1><a class="lnk" href="{wb_item(sku)}">{t['name']}</a></h1>
      <div class="artno">Артикул {a_item(sku, cls='lnk b')} · продавец {a_brand(M['seller'], M['seller'])}{' · <b>бренд не указан</b>' if not t.get('brand') else ' · '+t['brand']}</div>
      <div class="chips" style="margin-top:6px"><span class="chip">★ {t['rating']} · {t['comments']} отзывов</span><span class="chip">На ВБ с {t['first_date']}</span><span class="chip">{t.get('stock')} шт остаток</span></div></div></div>
    <div class="kpis">
      {kpi('Заказы за 30 дней', f"{nf(t['revenue'])} <small>₽</small>", f"{t['sales']} шт · {t.get('sales_per_day') and round(t['sales_per_day'],1)} шт/день", True)}
      {kpi('Цена vs медиана сегм.', f"{nf(price)} <small>₽</small>", f"медиана {nf(CP['kpb_median_price'])} ₽ · {vs_med} · до скидки {nf(t.get('base'))}")}
      {kpi('Выкуп по нише', f"{t.get('buyout','—')}%", 'средняя оценка MPStats по категории')}
      {kpi('Ранг · доля', f"#{nf(t['rank'])}", f"из {nf(M['n_sku'])} · {SEG} #{nf(t.get('kpb_rank'))} · доля {t['share']}%", True)}
      {kpi('Отзывы', f"{t['comments']}", f"рейтинг {t['rating']} · мало для конверсии")}
      {kpi('Упущенная выручка', lost, lost_sub)}
    </div>
    <div class="mid">
      <div class="card"><h3>Комплектация / размеры <span>всего {t.get('stock')} шт</span></h3>{sizes}</div>
      <div class="card"><h3>Склады <span>● — центральный хаб · {len(t['warehouses_ids'])} складов</span></h3>{wh}</div>
    </div>
    <div class="card" style="margin-top:11px"><h3>Видимость по запросам <span>орг. запросов в ТОП-100: {t.get('kw_organic_cnt','—')} из {t.get('kw_count','—')}</span></h3>
      <table class="kw"><tr><th>Запрос</th><th style="text-align:right">Поз.</th><th>Трафик</th><th style="text-align:right">Частотн.</th></tr>{kwrows}</table></div>
    <div class="assess" style="margin-top:11px"><h3>Оценка карточки</h3><p>{assess}</p></div>
    <div class="foot"><span>Источник: MPStats API · период {M['d1']}–{M['d2']}</span><span>Сравнение с {SEG}</span></div>"""
    return page('card-report', pal, inner, ctx['anchor'])


def _competitors(D, ctx):
    M = D['meta']; CM = D['comparable']; CP = D['compare']; SEG = ctx['SEG']; pal = ctx['pal']
    seg_note = M.get('segment_note') or f'исключены несопоставимые позиции'
    rows = ''
    for c in D['competitors']:
        nm = (c['name'] or '')[:38]
        ph = f"<a href='{wb_item(c['id'])}'><img class='ltph' src='{c.get('image','')}'/></a>"
        rows += (f"<tr><td class='q'><div class='ltprod'>{ph}<div>{a_item(c['id'], nm)}<i>{a_brand(c['brand']) if c['brand'] else (c['seller'] or '')[:20]}</i></div></div></td>"
                 f"<td class='num'>{nf(c['price'])}</td><td class='num'><b>{nf(c['sales'])}</b></td><td class='num'>{nf(c['revenue'])}</td>"
                 f"<td class='num'>{nf(c['comments'])}</td><td class='num'>{(str(round((c.get('days') or 0)/30))+' мес') if c.get('days') else '—'}</td></tr>")
    def bar(lbl, ours, comp, fmt, co='#0E9488', cc='#C7891B'):
        mx = max(ours, comp, 1)
        return (f'<div class="cmpbar"><span class="lb">{lbl}</span><div class="tk"><div class="fl" style="width:{ours/mx*100:.0f}%;background:{co}">{fmt(ours)}</div></div></div>'
                f'<div class="cmpbar"><span class="lb"></span><div class="tk"><div class="fl" style="width:{comp/mx*100:.0f}%;background:{cc}">{fmt(comp)}</div></div></div>')
    m = lambda x: f"{nf(x)}"
    cmp_block = (bar('Продажи/карточку — вы', CP['our_avg_sales'], CP['top10_avg_sales'], m)
                 + bar('Отзывы/карточку — вы', CP['our_avg_comments'], CP['top10_avg_comments'], m)
                 + bar('Ср. цена — вы', CP['our_avg_price'], CP['top10_avg_price'], lambda x: m(x) + '₽'))
    lead = D['competitors'][0] if D['competitors'] else {}
    inner = f"""
    <div class="eyebrow">Конкуренты · {SEG}</div>
    <h1 style="font-size:21px;margin:4px 0 7px">ТОП-конкуренты по выручке в нише</h1>
    <div class="chips"><span class="chip">Сопоставимых позиций: {nf(CM['n'])} SKU</span><span class="chip">Выручка сегмента {money_short(CM['rev'])} ₽/30д</span></div>
    <div class="card" style="margin-top:12px"><h3>ТОП-{len(D['competitors'])} карточек-конкурентов <span>цена · продажи · выручка · отзывы · возраст</span></h3>
      <table class="lt"><tr><th>Товар / бренд</th><th>Цена ₽</th><th>Продажи</th><th>Выручка ₽</th><th>Отзывы</th><th>На ВБ</th></tr>{rows}</table></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><h3>Вы (среднее) vs ТОП-10 <span>🟩 вы · 🟧 ТОП-10</span></h3>{cmp_block}</div>
      <div class="card"><h3>Что говорят цифры</h3>
        <div class="callout" style="margin-bottom:8px">Лидер объёма — ~<b>{nf(lead.get('price'))} ₽</b>, {nf(lead.get('sales'))} продаж/мес, {nf(lead.get('comments'))} отзывов.</div>
        <div class="callout">Рынок берут <b>отзывами, контентом, рекламой и наличием на центральных складах</b>, а не только ценой. У вас цена конкурентна, но <b>тонкий слой отзывов</b> и <b>региональная логистика</b>.</div>
      </div>
    </div>
    <div class="foot"><span>Источник: MPStats API · период {M['d1']}–{M['d2']}</span><span>Конкуренты — ТОП по выручке в сегменте ({seg_note})</span></div>"""
    return page('niche-report', pal, inner, ctx['anchor'])


def _warehouses(D, ctx):
    M = D['meta']; WH = D['warehouses']; pal = ctx['pal']
    sw = WH['seller']; fp = sw['footprint'][:8]; mx = max([q for _, q, _ in fp] + [1])
    sfp = ''.join(f'<div class="wrow"><span class="wname" style="{"color:#1f7a4d;font-weight:800" if c else ""}">{("● " if c else "")}{n}</span>'
                  f'<div class="wtrack"><div class="wbar" style="width:{max(4,q/mx*100):.0f}%;background:{"#1f7a4d" if c else "var(--accent)"}"></div></div>'
                  f'<span class="wqty">{q}</span></div>' for n, q, c in fp)
    cov = WH['central_coverage']; covbars = ''
    n_comp = len(WH['competitors']) or 1
    for hub in WH['central_priority']:
        cnt = cov.get(hub, 0); has = hub in sw['has_priority']
        covbars += (f'<div class="cmpbar"><span class="lb">{hub}</span><div class="tk"><div class="fl" style="width:{cnt/n_comp*100:.0f}%;background:#C7891B">{cnt}/{n_comp}</div></div>'
                    f'<span style="width:52px;flex:0 0 auto;font-size:9px;font-weight:800;color:{"#1f7a4d" if has else "#e5484d"}">вы: {"✓" if has else "нет"}</span></div>')
    crows = ''
    for c in WH['competitors'][:10]:
        cn = ', '.join(c['central_names']) or '— (FBS/регион)'
        crows += (f"<tr><td class='q'>{a_item(c['id'], (str(c['brand']) or '')[:18])}</td><td class='num'>{c['n_wh']}</td>"
                  f"<td class='num'><b>{c['central_n']}</b></td><td class='num'>{c['central_share']}%</td><td class='q' style='font-weight:600;text-align:left'>{cn[:44]}</td></tr>")
    inner = f"""
    <div class="eyebrow">Логистика · география складов</div>
    <h1 style="font-size:21px;margin:4px 0 7px">Склады — ключевая причина низких продаж</h1>
    <div class="chips"><span class="chip">Продавец: {sw['n_wh']} складов, центральных {sw['central_n']}</span><span class="chip">ТОП-конкуренты: ср. {WH['avg_comp_central_n']} центр. хаба</span></div>
    <div class="kpis">
      {kpi('Центральные хабы — вы', f"{len(sw['has_priority'])} <small>из 6</small>", 'Коледино/Электросталь/Тула/Казань/СПб/Екб', True)}
      {kpi('Сток на центре — вы', f"{sw['central_share']}%", f"{sw['n_wh']} складов · {nf(sw['total_qty'])} шт")}
      {kpi('Центр. хабы — ТОП-10', f"{WH['avg_comp_central_n']}", 'в среднем на карточку')}
      {kpi('Сток на центре — ТОП-10', f"{WH['avg_comp_central_share']}%", 'доля остатка на центральных хабах', True)}
      {kpi('Где вы есть', f"{sw['n_wh']}", 'склада — регион')}
      {kpi('Чего нет', f"{len(sw['missing_priority'])} <small>хаба</small>", ', '.join(sw['missing_priority'][:3]) + '…')}
    </div>
    <div class="grid2">
      <div class="card"><h3>Склады продавца <span>● — центральный хаб</span></h3>{sfp}
        <div class="callout" style="margin-top:9px">Основной сток — региональные склады. На флагманских хабах Москвы/центра товара практически нет.</div></div>
      <div class="card"><h3>Покрытие центр. хабов <span>сколько из {n_comp} ТОП-конкурентов там есть</span></h3>{covbars}
        <div class="callout" style="margin-top:9px">Вы — {("на " + ', '.join(sw['has_priority'])) if sw['has_priority'] else "ни на одном центральном хабе"}.</div></div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Конкуренты: склады и центральные хабы <span>склады · центр. · доля стока · какие</span></h3>
      <table class="lt"><tr><th>Бренд</th><th>Складов</th><th>Центр.</th><th>Доля</th><th style="text-align:left">Центральные хабы</th></tr>{crows}</table></div>
    <div class="assess" style="margin-top:11px"><h3>Почему это бьёт по продажам</h3>
      <p>WB ранжирует и считает срок доставки от ближайшего склада. Основной спрос — Москва и центр РФ (Коледино, Электросталь, Тула/Алексин, Подольск). Товар только на региональных складах → доставка в ядро спроса дольше, карточка проигрывает в выдаче и в проценте выкупа; отсутствие в Казани/СПб/Екатеринбурге отрезает регионы-миллионники. Решение — план распределения стока (следующая страница).</p></div>
    <div class="foot"><span>Источник: MPStats (остатки по складам) + справочник складов WB</span><span>Центральный хаб = флагманский WB-склад Москвы/города-миллионника</span></div>"""
    return page('niche-report', pal, inner, ctx['anchor'])


def _potential(D, ctx):
    M = D['meta']; POT = D['potential']; pal = ctx['pal']
    cols = ['#8a93a6', '#7C3AED', '#1F7A4D']
    sboxes = ''.join(
        f'<div class="sbox" style="--c:{cols[i]}"><div class="t">{s["name"]}</div>'
        f'<div class="n">{money_short(s["revenue"])} <small>₽/мес</small></div>'
        f'<div class="d">{nf(s["units"])} шт/мес · ×{s["mult"]}'
        + (f'<br>лог. ×{s.get("log_f")} × контент ×{s.get("rev_f")} · +{money_short(s["revenue"]-POT["scenarios"][0]["revenue"])} ₽' if i > 0 else '') + '</div></div>'
        for i, s in enumerate(POT['scenarios']))
    mxrev = max(s['revenue'] for s in POT['scenarios']) or 1
    revbars = ''.join(
        f'<div class="cmpbar"><span class="lb">{s["name"][:26]}</span><div class="tk"><div class="fl" style="width:{s["revenue"]/mxrev*100:.0f}%;background:{cols[i]}">{money_short(s["revenue"])} ₽</div></div></div>'
        for i, s in enumerate(POT['scenarios']))
    prows = ''.join(f"<tr><td>{p['hub']}</td><td>{p['weight']}%</td><td><b>{nf(p['units'])}</b></td></tr>" for p in POT['dist_plan'])
    inner = f"""
    <div class="eyebrow">Потенциал и план распределения стока</div>
    <h1 style="font-size:21px;margin:4px 0 7px">Сколько можно продавать и как разложить товар</h1>
    <div class="chips"><span class="chip">Оценочно · допущения указаны</span><span class="chip">База: {nf(POT['base_units'])} шт/мес · цена {nf(POT['price'])} ₽</span></div>
    <div class="card" style="margin-top:12px"><h3>Сценарии потенциала <span>выручка/мес при разной проработке</span></h3>
      <div class="scen">{sboxes}</div>
      <div style="margin-top:11px">{revbars}</div>
      <div class="callout" style="margin-top:9px">{POT['assumptions']} Не гарантия, а ориентир для планирования.</div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><h3>План распределения стока <span>под реалистичный сценарий · {nf(POT['target_units'])} шт/мес</span></h3>
        <table class="plan"><tr><th>Склад (центр. хаб)</th><th>Доля</th><th>Ед./мес</th></tr>{prows}</table>
        <div class="callout" style="margin-top:9px">Доли — по фактическому размещению стока ТОП-конкурентов на центральных хабах. Начинать с <b>{POT['dist_plan'][0]['hub'] if POT['dist_plan'] else '—'}</b> и <b>{POT['dist_plan'][1]['hub'] if len(POT['dist_plan'])>1 else '—'}</b>.</div></div>
      <div class="card"><h3>Как считали <span>коэффициент привязан к доле центр. спроса</span></h3>
        <div class="callout" style="margin-bottom:8px"><b>Доля центрального спроса.</b> Центральные регионы дают ≈<b>{POT['central_demand_pct']}%</b> спроса ниши ({' · '.join(f'{r} {w}%' for r, w in POT['region_weights'])}). Продавцу недоступно ≈<b>{POT['c_missing_pct']}%</b> (нет стока в: {', '.join(POT['missing_regions'])}).</div>
        <div class="callout" style="margin-bottom:8px"><b>Множитель.</b> Логистический фактор = 1 + недоступная доля × доля отвоевания; умножается на фактор контента/отзывов. Итог: ×{POT['scenarios'][1]['mult']} и ×{POT['scenarios'][2]['mult']}.</div>
        <div class="callout"><b>Распределение</b> целевого объёма {nf(POT['target_units'])} шт/мес — по фактическому стоку лидеров на хабах. Сначала логистика+отзывы (P1), потом реклама.</div></div>
    </div>
    <div class="foot"><span>Источник: MPStats + справочник складов WB · период {M['d1']}–{M['d2']}</span><span>Оценочный расчёт · допущения в тексте</span></div>"""
    return page('niche-report', pal, inner, ctx['anchor'])


def _niche(D, ctx):
    M = D['meta']; NI = D['niche']; CM = D['comparable']; CP = D['compare']; SEG = ctx['SEG']; SEGU = ctx['SEGU']; pal = ctx['pal']
    price_bars = ''.join(f'<div class="hb"><span class="hbl">{l}</span><div class="hbt"><div class="hbf" style="width:{max(3,v/max([x[1] for x in NI["bands"]]+[1])*100):.0f}%;background:var(--accent)"></div></div><span class="hbv">{v}%</span></div>' for l, v in NI['bands'])
    brand_bars = ''.join(f'<div class="hb"><span class="hbl">{a_brand(b, (b if len(b)<=16 else b[:15]+"…"))}</span><div class="hbt"><div class="hbf" style="width:{max(3,s/max([x[1] for x in NI["brands"]]+[1])*100):.0f}%;background:var(--accent)"></div></div><span class="hbv">{s}% · {cnt}</span></div>' for b, s, cnt in NI['brands'][:6])
    inner = f"""
    <div class="eyebrow">Аналитика ниши · Wildberries</div>
    <h1 style="font-size:22px;margin:4px 0 7px">Ниша: «<span style="color:var(--accent)">{M['niche_name']}</span>»</h1>
    <div class="chips"><span class="chip">Период {M['d1']}–{M['d2']} · {M['days']} дней</span><span class="chip">Категория «{M['niche_path'][:52]}…»</span></div>
    <div class="kpis">
      {kpi('Объём ниши · выручка', f"{money_short(NI['n_rev'])} <small>₽</small>", f"{nf(NI['n_sku'])} SKU · {nf(NI['n_sales'])} продаж", True)}
      {kpi('Медианная цена (сегмент)', f"{nf(CM['price_median'])} <small>₽</small>", f"коридор {nf(CM['p25'])}–{nf(CM['p75'])} ₽ · вся ниша {nf(NI['price_median'])} ₽")}
      {kpi('Средний выкуп', f"{NI['buyout']}%", "по нише")}
      {kpi('Концентрация · ТОП-100', f"{NI['top100']}%", "выручки у ТОП-100", True)}
      {kpi('Активные карточки', f"{NI['with_sales_share']}%", f"новинок за 180 дн — {NI['new180_share']}%")}
      {kpi('Игроков', f"{nf(NI['n_brands'])}", f"брендов · {nf(NI['n_sellers'])} продавцов · FBS {NI['fbs_share']}%")}
    </div>
    <div class="grid2">
      <div class="card"><h3>Ценовая структура <span>доля выручки по цене</span></h3>{price_bars}
        <div class="callout" style="margin-top:9px">{SEGU} живут в коридоре <b>{nf(CM['p25'])}–{nf(CM['p75'])} ₽</b>. Ваши {nf(CP['our_avg_price'])} ₽ — в верхней части, но не премиум.</div></div>
      <div class="card"><h3>Лидеры по брендам <span>доля выручки · SKU</span></h3>{brand_bars}
        <div class="callout" style="margin-top:9px">Рынок раздроблен: ТОП-100 = {NI['top100']}% выручки. Есть место для сильной карточки.</div></div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Позиция продавца в нише <span>место среди {nf(M['n_sku'])} SKU</span></h3>
      <div class="ours">
        <div class="ocard" style="border-left-color:#0E9488"><div class="osku">Ассортимент ({D['seller_agg']['n']} карточек)</div><div class="orank">доля <b>{D['seller_agg']['share']}%</b></div><div class="osub">{D['seller_agg']['sales']} продаж · {money_short(D['seller_agg']['revenue'])} ₽ · лучший ранг {nf(CP['our_best_rank'])}</div></div>
        <div class="ocard" style="border-left-color:#E8663D"><div class="osku">Разрыв с ТОП-10</div><div class="orank">×{round(CP['top10_avg_sales']/max(1,CP['our_avg_sales']))} <span>по продажам</span></div><div class="osub">вы {CP['our_avg_sales']} vs {nf(CP['top10_avg_sales'])} шт/карточку</div></div>
        <div class="ocard" style="border-left-color:#6D5AE6"><div class="osku">Разрыв по отзывам</div><div class="orank">×{round(CP['top10_avg_comments']/max(1,CP['our_avg_comments']))} <span>меньше</span></div><div class="osub">вы {CP['our_avg_comments']} vs {nf(CP['top10_avg_comments'])} отзывов</div></div>
      </div></div>
    <div class="assess" style="margin-top:12px"><h3>Оценка ниши</h3>
      <p>Крупная стабильная ниша (<b>{money_short(NI['n_rev'])} ₽/мес</b>, {nf(NI['n_sku'])} SKU), раздробленная (ТОП-100 = {NI['top100']}% выручки) — рост реален. Продавец в нужном ценовом коридоре и с рейтингом 5,0, но проигрывает по <b>логистике, отзывам и контенту</b>, а ассортимент распылён.</p></div>
    <div class="foot"><span>Источник: MPStats API · период {M['d1']}–{M['d2']}</span><span>Сегмент выделен из подкатегории</span></div>"""
    return page('niche-report', pal, inner, ctx['anchor'])


def _roadmap(D, ctx):
    M = D['meta']; POT = D['potential']; pal = ctx['pal']
    items = ''.join(f'<div class="road"><div class="pr"><b>{p}</b><span>{when}</span></div><div class="bd"><h4>{title}</h4><p>{detail}</p></div></div>'
                    for p, when, title, detail in D['roadmap'])
    inner = f"""
    <div class="eyebrow">Дорожная карта улучшений</div>
    <h1 style="font-size:22px;margin:4px 0 7px">Что сделать, чтобы поднять продажи</h1>
    <div class="chips"><span class="chip">Приоритеты P1→P3</span><span class="chip">Диагноз: склады (центр) + отзывы + дробление + контент</span></div>
    <div class="card" style="margin-top:10px"><h3>План действий <span>от быстрых побед к системным</span></h3>{items}</div>
    <div class="assess" style="margin-top:10px"><h3>Резюме</h3>
      <p><b>Корневая причина — логистика:</b> товар только на региональных складах, нет присутствия на центральных хабах, где основной спрос. Плюс тонкий слой отзывов и распылённый ассортимент; цена и качество конкурентны. Быстрые победы (P1): распределить сток по центральным складам, набрать отзывы, консолидировать карточки. Далее (P2–P3): бренд, SEO, контент, реклама. Потенциал — оценочно до {money_short(POT['scenarios'][1]['revenue'])}–{money_short(POT['scenarios'][2]['revenue'])} ₽/мес.</p></div>
    <div class="foot"><span>Источник: MPStats API · период {M['d1']}–{M['d2']}</span><span>Продавец {M['seller']} · id {M['seller_id']}</span></div>"""
    return page('niche-report', pal, inner, ctx['anchor'])


# реестр секций: имя → (builder, палитра). 'target_cards' — особая (мультистраничная).
SECTIONS = {
    'cover':        (_cover, P_COVER),
    'competitors':  (_competitors, P_COMP),
    'warehouses':   (_warehouses, P_WH),
    'potential':    (_potential, P_POT),
    'niche':        (_niche, P_NICHE),
    'roadmap':      (_roadmap, P_ROAD),
}


def build_html(D, cfg=None):
    """Собрать единый HTML по манифесту секций (cfg['sections'] или meta.sections)."""
    cfg = cfg or {}
    M = D['meta']
    sections = cfg.get('sections') or M.get('sections') or ['cover', 'target_cards', 'competitors', 'warehouses', 'potential', 'niche', 'roadmap']
    palettes = cfg.get('palettes', {})
    SEG = M.get('segment_name') or 'сопоставимый сегмент'
    SEGU = SEG[:1].upper() + SEG[1:]
    cards_pal = palettes.get('cards', P_CARDS)
    pages = []; anchor = 1
    for sec in sections:
        if sec == 'target_cards':
            for i, sku in enumerate(D['detailed']):
                ctx = {'pal': cards_pal[i % len(cards_pal)], 'anchor': f'p{anchor}', 'idx': i, 'sku': sku, 'SEG': SEG, 'SEGU': SEGU}
                pages.append(_target_card(D, ctx)); anchor += 1
        elif sec in SECTIONS:
            builder, defpal = SECTIONS[sec]
            pal = palettes.get(sec, defpal)
            ctx = {'pal': pal, 'anchor': f'p{anchor}', 'SEG': SEG, 'SEGU': SEGU}
            pages.append(builder(D, ctx)); anchor += 1
        else:
            print(f'  ! неизвестная секция «{sec}» — пропущена', file=sys.stderr)
    return ("<!doctype html><html><head><meta charset='utf-8'><style>@page{size:A4;margin:0}"
            + T.CSS + EXTRA_CSS + "</style></head><body>" + "\n".join(pages) + "</body></html>")


def render(D, html_out, pdf_out=None, cfg=None):
    html = build_html(D, cfg)
    os.makedirs(os.path.dirname(html_out) or '.', exist_ok=True)
    open(html_out, 'w', encoding='utf-8').write(html)
    print('HTML →', html_out)
    if pdf_out and T.render_pdf(html_out, pdf_out):
        print('PDF  →', pdf_out)
    return html
