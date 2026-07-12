// scripts/wb-cabinet-check.mjs — проверка сессии кабинета WB.
// Показывает: найдены ли куки/localStorage, срок годности токенов (по JWT exp),
// и реально ли мы залогинены (заход на кабинет). Значения не печатает.
//
//   npm run cabinet:check
//
// Коды выхода: 0 — сессия жива; 3 — протухла/невалидна (нужны свежие креды).

import { resolveCookies, resolveLocalStorage, launchCabinet, openAndSettle } from '../lib/wbCabinet.js';

const log = (...a) => process.stdout.write(a.join(' ') + '\n');

function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : null;
  } catch { return null; }
}
const fmt = (sec) => new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

// 1) Наличие кредов + срок токенов (без сети).
let cookiesOk = false, lsOk = false;
try { cookiesOk = resolveCookies().cookies.length > 0; } catch (e) { log('куки: НЕ найдены —', e.message.split('\n')[0]); }
const ls = (() => { try { return resolveLocalStorage(); } catch { return { items: [], source: 'нет' }; } })();
lsOk = ls.items.length > 0;

log(`куки:        ${cookiesOk ? 'есть' : 'НЕТ'}`);
log(`localStorage:${lsOk ? ' есть (' + ls.source + ')' : ' НЕТ'}`);

const now = Date.now() / 1000;
let anyExpired = false;
for (const name of ['wb-eu-passport-v2.access-token', 'wb-eu-portal.seller-token']) {
  const item = ls.items.find((i) => i.name === name);
  if (!item) { log(`  ${name}: отсутствует`); continue; }
  const exp = jwtExp(item.value);
  if (!exp) { log(`  ${name}: exp не прочитан`); continue; }
  const alive = exp > now;
  // seller-token короткоживущий (~5 мин) и обновляется SPA — его истечение не критично.
  const shortLived = name === 'wb-eu-portal.seller-token';
  if (!alive && !shortLived) anyExpired = true;
  const mark = alive ? 'ЖИВ' : (shortLived ? 'истёк (норм: обновляется автоматически)' : 'ПРОТУХ');
  log(`  ${name}: до ${fmt(exp)} — ${mark}`);
}
// Примечание: seller-token короткоживущий (~5 мин) и обновляется SPA по passport-токену;
// решает валидность именно passport-токен + реальный заход ниже.

// 2) Реальный заход в кабинет.
if (!cookiesOk || !lsOk) {
  log('\n⛔ Нет полного набора кредов. Нужны свежие:');
  log('   • .secrets/wb-cookies.json  — Cookie-Editor → Export → JSON (домен wildberries.ru)');
  log('   • .secrets/wb-localstorage.txt — localStorage кабинета (wb-eu-passport-v2.access-token и др.)');
  process.exit(3);
}

log('\nПроверяю реальный вход в кабинет…');
const { browser, page } = await launchCabinet();
try {
  const info = await openAndSettle(page, 'https://seller.wildberries.ru/');
  const ok = info.loggedIn && !/about-portal/.test(info.url);
  log(`  URL: ${info.url}`);
  log(`  вход: ${ok ? '✅ АВТОРИЗОВАНЫ' : '⛔ НЕ авторизованы (сессия протухла)'}`);
  if (!ok) {
    log('\nОбнови куки и localStorage-токен в .secrets/ и повтори проверку.');
    process.exit(3);
  }
  process.exit(0);
} finally {
  await browser.close();
}
