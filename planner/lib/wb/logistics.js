// logistics.js — расчёт логистики и хранения ВБ из объёма упаковки и тарифа склада.
//
//  ВАЖНО: в ответе WB tariffs/box поля deliveryBase/deliveryLiter/storageBase/
//  storageLiter УЖЕ включают коэффициент склада (проверено: Коледино base =
//  общий base × coef). Поэтому coefExpr — справочный, второй раз НЕ умножаем.
//
//  Прямая логистика (за заказ) = (deliveryBase + deliveryLiter·max(0,V−1)) · КТР
//  Хранение (за период)        = (storageBase + storageLiter·max(0,V−1)) · дни
//  Обратная логистика          = фикс (по умолчанию 50 ₽ за возврат)
//  «На 1 выкуп» сводит уже юнит-калькулятор: (прямая + обратная·(1−выкуп))/выкуп.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {number} volumeL   объём упаковки, литры
 * @param {object} wh        тариф склада {deliveryBase, deliveryLiter, deliveryCoef, storageBase, storageLiter, storageCoef}
 * @param {object} [opts]    {ktr=1, storageDays=60, returnLogistics=50}
 * @returns {{deliveryPerOrder, storagePerDay, storageTotal, returnLogistics, volumeL, extraLitres}}
 */
export function computeWbLogistics(volumeL, wh, opts = {}) {
  const V = Math.max(0, Number(volumeL) || 0);
  const ktr = opts.ktr != null ? Number(opts.ktr) : 1;
  const days = opts.storageDays != null ? Number(opts.storageDays) : 60;
  const returnLogistics = opts.returnLogistics != null ? Number(opts.returnLogistics) : 50;
  if (!wh || V <= 0) {
    return { deliveryPerOrder: null, storagePerDay: null, storageTotal: null, returnLogistics, volumeL: V, extraLitres: 0 };
  }
  const extra = Math.max(0, V - 1); // литры сверх первого
  // base уже с коэффициентом склада — умножаем только на КТР (по умолчанию 1).
  const deliveryPerOrder = round2(((wh.deliveryBase || 0) + (wh.deliveryLiter || 0) * extra) * ktr);
  const storagePerDay = round2((wh.storageBase || 0) + (wh.storageLiter || 0) * extra);
  const storageTotal = round2(storagePerDay * days);
  return {
    deliveryPerOrder, storagePerDay, storageTotal, returnLogistics, volumeL: V, extraLitres: round2(extra),
    deliveryCoef: wh.deliveryCoef, storageCoef: wh.storageCoef, // справочно (уже учтены в base)
  };
}
