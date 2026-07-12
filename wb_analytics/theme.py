#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
theme.py — общий слой оформления единой аналитической системы wb_analytics:
    · хелперы форматирования чисел/денег и кликабельных ссылок WB;
    · справочник складов (reference/wb_warehouses.json → wh_label);
    · весь CSS отчёта (акценты разведены по страницам CSS-переменными
      --accent/--accent2/--tint/--soft, поэтому весь отчёт — один HTML-документ);
    · поиск Chromium и рендер HTML→PDF (--print-to-pdf, без внешних утилит склейки).

Модуль не зависит от конкретной ниши/типа товара — используется всеми секциями
рендера (см. render.py). Данные готовит analyze.py, оркестрация — run.py.
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

# Справочник складов WB грузим из wb_warehouses.json (официальные названия из
# stores-data.json). Раньше здесь был хардкод с ошибками (130744≠Тула это Краснодар,
# 206348≠СПб это Алексин) — не возвращаем.
def _load_wh_names():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reference', 'wb_warehouses.json')
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return {}
WH_NAMES = _load_wh_names()
def wh_label(wid):
    n = WH_NAMES.get(str(wid))
    return n.replace(' WB', '') if n else f'СЦ · {wid}'

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

