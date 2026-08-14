# FBS-сервис (веб)

Мульти-тенант веб-сервис отчётов FBS вокруг движков `../scripts/fbs-*.mjs`.
Полный план — `../docs/service/PLAN.md` (и `plan.html`).

## Статус: Фаза 0 — каркас + авторизация ✅
Регистрация / вход / выход, сессии (persistent в SQLite), CSRF, rate-limit,
helmet, структурные логи (pino), health-check. При регистрации создаётся
пользователь + его личная организация (роль `owner`).

## Запуск
```bash
cd service
npm install
cp .env.example .env      # задайте SESSION_SECRET (и позже TOKEN_ENC_KEY)
npm start                 # http://127.0.0.1:9110   (только loopback!)
npm test                  # in-process дымовой тест (10 проверок)
```
Слушаем ТОЛЬКО `127.0.0.1:PORT` — наружу публикует Caddy (правила Mac Mini,
`../docs/china-fbs/deploy/MAC-MINI-RULES.md`). В коде нет привязок к 443/Funnel.

## Структура
- `server.js` — запуск (listen на loopback); `app.js` — сборка Express-приложения.
- `config.js` — конфиг из `.env`; `logger.js` — pino; `db.js` — SQLite + схема + session store.
- `models.js` — доступ к данным (users/orgs/memberships); `auth.js` — маршруты авторизации.
- `security.js` — helmet/rate-limit/CSRF/requireAuth; `tokens.js` — AES-256-GCM для WB-токенов (Фаза 1).
- `views.js` — серверный рендер страниц; `smoke-test.mjs` — тест Фазы 0.

## Модель данных (SQLite → Postgres позже)
users · organizations · memberships(role owner/admin/member) ·
cabinets(wb_token_enc AES-256-GCM) · invitations · snapshot_cache · sessions.

## Дальше
- **Ф1** — организации/кабинеты/WB-токены (валидация `/ping` + разбор прав JWT, шифрование).
- **Ф2** — оболочка отчётов + «Обновить» + кэш; первым Подсорт с формой.
