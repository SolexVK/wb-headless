// scripts/wb-token-check.mjs — показать, откуда берётся токен WB API (без раскрытия).
//
//   node scripts/wb-token-check.mjs        # диагностика
//   node scripts/wb-token-check.mjs --ping # ещё и проверить токен методом /ping
//
// Ничего не отправляет наружу без флага --ping. Значение токена не печатает —
// только источник и маску (первые/последние символы).

import { resolveWbToken, resolveTokenType, maskToken, TOKEN_KEYS } from '../lib/wbToken.js';

const { token, source } = resolveWbToken();
const type = resolveTokenType();

process.stdout.write('Токен WB API\n');
process.stdout.write(`  найден:  ${token ? 'ДА' : 'НЕТ'}\n`);
process.stdout.write(`  источник: ${source || '(не найден)'}\n`);
process.stdout.write(`  маска:   ${maskToken(token)}\n`);
process.stdout.write(`  тип:     ${type}\n`);

if (!token) {
  process.stdout.write(
    '\nКуда положить токен (любой из вариантов):\n' +
    `  • переменная окружения ${TOKEN_KEYS.join(' или ')} (в настройках среды — попадёт в сессию)\n` +
    '  • строка в .env в корне репозитория (локально/в контейнере; .env не коммитится)\n' +
    '  • для GitHub Actions — секрет + маппинг в workflow: WB_API_TOKEN: ${{ secrets.Wildberries_API }}\n'
  );
  process.exit(1);
}

if (process.argv.includes('--ping')) {
  // Проверяем валидность токена самым дешёвым методом. /ping есть у каждого
  // домена; берём common (лимит 3 запроса/30с — одиночная проверка безопасна).
  const url = 'https://common-api.wildberries.ru/ping';
  process.stdout.write(`\nПроверяю токен: GET ${url}\n`);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await resp.text().catch(() => '');
    process.stdout.write(`  HTTP ${resp.status} ${resp.statusText}\n`);
    process.stdout.write(`  ответ: ${body.slice(0, 200)}\n`);
    process.exit(resp.ok ? 0 : 2);
  } catch (err) {
    process.stdout.write(`  ошибка сети: ${err?.message || err}\n`);
    process.exit(3);
  }
}
