// google.js — Google OAuth 2.0 (Authorization Code) + Sheets API v4 через fetch, без внешних зависимостей.
// Включается при заданных PLANNER_GOOGLE_CLIENT_ID / PLANNER_GOOGLE_CLIENT_SECRET (тип клиента — Web).
// Redirect URI = <origin>/api/google/callback — его нужно зарегистрировать в Google Cloud Console.
// Scope: drive.file (доступ ТОЛЬКО к файлам, созданным приложением) + openid email — «щадящий» доступ.
import crypto from 'node:crypto';

const CLIENT_ID = () => process.env.PLANNER_GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.PLANNER_GOOGLE_CLIENT_SECRET || '';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

export function isEnabled() { return !!(CLIENT_ID() && CLIENT_SECRET()); }

// CSRF-state: одноразовые токены со сроком жизни 10 мин
const states = new Map();
export function makeState() { const s = crypto.randomBytes(16).toString('hex'); states.set(s, Date.now() + 10 * 60 * 1000); return s; }
export function checkState(s) { const e = states.get(s); states.delete(s); return !!(e && e > Date.now()); }

export function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID(), redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, state,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', // offline+consent → получить refresh_token
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function emailFromIdToken(idToken) {
  try { const pl = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); return pl.email || ''; } catch { return ''; }
}

// Обмен кода на токены. Возвращает { access_token, refresh_token, expires_at, email }.
export async function exchangeCode(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('Google: обмен кода не удался' + (d.error ? ` (${d.error})` : ''));
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token || '',
    expires_at: Date.now() + (d.expires_in ? d.expires_in * 1000 : 3300000),
    email: d.id_token ? emailFromIdToken(d.id_token) : '',
  };
}

// Обновить access_token по refresh_token. Возвращает { access_token, expires_at }.
export async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('Google: не удалось обновить токен' + (d.error ? ` (${d.error})` : ''));
  return { access_token: d.access_token, expires_at: Date.now() + (d.expires_in ? d.expires_in * 1000 : 3300000) };
}

// Создать таблицу с листами и данными + лёгкое оформление (жирная шапка, заморозка строки, автоширина).
// sheets: [{ title, rows: [[...], ...], cols: ['text'|'num'|'price'|'img', ...] }]. Возвращает { url, id }.
// Локаль ru_RU → разделитель тысяч = пробел. Выравнивание: text — влево, num/price/img — по центру.
export async function createReport(accessToken, title, sheets) {
  const H = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
  const safeTitle = (s, i) => String(s || `Лист ${i + 1}`).replace(/[\[\]\*\/\\\?:]/g, ' ').slice(0, 90).trim() || `Лист ${i + 1}`;
  // 1) создать таблицу со всеми листами (заморозка первой строки, русская локаль → пробел-разделитель)
  const createBody = {
    properties: { title: String(title || 'Отчёт').slice(0, 200), locale: 'ru_RU' },
    sheets: sheets.map((s, i) => ({ properties: { sheetId: i, title: safeTitle(s.title, i), gridProperties: { frozenRowCount: 1 } } })),
  };
  let r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', headers: H, body: JSON.stringify(createBody) });
  let doc = await r.json().catch(() => ({}));
  if (!r.ok || !doc.spreadsheetId) throw new Error('Google Sheets: не удалось создать таблицу' + (doc.error ? `: ${doc.error.message || ''}` : ''));
  // 2) записать значения (числа → числа, =IMAGE(...) → живая картинка). Локаль ru → разделитель ';' в формулах.
  const data = sheets.map((s, i) => ({ range: `'${doc.sheets[i].properties.title}'!A1`, majorDimension: 'ROWS', values: s.rows || [] }));
  r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${doc.spreadsheetId}/values:batchUpdate`, {
    method: 'POST', headers: H, body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error('Google Sheets: не удалось записать данные' + (e.error ? `: ${e.error.message || ''}` : '')); }
  // 3) оформление: шапка + выравнивание/числовой формат по колонкам + картинки
  const reqs = [];
  const HEADER_BG = { red: 0.90, green: 0.93, blue: 0.96 };
  doc.sheets.forEach((sh, i) => {
    const sid = sh.properties.sheetId;
    const cols = sheets[i].cols || [];
    const rows = sheets[i].rows || [];
    const nRows = rows.length;
    const nCols = Math.max(cols.length, rows.reduce((mx, r) => Math.max(mx, r.length), 0), 1);
    // шапка: жирная, заливка, по центру
    reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: HEADER_BG, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment,verticalAlignment)' } });
    // автоширина всех колонок (потом переопределим ширину колонки с картинками)
    reqs.push({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: nCols } } });
    // выравнивание + числовой формат по колонкам (строки данных)
    let hasImg = false;
    cols.forEach((t, c) => {
      const align = (t === 'num' || t === 'price' || t === 'img') ? 'CENTER' : 'LEFT';
      const uf = { horizontalAlignment: align, verticalAlignment: 'MIDDLE' };
      let fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment)';
      if (t === 'num') { uf.numberFormat = { type: 'NUMBER', pattern: '#,##0' }; fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)'; }
      if (t === 'price') { uf.numberFormat = { type: 'NUMBER', pattern: '#,##0.00' }; fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)'; }
      reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 1, endRowIndex: Math.max(1, nRows), startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: uf }, fields } });
      if (t === 'img') { hasImg = true; reqs.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } }); }
    });
    if (hasImg && nRows > 1) reqs.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: 1, endIndex: nRows }, properties: { pixelSize: 54 }, fields: 'pixelSize' } });
  });
  if (reqs.length) await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${doc.spreadsheetId}:batchUpdate`, { method: 'POST', headers: H, body: JSON.stringify({ requests: reqs }) }).catch(() => { /* оформление не критично */ });
  return { url: doc.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${doc.spreadsheetId}`, id: doc.spreadsheetId };
}

// Формула картинки в ячейке (локаль ru → аргументы через ';'). Режим 4: фикс. размер в пикселях.
export function imageFormula(fileId) {
  return `=IMAGE("https://drive.google.com/thumbnail?id=${fileId}&sz=w300"; 4; 46; 86)`;
}
// Загрузить картинку в Google Drive (drive.file) — multipart. Возвращает fileId.
export async function uploadImageToDrive(accessToken, buffer, mime, name) {
  const boundary = 'planner' + Math.random().toString(16).slice(2);
  const meta = JSON.stringify({ name: (name || 'sample').slice(0, 120), mimeType: mime });
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(pre, 'utf8'), buffer, Buffer.from(post, 'utf8')]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error('Google Drive: не удалось загрузить образец' + (d.error ? `: ${d.error.message || ''}` : ''));
  return d.id;
}
// Сделать файл доступным «по ссылке для чтения» (нужно, чтобы =IMAGE подтянул картинку с серверов Google).
export async function makeFilePublic(accessToken, fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }).catch(() => { /* если не вышло — картинка просто не отрисуется */ });
}
