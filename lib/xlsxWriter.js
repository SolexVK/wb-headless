// lib/xlsxWriter.js — минимальный генератор .xlsx без внешних зависимостей.
//
// Пишет Office Open XML (SpreadsheetML) и упаковывает в ZIP (метод STORE, с CRC32).
// Поддерживает: заголовок, строки (числа/строки), ширины колонок и ЗАЛИВКУ строк
// по цвету (для разбивки на этапы сезона). Достаточно для табличных отчётов.

import fs from 'fs';

// ── CRC32 ────────────────────────────────────────────────────────────────────
let CRC_TABLE;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (CRC_TABLE = t);
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── ZIP (STORE) ──────────────────────────────────────────────────────────────
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // comp size
    local.writeUInt32LE(data.length, 22); // uncomp size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ── XML helpers ──────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const colLetter = (n) => {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/**
 * Пишет один лист в .xlsx.
 * @param {string} filePath
 * @param {object} sheet
 *   sheet.name — имя листа
 *   sheet.columns — [{header, width}]
 *   sheet.rows — [{cells:[value…], fill?}]  value: number | string
 *   fill — ARGB-hex без '#', напр. 'FFDDEEFF' или 'DDEEFF' (альфа добавится)
 * @param {string[]} [fillPalette] — заранее объявленные цвета заливки (ARGB/hex)
 */
export function writeXlsx(filePath, sheet, fillPalette = []) {
  fs.writeFileSync(filePath, xlsxBuffer(sheet, fillPalette));
}

/** Собирает .xlsx в Buffer (без записи на диск). */
export function xlsxBuffer(sheet, fillPalette = []) {
  const colors = [...new Set(fillPalette.map(norm))];
  // styles.xml: fills[0..1] обязательны (none, gray125), далее наши цвета.
  const fillsXml = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    ...colors.map((c) => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/></patternFill></fill>`),
  ].join('');
  // cellXfs: xf 0 — дефолт; далее по одному на цвет.
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',
    ...colors.map((_, i) => `<xf numFmtId="0" fontId="0" fillId="${i + 2}" borderId="0" applyFill="1"/>`)].join('');
  const colorXf = new Map(colors.map((c, i) => [c, i + 1]));

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="${colors.length + 2}">${fillsXml}</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${colors.length + 1}">${xfs}</cellXfs>
</styleSheet>`;

  const cols = (sheet.columns || []).map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');
  const headerCells = (sheet.columns || []).map((c, i) =>
    `<c r="${colLetter(i)}1" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`).join('');
  const rowsXml = (sheet.rows || []).map((row, ri) => {
    const r = ri + 2;
    const s = row.fill ? colorXf.get(norm(row.fill)) : null;
    const sAttr = s != null ? ` s="${s}"` : '';
    const cells = row.cells.map((v, ci) => {
      const ref = `${colLetter(ci)}${r}`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t>${esc(v == null ? '' : v)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData><row r="1">${headerCells}</row>${rowsXml}</sheetData>
</worksheet>`;

  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheet.name || 'Лист1')}" sheetId="1" r:id="rId1"/></sheets>
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];
  return buildZip(files);
}

/** Нормализует цвет к ARGB (8 hex). '#RRGGBB' | 'RRGGBB' → 'FFRRGGBB'. */
function norm(c) {
  let s = String(c).replace('#', '').toUpperCase();
  if (s.length === 6) s = 'FF' + s;
  return s;
}
