# Handoff — настройка сервера netcup и переезд с Mac Mini

## Цель
Перенести инструменты и сервисы с общего Mac Mini на собственный VPS в netcup: настроить сервер
с нуля (доступ, защита, Node, обратный прокси с HTTPS), развернуть на нём `wb-headless`, а затем
по одному переселить остальные сервисы (planner, tandemtrace/калькулятор, getcourse, wbcalc).
Схема как на Mac Mini, но без Tailscale Funnel: наружу смотрит только Caddy, сервисы слушают
`127.0.0.1:<порт>` и публикуются маршрутами по путям (`/wb`, `/calc`, `/planner`, …).

## Текущее состояние
Работа идёт в ветке `claude/server-setup-fmrhlf` (в `main` НЕ влита, PR не открывался).
Сервер настроен и работает, сервис доступен снаружи по HTTPS.

Что зелёное:
- Доступ только по ssh-ключу; root по ssh закрыт (`Permission denied (publickey)`), пароли выключены.
  Аварийный вход — веб-консоль netcup (вкладка Screen), там root с паролем.
- Пользователь `deploy` с ключом и `sudo` без пароля (`/etc/sudoers.d/90-deploy`).
- ufw: снаружи только 22/80/443; fail2ban на sshd; unattended-upgrades; таймзона Europe/Moscow;
  swap 2 ГБ.
- Node.js 22.23.2, npm 10.9.8 (NodeSource).
- `wb-headless.service` слушает `127.0.0.1:8080`, автозапуск, секреты в `/opt/wb-headless/.env`
  (0600, владелец `wbheadless`).
- Caddy 2.11.4 на 80/443, сертификаты Let's Encrypt, логи в journald. Публичный вход:
  **https://tools.aidemiko.ru/**, резервный — **https://159-195-41-88.sslip.io/**
  (оба имени в одном блоке Caddyfile), маршрут `/wb` → сервис.
- Цепочка проверена end-to-end: запрос снаружи на `/wb/reports/niche` вернул `http 200`
  и полный JSON-анализ ниши (интернет → Caddy → сервис → MPStats).
- Снапшот-точка возврата в SCP: `base-debian13-node-wbheadless` (Offline, 03.09.2026) — сделан
  ДО установки Caddy и до правки токена.

Что красное:
- `aidemiko.online` по-прежнему не резолвится (SERVFAIL). Нам он не нужен — работаем на `.ru`.
  (`aidemiko.ru` лежал сутки по той же причине и починился на стороне RU-CENTER 04.09.2026;
  подробности и уроки — в `docs/netcup-server.md`.)

Параметры сервера (полный паспорт — `docs/netcup-server.md`): VPS 4000 G12, Nuremberg,
12 vCPU / 32 ГБ / 1 ТБ, IPv4 `159.195.41.88`, IPv6 `2a0a:4cc0:c1:8fbd:d44a:5eff:fe71:f3cf`,
Debian 13 (trixie), загрузка legacy BIOS (UEFI Boot не включать).

## Файлы, над которыми работали
- `deploy/vps/00-bootstrap.sh` — базовая настройка ОС: пакеты (+`sudo`), таймзона, автообновления,
  пользователь `deploy` с ключом и sudoers NOPASSWD, ssh-хардненинг, fail2ban, ufw, swap.
- `deploy/vps/10-install-node.sh` — Node LTS из NodeSource; поправлена проверка уже стоящей версии.
- `deploy/vps/20-install-caddy.sh` — Caddy из офиц. репозитория; домен и почта принимаются
  позиционными аргументами; проверка совпадения DNS с IP; проверка `systemctl is-active` после старта.
- `deploy/vps/30-deploy-service.sh` — деплой `wb-headless`: системный пользователь, библиотеки для
  headless Chrome, `.env` со случайным `API_KEY`, Chrome for Testing, systemd-юнит, health-check;
  ветка по умолчанию — текущая в `APP_DIR`, а не `main`.
- `deploy/vps/Caddyfile.template` — общий конфиг Caddy с маркерами `BEGIN/END ROUTES`; логи доступа
  переведены в journald.
- `deploy/vps/add-route.sh` — добавление маршрута нового сервиса с валидацией и откатом.
- `deploy/vps/wb-headless.service`, `deploy/vps/README.md` — юнит и реестр портов/правила.
- `docs/vps-setup.md` — общая инструкция по VPS (схема, шаги, перенос с Mac Mini, бэкапы).
- `docs/netcup-server.md` — паспорт нашей машины, особенности netcup, дорожная карта, состояние,
  грабли, команда переключения на домен.
- `server.js` — добавлен `HOST` (по умолчанию `0.0.0.0`, на VPS `127.0.0.1`), предупреждение при
  дефолтном `API_KEY` на публичном интерфейсе, корректная остановка по SIGTERM для systemd.
- `.env.example` — описан `HOST`.
- `MACMINI-DEPLOY.md` — врезка со ссылкой на новые доки (Mac Mini пока живой, Funnel не трогаем).

## Что изменилось
- Появился готовый набор скриптов для VPS: четыре шага по порядку + помощник для маршрутов.
  Все идемпотентны — повторный запуск обновляет, а не ломает.
- Сервис перестал быть привязан к «слушать всё»: `HOST=127.0.0.1` + Caddy как единственная точка входа.
- Публикация наружу устроена по путям, добавление сервиса = одна команда `add-route.sh /path 9100`.
- Задокументирована конкретика netcup, которая влияет на решения: их firewall пропускает все
  входящие (реальный фильтр — ufw), исходящий SMTP заблокирован (алерты только по HTTPS-API),
  веб-консоль как страховка, UEFI Boot не включать.

## Что пробовали и НЕ сработало
- **Вставка в старое окно PowerShell теряет заглавные буквы.** Самая дорогая грабля дня.
  `C:\Users\SystemX` превращалось в `:\sers\ystem`, `$env:USERPROFILE` — в `$env:`. Из-за этого:
  root-пароль «не подходил» по ssh (а в веб-консоли, где набирали руками, заходил);
  `API_KEY` в запросе давал `unauthorized`; `MPSTATS_TOKEN` в `.env` — `MPSTATS 401`.
  Обход: команды без заглавных букв, пути целиком вместо переменных, секреты набирать руками или
  вставлять уже внутри ssh-сессии (там правым кликом вставляется корректно — проверено
  `echo test-ABC-xyz`). Проверка секрета не раскрывая значение:
  `printf %s "$tok" | tr -cd '[:upper:]' | wc -c` — ноль заглавных = битое значение.
- **`tr -d \r` без кавычек** (моя ошибка в инструкции) — bash понял как `tr -d r` и вырезал из
  ssh-ключа все буквы `r`. Ключ выглядел правдоподобно (в начале строки `r` нет), но не работал.
  Правильно: `sed -i 's/\r$//' файл` или `tr -d '\r'` в кавычках.
- **Образ netcup запрещает root-логин по паролю в sshd.** Пароль верный, но ssh отвечает так же,
  как на неверный. Диагностика — вход через веб-консоль. Обход: временный drop-in
  `/etc/ssh/sshd_config.d/99-temp-password.conf` с `PermitRootLogin yes` + `PasswordAuthentication yes`,
  залить ключ, потом файл удалить.
- **`adduser --disabled-password` + группа sudo** — пользователь не мог ничего администрировать:
  пароля нет, а sudo его требует. Починено правилом NOPASSWD в `/etc/sudoers.d/`.
- **Caddy падал при старте с `open /var/log/caddy/access.log: permission denied`.** Юнит из пакета
  идёт с `ProtectSystem=full`, запись разрешена только в `/var/lib/caddy`. Не помог ни правильный
  владелец каталога, ни drop-in с `LogsDirectory=caddy` (переменная `LOGS_DIRECTORY` пробрасывалась,
  но ошибка та же). Решение: убрать файловый лог из Caddyfile, логи доступа — в journald.
- **`handle_path` с именованным матчером** (`@wb`) — Caddy требует inline-путь. Правильно:
  `redir /wb /wb/` + `handle_path /wb/* { … }`.
- **DNS у RU-CENTER.** Переключение радиокнопки «DNS-master Unicast» до реестра не доезжало;
  помог ручной ввод серверов в «Указать DNS-серверы самостоятельно» — whois после этого показал
  верные NS. Но зона на серверах услуги так и не поднялась (SERVFAIL, EDE 22). Красная плашка
  «Домен делегирован на сторонние DNS-серверы» после ручного ввода — ложная, она сравнивает не с
  реестром. Вывод: ждать бессмысленно, вопрос закрывается только через поддержку.
- **Проверка панелью вместо фактов.** Панель RU-CENTER показывала одно, реальность — другое.
  Проверять надо резолверами: `https://dns.google/resolve?name=…`, `https://cloudflare-dns.com/dns-query?name=…`
  (у Cloudflare полезная расшифровка EDE) и whois реестра (`https://api.whois.vu/?q=aidemiko.ru`).

## Команды для проверки
Формальных тестов в репозитории нет. Проверка — синтаксис, статус сервисов и живые запросы.

```bash
# 1. Синтаксис (в этом репозитории, локально)
for f in deploy/vps/*.sh; do bash -n "$f"; done
for f in server.js lib/*.js report-niche.js report-stock.js; do node --check "$f"; done

# 2. На сервере: состояние сервисов
ssh deploy@159.195.41.88
systemctl is-active wb-headless caddy          # ждём active active
sudo ss -lntp | grep -E ':(80|443|8080)'       # 8080 только на 127.0.0.1
ufw status verbose                             # активен, открыты 22/80/443

# 3. Снаружи (из PowerShell на своём компьютере — именно curl.exe)
curl.exe -s https://tools.aidemiko.ru/wb/health                # {"ok":true,...}
curl.exe -s -o nul -w "%{http_code}\n" https://tools.aidemiko.ru/wb/reports/niche  # 401 без ключа

# 4. Боевой отчёт (на сервере, ключ читаем из .env — не вставляем руками)
key=$(sudo grep -i '^api_key=' /opt/wb-headless/.env | cut -d= -f2 | tr -d '\r')
curl -s --header "x-api-key: $key" -o /tmp/niche.json -w 'http %{http_code}\n' \
  "https://tools.aidemiko.ru/wb/reports/niche?path=%d0%96%d0%b5%d0%bd%d1%89%d0%b8%d0%bd%d0%b0%d0%bc/%d0%9e%d0%b4%d0%b5%d0%b6%d0%b4%d0%b0/%d0%9f%d0%bb%d0%b0%d1%82%d1%8c%d1%8f&maxRows=200"
head -c 300 /tmp/niche.json

# 5. Состояние DNS доменов (с любой машины с интернетом)
curl -s "https://dns.google/resolve?name=tools.aidemiko.ru&type=A"

# 6. Логи
sudo journalctl -u wb-headless -n 50 --no-pager
sudo journalctl -u caddy -n 50 --no-pager
```

**Ожидаемое состояние (зелёное на 04.09.2026):** `bash -n` и `node --check` — OK;
`wb-headless` и `caddy` — `active`; снаружи `/wb/health` → `{"ok":true}`, без ключа → `401`,
с ключом `/wb/reports/niche` → `http 200` и JSON с данными; сертификат валиден, `http` → `https` (308).
**Красное и ожидаемо красное:** `tools.aidemiko.online` не резолвится (`Status 2` / SERVFAIL) —
домен `.online` мы не используем. Если `/wb/health` перестанет отвечать — смотреть логи по п.6.

## Открытые вопросы (нужно решение пользователя)
- ~~Ответ RU-CENTER по зонам~~ — закрыт: зона `aidemiko.ru` заработала 04.09.2026,
  домен подключён, переезд на Cloudflare не понадобился.
- **Влить ли ветку `claude/server-setup-fmrhlf` в `main`.** Сейчас сервер работает именно с этой
  ветки, а в `main` скриптов нет. Рекомендация: открыть PR и влить, чтобы `main` был источником
  правды, а на сервере переключиться на `main`. ЖДУ РЕШЕНИЯ (PR не открывался).
- **Порядок переезда сервисов с Mac Mini.** Кандидаты: planner (8477), tandemtrace/калькулятор (8899),
  getcourse (7837), wbcalc (8787). Рекомендация: начать с самого простого и наименее критичного,
  чтобы обкатать процедуру. ЖДУ ВЫБОРА, с какого начинаем.
- Схема адресов уже выбрана — пути (`домен/wb`, `домен/calc`), не поддомены. Вопрос закрыт.

## Следующий шаг
Сделать свежий снапшот в SCP (Media → Snapshots, Offline) с именем вроде
`base-debian13-caddy-domain` — текущая точка возврата сделана до установки Caddy, до исправления
токена и до подключения домена. После этого выбрать первый сервис для переезда с Mac Mini и пройти процедуру
из раздела «Перенос сервисов» в `docs/vps-setup.md`: код на сервер → свободный порт 9100+ →
systemd-юнит по образцу `deploy/vps/wb-headless.service` → `sudo bash deploy/vps/add-route.sh /calc 9100`
→ проверка снаружи → и только потом гасим сервис на Mac Mini.
