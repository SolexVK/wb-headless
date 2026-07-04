# VCOS / Hermes — Жёсткая ревизия платформы и план корректировки

> Дата: 4 июля 2026
> Объект: архив VCOSproject (ветка ревизии: `claude/platform-encyclopedia-review-mzjzjs`)
> Метод: полное чтение ядра + 4 параллельных ревизии подсистем + запуск тестов и репро-скриптов.
> Все находки ниже подтверждены чтением кода, и ключевые — исполнением.

---

## 0. Главный вывод

**Архитектура VCOS (7 сущностей, Semantic Graph, Transformer Chain, Domain Packs) — здравая. Реализация — нет.**
Проект находится в состоянии «фасад работает, проводка внутри оборвана»: заявленные механизмы
(Decision-First, immutability, Knowledge Providers, Learning, Merge/Fork, Domain Packs, Renderer-компиляция)
либо не подключены, либо падают при первом реальном вызове, либо существуют в 2–3 конкурирующих копиях.

Ключевые цифры:

| Метрика | Значение |
|---|---|
| Тесты | **39 из 300 падают**, включая compliance-тесты инвариантов |
| ...из них из-за одной строки (`~/VCOS` в conftest) | 26 |
| ...настоящих багов продакшн-кода | 13 |
| Мёртвый код | ≥ 2 200 строк только крупными блоками (`hermes/reasoning/` = 1759, `scene_spec.py` = 430) + десятки мёртвых методов |
| Код, который **ни разу не исполнялся** | SnapshotManager (diff/trace/compare), DialogueAgent.parse, LearningEngine.extract_patterns, 3 из 9 Domain Packs, CompileTransformer |
| Конкурирующих реализаций одного и того же | 2 оркестратора, 2 системы снапшотов, 2 Knowledge-протокола, 2 рендер-пайплайна, 3 модели сцены, 3 graph-API, 3 версии онтологии |

Причина не в недостатке ума — в **процессе**: код писался без запуска, compliance-тесты проверяют
существование файлов вместо поведения, Architecture Freeze объявлена при заведомо сломанном E2E,
а рефакторинги делались копированием («новая папка рядом») вместо замены.

---

## 1. Сквозные системные проблемы

### П-1. Код никогда не исполнялся — и тесты этого не ловили
Доказательства «нулевого прогона»:
- `hermes/agents/dialogue_agent.py:75` — `self._llm.transform({dict})` при сигнатуре `transform(graph, context)` → `TypeError` при первом вызове. LLM-парсинг ответов пользователя не работал ни разу.
- `hermes/learning/engine.py:118` — `Pattern(field=...)` при поле dataclass `field_name` → `TypeError` на первом паттерне.
- `hermes/kernel/snapshot_manager.py:432,521–533` — обращения к `edge.source_id/target_id/relation`, которых нет у `Edge` (`core.py:267–291`) → все `diff()`/`trace()` падают `AttributeError`; `compare()` сломан тремя независимыми способами (:576, :599, :610).
- `hermes/domain_packs/{youtube,infographic,fashion}_pack.py` — `DomainConstraint(block=..., rule=...)` при полях `description/constraint_type/confidence` → `TypeError` на любом `get_constraints()`.

### П-2. Главный интеграционный шов разорван
`hermes/transformers/pipeline_transformer.py:142` возвращает `log={"chain": [...]}` (всё вложено),
а `hermes/orchestrator/core.py:322–360` читает `category`, `error`, `question`, `next_phase`, `domain_pack`
**с верхнего уровня**. Ни один ключ никогда не находится. Следствия:
- невалидная категория принимается без ошибки; `_current_category` остаётся пустой;
- вопросы трансформеров подменяются fallback'ом «Продолжаем?»;
- Domain Pack никогда не активируется (плюс `core.py:325` кладёт в `_active_domain_pack` строку, а `core.py:406` зовёт у неё `.get_constraints()` — второй краш, замаскированный первым);
- все ошибки трансформеров молча теряются (в сочетании с системным `except Exception: pass` — см. П-6).

### П-3. Дублирование как метод разработки
- `hermes/design/` ≡ `hermes/reasoning/` — побайтовая копия 4 файлов (1759 строк), `reasoning/` не импортируется никем, но `visual_reasoner.py` уже разошёлся между копиями.
- Два оркестратора: живой god-объект `hermes/orchestrator/core.py` (778 строк, 11 магических фаз `0,1,2,-2,-3,-1,3,31,4,5,6`) и `hermes/transformers/orchestrator.py`, чей `_apply_proposal` («единственный путь мутации графа») **не вызывается нигде**.
- Две системы снапшотов одновременно в одном адаптере: `graph_adapter.py:45–46` держит и `SnapshotChain`, и `SnapshotManager` — истории расходятся, rollback работает только с первой.
- Два Knowledge-протокола с одинаковыми именами классов (`knowledge/provider.py` vs `transformers/knowledge_protocol.py`).
- Два рендер-пайплайна со скопированными форматтерами (`prompt_exporter.py:180–289` ≈ `dsl_compiler.py:592–664`).
- Три модели сцены: `vsl/ontology.py`, `domain_packs/scene_spec.py` (мёртвая), `SemDSL` в `dsl_compiler.py`.
- Три graph-API: `kernel.core.Graph`, `kernel.semantic_graph.SemanticGraph`, `kernel.graph_adapter.SemanticGraphAdapter` — используются разными частями системы вперемешку.
- Четыре копии таблицы моделей генерации (MODEL_MAP) в ядре: `clarify_transformer.py:16`, `export_transformer.py:17`, `core.py:672–677`, `core.py:734–737`.

### П-4. Инварианты стандарта нарушены самим ядром
| Инвариант | Реальность |
|---|---|
| I-004 «изменение графа только через Decision» | `graph_adapter.record_*` пишет 7 из 8 типов сущностей в Registry напрямую, сразу `APPROVED`, минуя lifecycle DRAFT→PROPOSED→VALIDATED, Proposal и DecisionMaker. Сам DecisionMaker падает `AttributeError` (`registry.graph`, `edge.source_id` — `decision_maker.py:331,337`) на любом не-user предложении с рёбрами |
| PM-002 «immutable, любое изменение = версия» | `snapshot.py:155–176` — rollback мутирует ProjectModel прямым присваиванием полей без bump версии; `decision_maker.py:207–210` правит `properties` frozen-узлов in-place; `Node(frozen=True)` не защищает вложенные dict/list, версии шарят списки (`project_model.py:87`) |
| I-001/I-006 «ядро не знает доменов и моделей» | В kernel и трансформерах: категории Wildberries (`category_transformer.py:19–22` + дубль в `dialogue_transformer.py:71–72`), поля одежды в Interview (`interview_layer.py:64–98`), `"Product Card Photo"` захардкожен в `graph_adapter.record_blueprint`, `profile_name`/`model_target` — поля ProjectModel, sdxl/midjourney-таблицы в 4 местах ядра |
| I-002/I-007 «промпт — компиляция, Renderer чист» | Реальный экспорт — `core.py:_export` (670–724) напрямую через PromptExporter; **Blueprint записывается задним числом после того, как промпт уже собран**; Renderer сам принимает творческие решения: дописывает `commercial product photography, not 3D render` любому домену и negative prompt `dark, moody` — прямо убивая нуар/драму из FilmPack |
| I-008 «общение только через граф» | SDE и inference_engine зовут LLM напрямую мимо LLMTransformer; данные для вопросов берутся из приватного `logger.decisions` мимо графа (`core.py:655–658`) |
| «Ядро не зависит от паков» | Вывернуто наизнанку: `transformers/llm_transformer.py:20`, `design/inference_engine.py:97`, `sde/scene_discovery.py:68` импортируют сетевой LLM-клиент **из `domain_packs/llm_client.py`**, где захардкожены deepseek/nemotron и ключ только из `~/.hermes/.env` |

### П-5. Внутренние противоречия ядра (валидаторы против адаптера)
- Направления рёбер несогласованы: адаптер создаёт `Decision → Goal` (SUPPORTS), а `Graph.validate_invariants` (`core.py:481–492`) ищет Goal среди **родителей** Decision → PM-I004 срабатывает на каждом решении. Адаптер создаёт `Decision → Blueprint` (REFERENCES), а G-006 требует `Blueprint —SATISFIES→ Decision`. Т.е. **граф, построенный штатным адаптером, системно не проходит штатную валидацию ядра**.
- Два валидатора (`core.Graph.validate_invariants` и `kernel/validator.py`) требуют противоположные направления ребра produces для Artifact.
- `record_decision` создаёт Decision c `confidence=0.5` и `state=APPROVED`, а Validator требует ≥0.7 для APPROVED → каждое дефолтное решение генерирует invariant_error; Validator при этом гоняется после каждой мутации и засоряет DecisionLogger системными записями.
- `record_artifact` сохраняет `prompt[:200]` — **артефакт (единственный результат всей системы) обрезается до 200 символов в SSOT**.
- Два инварианта в `core.py` носят один номер G-007; `Edge.type` — то enum, то строка (`Registry.find_edges` падает на строковом типе).

### П-6. Ошибки невидимы by design
`except Exception: pass` — системный паттерн: `category_transformer.py:94,114`, `profile_transformer.py:63,109`, `design_transformer.py:68,90`, `compile_transformer.py:128,137,163`, `export_transformer.py:141,152,159`, `llm_client.py:110–124` (тихий `return None` и фейковый вопрос-заглушка). Система «работает», потому что не сообщает, что не работает.

### П-7. Compliance — театр, Freeze — фикция
- 26 из 39 падений — захардкоженный `~/VCOS` в `compliance/conftest.py:7,36`: suite работал только на машине автора.
- Инвариант I-004 проверяется как «файл существует»; «трансформер не мутирует вход» — как «у метода есть аннотация типа»; «нет побочных эффектов» — соломенное чучело с `except ImportError: pass` (тест молча зелёный, если модуля нет).
- «Когнитивный цикл» в `transformers/orchestrator.py:192–202` вычисляет `observe → evaluate → decide` и **игнорирует результат** — он написан, чтобы его нашёл `inspect.getsource` в compliance-тесте.
- `ARCHITECTURE-FREEZE.md` («160/160, production-ready»), `AUDIT` («121/121, 0 gaps») и `STATE` («25/27») называют три несовместимых числа; freeze объявлена в день, когда собственный `FIX-PLAN.md` признаёт сломанный E2E.
- «Spec → JSON Schema → Test → Code»: каталог `schemas/` пуст, `compliance/schemas/*.py` не импортируются ни одним тестом и противоречат и спеке, и коду. Онтология существует в трёх версиях: спека CO-001 — 6 сущностей, код — 8, schemas — 5. CP-001 до сих пор описывает `ProjectModel → ProjectModel`.

### П-8. Персистентности и обучения нет
Ни одного байта на диск: Registry, снапшоты (deepcopy всего Registry после **каждой** мутации — O(N) память), DecisionLogger, MemoryStore («M-001 Survives Sessions» — список в RAM), LearningEngine (не подключён и падает). Между сессиями система не помнит ничего.

### П-9. Мёртвая проводка в «работающем» пути
- Knowledge Registry зарегистрирован (`core.py:120–122`), но `knowledge.query()` не вызывается нигде — вся подсистема знаний мертва.
- `render_hints` паков вычисляются и выбрасываются (`core.py:691,749`) — доменные подсказки не влияют на промпт.
- 6 из 9 Domain Packs не зарегистрированы в оркестраторе (`core.py:130–133`), потому их поломка и не была замечена.
- Экспорт теряет данные из-за рассинхрона ключей: exporter читает `color`/`environment`/`narrative`, extract кладёт `colors`/`world` (`prompt_exporter.py:106` vs `:374–381`) — **цвета, мир и констрейнты молча выпадают из финального промпта**.
- CategoryTransformer, ProfileTransformer, InterviewTransformer недостижимы: first-match диспетчеризация (`pipeline_transformer.py:149–154`) отдаёт всё DialogueTransformer'у, зарегистрированному первым.
- Фаза 4 (inference/reasoning) — тупик: LLMTransformer требует `config["prompt"]`, который никто не передаёт; свои proposals он в результат не кладёт (`llm_transformer.py:82–101`) — «LLM Proposes, Kernel Decides» физически не работает.

---

## 2. Что реально работает (чтобы не выплеснуть ребёнка)

- Модель данных ядра: `Node`/`Edge`/`NodeType`/`RelationType`/`LifecycleState` (`core.py`) — разумная основа.
- `Registry` как плоское хранилище + `ProjectModel` как ID-проекция — правильная пара.
- Immutable-хелперы `ProjectModel.with_*` и `Node.with_state` (с валидацией переходов) — честные.
- `SnapshotChain.create/rollback/diff` — базово работает (с оговорками из П-4).
- `DecisionLogger` как журнал + `why()` — работает.
- Поведенческие тесты `test_freeze_invariants.py` и `test_ca001_learn_compare.py` — образец того, как надо; команда умеет писать настоящие тесты.
- Узкий коридор Orchestrator → PromptExporter доводит демо-сценарий до промпта (с потерями данных).
- Контент паков (вопросы, чек-листы по свету/оптике) — полезный материал, просто неправильно упакованный.

---

## 3. План корректировки

Порядок фаз важен: сначала правда и удаление, потом починка, потом развитие.
Правило всего плана: **ни одна фаза не закрыта, пока её acceptance-критерий не проходит в CI.**

### Фаза 0 — Правда (1 день)
1. Починить `compliance/conftest.py`: относительные пути вместо `~/VCOS` (и `test_invariant_i001_010.py:248,272`). Это превращает 26 ложных падений в 0 и открывает реальную картину.
2. Завести CI (GitHub Actions): `pytest` на каждый пуш. Красный = не мёржим.
3. Отозвать фиктивные статусы: в `ARCHITECTURE-FREEZE.md`/`AUDIT`/`STATE` одним коммитом зафиксировать честное состояние («13 известных багов, E2E сломан, freeze снята до Фазы 3»).
- **Критерий:** CI работает; в репо нет документа, утверждающего “100% compliance”.

### Фаза 1 — Ампутация дубликатов (2–3 дня, только удаление)
1. Удалить `hermes/reasoning/` целиком (канон — `hermes/design/`).
2. Удалить `domain_packs/scene_spec.py` (мёртвая третья модель сцены).
3. Выбрать один рендер-пайплайн (рекомендация: `prompt_exporter.py`), удалить дубль-форматтеры из `dsl_compiler.py`.
4. Выбрать один Knowledge-протокол (рекомендация: `knowledge/provider.py`), удалить `transformers/knowledge_protocol.py`.
5. Убрать вторую систему снапшотов из адаптера (оставить `SnapshotChain`; `SnapshotManager` — в карантин до Фазы 3).
6. Свести MODEL_MAP к одной таблице в одном месте (временно — конфиг; целево — Domain Packs, Фаза 4).
7. Удалить мёртвые методы/импорты, помеченные в ревизии (`_apply_proposal`, `start_session`, `_run_transformer_phase`, `_apply_parsed`, `Validator` в DecisionMaker, `CONFIDENCE_SCALE` и т.д.).
- **Критерий:** каждый концепт имеет ровно одну реализацию; `grep -c "except Exception: pass"` зафиксирован как метрика и не растёт.

### Фаза 2 — Один живой вертикальный срез (1–2 недели; главная фаза)
Цель: **одна сессия проходит от Intent до Artifact без потерь данных, и это доказывает e2e-тест.**
1. Починить контракт log: `PipelineTransformer` возвращает структурированный `TransformResult` (typed-поля `category/error/question/next_phase`, а не magic-ключи словаря), оркестратор читает его. Убить `int("export")`-мину (`clarify_transformer.py:82` vs `core.py:330`).
2. Явная маршрутизация фаза→трансформер (таблица) вместо first-match `can_handle` — разблокирует Category/Profile/Interview.
3. Починить `DialogueAgent.parse` под текущую сигнатуру или удалить агент, если его работу делает DialogueTransformer.
4. Прекратить глотание ошибок: `except Exception: pass` → лог + проброс в `TransformResult.error`; запретить паттерн линтером (ruff BLE001/S110).
5. Починить экспорт: единый словарь ключей (`colors`→`color` и т.д.), контрактный тест «каждый ключ, который кладёт extract, читается exporter'ом»; убрать обрезку `prompt[:200]` в `record_artifact`.
6. Blueprint до Artifact, а не после: `_export` сначала собирает Blueprint из графа, потом компилирует.
7. Один e2e-тест: «рубашка для WB» → категория → профиль → интервью → blueprint → промпт, с проверкой, что цвета/среда/констрейнты дошли до промпта.
- **Критерий:** e2e зелёный в CI; 13 известных багов закрыты или явно перенесены с тикетами.

### Фаза 3 — Честное ядро (1–2 недели)
1. **Единый graph-API.** Оставить: `Registry` (хранение) + `SemanticGraph` (логика/query) + один write-path. `Graph` из `core.py` слить с `SemanticGraph`; `SemanticGraphAdapter` превратить в тонкий сервис над ними.
2. **Решить вопрос immutability честно.** Рекомендация: event log (append-only список операций) как SSOT истории + текущее состояние как проекция. Это даёт rollback/fork/diff «бесплатно» и убирает deepcopy-снапшоты после каждой мутации. Если event log — слишком дорого сейчас: признать модель мутабельной-с-версиями и убрать слово «immutable» из доков, но закрыть дыры (глубокое копирование properties, запрет in-place правок в DecisionMaker).
3. **Decision-First с bootstrap-правилом.** Зафиксировать в CO-001: Source и Intent создаются вне Decision-механизма; всё остальное — только через Proposal → DecisionMaker → Decision-узел. Починить `_check_invariants` (`registry.graph`, `edge.source_id`), убрать обход валидации для USER-предложений, провести `record_goal/constraint/blueprint/artifact` через этот путь.
4. **Один валидатор и один словарь направлений рёбер.** Таблица «тип ребра → (source-тип, target-тип)» в CM-001, оба валидатора слить в один, адаптер приводится к таблице. Убрать дубль-номер G-007.
5. `Edge.type` — всегда enum (или всегда строка), зафиксировать и проверить типами (mypy на kernel).
6. SnapshotManager: переписать diff/trace/compare под реальный Edge API или удалить до Фазы 6 — половина файла никогда не работала.
- **Критерий:** «граф, построенный штатным путём, проходит штатную валидацию» — property-тест в CI; mypy зелёный на `hermes/kernel`.

### Фаза 4 — Доменная чистка (1 неделя)
1. Вынести из ядра в Domain Packs / конфиг: категории WB, поля одежды Interview, photography-факты KnowledgeTransformer, `"Product Card Photo"`, MODEL_MAP, эмодзи-UX-строки.
2. `llm_client.py` → `hermes/infrastructure/llm/`: модели и ключи из конфига/env (`os.environ` в первую очередь), нормальные ошибки вместо тихого `None`.
3. Привести 3 сломанных пака к базовому интерфейсу `DomainPack` (или удалить до востребования); зарегистрировать паки декларативно; контрактный тест «каждый зарегистрированный пак: get_questions/get_constraints/get_render_hints вызываются без исключений».
4. Подключить мёртвую проводку: `knowledge.query()` в фазе сбора фактов, `render_hints` — в экспорт.
5. Пак отдаёт семантику (aspect, стиль), Renderer превращает её в синтаксис (`--ar`, `--v 6`); негативные промпты — из констрейнтов графа, не из хардкода рендера.
- **Критерий:** `grep -ri "wildberries\|midjourney\|sdxl\|chatgpt\|harari" hermes/kernel hermes/transformers hermes/orchestrator` → 0 совпадений.

### Фаза 5 — Compliance, который не врёт (параллельно фазам 2–4)
1. Каждый инвариант — поведенческий тест: I-004 «мутация в обход Decision → отказ», T-001 «вход трансформера не изменился (снимок до/после)», I-006 — grep-скан ядра на доменные термины.
2. Удалить тесты-тавтологии и `inspect.getsource`-театр; удалить «когнитивный цикл»-декорацию.
3. Синхронизировать спеки с кодом одним решением: онтология = 8 типов (6 + SOURCE + CONSTRAINT) → обновить CO-001 до v1.1; CP-001 → `SemanticGraph`; RelationType — один список. Либо схемы JSON стать настоящими (jsonschema-валидация сериализованного графа в тестах), либо удалить их.
- **Критерий:** compliance-suite падает, если сломать инвариант руками (мутационная проверка).

### Фаза 6 — Персистентность и память (после зелёного среза)
1. Сериализация Registry + event log в SQLite/JSONL; Memory — на диск.
2. LearningEngine: починить `Pattern(field_name=...)`, подключить к завершению сессии, паттерны — в Memory; считать подтверждения по проектам, не по решениям.
3. Snapshot-стратегия: не deepcopy после каждой мутации, а чекпоинты + event log.
- **Критерий:** перезапуск процесса не теряет проект; «Survives Sessions» — тест, а не докстринг.

### Правила процесса (навсегда)
1. **Код не существует, пока не исполнен**: ни одного мёржа без запуска затронутого пути (тест или скрипт).
2. **Рефакторинг = замена, не копия.** Новая реализация появляется только в коммите, удаляющем старую.
3. **Ошибки не глотаются.** `except Exception: pass` запрещён линтером.
4. **Спека меняется тем же PR, что и код.** Разошлись — CI красный (тест соответствия онтологии enum'ам).
5. **Freeze возможна только поверх зелёного CI**, и заявленные числа тестов генерируются, а не пишутся руками.

### Чего НЕ делать сейчас
- Не писать новые Domain Packs, новые фазы, новые слои стандарта — до зелёного вертикального среза.
- Не начинать «переписывание с нуля»: модель данных ядра пригодна, проблема в проводке и дублях.
- Не возвращаться к правке 43 исходных документов — энциклопедия как SSOT достаточна, но её §2.3 и карту противоречий нужно обновить по итогам Фазы 5.

---

## 4. Приложение: сводка критических дефектов (краткий реестр)

| # | Дефект | Где | Класс |
|---|---|---|---|
| 1 | log-контракт pipeline↔orchestrator разорван | pipeline_transformer.py:142 ↔ orchestrator/core.py:322–360 | CRITICAL |
| 2 | DialogueAgent.parse — TypeError по сигнатуре | agents/dialogue_agent.py:75 | CRITICAL |
| 3 | LLMTransformer выбрасывает свои proposals | transformers/llm_transformer.py:82–101 | CRITICAL |
| 4 | Category/Profile/Interview-трансформеры затенены first-match | pipeline_transformer.py:149–154 | CRITICAL |
| 5 | `int("export")` — мина при починке #1 | clarify_transformer.py:82 ↔ core.py:330 | CRITICAL |
| 6 | SnapshotManager: несуществующий Edge API; compare сломан ×3 | snapshot_manager.py:432,521,576,599,610 | CRITICAL |
| 7 | rollback мутирует «immutable» ProjectModel | kernel/snapshot.py:155–176 | CRITICAL |
| 8 | compile_blueprint: результат `_updated()` выбрасывается (no-op) | kernel/algebra.py:389 | CRITICAL |
| 9 | Снапшоты не сохраняют constraints/facts | kernel/snapshot.py:96–106,168–176 | CRITICAL |
| 10 | DecisionMaker._check_invariants падает всегда (registry.graph) | kernel/decision_maker.py:331,337 | CRITICAL |
| 11 | 3 Domain Pack'а падают TypeError на первом вызове | youtube/infographic/fashion_pack.py | CRITICAL |
| 12 | LearningEngine падает на первом паттерне | learning/engine.py:118 | CRITICAL |
| 13 | Экспорт теряет цвета/мир/констрейнты (ключи разъехались) | prompt_exporter.py:106 vs :374–381 | CRITICAL |
| 14 | render_hints вычисляются и выбрасываются | orchestrator/core.py:691,749 | CRITICAL |
| 15 | knowledge.query() не вызывается нигде | orchestrator/core.py:120–122 | CRITICAL |
| 16 | SDK fork() портит родительскую сессию (общий Orchestrator) | sdk/vcos_client.py:298–309 | CRITICAL |
| 17 | Artifact обрезается до 200 символов в SSOT | kernel/graph_adapter.py:301 | CRITICAL |
| 18 | Штатный граф не проходит штатную валидацию (направления рёбер) | graph_adapter ↔ core.py:481–525 ↔ validator.py | CRITICAL |
| 19 | Merge/Fork — декорации (union/пустой проект, source не читается) | algebra.py:94–241, snapshot_manager.py:146–344 | MAJOR |
| 20 | Ядро зависит от domain_packs (llm_client) с хардкодом моделей | llm_transformer.py:20, design/inference_engine.py:97 | MAJOR |
| 21 | Renderer навязывает «commercial product photography» и `dark, moody` всем доменам | prompt_exporter.py:187–192,284; dsl_compiler.py:594–659 | MAJOR |
| 22 | `~/VCOS` в conftest — 26 ложных падений compliance | compliance/conftest.py:7,36 | MAJOR |
| 23 | Онтология в трёх версиях (6/8/5 типов); CP-001 описывает старый контракт | CO-001 ↔ core.py ↔ schemas/co001.py | MAJOR |
| 24 | Тотальный `except Exception: pass` | ~15 мест по трансформерам/клиенту | MAJOR |

Полные отчёты по подсистемам (kernel, transformers/orchestrator, domain packs/renderers, compliance/standard) — в истории ревизии; каждый пункт локализован до file:line.
