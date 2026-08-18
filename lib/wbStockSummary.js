// lib/wbStockSummary.js — сборка сводного отчёта по остаткам из «сырых» данных WB.
//
// Функция buildStockSummary — чистая (без сети): принимает уже полученные массивы
// и возвращает готовую структуру отчёта. Это позволяет прогонять и тестировать
// логику агрегации на фикстурах, без реального WB-токена.

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;

/**
 * @param {Object} input
 * @param {Array}  input.fboRows              — строки FBO (см. fetchFboStocks)
 * @param {Array}  input.fbsWarehouses        — склады FBS [{id,name}]
 * @param {Map}    input.fbsStocksByWh         — Map(warehouseId → Map(barcode → amount))
 * @param {Map}    input.cardsByBarcode        — Map(barcode → {seller,nmId,techSize}) (может быть пустой)
 * @param {string} [input.generatedAt]         — ISO-метка времени сборки
 * @returns {Object} отчёт: { generatedAt, byArticle[], fboByWarehouse[], fbsByWarehouse[], totals }
 */
export function buildStockSummary({
  fboRows = [],
  fbsWarehouses = [],
  fbsStocksByWh = new Map(),
  cardsByBarcode = new Map(),
  generatedAt = new Date().toISOString(),
} = {}) {
  // Связка баркод → артикул: сперва из карточек (полнее), затем из строк FBO.
  const barcodeToArticle = new Map();
  for (const [bc, info] of cardsByBarcode) barcodeToArticle.set(String(bc), info);
  for (const r of fboRows) {
    if (r.barcode && !barcodeToArticle.has(String(r.barcode))) {
      barcodeToArticle.set(String(r.barcode), { seller: r.seller, nmId: r.nmId, techSize: r.techSize });
    }
  }

  // Аккумулятор по артикулу продавца.
  const byArticle = new Map();
  const bump = (seller, nmId) => {
    const key = seller || '(без артикула)';
    if (!byArticle.has(key)) {
      byArticle.set(key, {
        seller: key, nmId: nmId || 0,
        fboAvailable: 0, fboFull: 0, inWayToClient: 0, inWayFromClient: 0, fbs: 0,
      });
    }
    const a = byArticle.get(key);
    if (!a.nmId && nmId) a.nmId = nmId;
    return a;
  };

  // ── FBO: агрегируем по артикулу; параллельно копим разрез по складам ──
  const fboWh = new Map();
  for (const r of fboRows) {
    const a = bump(r.seller, r.nmId);
    a.fboAvailable += r.available;
    a.fboFull += r.full;
    a.inWayToClient += r.inWayToClient;
    a.inWayFromClient += r.inWayFromClient;

    if (!fboWh.has(r.warehouse)) {
      fboWh.set(r.warehouse, { warehouse: r.warehouse, available: 0, full: 0, inWayToClient: 0, inWayFromClient: 0 });
    }
    const w = fboWh.get(r.warehouse);
    w.available += r.available;
    w.full += r.full;
    w.inWayToClient += r.inWayToClient;
    w.inWayFromClient += r.inWayFromClient;
  }

  // ── FBS: остатки приходят по баркодам на каждом складе продавца ──
  const fbsWhSummary = [];
  const whName = new Map(fbsWarehouses.map((w) => [w.id, w.name]));
  for (const [whId, stockMap] of fbsStocksByWh) {
    let whTotal = 0;
    for (const [bc, amount] of stockMap) {
      const info = barcodeToArticle.get(String(bc)) || { seller: '(неизвестный баркод)', nmId: 0 };
      const a = bump(info.seller, info.nmId);
      a.fbs += amount;
      whTotal += amount;
    }
    fbsWhSummary.push({ warehouseId: whId, warehouse: whName.get(whId) || `Склад ${whId}`, amount: whTotal });
  }

  // ── Итоговые строки по артикулу ──
  const rows = [...byArticle.values()].map((a) => ({
    ...a,
    // «Доступно к продаже сейчас» = остаток FBO на складах + FBS.
    totalAvailable: a.fboAvailable + a.fbs,
  }));
  // Сортировка: по общему доступному остатку убыв., затем по артикулу.
  rows.sort((x, y) => y.totalAvailable - x.totalAvailable || String(x.seller).localeCompare(String(y.seller), 'ru'));

  const fboByWarehouse = [...fboWh.values()].sort((x, y) => y.available - x.available);
  const fbsByWarehouse = fbsWhSummary.sort((x, y) => y.amount - x.amount);

  const totals = rows.reduce(
    (t, r) => {
      t.fboAvailable += r.fboAvailable;
      t.fboFull += r.fboFull;
      t.fbs += r.fbs;
      t.inWayToClient += r.inWayToClient;
      t.inWayFromClient += r.inWayFromClient;
      t.totalAvailable += r.totalAvailable;
      return t;
    },
    { articles: rows.length, fboAvailable: 0, fboFull: 0, fbs: 0, inWayToClient: 0, inWayFromClient: 0, totalAvailable: 0 }
  );

  return { generatedAt, byArticle: rows, fboByWarehouse, fbsByWarehouse, totals };
}

// ─────────────────────────────── CSV ───────────────────────────────

const CSV_COLUMNS = [
  ['seller', 'Артикул продавца'],
  ['nmId', 'Артикул WB (nmID)'],
  ['fboAvailable', 'FBO доступно, шт'],
  ['fboFull', 'FBO всего, шт'],
  ['fbs', 'FBS остаток, шт'],
  ['totalAvailable', 'Итого доступно (FBO+FBS), шт'],
  ['inWayToClient', 'В пути к клиенту, шт'],
  ['inWayFromClient', 'В пути от клиента (возвраты), шт'],
];

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV по строкам «по артикулу». UTF-8 с BOM, разделитель ';' — Excel открывает без плясок. */
export function summaryToCSV(report) {
  const head = CSV_COLUMNS.map(([, title]) => csvCell(title)).join(';');
  const body = report.byArticle
    .map((r) => CSV_COLUMNS.map(([key]) => csvCell(r[key])).join(';'))
    .join('\n');
  const totalRow = CSV_COLUMNS
    .map(([key], i) => {
      if (i === 0) return csvCell('ИТОГО');
      if (i === 1) return '';
      return csvCell(report.totals[key] ?? '');
    })
    .join(';');
  return '﻿' + [head, body, totalRow].join('\n') + '\n';
}

export { CSV_COLUMNS };
