# Единый обратный прокси (Caddy) за одним входом Tailscale Funnel

## Зачем
Tailscale Funnel умеет публиковать **только 3 порта** (443/8443/10000), а его конфигурация
**глобальная и общая** для всех сервисов на машине. Раньше на порту 443 два сервиса
мультиплексировались через `--set-path` (`/` → planner, `/calc` → tandemtrace). Любая команда
`tailscale funnel/serve`, тронувшая 443 (а тем более `tailscale serve reset` или голый
`tailscale funnel <порт>`), затирала чужие маршруты → соседний сервис падал. Плюс служба
`com.tandem.funnel` с `KeepAlive=true` каждые ~10 сек переприменяла свой маршрут, добавляя гонок.

Решение: **один Caddy** слушает `127.0.0.1:9000`, Funnel указывает на него весь порт **443**,
маршрутизацию по путям делает Caddy. Добавление/изменение сервисов — это правка `Caddyfile` и
`caddy reload`; **Funnel после первичной настройки больше не трогаем**.

## Схема
```
Интернет ──HTTPS──▶ Tailscale Funnel :443 ──▶ 127.0.0.1:9000 (Caddy) ──┬─ /calc*  → 127.0.0.1:8899 (tandemtrace)
                                                                       └─ /*      → 127.0.0.1:8477 (planner)

Не через Caddy (выделенные funnel-порты, оставлены как есть):
  Funnel :8443  → 127.0.0.1:7837  (getcourse)
  Funnel :10000 → 127.0.0.1:8787  (наш калькулятор WB China FBS)
```

## Раскладка портов (снимок на 2026-08-14, Mac-mini-Vital)
| Сервис                         | Локальный порт | Публичный вход              | launchd label              |
|--------------------------------|----------------|-----------------------------|----------------------------|
| wbheadless.planner             | 8477           | Funnel 443 `/`  (via Caddy) | com.wbheadless.planner     |
| tandemtrace («UNIT-калькулятор»)| 8899          | Funnel 443 `/calc` (via Caddy)| com.tandemtrace.server    |
| tandemtrace prod-api           | (внутр.)       | —                           | com.tandemtrace.prod-api   |
| getcourse.downloader           | 7837           | Funnel 8443 `/`             | com.getcourse.downloader   |
| WB China FBS калькулятор (наш) | 8787           | Funnel 10000 `/`            | com.wbcalc.calculator      |
| старый python-калькулятор      | 8090           | — (не в Funnel)             | com.wb.unit-calc           |
| Caddy (обратный прокси)        | 9000           | (цель Funnel 443)           | homebrew.mxcl.caddy        |

## Важное про пути: strip vs no-strip
Проверено эмпирически: Tailscale с `--set-path=/calc` префикс **НЕ срезает** — бэкенд tandemtrace
на :8899 отдаёт страницу именно по `/calc` (по `/` — пусто). Поэтому в Caddy используем `handle`
(сохраняет полный путь). Если бы приложение обслуживалось по корню, а внешний префикс надо было бы
срезать — использовался бы `handle_path`.

## Установка (macOS, Apple Silicon, Homebrew)
```bash
brew install caddy                                  # если ещё не стоит
cp docs/china-fbs/deploy/Caddyfile /opt/homebrew/etc/Caddyfile
/opt/homebrew/bin/caddy validate --config /opt/homebrew/etc/Caddyfile
brew services start caddy                           # LaunchAgent, поднимается при входе
```
Проверка локально (до переключения Funnel!):
```bash
curl -s http://127.0.0.1:9000/      | head -c 200   # planner
curl -s http://127.0.0.1:9000/calc  | head -c 200   # tandemtrace («UNIT-калькулятор WB»)
```

## Переключение Funnel 443 на Caddy
```bash
# 1. Выключить конфликтующую службу, которая каждые 10 сек переписывает /calc:
launchctl bootout gui/$(id -u)/com.tandem.funnel 2>/dev/null
launchctl disable gui/$(id -u)/com.tandem.funnel 2>/dev/null
# 2. Снять отдельный path-маршрут /calc с порта 443:
tailscale funnel --https=443 --set-path=/calc off
# 3. Направить весь 443 на Caddy:
tailscale funnel --bg --https=443 127.0.0.1:9000
# 4. Проверить:
tailscale funnel status          # 443 → 127.0.0.1:9000 (одна строка, без /calc)
```

## Правила эксплуатации (чтобы новые сервисы не ломали старые)
- **НИКОГДА** не запускать `tailscale serve reset` — снимает ВСЕ Funnel (443/8443/10000).
- **НИКОГДА** не запускать голый `tailscale funnel <порт>` без понимания — перезапишет маршрут `/`.
- Новый публичный сервис на 443 = **правка `Caddyfile` + `caddy reload`**, Funnel не трогаем.
- Отдельные порты 8443/10000 при желании тоже можно завести за Caddy позже (освободив порты),
  но их публичные URL при этом изменятся — по согласованию.
- Тумблер только калькулятора WB China (наш): `tailscale funnel --https=10000 off`.

## Управление Caddy
```bash
brew services restart caddy                                     # применить изменения Caddyfile
/opt/homebrew/bin/caddy reload --config /opt/homebrew/etc/Caddyfile  # без даунтайма
brew services list | grep caddy                                 # статус
tail -f /opt/homebrew/var/log/caddy.log 2>/dev/null             # логи (если настроены)
```

## Перенос на VPS
На Linux Caddy умеет сам получать TLS-сертификаты (Let's Encrypt) — Tailscale Funnel не нужен.
Тот же `Caddyfile`, но вместо `http://127.0.0.1:9000` — публичный домен, напр.:
```
calc.example.com {
    handle /calc* { reverse_proxy 127.0.0.1:8899 }
    handle       { reverse_proxy 127.0.0.1:8477 }
}
```
Caddy сам поднимет HTTPS. Бэкенды (планировщик, калькулятор и т.д.) переносятся как systemd-юниты.
