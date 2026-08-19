#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
market.py — рыночный (нишевый) отчёт системы wb_analytics: анализ рынка/сегмента
БЕЗ конкретного продавца. Страницы:
    1. Сводка рынка/сегмента (объём, цены, концентрация, игроки, выводы)
    2. ТОП-20 карточек — таблица с фото (в HTML фото увеличивается ×3 по наведению
       модальным окном), кликабельный артикул → карточка WB, бренд, метрики
    3. Цвета — доля расцветок в продажах (семейства + точные цвета)
    4. Размеры — распределение продаж по размерному ряду

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

P_COVER = ['#1F3A5F', '#12263F', '#E7EDF5', '#F4F7FB']
P_TOP   = ['#0E7C86', '#0A5A62', '#E2F3F4', '#F1FAFB']
P_COLOR = ['#7C3AED', '#5B21B6', '#EFE9FB', '#F8F5FE']
P_SIZE  = ['#C7891B', '#9A6A10', '#FBF2DF', '#FDF9F0']

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
.szbar { display:flex; align-items:flex-end; gap:8px; height:150px; margin:14px 0 4px; padding:0 4px; }
.szcol { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; }
.szfill { width:100%; border-radius:6px 6px 0 0; background:var(--accent); min-height:3px; position:relative; }
.szpc { font-size:9.5px; font-weight:800; color:#141a26; margin-bottom:3px; }
.szlb { font-size:9.5px; font-weight:700; color:#3a445a; margin-top:5px; }
.szsub { font-size:8px; color:#9aa2b3; }
.note { background:var(--soft); border-radius:9px; padding:11px 13px; font-size:10px; color:#33405a; line-height:1.5; }
.note b { color:var(--accent2); }
"""


def page(cls, pal, inner, anchor=''):
    v = f"--accent:{pal[0]};--accent2:{pal[1]};--tint:{pal[2]};--soft:{pal[3]}"
    return f'<div class="page {cls}" id="{anchor}" style="{v}"><div class="accbar"></div>{inner}</div>'
def kpi(lbl, val, sub, hero=False):
    return f'<div class="kpi{" hero" if hero else ""}"><div class="lbl">{lbl}</div><div class="val">{val}</div><div class="sub">{sub}</div></div>'


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
        s = SEG
        kpis = ''.join([
            kpi('Объём рынка (вся категория)', f"{money_short(MK['revenue'])} <small>₽</small>", f"{nf(MK['n_sku'])} SKU · {nf(MK['sales'])} продаж за {per['days']} дн", True),
            kpi('Объём сегмента', f"{money_short(s['revenue'])} <small>₽</small>", f"{nf(s['n_sku'])} SKU · {nf(s['sales'])} продаж · {s['share_rev']}% рынка", True),
            kpi('Медианная цена', f"{nf(s['price_median'])} <small>₽</small>", f"коридор {nf(s['p25'])}–{nf(s['p75'])} ₽ (p25–p75)"),
            kpi('Концентрация ТОП-100', f"{s['top100']}%", f"ТОП-10 {s['top10']}% · ТОП-50 {s['top50']}% выручки", ),
            kpi('Игроки', f"{nf(s['n_brands'])} <small>брендов</small>", f"{nf(s['n_sellers'])} продавцов — рынок раздроблен"),
            kpi('Ценовой размах', f"{nf(s['p10'])}–{nf(s['p90'])} <small>₽</small>", "p10–p90 активных карточек"),
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
          <li><b>Рабочий ценовой коридор — {nf(s['p25'])}–{nf(s['p75'])} ₽</b> (медиана {nf(s['price_median'])} ₽). Массовый спрос — средний ценовой сегмент, не премиум.</li>
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
            rows += (f'<tr><td class="rk">{i+1}</td><td class="ph">{ph}</td>'
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
        return page('market', P_TOP, inner, 'p2')

    # ---------- COLORS ----------
    def colors():
        fams = D['colors_family']
        legend = ''.join(
            f'<div class="lgrow"><span class="lgsw" style="background:{FAM_COLORS.get(n,"#ccc")}"></span>'
            f'<span class="lgnm">{n}</span><span class="lgpc">{p:.0f}%</span></div>' for n, _, p in fams)
        mxc = max([p for _, _, p in D['colors_top']] + [1])
        cbars = ''.join(
            f'<div class="hbar"><span class="hbl">{c}</span><div class="hbt"><div class="hbf" style="width:{max(4,p/mxc*100):.0f}%;background:{P_COLOR[0]}">{p:.1f}%</div></div></div>'
            for c, n, p in D['colors_top'][:10])
        top = fams[0]
        inner = f"""
        <div class="eyebrow">Структура продаж · цвета</div>
        <h1 style="font-size:21px;margin:4px 0 6px">Какие расцветки покупают</h1>
        <div class="chips"><span class="chip">Выборка {nf(D['colors_sample'])} SKU сегмента</span><span class="chip">Доли взвешены по продажам</span></div>
        <div class="chartwrap">
          <div class="card"><h3>Семейства цветов <span>доля в продажах</span></h3>
            <div style="display:flex;gap:16px;align-items:center;margin-top:6px">
              <div style="flex:0 0 auto">{donut_svg(fams)}</div>
              <div class="donut-legend" style="flex:1">{legend}</div>
            </div>
          </div>
          <div class="card"><h3>ТОП-10 точных цветов <span>% продаж сегмента</span></h3>{cbars}</div>
        </div>
        <div class="note" style="margin-top:14px"><b>Вывод.</b> Ядро ассортимента — базовые светлые тона: <b>{top[0].lower()} ({top[2]:.0f}%)</b> плюс синяя гамма. Тёмные и цветные — нишевые. Для входа приоритет — белый и голубой/синий однотон; яркие цвета держать точечно под спрос.</div>
        <div class="foot"><span>Источник: MPStats API · поле «цвет» карточек · {per['d1']}–{per['d2']}</span><span>Доли — сумма продаж по цвету / все продажи сегмента</span></div>"""
        return page('market', P_COLOR, inner, 'p3')

    # ---------- SIZES ----------
    def sizes():
        sz = D['sizes']; mx = max([p for _, _, p in sz] + [1])
        cols = ''.join(
            f'<div class="szcol"><div class="szpc">{p:.0f}%</div>'
            f'<div class="szfill" style="height:{max(3,p/mx*100):.0f}%"></div>'
            f'<div class="szlb">{b}</div></div>' for b, s, p in sz)
        # таблица деталей
        trows = ''.join(f'<tr><td style="text-align:left;font-weight:700">{b}</td><td class="num">{p:.1f}%</td><td class="num">{nf(s)}</td></tr>' for b, s, p in sz)
        core = size_core(D)
        inner = f"""
        <div class="eyebrow">Структура продаж · размерный ряд</div>
        <h1 style="font-size:21px;margin:4px 0 6px">Как продаются размеры</h1>
        <div class="chips"><span class="chip">Выборка {nf(D['sizes_sample'])} карточек ТОП по выручке</span><span class="chip">{nf(D['sizes_total'])} продаж по размерам</span><span class="chip">размеры сведены к S–4XL+</span></div>
        <div class="card" style="margin-top:12px"><h3>Распределение продаж по размерам <span>доля продаж, %</span></h3>
          <div class="szbar" style="--accent:{P_SIZE[0]}">{cols}</div>
        </div>
        <div class="chartwrap">
          <div class="card"><h3>Детали по размерам <span>доля и штуки</span></h3>
            <table class="lt"><tr><th style="text-align:left">Размер</th><th>Доля продаж</th><th>Штук</th></tr>{trows}</table></div>
          <div class="card"><h3>Вывод</h3>
            <div class="note"><b>Размерное ядро — {core}.</b> На него приходится основная масса заказов. Крайние размеры (XXS/XS и 4XL+) продаются заметно хуже и чаще лежат в остатках — заводить их малыми партиями. Базовую матрицу закупки строить вокруг {core}, обеспечивая по ним стабильное наличие.</div></div>
        </div>
        <div class="foot"><span>Источник: MPStats API · разбивка продаж по размерам карточек · {per['d1']}–{per['d2']}</span><span>Размерные сетки нормализованы к единой лестнице S–4XL+</span></div>"""
        return page('market', P_SIZE, inner, 'p4')

    pages = [cover(), top20(), colors(), sizes()]
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
