// lib/skuReportHtml.js — годовой отчёт по артикулам WB (самодостаточный HTML→PDF).
// Крупное фото (зум ×3 при наведении), кликабельные артикул и бренд (→ карточка),
// три ключевые суммы: выручка, «заработал» (выручка×выкуп%), упущенная выручка.
// Инлайн-CSS, инлайн-SVG, фото — data-URI. Акцентная схема, без залезаний.

const RU = new Intl.NumberFormat('ru-RU');
const int = (n) => RU.format(Math.round(Number(n) || 0));
function money(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' млрд ₽';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
  if (Math.abs(n) >= 1e3) return int(Math.round(n / 1e3)) + ' тыс ₽';
  return int(n) + ' ₽';
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const C = {
  ink: '#1c1622', muted: '#6c6577', hair: '#ece7f0', soft: '#faf7fb', panel: '#ffffff',
  accent: '#cb11ab', accent2: '#7048e8',
  good: '#2f9e44', mid: '#f08c00', bad: '#e03131',
  goodBg: '#e9f7ee', badBg: '#fdecec', accentBg: '#fdf0f9',
};
const MON = { '01': 'янв', '02': 'фев', '03': 'мар', '04': 'апр', '05': 'май', '06': 'июн', '07': 'июл', '08': 'авг', '09': 'сен', '10': 'окт', '11': 'ноя', '12': 'дек' };
const monLabel = (ym) => {
  const [y, m] = String(ym).split('-');
  return `${MON[m] || m} ${String(y).slice(2)}`;
};

// Помесячные столбцы выручки (инлайн-SVG).
function monthlyBars(monthly) {
  if (!monthly || monthly.length < 2) return `<div class="mb-empty">помесячных данных нет</div>`;
  const max = Math.max(...monthly.map((m) => m.revenue), 1);
  const bw = 100 / monthly.length;
  const bars = monthly
    .map((m, i) => {
      const h = Math.max(1, (m.revenue / max) * 100);
      const x = i * bw;
      const peak = m.revenue === max;
      return `<div class="mb-col" style="left:${x}%;width:${bw}%">
        <div class="mb-bar" style="height:${h}%;background:${peak ? C.accent : C.accent2}" title="${monLabel(m.label)}: ${money(m.revenue)}"></div>
        <div class="mb-lab">${monLabel(m.label)}</div>
      </div>`;
    })
    .join('');
  return `<div class="mb-plot">${bars}</div>`;
}

function card(p) {
  const skuLink = (inner) =>
    p.url ? `<a class="lnk" href="${esc(p.url)}" target="_blank" rel="noopener">${inner}</a>` : inner;
  const img = p.img
    ? `<img src="${p.img}" alt="фото артикула ${p.sku}"/>`
    : `<div class="ph-none">нет<br>фото</div>`;

  return `<article class="card">
    <div class="ph">${skuLink(img)}</div>
    <div class="c-body">
      <div class="c-head">
        <div class="c-ids">
          ${skuLink(`<span class="sku">арт. ${int(p.sku)}</span>`)}
          ${p.brand ? skuLink(`<span class="brand">${esc(p.brand)}</span>`) : ''}
          ${p.rating ? `<span class="chip">★ ${String(p.rating).replace('.', ',')} · ${int(p.comments)} отз.</span>` : ''}
        </div>
        ${p.name ? `<div class="p-name">${esc(p.name)}</div>` : ''}
      </div>

      <div class="money">
        <div class="m-tile m-rev">
          <div class="m-lab">Выручка за год</div>
          <div class="m-val">${money(p.revenue)}</div>
          <div class="m-sub">${int(p.units)} шт · ср. цена ${int(p.avgPrice)} ₽</div>
        </div>
        <div class="m-tile m-earn">
          <div class="m-lab">Заработал <span class="m-hint">выручка × выкуп</span></div>
          <div class="m-val">${p.earned != null ? money(p.earned) : '—'}</div>
          <div class="m-sub">${p.buyoutPct ? 'выкуп ' + int(p.buyoutPct) + '%' : 'выкуп неизвестен'}</div>
        </div>
        <div class="m-tile m-lost">
          <div class="m-lab">Упущенная выручка</div>
          <div class="m-val">${money(p.lostProfit)}</div>
          <div class="m-sub">${p.revenue > 0 ? 'к выручке ' + int((p.lostProfit / p.revenue) * 100) + '%' : 'дефицит спроса'}</div>
        </div>
      </div>

      <div class="mb-wrap">
        <div class="mb-title">Выручка по месяцам</div>
        ${monthlyBars(p.monthly)}
      </div>
    </div>
  </article>`;
}

export function buildSkuReportHtml({ products, summary }) {
  const title = summary.title || 'Годовая аналитика по артикулам';
  const period = `${summary.d1} — ${summary.d2} (${summary.days} дн.)`;

  const head = `
    <div class="hkpi"><div class="hk-lab">Суммарная выручка</div><div class="hk-val" style="color:${C.accent}">${money(summary.revenueSum)}</div></div>
    <div class="hkpi"><div class="hk-lab">Заработал (× выкуп)</div><div class="hk-val" style="color:${C.good}">${summary.earnedSum ? money(summary.earnedSum) : '—'}</div></div>
    <div class="hkpi"><div class="hk-lab">Упущенная выручка</div><div class="hk-val" style="color:${C.bad}">${money(summary.lostSum)}</div></div>
    <div class="hkpi"><div class="hk-lab">Продано штук</div><div class="hk-val">${int(summary.unitsSum)}</div></div>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: ${C.ink}; background: ${C.soft}; font-size: 13px; line-height: 1.4; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 22px 20px 34px; }

  .head { border-bottom: 3px solid ${C.accent}; padding-bottom: 14px; margin-bottom: 16px; }
  .brandline { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: ${C.accent}; font-weight: 700; }
  h1 { font-size: 23px; margin: 4px 0 3px; font-weight: 800; letter-spacing: -.01em; }
  .sub { color: ${C.muted}; font-size: 12.5px; }

  .hkpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0 20px; }
  .hkpi { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 10px; padding: 11px 12px; min-width: 0; }
  .hk-lab { font-size: 10.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hk-val { font-size: 18px; font-weight: 800; margin-top: 3px; }

  .cards { display: flex; flex-direction: column; gap: 14px; }
  .card { display: grid; grid-template-columns: 150px 1fr; gap: 18px; background: ${C.panel};
    border: 1px solid ${C.hair}; border-radius: 14px; padding: 16px 18px; overflow: visible; }

  /* Фото + зум ×3 */
  .ph { width: 150px; height: 200px; position: relative; z-index: 1; }
  .ph img { width: 150px; height: 200px; object-fit: cover; border-radius: 10px; border: 1px solid ${C.hair};
    background: ${C.soft}; display: block; cursor: zoom-in; transition: transform .18s ease, box-shadow .18s ease; transform-origin: left top; }
  .card:hover { z-index: 40; }
  .ph:hover img { transform: scale(3); z-index: 60; position: relative; box-shadow: 0 18px 52px rgba(28,22,34,.42); border-color: ${C.accent}; }
  .ph-none { width: 150px; height: 200px; border-radius: 10px; border: 1px dashed ${C.hair}; display: flex; align-items: center; justify-content: center; text-align: center; color: ${C.muted}; font-size: 12px; background: ${C.soft}; }
  a.lnk { text-decoration: none; color: inherit; }

  .c-body { min-width: 0; }
  .c-ids { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 5px; }
  .sku { display: inline-block; font-size: 12.5px; font-weight: 800; color: #fff; background: ${C.accent2}; padding: 3px 9px; border-radius: 7px; }
  a.lnk:hover .sku { background: ${C.accent}; }
  .brand { display: inline-block; font-size: 12.5px; font-weight: 800; color: ${C.accent}; border: 1.5px solid ${C.accent}; padding: 2px 9px; border-radius: 7px; }
  a.lnk:hover .brand { background: ${C.accentBg}; }
  .chip { font-size: 11px; color: ${C.muted}; background: ${C.soft}; border: 1px solid ${C.hair}; padding: 2px 8px; border-radius: 20px; }
  .p-name { font-size: 14px; font-weight: 600; color: ${C.ink}; overflow-wrap: anywhere; margin-top: 2px; }

  .money { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 12px 0; }
  .m-tile { border-radius: 11px; padding: 11px 12px; border: 1px solid ${C.hair}; min-width: 0; }
  .m-rev { background: ${C.accentBg}; border-color: #f6cceb; }
  .m-earn { background: ${C.goodBg}; border-color: #cceccf; }
  .m-lost { background: ${C.badBg}; border-color: #f6cccc; }
  .m-lab { font-size: 10.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .m-hint { text-transform: none; letter-spacing: 0; font-size: 9.5px; opacity: .8; }
  .m-val { font-size: 20px; font-weight: 800; margin: 3px 0 2px; white-space: nowrap; }
  .m-rev .m-val { color: ${C.accent}; }
  .m-earn .m-val { color: ${C.good}; }
  .m-lost .m-val { color: ${C.bad}; }
  .m-sub { font-size: 10.5px; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .mb-wrap { margin-top: 4px; }
  .mb-title { font-size: 10.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
  .mb-plot { position: relative; height: 66px; border-bottom: 1px solid ${C.hair}; }
  .mb-col { position: absolute; bottom: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; padding: 0 2px; }
  .mb-bar { width: 100%; max-width: 30px; border-radius: 3px 3px 0 0; min-height: 1px; }
  .mb-lab { position: absolute; bottom: -15px; font-size: 8.5px; color: ${C.muted}; white-space: nowrap; }
  .mb-empty { font-size: 11px; color: ${C.muted}; padding: 10px 0; }

  .foot { margin-top: 24px; padding-top: 12px; border-top: 1px solid ${C.hair}; font-size: 10.5px; color: ${C.muted}; }

  @media print {
    body { background: #fff; }
    .wrap { max-width: none; padding: 0 6mm; }
    .card, .hkpi { break-inside: avoid; }
    .ph:hover img { transform: none; box-shadow: none; }
  }
  @page { size: A4; margin: 10mm 6mm; }
</style></head>
<body><div class="wrap">
  <div class="head">
    <div class="brandline">Аналитика артикулов · Wildberries · данные MPStats</div>
    <h1>${esc(title)}</h1>
    <div class="sub">Период ${esc(period)} · артикулов: ${summary.count}</div>
  </div>

  <div class="hkpis">${head}</div>

  <div class="cards">${products.map(card).join('')}</div>

  <div class="foot">
    Наведите курсор на фото — увеличение ×3. Артикул и бренд — ссылки на карточку Wildberries.
    «Заработал» = выручка × процент выкупа (поправка на возвраты); процент выкупа MPStats даёт оценочно
    на уровне категории/предмета (у похожих товаров он близок), поэтому «заработал» — ориентир, а не
    точная бухгалтерия. Упущенная выручка — оценка спроса, не удовлетворённого из-за отсутствия товара
    на складе. Данные MPStats оценочные, пригодны для сравнения и ранжирования.
  </div>
</div></body></html>`;
}
