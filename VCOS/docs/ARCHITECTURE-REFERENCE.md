# VCOS — Architecture Reference

## Общая архитектура

```
Пользователь ←→ PhaseInterview (6 фаз + референс + профиль + модель)
                        ↓
                  VisualProject (VSL — 17 блоков)
                        ↓
              PromptExporter (5 форматов моделей)
                        ↓
                  Готовый промпт
```

## Фазы диалога

```
Фаза 0:   🏷 Категория товара
Фаза 1:   🧥 Товар (группированный вопрос → LLM-парсинг → уточнение)
Фаза 2:   👤 Модель + окружение
Фаза -2:  🖼 Референс (опционально)
Фаза -1:  🎭 Выбор профиля (режиссёр/дизайнер/маркетолог)
Фаза 3:   🎬 Режиссура и настроение
Фаза 4:   🤖 Inference Engine (DeepSeek V4 Flash)
Фаза 5:   ✅ Контроль (проверка пробелов)
Фаза 6:   🎯 Выбор модели → экспорт промпта
```

## Файловая структура

```
hermes/
├── domain_packs/
│   ├── scene_spec.py          # VSL — 17 блоков (VisualProject)
│   ├── llm_client.py          # OpenRouter client (DeepSeek V4 Flash)
│
├── reasoning/
│   ├── phase_interview.py     # Фазовый опрос (PhaseInterview)
│   ├── director_profiles.py   # 22 профиля (~20 параметров каждый)
│   ├── inference_engine.py    # LLM-рассуждение (достройка пропусков)
│   ├── context_builder.py     # Сбор контекста из запроса
│   ├── intent_model.py        # Моделирование намерения
│   ├── gap_analyzer.py        # Поиск пробелов
│   ├── hypothesis_generator.py # Генерация гипотез
│   └── interview_planner.py   # Старый планировщик (не используется)
│
├── renderers/
│   ├── scene_prompt.py        # Русский промпт
│   └── prompt_exporter.py     # Английский промпт под 5 моделей
│
├── transformers/
│   └── dialogue.py            # Старый диалог (не используется)
│
├── tests/
│   ├── test_iteration1.py     # Тесты
│   └── demo_*.py              # Демо-скрипты

docs/
├── product-card-criteria.md   # Справочник 9 категорий товаров
└── ARCHITECTURE-REFERENCE.md  # Этот файл

standard/
└── 100-core-ontology/
    └── CO-001/                # Документация первой итерации
```

## Ключевые файлы — описание

### scene_spec.py
Ядро данных. 16 dataclass + VisualProject-корень.
17 блоков VSL: Metadata, Intent, Narrative, Character, Environment,
Composition, Camera, Lighting, Color, Style, Motion, Atmosphere,
VisualDesign, Technical, Constraints, Knowledge.

### phase_interview.py
Основной движок. Проводит фазовый опрос.
Каждая фаза → свой метод _phaseN_question и _process_phaseN.
LLM-парсинг на фазах 1, 2, 3, Reference.

### director_profiles.py
22 профиля с ~20 параметрами каждый.
3 роли: кинорежиссёры (12), дизайнеры (4), маркетологи (6).
Включает авто-подбор под категорию товара.

### prompt_exporter.py
Экспорт промпта под 5 моделей.
Сохраняет ПОЛНУЮ детализацию VSL.
Меняется только синтаксис (параметры, веса, разделители).

### llm_client.py
Клиент OpenRouter. Все LLM-вызовы через DeepSeek V4 Flash.
Fallback: Nemotron 3 Super 120B (free).
Стоимость: ~$0.0001-0.001 за сессию.
