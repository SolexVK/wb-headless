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

const toneColor = (t) => (t === 'good' ? C.good : t === 'bad' ? C.bad : C.mid);

// --- Заключение: буллеты с цветными маркерами + рекомендация и риск-флаги ---
function conclusionBox(c) {
  if (!c) return '';
  const vc = verdictColor(c.total);
  const pts = (c.points || []).map((p) =>
    `<li><span class="dot" style="background:${toneColor(p.tone)}"></span>${esc(p.text)}</li>`).join('');
  const flags = (c.flags || []).map((f) =>
    `<span class="flag" style="--fc:${f.level === 'stop' ? C.bad : C.mid}">${f.level === 'stop' ? '⛔' : '⚠'} ${esc(f.text)}</span>`).join('');
  return `<div class="concl" style="--vc:${vc}">
    <div class="chead"><span class="ctitle" style="color:var(--vc)">Заключение о входе</span>
      <span class="cbn">узкое место: ${esc(c.bottleneck)}</span></div>
    <ul class="cpts">${pts}</ul>
    ${flags ? `<div class="flags">${flags}</div>` : ''}
    ${c.recommendation ? `<div class="reco"><b>Рекомендация:</b> ${esc(c.recommendation)}</div>` : ''}
  </div>`;
}

// --- SVG: экономика — шкала цены с точкой безубыточности и коридором маржи ---
function economicsSvg(e) {
  if (!e) return '';
  const W = 520, H = 62, padL = 6, axW = 460, y = 26;
  const max = Math.max(e.corridorHi, e.medianPrice) * 1.12 || 1;
  const x = (p) => padL + (p / max) * axW;
  const bandLo = x(e.corridorLo), bandHi = x(e.corridorHi), be = x(e.breakEvenPrice), med = x(e.medianPrice);
  const medCol = e.marginAtMedianPct >= 25 ? C.good : e.marginAtMedianPct > 0 ? C.mid : C.bad;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    <rect x="${padL}" y="${y}" width="${axW}" height="8" rx="4" fill="${C.hair}"/>
    <rect x="${padL}" y="${y}" width="${be - padL}" height="8" rx="4" fill="${C.bad}" opacity="0.35"/>
    <rect x="${bandLo}" y="${y}" width="${Math.max(2, bandHi - bandLo)}" height="8" rx="4" fill="${C.good}"/>
    <line x1="${be}" y1="${y - 6}" x2="${be}" y2="${y + 14}" stroke="${C.bad}" stroke-width="1.5"/>
    <text x="${be}" y="${y - 9}" font-size="8.5" fill="${C.bad}" text-anchor="middle">безубыт. ${int(e.breakEvenPrice)}</text>
    <text x="${(bandLo + bandHi) / 2}" y="${y - 9}" font-size="8.5" fill="${C.good}" text-anchor="middle">коридор ${int(e.corridorLo)}–${int(e.corridorHi)}</text>
    <circle cx="${med}" cy="${y + 4}" r="5" fill="${medCol}" stroke="#fff" stroke-width="1.5"/>
    <text x="${med}" y="${y + 26}" font-size="9" fill="${medCol}" text-anchor="middle" font-weight="700">медиана ${int(e.medianPrice)} · маржа ${e.marginAtMedianPct}%</text>
  </svg>`;
}

// --- SVG: sell-through (метод Овчинникова) как горизонтальный датчик ---
function sellThroughBar(sat) {
  if (sat.sellThroughRatio == null) return '';
  const r = sat.sellThroughRatio;
  const max = Math.max(2.5, r * 1.15);
  const W = 520, H = 46, padL = 4, barW = 380, y = 14;
  const col = r >= 1.5 ? C.good : r >= 0.8 ? C.mid : C.bad;
  const x1 = padL + (1 / max) * barW; // отметка 1.0 (паритет)
  const w = (r / max) * barW;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    <rect x="${padL}" y="${y}" width="${barW}" height="16" rx="8" fill="${C.hair}"/>
    <rect x="${padL}" y="${y}" width="${Math.max(3, w)}" height="16" rx="8" fill="${col}"/>
    <line x1="${x1}" y1="${y - 4}" x2="${x1}" y2="${y + 20}" stroke="${C.muted}" stroke-width="1.5" stroke-dasharray="2 2"/>
    <text x="${x1}" y="${y - 6}" font-size="8.5" fill="${C.muted}" text-anchor="middle">паритет 1.0</text>
    <text x="${padL + barW + 10}" y="${y + 13}" font-size="15" font-weight="800" fill="${col}">${r}×</text>
    <text x="${padL}" y="${H - 2}" font-size="9" fill="${C.muted}">продажи ÷ остаток за период · оборот ${sat.medianTurnoverDays ?? '—'} дн.</text>
  </svg>`;
}

// --- SVG: распределение выручки по ценовым сегментам ---
function priceSegmentsSvg(segs) {
  const list = (segs || []).filter((s) => s.revenue > 0).sort((a, b) => a.minPrice - b.minPrice);
  if (!list.length) return '';
  const W = 520, H = 150, padT = 8, padB = 34, padL = 8;
  const maxRev = Math.max(...list.map((s) => s.revenue));
  const plotH = H - padT - padB, plotW = W - padL - 8;
  const bw = plotW / list.length;
  const topSeg = list.reduce((a, b) => (b.revenue > a.revenue ? b : a), list[0]);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  list.forEach((seg, i) => {
    const h = Math.max(1, (seg.revenue / maxRev) * plotH);
    const x = padL + i * bw + bw * 0.12;
    const w = bw * 0.76;
    const y = padT + plotH - h;
    const isTop = seg === topSeg;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${isTop ? C.accent : C.accent2}" opacity="${isTop ? 1 : 0.55}"/>`;
    // подпись цены — каждые N сегментов, чтобы не сливалось
    if (i % Math.ceil(list.length / 8) === 0 || isTop) {
      s += `<text x="${x + w / 2}" y="${H - 20}" font-size="8" fill="${isTop ? C.accent : C.muted}" text-anchor="middle" transform="rotate(0 ${x + w / 2} ${H - 20})">${int(seg.minPrice)}</text>`;
    }
  });
  s += `<text x="${padL}" y="${H - 6}" font-size="9" fill="${C.muted}">Выручка по цене (₽): пик — <tspan fill="${C.accent}" font-weight="700">${int(topSeg.minPrice)}–${int(topSeg.maxPrice)} ₽</tspan></text>`;
  return s + '</svg>';
}

export function buildNicheHtml(a) {
  const sc = a.score, cap = a.capacity, comp = a.competition, sat = a.saturation, tr = a.trend, seas = a.seasonality;
  const vc = verdictColor(sc.total);

  // Ранжируем фразы по sell-through (метод Овчинникова), затем по спрос:предложению.
  const qAll = (a.queryDemands || []).slice()
    .sort((x, y) => (y.sellThrough?.ratio || 0) - (x.sellThrough?.ratio || 0) || (y.demandSupplyRatio || 0) - (x.demandSupplyRatio || 0));
  const qShownP = qAll.slice(0, 12);
  const stCol = (r) => (r == null ? C.muted : r >= 1.5 ? C.good : r >= 0.8 ? C.mid : C.bad);
  const phraseRows = qShownP.map((q) => {
    const st = q.sellThrough?.ratio;
    const ds = q.demandSupplyRatio;
    return `<tr>
      <td class="ph">${esc(q.query)}</td>
      <td class="num"><span class="pill" style="background:${stCol(st)}1a;color:${stCol(st)}">${st != null ? st + '×' : '—'}</span></td>
      <td class="num">${q.sellThrough?.medianTurnoverDays != null ? q.sellThrough.medianTurnoverDays + ' дн' : '—'}</td>
      <td class="num">${ds != null ? ds.toFixed(1) + ':1' : '—'}</td>
      <td class="num">${int(q.frequency) || '—'}</td>
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

  ${conclusionBox(a.conclusion)}

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
        ${tile('Товаров в нише', int(cap.productsInNiche), C.ink)}
        ${tile('Продавцов / брендов', int(comp.sellersCount) + ' / ' + int(comp.brandsCount), C.ink)}
        ${tile('Процент выкупа', a.buyout != null ? a.buyout + '%' : '—', a.buyout != null && a.buyout < 30 ? C.bad : C.ink)}
        ${tile('Новых в топе (90 дн)', a.topAges ? a.topAges.youngPct90 + '%' : '—', C.ink)}
      </div>
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Реализация остатка — продажи ÷ средний остаток (метод Овчинникова)</div>
      ${sellThroughBar(sat)}
      <div class="cap">${sat.sellThroughRatio == null ? 'нет данных' :
        sat.sellThroughRatio >= 1.5 ? 'Спрос обгоняет остатки — дефицитный, выгодный для входа период.' :
        sat.sellThroughRatio >= 0.8 ? 'Спрос примерно равен предложению.' :
        'Склады переполнены относительно продаж — невыгодно.'}</div>
    </div>
    <div class="card">
      <div class="ctitle">Экономика единицы — маржа и коридор цены</div>
      ${a.economics ? economicsSvg(a.economics) +
        `<div class="cap">Себестоимость ${int(a.economics.cost)} ₽ · вывод: <b style="color:${a.economics.marginAtMedianPct >= 25 ? C.good : a.economics.marginAtMedianPct > 0 ? C.mid : C.bad}">${esc(a.economics.verdict)}</b></div>`
        : '<div class="cap">Задайте себестоимость (NICHE_COST) — посчитаем точку безубыточности и маржинальный коридор.</div>'}
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Сезонность — помесячный индекс</div>
      ${seas && seas.sufficient
        ? seasonalitySvg(seas) +
          `<div class="cap">Сила ${seas.strength} · пик — <b style="color:${C.accent}">${MONTHS[seas.peakMonth]}</b> · спад — ${MONTHS[seas.troughMonth]} · окно входа ≈ <b>${MONTHS[seas.entryMonth]}</b></div>`
        : `<div class="cap">${esc(seas?.note || 'нет данных')}</div>`}
    </div>
    <div class="card">
      <div class="ctitle">Выручка по цене · перспективный сегмент</div>
      ${priceSegmentsSvg(a.priceSegments) || '<div class="cap">нет данных</div>'}
      ${a.priceOpportunity?.opportunity ? `<div class="cap">Недооценён: <b style="color:${C.good}">${int(a.priceOpportunity.opportunity.from)}–${int(a.priceOpportunity.opportunity.to)} ₽</b> — ${int(a.priceOpportunity.opportunity.revenuePerCard)} ₽ на карточку при ${int(a.priceOpportunity.opportunity.items)} конкурентах.</div>` : ''}
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Топ-продавцы (доля выручки ниши)</div>
      <div class="sellers">${sellerRows || '<div class="cap">нет данных</div>'}</div>
      <div class="cap">Лидер: <b>${esc(comp.topSeller)}</b> — ${comp.topSellerSharePct}%.</div>
    </div>
    <div class="card">
      <div class="ctitle">Планка входа — реклама и контент топа</div>
      ${a.adContent ? `<div class="tiles">
        ${tile('В рекламе (топ-50)', a.adContent.adSharePct + '%', a.adContent.adSharePct >= 50 ? C.bad : C.ink)}
        ${tile('Ставка CPM', a.adContent.medianCpm ? int(a.adContent.medianCpm) + ' ₽' : '—', C.ink)}
        ${tile('Фото (медиана)', int(a.adContent.medianPics), C.ink)}
        ${tile('С видео', a.adContent.videoSharePct + '%', C.ink)}
        ${tile('Рейтинг / отзывы', a.adContent.medianRating + ' / ' + int(a.adContent.medianComments), C.ink)}
        ${tile('Негатив (медиана)', a.adContent.medianNegativePct + '%', a.adContent.medianNegativePct >= 20 ? C.mid : C.ink)}
      </div>` : '<div class="cap">нет данных</div>'}
    </div>
  </section>

  ${qShownP.length ? `<section class="card">
    <div class="ctitle">Уточняющие фразы — по реализации остатка ${qAll.length > qShownP.length ? `<span class="cap">(топ ${qShownP.length} из ${qAll.length})</span>` : ''}</div>
    <table class="phrases">
      <thead><tr><th>Запрос</th><th class="num">Реализация</th><th class="num">Оборот</th><th class="num">Спрос:предл.</th><th class="num">Частота</th></tr></thead>
      <tbody>${phraseRows}</tbody>
    </table>
    <div class="cap">Реализация = продажи ÷ средний остаток по ТОП-выдаче (>1.5× — дефицит, выгодно). Оборот — медиана дней распродажи. Спрос:предл. и частота — из Оракула (если заданы).</div>
  </section>` : ''}

  <footer class="foot">
    Сформировано автоматически · ёмкость/насыщенность — по всей нише (ценовые сегменты) · сезонность/тренд — из истории продаж (~6 лет) · ${esc(a.generatedAt || '').slice(0, 10)}
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
  .concl { border:1.5px solid var(--vc); border-left:5px solid var(--vc); border-radius:12px; padding:10px 14px; margin-bottom:12px; background:${C.soft}; break-inside:avoid; }
  .chead { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .cflag { color:#fff; font-weight:800; font-size:12px; text-transform:uppercase; letter-spacing:.02em; padding:2px 10px; border-radius:6px; }
  .cscore { font-weight:800; font-size:14px; color:var(--vc); } .cbn { font-size:10px; color:${C.muted}; }
  .concl .ctitle { font-size:12px; }
  .flags { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .flag { font-size:9.5px; font-weight:600; color:var(--fc); border:1px solid var(--fc); border-radius:6px; padding:1px 7px; }
  .reco { font-size:10.5px; margin-top:8px; padding-top:7px; border-top:1px dashed ${C.hair}; }
  .cpts { margin:0; padding:0; list-style:none; display:grid; grid-template-columns:1fr 1fr; gap:2px 18px; }
  .cpts li { font-size:10.5px; padding:2px 0 2px 16px; position:relative; }
  .dot { position:absolute; left:0; top:5px; width:8px; height:8px; border-radius:50%; }
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
