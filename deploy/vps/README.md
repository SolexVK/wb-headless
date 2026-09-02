# deploy/vps — настройка VPS (netcup) под наши сервисы

Модель та же, что была на Mac Mini, только без Tailscale Funnel:

```
Интернет ──HTTPS──▶ Caddy (:80/:443, авто-TLS) ──▶ по пути ──▶ сервис на 127.0.0.1:<порт>
```

**Золотое правило:** наружу слушает только Caddy. Любой сервис — на `127.0.0.1:<свободный порт>`,
публикуется добавлением маршрута в `/etc/caddy/Caddyfile` (скриптом `add-route.sh`). Так новый
сервис не может уронить соседей: ufw держит закрытыми все порты, кроме 22/80/443.

Подробная инструкция с нуля (заказ, DNS, перенос с Mac Mini, бэкапы): [`docs/vps-setup.md`](../../docs/vps-setup.md).

## Порядок запуска (от root, по одному)

```bash
apt-get update && apt-get install -y git
git clone https://github.com/SolexVK/wb-headless.git /opt/wb-headless
cd /opt/wb-headless

bash deploy/vps/00-bootstrap.sh                      # юзер, ssh, ufw, fail2ban, swap, автообновления
bash deploy/vps/10-install-node.sh                   # Node.js 22 LTS
DOMAIN=tools.example.com ACME_EMAIL=you@example.com \
  bash deploy/vps/20-install-caddy.sh                # Caddy + сертификат Let's Encrypt
bash deploy/vps/30-deploy-service.sh                 # wb-headless как systemd-сервис
```

После этого:

```bash
curl -s https://tools.example.com/wb/health          # {"ok":true,...}
journalctl -u wb-headless -f                         # логи сервиса
systemctl restart wb-headless                        # после правки .env
```

## Файлы

| Файл | Что делает |
|---|---|
| `00-bootstrap.sh` | Базовая настройка ОС: пакеты, таймзона, sudo-пользователь, ssh-хардненинг, ufw, fail2ban, unattended-upgrades, swap |
| `10-install-node.sh` | Node.js LTS из репозитория NodeSource (`NODE_MAJOR=22`) |
| `20-install-caddy.sh` | Caddy из офиц. репозитория + `Caddyfile` под твой домен, проверка DNS |
| `30-deploy-service.sh` | Клон/обновление кода, `.env`, зависимости, Chrome for Testing, systemd-юнит, health-check |
| `add-route.sh` | Добавить маршрут нового сервиса в Caddy (валидация + откат при ошибке) |
| `Caddyfile.template` | Шаблон общего конфига Caddy с маркерами `BEGIN/END ROUTES` |
| `wb-headless.service` | Шаблон systemd-юнита (loopback, авто-рестарт, journald, ограничения) |

Все скрипты идемпотентны: повторный запуск = обновление, а не поломка.

## Реестр портов VPS

Занимать только свободные. Обновлять таблицу при добавлении сервиса.

| Порт (127.0.0.1) | Сервис | Публичный путь | systemd unit |
|---|---|---|---|
| 8080 | wb-headless | `https://<домен>/wb/` | `wb-headless.service` |
| 9100+ | свободны под переезд с Mac Mini (planner, tandemtrace, getcourse, wbcalc) | — | — |
| 2019 | Caddy admin (loopback) | — | `caddy.service` |

Проверить, свободен ли порт: `ss -lntp | grep :9100 || echo свободен`

## Добавить новый сервис

```bash
# 1) сервис слушает 127.0.0.1:9100, автозапуск — свой systemd-юнит (за образец: wb-headless.service)
# 2) публикуем по пути /mytool:
sudo bash deploy/vps/add-route.sh /mytool 9100          # префикс срезается (сервис живёт на /)
sudo bash deploy/vps/add-route.sh /mytool 9100 --keep   # префикс сохраняется
# 3) проверяем
curl -s https://<домен>/mytool/health
```

## Чего НЕ делать

- Не открывать порты сервисов в ufw — только 22/80/443.
- Не редактировать `Caddyfile` «поверх» через перезапись файла целиком — маршруты соседей потеряются;
  добавляй блоки скриптом или руками ВЫШЕ маркера `END ROUTES`.
- Не хранить токены в git: они живут в `/opt/wb-headless/.env` (0600, владелец `wbheadless`).
- Не запускать сервис от root — для этого есть системный пользователь `wbheadless`.
