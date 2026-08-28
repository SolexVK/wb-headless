// google.js — Google OAuth 2.0 (Authorization Code) + Sheets/Drive API через fetch, без зависимостей.
// Включается при заданных PLANNER_GOOGLE_CLIENT_ID / PLANNER_GOOGLE_CLIENT_SECRET (тип клиента — Web).
// Redirect URI = <origin>/api/google/callback — регистрируется в Google Cloud Console.
// Scope: drive.file (доступ ТОЛЬКО к файлам, созданным приложением) + openid email.
import crypto from 'node:crypto';

const CLIENT_ID = () => process.env.PLANNER_GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.PLANNER_GOOGLE_CLIENT_SECRET || '';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

export function isEnabled() { return !!(CLIENT_ID() && CLIENT_SECRET()); }

// fetch с тайм-аутом (чтобы залипший запрос к Google не подвешивал выгрузку навсегда)
async function fetchT(url, opts = {}, ms = 20000) { return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }); }

// CSRF-state: одноразовые токены со сроком жизни 10 мин
const states = new Map();
export function makeState() { const s = crypto.randomBytes(16).toString('hex'); states.set(s, Date.now() + 10 * 60 * 1000); return s; }
export function checkState(s) { const e = states.get(s); states.delete(s); return !!(e && e > Date.now()); }

export function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID(), redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function emailFromIdToken(idToken) {
  try { const pl = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); return pl.email || ''; } catch { return ''; }
}

export async function exchangeCode(code, redirectUri) {
  const res = await fetchT('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('Google: обмен кода не удался' + (d.error ? ` (${d.error})` : ''));
  return { access_token: d.access_token, refresh_token: d.refresh_token || '', expires_at: Date.now() + (d.expires_in ? d.expires_in * 1000 : 3300000), email: d.id_token ? emailFromIdToken(d.id_token) : '' };
}

export async function refreshAccessToken(refreshToken) {
  const res = await fetchT('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('Google: не удалось обновить токен' + (d.error ? ` (${d.error})` : ''));
  return { access_token: d.access_token, expires_at: Date.now() + (d.expires_in ? d.expires_in * 1000 : 3300000) };
}

// ── Sheets ──
const hdrs = (at) => ({ Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' });
const safeTitle = (s, i) => String(s || `Лист ${i + 1}`).replace(/[\[\]\*\/\\\?:]/g, ' ').slice(0, 90).trim() || `Лист ${i + 1}`;

// формула картинки в ячейке (локаль ru → аргументы через ';'); режим 4 = фикс. размер в пикселях
export function imageFormula(fileId) { return `=IMAGE("https://drive.google.com/thumbnail?id=${fileId}&sz=w300"; 4; 46; 86)`; }

async function batchUpdate(at, id, requests, ms = 30000) {
  const r = await fetchT(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, { method: 'POST', headers: hdrs(at), body: JSON.stringify({ requests }) }, ms);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Sheets: ' + ((d.error && d.error.message) || ('batchUpdate ' + r.status)));
  return d.replies || [];
}
async function writeValues(at, id, sheets, docProps) {
  const data = sheets.map((s, i) => ({ range: `'${docProps[i].title}'!A1`, majorDimension: 'ROWS', values: s.rows || [] }));
  const r = await fetchT(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, { method: 'POST', headers: hdrs(at), body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) }, 40000);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error('Google Sheets: не удалось записать данные' + (e.error ? `: ${e.error.message || ''}` : '')); }
}
// колонка может быть строкой ('text'|'num'|'price'|'img'|'date') или объектом {t, a}.
// a — выравнивание 'LEFT'|'CENTER'|'RIGHT' (если не задано — text/date влево, остальное по центру).
const NC = (c) => (typeof c === 'string') ? { t: c, a: (c === 'text' || c === 'date') ? 'LEFT' : 'CENTER' } : { t: c.t || 'text', a: c.a || ((c.t === 'text' || c.t === 'date') ? 'LEFT' : 'CENTER') };

const numFmt = (t) => t === 'text' ? { type: 'TEXT' } : t === 'date' ? { type: 'DATE', pattern: 'dd.mm.yyyy' } : t === 'num' ? { type: 'NUMBER', pattern: '#,##0' } : t === 'price' ? { type: 'NUMBER', pattern: '#,##0.00' } : null;
// ДО записи: числовой формат по колонкам (текст → ведущие нули «003» не пропадут; дата распознаётся).
// Таблицу создаём БЕЗ типов столбцов (см. applyTables), поэтому этот формат не перебивается.
function preFormatRequests(sheets, docProps) {
  const reqs = [];
  docProps.forEach((dp, i) => {
    const sid = dp.sheetId, cols = (sheets[i].cols || []).map(NC), nRows = (sheets[i].rows || []).length;
    cols.forEach((col, c) => { const nf = numFmt(col.t); if (nf) reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: Math.max(1, nRows), startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: nf } }, fields: 'userEnteredFormat.numberFormat' } }); });
  });
  return reqs;
}
// ПОСЛЕ таблицы: переопределяем стиль таблицы — числовой формат (пробел-разделитель), формат даты
// (дд.мм.гггг), выравнивание по колонкам, размеры под картинки, жирный крупный «Итого», шапка (не-таблица).
function postFormatRequests(sheets, docProps) {
  const reqs = []; const HEADER_BG = { red: 0.90, green: 0.93, blue: 0.96 };
  docProps.forEach((dp, i) => {
    const sid = dp.sheetId, cols = (sheets[i].cols || []).map(NC), rows = sheets[i].rows || [];
    const nRows = rows.length, nCols = Math.max(cols.length, rows.reduce((mx, r) => Math.max(mx, r.length), 0), 1);
    reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: HEADER_BG, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,verticalAlignment)' } });
    reqs.push({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: nCols } } });
    let hasImg = false;
    cols.forEach((col, c) => {
      const uf = { horizontalAlignment: col.a, verticalAlignment: 'MIDDLE' };
      let fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment)';
      if (col.t === 'num') { uf.numberFormat = { type: 'NUMBER', pattern: '#,##0' }; fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)'; }
      else if (col.t === 'price') { uf.numberFormat = { type: 'NUMBER', pattern: '#,##0.00' }; fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)'; }
      else if (col.t === 'date') { uf.numberFormat = { type: 'DATE', pattern: 'dd.mm.yyyy' }; fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)'; }
      // строки данных (с итоговой включительно — там SUBTOTAL с тем же форматом)
      reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: Math.max(1, nRows), startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: uf }, fields } });
      if (col.t === 'img') { hasImg = true; reqs.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } }); }
    });
    if (hasImg && nRows > 1) reqs.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: 1, endIndex: nRows }, properties: { pixelSize: 54 }, fields: 'pixelSize' } });
    if (sheets[i].totalRow && nRows >= 2) reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: nRows - 1, endRowIndex: nRows }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } }, fields: 'userEnteredFormat.textFormat' } });
  });
  return reqs;
}

// Оформить листы как ТАБЛИЦУ: нативная таблица Google (фильтры + типы колонок),
// а если API таблиц недоступен — запасной вариант: базовый фильтр + чередование строк.
// Диапазон таблицы НЕ включает строку «Итого» (там SUBTOTAL, пересчитывается при фильтре).
async function applyTables(at, id, sheets, docProps) {
  const targets = sheets.map((s, i) => ({ s, dp: docProps[i] })).filter((x) => x.s && x.s.table);
  if (!targets.length) return;
  // Оформляем как ФИЛЬТР + чередование строк (визуально «таблица»: фильтры на колонках, полосы,
  // авто-пересчёт итога через SUBTOTAL). НЕ используем нативную таблицу Google: её типы столбцов
  // навязывают свой формат/выравнивание (US-дата, правый край, без пробелов) и перебивают наш.
  const rangeOf = (s, dp) => {
    const rows = s.rows || [], cols = s.cols || [];
    const nCols = Math.max(cols.length, rows.reduce((m, r) => Math.max(m, r.length), 0), 1);
    const endRow = rows.length - (s.totalRow ? 1 : 0); // без строки «Итого» (там SUBTOTAL — вне фильтра)
    return { sheetId: dp.sheetId, startRowIndex: 0, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: nCols };
  };
  try {
    const reqs = [];
    for (const { s, dp } of targets) {
      const range = rangeOf(s, dp);
      reqs.push({ setBasicFilter: { filter: { range } } });
      reqs.push({ addBanding: { bandedRange: { range, rowProperties: { headerColor: { red: 0.20, green: 0.42, blue: 0.28 }, firstBandColor: { red: 1, green: 1, blue: 1 }, secondBandColor: { red: 0.95, green: 0.97, blue: 0.95 } } } } });
    }
    await batchUpdate(at, id, reqs, 30000);
  } catch { /* фильтр/полосы не критичны — данные и формат уже применены */ }
}

// Создать НОВУЮ таблицу. Возвращает { url, id }.
export async function createReport(at, title, sheets) {
  const createBody = {
    properties: { title: String(title || 'Отчёт').slice(0, 200), locale: 'ru_RU' },
    sheets: sheets.map((s, i) => ({ properties: { sheetId: i, title: safeTitle(s.title, i), gridProperties: { frozenRowCount: 1 } } })),
  };
  const r = await fetchT('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', headers: hdrs(at), body: JSON.stringify(createBody) }, 30000);
  const doc = await r.json().catch(() => ({}));
  if (!r.ok || !doc.spreadsheetId) throw new Error('Google Sheets: не удалось создать таблицу' + (doc.error ? `: ${doc.error.message || ''}` : ''));
  const docProps = doc.sheets.map((sh) => ({ sheetId: sh.properties.sheetId, title: sh.properties.title }));
  const pre = preFormatRequests(sheets, docProps);
  if (pre.length) await batchUpdate(at, doc.spreadsheetId, pre, 30000).catch(() => {}); // текст ДО записи (ведущие нули)
  await writeValues(at, doc.spreadsheetId, sheets, docProps);
  const post = postFormatRequests(sheets, docProps);
  if (post.length) await batchUpdate(at, doc.spreadsheetId, post, 30000).catch(() => {}); // формат/выравнивание
  await applyTables(at, doc.spreadsheetId, sheets, docProps);          // фильтр + чередование (после форматирования)
  return { url: doc.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${doc.spreadsheetId}`, id: doc.spreadsheetId };
}

// метаданные таблицы; если её нет — бросает Error('NOT_FOUND')
async function getSheetsMeta(at, id) {
  const r = await fetchT(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId,spreadsheetUrl,sheets.properties(sheetId,title)`, { headers: hdrs(at) }, 20000);
  if (r.status === 404) throw new Error('NOT_FOUND');
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.spreadsheetId) throw new Error(r.status === 403 ? 'NOT_FOUND' : 'Google Sheets: таблица недоступна');
  return d;
}

// ОБНОВИТЬ существующую таблицу на месте (тот же URL): очищаем листы и пересоздаём с новыми данными.
export async function updateReport(at, id, title, sheets) {
  const meta = await getSheetsMeta(at, id); // бросит NOT_FOUND, если таблицу удалили
  const tmp = '__tmp_' + crypto.randomBytes(3).toString('hex');
  // A: переименовать файл + добавить временный лист + удалить все существующие листы
  const reqsA = [
    { updateSpreadsheetProperties: { properties: { title: String(title || 'Отчёт').slice(0, 200) }, fields: 'title' } },
    { addSheet: { properties: { title: tmp } } },
  ];
  for (const sh of (meta.sheets || [])) reqsA.push({ deleteSheet: { sheetId: sh.properties.sheetId } });
  const repA = await batchUpdate(at, id, reqsA, 30000);
  const tmpId = repA[1].addSheet.properties.sheetId;
  // B: добавить новые листы (финальные названия) + удалить временный; из ответа берём sheetId новых листов
  const reqsB = sheets.map((s, i) => ({ addSheet: { properties: { title: safeTitle(s.title, i), gridProperties: { frozenRowCount: 1 } } } }));
  reqsB.push({ deleteSheet: { sheetId: tmpId } });
  const repB = await batchUpdate(at, id, reqsB, 30000);
  const docProps = sheets.map((s, i) => ({ sheetId: repB[i].addSheet.properties.sheetId, title: repB[i].addSheet.properties.title }));
  const pre = preFormatRequests(sheets, docProps);
  if (pre.length) await batchUpdate(at, id, pre, 30000).catch(() => {}); // текст ДО записи (ведущие нули)
  await writeValues(at, id, sheets, docProps);
  const post = postFormatRequests(sheets, docProps);
  if (post.length) await batchUpdate(at, id, post, 30000).catch(() => {}); // формат/выравнивание
  await applyTables(at, id, sheets, docProps);          // фильтр + чередование (после форматирования)
  return { url: meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}`, id };
}

// ── Drive: заливка образцов ткани (для картинок в ячейках) ──
export async function uploadImageToDrive(at, buffer, mime, name) {
  const boundary = 'planner' + Math.random().toString(16).slice(2);
  const meta = JSON.stringify({ name: (name || 'sample').slice(0, 120), mimeType: mime });
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(pre, 'utf8'), buffer, Buffer.from(post, 'utf8')]);
  const r = await fetchT('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  }, 25000);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error('Google Drive: не удалось загрузить образец' + (d.error ? `: ${d.error.message || ''}` : ''));
  return d.id;
}
export async function makeFilePublic(at, fileId) {
  await fetchT(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST', headers: hdrs(at), body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }, 15000).catch(() => { /* не вышло — картинка просто не отрисуется */ });
}
