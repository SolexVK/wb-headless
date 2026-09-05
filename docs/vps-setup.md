# Настройка VPS (netcup) — с нуля до работающих сервисов

Цель: перенести на собственный сервер то, что временно жило на Mac Mini, и получить понятную
схему, куда добавлять следующие сервисы. Скрипты — в [`deploy/vps/`](../deploy/vps/README.md).

> Параметры нашей конкретной машины (IP, ОС, особенности netcup) и пошаговый план именно для неё —
> [`docs/netcup-server.md`](netcup-server.md). Здесь — общая схема и объяснения.

Итоговая схема:

```
Интернет ──HTTPS──▶ Caddy (:443, авто-TLS Let's Encrypt) ──▶ по пути ──▶ 127.0.0.1:<порт>
                                                                 /wb    → 8080  wb-headless
                                                                 /calc  → 9100  (переедет)
                                                                 ...
```

Отличие от Mac Mini: пропадает Tailscale Funnel с его лимитом «3 публичных порта» и общим на всю
машину конфигом. Остаётся то же золотое правило — **единственная точка входа наружу это Caddy**,
всё остальное слушает loopback.

---

## 0. Что нужно приготовить заранее

- VPS в netcup (панель **SCP** — сервер: образ ОС, консоль, rDNS; панель **CCP** — домены и DNS).
- Домен (или поддомен), которым можно управлять: понадобится A-запись.
- SSH-ключ на своей машине: `ssh-keygen -t ed25519 -C "you@example.com"` (если ещё нет).

**Образ ОС.** Скрипты рассчитаны на Debian 12/13 и Ubuntu 22.04/24.04 и сами определяют дистрибутив.
Если выбор ещё не сделан — ставь **Ubuntu 24.04 LTS**: свежие пакеты, поддержка до 2029, максимум
готовых инструкций в интернете. Debian 12 — тоже нормальный вариант, если хочется поменьше движения.
Разницы для наших скриптов нет.

---

## 1. Первый вход и ключ

В SCP: установить образ ОС → получить IP и root-пароль → войти:

```bash
ssh root@<ip>
```

Сразу залить свой публичный ключ (с локальной машины, во второй вкладке терминала):

```bash
ssh-copy-id root@<ip>
```

Без залитого ключа скрипт `00-bootstrap.sh` **намеренно не станет** выключать вход по паролю,
чтобы не запереть тебя снаружи.

---

## 2. DNS

В CCP (или у своего DNS-провайдера) добавить записи на IP сервера:

| Тип | Имя | Значение |
|---|---|---|
| A | `tools` (или `@`) | IPv4 сервера |
| AAAA | то же имя | IPv6 сервера (netcup выдаёт /64; необязательно, но желательно) |

Проверить, что запись разъехалась по DNS:

```bash
dig +short tools.example.com
```

Пока A-запись не смотрит на сервер, Let's Encrypt сертификат не выпишет — `20-install-caddy.sh`
это проверяет и предупреждает.

Заодно в SCP стоит выставить **rDNS** (PTR) на своё имя — пригодится, если позже сервер будет
отправлять почту/уведомления.

---

## 3. Базовая настройка ОС

```bash
apt-get update && apt-get install -y git
git clone https://github.com/SolexVK/wb-headless.git /opt/wb-headless
cd /opt/wb-headless
bash deploy/vps/00-bootstrap.sh
```

Что делает: обновляет пакеты, ставит базовый набор (curl/git/rsync/jq/htop/tmux), таймзону
`Europe/Moscow`, автоматические security-обновления, создаёт sudo-пользователя `deploy` и копирует
ему ssh-ключи root, закрывает sshd (без root-логина и без паролей), включает fail2ban, поднимает
ufw (наружу только 22/80/443) и создаёт swap 2 ГБ (headless Chrome прожорлив по памяти).

Переменные: `DEPLOY_USER`, `TZ_NAME`, `SWAP_GB`, `SKIP_SSH_HARDENING=1`, `SKIP_FIREWALL=1`.

> **Проверь ДО того, как закроешь текущую сессию:** из второго терминала `ssh deploy@<ip>` должен
> пускать по ключу. Если нет — вернись в открытую root-сессию и удали
> `/etc/ssh/sshd_config.d/99-hardening.conf`, затем `systemctl reload ssh`.

---

## 4. Node.js

```bash
bash deploy/vps/10-install-node.sh          # NODE_MAJOR=22 по умолчанию
```

---

## 5. Caddy и HTTPS

```bash
DOMAIN=tools.example.com ACME_EMAIL=you@example.com bash deploy/vps/20-install-caddy.sh
```

Ставит Caddy из официального репозитория и кладёт `/etc/caddy/Caddyfile` из шаблона: один блок на
домен, внутри — маркеры `BEGIN ROUTES` / `END ROUTES`, между которыми живут маршруты сервисов.
Сертификат Caddy выпускает и продлевает сам, cron не нужен.

Проверка:

```bash
curl -I https://tools.example.com/          # 200 и заглушка
systemctl status caddy
journalctl -u caddy -n 50                   # если сертификат не выписался — причина тут
```

---

## 6. wb-headless как сервис

```bash
bash deploy/vps/30-deploy-service.sh
```

Скрипт: создаёт системного пользователя `wbheadless`, подтягивает код, ставит библиотеки для
headless Chrome, `npm ci --omit=dev`, качает Chrome for Testing в `./chrome`, генерирует `.env`
(со случайным `API_KEY`, `HOST=127.0.0.1`), ставит и запускает systemd-юнит, проверяет `/health`.

Дальше вписать токен и перезапустить:

```bash
sudo -e /opt/wb-headless/.env               # MPSTATS_TOKEN=...
sudo systemctl restart wb-headless
curl -s https://tools.example.com/wb/health
curl -s -H "x-api-key: <ключ из .env>" "https://tools.example.com/wb/reports/niche?path=Женщинам/Одежда/Платья"
```

Обновление после пуша в `main` — тот же скрипт:

```bash
sudo bash /opt/wb-headless/deploy/vps/30-deploy-service.sh
```

**Приватный репозиторий?** Тогда либо заведи на сервере deploy-ключ
(`ssh-keygen -t ed25519 -f ~/.ssh/deploy_key`, публичную часть — в Settings → Deploy keys репозитория,
`REPO_URL=git@github.com:SolexVK/wb-headless.git`), либо заливай код с ноутбука
`rsync -az --exclude node_modules --exclude chrome ./ deploy@<ip>:/opt/wb-headless/` и запускай
скрипт с `SKIP_PULL=1`.

---

## 7. Перенос сервисов с Mac Mini

Порядок для каждого сервиса из реестра в [`MACMINI-DEPLOY.md`](../MACMINI-DEPLOY.md)
(planner 8477, tandemtrace 8899, getcourse 7837, wbcalc 8787):

1. **Скопировать код и данные** (без `node_modules`, с конфигами и базами):
   ```bash
   rsync -az --exclude node_modules --exclude .git \
     ~/path/to/service/ deploy@<ip>:/opt/<service>/
   ```
   Секреты (`.env`, токены, куки-сессии) — отдельно и с правами 600, в git они не лежат.
2. **Выбрать свободный порт** на loopback (9100, 9101, …): `ss -lntp | grep :9100 || echo свободен`.
3. **Автозапуск — systemd-юнит** вместо LaunchAgent: за образец взять
   `deploy/vps/wb-headless.service` (User=<сервисный пользователь>, WorkingDirectory, EnvironmentFile,
   Restart=always). LaunchAgent-плисты не переносятся, логика из них переписывается в юнит.
   Таблица соответствий:

   | Mac Mini (launchd) | VPS (systemd) |
   |---|---|
   | `~/Library/LaunchAgents/com.x.y.plist` | `/etc/systemd/system/y.service` |
   | `launchctl load -w` | `systemctl enable --now y` |
   | `launchctl kickstart -k` | `systemctl restart y` |
   | `StandardOutPath` в файл | `journalctl -u y -f` |
   | `KeepAlive` | `Restart=always` |
   | `StartCalendarInterval` | systemd timer или cron |

4. **Опубликовать через Caddy**: `sudo bash deploy/vps/add-route.sh /calc 9100`.
5. **Проверить снаружи**, только потом гасить сервис на Mac Mini:
   ```bash
   curl -s https://tools.example.com/calc/health
   ```
6. **Обновить реестр портов** в [`deploy/vps/README.md`](../deploy/vps/README.md).

Отдельно: на Mac Mini не выключай `com.tandem.funnel` обратно и вообще не трогай Funnel — пока
часть сервисов ещё там, общий конфиг Funnel остаётся как есть.

---

## 8. Бэкапы

Что реально жалко потерять: `.env` с токенами, `config/*.json`, `reports-output/`, данные
перенесённых сервисов.

Минимальный вариант — ежедневный tar в `/var/backups` + выгрузка на свою машину:

```bash
sudo tee /etc/cron.daily/backup-services >/dev/null <<'SH'
#!/bin/sh
set -e
d=/var/backups/services; mkdir -p "$d"
tar czf "$d/$(date +\%F).tar.gz" \
  /opt/wb-headless/.env /opt/wb-headless/config /opt/wb-headless/reports-output 2>/dev/null || true
find "$d" -name '*.tar.gz' -mtime +14 -delete
SH
sudo chmod +x /etc/cron.daily/backup-services
# забирать к себе: rsync -az deploy@<ip>:/var/backups/services/ ~/backups/vps/
```

В netcup есть свои снапшоты/бэкапы в SCP — включи их как второй слой, но не вместо файловых копий.

---

## 9. База данных (когда понадобится)

Сейчас БД не нужна: wb-headless держит конфиги в `config/*.json`, а результаты пишет файлами в
`reports-output/`. Когда появится, чего в файлах не удержать (история отчётов, очередь задач,
пользователи) — ставим PostgreSQL на этот же сервер:

- `apt-get install -y postgresql`, слушать только `127.0.0.1` (дефолт), доступ по паролю из `.env`;
- отдельная роль и база под каждый сервис, никакого общего суперюзера;
- `pg_dump` в тот же `/etc/cron.daily/backup-services`;
- в приложении — строка подключения из `DATABASE_URL`.

Отдельный шаг, отдельная ветка — сначала решаем, что именно храним.

---

## 10. Шпаргалка

```bash
systemctl status wb-headless caddy         # состояние
journalctl -u wb-headless -n 100 -f        # логи сервиса
journalctl -u caddy -n 100                 # логи прокси и выпуска сертификатов
ss -lntp                                   # кто какие порты слушает
ufw status verbose                         # что открыто наружу
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
df -h; free -h; uptime                     # место, память, нагрузка
```
