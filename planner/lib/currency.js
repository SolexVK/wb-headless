// currency.js — актуальные официальные курсы валют (источник: Нацбанк Кыргызстана, nbkr.kg).
// Нужны курсы для отчётов (ткань в $, оплата в сомах/рублях):
//   • сом ↔ доллар  • рубль ↔ сом  • рубль ↔ доллар
// NBKR daily.xml отдаёт стоимость 1 (или Nominal) единицы валюты в СОМАХ. Отсюда выводим все пары.

const NBKR_URL = 'https://www.nbkr.kg/XML/daily.xml';

export async function fetchRates() {
  const res = await fetch(NBKR_URL, { headers: { 'User-Agent': 'planner/1.0' } });
  if (!res.ok) throw new Error('НБ КР недоступен (HTTP ' + res.status + ')');
  const xml = await res.text(); // ISO-коды и числа — ASCII, кириллица названий не нужна
  // KGS за 1 единицу валюты iso (Value/Nominal), десятичная запятая → точка
  const kgsPer = (iso) => {
    const m = new RegExp('ISOCode="' + iso + '"[\\s\\S]*?<Nominal>\\s*(\\d+)\\s*</Nominal>[\\s\\S]*?<Value>\\s*([\\d.,\\s]+?)\\s*</Value>').exec(xml);
    if (!m) return null;
    const nominal = parseInt(m[1], 10) || 1;
    const value = parseFloat(String(m[2]).replace(/\s/g, '').replace(',', '.'));
    return (Number.isFinite(value) && value > 0) ? value / nominal : null;
  };
  const usdKgs = kgsPer('USD'); // сом за 1 $
  const rubKgs = kgsPer('RUB'); // сом за 1 ₽
  if (!usdKgs || !rubKgs) throw new Error('не удалось разобрать курсы USD/RUB из ответа НБ КР');
  // дата курса из атрибута Date="DD.MM.YYYY" (если есть)
  const dm = /Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  const rateDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : '';
  return {
    usdKgs,                    // сом за 1 доллар
    rubKgs,                    // сом за 1 рубль
    usdRub: usdKgs / rubKgs,   // рублей за 1 доллар
    kgsUsd: 1 / usdKgs,        // долларов за 1 сом
    rubUsd: rubKgs / usdKgs,   // долларов за 1 рубль
    source: 'НБ КР (nbkr.kg)',
    rateDate,                  // дата официального курса
    fetchedAt: new Date().toISOString(),
  };
}
