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

Шаги 0–3 и 5 выполнены, проверки зелёные:

- вход только по ssh-ключу; root по ssh закрыт (`Permission denied (publickey)`),
  пароли выключены; аварийный доступ — веб-консоль (Screen) в панели;
- рабочий пользователь **`deploy`** с ключом и `sudo` без пароля
  (`/etc/sudoers.d/90-deploy`, права даёт ключ — как в облачных образах);
- ufw активен: снаружи только 22/80/443; fail2ban на sshd; unattended-upgrades;
  таймзона Europe/Moscow; swap 2 ГБ;
- Node.js **22.23.2**, npm 10.9.8 (NodeSource);
- `/opt/wb-headless` — ветка `claude/server-setup-fmrhlf`, сервис
  **`wb-headless.service`** слушает `127.0.0.1:8080`, `/health` отвечает `{"ok":true}`;
  секреты в `/opt/wb-headless/.env` (0600, владелец `wbheadless`).

Осталось: шаг 4 (домен → DNS → Caddy, ждём домен), шаг 6 (снапшот и бэкапы),
шаг 7 (переезд сервисов с Mac Mini), шаг 8 (БД, когда понадобится).

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
код → свободный loopback-порт (9100+) → systemd-юнит → `add-route.sh /path 9100` → проверка
снаружи → и только потом гасим сервис на Mac Mini. После каждого — обновляем реестр портов
в [`deploy/vps/README.md`](../deploy/vps/README.md).

### Шаг 8. База данных
Отдельным шагом, когда станет ясно, что храним (история отчётов, очередь задач, пользователи).
Ставим PostgreSQL на localhost, роль/база на сервис, `pg_dump` в ежедневный бэкап.
