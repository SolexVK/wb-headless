#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run.py — единая точка входа аналитической системы wb_analytics.

Читает конфиг ниши/продавца (JSON), собирает данные из MPStats (analyze.py) и
рендерит единый PDF-отчёт (render.py). Один и тот же шаблон подходит под любой
тип товара / нишу — всё описывается конфигом (см. configs/*.example.json).

    # полный цикл: собрать из MPStats и сверстать PDF
    MPSTATS_TOKEN=xxx python3 wb_analytics/run.py configs/my.json \
        --data out/data.json --pdf out/report.pdf

    # только вёрстка из готового data.json (без обращения к сети)
    python3 wb_analytics/run.py configs/my.json --from-data out/data.json --pdf out/report.pdf

Требуется MPSTATS_TOKEN (для сбора) и Chromium (для PDF; путь из $CHROME или
автопоиск). Конфиг задаёт: category, niche_name, targets[], seller{id,name},
comparable[], sections[], period, segment_name и пр.
"""
import json, os, sys, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A
import render as R


def _derive(path, ext):
    base = os.path.splitext(os.path.basename(path))[0]
    return os.path.join('reports-output', base + ext)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Единый анализ WB × MPStats → PDF по конфигу')
    ap.add_argument('config', help='JSON-конфиг ниши/продавца (см. configs/*.example.json)')
    ap.add_argument('--data', help='куда сохранить собранный отчёт JSON (по умолчанию reports-output/<config>.json)')
    ap.add_argument('--from-data', help='взять готовый отчёт JSON и не обращаться к сети (только вёрстка)')
    ap.add_argument('--html', help='путь для HTML (по умолчанию reports-output/<config>.html)')
    ap.add_argument('--pdf', help='путь для PDF (иначе PDF не собирается)')
    a = ap.parse_args(argv)

    cfg = json.load(open(a.config, encoding='utf-8'))
    data_out = a.data or _derive(a.config, '.json')
    html_out = a.html or _derive(a.config, '.html')

    if a.from_data:
        D = json.load(open(a.from_data, encoding='utf-8'))
        print('данные из', a.from_data)
    else:
        D = A.analyze(cfg)
        os.makedirs(os.path.dirname(data_out) or '.', exist_ok=True)
        json.dump(D, open(data_out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('данные →', data_out,
              f"· рынок {D['meta']['market_total']:,} ₽ · продавец {D['seller_agg']['sales']} продаж"
              f" · центр. хабов {D['warehouses']['seller']['central_n']}".replace(',', ' '))

    R.render(D, html_out, a.pdf, cfg)


if __name__ == '__main__':
    main()
