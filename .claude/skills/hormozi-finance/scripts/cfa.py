#!/usr/bin/env python3
"""
Hormozi unit-economics calculator: CAC, LTGP, Payback Period, LTGP:CAC, CFA level.

Реализует метрики из "$100M Money Models" и "$100M Lost" (Section B):
  CAC  = ad_spend / new_customers
  LTGP = gross_profit_per_purchase * transactions        (one-off / physical)
       = monthly_gp / churn                               (recurring)
  PPD  = months until cumulative GP >= CAC
  CFA level: L1 (30dGP < CAC), L2 (30dGP == CAC), L3 (30dGP > 2*CAC)

Примеры:
  python3 cfa.py --ad-spend 4000 --new-customers 8 --avg-sale 600 \
      --gross-margin 0.8 --transactions 5 --first30-gp 480
  python3 cfa.py --ad-spend 4000 --new-customers 8 --monthly-gp 90 \
      --churn 0.1 --first30-gp 90
"""
import argparse
import sys


def money(x):
    return f"${x:,.2f}"


def main():
    p = argparse.ArgumentParser(description="Hormozi CAC/LTGP/PPD/CFA calculator")
    p.add_argument("--ad-spend", type=float, required=True,
                   help="Полные расходы на привлечение за период")
    p.add_argument("--new-customers", type=float, required=True,
                   help="Число новых клиентов за период")
    # gross profit per purchase: give either explicit gp, or avg-sale * gross-margin
    p.add_argument("--avg-sale", type=float, help="Средний чек одной покупки")
    p.add_argument("--gross-margin", type=float,
                   help="Валовая маржа, доля 0..1 (напр. 0.8)")
    p.add_argument("--gp-per-purchase", type=float,
                   help="Валовая прибыль с одной покупки (вместо avg-sale*margin)")
    # lifetime: either transactions (one-off) OR churn (+monthly-gp) for recurring
    p.add_argument("--transactions", type=float,
                   help="Среднее число покупок за жизнь клиента (one-off/physical)")
    p.add_argument("--monthly-gp", type=float,
                   help="Валовая прибыль в месяц (recurring)")
    p.add_argument("--churn", type=float,
                   help="Месячный churn, доля 0..1 (recurring)")
    p.add_argument("--first30-gp", type=float,
                   help="Валовая прибыль с клиента за первые 30 дней (для CFA)")
    args = p.parse_args()

    if args.new_customers <= 0:
        sys.exit("new-customers должно быть > 0")

    # CAC
    cac = args.ad_spend / args.new_customers

    # GP per purchase
    if args.gp_per_purchase is not None:
        gp_purchase = args.gp_per_purchase
    elif args.avg_sale is not None and args.gross_margin is not None:
        gp_purchase = args.avg_sale * args.gross_margin
    elif args.monthly_gp is not None:
        gp_purchase = args.monthly_gp
    else:
        sys.exit("Дай --gp-per-purchase, либо --avg-sale+--gross-margin, либо --monthly-gp")

    # LTGP
    recurring = args.churn is not None
    if recurring:
        if args.churn <= 0:
            sys.exit("churn должен быть > 0 для recurring")
        monthly_gp = args.monthly_gp if args.monthly_gp is not None else gp_purchase
        ltgp = monthly_gp / args.churn
        avg_lifetime_months = 1.0 / args.churn
    else:
        if args.transactions is None:
            sys.exit("Для one-off дай --transactions (или --churn для recurring)")
        ltgp = gp_purchase * args.transactions
        avg_lifetime_months = None

    ratio = ltgp / cac if cac else float("inf")

    # Payback period (months) — грубая помесячная модель
    if recurring:
        per_month = args.monthly_gp if args.monthly_gp is not None else gp_purchase
    else:
        # распределяем транзакции ~1/месяц как приближение
        per_month = gp_purchase
    ppd_months = None
    if per_month > 0:
        cum, m = 0.0, 0
        while cum < cac and m < 600:
            m += 1
            cum += per_month
        ppd_months = m

    # CFA level
    cfa = None
    if args.first30_gp is not None:
        g = args.first30_gp
        if g > 2 * cac:
            cfa = ("Level 3", "🟢 клиенты финансируют привлечение следующих (цель)")
        elif g >= cac:
            cfa = ("Level 2", "🟡 30д-прибыль ~= CAC (кредитка = бюджет)")
        else:
            cfa = ("Level 1", "🔴 финансируешь привлечение из кармана (риск)")

    print("=" * 46)
    print("  HORMOZI UNIT ECONOMICS")
    print("=" * 46)
    print(f"  CAC (стоимость привлечения) : {money(cac)}")
    print(f"  GP с покупки                : {money(gp_purchase)}")
    if recurring:
        print(f"  Модель                      : recurring (churn {args.churn:.0%}"
              f", ~{avg_lifetime_months:.1f} мес жизни)")
    else:
        print(f"  Модель                      : one-off ({args.transactions:g} покупок)")
    print(f"  LTGP (ценность за жизнь)     : {money(ltgp)}")
    print("-" * 46)
    verdict = "✅ здорово" if ratio >= 3 else "⚠️ ниже нормы (цель ≥ 3:1)"
    print(f"  LTGP : CAC                  : {ratio:.2f} : 1   {verdict}")
    if ppd_months is not None:
        print(f"  Payback Period              : ~{ppd_months} мес")
    if cfa:
        print(f"  CFA {cfa[0]:<8}                : {cfa[1]}")
    print("=" * 46)
    # подсказка куда копать
    if ratio < 3:
        print("  ▸ Подними LTGP (hormozi-offers/-money-models) или")
        print("    снизь CAC (hormozi-leads).")
    if cfa and cfa[0] != "Level 3":
        print("  ▸ Цель — CFA Level 3: добавь up-front-cash оффер")
        print("    (hormozi-money-models), чтобы 30д-GP > 2×CAC.")


if __name__ == "__main__":
    main()
