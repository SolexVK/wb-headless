---
name: hormozi-money-models
description: >-
  Проектирование денежной модели по «$100M Money Models» Хормози:
  последовательность офферов (Attraction→Upsell→Downsell→Continuity), 12+ готовых
  плей, 3 стадии (Get Cash→More→Most), offer stacking и Value Grid, окупаемость
  привлечения за 30 дней (Client-Financed Acquisition). Use to design an offer
  sequence, add upsells/downsells/continuity, increase 30-day profit per
  customer, turn "no" into "yes", or make advertising pay for itself fast.
  Триггеры: «апселл», «даунселл», «continuity», «подписка», «воронка офферов»,
  «последовательность продаж», «мало прибыли с клиента», «what to offer next»,
  «окупить рекламу», «rinse and repeat», «повысить средний чек», «offer stacking».
---

# Hormozi Money Models — последовательность офферов

Помогаешь собрать **Money Model** — продуманную последовательность офферов, чтобы заработать максимум быстро. Минимум: прибыль с клиента за **30 дней** > стоимости его привлечения+обслуживания. Цель: с *одного* клиента окупить привлечение *нескольких* (Client-Financed Acquisition).

> Язык: RU-инструкции, EN-термины. Глубокий референс — `hormozi/books/02-100m-money-models.md` (+ Value Grid/новые плеи в `04-100m-lost.md`).
> Считать деньги → `hormozi-finance`. Само содержимое офферов → `hormozi-offers`.

## 3 стадии (собирай по одной за раз!)

- **Stage I — Get Cash:** Attraction Offers (больше клиентов дешевле).
- **Stage II — Get More Cash:** Upsell + Downsell (больше денег с них быстрее).
- **Stage III — Get The Most Cash:** Continuity (максимум суммарных трат).

⚠️ Нельзя внедрять всю модель сразу — «сломает бизнес». Один оффер → надёжно → автоматически → следующая стадия. Мерь кварталами.

## 4 типа офферов — библиотека плей

### Attraction (превратить незнакомцев в клиентов; free/discount)
1. **Win Your Money Back** — верни цель/действия → верни деньги (лучше store credit; критерии: легко трекать / ведёт к результату / рекламирует бизнес).
2. **Giveaways** — розыгрыш за контакты; проигравшим — приз со скидкой.
3. **Decoy** — free/discount + премиум рядом.
4. **Buy X Get Y Free** — бесплатное за покупку платного (удлиняет жизнь клиента).
5. **Pay Less Now or Pay More Later** — дисконт+бонусы сейчас vs полная цена потом.

### Upsell (что предложить следующим; макс. 30-дн прибыль)
1. **Classic Upsell** — следующая проблема, «You can't have X without Y».
2. **Menu Upsell** — «тебе не нужно это, нужно вот это».
3. **Anchor Upsell** — сначала самое дорогое, потом дешевле-но-приемлемое.
4. **Rollover Upsell** — зачесть прошлую оплату в следующий оффер.

### Downsell (превратить «нет» в «да»)
1. **Payment Plan** — та же цена, платят по частям («seesaw»: гигантские или крошечные платежи?).
2. **Trial With Penalty** — бесплатно, пока выполняешь условия; иначе платишь.
3. **Feature Downsell** — ниже цена через *меньше фич* (убирай от высшей ценности к низшей). **Никогда не торгуйся по цене за то же** («не веду переговоры с террористами»). После каждого — «Fair enough?».

### Continuity (рекуррентные платежи)
1. **Continuity Bonus** — бонус за подписку сегодня (> первого платежа).
2. **Continuity Discount** — бесплатное время за подписку.
3. **Waived Fee** — startup-fee (3-5× мес.), списывается за долгосрочное обязательство.

**Новые плеи (из Lost):** Free Presentations · Freemium · Free Pick Your Price · Free With Alternate Revenue Stream · Lifetime Upgrades/Discounts · Discount + One-Time Fee.

## Собрать свою модель (4 шага)
1. **Attraction Offer** — превратить незнакомцев в клиентов, покрыть затраты.
2. **Upsell** — 30-дн прибыль сильно выше CAC (реши проблему, созданную attraction-оффером).
3. **Downsell** — «нет» → «да» (чередуй payment-plan ↔ feature).
4. **Continuity** — последняя продажа + рекуррент.

## Offer Stacking + Value Grid (из Lost — «arms race»)

**Backend informs frontend:** выше LTGP → больше можешь тратить на CAC → «выморить» конкурентов. Последовательность стека: **Attract → Up Front Cash → Upsell/Downsell → Continuity** (можно повторять). Каждый оффер — свой GSO. Считай **30D Cash** по Value Grid (клиенты покупают нелинейно — сетка, не лестница).

## Правила
- **Perfect one offer at a time.** Не всё сразу.
- **Raise price in stages** — стартуй дёшево (много «да» + фидбэк), поднимай, пока рост «нет» не съест прирост кэша.
- **Simple Scales. Fancy Fails.** Не 100 продуктов, а **100 способов предложить один**.
- **Affiliate products** заполняют дыры без операционного гемора.
- **Mix and match** — правил нет; один оффер может быть attraction+upsell+continuity сразу.
- Просят возврат — верни. Жёсткие продажи — для слабых продуктов.

## Чек-лист
- [ ] Есть Attraction Offer (окупает CAC ≤30 дней)?
- [ ] Есть Upsell (что предложить следующим)?
- [ ] Есть Downsell (payment-plan / trial / feature)?
- [ ] Есть Continuity (рекуррент)?
- [ ] Прибыль с 1 клиента за 30 дней ≥ CAC*2? → проверь в `hormozi-finance`.

## Дальше
- Посчитать окупаемость/CFA-уровень → `hormozi-finance`.
- Усилить сам оффер (гарантии/бонусы) → `hormozi-offers`.
- Пригнать трафик под модель → `hormozi-leads`.
