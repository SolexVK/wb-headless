# Публикация FBS-сервиса на Mac Mini (через Caddy)

Топология на машине (из `tailscale funnel status` и Caddy admin API):

```
Tailscale Funnel  https://mac-mini-vital.tail13d29e.ts.net (:443)
        │  проксирует на
        ▼
Caddy   127.0.0.1:9000   (--config /opt/homebrew/etc/Caddyfile, auto_https off)
        ├─ handle /calc*  → 127.0.0.1:8899
        └─ (остальное)    → 127.0.0.1:8477
```

Наш сервис слушает **`127.0.0.1:9110`** (только loopback). Публикуем его
**путём** `/fbs` на том же домене (поддоменов у `.ts.net` нет). Funnel и порт
443 руками не трогаем — добавляем только маршрут в Caddy и делаем `reload`.

## Публичный адрес

```
https://mac-mini-vital.tail13d29e.ts.net/fbs/
```

## 1. Настроить сервис под префикс

В `service/.env` задать (плюс уже существующие `SESSION_SECRET`, `TOKEN_ENC_KEY`):

```
BASE_PATH=/fbs
NODE_ENV=production
```

`BASE_PATH` заставляет все ссылки/редиректы/куки работать под `/fbs`.
`NODE_ENV=production` включает `secure`-cookie (TLS терминирует Tailscale).

## 2. Добавить path-маршрут в Caddy

В `/opt/homebrew/etc/Caddyfile`, в блок сайта `:9000`, **перед** финальным
`reverse_proxy` (catch-all) добавить (важно: `handle`, НЕ `handle_path` —
префикс не срезаем, приложение ждёт полный путь `/fbs/...`):

```
	handle /fbs* {
		reverse_proxy 127.0.0.1:9110
	}
```

Проверить и применить без перезапуска (Funnel/443 не трогаются):

```
caddy validate --config /opt/homebrew/etc/Caddyfile
caddy reload --config /opt/homebrew/etc/Caddyfile
```

Проверка: `curl -s http://127.0.0.1:9000/fbs/healthz` → `{"status":"ok",...}`.

## 3. Держать сервис живым — LaunchAgent

Свой agent с **уникальным** label (чужие launchd не трогаем). Файл
`~/Library/LaunchAgents/com.wbheadless.fbs.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wbheadless.fbs</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--experimental-sqlite</string>
    <string>/Users/openclaw/wb-fbs/service/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/openclaw/wb-fbs/service</string>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/openclaw/wb-fbs/service/data/stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/openclaw/wb-fbs/service/data/stderr.log</string>
</dict></plist>
```

(сервис сам читает `.env` через dotenv — секреты в plist не кладём).

```
launchctl load  ~/Library/LaunchAgents/com.wbheadless.fbs.plist
launchctl list | grep com.wbheadless.fbs
```

Обновление кода: `git pull` → `launchctl kickstart -k gui/$(id -u)/com.wbheadless.fbs`.

## Границы (правила Mac Mini)

- Слушаем только `127.0.0.1:9110`. Наружу — только через Caddy на 443.
- `tailscale serve/funnel` не трогаем; порт 443 и чужие launchd — не трогаем.
- Занятые порты (8477/8787/8899/7837/8090/9000/8443/10000/2019) не занимаем.
- Секреты только в `.env` (в git не коммитим); WB-токены шифруются AES-256-GCM.
