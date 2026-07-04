# VCOS — Visual Content Orchestration System

Платформа структурного промптинга. Строит промпты для фото товаров через диалог: задаёт вопросы → парсит ответы LLM → применяет режиссёрские/дизайнерские профили → экспортирует под любую модель генерации.

## Быстрый старт

```bash
cd ~/VCOS
source ~/.hermes/hermes-agent/venv/bin/activate
```

## Запуск сессии

```python
from hermes.orchestrator.core import Orchestrator

o = Orchestrator()
o.start_new_session()
# → ❓ Категория товара?
```

### Фазы диалога

| # | Фаза | Что спрашивает |
|---|------|----------------|
| 0 | Категория | Тип товара (одежда, обувь...) |
| 1 | Товар | Цвет, ткань, крой, детали |
| 2 | Модель + сцена | Кто на фото, где, окружение |
| -2 | Референс | Есть образец стиля? |
| -1 | Профиль | Кинорежиссёр / дизайнер / маркетолог |
| 3 | Режиссура | Настроение, свет, ракурс |
| 4 | Inference | LLM достраивает пропуски |
| 5 | Экспорт | Выбор модели (chatgpt/midjourney/nanobanana/flux/sdxl) |

### Пример полного цикла

```python
o = Orchestrator()
o.start_new_session()

o.submit_answer('одежда')                          # фаза 0
o.submit_answer('Рубашка, голубая, Оксфорд...')    # фаза 1
o.submit_answer('Девушка 25 лет, кафе...')          # фаза 2
o.submit_answer('нет')                               # референс
o.submit_answer('харари')                            # профиль
o.submit_answer('Тёплое настроение, свет...')        # фаза 3
o.submit_answer('')                                  # inference
o.submit_answer('chatgpt')                           # экспорт
# → ✅ Промпт готов!
```

Каждый вызов возвращает `{"type": "question" | "done", "text": "...", "prompt": "..."}`.

### Переключение модели

```python
# После экспорта
o.switch_model('midjourney')
o.switch_model('sdxl')
```

## Архитектура

```
VCOS/
├── hermes/
│   ├── agents/            # DialogueAgent — вопросы, парсинг, retry
│   ├── kernel/            # Node/Edge/Graph, DecisionLogger, SemanticGraphAdapter
│   ├── orchestrator/      # Cognitive cycle (Observe→Evaluate→Decide→Act→Record)
│   ├── reasoning/         # ConfidenceEvaluator, DirectorProfiles (22 шт), VisualReasoner
│   ├── renderers/         # PromptExporter (5 моделей), ScenePrompt
│   ├── domain_packs/      # VSL data model, LLM client
│   └── tests/             # 32 теста (unit + integration)
├── docs/
└── standard/              # Спецификации, ADR, архитектурные инварианты
```

## Тесты

```bash
# Unit-тесты (без LLM, быстрые)
python -m pytest hermes/tests/test_confidence.py -v

# Интеграционные (с LLM, ~1 мин)
python -m pytest hermes/tests/test_full_cycle.py -v

# Все
python -m pytest hermes/tests/ -v
```

### Что проверяют тесты

- **ConfidenceEvaluator** — расчёт уверенности по блокам (coverage + specificity + source)
- **DecisionLogger** — запись/чтение решений с источниками
- **SemanticGraph** — построение узлов и рёбер
- **Orchestrator** — старт, категория, валидация
- **DialogueParser** — парсинг товара/модели/режиссуры через LLM (3 retry)
- **FullCycle** — полный проход 0→6 фаз
- **ConfidenceProgression** — рост уверенности по мере заполнения
- **ModelSwitch** — переключение после экспорта
- **Exporters** — все 5 форматов с разным синтаксисом

## Принципы

- LLM только через DialogueTransformer (Kernel чистый)
- Вопросы группируются (3-4 вместо 10-15)
- Двухпроходная система: пользователь → LLM парсинг → уточнение
- ConfidenceEvaluator: advance (≥0.7) / clarify (≥0.4) / retry (<0.4)
- Мультимодельный экспорт: полное содержание, меняется только синтаксис