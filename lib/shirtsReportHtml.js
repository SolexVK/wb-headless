// lib/shirtsReportHtml.js — единый структурированный отчёт по рубашкам (PDF+HTML).
// Секции: рынок, 3 артикула (характеристики/запросы/деньги/отзывы/диагональное
// сканирование), ниша топ-10, расцветки и размеры. Самодостаточный, акцентная схема.

const RU = new Intl.NumberFormat('ru-RU');
const int = (n) => RU.format(Math.round(Number(n) || 0));
function money(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2).replace('.', ',') + ' млрд ₽';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
  if (Math.abs(n) >= 1e3) return int(Math.round(n / 1e3)) + ' тыс ₽';
  return int(n) + ' ₽';
}
const pct = (x) => (Math.round((Number(x) || 0) * 1000) / 10).toString().replace('.', ',') + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const C = {
  ink: '#1c1622', muted: '#6c6577', hair: '#ece7f0', soft: '#faf7fb', panel: '#fff',
  accent: '#cb11ab', accent2: '#7048e8',
  good: '#2f9e44', mid: '#f08c00', bad: '#e03131',
  goodBg: '#e9f7ee', badBg: '#fdecec', accentBg: '#fdf0f9',
};
const SWATCH = { 'белый': '#f2f2f2', 'чёрный': '#222', 'синий': '#2647c4', 'голубой': '#5aa8e0', 'серый': '#9a9a9a', 'бежевый': '#d9c7a3', 'коричневый': '#7b5a3a', 'зелёный': '#3a8a4a', 'красный': '#d13b3b', 'бордовый': '#7a2231', 'розовый': '#e39ac0', 'жёлтый': '#e6c84a', 'оранжевый': '#e08a3a', 'фиолетовый': '#7048e8', 'хаки': '#7c7b53', 'молочный': '#f5efe0', 'кремовый': '#f0e6cf', 'графитовый': '#4a4a55', 'прочее': '#c8c2cf' };
const swatch = (c) => SWATCH[c] || '#c8c2cf';

// Горизонтальный бар доли.
function shareBar(label, share, count, color, extra = '') {
  const w = Math.max(2, share * 100);
  return `<div class="sb-row">
    <div class="sb-lab">${label}</div>
    <div class="sb-track"><div class="sb-fill" style="width:${w}%;background:${color}"></div></div>
    <div class="sb-val">${pct(share)}${count != null ? ` <span class="sb-c">· ${int(count)}</span>` : ''}${extra}</div>
  </div>`;
}

// Мини-распределение звёзд (5→1).
function starsBlock(stars, sampled) {
  const max = Math.max(...Object.values(stars), 1);
  let rows = '';
  for (let s = 5; s >= 1; s--) {
    const n = stars[s] || 0;
    const w = Math.max(1, (n / max) * 100);
    const col = s >= 4 ? C.good : s === 3 ? C.mid : C.bad;
    rows += `<div class="st-row"><span class="st-k">${s}★</span><div class="st-tr"><div class="st-fl" style="width:${w}%;background:${col}"></div></div><span class="st-n">${int(n)}</span></div>`;
  }
  return rows;
}

const STOCK = '#0c8599'; // цвет линии остатка (контраст к фиолетовым столбцам выручки)
const MON = { '01': 'янв', '02': 'фев', '03': 'мар', '04': 'апр', '05': 'май', '06': 'июн', '07': 'июл', '08': 'авг', '09': 'сен', '10': 'окт', '11': 'ноя', '12': 'дек' };
const monLabel = (ym) => { const [y, m] = String(ym).split('-'); return `${MON[m] || m} ${String(y).slice(2)}`; };

// Совмещённая диаграмма: столбцы выручки + линия среднего остатка (по месяцам).
function combinedMonthlyChart(monthly) {
  if (!monthly || monthly.length < 2) return '';
  const maxRev = Math.max(...monthly.map((m) => m.revenue), 1);
  const maxStock = Math.max(...monthly.map((m) => m.stock), 1);
  const n = monthly.length, bw = 100 / n;
  const bars = monthly.map((m, i) => {
    const h = Math.max(2, (m.revenue / maxRev) * 100);
    const peak = m.revenue === maxRev;
    return `<div class="mc-bar" style="left:${(i * bw).toFixed(3)}%;width:${bw.toFixed(3)}%" title="${monLabel(m.label)}: ${money(m.revenue)} · остаток ${int(m.stock)}"><div class="mc-fill" style="height:${h.toFixed(1)}%;background:${peak ? C.accent : C.accent2}"></div></div>`;
  }).join('');
  const pts = monthly.map((m, i) => `${((i + 0.5) * bw).toFixed(2)},${((1 - m.stock / maxStock) * 100).toFixed(2)}`).join(' ');
  const dots = monthly.map((m, i) => `<span class="mc-dot" style="left:${((i + 0.5) * bw).toFixed(2)}%;bottom:${((m.stock / maxStock) * 100).toFixed(1)}%"></span>`).join('');
  const labels = monthly.map((m) => `<div class="mc-lab" style="width:${bw.toFixed(3)}%">${monLabel(m.label)}</div>`).join('');
  return `<div class="art-chart">
    <div class="mc-head"><span class="mc-t">Выручка и остаток по месяцам</span>
      <span class="mc-leg"><i class="lg-bar"></i>выручка<i class="lg-line"></i>остаток</span></div>
    <div class="mc-plot">${bars}<svg class="mc-line" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${STOCK}" stroke-width="1.7" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>${dots}</div>
    <div class="mc-labels">${labels}</div>
  </div>`;
}

const clickBadge = (url, cls, inner) => url
  ? `<a class="lnk" href="${esc(url)}" target="_blank" rel="noopener"><span class="${cls}">${inner}</span></a>`
  : `<span class="${cls}">${inner}</span>`;

// ---------- Блок одного артикула ----------
function articleBlock(a) {
  const m = a.money;
  const chars = a.chars.map((c) => `<span class="chip chip-soft" title="${esc(c.name)}">${esc(c.value)}</span>`).join('');
  const queries = a.queries.map((q) => `<span class="chip chip-q">${esc(q)}</span>`).join('');
  const r = a.reviews;
  const themes = (r.themes || []).slice(0, 4).map((t) =>
    `<div class="th-row"><span class="th-lab">${esc(t.label)}</span><span class="th-n">${int(t.count)}<span class="th-neg"> · нег ${int(t.neg)}</span></span></div>`).join('');
  const improvements = (r.improvements || []).slice(0, 4).map((i) =>
    `<li><b>${esc(i.theme)}.</b> ${esc(i.remedy)}</li>`).join('');
  const neg = (r.topNegatives || [])[0];
  const sizeSig = r.matching?.size ? Object.entries(r.matching.size).map(([k, v]) => `${k} ${v}`).join(' · ') : '';

  const s = a.scan;
  const comps = (s.competitors || []).slice(0, 4).map((c) =>
    `<tr><td>${clickBadge(c.url, 'c-brand', esc(c.brand || '—'))}</td><td>${int(c.price)} ₽</td><td>★${String(c.rating).replace('.', ',')}</td><td>${int(c.reviews)}</td><td>${int(c.sizeCount)}</td></tr>`).join('');
  const gaps = (s.gaps || []).map((g) => `<li>${esc(g.text)}</li>`).join('');
  const img = a.img ? `<img src="${a.img}" alt="фото ${a.sku}"/>` : `<div class="ph-none">нет<br>фото</div>`;

  return `<article class="art">
    <div class="art-head">
      <div class="ph">${clickBadge(a.url, 'ph-wrap', img)}</div>
      <div class="art-id">
        <div class="ids">
          ${clickBadge(a.url, 'sku', 'арт. ' + int(a.sku))}
          ${clickBadge(a.url, 'brand', esc(a.brand || '—'))}
          <span class="chip chip-soft">★ ${String(r.valuation).replace('.', ',')} · ${int(r.total)} отз.</span>
        </div>
        <div class="art-name">${esc(a.name)}</div>
        <div class="money3">
          <div class="mt mt-rev"><span class="mt-l">Выручка за год</span><span class="mt-v">${money(m.revenue)}</span><span class="mt-s">${int(m.units)} шт продано</span></div>
          <div class="mt mt-earn"><span class="mt-l">Заработал ×выкуп</span><span class="mt-v">${m.earned != null ? money(m.earned) : '—'}</span><span class="mt-s">выкуп ${m.buyout ? int(m.buyout) + '%' : '—'}</span></div>
          <div class="mt mt-lost"><span class="mt-l">Упущено</span><span class="mt-v">${money(m.lost)}</span><span class="mt-s">${pct(m.lostShare)} потенциала</span></div>
        </div>
        <div class="art-stats">
          <span class="as as-hi">Средняя цена продажи <b>${int(m.avgPrice)} ₽</b></span>
          <span class="as">Продано <b>${int(m.units)} шт</b></span>
          <span class="as">Выкуп <b>${m.buyout ? int(m.buyout) + '%' : '—'}</b></span>
        </div>
      </div>
    </div>

    <div class="art-meta">
      <div class="mm"><span class="mm-t">Характеристики</span><div class="chips">${chars || '<span class="muted">—</span>'}</div></div>
      <div class="mm"><span class="mm-t">Ключевые запросы</span><div class="chips">${queries || '<span class="muted">—</span>'}</div></div>
    </div>

    ${combinedMonthlyChart(a.monthly)}

    <div class="art-cols">
      <div class="col">
        <div class="col-t">Отзывы · рейтинг ${String(r.valuation).replace('.', ',')} · негатив ${pct(r.negativeShare)}</div>
        <div class="stars">${starsBlock(r.stars, r.sampled)}</div>
        ${sizeSig ? `<div class="sig">Соответствие размеру: ${esc(sizeSig)}</div>` : ''}
        <div class="themes">${themes}</div>
        ${neg ? `<div class="negex">«${esc(neg.text)}»<span class="negex-s"> — ${neg.stars}★${neg.size ? ', ' + esc(neg.size) : ''}</span></div>` : ''}
        <div class="improve"><div class="col-sub">Что доработать</div><ul>${improvements || '<li>Существенных проблем не выделено</li>'}</ul></div>
      </div>
      <div class="col">
        <div class="col-t">Диагональное сканирование${s.ownRank ? ` · позиция ${s.ownRank}` : ' · не в топе выдачи'}</div>
        <div class="col-sub">Реальные конкуренты по запросу</div>
        <table class="ctab"><thead><tr><th>Бренд</th><th>Цена</th><th>Рейт.</th><th>Отз.</th><th>Разм.</th></tr></thead><tbody>${comps || '<tr><td colspan="5" class="muted">нет данных</td></tr>'}</tbody></table>
        <div class="improve"><div class="col-sub">Гэпы и план</div><ul>${gaps || '<li>Существенных разрывов нет</li>'}</ul></div>
      </div>
    </div>
  </article>`;
}

// ---------- Ниша топ-10 ----------
function nicheTop10(top10) {
  const rows = top10.map((p) => {
    const img = p.img ? `<img src="${p.img}" alt=""/>` : `<div class="nt-noimg">—</div>`;
    return `<div class="nt-row">
      <div class="nt-rank">${p.rank}</div>
      <div class="nt-ph">${clickBadge(p.url, 'ph-wrap', img)}</div>
      <div class="nt-main">
        <div class="nt-ids">${clickBadge(p.url, 'sku sku-sm', 'арт. ' + int(p.sku))}${clickBadge(p.url, 'brand brand-sm', esc(p.brand || '—'))}<span class="chip chip-soft">★ ${String(p.rating).replace('.', ',')} · ${int(p.comments)}</span></div>
        <div class="nt-name">${esc(p.name)}</div>
      </div>
      <div class="nt-rev"><span class="nt-l">Выручка/год</span><b>${money(p.revenue)}</b></div>
      <div class="nt-lost"><span class="nt-l">Упущено</span><b>${money(p.lostProfit)}</b></div>
      <div class="nt-price"><span class="nt-l">Цена</span><b>${int(p.price)} ₽</b></div>
    </div>`;
  }).join('');
  return `<div class="nt">${rows}</div>`;
}

export function buildShirtsReportHtml(data, opts = {}) {
  const book = !!opts.book; // книжный (портретный) формат под A4
  const { d1, d2, articles, market } = data;
  const mk = market.market;
  const colors = market.top300.colorDist.slice(0, 8);
  const sizes = market.top300.sizeRange;
  const domSizes = market.dominantSizes.slice(0, 8);
  const maxSizeRange = Math.max(...sizes.map((s) => s.count), 1);

  const marketKpis = `
    <div class="hkpi"><div class="hk-l">Объём рынка (год)</div><div class="hk-v" style="color:${C.accent}">${money(mk.revenueSum)}</div><div class="hk-s">${int(market.withSalesCount)} карточек с продажами</div></div>
    <div class="hkpi"><div class="hk-l">Упущено рынком</div><div class="hk-v" style="color:${C.bad}">${money(mk.lostSum)}</div><div class="hk-s">неудовл. спрос</div></div>
    <div class="hkpi"><div class="hk-l">Доля упущенной</div><div class="hk-v" style="color:${C.mid}">${pct(mk.lostShare)}</div><div class="hk-s">от потенциала рынка</div></div>
    <div class="hkpi"><div class="hk-l">Карточек типа</div><div class="hk-v">${int(market.typeCount)}</div><div class="hk-s">из ${int(market.totalInCategory)} в категории</div></div>`;

  const colorBars = colors.map((c) => shareBar(
    `<span class="sw" style="background:${swatch(c.color)}"></span>${esc(c.color)}`, c.share, c.count, C.accent2)).join('');
  const sizeBars = sizes.map((b) => {
    const w = Math.max(2, (b.count / maxSizeRange) * 100);
    return `<div class="sb-row"><div class="sb-lab">${b.label} разм.</div><div class="sb-track"><div class="sb-fill" style="width:${w}%;background:${C.accent}"></div></div><div class="sb-val">${int(b.count)}</div></div>`;
  }).join('');
  const domSizeBars = domSizes.map((s) => shareBar(esc(s.size), s.share, s.offered, C.accent2)).join('');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Анализ ниши мужских рубашек</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: ${C.ink}; background: ${C.soft}; font-size: 12.5px; line-height: 1.4; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 940px; margin: 0 auto; padding: 20px 18px 30px; }
  .muted { color: ${C.muted}; }

  .head { border-bottom: 3px solid ${C.accent}; padding-bottom: 12px; margin-bottom: 14px; }
  .brandline { font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: ${C.accent}; font-weight: 700; }
  h1 { font-size: 21px; margin: 4px 0 3px; font-weight: 800; }
  .sub { color: ${C.muted}; font-size: 12px; }

  .sec-t { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: ${C.ink}; margin: 22px 0 10px; padding-left: 9px; border-left: 4px solid ${C.accent}; }

  .hkpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; }
  .hkpi { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 10px; padding: 10px 11px; min-width: 0; }
  .hk-l { font-size: 10px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hk-v { font-size: 18px; font-weight: 800; margin: 2px 0; }
  .hk-s { font-size: 10px; color: ${C.muted}; }

  /* Артикул */
  .art { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 12px; padding: 13px 15px; margin-bottom: 12px; overflow: visible; }
  .art-head { display: grid; grid-template-columns: 118px 1fr; gap: 14px; }
  .ph { width: 118px; height: 157px; position: relative; z-index: 1; }
  .ph-wrap { display: block; }
  .ph img { width: 118px; height: 157px; object-fit: cover; border-radius: 9px; border: 1px solid ${C.hair}; background: ${C.soft}; display: block; cursor: zoom-in; transition: transform .18s ease, box-shadow .18s ease; transform-origin: left top; }
  .art:hover { z-index: 30; }
  .ph:hover img { transform: scale(3); z-index: 60; position: relative; box-shadow: 0 16px 46px rgba(28,22,34,.4); border-color: ${C.accent}; }
  .ph-none { width: 118px; height: 157px; border-radius: 9px; border: 1px dashed ${C.hair}; display: flex; align-items: center; justify-content: center; text-align: center; color: ${C.muted}; font-size: 11px; background: ${C.soft}; }
  a.lnk { text-decoration: none; color: inherit; }

  .ids { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .sku { display: inline-block; font-size: 12px; font-weight: 800; color: #fff; background: ${C.accent2}; padding: 3px 8px; border-radius: 6px; }
  a.lnk:hover .sku { background: ${C.accent}; }
  .brand { display: inline-block; font-size: 12px; font-weight: 800; color: ${C.accent}; border: 1.5px solid ${C.accent}; padding: 2px 8px; border-radius: 6px; }
  .sku-sm, .brand-sm { font-size: 11px; padding: 1px 6px; }
  .art-name { font-size: 13.5px; font-weight: 700; margin: 5px 0 8px; overflow-wrap: anywhere; }
  .chip { font-size: 10.5px; padding: 2px 7px; border-radius: 20px; white-space: nowrap; }
  .chip-soft { background: ${C.soft}; border: 1px solid ${C.hair}; color: ${C.muted}; }
  .chip-q { background: ${C.accentBg}; border: 1px solid #f6cceb; color: ${C.accent}; font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 3px; }

  .money3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .mt { border-radius: 9px; padding: 8px 9px; border: 1px solid ${C.hair}; display: flex; flex-direction: column; min-width: 0; }
  .mt-rev { background: ${C.accentBg}; border-color: #f6cceb; }
  .mt-earn { background: ${C.goodBg}; border-color: #cceccf; }
  .mt-lost { background: ${C.badBg}; border-color: #f6cccc; }
  .mt-l { font-size: 9.5px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap; }
  .mt-v { font-size: 16px; font-weight: 800; margin: 1px 0; white-space: nowrap; }
  .mt-rev .mt-v { color: ${C.accent}; } .mt-earn .mt-v { color: ${C.good}; } .mt-lost .mt-v { color: ${C.bad}; }
  .mt-s { font-size: 9.5px; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .art-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; font-size: 11px; color: ${C.muted}; }
  .art-stats .as b { color: ${C.ink}; font-weight: 800; }
  .art-stats .as-hi { background: ${C.accentBg}; border: 1px solid #f6cceb; border-radius: 7px; padding: 3px 9px; color: ${C.accent}; }
  .art-stats .as-hi b { color: ${C.accent}; }
  .art-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 10px 0; padding: 9px 0; border-top: 1px solid ${C.hair}; border-bottom: 1px solid ${C.hair}; }
  .mm-t { font-size: 10px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }

  .art-chart { margin: 10px 0 4px; }
  .mc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
  .mc-t { font-size: 10px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
  .mc-leg { font-size: 9.5px; color: ${C.muted}; display: flex; align-items: center; gap: 4px; }
  .lg-bar { display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: ${C.accent2}; }
  .lg-line { display: inline-block; width: 13px; height: 0; border-top: 2px solid ${STOCK}; margin-left: 7px; position: relative; top: -1px; }
  .mc-plot { position: relative; height: 74px; border-bottom: 1px solid ${C.hair}; }
  .mc-bar { position: absolute; bottom: 0; height: 100%; display: flex; align-items: flex-end; padding: 0 2.5px; }
  .mc-fill { width: 100%; border-radius: 3px 3px 0 0; min-height: 1px; }
  .mc-line { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .mc-dot { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: ${STOCK}; transform: translate(-50%, 50%); }
  .mc-labels { display: flex; margin-top: 2px; }
  .mc-lab { font-size: 8.5px; color: ${C.muted}; text-align: center; overflow: hidden; }

  .art-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .col { min-width: 0; }
  .col-t { font-size: 11.5px; font-weight: 800; color: ${C.ink}; margin-bottom: 6px; }
  .col-sub { font-size: 10px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .03em; margin: 6px 0 3px; }
  .stars { display: flex; flex-direction: column; gap: 2px; margin-bottom: 5px; }
  .st-row { display: grid; grid-template-columns: 22px 1fr 34px; align-items: center; gap: 6px; }
  .st-k { font-size: 10px; color: ${C.muted}; } .st-n { font-size: 10px; text-align: right; }
  .st-tr { background: ${C.hair}; border-radius: 4px; height: 8px; overflow: hidden; } .st-fl { height: 100%; border-radius: 4px; }
  .sig { font-size: 10.5px; color: ${C.muted}; margin-bottom: 4px; }
  .th-row { display: flex; justify-content: space-between; font-size: 11px; padding: 1px 0; }
  .th-neg { color: ${C.bad}; } .th-n { color: ${C.muted}; }
  .negex { font-size: 10.5px; color: ${C.ink}; background: ${C.badBg}; border-radius: 6px; padding: 5px 7px; margin: 5px 0; font-style: italic; }
  .negex-s { color: ${C.bad}; font-style: normal; }
  .improve ul { margin: 2px 0 0; padding-left: 15px; } .improve li { font-size: 10.5px; margin-bottom: 3px; }
  .ctab { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  .ctab th { text-align: left; color: ${C.muted}; font-weight: 600; border-bottom: 1px solid ${C.hair}; padding: 2px 4px; }
  .ctab td { padding: 3px 4px; border-bottom: 1px solid ${C.soft}; white-space: nowrap; }
  .c-brand { color: ${C.accent}; font-weight: 700; }

  /* Ниша топ-10 */
  .nt { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 12px; overflow: hidden; }
  .nt-row { display: grid; grid-template-columns: 26px 46px 1fr 108px 96px 74px; gap: 9px; align-items: center; padding: 8px 12px; border-bottom: 1px solid ${C.soft}; }
  .nt-row:last-child { border-bottom: none; }
  .nt-rank { font-weight: 800; color: ${C.accent2}; text-align: center; }
  .nt-ph { width: 46px; height: 61px; } .nt-ph img { width: 46px; height: 61px; object-fit: cover; border-radius: 6px; border: 1px solid ${C.hair}; transition: transform .16s ease, box-shadow .16s ease; transform-origin: left center; cursor: zoom-in; position: relative; }
  .nt-row:hover { position: relative; z-index: 20; } .nt-ph img:hover { transform: scale(3); z-index: 60; box-shadow: 0 12px 34px rgba(28,22,34,.4); border-color: ${C.accent}; }
  .nt-noimg { width: 46px; height: 61px; border: 1px dashed ${C.hair}; border-radius: 6px; }
  .nt-ids { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .nt-name { font-size: 11px; color: ${C.muted}; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nt-l { display: block; font-size: 9px; color: ${C.muted}; text-transform: uppercase; }
  .nt-rev b, .nt-lost b, .nt-price b { font-size: 12.5px; font-weight: 800; } .nt-rev b { color: ${C.accent}; } .nt-lost b { color: ${C.bad}; }

  /* Расцветки/размеры */
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .card { background: ${C.panel}; border: 1px solid ${C.hair}; border-radius: 12px; padding: 12px 14px; }
  .card-t { font-size: 12px; font-weight: 800; margin-bottom: 9px; }
  .sb-row { display: grid; grid-template-columns: 128px 1fr 78px; gap: 8px; align-items: center; margin: 4px 0; }
  .sb-lab { font-size: 11px; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sw { width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgba(0,0,0,.12); flex: 0 0 auto; }
  .sb-track { background: ${C.hair}; border-radius: 5px; height: 11px; overflow: hidden; } .sb-fill { height: 100%; border-radius: 5px; }
  .sb-val { font-size: 11px; font-weight: 700; text-align: right; white-space: nowrap; } .sb-c { color: ${C.muted}; font-weight: 400; }

  .foot { margin-top: 22px; padding-top: 12px; border-top: 1px solid ${C.hair}; font-size: 10px; color: ${C.muted}; }

  /* --- Книжный (портретный) формат: узкая колонка под A4, плотная упаковка --- */
  body.book { background: #fff; font-size: 11.5px; }
  body.book .wrap { max-width: 700px; padding: 0 2px 12px; }
  body.book h1 { font-size: 19px; }
  body.book .sec-t { margin: 16px 0 8px; font-size: 12px; }
  body.book .hkpis { gap: 7px; }
  body.book .hk-v { font-size: 16px; }
  body.book .art { padding: 11px 12px; margin-bottom: 9px; }
  body.book .art-head { grid-template-columns: 104px 1fr; gap: 11px; }
  body.book .ph, body.book .ph img, body.book .ph-none { width: 104px; height: 138px; }
  body.book .money3 { gap: 6px; }
  body.book .mt { padding: 6px 8px; } body.book .mt-v { font-size: 14px; }
  body.book .art-meta { gap: 10px; }
  body.book .art-cols { gap: 12px; }
  body.book .ctab { font-size: 9.3px; } body.book .ctab th, body.book .ctab td { padding: 2px 3px; }
  body.book .c-brand { display: inline-block; max-width: 82px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  body.book .nt-row { grid-template-columns: 20px 38px 1fr 88px 78px 58px; gap: 7px; padding: 7px 10px; }
  body.book .nt-ph, body.book .nt-ph img, body.book .nt-noimg { width: 38px; height: 51px; }
  body.book .nt-name { font-size: 9.5px; }
  body.book .nt-rev b, body.book .nt-lost b, body.book .nt-price b { font-size: 11px; }
  body.book .sb-row { grid-template-columns: 108px 1fr 70px; }
  body.book .mc-plot { height: 62px; } body.book .mc-lab { font-size: 7.5px; }
  body.book .art-chart { break-inside: avoid; }
  body.book .chip, body.book .chip-q { font-size: 10px; }
  /* Плотная упаковка: крупные блоки могут переноситься, атомарные — целиком. */
  body.book .art, body.book .art-cols, body.book .col, body.book .nt { break-inside: auto; }
  body.book .art-head, body.book .money3, body.book .hkpi, body.book .mt,
  body.book .nt-row, body.book .sb-row, body.book .st-row, body.book .negex,
  body.book .card, body.book .ctab tr { break-inside: avoid; }
  body.book .sec-t { break-after: avoid; break-inside: avoid; }

  @media print {
    body { background: #fff; }
    .wrap { max-width: none; }
    .ph:hover img, .nt-ph img:hover { transform: none; box-shadow: none; }
    .art, .nt-row, .card, .hkpi { break-inside: avoid; }
    body.book .art { break-inside: auto; }
  }
  @page { size: A4 portrait; margin: 9mm 7mm; }
</style></head>
<body class="${book ? 'book' : ''}"><div class="wrap">
  <div class="head">
    <div class="brandline">Анализ ниши · Wildberries · MPStats + публичные данные WB</div>
    <h1>${esc(data.title || 'Анализ ниши — рынок, топ и разбор артикулов')}</h1>
    <div class="sub">${esc(market.categoryPath)} · период ${esc(d1)} — ${esc(d2)} · артикулов в разборе: ${articles.length}<br>
      <span style="font-size:11px">${esc(data.nicheDesc || '')}</span></div>
  </div>

  <div class="sec-t">Рынок ниши</div>
  <div class="hkpis">${marketKpis}</div>

  <div class="sec-t">Ваши 3 артикула — деньги, характеристики, отзывы, диагональное сканирование</div>
  ${articles.map(articleBlock).join('')}

  <div class="sec-t">Ниша: топ-10 по выручке за год</div>
  ${nicheTop10(market.top10)}

  <div class="sec-t">Расцветки и размеры рынка (топ-300)</div>
  <div class="grid2">
    <div class="card"><div class="card-t">Доля расцветок</div>${colorBars}</div>
    <div class="card">
      <div class="card-t">Размерные ряды (ширина ряда, ср. ${market.top300.avgSizeRange.toFixed(1).replace('.', ',')})</div>${sizeBars}
      <div class="card-t" style="margin-top:12px">Преобладающие размеры (выдача)</div>${domSizeBars}
    </div>
  </div>

  <div class="foot">
    Данные MPStats оценочные (восстановление по остаткам/выкупам) — для сравнения и ранжирования; отзывы, характеристики
    и выдача — публичные данные Wildberries. «Заработал» = выручка × % выкупа (выкуп MPStats даёт оценочно на уровне
    категории). «Упущено» — оценка спроса, не удовлетворённого из-за отсутствия товара. «Диагональное сканирование» —
    отбор реальных конкурентов по ключевому запросу (методика конкурентного анализа) и разрывы к ним. Артикул, бренд и
    фото — кликабельны/увеличиваются; ведут на карточку WB.
  </div>
</div></body></html>`;
}
