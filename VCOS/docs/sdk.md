# VCOS SDK — публичное API для работы с системой

## Быстрый старт

```python
from hermes.sdk.vcos_client import VCOSClient

client = VCOSClient()
```

## Создание сессии

```python
# Без категории (спросит)
session = client.create_session()

# С категорией (начинает сразу с товара)
session = client.create_session("одежда")
```

## Полный цикл: создание промпта

```python
# 1. Создать сессию
session = client.create_session("одежда")

# 2. Пройти по фазам
result = client.ask(session.id, "Рубашка оверсайз, голубая, хлопок")
# → {"type": "question", "text": "Кто на фото? Где снимаем?"}

result = client.ask(session.id, "Девушка 25 лет, кафе, солнечный день")
# → {"type": "question", "text": "Есть референс?"}

result = client.ask(session.id, "нет")              # Референс
result = client.ask(session.id, "нет")              # Ограничения

# 3. Выбрать профиль
result = client.select_profile(session.id, "харари")

# 4. Направление
result = client.ask(session.id, "Тёплое настроение, золотой свет")

# 5. Творческий замысел (Creative Strategy)
result = client.ask(session.id, "Статус через сдержанность, минимум деталей")

# 6. Выбрать модель
result = client.ask(session.id, "chatgpt")
if result["type"] == "done":
    print(result["prompt"])
```

## Компактный цикл (когда знаешь категорию)

```python
client = VCOSClient()
session = client.create_session("одежда")

for answer in [
    "Рубашка оверсайз, голубая, хлопок",
    "Девушка 25 лет, на улице, день",
    "нет",                    # референс
    "",                       # ограничения
    "харари",                 # профиль
    "Тёплое настроение, золотой свет, естественный стиль",
    "Статус через сдержанность, много воздуха",  # creative strategy
    "midjourney",             # экспорт
]:
    result = client.ask(session.id, answer)
    if result["type"] == "done":
        print("✅ Промпт готов!")
        print(result["prompt"])
```

## Экспорт

```python
# Через когнитивный цикл
result = client.ask(session.id, "midjourney")

# Или напрямую (если данные уже в сессии)
prompt = client.export(session.id, "chatgpt")
prompt = client.export(session.id, "midjourney")
prompt = client.export(session.id, "sdxl")

# Переключение модели после первого экспорта
prompt2 = client.switch_model(session.id, "flux")
```

## Fork и Diff (ветвление проекта)

```python
# Создать ветку от текущего состояния
branch = client.fork(session.id, "Эксперимент с холодным светом")

# Продолжить в ветке
client.ask(branch.id, "Холодный свет, синие тона")

# Сравнить две ветки
diff = client.diff(session.id, branch.id)
print(diff["summary"])  # "+1 узлов, -2 узлов, ~0 узлов изменено"
print(f"Изменения есть: {diff['has_changes']}")
```

## Память (Memory Protocol, CP-001.4)

```python
# Сохранить в память
client.remember("last_project", "одежда-рубашка", "user.preferences")
client.remember("preferred_lighting", "золотой час", "user.preferences")

# Поиск в памяти
results = client.search_memory("рубашка", "user.preferences")
for r in results:
    print(f"  {r.key}: {r.value} (score: {r.score})")

# Поиск по проектам
results = client.search_memory("синяя", "project.test.facts")
```

## Сессии

```python
# Список всех сессий
all_sessions = client.list_sessions()

# Только активные
active = client.list_sessions(active_only=True)

# Получить по ID
session = client.get_session("vcos_a1b2c3d4_20260701_120000")

# Закрыть
client.close_session(session.id)
```

## Состояние системы

```python
info = client.summary()
print(info)
# {
#   "sessions": 5,
#   "runtime": {"total_projects": 5, "active_projects": 3, ...},
#   "memory": {"total_entries": 12, "namespaces": ["user", "project", "domain"], ...},
# }
```

## Работа с Orchestrator напрямую (продвинутое)

```python
session = client.get_session("vcos_...")

# Доступ к полному Orchestrator
orch = session.orchestrator

# Статус
print(orch.state.status)  # "active"

# Данные проекта
data = orch.graph.project_data()

# История снэпшотов
for snap in orch.graph.snapshots.history(5):
    print(f"  [{snap.version}] {snap.id[:8]} — {snap.reason[:40]}")

# SnapshotManager для fork/merge/diff
sm = orch.graph.snaps
changes = sm.diff(snap_a_id, snap_b_id)
```

## Поддерживаемые модели

| Ключ       | Модель               | Параметры |
|------------|----------------------|-----------|
| `chatgpt`  | ChatGPT / DALL-E 3   | Полные абзацы + техспеки |
| `midjourney` | Midjourney v6      | Запятые, --ar, --v 6, --style raw |
| `nanobanana` | Nano Banana Pro    | Story + aspect ratio |
| `flux`     | Flux Pro             | Story + aspect ratio |
| `sdxl`     | Stable Diffusion XL  | Веса, negative prompt, CFG |

## Требования

- Python 3.11+
- API key в `~/.hermes/.env`: `OPENROUTER_API_KEY=sk-...`
- PostgreSQL 16 + pgvector (для persistent memory) — опционально

## Пример полного скрипта

```python
#!/usr/bin/env python3
"""Пример: генерация промпта для товара на WB."""

from hermes.sdk.vcos_client import VCOSClient

client = VCOSClient()
session = client.create_session("одежда")

answers = [
    "Рубашка оверсайз, голубая, оксфорд, прямой крой",
    "Девушка 25, блондинка, кафе, солнечный день",
    "нет",
    "Белый фон, квадратный формат 1:1",
    "harari",
    "Тёплый свет, естественная улыбка, средний план",
    "Премиум-качество: идеальная посадка и ткань",
    "chatgpt",
]

for a in answers:
    r = client.ask(session.id, a)
    if r.get("type") == "done":
        print(r["prompt"])
        break
    print(f"→ {r.get('text', '')[:80]}...")

# Сохранить факт
client.remember("wb_shirt", "Blue oxford shirt, harari profile", "domain.marketplace")
```