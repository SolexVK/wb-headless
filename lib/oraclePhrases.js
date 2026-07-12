// lib/oraclePhrases.js — ингест выгрузки «Оракул запросов» (Wildbox) и отбор
// релевантных фраз по плюс/минус-ключам. Без сторонних зависимостей:
//   • xlsx читаем сами (ZIP central directory + inflateRaw + разбор XML);
//   • csv — простым парсером;
// затем фильтруем фразы и собираем спецификацию для report-niche.js
// (формат «фраза=частота:карточки; …»).

import fs from 'fs';
import zlib from 'zlib';

const num = (v) => (v == null || v === '' ? 0 : Number(String(v).replace(/\s/g, '').replace(',', '.'))) || 0;

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---- минимальный ридер xlsx (ZIP) ----
function zipCentralDir(buf) {
  // ищем End Of Central Directory (0x06054b50) с конца файла
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не похоже на xlsx (ZIP не найден)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const fname = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries[fname] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entries, name) {
  const e = entries[name];
  if (!e) return null;
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  return e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
}

/** Читает первый лист xlsx → { [row]: { [col]: value } } (значения — строки/числа). */
export function readXlsxRows(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = zipCentralDir(buf);

  const ssBuf = readZipEntry(buf, entries, 'xl/sharedStrings.xml');
  const strings = [];
  if (ssBuf) {
    const ss = ssBuf.toString('utf8');
    for (const m of ss.matchAll(/<si>(.*?)<\/si>/gs)) {
      let t = '';
      for (const x of m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)) t += x[1];
      strings.push(unescapeXml(t));
    }
  }
  const sheetName =
    Object.keys(entries).find((n) => n === 'xl/worksheets/sheet1.xml') ||
    Object.keys(entries).find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) throw new Error('в xlsx не найден лист');
  const sheet = readZipEntry(buf, entries, sheetName).toString('utf8');

  const rows = {};
  const re = /<c r="([A-Z]+)(\d+)"(?:[^>]*?t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>|<is>(?:<t[^>]*>(.*?)<\/t>)?<\/is>)?/gs;
  for (const c of sheet.matchAll(re)) {
    const col = c[1];
    const row = Number(c[2]);
    const type = c[3];
    let val = c[4] != null ? c[4] : c[5];
    if (val == null) continue;
    val = type === 's' ? strings[Number(val)] : unescapeXml(val);
    (rows[row] = rows[row] || {})[col] = val;
  }
  return rows;
}

// ---- CSV (запасной вариант) → те же строки по «колонкам» A,B,C… ----
function readCsvRows(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const delim = (text.match(/;/g) || []).length > (text.match(/,/g) || []).length ? ';' : ',';
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const colName = (i) => {
    let s = '';
    i += 1;
    while (i > 0) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); }
    return s;
  };
  const rows = {};
  lines.forEach((line, r) => {
    // простой split (Оракул-CSV без кавычек-с-разделителями внутри)
    line.split(delim).forEach((cell, ci) => {
      if (cell !== '') (rows[r + 1] = rows[r + 1] || {})[colName(ci)] = cell.trim();
    });
  });
  return rows;
}

/** Извлекает {phrase,frequency,count} из строк Оракула (ищет шапку по названиям столбцов). */
export function extractOraclePhrases(rows) {
  const rn = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const hdrR = rn.find((r) => Object.values(rows[r]).some((v) => /частотност/i.test(String(v))));
  if (hdrR == null) throw new Error('не найдена шапка Оракула (столбец «Частотность …»)');
  const hdr = rows[hdrR];
  const colBy = (re) => Object.keys(hdr).find((c) => re.test(String(hdr[c])));
  const cQ = colBy(/запрос/i);
  const cF = colBy(/частотност/i);
  const cC = colBy(/товаров в выдаче|кол.?во товаров в выдаче|количество товаров/i);
  if (!cQ || !cF) throw new Error('в Оракуле нет столбцов «Запрос»/«Частотность»');

  const out = [];
  for (const r of rn) {
    if (r <= hdrR) continue;
    const phrase = rows[r][cQ];
    if (!phrase || !String(phrase).trim()) continue;
    out.push({ phrase: String(phrase).trim(), frequency: num(rows[r][cF]), count: cC ? num(rows[r][cC]) : null });
  }
  return out;
}

/** Читает файл Оракула (.xlsx или .csv) → массив {phrase,frequency,count}. */
export function readOracle(filePath) {
  const rows = /\.csv$/i.test(filePath) ? readCsvRows(filePath) : readXlsxRows(filePath);
  return extractOraclePhrases(rows);
}

// ---- фильтр по плюс/минус-ключам (совпадение по КОРНЮ слова) ----
const normKey = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
const wordsOf = (s) => normKey(s).split(/[^a-zа-я0-9]+/i).filter(Boolean);
// грубый стем: срезаем частые русские окончания (одно).
const stem = (w) => normKey(w).replace(/(ами|ах|ов|ев|ая|яя|ое|ые|ый|ий|ой|ом|ую|ю|а|я|и|ы|е|ь)$/, '');

// Цветовые корни (для минус-ключа «@цвета» / «любые упоминания цвета»).
// Совпадение — по префиксу слова (белая→«бел», тёмно-синяя→«син»).
export const COLOR_STEMS = [
  'бел', 'черн', 'красн', 'син', 'голуб', 'зелен', 'желт', 'оранж', 'розов', 'фиолет',
  'сирен', 'бордов', 'беж', 'коричн', 'сер', 'бирюз', 'хаки', 'молочн', 'кремов', 'пудров',
  'малин', 'изумруд', 'золот', 'серебр', 'лилов', 'мятн', 'персиков', 'терракот', 'шоколад',
  'вишнев', 'лаванд', 'оливк', 'горчичн', 'фукси', 'коралл', 'айвори', 'ванильн', 'небесн',
  'васильк', 'графит', 'антрацит', 'темн', 'светл', 'пыльн', 'кофейн', 'какао', 'капучино',
  'марсал', 'индиго', 'лимонн', 'салатов', 'бронз', 'медн', 'песочн', 'кирпичн', 'шампань',
  'слонов', 'пастельн', 'неонов', 'сливочн', 'баклажан', 'морков', 'лаймов', 'фисташков',
  'пломбир', 'мокко', 'латте', 'фуксия', 'пурпурн', 'алый', 'нюдов', 'хвойн',
];

// Токен «@цвета» (или «цвета»/«colors»/«любые упоминания цвета») → список цветовых корней.
const COLOR_TOKEN = /^@?(цвет(а|ов)?|любые упоминания цвета|colou?rs?)$/i;

export function splitKeys(spec) {
  if (Array.isArray(spec)) return spec.map((s) => String(s).trim()).filter(Boolean);
  return String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Раскрывает спец-токены (@цвета) в конкретные корни.
export function expandKeys(spec) {
  const out = [];
  for (const k of splitKeys(spec)) {
    if (COLOR_TOKEN.test(k)) out.push(...COLOR_STEMS);
    else out.push(k);
  }
  return out;
}

/** Ключ совпал, если ВСЕ его слова-корни — префиксы каких-то слов фразы. */
export function keyMatches(key, phraseWords) {
  const stems = wordsOf(key).map(stem).filter(Boolean);
  if (!stems.length) return false;
  return stems.every((st) => phraseWords.some((w) => w.startsWith(st)));
}

/**
 * Отбор фраз: берём, если сработал хотя бы один плюс-ключ (или плюсов нет)
 * И не сработал ни один минус-ключ. Отсортировано по спрос:предложение ↓.
 */
export function filterPhrases(phrases, { plus = [], minus = [] } = {}) {
  const P = expandKeys(plus);
  const M = expandKeys(minus);
  const selected = [];
  const rejected = [];
  for (const p of phrases) {
    const pw = wordsOf(p.phrase);
    const plusHit = P.filter((k) => keyMatches(k, pw));
    const minusHit = M.filter((k) => keyMatches(k, pw));
    if ((!P.length || plusHit.length) && !minusHit.length) selected.push({ ...p, plusHit });
    else rejected.push({ ...p, plusHit, minusHit });
  }
  const ratio = (x) => (x.count ? x.frequency / x.count : 0);
  selected.sort((a, b) => ratio(b) - ratio(a));
  return { selected, rejected };
}

/** Собирает спецификацию для report-niche: «фраза=частота:карточки; …». */
export function toQuerySpec(selected) {
  return selected
    .map((s) => (s.count != null ? `${s.phrase}=${s.frequency}:${s.count}` : s.phrase))
    .join('; ');
}

/** Готовый список queries [{phrase,frequency,supplyCards}] для buildNicheAnalysis. */
export function toQueries(selected) {
  return selected.map((s) => ({ phrase: s.phrase, frequency: s.frequency, supplyCards: s.count }));
}
