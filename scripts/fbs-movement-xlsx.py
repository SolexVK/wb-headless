# scripts/fbs-movement-xlsx.py — Excel по «Движению заказов» FBS (для веб-сервиса).
# Вход:  <REPORTS_OUTPUT_DIR>/fbs-movement-service.json (снимок сервиса)
# Выход: <REPORTS_OUTPUT_DIR>/fbs-movement.xlsx
# Листы (за период отображения, последние N дней): Принято/Передано × шт/₽.
# День × фулфилмент, значения (не формулы), со столбцом «Итого».
import os
import json
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.abspath(os.environ['REPORTS_OUTPUT_DIR']) if os.environ.get('REPORTS_OUTPUT_DIR') else os.path.join(REPO, 'reports-output')
SNAP = os.path.join(OUT_DIR, 'fbs-movement-service.json')
OUT = os.path.join(OUT_DIR, 'fbs-movement.xlsx')

with open(SNAP, encoding='utf-8') as f:
    s = json.load(f)

bold = Font(bold=True)
center = Alignment(horizontal='center')
fulfillments = s.get('fulfillments', [])
N = int(s.get('days', 14))
series = s.get('series', [])[-N:]  # период отображения


def autofit(ws):
    for col in ws.columns:
        width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
        ws.column_dimensions[col[0].column_letter].width = min(40, max(9, width + 2))


def sheet(ws, kind, unit):
    ws.append(['Дата'] + list(fulfillments) + ['Итого'])
    for c in ws[1]:
        c.font = bold
        c.alignment = center
    for d in series:
        blk = d.get(kind, {}) or {}
        bf = blk.get('byFulfillment', {}) or {}
        row = [d.get('date')]
        total = 0
        for name in fulfillments:
            v = (bf.get(name, {}) or {}).get(unit, 0)
            row.append(v)
            total += v
        row.append(round(total, 2) if unit == 'money' else total)
        ws.append(row)
    autofit(ws)
    ws.freeze_panes = 'B2'


wb = Workbook()
ws = wb.active
ws.title = 'Принято (шт)'
sheet(ws, 'accepted', 'count')
sheet(wb.create_sheet('Передано (шт)'), 'delivered', 'count')
sheet(wb.create_sheet('Принято (руб)'), 'accepted', 'money')
sheet(wb.create_sheet('Передано (руб)'), 'delivered', 'money')

wb.save(OUT)
print('OK', OUT)
