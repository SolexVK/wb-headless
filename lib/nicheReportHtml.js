// lib/nicheReportHtml.js — компактный HTML-отчёт «Анализ ниши» для печати в PDF.
// Самодостаточный: инлайн-CSS и инлайн-SVG-графики, без внешних ресурсов
// (нужно для офлайн-рендера headless-хромиумом).

const RU = new Intl.NumberFormat('ru-RU');
const int = (n) => RU.format(Math.round(Number(n) || 0));
function money(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' млрд ₽';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
  return int(n) + ' ₽';
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Палитра: акцент — WB-маджента, поддержка — фиолетовый; светофор для оценок.
const C = {
  ink: '#1c1622', muted: '#6c6577', hair: '#ece7f0', soft: '#faf6fb',
  accent: '#cb11ab', accent2: '#7048e8',
  good: '#2f9e44', mid: '#f08c00', bad: '#e03131',
};
const MONTHS = { '01': 'янв', '02': 'фев', '03': 'мар', '04': 'апр', '05': 'май', '06': 'июн', '07': 'июл', '08': 'авг', '09': 'сен', '10': 'окт', '11': 'ноя', '12': 'дек' };

const band20 = (s) => (s >= 14 ? C.good : s >= 9 ? C.mid : C.bad);
const verdictColor = (t) => (t >= 70 ? C.good : t >= 45 ? C.mid : C.bad);
const ratioColor = (r) => (r >= 3 ? C.good : r >= 1 ? C.mid : C.bad);

// --- SVG: горизонтальные бары скоринга (5 измерений) ---
function scoreBarsSvg(blocks) {
  const rows = [
    ['Ёмкость', blocks.capacity], ['Сезонность', blocks.seasonality], ['Тренд', blocks.trend],
    ['Конкуренция', blocks.competition], ['Насыщенность', blocks.saturation],
  ];
  const W = 520, rowH = 30, padL = 118, barW = 300, top = 6;
  const H = top * 2 + rows.length * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  rows.forEach(([title, b], i) => {
    const y = top + i * rowH + 4;
    const w = Math.max(2, (b.score / 20) * barW);
    const col = band20(b.score);
    s += `<text x="0" y="${y + 13}" font-size="12" font-weight="600" fill="${C.ink}">${esc(title)}</text>`;
    s += `<rect x="${padL}" y="${y}" width="${barW}" height="18" rx="4" fill="${C.hair}"/>`;
    s += `<rect x="${padL}" y="${y}" width="${w}" height="18" rx="4" fill="${col}"/>`;
    s += `<text x="${padL + barW + 8}" y="${y + 13}" font-size="11" font-weight="700" fill="${col}">${b.score}/20</text>`;
    s += `<text x="${padL + 8}" y="${y + 13}" font-size="10.5" fill="#fff" font-weight="600">${esc(b.label)}</text>`;
  });
  return s + '</svg>';
}

// --- SVG: помесячная сезонность (индекс к среднегодовому) ---
function seasonalitySvg(seas) {
  if (!seas || !seas.sufficient || !seas.months?.length) return '';
  const W = 520, H = 150, padL = 24, padB = 22, padT = 10;
  const months = seas.months;
  const maxIdx = Math.max(...months.map((m) => m.index), 1.2);
  const plotH = H - padB - padT, plotW = W - padL - 8;
  const bw = plotW / months.length;
  const y0 = padT + plotH; // baseline (0)
  const yFor = (v) => padT + plotH - (v / maxIdx) * plotH;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  // линия среднегодового уровня (index=1)
  const y1 = yFor(1);
  s += `<line x1="${padL}" y1="${y1}" x2="${W - 8}" y2="${y1}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3"/>`;
  s += `<text x="${W - 6}" y="${y1 - 3}" font-size="9" fill="${C.muted}" text-anchor="end">среднегод. 1.0</text>`;
  months.forEach((m, i) => {
    const x = padL + i * bw + bw * 0.16;
    const w = bw * 0.68;
    const h = Math.max(1, y0 - yFor(m.index));
    const isPeak = m.month === seas.peakMonth;
    const isTrough = m.month === seas.troughMonth;
    const col = isPeak ? C.accent : isTrough ? C.hair : m.index >= 1 ? C.accent2 : '#c7bfd6';
    s += `<rect x="${x}" y="${yFor(m.index)}" width="${w}" height="${h}" rx="2.5" fill="${col}"/>`;
    s += `<text x="${x + w / 2}" y="${H - 8}" font-size="9" fill="${isPeak ? C.accent : C.muted}" font-weight="${isPeak ? 700 : 400}" text-anchor="middle">${MONTHS[m.month] || m.month}</text>`;
    if (isPeak || isTrough) s += `<text x="${x + w / 2}" y="${yFor(m.index) - 3}" font-size="8.5" fill="${col === C.hair ? C.muted : col}" text-anchor="middle" font-weight="700">${m.index.toFixed(2)}</text>`;
  });
  return s + '</svg>';
}

function tile(label, value, accent) {
  return `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv" style="color:${accent || C.ink}">${value}</div></div>`;
}

export function buildNicheHtml(a) {
  const sc = a.score, cap = a.capacity, comp = a.competition, sat = a.saturation, tr = a.trend, seas = a.seasonality;
  const vc = verdictColor(sc.total);
  const qds = (a.queryDemands || []).filter((q) => q.demandSupplyRatio != null)
    .sort((x, y) => y.demandSupplyRatio - x.demandSupplyRatio);
  const qShown = qds.slice(0, 12);

  const phraseRows = qShown.map((q) => {
    const col = ratioColor(q.demandSupplyRatio);
    return `<tr>
      <td class="ph">${esc(q.query)}</td>
      <td class="num">${int(q.frequency)}</td>
      <td class="num">${int(q.supplyCards)}</td>
      <td class="num"><span class="pill" style="background:${col}1a;color:${col}">${q.demandSupplyRatio.toFixed(1)}:1</span></td>
      <td class="mono" style="color:${col}">${esc(q.ratioVerdict)}</td>
    </tr>`;
  }).join('');

  const sellers = (a.sellers || []).slice(0, 6);
  const maxSellerShare = Math.max(...sellers.map((s) => s.revenueSharePct), 1);
  const sellerRows = sellers.map((s) => `
    <div class="srow">
      <div class="sname">${esc(s.seller)}</div>
      <div class="sbar"><div class="sfill" style="width:${(s.revenueSharePct / maxSellerShare) * 100}%"></div></div>
      <div class="sval">${s.revenueSharePct}%</div>
    </div>`).join('');

  const trendTxt = tr
    ? `${tr.growthPct > 0 ? '+' : ''}${tr.growthPct}% ${tr.basis === 'yoy' ? 'год к году' : ''}` +
      (tr.recentYoyPct != null ? ` · послед. 3 мес ${tr.recentYoyPct > 0 ? '+' : ''}${tr.recentYoyPct}%` : '')
    : '—';

  return `<div class="page">
  <header class="hdr">
    <div class="hleft">
      <div class="kicker">Анализ ниши · Wildberries</div>
      <h1>${esc(a.categoryPath)}</h1>
      <div class="sub">Период ${esc(a.period.d1)} — ${esc(a.period.d2)} · данные MPStats (оценочные)</div>
    </div>
    <div class="verdict" style="--vc:${vc}">
      <div class="vscore">${sc.total}<span>/100</span></div>
      <div class="vword">${esc(sc.verdict)}</div>
      <div class="vbn">узкое место: ${esc(sc.bottleneck)}</div>
    </div>
  </header>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Оценка по 5 измерениям</div>
      ${scoreBarsSvg(sc.blocks)}
    </div>
    <div class="card">
      <div class="ctitle">Ключевые цифры</div>
      <div class="tiles">
        ${tile('Выручка ниши / мес', money(cap.totalRevenue * 30 / (a.period.days || 30)), C.accent)}
        ${tile('Упущенная выручка', money(cap.lostRevenue), C.accent2)}
        ${tile('Насыщенность', sat.withSalesPct + '%', band20(sc.blocks.saturation.score))}
        ${tile('Монополизация топ-10', comp.monopolyPct + '%', band20(sc.blocks.competition.score))}
        ${tile('Тренд выручки', trendTxt, tr && tr.direction === 'up' ? C.good : tr && tr.direction === 'down' ? C.bad : C.ink)}
        ${tile('Цена медиана', int(cap.medianPrice) + ' ₽', C.ink)}
        ${tile('Продавцов / брендов', int(comp.sellersCount) + ' / ' + int(comp.brandsCount), C.ink)}
        ${tile('Товаров в нише', int(cap.productsInNiche), C.ink)}
      </div>
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Сезонность — помесячный индекс</div>
      ${seas && seas.sufficient
        ? seasonalitySvg(seas) +
          `<div class="cap">Сила ${seas.strength} (${esc(sc.blocks.seasonality.label)}) · пик — <b style="color:${C.accent}">${MONTHS[seas.peakMonth]}</b> · спад — ${MONTHS[seas.troughMonth]} · окно входа ≈ <b>${MONTHS[seas.entryMonth]}</b></div>`
        : `<div class="cap">${esc(seas?.note || 'нет данных')}</div>`}
    </div>
    <div class="card">
      <div class="ctitle">Топ-продавцы (доля выручки ниши)</div>
      <div class="sellers">${sellerRows || '<div class="cap">нет данных</div>'}</div>
      <div class="cap">Лидер: <b>${esc(comp.topSeller)}</b> — ${comp.topSellerSharePct}% · медиана отзывов у топ-20: ${int(comp.medianTopComments)}</div>
    </div>
  </section>

  ${qShown.length ? `<section class="card">
    <div class="ctitle">Уточняющие фразы — спрос : предложение ${qds.length > qShown.length ? `<span class="cap">(топ ${qShown.length} из ${qds.length})</span>` : ''}</div>
    <table class="phrases">
      <thead><tr><th>Запрос</th><th class="num">Частота</th><th class="num">Карточек</th><th class="num">Спрос:предл.</th><th>Вывод</th></tr></thead>
      <tbody>${phraseRows}</tbody>
    </table>
    <div class="cap">Порог: ≥10:1 «спрос превышает», 3–10 «умеренный», &lt;3 «предложение насыщено». Частота и кол-во карточек — из Оракула Wildbox.</div>
  </section>` : ''}

  <footer class="foot">
    Сформировано автоматически · ёмкость/насыщенность — по всей нише (ценовые сегменты) · сезонность/тренд — из истории trends (~6 лет) · ${esc(a.generatedAt || '').slice(0, 10)}
  </footer>
</div>`;
}

// Полный HTML-документ (обёртка со стилями) — для рендера в PDF.
export function nicheHtmlDocument(a) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Анализ ниши — ${esc(a.categoryPath)}</title>
<style>
  @page { size: A4; margin: 12mm 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html,body { margin:0; padding:0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color:${C.ink}; font-size:12px; line-height:1.35; }
  .page { max-width: 190mm; margin:0 auto; }
  .hdr { display:flex; justify-content:space-between; align-items:stretch; gap:14px; padding-bottom:12px; border-bottom:3px solid ${C.accent}; margin-bottom:14px; }
  .kicker { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:${C.accent}; font-weight:700; }
  h1 { font-size:22px; margin:3px 0 2px; font-weight:800; letter-spacing:-.01em; }
  .sub { font-size:11px; color:${C.muted}; }
  .verdict { min-width:150px; border-radius:12px; padding:10px 14px; color:#fff; background:linear-gradient(135deg, var(--vc), color-mix(in srgb, var(--vc) 72%, #000)); text-align:right; display:flex; flex-direction:column; justify-content:center; }
  .vscore { font-size:30px; font-weight:800; line-height:1; } .vscore span { font-size:14px; opacity:.8; font-weight:600; }
  .vword { font-size:15px; font-weight:800; text-transform:uppercase; letter-spacing:.02em; margin-top:2px; }
  .vbn { font-size:9.5px; opacity:.92; margin-top:2px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px; }
  .card { border:1px solid ${C.hair}; border-radius:12px; padding:12px 14px; background:#fff; break-inside:avoid; }
  .ctitle { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:${C.muted}; margin-bottom:8px; }
  .tiles { display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; }
  .tile { }
  .tl { font-size:9.5px; color:${C.muted}; } .tv { font-size:15px; font-weight:800; margin-top:1px; }
  .cap { font-size:9.5px; color:${C.muted}; margin-top:8px; }
  .sellers { display:flex; flex-direction:column; gap:5px; }
  .srow { display:grid; grid-template-columns:120px 1fr 34px; align-items:center; gap:8px; }
  .sname { font-size:10.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sbar { height:9px; background:${C.hair}; border-radius:5px; overflow:hidden; }
  .sfill { height:100%; background:linear-gradient(90deg, ${C.accent2}, ${C.accent}); border-radius:5px; }
  .sval { font-size:10px; font-weight:700; text-align:right; color:${C.accent}; }
  table.phrases { width:100%; border-collapse:collapse; margin-top:2px; }
  table.phrases th { font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:${C.muted}; text-align:left; padding:4px 6px; border-bottom:1.5px solid ${C.hair}; }
  table.phrases td { font-size:10.5px; padding:4px 6px; border-bottom:1px solid ${C.soft}; }
  .num { text-align:right; } td.num { text-align:right; } th.num { text-align:right; }
  .ph { font-weight:600; }
  .mono { font-size:9.5px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:20px; font-weight:800; font-size:10px; }
  .foot { font-size:8.5px; color:${C.muted}; border-top:1px solid ${C.hair}; padding-top:6px; margin-top:6px; }
</style></head><body>${buildNicheHtml(a)}</body></html>`;
}
