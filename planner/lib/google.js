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
// sheets: [{ title, rows: [[...], ...] }]. Возвращает { url, id }.
export async function createReport(accessToken, title, sheets) {
  const H = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
  const safeTitle = (s, i) => String(s || `Лист ${i + 1}`).replace(/[\[\]\*\/\\\?:]/g, ' ').slice(0, 90).trim() || `Лист ${i + 1}`;
  // 1) создать таблицу со всеми листами (заморозка первой строки)
  const createBody = {
    properties: { title: String(title || 'Отчёт').slice(0, 200) },
    sheets: sheets.map((s, i) => ({ properties: { sheetId: i, title: safeTitle(s.title, i), gridProperties: { frozenRowCount: 1 } } })),
  };
  let r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', headers: H, body: JSON.stringify(createBody) });
  let doc = await r.json().catch(() => ({}));
  if (!r.ok || !doc.spreadsheetId) throw new Error('Google Sheets: не удалось создать таблицу' + (doc.error ? `: ${doc.error.message || ''}` : ''));
  // 2) записать значения (числа станут числами, текст — текстом)
  const data = sheets.map((s, i) => ({ range: `'${doc.sheets[i].properties.title}'!A1`, majorDimension: 'ROWS', values: s.rows || [] }));
  r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${doc.spreadsheetId}/values:batchUpdate`, {
    method: 'POST', headers: H, body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error('Google Sheets: не удалось записать данные' + (e.error ? `: ${e.error.message || ''}` : '')); }
  // 3) оформление: жирная шапка с заливкой + автоширина колонок
  const reqs = [];
  for (const sh of doc.sheets) {
    const sid = sh.properties.sheetId;
    reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.90, green: 0.93, blue: 0.96 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
    reqs.push({ autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: 30 } } });
  }
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${doc.spreadsheetId}:batchUpdate`, { method: 'POST', headers: H, body: JSON.stringify({ requests: reqs }) }).catch(() => { /* оформление не критично */ });
  return { url: doc.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${doc.spreadsheetId}`, id: doc.spreadsheetId };
}
