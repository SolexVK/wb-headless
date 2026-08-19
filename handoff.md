# Handoff — единая аналитическая система WB × MPStats + PDF-отчёты

## Цель
Проводить конкурентный анализ товаров/ниш/продавцов на Wildberries по данным **MPStats API** и
оформлять результат в **красивые многостраничные PDF**. Всё собрано в **один конфиг-управляемый
шаблон** `wb_analytics/`, который подходит под **любой тип товара и нишу** — код/вёрстка не меняются,
меняется только JSON-конфиг.

## Текущее состояние
Работает end-to-end, всё закоммичено и запушено. Ветка `claude/wildberries-competitor-analysis-u4ftu1`,
PR #11, tip = `eb0f67b`.

> **ВНИМАНИЕ (важно для следующей сессии).** Наша ветка **независима** и НЕ основана на текущем `main`.
> Пока мы работали, в `main` влили чужие PR (#10 MPStats-прокси, #12 «Анализ ниши» — node.js `lib/`,
> #13 deploy-гайд). Свежий эфемерный контейнер может подняться на `main` (коммит `6e34e81`): тогда на
> диске НЕ будет `wb_analytics/`, а `handoff.md` будет ЧУЖОЙ (про niche-analysis). Это НЕ потеря работы —
> наш код цел на remote. Восстановление: `git fetch origin claude/wildberries-competitor-analysis-u4ftu1
> && git reset --hard origin/claude/wildberries-competitor-analysis-u4ftu1`. Мержить/ребейзить на `main`
> — только по явному запросу пользователя (там другой проект в `lib/`, конфликтов по файлам нет —
> наш код в `wb_analytics/`, их в `lib/`).

**Единая система `wb_analytics/`** (заменила прежние разрозненные пайплайны):
```
конфиг.json ─▶ analyze.py (MPStats) ─▶ отчёт JSON ─▶ render.py (секции по манифесту) ─▶ единый PDF (Chromium)
                                        ▲ run.py — точка входа (CLI), связывает всё
```
- `run.py` — CLI: читает конфиг → `analyze` → `render`; `--from-data` = только вёрстка без сети.
- `analyze.py` — `analyze(cfg)→report`: карточки, рынок ниши, сопоставимый сегмент, ТОП-конкуренты,
  логистика складов (продавец vs конкуренты), потенциал+распределение стока (привязан к доле центр.
  спроса), авто-дорожная карта. Фетчи гейтятся по `sections`/`fetch_images`.
- `render.py` — реестр `SECTIONS` + `build_html(D,cfg)`: страницы по `cfg['sections']`
  (порядок/состав задаётся конфигом; неизвестные секции пропускаются). Метка сегмента
  (`segment_name`) параметризована → тексты не привязаны к конкретной нише.
- `theme.py` — хелперы, кликабельные ссылки WB, `wh_label` (из `reference/wb_warehouses.json`),
  весь CSS, поиск Chromium, `render_pdf`.
- `reference/wb_warehouses.json`, `reference/wb_region_demand.json` — справочники (перенесены сюда).
- `configs/seller_bedding.example.json` (полный разбор продавца, 9 секций),
  `configs/shirts_cards.example.json` (другой тип товара, только карточки+ниша).
- `README.md` — полная документация системы. Навык-обёртка: `.claude/skills/wb-analytics/SKILL.md`.

Секции: `cover · target_cards · competitors · warehouses · potential · niche · roadmap`.

Последний реальный разбор — продавец **4289467 = ИП Комиренко Т А**, детское постельное (12 nmId).
Корневая причина низких продаж (подтверждена данными): товар на региональных складах, ~нет на
центральных хабах (Коледино/Электросталь/Тула-Алексин/Казань/СПб/Екб) — у конкурентов там в среднем
4 хаба и ~50% стока. Плюс мало отзывов (×50 разрыв), 12 дроблёных карточек, нет бренда. Цена (2 697 ₽) —
выше медианы сегмента, т.е. НЕ причина.

## Что изменилось (последняя сессия)
- **Консолидация всех навыков в одну систему `wb_analytics/`.** Прежние `reports-generator/*.py`
  (build.py, collect.py, collect_seller.py, build_seller.py, README.md) **удалены** — их логика
  перенесена в модульную конфиг-управляемую систему.
- **Конфиг-манифест секций:** какие страницы и в каком порядке рисовать — задаётся `sections`
  в конфиге. Проверено: подмножество (5 стр.), переупорядочивание (2 стр.), пропуск неизвестной секции.
- **Обобщение под любую нишу:** метка сопоставимого сегмента вынесена в `segment_name`/`segment_note`
  (раньше был хардкод «КПБ/комплекты»); коэффициенты потенциала — в конфиг (`capture`,
  `content_factor`); справочники — в `reference/`.
- Регресс-проверка: тот же вход (`reports-output/seller_data.json`) даёт **идентичный 9-страничный PDF,
  156 ссылок**, как прежний `build_seller.py`.

## Что пробовали и НЕ сработало (важно — читать перед доработками)
- **Ассортимент продавца по id/имени/бренду в MPStats — НЕ работает надёжно.** `/wb/get/seller/{id}`
  → 405; `/wb/get/brand?path=бренд` → чужие карточки (бренд-сквоттинг). **Обход:** список nmId в конфиге.
- **Имя/бренд продавца:** WB `static-basket-01.wbbasket.ru/vol0/data/supplier-by-id/{id}.json`.
- **Справочник складов:** WB `.../stores-data.json` (`isWb`=фулфилмент WB). WB-Тула = **Алексин
  (206348)**; «Склад продавца Тула» — FBS (isWb=false), не фулфилмент; 130744 = **Краснодар**.
- **`/wb/get/warehouses?path=` → 500** — footprint складов считаем из `item/{sku}` `sizeandstores.s`.
- **Категорийный `purchase` (выкуп)** — величина уровня подкатегории, не по-товарная; в таблице
  конкурентов заменено на «возраст карточки».
- **Дерево категорий:** `/wb/get/categories` (GET, ~12 МБ) — искать точный путь ниши.
- **Замусоренность подкатегории:** фильтр сегмента через `comparable` (`"a b"` = обе подстроки),
  иначе цена/медиана врут.
- **Пагинация category:** `endRow=5000` — предел страницы; изредка пустой ответ → перезапуск.
- **Грабли:** `sizeandstores[*].s` бывает пустым list; `%,d` в Python-% не работает; случайный «但».
- **`AskUserQuestion` дважды падал** («Tool permission stream closed») — работали по озвученным
  дефолтам.

## Команды для проверки
Нужны `MPSTATS_TOKEN` и Chromium (`/opt/pw-browsers/chromium-*/chrome-linux/chrome`).
```bash
# импорт + компиляция (без сети)
python3 -m py_compile wb_analytics/*.py
python3 -c "import sys; sys.path.insert(0,'wb_analytics'); import theme,analyze,render,run; print('OK')"
python3 -c "import sys; sys.path.insert(0,'wb_analytics'); import theme; print(theme.wh_label('130744'), theme.wh_label('206348'))"  # Краснодар Алексин

# вёрстка из готового JSON (без сети) — регресс-проверка
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
python3 wb_analytics/run.py wb_analytics/configs/seller_bedding.example.json \
  --from-data reports-output/seller_data.json --pdf reports-output/bedding.pdf
python3 -c "d=open('reports-output/bedding.pdf','rb').read();print('pages',d.count(b'/Type /Page')-d.count(b'/Type /Pages'))"  # 9

# полный цикл (с сетью)
MPSTATS_TOKEN=*** CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
python3 wb_analytics/run.py wb_analytics/configs/seller_bedding.example.json \
  --data reports-output/bedding.json --pdf reports-output/bedding.pdf
```
**Ожидаемое (зелёное):** формальных тестов нет. `py_compile` молча проходит; `import` печатает OK;
`wh_label` → «Краснодар»/«Алексин»; вёрстка из фикстуры даёт **9-страничный** PDF, 156 ссылок.
КРАСНОЕ: пусто в MPStats (токен/429), пустой ответ category (перезапуск), Chromium не найден (`$CHROME`).
На момент хендоффа всё зелёное. Выходы в `reports-output/` (gitignored) — пересобрать командами выше.

## Открытые вопросы (нужно решение пользователя)
Блокеров нет. Возможные доработки по запросу:
- Уточнить `reference/wb_region_demand.json` и коэффициенты (`capture`/`content_factor`) под реальные
  данные клиента — сейчас это документированная эвристика.
- Отдельный «нишевый» вариант обложки для конфигов без продавца (сейчас `cover` — продавец-ориентирован;
  для чистого анализа ниши используйте `sections` без `cover`, напр. `["target_cards","competitors","niche"]`).
- Мерж PR #11 в `main` (создание PR согласовано; про мерж не спрашивали).

## Следующий шаг
Ждать запроса пользователя. Для нового анализа — скопировать `wb_analytics/configs/*.example.json`,
поправить под нишу/продавца и запустить `wb_analytics/run.py`. Либо мерж PR #11, либо калибровка
модели потенциала под конкретную нишу.
