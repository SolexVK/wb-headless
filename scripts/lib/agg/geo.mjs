// scripts/lib/agg/geo.mjs — чистые агрегаторы отчёта «География».
// Вынесены из fbs-geo.mjs 1:1, чтобы покрыть юнит-тестами (smoke-agg.mjs):
//   • aggregateRegions(sales, pred) — продажи/возвраты по регионам и округам;
//   • aggregateFbs(sales, ord)      — привязка к ФФ отгрузки по srid==rid.

const isReturn = (s) => String(s.saleID || '').startsWith('R');
const rub = (s) => Math.abs(Number(s.finishedPrice) || 0);
const okrugOf = (s) => (s.oblastOkrugName || '—');
const regionOf = (s) => (s.regionName || '—');
const rInt = (x) => Math.round(x);            // рубли — до целого (как в исходном пайплайне)
const pctOf = (ret, sal) => (sal ? Math.round((ret / sal) * 1000) / 10 : 0);

// Регионы/округа по строкам продаж, отфильтрованным предикатом pred(s).
export function aggregateRegions(sales, pred) {
  const byRegion = new Map(); const byOkrug = new Map();
  const bump = (map, key, extra, s) => {
    if (!map.has(key)) map.set(key, { ...extra, salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 });
    const e = map.get(key);
    if (isReturn(s)) { e.returnCount += 1; e.returnRub += rub(s); } else { e.salesCount += 1; e.salesRub += rub(s); }
  };
  for (const s of sales) {
    if (!pred(s)) continue;
    bump(byRegion, okrugOf(s) + '||' + regionOf(s), { okrug: okrugOf(s), region: regionOf(s) }, s);
    bump(byOkrug, okrugOf(s), { okrug: okrugOf(s) }, s);
  }
  const fin = (arr) => arr.map((e) => ({ ...e, salesRub: rInt(e.salesRub), returnRub: rInt(e.returnRub), returnPct: e.salesCount ? Math.round((e.returnCount / e.salesCount) * 1000) / 10 : 0 })).sort((a, b) => b.salesCount - a.salesCount);
  const regions = fin([...byRegion.values()]); const okrugs = fin([...byOkrug.values()]);
  const t = regions.reduce((a, r) => ({ salesCount: a.salesCount + r.salesCount, returnCount: a.returnCount + r.returnCount, salesRub: a.salesRub + r.salesRub, returnRub: a.returnRub + r.returnRub }), { salesCount: 0, returnCount: 0, salesRub: 0, returnRub: 0 });
  t.regions = regions.length; t.returnPct = t.salesCount ? Math.round((t.returnCount / t.salesCount) * 1000) / 10 : 0;
  return { totals: t, byRegion: regions, byOkrug: okrugs };
}

// FBS-атрибуция: привязка продаж/возвратов к ФФ отгрузки по srid == rid заказа.
//   ord = { rid: Map(srid → { ff, mos, article, nm }), ordersByFF: { [ff]: count } }
export function aggregateFbs(sales, ord) {
  const byFF = new Map(); const ffReg = new Map(); const byDay = new Map(); const byArt = new Map();
  let unSales = 0, unRet = 0; const tot = { salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 };
  for (const s of sales) {
    const o = ord.rid.get(String(s.srid));
    if (!o) { // FBS-строка без заказа в окне (старше ~90 дн) — не привязать к ФФ
      if (/продав/i.test(s.warehouseType || '')) { if (isReturn(s)) unRet += 1; else unSales += 1; }
      continue;
    }
    const ret = isReturn(s); const money = rub(s); const day = String(s.date || '').slice(0, 10);
    if (ret) { tot.returnCount += 1; tot.returnRub += money; } else { tot.salesCount += 1; tot.salesRub += money; }
    const add = (map, key, extra) => { if (!map.has(key)) map.set(key, { ...extra, salesCount: 0, salesRub: 0, returnCount: 0, returnRub: 0 }); const e = map.get(key); if (ret) { e.returnCount += 1; e.returnRub += money; } else { e.salesCount += 1; e.salesRub += money; } };
    add(byFF, o.ff, { ff: o.ff });
    add(ffReg, o.ff + '||' + regionOf(s), { ff: o.ff, okrug: okrugOf(s), region: regionOf(s) });
    add(byArt, o.article, { article: o.article, ff: o.ff });
    if (day) { if (!byDay.has(day)) byDay.set(day, { date: day, salesCount: 0, returnCount: 0 }); const d = byDay.get(day); if (ret) d.returnCount += 1; else d.salesCount += 1; }
  }
  const finFF = (arr) => arr.map((e) => ({ ...e, salesRub: rInt(e.salesRub), returnRub: rInt(e.returnRub), returnPct: pctOf(e.returnCount, e.salesCount), shipped: ord.ordersByFF[e.ff] || 0 })).sort((a, b) => b.returnCount - a.returnCount || b.salesCount - a.salesCount);
  const finReg = (arr) => arr.map((e) => ({ ...e, salesRub: rInt(e.salesRub), returnRub: rInt(e.returnRub), returnPct: pctOf(e.returnCount, e.salesCount) })).sort((a, b) => b.returnCount - a.returnCount || b.salesCount - a.salesCount);
  const finArt = (arr) => arr.map((e) => ({ ...e, salesRub: rInt(e.salesRub), returnRub: rInt(e.returnRub), returnPct: pctOf(e.returnCount, e.salesCount) })).sort((a, b) => b.returnCount - a.returnCount || b.salesCount - a.salesCount).slice(0, 60);
  tot.salesRub = rInt(tot.salesRub); tot.returnRub = rInt(tot.returnRub); tot.returnPct = pctOf(tot.returnCount, tot.salesCount);
  tot.shipped = Object.values(ord.ordersByFF).reduce((a, b) => a + b, 0);
  return {
    totals: tot, ordersByFF: ord.ordersByFF,
    byFF: finFF([...byFF.values()]),
    ffByRegion: finReg([...ffReg.values()]),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byArticle: finArt([...byArt.values()]),
    unattributed: { salesCount: unSales, returnCount: unRet },
  };
}
