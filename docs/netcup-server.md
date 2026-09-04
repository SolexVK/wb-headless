# Наш сервер в netcup — паспорт и дорожная карта настройки

Конкретика по машине, на которую переезжаем с Mac Mini. Общая инструкция «как это устроено» —
[`docs/vps-setup.md`](vps-setup.md), скрипты — [`deploy/vps/`](../deploy/vps/README.md).

## Паспорт

| Параметр | Значение |
|---|---|
| Панель | netcup SCP (servercontrolpanel.de), аккаунт SolexVK |
| Сервер | `v2202609409812511656`, ник **SolexVK**, продукт **VPS 4000 G12** |
| Локация | Nuremberg (DE) |
| CPU / RAM | 12 vCPU (12 сокетов × 1 ядро) / 32 ГБ |
| Диск | 1 ТБ, virtio, boot: HDD → CD-ROM → Network |
| Сеть | 2500 Мбит/с, virtio |
| IPv4 | `159.195.41.88/22`, шлюз `159.195.40.1` |
| IPv6 | `2a0a:4cc0:c1:8fbd::/64`, шлюз `fe80::1` |
| rDNS (сейчас) | `v2202609409812511656.ultrasrv.de` |
| ОС | **Debian GNU/Linux 13** — уже установлена, загрузка legacy BIOS (UEFI Boot выключен) |
| Autostart | включён |

## Особенности netcup, которые влияют на настройку

1. **Firewall netcup ≠ защита.** На интерфейсе он «активен», но правила такие: блок исходящего
   SMTP, разрешение ICMP и в конце **неявное Accept all для входящих**. То есть снаружи доступен
   любой порт, который слушает сервис. Реальный фильтр — наш **ufw** (22/80/443), поднимаем его
   ДО того, как появятся сервисы.
2. **Исходящий SMTP заблокирован** (25/465/587, политика `netcup Mail block`). Почтовые
   уведомления с сервера не уйдут — алерты только через HTTPS-API (телеграм-бот, почтовый API).
   Политику не удаляем.
3. **Веб-консоль (вкладка Screen) и Rescue System** — страховка на случай, если закроем себе SSH.
   Поэтому жёсткий ssh-хардненинг безопасен: доступ к машине останется через консоль панели.
4. **UEFI Boot оставить выключенным.** Система установлена в BIOS-режиме; включение тумблера
   сломает загрузку.
5. **Снапшоты**: доступен 1 экспортируемый снапшот, сейчас снапшотов нет. Делаем перед и после
   больших изменений (Media → Snapshots → Create, тип Offline).
6. **Репозиторий `SolexVK/wb-headless` публичный** — клонируется на сервер без ключей и токенов.
   Обратная сторона: в git не должно попадать ничего секретного (`.env` в `.gitignore`).

## Состояние на 03.09.2026

Шаги 0–5 выполнены, сервис доступен снаружи по HTTPS.

- вход только по ssh-ключу; root по ssh закрыт (`Permission denied (publickey)`),
  пароли выключены; аварийный доступ — веб-консоль (Screen) в панели;
- рабочий пользователь **`deploy`** с ключом и `sudo` без пароля
  (`/etc/sudoers.d/90-deploy`, права даёт ключ — как в облачных образах);
- ufw активен: снаружи только 22/80/443; fail2ban на sshd; unattended-upgrades;
  таймзона Europe/Moscow; swap 2 ГБ;
- Node.js **22.23.2**, npm 10.9.8 (NodeSource);
- `/opt/wb-headless` — ветка `claude/server-setup-fmrhlf`, сервис
  **`wb-headless.service`** на `127.0.0.1:8080`; секреты в `.env` (0600, `wbheadless`);
- **Caddy 2.11.4** на 80/443, сертификат Let's Encrypt, логи в journald
  (`journalctl -u caddy`). Публичный вход: **https://tools.aidemiko.ru/**, резервный —
  **https://159-195-41-88.sslip.io/** (оба имени в одном блоке Caddyfile);
  маршрут `/wb` → сервис. Проверено снаружи на обоих именах: `/wb/health` → `{"ok":true}`,
  сертификат валиден, `http` → `https` редиректом 308;
- снапшот-точка возврата в SCP: `base-debian13-node-wbheadless` (Offline, 03.09.2026);
- **цепочка проверена end-to-end**: запрос снаружи на `/wb/reports/niche` вернул
  `http 200` и полноценный JSON-анализ ниши (интернет → Caddy → сервис → MPStats).

Грабли, на которые наступили и которые стоит помнить:

- **Вставка в старое окно PowerShell теряет заглавные буквы.** Так побились и
  `API_KEY` в запросе (`unauthorized`), и `MPSTATS_TOKEN` в `.env`
  (`MPSTATS 401: Authorization Required`). Внутри ssh-сессии вставка правым
  кликом работает корректно — секреты вписывать там, в `nano`.
- Проверять секреты, не раскрывая их:
  `printf %s "$tok" | tr -cd '[:upper:]' | wc -c` — если заглавных ноль, значение битое.

### Домен — подключён 04.09.2026

`tools.aidemiko.ru` резолвится (`A 159.195.41.88`, `AAAA 2a0a:4cc0:c1:8fbd:d44a:5eff:fe71:f3cf`),
зона на серверах DNS-master отвечает, сертификат Let's Encrypt выписан.

История вопроса: сутки домены `aidemiko.ru` и `aidemiko.online` не резолвились вообще —
делегирование в реестре было корректным (whois TCI: `ns3-l2`, `ns4-l2`, `ns8-l2`, `ns4-cloud`,
`ns8-cloud`), зоны в DNS-master заполнены и опубликованы, но серверы услуги не отвечали
авторитативно: Google, Cloudflare и AdGuard давали SERVFAIL, Cloudflare с
`EDE 22 No Reachable Authority at delegation`. Починилось на стороне RU-CENTER.
`aidemiko.online` на 04.09.2026 всё ещё не резолвится — нам он не нужен.

Уроки: панель регистратора показывает намерение, а не факт. Проверять надо резолверами
(`https://dns.google/resolve?name=…`, `https://cloudflare-dns.com/dns-query?name=…` — у Cloudflare
полезная расшифровка EDE) и whois реестра (`https://api.whois.vu/?q=aidemiko.ru`).
Пока домен лежал, работали через `sslip.io` — публичный wildcard-DNS, отдающий IP прямо из имени;
это позволило не ждать регистратора и поднять рабочий HTTPS сразу.

### Как добавить ещё одно имя к сайту

В `/etc/caddy/Caddyfile` имена перечисляются через запятую в строке блока:
```
tools.aidemiko.ru, 159-195-41-88.sslip.io {
```
После правки: `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
и `sudo systemctl reload caddy`. Сертификат на новое имя Caddy выпишет сам.

### Переезд сервисов — начали 04.09.2026

**planner («производственный план») переехал 04.09.2026.** Живёт на `127.0.0.1:9100`,
снаружи — **https://planner.aidemiko.ru/** (отдельный поддомен: во фронтенде зашиты абсолютные
`/api/…` и `/admin`, под префиксом не заработает), сертификат Let's Encrypt, вход по паролю
(`admin` + `PLANNER_PASSWORD` из `/opt/planner/planner/data/.env`). База с Mac Mini перенесена
целиком (`planner.db` 117 МБ, `samples/`, `plans/`, `wb-cache/`), сохранённые версии на месте,
launchd-агент на Mac Mini выключен. Инструкция: [`docs/planner-migration.md`](planner-migration.md).

Что заметили по дороге:

- `/opt/wb-headless` принадлежит `wbheadless`, а работаем мы под `deploy` — `git pull` падает
  на «dubious ownership» и молча ничего не обновляет. Обновлять от root
  (`sudo git config --global --add safe.directory …`), потом возвращать владельца.
- В `planner/data` на Mac Mini рядом с `.env` лежали `.env.bak` и `.env.save` — при упаковке
  исключать `.env*`, иначе старые секреты уезжают на сервер.
- У Mac Mini не было своего ssh-ключа: завели `~/.ssh/id_ed25519` и добавили в
  `authorized_keys` пользователя `deploy` — понадобится и для остальных сервисов.

### Доступ к planner — настроен 04.09.2026

Вход только через Telegram. Условие доступа для сотрудников — **членство в рабочей
группе** (`STAFF_CHAT_ID` в `planner/data/.env`): человек открывает обычный адрес,
бот сверяет членство через `getChatMember` и выдаёт права сам. Убрали из группы —
доступ снимается при следующем входе либо фоновой перепроверкой (раз в час на
человека). Ссылок с кодами не осталось: витрина `demo.aidemiko.ru` открывается
сразу (`GUEST_AUTO=1`), коды приглашений остались отключённым запасным путём.
Подробности — [`planner/deploy/AUTH-SETUP.md`](https://github.com/SolexVK/wb-headless/blob/claude/production-plan-twv8ki/planner/deploy/AUTH-SETUP.md).

### Бэкапы — шаг 6

`deploy/vps/50-install-backups.sh` ставит systemd-таймер: ежедневно в 03:20 снимок
`planner.db` (через `VACUUM INTO` — `cp` живой базы даёт неполную копию), `state.json`,
`.env`-файлы, `Caddyfile` и список развёрнутых версий. Хранение 14 дней в
`/var/backups/planner`. Это защита от порчи данных и ошибки, но НЕ от потери сервера:
копию нужно регулярно забирать наружу.

Осталось: шаг 7 (остальные сервисы с Mac Mini), шаг 8 (БД, когда понадобится).

## Дорожная карта

Отмечай шаги по мере прохождения. Каждый шаг заканчивается проверкой — не переходим дальше,
пока она не зелёная.

### Шаг 0. Что нужно на руках
- [ ] root-пароль сервера (письмо netcup) — либо сброс в SCP → сервер → **Access**.
- [ ] SSH-ключ на рабочем компьютере. Если нет: `ssh-keygen -t ed25519 -C "solexvk"`
      (одинаково в macOS Terminal и Windows PowerShell), Enter на все вопросы.
- [ ] Домен (нужен только на шаге 4; до него всё делается по IP).

### Шаг 1. Первый вход и ключ
```bash
ssh root@159.195.41.88            # пароль из письма netcup
passwd                            # сменить root-пароль на свой
```
С рабочего компьютера, во втором окне:
```bash
ssh-copy-id root@159.195.41.88    # macOS/Linux
# Windows PowerShell:
# type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@159.195.41.88 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```
**Проверка:** `ssh root@159.195.41.88` пускает без пароля.

### Шаг 2. Базовая настройка ОС
```bash
apt-get update && apt-get install -y git
git clone https://github.com/SolexVK/wb-headless.git /opt/wb-headless
cd /opt/wb-headless
bash deploy/vps/00-bootstrap.sh
```
Создаст пользователя `deploy`, скопирует ему ключ, закроет ssh (без root-логина и паролей),
включит ufw (22/80/443), fail2ban, автообновления, swap 2 ГБ, таймзону Europe/Moscow.

**Проверка (обязательно, не закрывая текущую сессию):** из второго окна `ssh deploy@159.195.41.88`
пускает по ключу, `sudo -v` работает. Если что-то пошло не так — вкладка **Screen** в панели,
удалить `/etc/ssh/sshd_config.d/99-hardening.conf`, `systemctl reload ssh`.
Затем: `ufw status verbose` → активен, открыты 22/80/443.

### Шаг 3. Node.js
```bash
sudo bash /opt/wb-headless/deploy/vps/10-install-node.sh
```
**Проверка:** `node -v` → v22.x, `npm -v` отвечает.

### Шаг 4. Домен, DNS и Caddy
1. У регистратора: `A` запись на `159.195.41.88`. IPv6 (`AAAA`) — только после
   `ip -6 addr show` на сервере, если адрес реально поднят.
2. В SCP → Network → Reverse DNS: поменять rDNS на своё имя (для почты/репутации).
3. Дождаться DNS: `dig +short tools.example.com` → наш IP.
4. ```bash
   sudo DOMAIN=tools.example.com ACME_EMAIL=solexvk@gmail.com \
     bash /opt/wb-headless/deploy/vps/20-install-caddy.sh
   ```

**Проверка:** `curl -I https://tools.example.com/` → 200 и валидный сертификат;
`journalctl -u caddy -n 30` без ошибок ACME.

### Шаг 5. wb-headless как сервис
```bash
sudo bash /opt/wb-headless/deploy/vps/30-deploy-service.sh
sudo nano /opt/wb-headless/.env        # вписать MPSTATS_TOKEN, запомнить API_KEY
sudo systemctl restart wb-headless
```
**Проверка:**
```bash
curl -s https://tools.example.com/wb/health
curl -s -H "x-api-key: <ключ>" "https://tools.example.com/wb/reports/niche?path=Женщинам/Одежда/Платья&maxRows=200"
journalctl -u wb-headless -n 50
```

### Шаг 6. Точка возврата и бэкапы
- Снапшот в SCP (Media → Snapshots) с именем вроде `base-debian13-caddy-wbheadless`.
- Ежедневный tar конфигов и отчётов — раздел «Бэкапы» в [`docs/vps-setup.md`](vps-setup.md).

### Шаг 7. Переезд сервисов с Mac Mini
По одному, по инструкции «Перенос сервисов» в [`docs/vps-setup.md`](vps-setup.md):
код → свободный loopback-порт (9100+) → systemd-юнит → публикация (`add-route.sh /path 9101`
на общем домене или `add-site.sh sub.aidemiko.ru 9101` отдельным поддоменом) → проверка
снаружи → и только потом гасим сервис на Mac Mini. После каждого — обновляем реестр портов
в [`deploy/vps/README.md`](../deploy/vps/README.md).

- [x] **planner** — `https://planner.aidemiko.ru/`, порт 9100,
      [`docs/planner-migration.md`](planner-migration.md)
- [x] **planner ДЕМО** — `https://demo.aidemiko.ru/`, порт 9101, обезличенная копия базы,
      вход по гостевой ссылке без Telegram ([`docs/planner-demo.md`](planner-demo.md))
- [ ] FBS-аналитика, getcourse, wbcalc, telegram-бот, дашборд остатков
- [ ] UNIT-калькулятор (порт 8899) — решаем позже, код пока не локализован

### Шаг 8. База данных
Отдельным шагом, когда станет ясно, что храним (история отчётов, очередь задач, пользователи).
Ставим PostgreSQL на localhost, роль/база на сервис, `pg_dump` в ежедневный бэкап.
