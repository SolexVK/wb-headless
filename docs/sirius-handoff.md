# HANDOFF — проект «Сириус» (личный ИИ-ассистент на VPS)

Дата: 2026-09-06. Автор: архитектор-сессия Claude Code (web) на репозитории `wb-headless`,
ветка `claude/agents-team-branch-cb0h32`. Этот файл — единственный источник состояния для
следующей сессии. Читать целиком перед любым действием.

## 1. Цель

Воссоздать **Сириуса** — личного ассистента пользователя (SolexVK, solexvk@gmail.com), который жил на
Mac Mini на движке OpenClaw, — на VPS поверх **Claude Code** (подписка Max, API-ключа нет).
Требования пользователя:
- знает его, его бизнес (продавец Wildberries, линейки РЖК/РЖП, аналитика MPStats) и предпочтения;
- с ним можно разговаривать текстом и **голосом в реальном времени** (как ChatGPT Voice / Джарвис),
  не голосовыми сообщениями;
- принимает идеи/задачи, собирает информацию, создаёт субагентов, выполняет регулярные задачи,
  возвращается с вариантами решений; критичные действия — только с подтверждением;
- **память не теряется**: перенести всю многослойную память с Mac Mini (не только markdown),
  но подавать в контекст дозированно;
- всё работает на VPS, пользователь не хочет ретранслировать команды через терминал.
- Брат Сириуса — **Гелиос** (движок Hermes) — тоже переезжает, как второй агент.
- У пользователя есть **база готовых агентов в Markdown** — изучить, взять полезное.

## 2. Что выяснено и решено (не пересматривать без причины)

### Инфраструктура VPS (netcup, Debian 13, 12 vCPU, 31 ГБ RAM, 1 ТБ, **GPU нет** — проверено)
- Пользователь-оператор `deploy` (sudo). Сервисы — под системными аккаунтами без входа
  (`wbheadless`, `fbs`, …) по правилам `deploy/vps/README.md` (ветка `claude/server-setup-fmrhlf`).
- Caddy на 80/443, TLS сам. Домены: `tools.aidemiko.ru` (пути `/wb/`, `/fbs/`),
  `planner.aidemiko.ru`, `demo.aidemiko.ru`. Золотое правило: сервис слушает `127.0.0.1:<порт>`,
  публикуется `deploy/vps/add-route.sh` или `add-site.sh`. Порты заняты: 8080, 9100, 9101, 9110.
- Установлено скриптом `scripts/vps-bootstrap.sh` (wb-headless): Claude Code 2.1.263, Bun 1.4.2,
  ffmpeg, jq, tmux, git, Node 22, Python 3.13. Таймзона MSK.
- Раскладка (принята пользователем):
  ```
  /opt/wb-headless         прод wb-headless, владелец wbheadless, менять ТОЛЬКО deploy/vps/30-deploy-service.sh
  /opt/sirius              дом Сириуса = клон репозитория SolexVK/sirius (CLAUDE.md, .claude/, voice/)
  /opt/sirius/memory       данные памяти (вне git): SOUL/USER/IDENTITY, БД, индексы; бэкап таймером
  /opt/sirius/memory/import сюда пользователь кладёт архив sirius-data-*.tar.gz с Mac Mini
  /opt/sirius/wb-headless  рабочая копия wb-headless (в git sirius игнорируется)
  /opt/sirius/logs
  ```
- Голосовой сервер: `127.0.0.1:9120`, `sirius-voice.service` от `deploy`, сайт `sirius.aidemiko.ru`
  (DNS ещё не заведён — попросить пользователя).

### Как Сириус работает на Claude Code (проверено по документации code.claude.com)
- Постоянная сессия в `tmux` в `/opt/sirius`:
  `claude --remote-control "sirius" --channels plugin:telegram@claude-plugins-official`
- **Remote Control** — управление с телефона/браузера, только по подписке (API-ключ не поддерживается).
  Разрешения на действия подтверждаются из приложения.
- **Channels/Telegram** (research preview, для Max без ограничений): текст/фото/файлы туда-обратно,
  allowlist на одного пользователя. Голосовые сообщения плагин НЕ обрабатывает.
- **Cross-session messaging**: воркеры `claude -p` на той же машине шлют результат в сессию Сириуса.
- **Регулярные задачи**: cron на VPS → `claude -p "<задача>" --resume <id>`; `/loop` внутри сессии
  живёт 7 дней. Bare-режим требует API-ключ — не использовать.
- **Голос в реальном времени**: свой PWA-клиент (HTTPS через Caddy) → WebSocket → VAD (Silero) →
  STT локально на CPU (faster-whisper large-v3-turbo int8 или GigaAM для русского — сравнить) →
  мозг = `claude -p --resume <session> --output-format stream-json --verbose --include-partial-messages`
  (стриминг токенов подтверждён) → нарезка по предложениям → TTS (Piper/Silero локально,
  ElevenLabs/Yandex облаком опционально) → обратно в клиент. Перебивание: клиент глушит воспроизведение,
  сервер сбрасывает TTS-очередь. Латентность 2–5 с — маскировать мгновенным коротким подтверждением.
  Ни Claude Code, ни API Claude не дают TTS; STT только как локальная диктовка (на сервере бесполезна).
- Использование Claude Code из своего приложения по подписке — личное использование; для продукта
  другим людям нужен API-ключ (тогда быстрый путь через Messages API streaming).

### Память Сириуса на Mac Mini (OpenClaw, ЖИВОЙ — не выключать до подтверждения переноса)
- launchd: `ai.openclaw.gateway`, `com.openclaw.cron-wake-server`, `com.sirius.inbox`
  (`sirius-inbox-reader.py --watch`, Postgres `tandem_db`).
- `~/.openclaw/workspace/`: SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, HEARTBEAT.md, TOOLS.md,
  DREAMS.md, ROADMAP.md, `memory/ГГГГ-ММ-ДД.md`, `memory/dreaming/{light,rem,deep}/`, `memory/.dreams/`
  (session-corpus, short-term-recall, phase-signals), `scripts/` (remember/forget/search-memory/
  save-memory/vectorize_instructions/task-*), `skills/` (wb-api, google-sheets),
  `projects/` (self-awareness-kernel, mail-notes, free-claude-code), `docs/task-tracker-architecture.md`.
- Базы: `~/.openclaw/memory/main.sqlite` (109 МБ, векторный индекс OpenClaw), агент 93 МБ, state 58 МБ,
  сессии 5111 .jsonl; **Postgres**: `tandem_db` (ежедневник-трекер), `memory_db`, `wb_analytics`.
- Гелиос: `~/.hermes/` (state.db 135 МБ, memory/helios.db, solex.db, kanban.db), движок в
  `~/.hermes/hermes-agent` (git-клон, в экспорт не входит — см. `helios/HERMES-SOURCE.txt`).
- Целевая модель памяти на VPS (дозирование): L0 ядро (SOUL/IDENTITY/USER/правила, несколько КБ) —
  всегда в контексте через CLAUDE.md; L1 недавнее (дни) — сжатые дневники; L2 архив — поиск
  (векторный + полнотекстовый) через MCP/скрипт, подтягивается по запросу; L3 сырые источники
  (сессии, дампы). Ночная консолидация = «dreaming» через cron-воркер. Детали — из того, что уже
  построено на Mac Mini, не переизобретать.

### Экспорт с Mac Mini
- Скрипт `scripts/macmini-export-sirius.sh` (wb-headless, эта ветка). Запуск на Mac Mini под `openclaw`:
  `cd ~/wb-headless && git pull && mkdir -p ~/sirius-export && bash scripts/macmini-export-sirius.sh 2>&1 | tee ~/sirius-export/export.log`
  Опционально `AGENTS_DIR=/путь/к/базе/агентов` перед командой — база агентов попадёт в `agents-library/`.
- Даёт `~/sirius-export/repo` (знания, → git `SolexVK/sirius`, ветка main) и
  `~/sirius-export/sirius-data-<дата>.tar.gz` (полные данные, → `/opt/sirius/memory/import/`).
- Секреты (credentials/, auth-profiles.json, .pgconfig, .env) исключены; известные форматы ключей
  в текстах заменены на `<redacted>`. Перенос секретов — руками, отдельно.
- Первый прогон 2026-09-06 21:37: Postgres-шаг упал (баг grep — исправлен), в repo попали исходники
  Hermes (исправлено) и .env (исправлено). **Нужен повторный прогон.**

## 3. Статус шагов

| Шаг | Статус |
|---|---|
| VPS bootstrap (Claude Code, Bun, ffmpeg, tmux, /opt/sirius) | ✅ выполнен |
| Логин Claude Code подпиской на VPS, tmux-сессия | ⬜ не сделано (шаги печатает bootstrap в конце) |
| Telegram-бот (BotFather) + плагин + pairing | ⬜ не сделано |
| Репозиторий `SolexVK/sirius` (приватный, пустой) | ✅ создан; доступ Claude-приложению выдан |
| Экспорт с Mac Mini | 🔁 повторить после исправлений |
| Push знаний в `sirius`, scp данных на VPS | ⬜ после повторного экспорта |
| DNS `sirius.aidemiko.ru` → IP VPS | ⬜ попросить пользователя |
| Изучение памяти/Гелиоса/базы агентов | ⬜ следующая сессия, в репозитории `sirius` |
| CLAUDE.md Сириуса, .claude/agents, первый субагент «дежурный по остаткам» | ⬜ |
| Голосовой сервер (voice/), PWA, systemd, Caddy | ⬜ |

## 4. Следующий шаг (с чего начинать новой сессии в репозитории `sirius`)

1. Прочитать `INVENTORY.md`, `workspace/SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`,
   `workspace/memory/memory-system-plan.md`, `docs/task-tracker-architecture.md`, `db/**/*.schema.sql`,
   `config/openclaw.redacted.json`, скрипты памяти в `workspace/scripts/`, затем `helios/`.
2. Составить карту памяти «как было» → «как будет на Claude Code» по слоям L0–L3, с сохранением
   всех данных (Postgres на VPS: поставить, восстановить дампы из архива; SQLite — импорт/конвертация).
3. Написать `CLAUDE.md` Сириуса (ядро L0 из SOUL/IDENTITY/USER + правила единой архитектуры VPS),
   `.claude/settings.json` (разрешения: git, systemctl для своих сервисов, MPStats), `.claude/agents/`.
4. Скрипт установки Сириуса на VPS: клон `sirius` в `/opt/sirius`, импорт архива, Postgres,
   память, cron-воркеры; затем голос.
5. Только после того, как Сириус на VPS подтвердит, что помнит всё, — выключать OpenClaw на Mac Mini.

## 5. Правила общения с пользователем
- Русский язык. Прямо и честно про ограничения. Не обещать того, что не проверено документацией.
- Пользователь не хочет ретранслировать команды; каждую ручную команду — одним копируемым блоком и
  с объяснением, что прислать обратно.
- Не трогать прод (`/opt/wb-headless`, Caddyfile) руками — только скриптами из `deploy/vps/`.
