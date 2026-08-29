// scripts/wb-watch-selftest.mjs — проверка окружения сторожа ПЕРЕД боевым запуском.
//
// Ничего не меняет и не публикует. Секреты никогда не печатает целиком:
// только маску вида «eyJh…c1Qz (len 424)» — по ней видно, что значение на месте
// и не перепутано, но само значение по логу не восстановить.
//
//   node scripts/wb-watch-selftest.mjs           проверить всё, ничего не отправляя
//   node scripts/wb-watch-selftest.mjs --send    дополнительно отправить тестовое
//                                                сообщение в Telegram
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveWbToken, maskToken } from '../lib/wbToken.js';
import { telegramConfig, sendMessage } from '../lib/telegram.js';
import { WbClient } from '../lib/wbClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEND = process.argv.includes('--send');
let bad = 0;
const ok = (m, extra = '') => console.log(`  ✅ ${m}${extra ? ' — ' + extra : ''}`);
const fail = (m, extra = '') => { bad += 1; console.log(`  ❌ ${m}${extra ? ' — ' + extra : ''}`); };
const warn = (m, extra = '') => console.log(`  ⚠️  ${m}${extra ? ' — ' + extra : ''}`);

// Значения из .env — Node сам их не читает, поэтому подхватываем вручную.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !process.env[k]) process.env[k] = v;
  }
  return file;
}

console.log('\n1. Файл .env и права доступа');
const envFile = loadDotEnv();
if (!envFile) {
  warn('.env не найден', 'секреты должны прийти из переменных окружения');
} else {
  const mode = (fs.statSync(envFile).mode & 0o777).toString(8);
  if (mode === '600') ok('.env найден, права 600', 'читает только владелец');
  else fail(`.env найден, но права ${mode}`, 'выполните: chmod 600 .env');
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('.env');
  ignored ? ok('.env в .gitignore', 'в репозиторий не попадёт') : fail('.env НЕ в .gitignore', 'секреты могут уехать в git');
}

console.log('\n2. Токен Wildberries');
const { token: wbToken, source } = resolveWbToken({ root: ROOT });
if (!wbToken) {
  fail('токен не найден', 'задайте WB_API_TOKEN или Wildberries_API');
} else {
  ok(`токен найден (${source})`, maskToken(wbToken));
  try {
    const p = JSON.parse(Buffer.from(wbToken.split('.')[1], 'base64').toString());
    const exp = new Date(p.exp * 1000);
    const days = Math.round((exp - Date.now()) / 864e5);
    days > 0 ? ok('срок действия', `до ${exp.toISOString().slice(0, 10)} (осталось ${days} дн.)`)
             : fail('токен истёк', exp.toISOString().slice(0, 10));
    const NAMES = { 2: 'Аналитика', 4: 'Маркетплейс', 5: 'Статистика', 13: 'Финансы' };
    const missing = Object.entries(NAMES).filter(([bit]) => !(p.s & (1 << (bit - 1)))).map(([, n]) => n);
    missing.length ? fail('не хватает категорий токена', missing.join(', '))
                   : ok('категории на месте', Object.values(NAMES).join(', '));
    if (p.t) warn('это тестовый токен', 'боевые данные он не отдаст');
  } catch { warn('не удалось разобрать токен', 'проверка категорий пропущена'); }
}

console.log('\n3. Связь с API Wildberries');
if (wbToken) {
  process.env.WB_API_TOKEN ||= wbToken;
  try {
    const c = new WbClient({ timeoutMs: 60000, maxRetries: 1 });
    const { status, data } = await c.request('finance', '/api/finance/v1/sales-reports/list', {
      method: 'POST',
      body: { dateFrom: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), dateTo: new Date().toISOString().slice(0, 10), period: 'daily', limit: 5 },
      methodLimit: { limit: 1, periodSec: 60, burst: 1 },
    });
    const rows = Array.isArray(data) ? data : [];
    ok(`ответ получен (HTTP ${status})`, `отчётов за неделю: ${rows.length}${rows[0] ? `, валюта ${rows[0].currency}` : ''}`);
  } catch (e) {
    fail('запрос не прошёл', e.message.split('\n')[0]);
  }
} else {
  warn('пропущено', 'нет токена');
}

console.log('\n4. Telegram');
const tg = telegramConfig();
if (!tg.token) fail('нет TELEGRAM_BOT_TOKEN');
else ok('токен бота найден', maskToken(tg.token));
if (!tg.chats.length) fail('нет TELEGRAM_ALLOWED_CHAT', 'укажите chat id получателя');
else ok(`получателей: ${tg.chats.length}`, tg.chats.map((c) => String(c).replace(/\d(?=\d{3})/g, '•')).join(', '));

if (tg.token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/getMe`, { signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    data.ok ? ok('бот отвечает', `@${data.result.username}`) : fail('бот не отвечает', data.description);
  } catch (e) { fail('нет связи с Telegram', e.message); }
}

if (SEND && tg.ready) {
  console.log('\n5. Тестовое сообщение');
  try {
    const r = await sendMessage(
      '🔧 <b>Проверка связи</b>\nСторож удержаний WB настроен на этой машине. Это тестовое сообщение, данных в нём нет.'
    );
    r.errors.length ? fail('не доставлено', r.errors.join('; ')) : ok(`доставлено (${r.sent})`, 'проверьте чат');
  } catch (e) { fail('отправка не удалась', e.message); }
} else if (SEND) {
  console.log('\n5. Тестовое сообщение');
  fail('пропущено', 'Telegram настроен не полностью');
}

console.log('\n' + '─'.repeat(56));
if (bad) {
  console.log(`❌ Проблем: ${bad}. Исправьте их до боевого запуска.`);
  process.exit(1);
}
console.log('✅ Всё готово. Дальше: node agent-wb-watch.mjs --dry-run');
