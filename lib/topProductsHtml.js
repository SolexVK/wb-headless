// lib/topProductsHtml.js — самодостаточный HTML-отчёт «Топ-N товаров» для печати в PDF.
// Инлайн-CSS, инлайн-SVG-спарклайны, фото — data-URI (без внешних ресурсов).
// Фото увеличивается при наведении; название кликабельно (ссылка на карточку WB).

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

// Палитра: акцент — WB-маджента, поддержка — фиолетовый; светофор для сигналов.
const C = {
  ink: '#1c1622', muted: '#6c6577', hair: '#ece7f0', soft: '#faf7fb', panel: '#ffffff',
  accent: '#cb11ab', accent2: '#7048e8',
  good: '#2f9e44', mid: '#f08c00', bad: '#e03131',
  goodBg: '#e9f7ee', midBg: '#fff4e2', badBg: '#fdecec',
};

// Мини-спарклайн: массив → инлайн-SVG полилиния; цвет по тренду (последн. vs первый).
function spark(values, { w = 132, h = 34, color, fill = true } = {}) {
  const vals = (values || []).map((v) => Number(v) || 0);
  if (vals.length < 2) return `<div class="spk-empty">нет данных</div>`;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 3;
  const stepX = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (h - pad * 2) * (1 - (v - min) / span);
    return [x, y];
  });
  const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const trend = vals[vals.length - 1] - vals[0];
  const col = color || (trend > 0 ? C.good : trend < 0 ? C.bad : C.accent2);
  const area = fill
    ? `<polygon points="${pad},${h - pad} ${line} ${w - pad},${h - pad}" fill="${col}" opacity="0.10"/>`
    : '';
  const last = pts[pts.length - 1];
  return `<svg class="spk" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">
    ${area}
    <polyline points="${line}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${col}"/>
  </svg>`;
}

const trendArrow = (arr) => {
  const v = (arr || []).map((x) => Number(x) || 0);
  if (v.length < 2) return '';
  const d = v[v.length - 1] - v[0];
  if (d > 0) return `<span style="color:${C.good}">↑</span>`;
  if (d < 0) return `<span style="color:${C.bad}">↓</span>`;
  return `<span style="color:${C.muted}">→</span>`;
};

// Возраст карточки: дни → «X дн» / «X мес» / «X г Y мес».
function fmtAge(days) {
  if (days == null) return '—';
  if (days < 60) return `${days} дн`;
  const mo = Math.round(days / 30);
  if (mo < 12) return `${mo} мес`;
  const y = Math.floor(mo / 12), m = mo % 12;
  return m ? `${y} г ${m} мес` : `${y} г`;
}
// Реклама: CPM, если известен; иначе флаг «да/нет».
function adLabel(p) {
  if (p.searchCpm > 0) return `CPM ${int(p.searchCpm)} ₽`;
  return p.hasAd ? 'да' : 'нет';
}

// Горизонтальная столбчатая диаграмма выручки топа (сравнение лидеров).
function revenueBars(products) {
  const max = Math.max(...products.map((p) => p.revenue), 1);
  return products
    .map((p) => {
      const wPct = Math.max(2, (p.revenue / max) * 100);
      const col = p.rank === 1 ? C.accent : C.accent2;
      return `<div class="rb-row">
        <div class="rb-rank">${p.rank}</div>
        <div class="rb-track"><div class="rb-fill" style="width:${wPct}%;background:${col}"></div></div>
        <div class="rb-val">${money(p.revenue)}</div>
      </div>`;
    })
    .join('');
}

// Значок-сигнал для метрики остатка/заморозки.
function stockTone(balance, salesPerDay) {
  const days = salesPerDay > 0 ? balance / salesPerDay : Infinity;
  if (days < 7) return { bg: C.badBg, col: C.bad, note: 'мало' };
  if (days < 20) return { bg: C.midBg, col: C.mid, note: 'средне' };
  return { bg: C.goodBg, col: C.good, note: 'запас' };
}

function card(p) {
  const st = stockTone(p.balance, p.salesPerDay);
  const leader = p.rank === 1;
  const frozenBad = p.frozenPct >= 15;
  const img = p.img
    ? `<img src="${p.img}" alt="фото товара" loading="eager"/>`
    : `<div class="ph-none">нет<br>фото</div>`;
  const nameHtml = p.url
    ? `<a class="p-name" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`
    : `<span class="p-name">${esc(p.name)}</span>`;
  const color = p.color ? `<span class="chip chip-soft">${esc(p.color.split(',')[0].trim())}</span>` : '';
  const rating = p.rating ? `<span class="chip chip-soft">★ ${String(p.rating).replace('.', ',')} · ${int(p.comments)} отз.</span>` : '';

  return `<article class="card${leader ? ' card-leader' : ''}">
    <div class="c-rank">${p.rank}</div>
    <div class="ph">${img}</div>
    <div class="c-body">
      <div class="c-head">
        ${nameHtml}
        <div class="c-tags">
          <span class="chip chip-brand">${esc(p.brand || '—')}</span>
          ${color}${rating}
          <span class="chip chip-soft">${esc(p.seller || '')}</span>
        </div>
      </div>

      <div class="kpis">
        <div class="kpi kpi-accent">
          <div class="k-lab">Выручка за период</div>
          <div class="k-val">${money(p.revenue)}</div>
        </div>
        <div class="kpi">
          <div class="k-lab">Продано</div>
          <div class="k-val">${int(p.units)} <span class="k-u">шт</span></div>
        </div>
        <div class="kpi">
          <div class="k-lab">Цена</div>
          <div class="k-val">${int(p.price)} <span class="k-u">₽</span></div>
        </div>
        <div class="kpi" style="background:${st.bg}">
          <div class="k-lab">Остаток <span style="color:${st.col}">· ${st.note}</span></div>
          <div class="k-val" style="color:${st.col}">${int(p.balance)} <span class="k-u">шт</span></div>
        </div>
        <div class="kpi">
          <div class="k-lab">Оборачиваемость</div>
          <div class="k-val">${p.turnoverDays ? int(p.turnoverDays) + ' <span class="k-u">дн</span>' : '—'}</div>
        </div>
      </div>

      <div class="stockrow">
        <span class="sr-item">FBO <b>${int(p.balanceFbo)}</b> · FBS <b>${int(p.balanceFbs)}</b></span>
        <span class="sr-sep">•</span>
        <span class="sr-item">складов: <b>${int(p.warehousesCount)}</b></span>
        <span class="sr-sep">•</span>
        <span class="sr-item">заморожено: <b style="color:${frozenBad ? C.bad : C.ink}">${int(p.frozenPct)}%</b></span>
        <span class="sr-sep">•</span>
        <span class="sr-item">продаж/день: <b>${int(p.salesPerDay)}</b></span>
      </div>

      <div class="metarow">
        <span class="mr-item">выкуп: <b style="color:${p.buyoutPct && p.buyoutPct < 70 ? C.bad : C.ink}">${p.buyoutPct ? int(p.buyoutPct) + '%' : '—'}</b></span>
        <span class="sr-sep">•</span>
        <span class="mr-item">возраст: <b>${fmtAge(p.ageDays)}</b></span>
        <span class="sr-sep">•</span>
        <span class="mr-item">размеры: <b>${p.sizeCount ? int(p.sizeInStock) + '/' + int(p.sizeCount) : '—'}</b></span>
        <span class="sr-sep">•</span>
        <span class="mr-item">реклама: <b style="color:${p.hasAd ? C.accent2 : C.muted}">${adLabel(p)}</b></span>
      </div>

      <div class="sparks">
        <div class="spk-box">
          <div class="spk-lab">Выручка/день ${trendArrow(p.revenueGraph)}</div>
          ${spark(p.revenueGraph, { color: C.accent })}
        </div>
        <div class="spk-box">
          <div class="spk-lab">Остаток ${trendArrow(p.stocksGraph)}</div>
          ${spark(p.stocksGraph, { color: C.accent2 })}
        </div>
        <div class="spk-box">
          <div class="spk-lab">Цена ${trendArrow(p.priceGraph)}</div>
          ${spark(p.priceGraph, { color: C.mid, fill: false })}
        </div>
      </div>
    </div>
  </article>`;
}

export function buildTopProductsHtml({ products, summary }) {
  const title = summary.title || 'Топ товаров Wildberries';
  const period = `${summary.d1} — ${summary.d2} (${summary.days} дн.)`;
  const filt = [
    summary.plus.length ? `плюс: ${summary.plus.join(', ')}` : '',
    summary.minus.length ? `минус: ${summary.minus.join(', ')}` : '',
  ].filter(Boolean).join(' · ');

  const kpiHead = `
    <div class="hkpi"><div class="hk-lab">Выручка ТОП-${summary.shown}</div><div class="hk-val" style="color:${C.accent}">${money(summary.revenueSum)}</div></div>
    <div class="hkpi"><div class="hk-lab">Продано штук</div><div class="hk-val">${int(summary.unitsSum)}</div></div>
    <div class="hkpi"><div class="hk-lab">Средняя цена</div><div class="hk-val">${int(summary.avgPrice)} ₽</div></div>
    <div class="hkpi"><div class="hk-lab">Остаток суммарно</div><div class="hk-val">${int(summary.stockSum)} шт</div></div>
    <div class="hkpi"><div class="hk-lab">Брендов в топе</div><div class="hk-val">${summary.brands.length}</div></div>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: ${C.ink}; background: ${C.soft};
    font-size: 13px; line-height: 1.4; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 22px 20px 34px; }

  /* Шапка */
  .head { border-bottom: 3px solid ${C.accent}; padding-bottom: 14px; margin-bottom: 16px; }
  .brandline { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: ${C.accent}; font-weight: 700; }
  h1 { font-size: 23px; margin: 4px 0 3px; font-weight: 800; letter-spacing: -.01em; }
  .sub { color: ${C.muted}; font-size: 12.5px; }
  .filt { margin-top: 6px; font-size: 11.5px; color: ${C.accent2}; }

  .hkpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 16px 0 18px; }
  .hkpi { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 10px; padding: 10px 11px; min-width: 0; }
  .hk-lab { font-size: 10.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hk-val { font-size: 17px; font-weight: 800; margin-top: 3px; }

  /* Диаграмма выручки */
  .section-t { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: ${C.ink}; margin: 4px 0 9px; }
  .revbars { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 10px; padding: 12px 14px; margin-bottom: 20px; }
  .rb-row { display: grid; grid-template-columns: 20px 1fr 96px; align-items: center; gap: 9px; margin: 5px 0; }
  .rb-rank { font-size: 11px; font-weight: 700; color: ${C.muted}; text-align: center; }
  .rb-track { background: ${C.hair}; border-radius: 5px; height: 12px; overflow: hidden; }
  .rb-fill { height: 100%; border-radius: 5px; }
  .rb-val { font-size: 12px; font-weight: 700; text-align: right; white-space: nowrap; }

  /* Карточки товаров */
  .cards { display: flex; flex-direction: column; gap: 12px; }
  .card {
    position: relative; display: grid; grid-template-columns: 104px 1fr; gap: 14px;
    background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 12px;
    padding: 13px 15px 13px 40px; overflow: visible;
  }
  .card-leader { border-color: ${C.accent}; box-shadow: 0 0 0 1px ${C.accent}; }
  .c-rank {
    position: absolute; top: 12px; left: 11px; width: 22px; height: 22px; border-radius: 7px;
    background: ${C.accent2}; color: #fff; font-weight: 800; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
  }
  .card-leader .c-rank { background: ${C.accent}; }

  /* Фото + hover-zoom */
  .ph { width: 104px; height: 138px; position: relative; z-index: 1; }
  .ph img {
    width: 104px; height: 138px; object-fit: cover; border-radius: 9px; border: 1px solid ${C.hair};
    background: ${C.soft}; display: block; cursor: zoom-in;
    transition: transform .18s ease, box-shadow .18s ease;
    transform-origin: left top;
  }
  .card:hover { z-index: 40; }
  .ph:hover img {
    transform: scale(2.7); z-index: 60; position: relative;
    box-shadow: 0 16px 46px rgba(28,22,34,.4); border-color: ${C.accent};
  }
  .ph-none { width: 104px; height: 138px; border-radius: 9px; border: 1px dashed ${C.hair};
    display: flex; align-items: center; justify-content: center; text-align: center;
    color: ${C.muted}; font-size: 11px; background: ${C.soft}; }

  .c-body { min-width: 0; }
  .c-head { margin-bottom: 9px; }
  .p-name {
    font-size: 14.5px; font-weight: 700; color: ${C.ink}; text-decoration: none;
    display: block; overflow-wrap: anywhere;
  }
  a.p-name:hover { color: ${C.accent}; text-decoration: underline; }
  .c-tags { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 10.5px; padding: 2px 7px; border-radius: 20px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .chip-brand { background: ${C.accent}; color: #fff; font-weight: 700; }
  .chip-soft { background: ${C.soft}; border: 1px solid ${C.hair}; color: ${C.muted}; }

  .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 9px; }
  .kpi { background: ${C.soft}; border: 1px solid ${C.hair}; border-radius: 8px; padding: 7px 8px; min-width: 0; }
  .kpi-accent { background: #fdf0f9; border-color: #f6cceb; }
  .k-lab { font-size: 9.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k-val { font-size: 15px; font-weight: 800; margin-top: 2px; white-space: nowrap; }
  .kpi-accent .k-val { color: ${C.accent}; }
  .k-u { font-size: 10px; font-weight: 600; color: ${C.muted}; }

  .stockrow { font-size: 11.5px; color: ${C.muted}; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .stockrow b { color: ${C.ink}; }
  .sr-sep { color: ${C.hair}; }
  .metarow { font-size: 11.5px; color: ${C.muted}; margin-bottom: 10px; padding: 6px 9px; background: ${C.soft};
    border: 1px solid ${C.hair}; border-radius: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .metarow b { color: ${C.ink}; font-weight: 700; }
  .mr-item { white-space: nowrap; }

  .sparks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .spk-box { background: ${C.soft}; border: 1px solid ${C.hair}; border-radius: 8px; padding: 6px 8px; min-width: 0; }
  .spk-lab { font-size: 10px; color: ${C.muted}; margin-bottom: 2px; font-weight: 600; white-space: nowrap; }
  .spk { width: 100%; height: 34px; display: block; }
  .spk-empty { font-size: 10px; color: ${C.muted}; height: 34px; display: flex; align-items: center; }

  .foot { margin-top: 22px; padding-top: 12px; border-top: 1px solid ${C.hair}; font-size: 10.5px; color: ${C.muted}; }

  @media print {
    body { background: #fff; }
    .wrap { max-width: none; padding: 0 6mm; }
    .card, .revbars, .hkpi { break-inside: avoid; }
    .card:hover .ph img, .ph:hover img { transform: none; box-shadow: none; }
    .card-leader { box-shadow: none; }
  }
  @page { size: A4; margin: 10mm 6mm; }
</style></head>
<body><div class="wrap">
  <div class="head">
    <div class="brandline">Топ товаров · Wildberries · данные MPStats</div>
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(summary.categoryPath)} · период ${esc(period)}</div>
    ${filt ? `<div class="filt">Фильтр — ${esc(filt)}</div>` : ''}
  </div>

  <div class="hkpis">${kpiHead}</div>

  <div class="section-t">Сравнение по выручке</div>
  <div class="revbars">${revenueBars(products)}</div>

  <div class="section-t">Товары — топ-${summary.shown} по выручке</div>
  <div class="cards">${products.map(card).join('')}</div>

  <div class="foot">
    Наведите курсор на фото — оно увеличится. Название товара — ссылка на карточку Wildberries.
    Данные MPStats оценочные (восстановление по остаткам/выкупам), пригодны для сравнения и ранжирования.
    Отобрано ${int(summary.matchedCount)} карточек из ${int(summary.totalInCategory)} в категории; показаны топ-${summary.shown} по выручке.
  </div>
</div></body></html>`;
}
