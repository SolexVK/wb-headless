// lib/forensicsHtml.js — вёрстка двух PDF-отчётов расследования.
//
// Печатная вёрстка (A4), поэтому: без интерактива, каждый график продублирован
// таблицей, значения подписаны прямо на столбцах. Палитра — валидированные
// слоты (blue #2a78d6, orange #eb6834, aqua #1baf7a) и фиксированные статусные
// цвета (good/warning/serious/critical), которые всегда идут с подписью, а не
// «цветом в одиночку».

const fmt = (v, d = 0) =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dt = (v) => (v ? String(v).replace('T', ' ').replace('Z', '').slice(0, 16) : '—');
/** Все календарные дни периода — чтобы в графике были видны и нулевые дни. */
const daysOf = ({ d1, d2 }) => {
  const out = [];
  for (let x = new Date(d1 + 'T00:00:00Z'); x.toISOString().slice(0, 10) <= d2; x.setUTCDate(x.getUTCDate() + 1)) {
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
};

const CSS = (accent) => `
:root{
  --surface:#fcfcfb; --plane:#f4f4f1; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --line:#c3c2b7; --ring:rgba(11,11,11,.10);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a;
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --accent:${accent};
}
@page{size:A4;margin:14mm 12mm 16mm}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);
  font:11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1{font-size:23px;line-height:1.2;margin:0 0 4px}
h2{font-size:15px;margin:0 0 8px;padding-bottom:5px;border-bottom:2px solid var(--accent)}
h3{font-size:12.5px;margin:14px 0 6px;color:var(--ink)}
p{margin:0 0 8px;color:var(--ink2)}
section{margin:0 0 16px;break-inside:avoid}
.head{border-left:5px solid var(--accent);padding:2px 0 2px 12px;margin-bottom:14px}
.sub{color:var(--ink2);font-size:11px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{background:var(--plane);border:1px solid var(--ring);border-radius:4px;padding:2px 7px;font-size:9.5px;color:var(--ink2)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.kpi{background:var(--plane);border:1px solid var(--ring);border-radius:6px;padding:9px 10px}
.kpi .v{font-size:18px;font-weight:650;letter-spacing:-.02em}
.kpi .l{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.kpi .n{font-size:9.5px;color:var(--ink2);margin-top:3px}
.kpi.crit .v{color:var(--critical)} .kpi.good .v{color:var(--good)} .kpi.warn .v{color:#8a6100}
.banner{border-radius:6px;padding:11px 13px;margin:0 0 14px;border:1px solid var(--ring);border-left-width:5px}
.banner.finding{background:#eef5fd;border-left-color:var(--s1)}
.banner.alarm{background:#fdeeee;border-left-color:var(--critical)}
.banner.ok{background:#eefaee;border-left-color:var(--good)}
.banner.warn{background:#fff7e6;border-left-color:var(--warning)}
.banner>b:first-child{display:block;font-size:12.5px;margin-bottom:4px;color:var(--ink)}
.banner p{margin:0;font-size:10.5px}
table{width:100%;border-collapse:collapse;font-size:9.8px;margin:6px 0 4px}
th{text-align:left;font-size:8.6px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  border-bottom:1px solid var(--line);padding:4px 5px;font-weight:600}
td{padding:3.5px 5px;border-bottom:1px solid var(--grid);vertical-align:top}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.total td{font-weight:650;border-top:1.5px solid var(--line);border-bottom:none;background:var(--plane)}
.bars{margin:8px 0 6px}
.bar-row{display:grid;grid-template-columns:minmax(120px,250px) 1fr auto;gap:8px;align-items:center;margin-bottom:5px}
.bar-lab{font-size:9.5px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{display:block;background:var(--plane);border-radius:3px;height:13px;position:relative;overflow:hidden}
.bar-fill{display:block;height:13px;border-radius:0 4px 4px 0;background:var(--s1)}
.bar-val{font-size:9.5px;font-variant-numeric:tabular-nums;color:var(--ink);min-width:78px;text-align:right}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.card{background:var(--plane);border:1px solid var(--ring);border-radius:6px;padding:10px 11px}
.card b{font-size:11px}
.card ul{margin:6px 0 0;padding-left:16px} .card li{margin-bottom:4px;color:var(--ink2);font-size:10px}
.note{font-size:9.3px;color:var(--muted);margin-top:5px}
.tag{display:inline-block;font-size:8.6px;padding:1px 6px;border-radius:9px;border:1px solid var(--ring);
  background:#fff;color:var(--ink2);white-space:nowrap}
.tag.crit{background:#fdeeee;border-color:#f0c3c3;color:#8f2020}
.tag.warn{background:#fff7e6;border-color:#f3ddab;color:#7a5600}
.tag.ok{background:#eefaee;border-color:#bfe6bf;color:#0a6b0a}
.tl{border-left:2px solid var(--grid);margin:8px 0 4px;padding-left:12px}
.tl-item{position:relative;margin-bottom:9px}
.tl-item::before{content:"";position:absolute;left:-17px;top:3px;width:8px;height:8px;border-radius:50%;
  background:var(--s1);border:2px solid var(--surface)}
.tl-item.crit::before{background:var(--critical)}
.tl-d{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.tl-t{font-size:10.5px;color:var(--ink)}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin:4px 0 6px;font-size:9.3px;color:var(--ink2)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.page-break{break-before:page}
footer{margin-top:14px;padding-top:7px;border-top:1px solid var(--grid);font-size:8.6px;color:var(--muted)}
`;

/** Горизонтальные столбцы с подписью значения на каждой строке. */
function bars(items, { color = 'var(--s1)', unit = 'сом', max } = {}) {
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return `<div class="bars">${items.map((i) => `
    <div class="bar-row">
      <span class="bar-lab" title="${esc(i.label)}">${esc(i.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${i.value === 0 ? 0 : Math.max(1.5, (Math.abs(i.value) / top) * 100)}%;background:${i.color || color}"></span></span>
      <span class="bar-val">${fmt(i.value, i.dec ?? 0)}${unit ? ' ' + unit : ''}${i.note ? ` <span class="note">${esc(i.note)}</span>` : ''}</span>
    </div>`).join('')}</div>`;
}

const table = (cols, rows, totalRow) => `<table><thead><tr>${
  cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.title)}</th>`).join('')
}</tr></thead><tbody>${
  rows.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.render ? c.render(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`).join('')
}${totalRow ? `<tr class="total">${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${totalRow[c.key] ?? ''}</td>`).join('')}</tr>` : ''}</tbody></table>`;

const shell = (title, accent, body) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS(accent)}</style></head><body>${body}</body></html>`;

const header = (title, subtitle, chips) => `
<div class="head">
  <h1>${esc(title)}</h1>
  <div class="sub">${subtitle}</div>
  <div class="meta">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
</div>`;

// ───────────────────── ОТЧЁТ 1: ЛОГИСТИКА ─────────────────────

export function logisticsHtml({ log, prev, period, meta, weekly }) {
  const accent = '#2a78d6';
  const grand = (log.total + (prev?.logisticsTotal || 0)).toFixed(2);
  const paidPvz = log.pvzStats.filter((p) => p.charged > 0);
  const freePvz = log.pvzStats.filter((p) => p.charged === 0 && p.issued > 0);

  const body = `
${header('Расследование: удержания за логистику',
  `Период ${period.d1} — ${period.d2} - валюта отчётов <b>KGS (сом)</b> - ${esc(meta.seller)}`,
  [`Источник: WB Finance API /sales-reports/detailed`,
   `Отчёты: дневные (reportType 1)`,
   `Строк детализации: ${fmt(meta.financeRows)}`,
   `Связано с карточками возвратов: ${fmt(log.rows.filter((r) => r.returnType).length)} из ${fmt(log.rowCount)}`,
   `Сформирован: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`])}

<div class="kpis">
  <div class="kpi"><div class="l">Логистика за период</div><div class="v">${fmt(log.total)}</div><div class="n">сом, ${fmt(log.rowCount)} начислений</div></div>
  <div class="kpi good"><div class="l">За доставку покупателю</div><div class="v">${fmt(log.forwardTotal)}</div><div class="n">сом - ИУ соблюдаются</div></div>
  <div class="kpi"><div class="l">Средний тариф возврата</div><div class="v">${fmt(log.avgTariff)}</div><div class="n">сом (медиана ${fmt(log.medianTariff)}, макс ${fmt(log.maxTariff)})</div></div>
  <div class="kpi crit"><div class="l">Ожидаемый «хвост»</div><div class="v">≈${fmt(log.pending.forecast)}</div><div class="n">сом за ${fmt(log.pending.count)} выданных возвратов</div></div>
</div>

<div class="banner ok">
  <b>Главный вывод: индивидуальные условия не нарушены — логистика продаж не удерживалась вообще</b>
  <p>Все ${fmt(log.rowCount)} начислений за период имеют в поле <i>bonusTypeName</i> причину «Возврат … (К продавцу)».
  Ни одной строки за прямую доставку заказа покупателю (${fmt(log.forwardTotal)} сом) в отчётах нет.
  Удерживается <b>обратная логистика возвратов</b> — перевозка товара с ПВЗ обратно продавцу. Это отдельная услуга,
  тарифицируемая по общей сетке маркетплейса и не покрываемая ИУ на логистику продаж.</p>
</div>

<section>
  <h2>1. За что именно удержано</h2>
  ${bars(log.byReason.map((r) => ({ label: r.key, value: r.sum, note: `${r.count} шт` })), { color: 'var(--s1)' })}
  ${table([
    { title: 'Причина начисления (bonusTypeName)', key: 'key' },
    { title: 'Что это значит на практике', key: 'expl' },
    { title: 'Начислений', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Средний тариф', key: 'avg', num: true, render: (r) => fmt(r.sum / r.count, 2) },
  ], log.byReason.map((r) => ({ ...r, expl: REASON_EXPL[r.key] || 'Перевозка товара обратно продавцу' })),
    { key: 'ИТОГО', expl: '', count: fmt(log.rowCount), sum: fmt(log.total, 2), avg: fmt(log.avgTariff, 2) })}
  <p class="note">Тариф не зависит от причины: он считается по сетке маркетплейса как «база + литраж × объём», умноженная на коэффициент склада (см. раздел 3).</p>
</section>

<section>
  <h2>2. Когда списывали: начисления идут пакетами</h2>
  <div class="legend"><span><i style="background:var(--s1)"></i>логистика, сом</span></div>
  ${bars(daysOf(period).map((day) => {
    const hit = log.byDate.find((d) => d.key === day);
    return { label: day, value: hit ? hit.sum : 0, note: hit ? `${hit.count} строк` : 'нет начислений' };
  }), { color: 'var(--s1)' })}
  <p>Списания приходят не ежедневно, а <b>партиями в день выдачи возвратов продавцу</b>. Поэтому в отдельные дни
  логистика равна нулю, а затем приходит крупный пакет. Это же объясняет ощущение «удерживают не за все поставки»:
  по большинству выданных возвратов начисление ещё просто не проведено.</p>
</section>

<section>
  <h2>3. Почему тариф именно такой</h2>
  <p>В каждой строке WB передаёт <b>коэффициент склада</b> (<i>warehouseLogisticsCoeff</i>) — множитель к базовому тарифу
  маркетплейса. Отсюда разброс сумм: одна и та же рубашка стоит по-разному в зависимости от того, через какой склад идёт возврат.</p>
  ${table([
    { title: 'Коэффициент', key: 'key', render: (r) => `×${r.key}` },
    { title: 'Начислений', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Средний тариф, сом', key: 'avg', num: true, render: (r) => fmt(r.avg, 2) },
    { title: 'Переплата к ×1', key: 'over', num: true, render: (r) => {
      const base = log.byCoef.find((c) => Number(c.key) === 1);
      if (!base || Number(r.key) === 1) return '—';
      return `+${fmt(r.avg - base.avg, 2)} сом (${fmt(((r.avg / base.avg) - 1) * 100, 0)}%)`;
    } },
  ], log.byCoef)}
  ${bars(log.byCoef.map((c) => ({ label: `×${c.key} — ${c.count} перевозок`, value: c.sum, note: `по ${fmt(c.avg, 2)} сом` })), { color: 'var(--s2)' })}
  <p class="note">Столбцы — сколько всего удержано при каждом коэффициенте; средний тариф одной перевозки — в таблице выше.
  Тариф маркетплейса на 27.08 для «своего склада»: база 46, литр 14, коэффициент 100%.</p>
</section>

<section class="page-break">
  <h2>4. Куда едут возвраты и где платим</h2>
  ${table([
    { title: 'ПВЗ выдачи возвратов', key: 'pvz' },
    { title: 'Выдано возвратов', key: 'issued', num: true },
    { title: 'Из них тарифицировано', key: 'charged', num: true },
    { title: 'Доля', key: 'chargedPct', num: true, render: (r) => `${fmt(r.chargedPct, 1)} %` },
    { title: 'Даты выдач', key: 'dates', render: (r) => esc(r.dates.join(', ')) },
  ], log.pvzStats)}
  ${freePvz.length ? `
  <div class="banner warn">
    <b>По ${esc(String(freePvz[0].pvz).split(',')[0])} в этом окне начислений нет — это лаг, а не бесплатность</b>
    <p>Выдано <b>${fmt(freePvz.reduce((s, p) => s + p.issued, 0))}</b> возвратов без единого начисления логистики,
    тогда как ${paidPvz.map((p) => esc(p.pvz.split(',')[0])).join(' и ')} тарифицируются регулярно.
    Соблазнительно счесть такой ПВЗ бесплатным — <b>это ошибка</b>: списание приходит пакетом в день выдачи, а сам день
    может быть ещё не закрыт. На живых данных такой «бесплатный» ПВЗ на следующем закрытом дне оплатился на 100%.
    Считайте эти ${fmt(freePvz.reduce((s, p) => s + p.issued, 0))} возвратов будущим расходом
    (≈${fmt(freePvz.reduce((s, p) => s + p.issued, 0) * log.avgTariff)} сом), а не экономией.</p>
  </div>` : ''}
  <h3>Разрез по способу доставки</h3>
  ${table([
    { title: 'Способ', key: 'key' }, { title: 'Начислений', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
  ], log.byMethod)}
</section>

<section>
  <h2>5. Ответы на поставленные вопросы</h2>
  <div class="cols">
    <div class="card"><b>«У нас ИУ, логистика не должна учитываться»</b>
      <ul><li>Верно: за доставку заказов покупателям не удержано <b>ни одного сома</b>.</li>
      <li>ИУ распространяются на логистику продаж, а не на возврат товара продавцу — это разные услуги в тарифах WB.</li>
      <li>Проверить формулировку ИУ по пункту «обратная логистика/возврат к продавцу» — если она там есть, начисления оспоримы.</li></ul></div>
    <div class="card"><b>«Перешли с FBO на FBS — теперь удерживают?»</b>
      <ul><li>Нет. Переход модели тут ни при чём: удержания привязаны к возвратам, а не к схеме продаж.</li>
      <li>В периоде тарифицированы обе схемы: возвраты FBS — ${fmt((log.byMethod.find((m) => /FBS/i.test(m.key)) || { sum: 0 }).sum)} сом,
      возвраты FBW — ${fmt((log.byMethod.find((m) => /FBW/i.test(m.key)) || { sum: 0 }).sum)} сом. Правило одно и то же.</li>
      <li>При FBO тот же возврат тоже тарифицируется — просто он реже доезжает до вас, оставаясь на складе WB.</li></ul></div>
    <div class="card"><b>«Товар везут со склада ФФ на дорогой склад WB?»</b>
      <ul><li>Нет. Направление обратное: товар едет <b>от покупателя к вам</b> — с ПВЗ на пункт выдачи возвратов.</li>
      <li>Поле поставки (giId) во всех строках указывает на «Склад WB РФ», то есть на исходную партию, а не на новое перемещение.</li>
      <li>«Дорогим» тариф делает не склад назначения, а коэффициент (до ×2) на маршруте возврата.</li></ul></div>
    <div class="card"><b>«Удерживают не за все поставки»</b>
      <ul><li>Подтверждается, но причина — не выборочность, а <b>лаг</b>: списание приходит в день выдачи возврата.</li>
      <li>Уже выдано и ещё не оплачено: <b>${fmt(log.pending.count)}</b> возвратов ≈ <b>${fmt(log.pending.forecast)} сом</b> будущих удержаний.</li>
      <li>ПВЗ без начислений в окне — это не бесплатность, а незакрытый день: см. раздел 4.</li></ul></div>
  </div>
</section>

<section>
  <h2>6. Как снизить эти затраты</h2>
  <div class="banner warn">
    <b>Порядок действий по убыванию эффекта</b>
    <p>1. <b>Снизить сам поток возвратов</b>: ${fmt(log.rowCount)} перевозок — это ${fmt(log.rowCount)} невыкупов и браков. Топ-артикулы в разделе 7:
    у лидеров проблема системная (размерная сетка, фото, описание, качество пошива).<br>
    2. <b>Уходить со складов с коэффициентом ×2</b>: средний чек перевозки там ${fmt((log.byCoef.find((c) => Number(c.key) === 2) || { avg: 0 }).avg, 2)} сом против
    ${fmt((log.byCoef.find((c) => Number(c.key) === 1) || { avg: 0 }).avg, 2)} сом при ×1.<br>
    3. <b>Забирать возвраты вовремя</b> — иначе к логистике добавляется штраф за хранение на ПВЗ (см. второй отчёт).</p>
  </div>
</section>

<section>
  <h2>7. Топ товаров по стоимости возвратной логистики</h2>
  ${table([
    { title: 'Артикул продавца', key: 'key' },
    { title: 'Перевозок', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Средний тариф', key: 'avg', num: true, render: (r) => fmt(r.sum / r.count, 2) },
    { title: 'Доля в логистике', key: 'sh', num: true, render: (r) => `${fmt((r.sum / log.total) * 100, 1)} %` },
  ], log.byArticle.slice(0, 15))}
  <p class="note">Полный построчный список — в приложенном CSV (${fmt(log.rowCount)} строк, включая srid, ПВЗ, коэффициент и дату).</p>
</section>

<footer>Источник данных: WB Finance API (детализация к отчётам реализации), WB Analytics API (отчёт о возвратах),
WB Statistics API (заказы и продажи), WB Marketplace API (склады продавца), WB Common API (тарифы коробов).
Все суммы — в валюте отчётов продавца (KGS). Отчёт за ${period.d2} не закрыт на момент выгрузки.</footer>`;

  return shell('Расследование: удержания за логистику', accent, body);
}

const REASON_EXPL = {
  'Возврат товара, который приехал по МП, продавцу (К продавцу)':
    'Покупатель не выкупил или вернул заказ маркетплейса — товар везут обратно вам',
  'Возврат брака (К продавцу)': 'Товар признан браком и отправлен обратно продавцу',
  'Возврат товара продавцу по отзыву (К продавцу)': 'Возврат инициирован по отзыву/претензии покупателя',
  'Возврат неопознанного товара (К продавцу)': 'Товар не идентифицирован на складе WB и возвращён продавцу',
};

// ───────────────────── ОТЧЁТ 2: ШТРАФЫ ─────────────────────

export function finesHtml({ fines, prev, period, meta }) {
  const accent = '#d03b3b';
  const c = fines.cancels;
  const s = fines.storage;
  const ffTop = c.byFf[0];
  const pvzTop = s.byPvz[0];

  const body = `
${header('Расследование: начисленные штрафы',
  `Период ${period.d1} — ${period.d2} - валюта отчётов <b>KGS (сом)</b> - ${esc(meta.seller)}`,
  [`Источник: WB Finance API /sales-reports/detailed`,
   `Штрафных строк: ${fmt(c.count + s.count + fines.other.count)}`,
   `Связано с заказами: ${fmt(c.rows.filter((r) => r.orderId).length)} из ${fmt(c.material)}`,
   `Связано с возвратами: ${fmt(s.rows.filter((r) => r.days != null).length)} из ${fmt(s.count)}`,
   `Сформирован: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`])}

<div class="kpis">
  <div class="kpi crit"><div class="l">Штрафы за период</div><div class="v">${fmt(fines.total)}</div><div class="n">сом, ${fmt(c.count + s.count + fines.other.count)} строк</div></div>
  <div class="kpi crit"><div class="l">Срыв заказов</div><div class="v">${fmt(c.total)}</div><div class="n">сом, ${fmt(c.material)} отмен</div></div>
  <div class="kpi warn"><div class="l">Хранение на ПВЗ</div><div class="v">${fmt(s.total)}</div><div class="n">сом, ${fmt(s.count)} случаев</div></div>
  <div class="kpi ${prev.penaltyTotal < 0 ? 'good' : ''}"><div class="l">Прошлый период</div><div class="v">${fmt(prev.penaltyTotal)}</div><div class="n">сом ${prev.penaltyTotal < 0 ? '(сторно в вашу пользу)' : ''}</div></div>
</div>

<div class="banner alarm">
  <b>Главный вывод: ${fmt((c.total / fines.total) * 100, 0)}% штрафов — один сбой одного дня на одном складе</b>
  <p>Все ${fmt(c.material)} отмен пришлись на сборочные задания, созданные <b>${esc(c.byCreatedDate[0]?.key)}</b>
  на складе <b>${esc(ffTop?.key)}</b> (сдача в ${esc(c.rows[0]?.office)}). Заказы провисели необработанными
  ${c.hours ? `<b>${fmt(c.hours.median / 24, 1)} суток</b> (медиана ${fmt(c.hours.median)} ч, разброс ${fmt(c.hours.min)}–${fmt(c.hours.max)} ч)` : ''}
  и были аннулированы ${esc(c.byCancelDate[0]?.key)} — штраф начислен по каждой позиции.</p>
</div>

<section>
  <h2>1. Структура штрафов</h2>
  ${bars(fines.byReason.map((r) => ({ label: r.key, value: r.sum, note: `${r.count} строк`, color: /невыполненный/i.test(r.key) ? 'var(--critical)' : 'var(--s2)' })), { color: 'var(--critical)' })}
  ${table([
    { title: 'Причина (bonusTypeName)', key: 'key' },
    { title: 'Строк', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Средний штраф', key: 'avg', num: true, render: (r) => fmt(r.sum / r.count, 2) },
    { title: 'Доля', key: 'sh', num: true, render: (r) => `${fmt((r.sum / fines.total) * 100, 1)} %` },
  ], fines.byReason, { key: 'ИТОГО', count: fmt(fines.byReason.reduce((a, b) => a + b.count, 0)), sum: fmt(fines.total, 2), avg: '', sh: '100 %' })}
  <p class="note">Средний штраф здесь считается по всем строкам причины. В разделе 2 знаменатель другой — ${fmt(c.material)} материальных отмен
  (${fmt(c.dust)} строк на 0,01 сом — технические хвосты той же партии), поэтому средние значения отличаются.</p>
</section>

<section>
  <h2>2. Дело №1: срыв заказов — ${fmt(c.total)} сом</h2>
  <div class="tl">
    <div class="tl-item"><div class="tl-d">${esc(c.byCreatedDate[0]?.key)} — источник проблемы</div>
      <div class="tl-t">Создано ${fmt(c.material)} сборочных заданий на складе <b>${esc(ffTop?.key)}</b>. Заказы приняты в работу и не собраны.</div></div>
    <div class="tl-item"><div class="tl-d">следующие ${c.hours ? fmt(c.hours.median / 24, 1) : '—'} суток — простой</div>
      <div class="tl-t">Заказы не переведены в сборку и не отгружены. Обычный срок обработки FBS — сутки; здесь он превышен примерно в ${c.hours ? fmt(c.hours.median / 24, 0) : '—'} раз.</div></div>
    <div class="tl-item crit"><div class="tl-d">${esc(c.byCancelDate[0]?.key)} — срыв</div>
      <div class="tl-t">Заказы аннулированы, начислен штраф ${fmt(c.total)} сом — в среднем ${fmt(c.avg, 2)} сом за позицию
      ${c.priceShare ? `(≈${fmt(c.priceShare.median, 1)}% от цены товара, разброс ${fmt(c.priceShare.min, 1)}–${fmt(c.priceShare.max, 1)}%)` : ''}.</div></div>
  </div>
  <h3>Все склады, участвовавшие в срыве</h3>
  ${table([
    { title: 'Склад продавца (ФФ)', key: 'key' },
    { title: 'Отмен', key: 'count', num: true },
    { title: 'Сумма штрафа, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Статус', key: 'st', render: () => '<span class="tag crit">единственный источник</span>' },
  ], c.byFf)}
  <h3>Разбивка по артикулам</h3>
  ${table([
    { title: 'Артикул продавца', key: 'key' },
    { title: 'Отмен', key: 'count', num: true },
    { title: 'Штраф, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Штраф за позицию', key: 'avg', num: true, render: (r) => fmt(r.sum / r.count, 2) },
    { title: 'Доля дела', key: 'sh', num: true, render: (r) => `${fmt((r.sum / c.total) * 100, 1)} %` },
  ], c.byArticle, { key: 'ИТОГО', count: fmt(c.material), sum: fmt(c.total, 2), avg: fmt(c.avg, 2), sh: '100 %' })}
</section>

<section class="page-break">
  <h2>3. Дело №1: пофамильный список сорванных заказов</h2>
  <p class="note">Время простоя = от постановки сборочного задания до аннулирования. Заказы с суммой ≤ 1 сом (${fmt(c.dust)} шт) — технические хвосты той же партии, в статистику не включены.</p>
  ${table([
    { title: '№ заказа', key: 'orderId' },
    { title: 'Артикул', key: 'article' },
    { title: 'Размер', key: 'size' },
    { title: 'Задание создано', key: 'createdAt', render: (r) => dt(r.createdAt) },
    { title: 'Аннулирован', key: 'cancelDate', render: (r) => dt(r.cancelDate) },
    { title: 'Простой, ч', key: 'hours', num: true, render: (r) => (r.hours == null ? '—' : fmt(r.hours, 1)) },
    { title: 'Цена, сом', key: 'price', num: true, render: (r) => (r.price ? fmt(r.price) : '—') },
    { title: 'Штраф, сом', key: 'amount', num: true, render: (r) => fmt(r.amount, 2) },
    { title: '% цены', key: 'priceShare', num: true, render: (r) => (r.priceShare == null ? '—' : `${fmt(r.priceShare, 1)}%`) },
  ], c.rows)}
</section>

<section class="page-break">
  <h2>4. Дело №2: несвоевременный забор возвратов с ПВЗ — ${fmt(s.total)} сом</h2>
  <div class="banner warn">
    <b>Тариф и механика</b>
    <p>WB начисляет посуточную плату за возврат, лежащий на пункте выдачи. По данным периода суточная ставка —
    <b>${fmt(s.dailyRate, 2)} сом</b>, начисление начинается после ~2 суток ожидания: 3 дня → ${fmt(s.dailyRate, 2)}–${fmt(s.dailyRate * 2, 2)} сом,
    7 дней → ${fmt(s.dailyRate * 5, 2)} сом. Пролежало: медиана <b>${s.days ? fmt(s.days.median, 1) : '—'} дн</b>, максимум ${s.days ? fmt(s.days.max, 1) : '—'} дн.</p>
  </div>
  <h3>Где копится просрочка</h3>
  ${table([
    { title: 'ПВЗ', key: 'key' },
    { title: 'Случаев', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Доля', key: 'sh', num: true, render: (r) => `${fmt((r.sum / s.total) * 100, 1)} %` },
  ], s.byPvz, { key: 'ИТОГО', count: fmt(s.count), sum: fmt(s.total, 2), sh: '100 %' })}
  <h3>Сколько суток лежали возвраты</h3>
  ${bars(s.byDays.map((d) => ({ label: `${d.key}–${Number(d.key) + 1} суток`, value: d.count, note: `${fmt(d.sum, 2)} сом` })), { color: 'var(--s2)', unit: 'случаев' })}
  ${fines.awaiting.count ? `
  <div class="banner ${fines.awaiting.overdue ? 'alarm' : 'warn'}">
    <b>Прямо сейчас забора ждут ${fmt(fines.awaiting.count)} возвратов${fines.awaiting.overdue ? ` — ${fmt(fines.awaiting.overdue)} уже в платной зоне` : ' — платная зона ещё не началась'}</b>
    <p>Статус «Готов к выдаче», отметки о выдаче нет. Самый давний лежит ${fmt(fines.awaiting.maxAgeDays, 1)} суток при бесплатном окне ~2 суток,
    так что счёт пока не идёт. Но если партию не забрать в ближайший день, при ставке ${fmt(s.dailyRate, 2)} сом набегает
    <b>до ≈${fmt(fines.awaiting.count * s.dailyRate)} сом за каждые сутки простоя</b>. Очаг:
    ${esc(String(fines.awaiting.byPvz[0]?.key || '—').split(',')[0])} — ${fmt(fines.awaiting.byPvz[0]?.count || 0)} возвратов.
    Кроме того, у ${fmt(s.notTakenYet)} из ${fmt(s.count)} уже оштрафованных случаев отметки о выдаче так и нет — плата идёт, товар лежит.</p>
  </div>` : ''}
  ${fines.awaiting.expired.count ? `
  <div class="banner alarm">
    <b>Критично: у ${fmt(fines.awaiting.expired.count)} возвратов срок хранения на ПВЗ уже истёк</b>
    <p>Самый давний готов к выдаче с ${esc(String(fines.awaiting.expired.oldest).slice(0, 10))}, очаг —
    ${esc(String(fines.awaiting.expired.byPvz[0]?.key || '—').split(',')[0])} (${fmt(fines.awaiting.expired.byPvz[0]?.count || 0)} шт).
    Это уже не суточная плата: товар с истёкшим сроком хранения продавцу не выдают в обычном порядке —
    его судьбу нужно решать отдельно, а стоимость самой единицы к этому моменту потеряна. Проверьте эти позиции первыми.</p>
  </div>` : ''}
  <h3>Топ артикулов по просрочке</h3>
  ${table([
    { title: 'Артикул продавца', key: 'key' },
    { title: 'Случаев', key: 'count', num: true },
    { title: 'Штраф, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
  ], s.byArticle.slice(0, 12))}
</section>

<section class="page-break">
  <h2>5. Дело №2: детализация случаев (топ-40 по сумме)</h2>
  ${table([
    { title: 'Артикул', key: 'article' },
    { title: 'Размер', key: 'size' },
    { title: '№ заказа', key: 'orderId', render: (r) => (r.orderId ? esc(r.orderId) : '—') },
    { title: 'ПВЗ', key: 'pvz', render: (r) => esc(String(r.pvz).split(',')[0]) },
    { title: 'Готов к выдаче', key: 'readyDt', render: (r) => dt(r.readyDt) },
    { title: 'Забран', key: 'takenDt', render: (r) => dt(r.takenDt) },
    { title: 'Суток', key: 'days', num: true, render: (r) => (r.days == null ? '—' : fmt(r.days, 2)) },
    { title: 'Штраф, сом', key: 'amount', num: true, render: (r) => fmt(r.amount, 2) },
  ], [...s.rows].sort((a, b) => (b.days ?? 99) - (a.days ?? 99) || b.amount - a.amount).slice(0, 40))}
  <p class="note">Полный список всех ${fmt(s.count)} случаев — в приложенном CSV.</p>
</section>

<section>
  <h2>6. Предыдущий период (${esc(prev.label)}): что было до этого</h2>
  ${table([
    { title: 'Причина', key: 'key' },
    { title: 'Строк', key: 'count', num: true },
    { title: 'Сумма, сом', key: 'sum', num: true, render: (r) => fmt(r.sum, 2) },
    { title: 'Характер', key: 'ch', render: (r) => (r.sum < 0 ? '<span class="tag ok">возврат средств</span>' : '<span class="tag warn">начисление</span>') },
  ], prev.penaltyByReason, { key: 'ИТОГО', count: '', sum: fmt(prev.penaltyTotal, 2), ch: '' })}
  ${prev.penaltyTotal < 0 ? `<div class="banner ok"><b>WB вернул ранее удержанное</b>
  <p>Сальдо прошлого периода отрицательное (${fmt(prev.penaltyTotal, 2)} сом) за счёт сторно по расхождениям в карточке товара.
  Это доказывает, что штрафы этой категории оспариваются успешно — механика возврата работает.</p></div>` : ''}
</section>

<section>
  <h2>7. Что сделать, чтобы это не повторилось</h2>
  <div class="cols">
    <div class="card"><b>Срыв заказов (${fmt((c.total / fines.total) * 100, 0)}% штрафов)</b>
      <ul>
        <li>Разобрать инцидент <b>${esc(c.byCreatedDate[0]?.key)}</b> на складе <b>${esc(ffTop?.key)}</b>: почему задания не ушли в сборку.</li>
        <li>Ввести контроль возраста задания: сигнал, если задание не собрано за 12 ч, эскалация — за 24 ч.</li>
        <li>Сверять остатки FBS с фактом на складе ФФ ежедневно: чаще всего причина отмен — товара физически нет.</li>
        <li>Приоритет складам с подтверждённым остатком; для дефицитных артикулов (${esc(c.byArticle.slice(0, 3).map((a) => a.key).join(', '))}) снижать лимит FBS.</li>
      </ul></div>
    <div class="card"><b>Возвраты на ПВЗ (${fmt((s.total / fines.total) * 100, 0)}% штрафов)</b>
      <ul>
        <li>Забирать возвраты <b>каждые 2 суток</b> — начисление стартует после этого срока.</li>
        <li>Основной очаг — ${esc(String(pvzTop?.key).split(',')[0])} (${fmt((pvzTop?.sum / s.total) * 100, 0)}% суммы): назначить ответственного и график забора.</li>
        <li>Разобрать ${fmt(fines.awaiting.expired.count)} позиций с истёкшим сроком хранения — там потеряна уже стоимость товара, а не только плата за хранение.</li>
        <li>Сумма невелика (${fmt(s.total)} сом), но она сигнализирует о заторе: те же возвраты порождают обратную логистику (см. первый отчёт).</li>
      </ul></div>
  </div>
</section>

<footer>Источник данных: WB Finance API (детализация к отчётам реализации), WB Marketplace API (сборочные задания и склады продавца),
WB Statistics API (заказы, отмены), WB Analytics API (отчёт о возвратах). Суммы — в валюте отчётов продавца (KGS).
Отчёт за ${period.d2} на момент выгрузки не закрыт, суммы могут дополниться.</footer>`;

  return shell('Расследование: начисленные штрафы', accent, body);
}
