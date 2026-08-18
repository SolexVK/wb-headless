# Handoff

## Цель
Два направления в одном репозитории `wb-headless`:
1. **Дашборд динамики остатков** из выгрузки «Остатки по дням» —
   `analytics/inventory-dashboard/build_dashboard.py` (готово, использовалось для
   разовых Excel-дашбордов пользователю).
2. **Сводка по остаткам WB на текущий момент** (по артикулу продавца: FBO + FBS +
   «в пути к клиенту» + «в пути от клиента/возвраты») из официального API WB.
   Формат: сервис (CLI + HTTP-эндпоинт) + Excel. Токен подхватывается
   автоматически, без ручного ввода.

## Текущее состояние
### Дашборд (направление 1) — готово.
- Генератор собирает книгу: Дашборд (2 фильтра Артикул/Склад, живые SUMIFS, KPI,
  график), По артикулам, По складам, Данные. Консолидация размеров + отсев
  нулевых складов. Числа сверены с pandas.

### Сводка по остаткам WB (направление 2) — КОД ГОТОВ, ЖИВЬЁМ ЕЩЁ НЕ ПРОГНАН.
- Реализовано и проверено на фикстуре (`--dry-run`): клиент WB
  (`lib/wbApi.js`), агрегатор (`lib/wbStockSummary.js`), CLI (`report-wb-stock.js`),
  эндпоинт `GET /reports/wb-stock` (`server.js`), Excel-генератор
  (`analytics/wb-stock-report/build_report.py`), one-shot запуск
  (`scripts/run-wb-stock.sh`, `npm run wb-stock`).
- **Авто-поиск токена** (`lib/resolveWbToken.js`): env / похоже-названная
  env-переменная / `.env`/`.env.local` / файл (`WB_TOKEN_FILE`, `~/.wb_token`,
  `~/.config/wb/token`, `<репо>/.wb-token`) / **macOS Keychain**. Значение не
  логируется (только источник + длина). Для Actions — секрет репозитория
  `WB_API_TOKEN` + workflow `.github/workflows/wb-stock-report.yml`.
- **Реальные вызовы WB API НЕ выполнялись** — в среде нет токена. Форматы ответов
  выверены по докам; на первом живом прогоне возможны правки нормализации.
- Последнее: пользователь запускает на Mac mini (`openclaw@Mac-mini-Vital`).
  Первая попытка провалилась — он вставил placeholder-путь `путь/к/wb-headless`.
  Дал идемпотентную команду clone-or-update (репо публичный, дефолт `main`).
  **Ждём вывод его консоли.**
- Ветка: `claude/inventory-dashboard-5j5lif`. Всё запушено. PR не создавался.

## Файлы, над которыми работали
- `analytics/inventory-dashboard/build_dashboard.py` + `README.md` — дашборд (направление 1).
- `lib/wbApi.js` — клиент WB API (Статистика FBO / Маркетплейс FBS / Контент карточки).
- `lib/wbStockSummary.js` — чистый агрегатор сводки + CSV.
- `lib/resolveWbToken.js` — авто-поиск WB-токена (env/файл/Keychain).
- `lib/loadEnv.js` — загрузчик `.env`/`.env.local` без зависимостей.
- `report-wb-stock.js` — CLI-раннер сводки (+`--dry-run`, авто-поиск токена).
- `server.js` — эндпоинт `GET /reports/wb-stock` + resolveWbToken() на старте.
- `scripts/run-wb-stock.sh` — one-shot: сбор → JSON/CSV → Excel → open.
- `analytics/wb-stock-report/build_report.py` + `README.md` — Excel из JSON сводки.
- `.github/workflows/wb-stock-report.yml` — ручной прогон в Actions по секрету.
- `fixtures/wb-stock.sample.json` — фикстура для offline-проверки.
- `.env.example`, `package.json`, `REPORTS.md`, `.gitignore` — токены WB, скрипты,
  оглавление, игнор `.env.local`/`.wb-token`.
- `handoff.md` — этот файл.

## Что изменилось
- Направление 1 (дашборд): коммиты `d9c7726` (3 измерения), `8f15790`
  (консолидация размеров + отсев нулевых складов, 2 фильтра).
- Направление 2 (сводка WB): `d25de0d` (клиент+агрегатор+CLI+эндпоинт+Excel+
  фикстура), `49beeff` (one-shot раннер + авто-`.env`), `5ffe691` (авто-поиск
  токена: env/файл/Keychain + workflow Actions + игнор токен-файлов).
- FBO/FBS/в пути/возвраты берутся из API WB напрямую (см. «Открытые вопросы» в
  прошлом — выбрано: WB API, и Excel и сервис, охват FBO+FBS).

## Что пробовали и НЕ сработало
- **Пересчёт xlsx через headless LibreOffice (`xlsx/scripts/recalc.py`) в этой
  среде НЕ работает** — виснет на бутстрапе профиля даже на файле из 3 ячеек
  (пробовали таймауты 80/100/280/300 с). Причина: два запуска `soffice`, каждый
  медленно создаёт свежий профиль под LD_PRELOAD-шимом (AF_UNIX). **Обход:**
  `wb.calculation.fullCalcOnLoad=True` (Excel/LibreOffice пересчитают при
  открытии) + независимая сверка чисел через pandas. НЕ тратить время на recalc.py.
- **~2000 живых SUMIF на сводных листах дашборда** делали книгу неподъёмной —
  перешли на предрасчёт значений в Python, живые формулы только на «Дашборд».
- **Грабли смещения столбцов** при верификации дашборда: дни начинаются с колонки
  C (ключ в B), а не D. Учитывать при чтении сводных листов.
- **Баг эвристики имени токена:** переменная `WB_TOKEN_FILE` подпадала под
  «похоже на WB-токен» и её ЗНАЧЕНИЕ (путь) бралось как токен. Обошли: исключили
  имена, оканчивающиеся на FILE/PATH/HOST/URL/BASE/DIR, из env-скана.
- **Баг суммирования nmID** в строке ИТОГО Excel-сводки (складывались
  идентификаторы) — nmID исключён из SUM.
- **Пользователь вставил placeholder `путь/к/wb-headless`** буквально → `cd`/git/npm
  упали. Обошли идемпотентной командой clone-or-update; репо публичный, поэтому
  https-clone без авторизации.
- `openpyxl`/`pandas` в системном python нет — ставить через `pip install` (среда
  эфемерная, при новой сессии заново). Node-часть внешних зависимостей НЕ требует
  (встроенный `fetch` Node 18+), `npm install` для отчёта не нужен.

## Команды для проверки
```bash
pip install openpyxl pandas             # среда эфемерная, ставить заново

# --- Направление 1: дашборд ---
python -c "import ast; ast.parse(open('analytics/inventory-dashboard/build_dashboard.py').read())"
python analytics/inventory-dashboard/build_dashboard.py <input.xlsx> /tmp/out.xlsx --sheet "Остатки по дням"

# --- Направление 2: сводка WB (без токена, на фикстуре) ---
for f in lib/wbApi.js lib/wbStockSummary.js lib/resolveWbToken.js lib/loadEnv.js report-wb-stock.js server.js; do node --check "$f"; done
node report-wb-stock.js --dry-run fixtures/wb-stock.sample.json
python analytics/wb-stock-report/build_report.py reports-output/wb-stock-*.json /tmp/wb.xlsx
bash -n scripts/run-wb-stock.sh
```
**Ожидаемое состояние сейчас (всё зелёное):**
- Дашборд: `ast.parse` ok; книга собирается; recalc через LibreOffice — заведомо
  КРАСНЫЙ (см. выше), это ожидаемо и не блокер.
- Сводка WB: `node --check` ok для всех 6 файлов; `--dry-run` даёт итоги
  FBO дост.=25, FBS=19, итого=44, →клиенту=6, ←возврат=3 (сверено вручную);
  Excel из JSON строится; `bash -n` ok. **Живые вызовы WB API — НЕ прогонялись**
  (нет токена локально) — ожидаемо КРАСНО до первого запуска с реальным токеном.

## Открытые вопросы (нужно решение пользователя)
- **Первый живой прогон сводки WB на Mac mini** — ЖДУ ВЫВОД КОНСОЛИ после
  `npm run wb-stock`. По нему: (а) нашёлся ли токен и каким источником; (б) не
  ругается ли WB API на формат/категории. Если токен назван совсем нестандартно
  (не под паттерн WB…TOKEN и не в Keychain/файле) — добавить его имя/место в
  `lib/resolveWbToken.js`.
- **Имя секрета в GitHub Actions** — workflow ждёт `WB_API_TOKEN` (запасные
  `WB_TOKEN`/`WILDBERRIES_TOKEN`). Если секрет назван иначе — переименовать/
  продублировать или вписать имя в workflow. (не блокер для локального прогона)
- **Создавать ли PR** по ветке `claude/inventory-dashboard-5j5lif` (дашборды +
  отчёт) — пользователю предлагали, ответа нет. Рекомендация: сначала удачный
  живой прогон, потом PR. ЖДУ ОТВЕТА.
- **Доработки дашборда** (разбивка по размерам для артикула; показатель
  «продажи = снижение остатка») — предложены ранее, решение за пользователем.

## Следующий шаг
Дождаться вывода `npm run wb-stock` с Mac mini. Если WB API вернул данные —
свериться, что поля разложились верно (FBO/FBS/в пути/возвраты), при расхождении
формата ответа поправить нормализацию в `lib/wbApi.js` (агрегатор
`lib/wbStockSummary.js` не трогать). Если токен не нашёлся — уточнить у
пользователя, где он лежит на маке, и расширить `lib/resolveWbToken.js`.
Про recalc.py помнить — в этой среде не работает, полагаться на `fullCalcOnLoad`.
