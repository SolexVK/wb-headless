// lib/finesReportHtml.js — цветной структурированный отчёт по штрафам WB для печати в PDF.
//
// Самодостаточный HTML: инлайн-CSS и инлайн-SVG, без внешних ресурсов — так его
// печатает headless-хромиум (lib/renderPdf.js) без сети и шрифтов извне.
//
// Отчёт отвечает на один вопрос: «за что и по чьей вине списали деньги».
// Поэтому он не таблица, а разбор: сводка с инфографикой → объяснение каждой
// причины → детализация, сгруппированная по фулфилменту (FBS) и по поставке (FBW).
// В каждой строке — номер заявки / номер поставки, склад, дата и суть претензии.

const RU = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => RU.format(Number(v) || 0) + ' ₽';
const int = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function dmy(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]} ${MON[+m[2] - 1]} ${m[1]}` : '—';
}
function dm(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}` : '—';
}

// Палитра как в остальных отчётах: WB-маджента + фиолетовый, светофор для оценок.
const C = {
  ink: '#1c1622', muted: '#6c6577', hair: '#ece7f0', soft: '#faf6fb',
  accent: '#cb11ab', accent2: '#7048e8',
  good: '#2f9e44', mid: '#f08c00', bad: '#e03131', info: '#1971c2',
};

// Что означает каждая формулировка WB и на что смотреть.
const REASONS = {
  'Штраф МП. Невыполненный заказ (отмена продавцом)': {
    short: 'Отмена заказа продавцом',
    color: C.bad,
    what: 'Покупатель оформил заказ FBS, сборочное задание ушло на фулфилмент, но заказ не был выполнен и его отменили на нашей стороне.',
    why: 'Обычная причина — товара физически нет на складе, где он числился, либо задание не собрали в срок отгрузки.',
    watch: 'Удержание символическое, вся тяжесть — в количестве. Смотреть надо не на сумму, а на то, какой фулфилмент даёт поток отмен.',
  },
  'Платное хранение возвратов на ПВЗ более 3 дней': {
    short: 'Хранение возвратов на ПВЗ',
    color: C.mid,
    what: 'Покупатель вернул товар, возврат приехал в пункт выдачи или сортировочный центр и пролежал там дольше трёх дней.',
    why: 'Возврат не забрали и не отправили обратно на склад вовремя — WB берёт плату за каждый день сверх лимита.',
    watch: 'Тариф в этой выгрузке — 21,17 ₽ или 31,75 ₽ за единицу. Это основная сумма удержаний за период.',
  },
};
const reasonOf = (t) => REASONS[t] || { short: t, color: C.muted, what: '', why: '', watch: '' };

// ── SVG: доля суммы по типам штрафа (одна полоса + легенда) ──────────────────
function shareBarSvg(groups, total) {
  const W = 520, H = 30;
  let x = 0, s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  for (const g of groups) {
    const w = Math.max(2, (g.sum / total) * W);
    s += `<rect x="${x.toFixed(1)}" y="6" width="${w.toFixed(1)}" height="18" rx="3" fill="${g.color}"/>`;
    const pct = (g.sum / total) * 100;
    if (w > 60) s += `<text x="${(x + w / 2).toFixed(1)}" y="19" font-size="10.5" font-weight="700" fill="#fff" text-anchor="middle">${pct.toFixed(1).replace('.', ',')}%</text>`;
    x += w;
  }
  return s + '</svg>';
}

// ── SVG: горизонтальные бары «кто сколько» ───────────────────────────────────
// Бар — по количеству случаев; справа сумма. Так видно и частоту, и деньги.
function barsSvg(rows, { unit = 'шт', color = C.accent, showMoney = true } = {}) {
  if (!rows.length) return '';
  const W = 520, rowH = 26, labelW = 190, barX = labelW + 8, barW = W - barX - (showMoney ? 96 : 40);
  const max = Math.max(...rows.map((r) => r.n));
  const H = rows.length * rowH + 4;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const cy = y + 11;
    const w = Math.max(3, (r.n / max) * barW);
    const col = r.color || color;
    const label = r.label.length > 34 ? r.label.slice(0, 33) + '…' : r.label;
    s += `<text x="0" y="${cy + 4}" font-size="11" font-weight="600" fill="${C.ink}">${esc(label)}</text>`;
    s += `<rect x="${barX}" y="${y + 2}" width="${barW}" height="17" rx="4" fill="${C.hair}"/>`;
    s += `<rect x="${barX}" y="${y + 2}" width="${w.toFixed(1)}" height="17" rx="4" fill="${col}"/>`;
    // На коротком баре подпись внутрь не влезает — выносим её наружу тёмным цветом.
    const inside = w > 52;
    s += `<text x="${(barX + (inside ? 7 : w + 7)).toFixed(1)}" y="${cy + 4}" font-size="10.5" font-weight="700" fill="${inside ? '#fff' : col}">${int(r.n)} ${unit}</text>`;
    if (showMoney) s += `<text x="${W}" y="${cy + 4}" font-size="11" font-weight="700" fill="${col}" text-anchor="end">${money(r.sum)}</text>`;
  });
  return s + '</svg>';
}

// ── SVG: календарь дней — сколько случаев в какой день ───────────────────────
function daysSvg(days) {
  if (days.length < 2) return '';
  const W = 520, H = 96, padB = 22, padT = 14;
  const plotH = H - padB - padT;
  const max = Math.max(...days.map((d) => d.n));
  const bw = W / days.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  days.forEach((d, i) => {
    const h = Math.max(2, (d.n / max) * plotH);
    const x = i * bw + bw * 0.2;
    const w = bw * 0.6;
    const y = padT + plotH - h;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${C.accent2}"/>`;
    s += `<text x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" font-weight="700" fill="${C.accent2}" text-anchor="middle">${d.n}</text>`;
    s += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" font-size="9.5" fill="${C.muted}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return s + '</svg>';
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
const sum = (rows) => rows.reduce((s, r) => s + (Number(r.penalty) || 0), 0);

// ── Тело отчёта ──────────────────────────────────────────────────────────────
export function buildFinesHtml(rows, meta = {}) {
  const total = sum(rows);
  const dates = rows.map((r) => r.saleDate).filter(Boolean).sort();
  const period = dates.length ? `${dmy(dates[0])} — ${dmy(dates[dates.length - 1])}` : '—';

  // Сводка по типам штрафа.
  const byType = [...groupBy(rows, (r) => r.type || '—').entries()]
    .map(([type, list]) => ({ type, list, n: list.length, sum: sum(list), color: reasonOf(type).color }))
    .sort((a, b) => b.sum - a.sum);

  // FBS: разбивка по нашим фулфилментам.
  const fbs = rows.filter((r) => r.channel === 'FBS');
  const byFf = [...groupBy(fbs, (r) => r.ff || 'не определён').entries()]
    .map(([label, list]) => ({ label, list, n: list.length, sum: sum(list) }))
    .sort((a, b) => b.n - a.n);

  // FBW: разбивка по поставкам и по складам сдачи.
  const fbw = rows.filter((r) => r.channel === 'FBW');
  const bySupply = [...groupBy(fbw, (r) => String(r.supply)).entries()]
    .map(([id, list]) => ({ id, list, n: list.length, sum: sum(list), drop: list[0].supplyDropOff, dest: list[0].supplyDest, info: list[0].supplyInfo, ff: list[0].ff }))
    .sort((a, b) => b.sum - a.sum);
  const byDrop = [...groupBy(fbw, (r) => r.supplyDropOff || '—').entries()]
    .map(([label, list]) => ({ label, list, n: list.length, sum: sum(list), color: C.mid }))
    .sort((a, b) => b.sum - a.sum);

  // Динамика по дням.
  const byDay = [...groupBy(rows, (r) => r.saleDate || '—').entries()]
    .map(([d, list]) => ({ label: dm(d), d, n: list.length, sum: sum(list) }))
    .sort((a, b) => String(a.d).localeCompare(String(b.d)));

  const ffCount = byFf.filter((g) => g.label !== 'не определён').length;
  const unknown = rows.filter((r) => !r.ff);

  let h = '';

  // ── Шапка ──
  h += `<div class="hdr">
    <div>
      <div class="kicker">Wildberries · разбор удержаний</div>
      <h1>Штрафы: за что и по чьей вине</h1>
      <div class="sub">Период продаж ${esc(period)} · источник: детализация к отчёту о реализации${meta.file ? ' · ' + esc(meta.file) : ''}</div>
    </div>
    <div class="total">
      <div class="tlbl">Удержано всего</div>
      <div class="tval">${money(total)}</div>
      <div class="tsub">${int(rows.length)} ${plural(rows.length, 'строка', 'строки', 'строк')} · ${byType.length} ${plural(byType.length, 'тип', 'типа', 'типов')}</div>
    </div>
  </div>`;

  // ── KPI ──
  h += `<div class="kpis">
    ${kpi('Основная причина', reasonOf(byType[0].type).short, money(byType[0].sum), byType[0].color)}
    ${kpi('Фулфилментов затронуто', String(ffCount), `${int(fbs.length)} ${plural(fbs.length, 'случай', 'случая', 'случаев')} FBS`, C.accent)}
    ${kpi('Поставок FBW', String(bySupply.length), `${int(fbw.length)} ${plural(fbw.length, 'случай', 'случая', 'случаев')}`, C.accent2)}
    ${kpi('ФФ не определён', money(sum(unknown)), unknown.length ? `${int(unknown.length)} ${plural(unknown.length, 'строка', 'строки', 'строк')} — нужен реестр` : 'все строки закрыты', unknown.length ? C.mid : C.good)}
  </div>`;

  // ── Распределение суммы ──
  h += `<div class="card">
    <div class="ctitle">Куда ушли деньги</div>
    ${shareBarSvg(byType, total)}
    <div class="legend">${byType.map((g) => `<span class="lg"><i style="background:${g.color}"></i>${esc(reasonOf(g.type).short)} — <b>${money(g.sum)}</b> · ${int(g.n)} ${plural(g.n, 'случай', 'случая', 'случаев')}</span>`).join('')}</div>
  </div>`;

  // ── Причины ──
  h += `<div class="card"><div class="ctitle">Что случилось</div><div class="reasons">`;
  for (const g of byType) {
    const R = reasonOf(g.type);
    h += `<div class="reason" style="--rc:${g.color}">
      <div class="rhead"><span class="rdot"></span><span class="rname">${esc(R.short)}</span><span class="rsum">${money(g.sum)} · ${int(g.n)} ${plural(g.n, 'случай', 'случая', 'случаев')}</span></div>
      <div class="rwb">${esc(g.type)}</div>
      <div class="rtxt"><b>Что произошло.</b> ${esc(R.what)}</div>
      <div class="rtxt"><b>Почему.</b> ${esc(R.why)}</div>
      <div class="rtxt rwatch">${esc(R.watch)}</div>
    </div>`;
  }
  h += `</div></div>`;

  // ── Инфографика по ФФ и складам ──
  h += `<div class="card"><div class="ctitle">Отмены FBS по фулфилментам</div>
    ${barsSvg(byFf.map((g) => ({ label: g.label, n: g.n, sum: g.sum, color: g.label === 'не определён' ? C.muted : C.bad })))}
    <div class="cap">Бар — количество отмен, справа — удержанная сумма. Фулфилмент определён по номеру сборочного задания.</div>
  </div>`;

  if (byDrop.length) {
    h += `<div class="card"><div class="ctitle">Хранение возвратов FBW по складу сдачи поставки</div>
      ${barsSvg(byDrop)}
      <div class="cap">Склад, куда физически сдавали поставку. Какой фулфилмент её собирал, Wildberries не хранит — см. раздел с поставками.</div>
    </div>`;
  }

  h += `<div class="card"><div class="ctitle">Динамика по дням</div>${daysSvg(byDay)}
    <div class="cap">Количество удержаний по дате продажи.</div></div>`;

  // ── Детализация FBS ──
  if (fbs.length) {
    h += `<div class="sec">Детализация · отмены заказов FBS</div>`;
    for (const g of byFf) {
      const col = g.label === 'не определён' ? C.muted : C.bad;
      h += `<div class="card grp" style="--gc:${col}">
        <div class="ghead">
          <div class="gname">${esc(g.label)}</div>
          <div class="gmeta">${int(g.n)} ${plural(g.n, 'отмена', 'отмены', 'отмен')} · ${money(g.sum)}</div>
        </div>
        <div class="items">`;
      for (const r of g.list.sort((a, b) => String(a.saleDate).localeCompare(String(b.saleDate)))) {
        h += `<div class="item">
          <div class="idate">${dmy(r.saleDate)}</div>
          <div class="imain">
            <div class="ittl">${esc(r.title || r.subject || '—')}</div>
            <div class="isub">${esc(r.vendorCode || '')}${r.size ? ' · размер ' + esc(r.size) : ''}${r.wbWarehouse ? ' · приёмка WB: ' + esc(r.wbWarehouse) : ''}</div>
          </div>
          <div class="iids">
            <div><span>заявка</span> ${esc(r.assemblyId || '—')}</div>
            <div><span>ШК</span> ${esc(r.shkId || '—')}</div>
          </div>
          <div class="isum">${money(r.penalty)}</div>
        </div>`;
      }
      h += `</div></div>`;
    }
  }

  // ── Детализация FBW ──
  if (fbw.length) {
    h += `<div class="sec">Детализация · платное хранение возвратов (FBW)</div>`;
    for (const g of bySupply) {
      const i = g.info || {};
      h += `<div class="card grp" style="--gc:${C.mid}">
        <div class="ghead">
          <div class="gname">Поставка ${esc(g.id)}${g.ff ? ' · ' + esc(g.ff) : ''}</div>
          <div class="gmeta">${int(g.n)} ${plural(g.n, 'случай', 'случая', 'случаев')} · ${money(g.sum)}</div>
        </div>
        <div class="gline">
          <span><b>Сдана на склад:</b> ${esc(g.drop || '—')}</span>
          ${g.dest && g.dest !== g.drop ? `<span><b>Назначение:</b> ${esc(g.dest)}</span>` : ''}
          <span><b>Принята:</b> ${dmy(i.factDate)}</span>
          <span><b>Объём:</b> ${i.acceptedQuantity != null ? int(i.acceptedQuantity) + ' шт' : '—'}</span>
          ${g.ff ? '' : `<span class="warn">фулфилмент не определён</span>`}
        </div>
        <div class="items">`;
      for (const r of g.list.sort((a, b) => String(a.saleDate).localeCompare(String(b.saleDate)))) {
        h += `<div class="item">
          <div class="idate">${dmy(r.saleDate)}</div>
          <div class="imain">
            <div class="ittl">${esc(r.title || r.subject || '—')}</div>
            <div class="isub">${esc(r.vendorCode || '')}${r.size ? ' · размер ' + esc(r.size) : ''}${r.wbWarehouse ? ' · возврат лежал: ' + esc(r.wbWarehouse) : ''}</div>
          </div>
          <div class="iids">
            <div><span>поставка</span> ${esc(r.supply)}</div>
            <div><span>ШК</span> ${esc(r.shkId || '—')}</div>
          </div>
          <div class="isum">${money(r.penalty)}</div>
        </div>`;
      }
      h += `</div></div>`;
    }
  }

  // ── Что делать ──
  h += `<div class="card next"><div class="ctitle">Что с этим делать</div><ol class="steps">
    <li><b>Отмены FBS.</b> ${byFf[0] ? `Основной источник — <b>${esc(byFf[0].label)}</b>: ${int(byFf[0].n)} из ${int(fbs.length)} отмен.` : ''} Сверить остатки этого фулфилмента с тем, что выставлено на витрине: отмена почти всегда означает, что товар числился, но его не было.</li>
    <li><b>Хранение возвратов.</b> ${byDrop[0] ? `Больше всего накопили ${esc(byDrop[0].label)} и ${esc(byDrop[1]?.label || '—')}.` : ''} Возвраты нужно забирать из ПВЗ в пределах трёх дней — дальше счётчик тикает по каждой единице.</li>
    ${unknown.length ? `<li><b>Закрыть привязку FBW.</b> ${int(unknown.length)} ${plural(unknown.length, 'строка', 'строки', 'строк')} на ${money(sum(unknown))} нельзя отнести к конкретному фулфилменту: Wildberries хранит только склад приёмки. Нужен наш реестр «номер поставки → фулфилмент» — тогда эта часть отчёта закроется автоматически.</li>` : ''}
  </ol></div>`;

  h += `<div class="foot">Источник данных — детализация к отчёту о реализации Wildberries. Фулфилмент FBS определён через сборочные задания (<code>GET /api/v3/orders</code>), поставки FBW — через <code>GET /api/v1/supplies/{ID}</code>. Отчёт сформирован автоматически.</div>`;

  return h;
}

function kpi(label, value, sub, color) {
  return `<div class="kpi" style="--kc:${color}">
    <div class="klbl">${esc(label)}</div>
    <div class="kval">${esc(value)}</div>
    <div class="ksub">${esc(sub)}</div>
  </div>`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function finesHtmlDocument(rows, meta = {}) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Штрафы Wildberries</title>
<style>
  @page { size: A4; margin: 12mm 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html,body { margin:0; padding:0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color:${C.ink}; font-size:12px; line-height:1.35; }
  .hdr { display:flex; justify-content:space-between; align-items:stretch; gap:14px; padding-bottom:12px; border-bottom:3px solid ${C.accent}; margin-bottom:14px; }
  .kicker { font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:${C.accent}; font-weight:700; }
  h1 { font-size:22px; margin:3px 0 2px; font-weight:800; letter-spacing:-.01em; }
  .sub { font-size:11px; color:${C.muted}; }
  .total { min-width:170px; border-radius:12px; padding:10px 16px; color:#fff; background:linear-gradient(135deg, ${C.accent}, #7b0f78); text-align:right; display:flex; flex-direction:column; justify-content:center; }
  .tlbl { font-size:9.5px; opacity:.85; text-transform:uppercase; letter-spacing:.08em; font-weight:700; }
  .tval { font-size:26px; font-weight:800; line-height:1.1; }
  .tsub { font-size:9.5px; opacity:.9; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:12px; }
  .kpi { border:1px solid ${C.hair}; border-top:3px solid var(--kc); border-radius:10px; padding:9px 11px; background:#fff; }
  .klbl { font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:${C.muted}; font-weight:700; }
  .kval { font-size:16px; font-weight:800; margin-top:2px; color:var(--kc); line-height:1.15; }
  .ksub { font-size:9.5px; color:${C.muted}; margin-top:2px; }
  .card { border:1px solid ${C.hair}; border-radius:12px; padding:12px 14px; background:#fff; break-inside:avoid; margin-bottom:12px; }
  .ctitle { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; color:${C.muted}; margin-bottom:8px; }
  .cap { font-size:9.5px; color:${C.muted}; margin-top:6px; }
  .legend { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:6px; }
  .lg { font-size:10.5px; display:flex; align-items:center; gap:6px; }
  .lg i { width:10px; height:10px; border-radius:3px; display:inline-block; }
  .reasons { display:flex; flex-direction:column; gap:10px; }
  .reason { border-left:4px solid var(--rc); background:${C.soft}; border-radius:0 10px 10px 0; padding:8px 12px; }
  .rhead { display:flex; align-items:center; gap:8px; }
  .rdot { width:9px; height:9px; border-radius:50%; background:var(--rc); }
  .rname { font-size:13px; font-weight:800; }
  .rsum { margin-left:auto; font-size:11.5px; font-weight:800; color:var(--rc); }
  .rwb { font-size:9.5px; color:${C.muted}; margin:1px 0 5px 17px; font-style:italic; }
  .rtxt { font-size:10.5px; line-height:1.45; margin-left:17px; }
  .rwatch { margin-top:4px; padding-top:4px; border-top:1px dashed ${C.hair}; color:${C.accent2}; font-weight:600; }
  .sec { font-size:13px; font-weight:800; color:${C.accent}; text-transform:uppercase; letter-spacing:.05em; margin:16px 0 8px; padding-bottom:5px; border-bottom:2px solid ${C.accent}; break-after:avoid; }
  .grp { border-left:4px solid var(--gc); padding-left:12px; }
  .ghead { display:flex; align-items:baseline; gap:10px; border-bottom:1px solid ${C.hair}; padding-bottom:6px; margin-bottom:6px; }
  .gname { font-size:13px; font-weight:800; }
  .gmeta { margin-left:auto; font-size:11px; font-weight:700; color:var(--gc); }
  .gline { display:flex; flex-wrap:wrap; gap:4px 16px; font-size:10px; color:${C.ink}; margin-bottom:7px; }
  .gline b { color:${C.muted}; font-weight:700; }
  .gline .warn { color:${C.mid}; font-weight:700; }
  .items { display:flex; flex-direction:column; }
  .item { display:grid; grid-template-columns:74px 1fr 132px 62px; gap:8px; align-items:center; padding:4px 0; border-bottom:1px solid ${C.soft}; break-inside:avoid; }
  .item:last-child { border-bottom:none; }
  .idate { font-size:10px; font-weight:700; color:${C.accent2}; }
  .ittl { font-size:10.5px; font-weight:600; line-height:1.25; }
  .isub { font-size:9px; color:${C.muted}; line-height:1.25; }
  .iids { font-size:9px; color:${C.ink}; font-variant-numeric:tabular-nums; }
  .iids span { display:inline-block; width:52px; color:${C.muted}; text-transform:uppercase; letter-spacing:.04em; font-size:8px; font-weight:700; }
  .isum { font-size:11px; font-weight:800; text-align:right; }
  .next { border-color:${C.accent}; border-left:5px solid ${C.accent}; background:${C.soft}; }
  .steps { margin:0; padding-left:18px; }
  .steps li { font-size:10.5px; line-height:1.5; margin-bottom:5px; }
  .foot { font-size:8.5px; color:${C.muted}; border-top:1px solid ${C.hair}; padding-top:6px; margin-top:8px; }
  code { font-family:"SF Mono", Menlo, Consolas, monospace; font-size:8.5px; }
</style></head><body>${buildFinesHtml(rows, meta)}</body></html>`;
}
