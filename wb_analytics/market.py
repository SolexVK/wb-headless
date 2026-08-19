#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
market.py — рыночный (нишевый) отчёт системы wb_analytics: анализ рынка/сегмента
БЕЗ конкретного продавца. Страницы:
    1. Сводка рынка/сегмента (объём, цены, концентрация, игроки, выводы)
    2. Прогноз продаж по целевой ценовой зоне (напр. средний + выше-среднего):
       сценарии для сильной карточки, подсегменты, ёмкость по полосам
    3. ТОП-20 карточек — таблица с фото (в HTML фото увеличивается ×3 по наведению
       модальным окном), кликабельный артикул → карточка WB, бренд, метрики
    4. Цвета и размеры на одном листе — доля расцветок и распределение по размерам

Данные готовит market_collect.py (или любой сборщик в схему market_data.json).
Рендер — theme.render_pdf (Chromium --print-to-pdf). Hover-зум работает только в
HTML (в PDF hover невозможен — печатается статичная миниатюра).

    python3 wb_analytics/market.py market_data.json --html out.html --pdf out.pdf
"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import theme as T
nf, money_short, wb_item, wb_brand, a_item, a_brand = (
    T.nf, T.money_short, T.wb_item, T.wb_brand, T.a_item, T.a_brand)

P_COVER = ['#3B5BDB', '#2942B8', '#E8ECFF', '#F3F5FF']
P_TOP   = ['#0DAB9A', '#0A7C72', '#DEF6F2', '#F0FBF9']
P_COLOR = ['#8B2FE0', '#6A1FB0', '#F0E7FE', '#F9F5FF']
P_SIZE  = ['#F97316', '#C2560B', '#FFEEDD', '#FFF7F0']
P_HIGH  = ['#0E9F6E', '#0A7350', '#E1F6EE', '#F0FBF6']
# палитра для разноцветных KPI-плиток (добавляет живости)
KPI_COLORS = ['#3B5BDB', '#0DAB9A', '#F97316', '#8B2FE0', '#E8517A', '#0E9F6E']

# палитра семейств цветов (для доната/легенды)
FAM_COLORS = {
    'Белый': '#D7DBE2', 'Синий/голубой': '#3B6FE0', 'Чёрный': '#2B3350',
    'Бежевый': '#D8C4A0', 'Серый': '#9AA2B3', 'Зелёный/хаки': '#6B8E5A',
    'Коричневый': '#8B5E3C', 'Красный/бордо': '#B23A48', 'Другое': '#C9CDD6'}

MARKET_CSS = r"""
.lead2 { font-size:11.5px; color:#5a6478; line-height:1.55; max-width:172mm; }
.wide-kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:9px; margin-top:13px; }
/* top-20 table */
.t20 { width:100%; border-collapse:collapse; margin-top:10px; table-layout:fixed; }
.t20 th { font-size:8px; text-transform:uppercase; letter-spacing:.03em; color:#8a93a6; font-weight:800;
  padding:5px 4px; border-bottom:2px solid #e6e9f0; text-align:right; }
.t20 col.c-rk{ width:20px; } .t20 col.c-ph{ width:40px; } .t20 col.c-nm{ width:232px; }
.t20 col.c-pr{ width:52px; } .t20 col.c-sl{ width:60px; } .t20 col.c-sd{ width:40px; }
.t20 col.c-rv{ width:60px; } .t20 col.c-cm{ width:58px; } .t20 col.c-st{ width:34px; }
.t20 th:nth-child(1){ text-align:center; } .t20 th:nth-child(2){ text-align:center; }
.t20 th:nth-child(3){ text-align:left; }
.t20 td { font-size:9px; padding:2px 4px; border-bottom:1px solid #f1f2f6; text-align:right; white-space:nowrap; }
.t20 td.rk { text-align:center; color:#aab0be; font-weight:800; font-size:9px; }
.t20 td.ph { text-align:center; padding:1px 2px; }
.t20 td.nm { text-align:left; overflow:hidden; }
.t20 td.nm .l1 { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.t20 td.nm .art { font-weight:800; }
.t20 td.nm .br { font-size:8.2px; color:#8a93a6; font-weight:600; }
.t20 td.nm .nml { display:block; font-size:8px; color:#9aa2b3; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.t20 td.big { font-weight:800; color:#141a26; }
.t20 tr:nth-child(even) td { background:#fafbfc; }
.t20 .star { color:#e8a70b; font-weight:800; }
/* hover-zoom (HTML only; в PDF hover не срабатывает — печатается миниатюра) */
.page.market { overflow:visible; }  /* чтобы увеличенное фото не обрезалось краем страницы (в PDF hover не срабатывает) */
.thumb { position:relative; display:inline-block; line-height:0; }
.thumb .tmb { width:30px; height:40px; object-fit:cover; border-radius:4px; border:1px solid #e0e3ea; }
.thumb .zoom { position:absolute; bottom:100%; left:50%; transform:translateX(-50%) translateY(-6px);
  width:150px; height:200px; object-fit:cover; border-radius:8px; border:3px solid #fff;
  box-shadow:0 10px 30px rgba(20,30,50,.35); display:none; z-index:50; pointer-events:none; background:#fff; }
.thumb:hover .zoom { display:block; }
/* charts */
.chartwrap { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px; align-items:start; }
.donut-legend { display:flex; flex-direction:column; gap:6px; }
.lgrow { display:flex; align-items:center; gap:8px; font-size:10px; }
.lgsw { width:12px; height:12px; border-radius:3px; border:1px solid rgba(0,0,0,.08); flex:0 0 auto; }
.lgnm { flex:1; color:#3a445a; font-weight:600; }
.lgpc { font-weight:800; color:#141a26; }
.hbar { display:flex; align-items:center; gap:9px; margin:5px 0; }
.hbl { width:120px; font-size:9.5px; font-weight:600; color:#3a445a; flex:0 0 auto; overflow:hidden;
  white-space:nowrap; text-overflow:ellipsis; }
.hbt { flex:1; height:14px; background:#eef0f4; border-radius:5px; overflow:hidden; }
.hbf { height:100%; border-radius:5px; display:flex; align-items:center; justify-content:flex-end;
  padding-right:5px; color:#fff; font-size:8.5px; font-weight:800; }
.hbv2 { width:40px; text-align:right; font-size:9px; font-weight:800; color:#141a26; flex:0 0 auto; }
.szbar { display:flex; align-items:flex-end; gap:8px; height:150px; margin:14px 0 4px; padding:0 4px; }
.szcol { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
.szfill { width:100%; border-radius:6px 6px 0 0; background:var(--accent); min-height:3px; position:relative; }
.szpc { font-size:9.5px; font-weight:800; color:#141a26; margin-bottom:3px; }
.szlb { font-size:9.5px; font-weight:700; color:#3a445a; margin-top:5px; }
.szsub { font-size:8px; color:#9aa2b3; }
.note { background:var(--soft); border-radius:9px; padding:11px 13px; font-size:10px; color:#33405a; line-height:1.5; }
.note b { color:var(--accent2); }
.secttl { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; }
/* high-segment scenarios */
.scn { display:flex; gap:11px; margin-top:4px; }
.scnbox { flex:1; border:1px solid #e6e9f0; border-radius:11px; padding:13px; border-top:5px solid var(--c);
  background:linear-gradient(180deg, var(--c)0C, #fff 60%); }
.scnbox .t { font-size:10px; font-weight:800; color:var(--c); text-transform:uppercase; letter-spacing:.04em; }
.scnbox .n { font-size:24px; font-weight:800; color:#141a26; margin-top:7px; line-height:1; }
.scnbox .n small { font-size:11px; color:#6b7488; font-weight:700; }
.scnbox .u { font-size:11px; color:#3a445a; font-weight:700; margin-top:5px; }
.scnbox .d { font-size:8.6px; color:#9aa2b3; margin-top:5px; line-height:1.35; }
.ceil { display:flex; align-items:center; gap:12px; margin-top:12px; background:var(--soft);
  border-radius:10px; padding:11px 14px; border-left:5px solid var(--accent); }
.ceil .big { font-size:20px; font-weight:800; color:var(--accent2); white-space:nowrap; }
.ceil .tx { font-size:9.6px; color:#33405a; line-height:1.4; }
.bandtbl { width:100%; border-collapse:collapse; margin-top:4px; }
.bandtbl th { font-size:8.4px; text-transform:uppercase; color:#9aa2b3; text-align:right; padding:5px 6px; border-bottom:2px solid #e6e9f0; }
.bandtbl th:first-child { text-align:left; }
.bandtbl td { font-size:9.6px; padding:6px 6px; border-bottom:1px solid #f2f3f7; text-align:right; }
.bandtbl td:first-child { text-align:left; font-weight:700; }
.bandtbl tr.hl td { background:var(--soft); }
/* medal rank badges */
.medal { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
  border-radius:50%; font-size:9px; font-weight:800; color:#fff; }
.m1 { background:linear-gradient(135deg,#F5C542,#D9A400); } .m2 { background:linear-gradient(135deg,#C6CCD6,#9AA2B3); }
.m3 { background:linear-gradient(135deg,#E0995C,#B06B36); }
"""


def page(cls, pal, inner, anchor=''):
    v = f"--accent:{pal[0]};--accent2:{pal[1]};--tint:{pal[2]};--soft:{pal[3]}"
    return f'<div class="page {cls}" id="{anchor}" style="{v}"><div class="accbar"></div>{inner}</div>'
def kpi(lbl, val, sub, hero=False, c=None):
    """KPI-плитка; c — акцентный цвет плитки (верхняя рамка/значение) для «живости»."""
    style = ''
    if c:
        style = f' style="border-top-color:{c};background:{c}0F"'
    lblc = f' style="color:{c}"' if c else ''
    return (f'<div class="kpi{" hero" if hero else ""}"{style}><div class="lbl"{lblc}>{lbl}</div>'
            f'<div class="val">{val}</div><div class="sub">{sub}</div></div>')


def donut_svg(fams, size=150, stroke=26):
    """Донат по семействам цветов. fams = [(name, sales, pct)]."""
    import math
    r = (size - stroke) / 2; c = 2 * math.pi * r; cx = cy = size / 2
    segs = ''; off = 0
    for name, _, pct in fams:
        frac = pct / 100.0; ln = c * frac
        col = FAM_COLORS.get(name, '#C9CDD6')
        segs += (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{col}" stroke-width="{stroke}" '
                 f'stroke-dasharray="{ln:.2f} {c-ln:.2f}" stroke-dashoffset="{-off:.2f}" transform="rotate(-90 {cx} {cy})"/>')
        off += ln
    top = fams[0] if fams else ('', 0, 0)
    return (f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}">{segs}'
            f'<text x="{cx}" y="{cy-4}" text-anchor="middle" font-size="20" font-weight="800" fill="#141a26">{top[2]:.0f}%</text>'
            f'<text x="{cx}" y="{cy+12}" text-anchor="middle" font-size="9" fill="#8a93a6">{top[0]}</text></svg>')


def build_html(D):
    M = D; SEG = D['segment']; MK = D['market']; per = D['period']
    seg_name = D['segment_name']

    # ---------- COVER ----------
    def cover():
        s = SEG; FC = D.get('forecast') or {}
        zlo, zhi = (FC.get('zone') or [1700, 3500])
        kc = KPI_COLORS
        kpis = ''.join([
            kpi('Объём рынка (вся категория)', f"{money_short(MK['revenue'])} <small>₽</small>", f"{nf(MK['n_sku'])} SKU · {nf(MK['sales'])} продаж за {per['days']} дн", True, kc[0]),
            kpi('Объём сегмента', f"{money_short(s['revenue'])} <small>₽</small>", f"{nf(s['n_sku'])} SKU · {nf(s['sales'])} продаж · {s['share_rev']}% рынка", True, kc[1]),
            kpi(f'Целевая зона {nf(zlo)}–{nf(zhi)} ₽', f"{money_short(FC.get('revenue',0))} <small>₽</small>", f"{FC.get('share_rev',0)}% выручки сегмента · медиана {nf(FC.get('price_median',0))} ₽", True, kc[5]),
            kpi('Медианная цена сегмента', f"{nf(s['price_median'])} <small>₽</small>", f"коридор {nf(s['p25'])}–{nf(s['p75'])} ₽ (p25–p75)", False, kc[2]),
            kpi('Концентрация ТОП-100', f"{s['top100']}%", f"ТОП-10 {s['top10']}% · ТОП-50 {s['top50']}% выручки", False, kc[3]),
            kpi('Игроки', f"{nf(s['n_brands'])} <small>брендов</small>", f"{nf(s['n_sellers'])} продавцов — рынок раздроблен", False, kc[4]),
        ])
        topc = D['colors_family'][0]; topc2 = D['colors_family'][1]
        inner = f"""
        <div class="eyebrow">Конкурентный анализ рынка · Wildberries × MPStats</div>
        <h1 style="font-size:25px;margin:8px 0 6px">{seg_name}</h1>
        <div class="lead2">Анализ рынка и сопоставимого сегмента за <b>{per['d1']} – {per['d2']}</b> ({per['days']} дней).
        Сегмент выделен из категории «{MK_path(M)}»: только однотонные (без клетки/полоски/принта), приталенные или
        прямого кроя, длинный рукав. Ниже — объём, ТОП-20 игроков, структура продаж по цветам и размерам.</div>
        <div class="wide-kpis">{kpis}</div>
        <div class="tak" style="margin-top:16px"><h3>Главные выводы</h3><ul>
          <li><b>Крупный, но раздроблённый рынок.</b> Сегмент — <b>{money_short(s['revenue'])} ₽</b> за {per['days']} дней ({s['share_rev']}% всей категории рубашек), но ТОП-100 карточек держат лишь <b>{s['top100']}%</b> выручки. Место для входа есть.</li>
          <li><b>Деньги — в среднем и выше-среднем.</b> Ценовая зона <b>{nf(zlo)}–{nf(zhi)} ₽</b> даёт <b>{FC.get('share_rev',0)}%</b> выручки сегмента ({money_short(FC.get('revenue',0))} ₽, {nf(FC.get('n_sku',0))} SKU, медиана {nf(FC.get('price_median',0))} ₽) — и лучшую скорость продаж. Прогноз — на стр. «Прогноз продаж».</li>
          <li><b>Цвет решает.</b> В продажах доминирует <b>{topc[0].lower()} — {topc[2]:.0f}%</b>, затем {topc2[0].lower()} {topc2[2]:.0f}%. Базовые светлые цвета — ядро ассортимента.</li>
          <li><b>Размерное ядро — {size_core(D)}</b> (см. стр. «Размеры»): на них приходится основная масса продаж; крайние размеры чаще затоварены.</li>
        </ul></div>
        <div class="foot"><span>Источник: MPStats API · категория {MK_path(M)} · {per['d1']}–{per['d2']}</span><span>Сегмент: однотонные приталенные/прямого кроя, длинный рукав</span></div>"""
        return page('cover', P_COVER, inner, 'p1')

    # ---------- TOP-20 ----------
    def top20():
        rows = ''
        for i, t in enumerate(D['top20']):
            nm = (t['name'] or '')[:44]
            img = t.get('image') or ''
            ph = (f'<div class="thumb"><img class="tmb" src="{img}"/><img class="zoom" src="{img}"/></div>'
                  if img else '<span style="color:#ccc">—</span>')
            brand = a_brand(t['brand'], (t['brand'] or '—')[:20]) if t.get('brand') else '—'
            rkcell = (f'<span class="medal m{i+1}">{i+1}</span>' if i < 3 else str(i+1))
            rows += (f'<tr><td class="rk">{rkcell}</td><td class="ph">{ph}</td>'
                     f'<td class="nm"><span class="l1"><span class="art">{a_item(t["id"], cls="lnk b")}</span> · <span class="br">{brand}</span></span>'
                     f'<span class="nml">{nm}</span></td>'
                     f'<td class="big">{nf(t["price"])}</td>'
                     f'<td class="big">{nf(t["sales"])}</td>'
                     f'<td>{nf(round((t.get("spd") or 0)))}</td>'
                     f'<td class="big">{money_short(t["revenue"])}</td>'
                     f'<td>{nf(t["comments"])}</td>'
                     f'<td class="star">★{t.get("rating") or "—"}</td></tr>')
        inner = f"""
        <div class="eyebrow">ТОП-20 карточек сегмента · по выручке за {per['days']} дней</div>
        <h1 style="font-size:21px;margin:4px 0 6px">ТОП-20 лидеров: продажи, цены, метрики</h1>
        <div class="lead2" style="font-size:10px">Наведите курсор на фото — увеличенное изображение (в HTML-версии). Артикул кликабелен — открывает карточку на Wildberries.</div>
        <table class="t20">
          <colgroup><col class="c-rk"><col class="c-ph"><col class="c-nm"><col class="c-pr"><col class="c-sl"><col class="c-sd"><col class="c-rv"><col class="c-cm"><col class="c-st"></colgroup>
          <tr><th>#</th><th>Фото</th><th>Артикул · бренд · название</th><th>Цена ₽</th><th>Прод. 90д</th><th>шт/дн</th><th>Выручка</th><th>Отзывы</th><th>★</th></tr>
          {rows}
        </table>
        <div class="foot"><span>Источник: MPStats API · {per['d1']}–{per['d2']}</span><span>Продажи — за 90 дней; шт/дн — среднесуточные</span></div>"""
        return page('market', P_TOP, inner, 'p3')

    # ---------- COLORS + SIZES (combined) ----------
    def combo():
        # --- colors ---
        fams = D['colors_family']
        legend = ''.join(
            f'<div class="lgrow"><span class="lgsw" style="background:{FAM_COLORS.get(n,"#ccc")}"></span>'
            f'<span class="lgnm">{n}</span><span class="lgpc">{p:.0f}%</span></div>' for n, _, p in fams)
        mxc = max([p for _, _, p in D['colors_top']] + [1])
        cbars = ''.join(
            f'<div class="hbar"><span class="hbl">{c}</span><div class="hbt"><div class="hbf" style="width:{max(2,p/mxc*100):.0f}%;background:{P_COLOR[0]}"></div></div><span class="hbv2">{p:.1f}%</span></div>'
            for c, n, p in D['colors_top'][:8])
        top = fams[0]
        # --- sizes ---
        sz = D['sizes']; mx = max([p for _, _, p in sz] + [1])
        core = size_core(D)
        labels = [l for l, _, _ in sz]
        core_set = set()
        if '–' in core:
            a, b = core.split('–')
            if a in labels and b in labels:
                core_set = set(labels[labels.index(a): labels.index(b) + 1])
        elif core in labels:
            core_set = {core}
        def fill(b, p):
            bg = (f'background:linear-gradient(180deg,{P_SIZE[0]},{P_SIZE[1]})' if b in core_set
                  else f'background:{P_SIZE[0]}55')
            return f'<div class="szfill" style="height:{max(3,p/mx*100):.0f}%;{bg}"></div>'
        scols = ''.join(
            f'<div class="szcol"><div class="szpc"{" style=color:"+P_SIZE[1] if b in core_set else ""}>{p:.0f}%</div>'
            f'{fill(b,p)}<div class="szlb">{b}{"  ●" if b in core_set else ""}</div></div>' for b, s, p in sz)
        inner = f"""
        <div class="eyebrow">Структура продаж · цвета и размеры</div>
        <h1 style="font-size:21px;margin:4px 0 6px">Что покупают: цвета и размеры</h1>
        <div class="chips"><span class="chip">Цвета — {nf(D['colors_sample'])} SKU сегмента</span><span class="chip">Размеры — {nf(D['sizes_sample'])} карточек ТОП</span><span class="chip">доли взвешены по продажам</span></div>

        <div class="secttl" style="color:{P_COLOR[1]}">Цвета — доля расцветок в продажах</div>
        <div class="chartwrap" style="margin-top:6px">
          <div class="card"><h3>Семейства цветов <span>доля в продажах</span></h3>
            <div style="display:flex;gap:14px;align-items:center;margin-top:4px">
              <div style="flex:0 0 auto">{donut_svg(fams, size=128, stroke=22)}</div>
              <div class="donut-legend" style="flex:1">{legend}</div>
            </div>
          </div>
          <div class="card"><h3>ТОП-8 точных цветов <span>% продаж</span></h3>{cbars}
            <div class="note" style="margin-top:8px;font-size:9.2px">Ядро — <b>{top[0].lower()} ({top[2]:.0f}%)</b> + синяя гамма. Тёмные и яркие — нишевые.</div></div>
        </div>

        <div class="secttl" style="color:{P_SIZE[1]};margin-top:13px">Размеры — распределение продаж</div>
        <div class="card" style="margin-top:6px"><h3>Доля продаж по размерам <span>● — размерное ядро {core}</span></h3>
          <div class="szbar" style="--accent:{P_SIZE[0]};height:118px">{scols}</div>
          <div class="note" style="margin-top:8px"><b>Размерное ядро — {core}.</b> На него приходится основная масса заказов; крайние размеры (XXS/XS и 4XL+) идут хуже и чаще лежат в остатке — заводить малыми партиями. Базовую матрицу закупки строить вокруг {core}.</div>
        </div>
        <div class="foot"><span>Источник: MPStats API · поле «цвет» + разбивка продаж по размерам · {per['d1']}–{per['d2']}</span><span>Доли по продажам · размеры сведены к S–4XL+</span></div>"""
        return page('market', P_COLOR, inner, 'p4')

    # ---------- HIGH PRICE SEGMENT ----------
    def forecast():
        FC = D.get('forecast') or {}
        if not FC:
            return ''
        zlo, zhi = FC['zone']
        kc = KPI_COLORS
        kpis = ''.join([
            kpi(f'Объём зоны {nf(zlo)}–{nf(zhi)} ₽', f"{money_short(FC['revenue'])} <small>₽</small>", f"{nf(FC['n_sku'])} SKU · {nf(FC['sales'])} продаж за {per['days']} дн", True, kc[5]),
            kpi('Доля в выручке сегмента', f"{FC['share_rev']}%", "средний и выше-среднего — ядро денег ниши", True, kc[1]),
            kpi('Медианная цена зоны', f"{nf(FC['price_median'])} <small>₽</small>", f"коридор {nf(FC['price_p25'])}–{nf(FC['price_p75'])} ₽", False, kc[2]),
            kpi('Продаж на карточку', f"{nf(FC['card_sales_median'])}–{nf(FC['card_sales_p90'])} <small>шт</small>", f"медиана→p90 за {per['days']} дн среди активных", False, kc[0]),
        ])
        cols = ['#8a93a6', '#3B5BDB', '#0E9F6E']
        scn = ''.join(
            f'<div class="scnbox" style="--c:{cols[i]}"><div class="t">{s["name"]}</div>'
            f'<div class="n">{money_short(s["revenue_mo"])} <small>₽/мес</small></div>'
            f'<div class="u">{nf(s["units_mo"])} шт/мес · цена {nf(s["price"])} ₽</div>'
            f'<div class="d">{s["note"]}</div></div>'
            for i, s in enumerate(FC['scenarios']))
        # сравнение подсегментов: строки — сценарии, столбцы — Средний / Выше среднего
        subs = FC.get('subs', [])
        sc_names = ['Осторожный', 'Реалистичный', 'Амбициозный']
        subhdr = ''.join(f'<th>{x["name"]}<br><small style="font-weight:600;color:#9aa2b3">медиана {nf(x["price_median"])} ₽</small></th>' for x in subs)
        subrows = ''
        for i, nmv in enumerate(sc_names):
            cells = ''.join(f'<td><b>{nf(x["scenarios"][i]["units_mo"])}</b> шт → {money_short(x["scenarios"][i]["revenue_mo"])} ₽</td>' for x in subs)
            subrows += f'<tr><td style="text-align:left">{nmv}</td>{cells}</tr>'
        # контекст-полосы
        brows = ''
        for b in FC['context']:
            hl = ' class="hl"' if b['target'] else ''
            brows += (f'<tr{hl}><td>{b["name"]}<br><small style="color:#9aa2b3;font-weight:600">{b["range"]}</small></td>'
                      f'<td>{nf(b["sku"])}</td><td><b>{nf(b["sales"])}</b></td>'
                      f'<td>{money_short(b["revenue"])}</td><td>{nf(b["avg_card"])}</td></tr>')
        inner = f"""
        <div class="eyebrow">Средний и выше-среднего сегмент · прогноз продаж</div>
        <h1 style="font-size:22px;margin:4px 0 6px">Сколько можно продавать: средний и выше среднего</h1>
        <div class="chips"><span class="chip">Целевая зона {nf(zlo)}–{nf(zhi)} ₽</span><span class="chip">Прогноз — по фактическим продажам карточек зоны</span><span class="chip">Продажи 90д → в месяц</span></div>
        <div class="wide-kpis" style="grid-template-columns:repeat(4,1fr)">{kpis}</div>
        <div class="card" style="margin-top:12px"><h3>Прогноз для сильной карточки в целевой зоне <span>выручка/мес при цене ≈ {nf(FC['price_median'])} ₽</span></h3>
          <div class="scn">{scn}</div>
        </div>
        <div class="chartwrap" style="margin-top:12px">
          <div class="card"><h3>Прогноз по подсегментам <span>средний vs выше среднего · шт/мес → ₽/мес</span></h3>
            <table class="bandtbl"><tr><th style="text-align:left">Сценарий</th>{subhdr}</tr>{subrows}</table>
            <div class="note" style="margin-top:9px"><b>Средний</b> ({nf(subs[0]['price_median']) if subs else '—'} ₽) даёт бóльшую скорость продаж, <b>выше среднего</b> ({nf(subs[1]['price_median']) if len(subs)>1 else '—'} ₽) — выше чек при чуть меньшем спросе. Оптимум — карточки в верхней части зоны с сильным контентом.</div></div>
          <div class="card"><h3>Ёмкость по ценовым полосам <span>зелёным — целевая зона</span></h3>
            <table class="bandtbl"><tr><th>Полоса</th><th>SKU</th><th>Прод. 90д</th><th>Выручка</th><th>Ср/карт</th></tr>{brows}</table>
            <div class="note" style="margin-top:9px"><b>Средний (1 700–2 500 ₽)</b> — лучшая скорость (ср. продаж на карточку максимальна). Ниже 1 700 ₽ — демпинг с низкой маржой; выше 3 500 ₽ спрос быстро тает.</div></div>
        </div>
        <div class="foot"><span>Источник: MPStats API · сегмент, цена {nf(zlo)}–{nf(zhi)} ₽ · {per['d1']}–{per['d2']}</span><span>Прогноз: осторожный=медиана / реалистичный=p75 / амбициозный=p90 продаж карточек зоны · оценочно</span></div>"""
        return page('market', P_HIGH, inner, 'p2')

    pages = [cover(), forecast(), top20(), combo()]
    return ("<!doctype html><html><head><meta charset='utf-8'><style>@page{size:A4;margin:0}"
            + T.CSS + MARKET_CSS + "</style></head><body>" + "\n".join(pages) + "</body></html>")


def MK_path(D): return D['category']

def size_core(D):
    """Ядро размеров = минимальный набор подряд идущих размеров, дающий ≥55% продаж."""
    sz = D.get('sizes') or []
    if not sz: return '—'
    best = None
    for i in range(len(sz)):
        cum = 0
        for j in range(i, len(sz)):
            cum += sz[j][2]
            if cum >= 55:
                span = (i, j, cum, j - i)
                if best is None or span[3] < best[3]:
                    best = span
                break
    if not best: return sz[0][0]
    i, j, cum, _ = best
    return f"{sz[i][0]}–{sz[j][0]}"


def main(argv):
    data = 'market_data.json'; html_out = None; pdf_out = None
    i = 0
    while i < len(argv):
        if argv[i] == '--html': html_out = argv[i+1]; i += 2
        elif argv[i] == '--pdf': pdf_out = argv[i+1]; i += 2
        else: data = argv[i]; i += 1
    D = json.load(open(data, encoding='utf-8'))
    html = build_html(D)
    html_out = html_out or 'reports-output/market.html'
    os.makedirs(os.path.dirname(html_out) or '.', exist_ok=True)
    open(html_out, 'w', encoding='utf-8').write(html)
    print('HTML →', html_out)
    if pdf_out and T.render_pdf(html_out, pdf_out):
        print('PDF  →', pdf_out)


if __name__ == '__main__':
    main(sys.argv[1:])
