// lib/wbBrandKeywordSales.js — «Анализ своих товаров по ключевым запросам».
//
// Что делает: по КАЖДОЙ ключевой фразе берёт поисковую выдачу WB (MPStats),
// оставляет карточки НАШИХ брендов → получает список наших nmId в этой нише.
// Затем по этим nmId тянет ФАКТИЧЕСКИЕ продажи из кабинета (WB Statistics) и
// считает за каждый период: выкуплено штук и на какую сумму (+ возвраты отдельно).
//
// Важно про «по запросу»: WB не атрибутирует органические продажи к конкретной
// поисковой фразе. Поэтому «по запросу» = перечень карточек наших брендов, которые
// WB показывает в выдаче по этой фразе (топ‑100 выдачи MPStats), с их фактическими
// продажами из кабинета. Это НЕ «сколько принёс запрос».
//
// Источники: lib/mpstats.js (выдача по фразе) + lib/wbSales.js (продажи, лимит 1/мин).
// Отчёт: formatHtml() → HTML, дальше lib/htmlToPdf.js рендерит PDF.

import { fetchSearchResults } from './mpstats.js';
import { pullSales } from './wbSales.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

// Матчер брендов: регистронезависимая подстрока по любому из имён.
function brandMatcher(brands) {
  const re = new RegExp(brands.map((b) => String(b).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).join('|'), 'i');
  return (b) => re.test(String(b || ''));
}

// Какому имени бренда из списка соответствует строка (для аккуратного вывода).
function brandLabel(raw, brands) {
  const low = String(raw || '').toLowerCase();
  return brands.find((b) => low.includes(String(b).toLowerCase())) || raw || null;
}

/**
 * Собирает наши nmId по каждой фразе из поисковой выдачи (объединяя окна периодов,
 * т.к. состав/ранжирование выдачи слегка меняются во времени).
 * @returns {Promise<Array<{phrase, nm: Map<number,string>}>>}  nm: nmId → бренд
 */
export async function resolveTargets({ brands, phrases, windows, log = () => {} }) {
  const isOur = brandMatcher(brands);
  const out = [];
  for (const phrase of phrases) {
    const nm = new Map();
    for (const w of windows) {
      const { rows } = await fetchSearchResults(phrase, { d1: w.d1, d2: w.d2 });
      for (const r of rows) if (isOur(r.brand)) nm.set(+r.id, brandLabel(r.brand, brands));
    }
    log(`  «${phrase}»: наших карточек ${nm.size}`);
    out.push({ phrase, nm });
  }
  return out;
}

const emptyAgg = () => ({ buyouts: 0, sum: 0, returns: 0, returnSum: 0 });
const isSale = (x) => String(x.saleID || '').startsWith('S');
const inDay = (date, from, to) => date >= `${from}T00:00:00` && date <= `${to}T23:59:59`;

// Агрегирует строки продаж по периодам. sumField: 'finishedPrice' | 'forPay'.
function aggregate(rows, periods, sumField) {
  const byPeriod = {};
  for (const p of periods) byPeriod[p.key] = emptyAgg();
  const perNm = new Map();
  for (const x of rows) {
    const val = Math.abs(num(x[sumField]));
    const sale = isSale(x);
    for (const p of periods) {
      if (!inDay(x.date, p.from, p.to)) continue;
      const bump = (o) => { if (sale) { o.buyouts++; o.sum += val; } else { o.returns++; o.returnSum += val; } };
      bump(byPeriod[p.key]);
      if (!perNm.has(x.nmId)) {
        const rec = { nmId: x.nmId, brand: x.brand, art: x.supplierArticle, subject: x.subject, byPeriod: {} };
        for (const q of periods) rec.byPeriod[q.key] = emptyAgg();
        perNm.set(x.nmId, rec);
      }
      bump(perNm.get(x.nmId).byPeriod[p.key]);
    }
  }
  const per = [...perNm.values()].sort((a, b) => (b.byPeriod[periods[0].key].sum) - (a.byPeriod[periods[0].key].sum));
  return { byPeriod, perNm: per };
}

/**
 * Полный анализ.
 * @param {object} p
 *   brands    ['AIDEMIKO','Aizek']  — наши бренды (обязательно)
 *   phrases   ['рубашка муслиновая женская', ...]  — ключевые фразы (обязательно)
 *   periods   [{key,label,from,to}]  — периоды по дате продажи (YYYY-MM-DD)
 *   sumField  'finishedPrice' (розничная, дефолт) | 'forPay' (к перечислению)
 *   minIntervalMs  пауза между запросами WB (лимит), по умолч. 66000
 * @returns {Promise<object>} контракт отчёта
 */
export async function analyzeBrandKeywordSales({ brands, phrases, periods, sumField = 'finishedPrice', minIntervalMs, log = () => {} }) {
  if (!brands?.length) throw new Error('analyzeBrandKeywordSales: не заданы brands');
  if (!phrases?.length) throw new Error('analyzeBrandKeywordSales: не заданы phrases');
  if (!periods?.length) throw new Error('analyzeBrandKeywordSales: не заданы periods');

  // Окна для сбора nmId из выдачи (d2 у MPStats — строго раньше сегодня).
  const day = 86400000;
  const yst = new Date(Date.now() - day).toISOString().slice(0, 10);
  const windows = periods.map((p) => ({ d1: p.from, d2: p.to > yst ? yst : p.to }));

  log('[1/3] Собираю наши nmId из выдачи (MPStats)…');
  const targets = await resolveTargets({ brands, phrases, windows, log });
  const allNm = new Set();
  for (const t of targets) for (const id of t.nm.keys()) allNm.add(id);
  if (!allNm.size) throw new Error('Не нашёл карточек наших брендов в выдаче по заданным фразам.');

  // Один pull продаж с самой ранней даты периода — из него считаем все периоды.
  const from = periods.map((p) => p.from).sort()[0];
  log(`[2/3] Тяну продажи из кабинета с ${from} (лимит 1 запрос/мин, наберитесь терпения)…`);
  const rows = await pullSales({ dateFrom: from, nmIds: allNm, minIntervalMs, log });
  log(`  собрано наших строк: ${rows.length}`);

  log('[3/3] Считаю по запросам и периодам…');
  const queries = targets.map((t) => {
    const nmSet = new Set(t.nm.keys());
    const mine = rows.filter((x) => nmSet.has(+x.nmId));
    const agg = aggregate(mine, periods, sumField);
    const brandsMatched = [...new Set([...t.nm.values()])];
    return { phrase: t.phrase, brandsMatched, nmids: t.nm.size, ...agg };
  });

  // Итоги по всем запросам.
  const totals = {};
  for (const p of periods) {
    totals[p.key] = emptyAgg();
    for (const q of queries) {
      totals[p.key].buyouts += q.byPeriod[p.key].buyouts;
      totals[p.key].sum += q.byPeriod[p.key].sum;
      totals[p.key].returns += q.byPeriod[p.key].returns;
      totals[p.key].returnSum += q.byPeriod[p.key].returnSum;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    brands,
    sumField,
    periods,
    queries,
    totals,
  };
}

// ── HTML-отчёт ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ');
const intf = (n) => (Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ');

/**
 * Формирует самодостаточный HTML-отчёт (для PDF).
 * @param {object} a  результат analyzeBrandKeywordSales
 * @param {object} meta { title? }
 */
export function formatHtml(a, meta = {}) {
  const P = a.periods;
  const sumLabel = a.sumField === 'forPay' ? 'к перечислению продавцу (forPay)' : 'розничная цена с учётом скидок (finishedPrice, что заплатил покупатель)';
  const genStr = a.generatedAt.slice(0, 10).split('-').reverse().join('.');

  const th = P.map((p) => `<th class="n">Выкупов, ${esc(p.label)}</th><th class="n">Сумма ${esc(p.label)}, ₽</th>`).join('');
  const summaryRows = a.queries.map((q) => `
    <tr><td class="q">${esc(q.phrase)}<span class="br">${esc(q.brandsMatched.join(', '))} · ${q.nmids} арт.</span></td>
      ${P.map((p) => `<td class="n">${intf(q.byPeriod[p.key].buyouts)}</td><td class="n">${money(q.byPeriod[p.key].sum)}</td>`).join('')}</tr>`).join('');
  const totalRow = `<tr class="total"><td>ИТОГО</td>${P.map((p) => `<td class="n">${intf(a.totals[p.key].buyouts)}</td><td class="n">${money(a.totals[p.key].sum)}</td>`).join('')}</tr>`;

  const retRows = a.queries.map((q) => `
    <tr><td class="q">${esc(q.phrase)}<span class="br">${esc(q.brandsMatched.join(', '))}</span></td>
      ${P.map((p) => `<td class="n">${intf(q.byPeriod[p.key].returns)}</td><td class="n">−${money(q.byPeriod[p.key].returnSum)}</td>`).join('')}</tr>`).join('');

  const detail = (q) => `
    <h3>${esc(q.phrase)} <span class="muted">— ${esc(q.brandsMatched.join(', '))} (${q.nmids} арт.)</span></h3>
    <table class="grid"><thead><tr><th>Артикул WB</th><th>Наш SKU</th>
      ${P.map((p) => `<th class="n">Выкупов ${esc(p.label)}</th><th class="n">Сумма ${esc(p.label)}, ₽</th>`).join('')}</tr></thead><tbody>
    ${q.perNm.map((x) => `<tr><td>${esc(x.nmId)}</td><td class="art">${esc(x.art || '—')}</td>
      ${P.map((p) => `<td class="n">${intf(x.byPeriod[p.key].buyouts)}</td><td class="n">${money(x.byPeriod[p.key].sum)}</td>`).join('')}</tr>`).join('')}
    </tbody></table>`;

  const periodDefs = P.map((p) => `${esc(p.label)} — с ${p.from.split('-').reverse().join('.')} по ${p.to.split('-').reverse().join('.')}`).join('; ');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 15mm 13mm; }
    * { box-sizing: border-box; }
    body { font: 11px/1.45 'Helvetica Neue', Arial, sans-serif; color:#1a1a1a; margin:0; }
    h1 { font-size:19px; margin:0 0 2px; }
    h2 { font-size:14px; margin:20px 0 8px; border-bottom:2px solid #222; padding-bottom:3px; }
    h3 { font-size:12.5px; margin:14px 0 5px; }
    .muted { color:#888; font-weight:normal; } .sub { color:#666; font-size:10.5px; }
    .meta { background:#f5f5f5; border-radius:6px; padding:9px 12px; margin:10px 0 4px; font-size:10px; color:#444; }
    .meta b { color:#222; } code { font-family:monospace; }
    table { border-collapse:collapse; width:100%; margin-top:4px; }
    th,td { padding:5px 8px; border-bottom:1px solid #ddd; text-align:left; }
    th { background:#222; color:#fff; font-size:9.5px; text-transform:uppercase; letter-spacing:.02em; }
    td.n, th.n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
    td.q { font-weight:600; } td.q .br { display:block; font-weight:normal; color:#888; font-size:9.5px; }
    tr.total td { border-top:2px solid #222; font-weight:700; background:#fafafa; }
    .grid th { background:#eee; color:#222; } .grid td { font-size:10px; }
    td.art { color:#666; font-family:monospace; font-size:9.5px; }
    .foot { margin-top:18px; font-size:9px; color:#888; border-top:1px solid #ddd; padding-top:6px; }
  </style></head><body>
    <h1>${esc(meta.title || 'Анализ своих товаров по ключевым запросам')}</h1>
    <div class="sub">Бренды <b>${esc(a.brands.join(', '))}</b> · фактические выкупы из личного кабинета Wildberries</div>
    <div class="meta">
      <b>Источник:</b> WB Statistics API (<code>/api/v1/supplier/sales</code>) — фактические выкупы.
      <b>Сумма</b> — ${sumLabel}.<br>
      <b>Периоды:</b> ${periodDefs}. <b>Отбор товаров:</b> карточки наших брендов из поисковой выдачи WB по запросу (топ‑100).
      <b>Сформирован:</b> ${genStr}.
    </div>

    <h2>Итог: выкуплено и на какую сумму</h2>
    <table><thead><tr><th>Запрос / бренд</th>${th}</tr></thead><tbody>${summaryRows}${totalRow}</tbody></table>

    <h2>Возвраты за те же периоды <span class="muted" style="font-size:11px">(справочно, из выкупов не вычтены)</span></h2>
    <table><thead><tr><th>Запрос / бренд</th>${P.map((p) => `<th class="n">Возвратов, ${esc(p.label)}</th><th class="n">Сумма ${esc(p.label)}, ₽</th>`).join('')}</tr></thead><tbody>${retRows}</tbody></table>

    <h2>Детализация по артикулам</h2>
    ${a.queries.map(detail).join('')}

    <div class="foot">
      «Выкуп» — фактически купленный (оплаченный и не возвращённый) товар; строки <code>saleID</code> вида S.
      Возвраты (строки вида R) показаны отдельно. Продажи невозможно строго привязать к конкретному поисковому
      запросу — под «по запросу» понимается перечень карточек наших брендов, которые WB показывает в выдаче по
      данной фразе (топ‑100 выдачи MPStats), с их фактическими продажами из кабинета.
    </div>
  </body></html>`;
}
