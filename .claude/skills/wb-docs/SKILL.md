---
name: wb-docs
description: Правильно зайти на портал документации Wildberries (dev.wildberries.ru) и прочитать любую его страницу в обход антибота, а также освежить снимки лимитов/методов. Использовать всякий раз, когда нужно прочитать страницу WB API, узнать лимит метода или обновить docs/wb-api. Триггеры — «/wb-docs», «прочитай доку WB», «зайди на dev.wildberries.ru», «какой лимит у метода WB», «обнови снимки WB».
---

# /wb-docs — чтение документации Wildberries (обход антибота)

Страницы `dev.wildberries.ru` **нельзя** прочитать обычным `curl`/`fetch`/WebFetch:
они закрыты антибот-челленджем и рисуются на клиенте (SPA). Обычный запрос
получает заглушку «Почти готово…» (HTTP 498). Нужен настоящий браузер — он уже
поднимается штатным скриптом `scripts/fetch-wb-docs.mjs`.

## Два препятствия (уже решены в коде — не искать заново)

1. **Антибот** `__wbaas/challenges/antibot`. Проходит сам настоящий
   headless-Chromium со «стелс»-настройками: реальный User-Agent, локаль `ru-RU`,
   скрытый `navigator.webdriver`, паузы/движения мышью, цикл ожидания, пока
   челлендж пропустит и SPA дорисуется.
2. **MITM-прокси окружения** (когда задан `HTTPS_PROXY`) рвёт TLS 1.3-хендшейк
   Chrome из-за расширения **ECH**. Лечится понижением потолка до **TLS 1.2**
   (`--ssl-version-max=tls1.2` + игнор MITM-сертификата). Включается
   автоматически только при наличии прокси; в CI (прямая сеть) не нужен.

## Как пользоваться

Требуется браузер Chromium (в этом окружении предустановлен через
`PLAYWRIGHT_BROWSERS_PATH`; в CI — `npx playwright install --with-deps chromium`).
Если пакеты не стоят: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`.

```bash
# прочитать любую страницу доки → в stdout
npm run docs:fetch -- https://dev.wildberries.ru/docs/openapi/analytics

# сохранить страницу в файл (второй аргумент — путь)
node scripts/fetch-wb-docs.mjs https://dev.wildberries.ru/docs/openapi/<раздел> docs/wb-api/<файл>.md

# освежить снимок «общая информация + лимиты»
npm run docs:limits            # → docs/wb-api/limits.md

# перечитать ВСЕ страницы из docs/wb-api/pages.json и обновить снимки
node scripts/refresh-wb-docs.mjs
```

Полезные переменные окружения: `WB_DOCS_BROWSER` (путь к Chromium, если
автопоиск не сработал), `WB_DOCS_TIMEOUT` (тайм-аут прохождения челленджа, мс).

## Где уже лежит изученное

- `docs/wb-api/README.md` — метод обхода + сводка лимитов + регламент обновления.
- `docs/wb-api/limits.md` — снимок «Введение / Авторизация / статус-коды /
  лимиты» (первоисточник правил).
- `docs/wb-api/analytics.md`, `docs/wb-api/reports-statistics.md` — снимки методов.
- `docs/wb-api/pages.json` — список страниц для регулярного обновления.
- `lib/wbClient.js` — клиент WB API, который **соблюдает лимиты** (token-bucket на
  категорию, чтение `X-Ratelimit-*`, ожидание по `X-Ratelimit-Retry` на 429,
  запрет ретраев на 4xx, бэкофф на 5xx/сеть).
- `lib/wbJemReports.js` + `scripts/wb-jem-report.mjs` — отчёты **Джем** (Аналитика
  продавца CSV): асинхронный цикл create → status → getFile (ZIP/CSV). Лимит
  метода 3/мин, интервал 20с; макс. 20 отчётов/сутки; хранятся 48 ч. Статус
  готовности — `SUCCESS`. CLI: `node scripts/wb-jem-report.mjs --list`.
- `.github/workflows/wb-docs-refresh.yml` — авто-обновление снимков раз в неделю.

## Где лежит токен WB API и как его достать

Токен — **персональный**, задан пользователем под именем **`Wildberries_API`**.
Не хардкодить и не печатать значение. Доставать только через резолвер
`lib/wbToken.js`, который ищет по очереди (первый непустой выигрывает):

1. `process.env.WB_API_TOKEN`
2. `process.env.Wildberries_API`
3. `.env` в корне репозитория (ключи `WB_API_TOKEN` / `Wildberries_API`) —
   парсится напрямую, т.к. Node сам `.env` не грузит.

```bash
npm run token:check          # откуда взят токен (маска, без значения)
npm run token:check -- --ping # + проверить валидность через /ping
```

```js
import { resolveWbToken } from './lib/wbToken.js';
const { token, source } = resolveWbToken();   // source — напр. 'env:Wildberries_API'
// WbClient делает это сам: new WbClient() уже подхватит токен из любого источника.
```

**Канонический источник — переменная окружения самого environment’а Claude Code
on the web.** Задаётся один раз в настройках среды (иконка облака → шестерёнка →
поле **Environment variables**, формат `.env`, без кавычек):
`Wildberries_API=<токен>`. После этого токен попадает в `process.env` каждой
сессии автоматически — резолвер подхватит его сам, вставлять в чат не нужно.

⚠️ Важные оговорки (из офиц. доки code.claude.com):
- **GitHub «Repository secrets» в сессию/контейнер НЕ попадают** — только в
  GitHub Actions и только при маппинге в workflow
  (`WB_API_TOKEN: ${{ secrets.Wildberries_API }}`).
- Выделенного хранилища секретов на платформе **пока нет**: переменные среды
  видны тем, кто может редактировать environment. Доступ к редактированию среды
  держать ограниченным.
- Токен — секрет. **Никогда** не печатать его значение и не логировать заголовок
  `Authorization`; для диагностики только `maskToken()`.

Если `npm run token:check` говорит «НЕ найден» — попросить пользователя задать
токен переменной среды (способ выше) или файлом `.env`. Сам токен взять неоткуда.

## Обязательное правило при работе с методом

Перед использованием любого нового метода WB API **точечно прочитай его страницу**
(`npm run docs:fetch -- <URL-метода>`) и возьми **его собственный лимит** — он
часто строже базового. Затем передай лимит в клиент через `methodLimit`:

```js
import { WbClient } from './lib/wbClient.js';
const wb = new WbClient({ token: process.env.Wildberries_API, tokenType: 'personal' });
const { data } = await wb.get('analytics', '/api/v1/...', {
  query: { dateFrom: '2024-01-01' },
  methodLimit: { limit: 1, periodSec: 60, burst: 1 }, // ← из доки метода!
});
```

Базовые лимиты (период = 1 мин): Персональный/Сервисный — 300/мин, всплеск 20;
Базовый/Тестовый — 150/мин, всплеск 10. Один **4xx в «Маркетплейс» = 10 запросов**
→ 4xx не повторять. Токен живёт 180 дней, идёт в заголовок `Authorization`.
