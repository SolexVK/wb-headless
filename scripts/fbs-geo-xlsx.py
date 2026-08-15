# scripts/fbs-geo-xlsx.py — Excel по «Географии продаж и возвратов» FBS.
# Вход:  <REPORTS_OUTPUT_DIR>/fbs-geo-service.json (снимок сервиса)
# Выход: <REPORTS_OUTPUT_DIR>/fbs-geo.xlsx
# Листы: «Вся РФ — регионы», «Вся РФ — округа», «Моск. FF — регионы».
import os
import json
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.abspath(os.environ['REPORTS_OUTPUT_DIR']) if os.environ.get('REPORTS_OUTPUT_DIR') else os.path.join(REPO, 'reports-output')
SNAP = os.path.join(OUT_DIR, 'fbs-geo-service.json')
OUT = os.path.join(OUT_DIR, 'fbs-geo.xlsx')

with open(SNAP, encoding='utf-8') as f:
    s = json.load(f)

bold = Font(bold=True, color='FFFFFF')
HEAD = PatternFill('solid', fgColor='1B965A')
center = Alignment(horizontal='center', vertical='center', wrap_text=True)


def autofit(ws):
    for col in ws.columns:
        width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
        ws.column_dimensions[col[0].column_letter].width = min(42, max(9, width + 2))


def sheet(ws, rows, with_okrug):
    head = (['Округ'] if with_okrug else []) + ['Регион' if with_okrug else 'Округ', 'Продано', 'Возвращено', '% возврата', 'Сумма ₽']
    ws.append(head)
    for c in ws[1]:
        c.font = bold
        c.fill = HEAD
        c.alignment = center
    for r in rows:
        name = r.get('region') or r.get('okrug') or '—'
        row = ([r.get('okrug', '')] if with_okrug else []) + [name, r.get('salesCount', 0), r.get('returnCount', 0), r.get('returnPct', 0) / 100.0, round(r.get('salesRub', 0))]
        ws.append(row)
        rr = ws.max_row
        ws.cell(rr, ws.max_column - 1).number_format = '0.0%'
    ws.freeze_panes = 'A2'
    if ws.max_row > 1:
        last_col = ws.cell(1, ws.max_column).column_letter
        ws.auto_filter.ref = f'A1:{last_col}{ws.max_row}'
    autofit(ws)


wb = Workbook()
ws = wb.active
ws.title = 'Вся РФ — регионы'
sheet(ws, s.get('scopes', {}).get('all', {}).get('byRegion', []), True)
sheet(wb.create_sheet('Вся РФ — округа'), s.get('scopes', {}).get('all', {}).get('byOkrug', []), False)
sheet(wb.create_sheet('Моск. FF — регионы'), s.get('scopes', {}).get('moscow', {}).get('byRegion', []), True)

wb.save(OUT)
print('OK', OUT)
