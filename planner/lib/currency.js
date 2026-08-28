// currency.js — курсы валют для отчётов (ткань в $, оплата в сомах/рублях).
// ОСНОВНОЙ источник — обменные бюро Бишкека (valuta.kg), курс ПРОДАЖИ: по нему мы ПОКУПАЕМ
// доллары/рубли, чтобы оплатить ткань, — это реальная закупочная стоимость валюты.
// Если обменник недоступен — ОТКАТ на официальный курс НБ КР (nbkr.kg), чтобы отчёты не остались без курса.

const VALUTA_URL = 'https://valuta.kg/';
const NBKR_URL = 'https://www.nbkr.kg/XML/daily.xml';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) planner/1.0';

// ── обменники Бишкека (valuta.kg), лучший курс ПРОДАЖИ ──
// На странице лучшие курсы вынесены в ссылки вида rates/sell/usd/87-80 (87.80) и rates/sell/rub/1-005 (1.005).
async function fetchExchangeOffice() {
  const res = await fetch(VALUTA_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('valuta.kg HTTP ' + res.status);
  const html = await res.text();
  // курс ПРОДАЖИ обменника: rates/sell/<iso>/<целое>-<дробь> → «87-80» = 87.80, «1-005» = 1.005
  const sellRate = (iso, lo, hi) => {
    const m = new RegExp('rates/sell/' + iso + '/(\\d+)-(\\d+)').exec(html);
    if (!m) return null;
    const v = parseFloat(m[1] + '.' + m[2]);
    return (Number.isFinite(v) && v >= lo && v <= hi) ? v : null;
  };
  const usdKgs = sellRate('usd', 40, 200); // сом за 1 $ (продажа)
  const rubKgs = sellRate('rub', 0.3, 5);  // сом за 1 ₽ (продажа)
  if (!usdKgs || !rubKgs) throw new Error('не удалось разобрать курс продажи USD/RUB с valuta.kg');
  return {
    usdKgs, rubKgs,
    usdRub: usdKgs / rubKgs, kgsUsd: 1 / usdKgs, rubUsd: rubKgs / usdKgs,
    source: 'Обменники Бишкека (valuta.kg · продажа)',
    rateDate: new Date().toISOString().slice(0, 10), // курс обменников — на сегодня
    fetchedAt: new Date().toISOString(),
  };
}

// ── официальный курс НБ КР (fallback) ──
async function fetchOfficial() {
  const res = await fetch(NBKR_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('НБ КР недоступен (HTTP ' + res.status + ')');
  const xml = await res.text(); // ISO-коды и числа — ASCII, кириллица названий не нужна
  const kgsPer = (iso) => {
    const m = new RegExp('ISOCode="' + iso + '"[\\s\\S]*?<Nominal>\\s*(\\d+)\\s*</Nominal>[\\s\\S]*?<Value>\\s*([\\d.,\\s]+?)\\s*</Value>').exec(xml);
    if (!m) return null;
    const nominal = parseInt(m[1], 10) || 1;
    const value = parseFloat(String(m[2]).replace(/\s/g, '').replace(',', '.'));
    return (Number.isFinite(value) && value > 0) ? value / nominal : null;
  };
  const usdKgs = kgsPer('USD');
  const rubKgs = kgsPer('RUB');
  if (!usdKgs || !rubKgs) throw new Error('не удалось разобрать курсы USD/RUB из ответа НБ КР');
  const dm = /Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  const rateDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : '';
  return {
    usdKgs, rubKgs,
    usdRub: usdKgs / rubKgs, kgsUsd: 1 / usdKgs, rubUsd: rubKgs / usdKgs,
    source: 'НБ КР (nbkr.kg · официальный)',
    rateDate, fetchedAt: new Date().toISOString(),
  };
}

// Основная точка: сперва обменники (продажа), при неудаче — официальный НБ КР.
export async function fetchRates() {
  try {
    return await fetchExchangeOffice();
  } catch (e) {
    const off = await fetchOfficial(); // fallback
    off.source += ' — обменник недоступен: ' + String(e && e.message || e).slice(0, 60);
    return off;
  }
}
