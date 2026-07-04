# VCOS Fix Plan: Реальный пользовательский сценарий

## Диагноз

Корень проблем: **`_apply_proposal` пишет всё как Decision**. Intent, Goal, Constraint — всё уходит в Decision-узлы. Граф не строится, Export не может прочитать данные.

Пять слоёв поломки (снизу вверх):
1. **`_apply_proposal`** — не различает Intent, Goal, Source, Constraint, Decision
2. **Трансформеры** — не парсят ответ пользователя; всё складируют в одно поле `description`
3. **`_export`** — не маппит блоки решений на именованные поля промпта
4. **Validator** — не блокирует запрещённые переходы, только логирует
5. **DialogueAgent** — не задаёт осмысленные вопросы

## План: 5 фаз

Фаза 1: `_apply_proposal` → правильные узлы графа
Фаза 2: Трансформеры → парсинг ответа
Фаза 3: Export → маппинг блоков в промпт
Фаза 4: Validator → блокировка
Фаза 5: E2E тест + FREEZE

---

## ФАЗА 1: `_apply_proposal` строит граф правильно

**Где:** `hermes/orchestrator/core.py` — метод `_apply_proposal`

**Что сейчас:** Всё → `graph.record_decision(block, field, value)`

**Что нужно:** Маршрутизация по `block`:

| `proposal.block` | Действие |
|------------------|----------|
| `"source"` | `graph.record_source(value)` |
| `"intent"` | `graph.record_intent(value)` |
| `"goal"` | `graph.record_goal(value)` |
| `"constraint"` | `graph.record_constraint(value, field)` |
| `"blueprint"` | `graph.record_blueprint()` |
| `"artifact"` | `graph.record_artifact(value, model)` |
| всё остальное | `graph.record_decision(block, field, value)` |

**Верификация:** После сессии в Registry есть:
- Node(SOURCE) + Node(INTENT) + Node(GOAL) + Node(CONSTRAINT) + Node(DECISION)*N
- Edge: INTENT→GOAL, GOAL→DECISION, CONSTRAINT→GOAL
- Валидатор не находит PM-I004, CO-001-I-1

---

## ФАЗА 2: Трансформеры парсят ответ пользователя

**Где:** `hermes/transformers/dialogue_transformer.py`

**Что сейчас:** Возвращает `{"field": "description", "value": user_input}` — всё в одну кучу

**Что нужно:** Парсить ответ на структурированные поля:

```python
# Для фазы "direction" — ответ "мягкий верхний свет, тёплые тона, минимализм"
proposals = [
    {"block": "direction", "field": "composition", "value": "минимализм"},
    {"block": "direction", "field": "lighting", "value": "мягкий верхний свет"},
    {"block": "direction", "field": "color", "value": "тёплые тона"},
]
```

**Простой парсер (MVP):** Регулярные выражения на известные ключевые слова. ИЛИ передача в LLM для структурирования.

**Верификация:** После ввода "мягкий верхний свет, тёплые тона, минимализм" в графе 3 Decision: composition, lighting, color

---

## ФАЗА 3: Export → маппинг блоков в именованные поля

**Где:** `hermes/orchestrator/core.py` — метод `_export`

**Что сейчас:** `project_data()` строит блоки из logger.decisions — `data["direction"] = "description: мягкий верхний свет..."`

**Что нужно:** Маппинг block → field name в `project_data()`:

```python
BLOCK_TO_DATA_KEY = {
    "direction": "composition",
    "lighting": "lighting", 
    "color": "color",
    "style": "style",
    "model_scene": "environment",
    "reference": "reference",
    "product": "character",
}
```

ИЛИ (чище): в `_export` явно собирать data из решений:

```python
for d in self.graph.logger.decisions:
    if d.block == "direction":
        data[d.field] = d.value  # data["composition"] = "минимализм"
```

**Верификация:** После полной сессии `build_full_story()` возвращает промпт с 5+ параграфами

---

## ФАЗА 4: Validator блокирует невалидные переходы

**Где:** `hermes/kernel/validator.py` — метод `validate()`, Orchestrator — вызов валидатора

**Что сейчас:** Ошибки накапливаются, ничего не блокируется

**Что нужно:** После каждой `_apply_proposal` → запуск валидации → если **error** severity → rollback + user question

```python
# В _apply_proposal или submit_answer
violations = self._validator.validate()
errors = [v for v in violations if v.severity == "error"]
if errors:
    # Откатить последнюю операцию
    self.graph.rollback_to(self._last_snapshot)
    # Спросить пользователя
    return {"type": "question", "text": f"⚠️ Нарушение: {errors[0].message}. Уточни:"}
```

**Верификация:** Сессия с intentional error (попытка второго Intent) → блокируется, пользователю объяснение

---

## ФАЗА 5: E2E тест + FREEZE

**Сценарий:** Полный цикл пользователя:
1. "Хочу промпт для фото духов" → старт
2. "Духи, флакон, золотой колпачок" → product info → 3 Decision
3. "Без модели, белый фон, макросъёмка" → scene → environment
4. "Референс Chanel No5" → reference
5. "Без текста, строго вертикально" → constraints
6. "morandi-journal" → profile
7. "Мягкий верхний свет, тёплые тона" → direction → composition+lighting+color
8. "Роскошь и простота" → creative strategy
9. "SDXL" → export

**Ожидаемый результат:**
- Registry: SOURCE + INTENT + GOAL + 3×CONSTRAINT + 9×DECISION + BLUEPRINT + ARTIFACT
- All edges: Intent→Goal, Goal→Decisions, Decisions→Blueprint, Blueprint→Artifact
- 0 invariant violations
- Промпт: 5+ абзацев с composition, lighting, color, style, camera

**Проверка:**
```python
v = Validator(registry, project)
assert len(v.validate()) == 0  # 0 violations!
assert len(prompt) > 200       # содержательный промпт
```

---

## Приоритет

```
ФАЗА 1  ████████████████████████  критично — без этого граф не существует
ФАЗА 2  ████████████████████░░░  критично — без парсинга нет данных
ФАЗА 3  ██████████████████░░░░░  критично — без этого промпт пустой
ФАЗА 4  ██████████░░░░░░░░░░░░  важно — без блокировки накапливаются ошибки
ФАЗА 5  ████████████████████████  верификация
```

---

## Оценка рисков

| Риск | Вероятность | Mitigation |
|------|:-----------:|-----------|
| Фаза 2 парсер сломается на нестандартном вводе | 🟡 Средняя | Fallback: если парсинг не дал полей → "description" как сейчас |
| Фаза 4 rollback сломает сессию | 🟢 Низкая | Rollback только последнего snapshot, не всей сессии |
| Существующие compliance-тесты упадут | 🟡 Средняя | Бегут на изолированных тестах, не на сквозном сценарии |