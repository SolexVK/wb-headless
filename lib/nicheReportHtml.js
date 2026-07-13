// lib/nicheReportHtml.js — компактный HTML-отчёт «Анализ ниши» для печати в PDF.
// Самодостаточный: инлайн-CSS и инлайн-SVG-графики, без внешних ресурсов
// (нужно для офлайн-рендера headless-хромиумом).

const RU = new Intl.NumberFormat('ru-RU');
const int = (n) => RU.format(Math.round(Number(n) || 0));
function money(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' млрд ₽';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн ₽';
  if (Math.abs(n) >= 1e3) return Math.round(n / 1e3) + ' тыс ₽';
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
const stCol = (r) => (r == null ? C.muted : r >= 1.5 ? C.good : r >= 0.8 ? C.mid : C.bad);

// --- SVG: горизонтальные бары скоринга (5 измерений) + КОНКРЕТНЫЕ цифры ---
// Каждое измерение: слева название и реальное значение (не абстрактный балл),
// справа бар с ярлыком и баллом 0–20.
function scoreBarsSvg(blocks, real) {
  const rows = [
    ['Ёмкость', blocks.capacity, real.capacity], ['Сезонность', blocks.seasonality, real.seasonality],
    ['Тренд', blocks.trend, real.trend], ['Конкуренция', blocks.competition, real.competition],
    ['Насыщенность', blocks.saturation, real.saturation],
  ];
  const W = 524, rowH = 46, barX = 250, barW = 198, top = 4;
  const H = top * 2 + rows.length * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  rows.forEach(([title, b, val], i) => {
    const y = top + i * rowH;
    const cy = y + rowH / 2;
    const w = Math.max(2, (b.score / 20) * barW);
    const col = band20(b.score);
    // левая колонка: название + реальное значение (крупнее — удобнее читать)
    s += `<text x="0" y="${cy - 4}" font-size="12.5" font-weight="700" fill="${C.ink}">${esc(title)}</text>`;
    s += `<text x="0" y="${cy + 13}" font-size="11.5" font-weight="600" fill="#413b4a">${esc(val || '')}</text>`;
    // бар
    const by = cy - 9;
    s += `<rect x="${barX}" y="${by}" width="${barW}" height="18" rx="4" fill="${C.hair}"/>`;
    s += `<rect x="${barX}" y="${by}" width="${w}" height="18" rx="4" fill="${col}"/>`;
    s += `<text x="${barX + 8}" y="${by + 13}" font-size="10.5" fill="#fff" font-weight="600">${esc(b.label)}</text>`;
    s += `<text x="${barX + barW + 8}" y="${by + 13}" font-size="11" font-weight="700" fill="${col}">${b.score}/20</text>`;
  });
  return s + '</svg>';
}

// --- SVG: реализация остатка по МЕСЯЦАМ (временнáя диаграмма) ---
// Показывает, В КАКИЕ периоды спрос обгонял предложение (реализация >1 — благоприятно,
// зелёный столбец со стрелкой ↑). Пунктир — паритет 1.0.
function sellThroughTimelineSvg(tl, targetSales) {
  const list = (tl || []).filter((m) => m.ratio != null);
  if (list.length < 2) return '';
  const maxR = Math.max(1.6, ...list.map((m) => m.ratio)) * 1.1;
  // нужен ли ряд «остаток по месяцам» (цель по продажам из рекомендуемого сегмента)
  const showStock = targetSales > 0;
  const W = 520, H = showStock ? 176 : 158, padT = 16, padB = showStock ? 42 : 24, padL = 8;
  const plotH = H - padT - padB, plotW = W - padL - 8;
  const bw = plotW / list.length;
  const y1 = padT + plotH - (1 / maxR) * plotH; // паритет 1.0
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  s += `<line x1="${padL}" y1="${y1}" x2="${W - 8}" y2="${y1}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3"/>`;
  s += `<text x="${W - 6}" y="${y1 - 3}" font-size="8.5" fill="${C.muted}" text-anchor="end">паритет 1.0</text>`;
  list.forEach((m, i) => {
    const h = Math.max(1.5, (m.ratio / maxR) * plotH);
    const x = padL + i * bw + bw * 0.16;
    const w = bw * 0.68;
    const y = padT + plotH - h;
    const col = m.favorable ? C.good : m.ratio >= 0.8 ? C.mid : C.bad;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="${col}"/>`;
    // благоприятный месяц — зелёная стрелка ↑ и значение
    if (m.favorable) {
      s += `<text x="${x + w / 2}" y="${y - 8}" font-size="10" fill="${C.good}" text-anchor="middle" font-weight="700">↑</text>`;
      s += `<text x="${x + w / 2}" y="${y - 1}" font-size="8" fill="${C.good}" text-anchor="middle" font-weight="700">${m.ratio}×</text>`;
    }
    s += `<text x="${x + w / 2}" y="${padT + plotH + 12}" font-size="8.5" fill="${m.favorable ? C.good : C.muted}" font-weight="${m.favorable ? 700 : 400}" text-anchor="middle">${esc(m.label)}</text>`;
    // нужный средний остаток на карточку, чтобы реализовать целевые продажи при этом коэффициенте
    if (showStock && m.ratio > 0) {
      const need = Math.round(targetSales / m.ratio);
      s += `<text x="${x + w / 2}" y="${padT + plotH + 26}" font-size="9" fill="${C.accent2}" font-weight="700" text-anchor="middle">${int(need)}</text>`;
    }
  });
  if (showStock) {
    s += `<text x="${padL}" y="${H - 3}" font-size="8.5" fill="${C.accent2}" font-weight="700">остаток на карточку, шт (для ~${int(targetSales)} продаж/мес в сегменте)</text>`;
  }
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

// --- SVG: распределение выручки по ценовым сегментам ---
// Подсвечивает ОБА рекомендуемых сегмента (opps) — по бэйджу «1»/«2».
function priceSegmentsSvg(segs, opps = []) {
  const list = (segs || []).filter((s) => s.revenue > 0).sort((a, b) => a.minPrice - b.minPrice);
  if (!list.length) return '';
  const W = 520, H = 150, padT = 18, padB = 30, padL = 8;
  const maxRev = Math.max(...list.map((s) => s.revenue));
  const plotH = H - padT - padB, plotW = W - padL - 8;
  const bw = plotW / list.length;
  // ранг рекомендуемого сегмента по совпадению цены (1 или 2)
  const oppRank = (seg) => {
    const idx = opps.findIndex((o) => o.from === seg.minPrice && o.to === seg.maxPrice);
    return idx >= 0 && idx < 2 ? idx + 1 : 0;
  };
  const recCol = [C.accent, C.good]; // #1 маджента, #2 зелёный
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  list.forEach((seg, i) => {
    const h = Math.max(1, (seg.revenue / maxRev) * plotH);
    const x = padL + i * bw + bw * 0.12;
    const w = bw * 0.76;
    const y = padT + plotH - h;
    const rank = oppRank(seg);
    const fill = rank ? recCol[rank - 1] : C.accent2;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${fill}" opacity="${rank ? 1 : 0.5}"/>`;
    if (rank) {
      // бэйдж с номером рекомендации над столбцом
      s += `<circle cx="${x + w / 2}" cy="${y - 8}" r="7" fill="${fill}"/>`;
      s += `<text x="${x + w / 2}" y="${y - 5}" font-size="9" fill="#fff" font-weight="800" text-anchor="middle">${rank}</text>`;
      s += `<text x="${x + w / 2}" y="${H - 18}" font-size="8" fill="${fill}" font-weight="700" text-anchor="middle">${int(seg.minPrice)}</text>`;
    } else if (i % Math.ceil(list.length / 8) === 0) {
      s += `<text x="${x + w / 2}" y="${H - 18}" font-size="8" fill="${C.muted}" text-anchor="middle">${int(seg.minPrice)}</text>`;
    }
  });
  s += `<text x="${padL}" y="${H - 4}" font-size="9" fill="${C.muted}">Выручка по цене (₽) · рекомендуемые сегменты: ` +
    opps.slice(0, 2).map((o, i) => `<tspan fill="${recCol[i]}" font-weight="700">${i + 1}) ${int(o.from)}–${int(o.to)}</tspan>`).join('<tspan fill="' + C.muted + '"> · </tspan>') + `</text>`;
  return s + '</svg>';
}

export function buildNicheHtml(a) {
  const sc = a.score, cap = a.capacity, comp = a.competition, sat = a.saturation, tr = a.trend, seas = a.seasonality;
  const vc = verdictColor(sc.total);
  const k = 30 / (a.period.days || 30); // нормировка периода на месяц
  const revMonth = cap.totalRevenue * k;
  const perActiveMonth = cap.avgRevenuePerActiveProduct * k;

  // Конкретные значения для 5 измерений (не абстрактный балл 0–20).
  const real = {
    capacity: `${money(revMonth)}/мес · ${int(perActiveMonth / 1000)} тыс/живой товар`,
    seasonality: seas?.sufficient ? `размах ${seas.strength} · пик ${MONTHS[seas.peakMonth] || seas.peakMonth}` : 'нет данных',
    trend: tr ? `${tr.growthPct > 0 ? '+' : ''}${tr.growthPct}% г/г${tr.recentYoyPct != null ? ` · 3 мес ${tr.recentYoyPct > 0 ? '+' : ''}${tr.recentYoyPct}%` : ''}` : 'нет данных',
    competition: `монополизация ${Math.round(comp.monopolyPct)}% · ${int(comp.sellersCount)} прод. / ${int(comp.brandsCount)} бр.`,
    saturation: `${sat.withSalesPct}% с продажами`,
  };

  // Уточняющие фразы: сортировка по реализации, затем спрос:предложение.
  const qAll = (a.queryDemands || []).slice()
    .sort((x, y) => (y.sellThrough?.ratio || 0) - (x.sellThrough?.ratio || 0) || (y.demandSupplyRatio || 0) - (x.demandSupplyRatio || 0));
  const qShownP = qAll.slice(0, 12);
  const dsArrow = (ds) => (ds == null ? '' : ds > 1
    ? `<span style="color:${C.good};font-weight:800">↑</span> `
    : ds < 1 ? `<span style="color:${C.bad};font-weight:800">↓</span> ` : '');
  const phraseRows = qShownP.map((q) => {
    const st = q.sellThrough?.ratio;
    const ds = q.demandSupplyRatio;
    const stW = st == null ? 0 : Math.min(100, (st / 3) * 100); // мини-бар: 3× = полная ширина
    return `<tr>
      <td class="ph">${esc(q.query)}</td>
      <td class="real"><div class="mbar"><div class="mbf" style="width:${stW}%;background:${stCol(st)}"></div></div><span class="mval" style="color:${stCol(st)}">${st != null ? st + '×' : '—'}</span></td>
      <td class="num">${q.sellThrough?.medianTurnoverDays != null ? q.sellThrough.medianTurnoverDays + ' дн' : '—'}</td>
      <td class="num">${ds != null ? dsArrow(ds) + ds.toFixed(1) + ':1' : '—'}</td>
      <td class="num">${int(q.frequency) || '—'}</td>
    </tr>`;
  }).join('');

  // Топ-продавцы: бренд + выручка ₽/мес + ссылка на витрину.
  const sellers = (a.sellers || []).slice(0, 6);
  const maxSellerShare = Math.max(...sellers.map((s) => s.revenueSharePct), 1);
  const sellerRows = sellers.map((s) => {
    const revM = (s.revenue || 0) * k;
    const nm = esc(s.seller);
    const name = s.url ? `<a href="${esc(s.url)}" class="slink">${nm} ↗</a>` : nm;
    const brand = s.brand && s.brand !== s.seller ? `<span class="sbrand">бренд: ${esc(s.brand)}</span>` : '';
    return `<div class="srow">
      <div class="sname">${name}${brand}</div>
      <div class="sbar"><div class="sfill" style="width:${(s.revenueSharePct / maxSellerShare) * 100}%"></div></div>
      <div class="sval">${money(revM)}<span class="spct">${s.revenueSharePct}%</span></div>
    </div>`;
  }).join('');

  // Перспективные сегменты — минимум два. Выручка/продажи — по ТОП 1-3 (цель: выйти в ТОП).
  const opps = (a.priceOpportunity?.opportunities || []).slice(0, 2);
  const oppCol = [C.accent, C.good];
  const oppRows = opps.map((o, i) => `<div class="opp">
      <span class="oppn" style="background:${oppCol[i]}">${i + 1}</span>
      <b style="color:${oppCol[i]}">${int(o.from)}–${int(o.to)} ₽</b> — у ТОП 1-3 <b>${money(o.topRevenueMonth)}/мес</b> (${int(o.topSalesMonth)} шт/мес) ·
      ${int(o.items)} конкурентов · ${o.withSalesPct}% с продажами
    </div>`).join('');
  // Цель по продажам для расчёта нужного остатка на диаграмме реализации.
  const stockTargetSales = opps[0]?.topSalesMonth || a.economics?.target?.salesPerCardMonth || 0;

  const ec = a.economics;

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
      <div class="ctitle">Оценка по 5 измерениям — балл и реальные цифры</div>
      ${scoreBarsSvg(sc.blocks, real)}
    </div>
    <div class="card">
      <div class="ctitle">Ключевые цифры</div>
      <div class="tiles">
        ${tile('Выручка ниши / мес', money(revMonth), C.accent)}
        ${tile('Упущенная выручка', money(cap.lostRevenue), C.accent2)}
        ${tile('Товаров в нише', int(cap.productsInNiche), C.ink)}
        ${tile('Продавцов / брендов', int(comp.sellersCount) + ' / ' + int(comp.brandsCount), C.ink)}
        ${tile('Процент выкупа', a.buyout != null ? a.buyout + '%' : '—', a.buyout != null && a.buyout < 30 ? C.bad : C.ink)}
        ${tile('Новых в топе (90 дн)', a.topAges ? a.topAges.youngPct90 + '%' : '—', C.ink)}
      </div>
    </div>
  </section>

  <section class="card">
    <div class="ctitle">Реализация остатка по месяцам — когда спрос обгонял предложение (метод Овчинникова)</div>
    ${sellThroughTimelineSvg(a.sellThroughByMonth, stockTargetSales) || sellThroughGaugeFallback(sat)}
    <div class="cap">Реализация = продажи ÷ средний остаток за месяц. <b style="color:${C.good}">Зелёные столбцы со стрелкой ↑</b> — благоприятные окна (спрос выше предложения, &gt;1.0): в них выгоднее всего продавать и держать запас. Итого за период: <b style="color:${stCol(sat.sellThroughRatio)}">${sat.sellThroughRatio != null ? sat.sellThroughRatio + '×' : '—'}</b> · оборот ${sat.medianTurnoverDays ?? '—'} дн.${stockTargetSales ? ` <b style="color:${C.accent2}">Цифры под столбцами</b> — сколько штук держать на карточке в этот месяц, чтобы при таком коэффициенте реализовать ~${int(stockTargetSales)} продаж/мес (объём ТОП 1-3 рекомендуемого сегмента).` : ''}</div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Экономика единицы — маржа, коридор цены и объём при марже 30%</div>
      ${ec ? economicsSvg(ec) +
        `<div class="cap">Себестоимость ${int(ec.cost)} ₽ · медианная цена продажи в нише ${int(ec.medianPrice)} ₽ · вывод: <b style="color:${ec.marginAtMedianPct >= 25 ? C.good : ec.marginAtMedianPct > 0 ? C.mid : C.bad}">${esc(ec.verdict)}</b></div>` +
        (ec.target && ec.target.competitors
          ? `<div class="etar">При цене <b>${int(ec.target.price)} ₽</b> (целевая маржа 30%) — сегмент ${int(ec.target.segFrom)}–${int(ec.target.segTo)} ₽, ~${int(ec.target.competitors)} конкурентов. Ориентир — <b>ТОП 1-3</b> сегмента (наша цель — выйти в ТОП):<br>
              продажи ~<b style="color:${C.accent}">${int(ec.target.salesPerCardMonth)} шт/мес</b> · выручка ~<b>${money(ec.target.revenuePerCardMonth)}/мес</b> · прибыль ~<b style="color:${C.good}">${money(ec.target.profitPerCardMonth)}/мес</b>.</div>`
          : `<div class="etar">Целевая цена под маржу 30% ≈ <b>${int(ec.target?.price || ec.corridorHi)} ₽</b> (объём по сегменту недоступен — нет ценовых сегментов).</div>`)
        : '<div class="cap">Задайте себестоимость (NICHE_COST) — посчитаем точку безубыточности, маржинальный коридор и достижимый объём.</div>'}
    </div>
    <div class="card">
      <div class="ctitle">Сезонность — помесячный индекс и торговля вне сезона</div>
      ${seas && seas.sufficient
        ? seasonalitySvg(seas) +
          `<div class="cap">Сила ${seas.strength} · пик — <b style="color:${C.accent}">${MONTHS[seas.peakMonth]}</b> · спад — ${MONTHS[seas.troughMonth]} · окно входа ≈ <b>${MONTHS[seas.entryMonth]}</b></div>` +
          (a.offSeason ? `<div class="offs">${esc(a.offSeason.text)}</div>` : '')
        : `<div class="cap">${esc(seas?.note || 'нет данных')}</div>`}
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <div class="ctitle">Выручка по цене · перспективные сегменты (2 лучших)</div>
      ${priceSegmentsSvg(a.priceSegments, opps) || '<div class="cap">нет данных</div>'}
      ${oppRows ? `<div class="opps">${oppRows}</div><div class="cap">Выручка/продажи — по <b>ТОП 1-3</b> сегмента (мы стремимся в ТОП, значит целимся в их результат). Оба сегмента подсвечены на диаграмме. Приоритет дорогим — массовость не нужна.</div>` : ''}
    </div>
    <div class="card">
      <div class="ctitle">Топ-продавцы — выручка, бренд, витрина</div>
      <div class="sellers">${sellerRows || '<div class="cap">нет данных</div>'}</div>
      <div class="cap">Лидер: <b>${esc(comp.topSeller)}</b> — ${comp.topSellerSharePct}% выручки ниши. ₽ — оценка выручки продавца в месяц; ссылка ведёт на витрину продавца на WB.</div>
    </div>
  </section>

  <section class="card">
    <div class="ctitle">Планка входа — ориентиры для будущей карточки (экспресс-анализ топ-50)</div>
    ${a.adContent ? `<div class="tiles tiles3">
      ${tile('Цель по объёму', int(a.adContent.targetSalesMonth) + ' шт/мес', C.accent)}
      ${tile('Конкуренты в рекламе', a.adContent.adSharePct + '%', a.adContent.adSharePct >= 50 ? C.bad : C.ink)}
      ${tile('Фото (медиана)', int(a.adContent.medianPics) + ' шт', C.ink)}
      ${tile('С видео', a.adContent.videoSharePct + '%', C.ink)}
      ${tile('Барьер отзывов', int(a.adContent.medianComments) + ' · ' + a.adContent.medianRating + '★', a.adContent.medianComments >= 3000 ? C.mid : C.ink)}
      ${tile('Размеров / описание', int(a.adContent.medianSizes) + ' / ' + int(a.adContent.medianDescLen) + ' зн.', C.ink)}
    </div>
    <div class="cap">Чтобы попасть в топ, карточка должна перебивать эти медианы: набрать целевой объём продаж, ≥ медианы фото/видео, накопить сопоставимое число отзывов и заполнить размерный ряд и описание.</div>` : '<div class="cap">нет данных</div>'}
  </section>

  ${qShownP.length ? `<section class="card">
    <div class="ctitle">Уточняющие фразы — по реализации остатка ${qAll.length > qShownP.length ? `<span class="cap">(топ ${qShownP.length} из ${qAll.length})</span>` : ''}</div>
    <table class="phrases">
      <thead><tr><th>Запрос</th><th class="real">Реализация</th><th class="num">Оборот</th><th class="num">Спрос:предл.</th><th class="num">Частота</th></tr></thead>
      <tbody>${phraseRows}</tbody>
    </table>
    <div class="cap">Реализация (мини-бар) = продажи ÷ средний остаток по ТОП-выдаче: <b style="color:${C.good}">&gt;1.5×</b> дефицит (выгодно), 0.8–1.5 паритет, <b style="color:${C.bad}">&lt;0.8</b> затоварка. Спрос:предл. — частотность ÷ карточки из Оракула: <b style="color:${C.good}">↑</b> спрос выше предложения, <b style="color:${C.bad}">↓</b> предложение выше спроса.</div>
  </section>` : ''}

  <footer class="foot">
    Сформировано автоматически · ёмкость/насыщенность — по всей нише (ценовые сегменты) · сезонность/тренд — из истории продаж (~6 лет) · ${esc(a.generatedAt || '').slice(0, 10)}
  </footer>
</div>`;
}

// Запасной датчик, если дневных рядов для временнóй диаграммы нет.
function sellThroughGaugeFallback(sat) {
  if (sat.sellThroughRatio == null) return '<div class="cap">нет дневных рядов продаж/остатков для помесячной диаграммы</div>';
  const r = sat.sellThroughRatio;
  const max = Math.max(2.5, r * 1.15);
  const W = 520, H = 46, padL = 4, barW = 380, y = 14;
  const col = stCol(r);
  const x1 = padL + (1 / max) * barW;
  const w = (r / max) * barW;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    <rect x="${padL}" y="${y}" width="${barW}" height="16" rx="8" fill="${C.hair}"/>
    <rect x="${padL}" y="${y}" width="${Math.max(3, w)}" height="16" rx="8" fill="${col}"/>
    <line x1="${x1}" y1="${y - 4}" x2="${x1}" y2="${y + 20}" stroke="${C.muted}" stroke-width="1.5" stroke-dasharray="2 2"/>
    <text x="${x1}" y="${y - 6}" font-size="8.5" fill="${C.muted}" text-anchor="middle">паритет 1.0</text>
    <text x="${padL + barW + 10}" y="${y + 13}" font-size="15" font-weight="800" fill="${col}">${r}×</text>
  </svg>`;
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
  .card { border:1px solid ${C.hair}; border-radius:12px; padding:12px 14px; background:#fff; break-inside:avoid; margin-bottom:12px; }
  .grid2 .card { margin-bottom:0; }
  .concl { border:1.5px solid var(--vc); border-left:5px solid var(--vc); border-radius:12px; padding:10px 14px; margin-bottom:12px; background:${C.soft}; break-inside:avoid; }
  .chead { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .cbn { font-size:10px; color:${C.muted}; }
  .concl .ctitle { font-size:12px; }
  .flags { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .flag { font-size:9.5px; font-weight:600; color:var(--fc); border:1px solid var(--fc); border-radius:6px; padding:1px 7px; }
  .reco { font-size:10.5px; margin-top:8px; padding-top:7px; border-top:1px dashed ${C.hair}; }
  .cpts { margin:0; padding:0; list-style:none; display:grid; grid-template-columns:1fr 1fr; gap:2px 18px; }
  .cpts li { font-size:10.5px; padding:2px 0 2px 16px; position:relative; }
  .dot { position:absolute; left:0; top:5px; width:8px; height:8px; border-radius:50%; }
  .ctitle { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:${C.muted}; margin-bottom:8px; }
  .tiles { display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; }
  .tiles3 { grid-template-columns:1fr 1fr 1fr; }
  .tl { font-size:9.5px; color:${C.muted}; } .tv { font-size:15px; font-weight:800; margin-top:1px; }
  .cap { font-size:9.5px; color:${C.muted}; margin-top:8px; }
  .etar { font-size:10px; margin-top:8px; padding:7px 9px; background:${C.soft}; border:1px solid ${C.hair}; border-radius:8px; line-height:1.45; }
  .offs { font-size:9.5px; margin-top:7px; padding-top:7px; border-top:1px dashed ${C.hair}; color:${C.ink}; line-height:1.45; }
  .opps { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .opp { font-size:10px; padding-left:22px; position:relative; line-height:1.4; }
  .oppn { position:absolute; left:0; top:0; width:15px; height:15px; border-radius:50%; background:${C.good}; color:#fff; font-size:9px; font-weight:800; text-align:center; line-height:15px; }
  .sellers { display:flex; flex-direction:column; gap:7px; }
  .srow { display:grid; grid-template-columns:150px 1fr 92px; align-items:center; gap:8px; }
  .sname { font-size:10.5px; font-weight:600; line-height:1.2; overflow:hidden; }
  .slink { color:${C.accent2}; text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; }
  .sbrand { display:block; font-size:8.5px; font-weight:400; color:${C.muted}; }
  .sbar { height:9px; background:${C.hair}; border-radius:5px; overflow:hidden; }
  .sfill { height:100%; background:linear-gradient(90deg, ${C.accent2}, ${C.accent}); border-radius:5px; }
  .sval { font-size:11px; font-weight:800; text-align:right; color:${C.accent}; line-height:1.15; }
  .sval .spct { display:block; font-size:9px; font-weight:600; color:${C.muted}; }
  table.phrases { width:100%; border-collapse:collapse; margin-top:2px; }
  table.phrases th { font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:${C.muted}; text-align:left; padding:4px 6px; border-bottom:1.5px solid ${C.hair}; }
  table.phrases td { font-size:10.5px; padding:4px 6px; border-bottom:1px solid ${C.soft}; }
  .num { text-align:right; } td.num { text-align:right; } th.num { text-align:right; }
  .real { width:120px; } th.real { text-align:left; }
  td.real { }
  .mbar { display:inline-block; vertical-align:middle; width:64px; height:8px; background:${C.hair}; border-radius:4px; overflow:hidden; margin-right:6px; }
  .mbf { height:100%; border-radius:4px; }
  .mval { font-weight:800; font-size:10.5px; vertical-align:middle; }
  .ph { font-weight:600; }
  .foot { font-size:8.5px; color:${C.muted}; border-top:1px solid ${C.hair}; padding-top:6px; margin-top:6px; }
</style></head><body>${buildNicheHtml(a)}</body></html>`;
}
