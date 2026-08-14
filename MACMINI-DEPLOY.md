# 🖥️ Как добавлять сервисы на общий Mac Mini (не сломав остальные)

Единая инструкция для **всех веток/сервисов**. Модель работы:

> В разных ветках я делаю разные инструменты/сервисы. Все они временно живут на одном
> **Mac Mini** и должны работать одновременно. Позже всё переедет на VPS.

Ключ к «не сломать» — **один общий вход**. Наружу торчит Tailscale Funnel (публичный HTTPS), а всю
раздачу по адресам делает **один Caddy**. Новый сервис = добавить строчку в Caddy, **Funnel не
трогаем**. Так один сервис не может уронить другой.

```
Интернет ──HTTPS──▶ Tailscale Funnel ──▶ Caddy (127.0.0.1:9000) ──▶ по пути в нужный сервис
```

---

## Золотое правило
**Новый публичный сервис добавляется ТОЛЬКО через Caddy (маршрут по пути на порту 443).
Команды `tailscale funnel/serve` для этого запускать НЕ нужно.**

Причина: конфиг Tailscale Funnel — один на всю машину и общий. Любая команда `tailscale funnel …`
перезаписывает общий конфиг и может снести маршруты соседей (уже наступали). Caddy же меняется
локально и по одному сервису, без риска для остальных.

---

## Реестр портов (снимок 2026-08-14) — НЕ занимать чужое
| Локальный порт | Сервис | Публичный вход | launchd label |
|---|---|---|---|
| 8477 | planner | Funnel **443** `/` (через Caddy) | com.wbheadless.planner |
| 8899 | tandemtrace («UNIT-калькулятор») | Funnel **443** `/calc` (через Caddy) | com.tandemtrace.server |
| — | tandemtrace prod-api (внутр.) | — | com.tandemtrace.prod-api |
| 7837 | getcourse | Funnel **8443** `/` (напрямую) | com.getcourse.downloader |
| 8787 | WB China FBS калькулятор | Funnel **10000** `/` (напрямую) | com.wbcalc.calculator |
| 8090 | старый python-калькулятор | — (не в Funnel) | com.wb.unit-calc |
| 9000 | **Caddy** (обратный прокси) | цель Funnel 443 | homebrew.mxcl.caddy |
| 2019 | Caddy admin (loopback) | — | — |

`com.tandem.funnel` — **намеренно выключена** (`launchctl disable`), обратно не включать.

Funnel умеет всего **3 публичных порта: 443 / 8443 / 10000**. 8443 и 10000 заняты напрямую;
443 — общий вход через Caddy. **Все новые сервисы вешаем на 443 через Caddy по пути** — так лимит
в 3 порта не мешает, сколько бы сервисов ни было.

---

## Добавить свой новый сервис — пошагово
Пусть сервис слушает `127.0.0.1:9100` и должен открываться по пути `/mytool`.

**1. Сервис — только на loopback и на свободном порту.** Слушать `127.0.0.1:<порт>`, не `*`.
Свободные порты подряд: 9100, 9101, 9102… Проверить, что порт свободен:
```bash
lsof -nP -iTCP:9100 -sTCP:LISTEN || echo "9100 свободен"
```

**2. Автозапуск — свой LaunchAgent с уникальным label** `com.<проект>.<сервис>` в
`~/Library/LaunchAgents/`. Пример-шаблон — `docs/china-fbs/deploy/install-launchd.sh`.
Не переиспользуй чужие label.

**3. Добавь маршрут в Caddy.** Открой `/opt/homebrew/etc/Caddyfile` и вставь блок **ВЫШЕ**
дефолтного `handle` (порядок важен — специфичные пути раньше общего):
```
@mytool path /mytool /mytool/*
handle @mytool {
	reverse_proxy 127.0.0.1:9100
}
```
- `handle` берёт **один** путь-аргумент → несколько путей задаём через именованный матчер `@…`.
- Приложение живёт прямо на `/mytool` → `handle` (путь сохраняется). Если оно обслуживается на
  корне `/`, а внешний префикс надо срезать → используй `handle_path` вместо `handle`.

**4. Применить без даунтайма:**
```bash
/opt/homebrew/bin/caddy validate --config /opt/homebrew/etc/Caddyfile && \
/opt/homebrew/bin/caddy reload --config /opt/homebrew/etc/Caddyfile
```

**5. Проверить (в т.ч. «внешний» кейс с реальным Host):**
```bash
curl -s -H 'Host: mac-mini-vital.tail13d29e.ts.net' http://127.0.0.1:9000/mytool | head -c 200
```
Затем открыть с телефона (мобильный интернет): `https://mac-mini-vital.tail13d29e.ts.net/mytool`.

**6. Сохрани изменение Caddyfile в репо** (канонич. копия — `docs/china-fbs/deploy/Caddyfile`),
чтобы не потерять и легко перенести на VPS.

---

## Полный рабочий Caddyfile (текущий) — для справки
`/opt/homebrew/etc/Caddyfile`:
```
{
	auto_https off
}

:9000 {
	bind 127.0.0.1

	@calc path /calc /calc/*
	handle @calc {
		reverse_proxy 127.0.0.1:8899
	}

	handle {
		reverse_proxy 127.0.0.1:8477
	}
}
```
Свои сервисы добавляй новыми `@name`/`handle`-блоками перед последним `handle`.

Установка Caddy (если на чистой машине ещё нет): `brew install caddy`, положить Caddyfile в
`/opt/homebrew/etc/Caddyfile`, запустить `brew services start caddy`.

---

## 🚫 НЕЛЬЗЯ (ломает соседей)
- **`tailscale serve reset`** — снесёт ВСЕ Funnel (443/8443/10000). Никогда.
- **Голый `tailscale funnel <порт>`** / любые `tailscale funnel --https=443 …` — перезапишут общий
  конфиг и маршрут `/` на 443. Для добавления сервиса это не нужно — используй Caddy.
- **Занимать чужие порты** из реестра выше.
- **Включать `com.tandem.funnel`** обратно.
- **Трогать чужие launchd** (`com.tandemtrace.*`, `com.getcourse.*`, `com.wbheadless.planner`) —
  не выгружать, не перезапускать, plist не редактировать.
- **Коммитить секреты** (пароли, токены, `users.json`, `.auth-secret`) — только в env / plist
  (chmod 600), в git не класть.

## ✅ МОЖНО / РЕКОМЕНДОВАНО
- `brew install <x>` — безопасно (аддитивно).
- Свой сервис на свободном loopback-порту + свой LaunchAgent.
- Публиковать только через Caddy (path на 443), Funnel не трогать.
- Всегда тест локально ДО показа наружу (включая `-H 'Host: …'`).
- `git pull` и перезапуск ТОЛЬКО своей службы.

---

## Грабли, на которые уже наступали (не повторять)
- **zsh на этом Mac: интерактивные комментарии ВЫКЛючены** → строка с `#` выполняется как команда
  (`command not found: #`). В командах для терминала не пиши `#`-строки (внутри heredoc — можно).
  Для пояснений — `echo`.
- **Caddy: адрес сайта `:9000` + `bind 127.0.0.1`, а НЕ `http://127.0.0.1:9000`.** Второе навешивает
  фильтр по `Host=127.0.0.1`; запросы от Funnel идут с реальным именем хоста и не матчатся → порт
  «не открывается» публично (хотя локальный `curl` работает). Проверяй через `-H 'Host: <домен>'`.
- **Tailscale `--set-path` префикс НЕ срезает** — бэкенд получает полный путь (в Caddy — `handle`).
- **Обращение к своему funnel-адресу с самого Mac часто не проходит (hairpin-NAT)** — это не
  поломка. Публичную доступность проверяй с телефона (мобильный интернет) или через `-H Host:`.

---

## Если что-то уронил — диагностика и восстановление
```bash
tailscale funnel status
brew services list | grep caddy
launchctl list | grep -Ei 'tandem|wbcalc|getcourse|planner|caddy|wb\.unit'
```
Восстановить вход 443 → Caddy (если слетел):
```bash
tailscale funnel --bg --https=443 127.0.0.1:9000
```

---

## Перенос на VPS (когда купишь)
На Linux Caddy сам получает TLS-сертификаты (Let's Encrypt) — Tailscale Funnel не нужен. Тот же
подход: один Caddy раздаёт по путям/доменам, сервисы — как systemd-юниты на loopback-портах.
Пример для домена:
```
myhost.example.com {
	handle /mytool* { reverse_proxy 127.0.0.1:9100 }
	handle /calc*   { reverse_proxy 127.0.0.1:8899 }
	handle          { reverse_proxy 127.0.0.1:8477 }
}
```
Подробнее по нашему калькулятору — `docs/china-fbs/deploy/CADDY.md` и `docs/china-fbs/deploy/RUNBOOK.md`
(если эти файлы есть в твоей ветке).
