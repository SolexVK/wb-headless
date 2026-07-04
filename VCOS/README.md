# VCOS — Visual Cognitive Operating System

**Version:** v1.0.0-draft  
**Status:** Foundation Phase  
**License:** Apache 2.0  

---

VCOS — это открытый стандарт когнитивного проектирования визуального контента.  
Он преобразует человеческое намерение в формальную проектную модель,  
а затем компилирует её в артефакты для различных генеративных систем.

**VCOS — это не генератор промптов.**  
VCOS — это операционная система для проектирования визуального контента,  
где LLM является лишь одним из механизмов, предлагающих изменения семантического графа.

---

## Архитектура

```
Пользователь → Intent → Semantic Graph → Domain Pack → Renderer → Артефакт
```

Система строится вокруг **Semantic Graph** — графа знаний,  
где каждая сущность проекта (цель, решение, ограничение, артефакт)  
является узлом, а связи между ними — типизированными рёбрами.

**Фундаментальные примитивы (CO-001):**
- **Intent** — намерение пользователя
- **Goal** — цель проектирования
- **Fact** — установленный факт
- **Decision** — принятое решение
- **Constraint** — ограничение
- **Blueprint** — проектная модель сцены
- **Artifact** — результат компиляции

**Три объекта ядра (CM-001):**
- **Node** — типизированный узел графа
- **Edge** — типизированная связь между узлами
- **Graph** — контейнер узлов и связей

---

## Структура репозитория

```
VCOS/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── CHANGELOG.md
├── ROADMAP.md
├── VERSION
│
├── docs/
│   ├── standard/          # Спецификация стандарта
│   │   ├── 000-foundation/ # Неизменяемый фундамент
│   │   ├── 100-core/       # Core Ontology + Canonical Model
│   │   ├── 200-model/      # Domain Model
│   │   ├── 300-algebra/    # Core Algebra
│   │   ├── 400-protocols/  # Agent Protocol
│   │   ├── 500-domain/     # Domain Packs
│   │   ├── 600-runtime/    # Runtime
│   │   ├── 700-renderers/  # Renderer Specifications
│   │   ├── 800-reference/  # Reference Implementation
│   │   └── 900-adr/        # Architecture Decision Records
│   │
│   ├── reference/          # Справочная информация
│   ├── examples/           # Примеры VSL-документов
│   ├── schemas/            # Машиночитаемые схемы (JSON/YAML/Proto)
│   ├── hermes/             # Hermes reference implementation docs
│   └── templates/          # Шаблоны документов
│
├── scripts/                # Инструменты и утилиты
└── tools/                  # CLI tools
```

---

## Принципы

1. **The System Designs, Not Generates** — система проектирует визуальное решение, генерация — лишь экспорт
2. **Reasoning First** — любое решение — результат рассуждения, не шаблона
3. **Prompt Is Compilation** — промпт — результат компиляции Scene Specification
4. **Separation of Concerns** — каждый агент отвечает за одну область
5. **Explainability** — каждое решение имеет обоснование и источник
6. **Model-agnostic** — система не зависит от генеративной модели
7. **Render Independence** — одна спецификация — множество рендереров
8. **Knowledge-centric** — агент опирается на знания, а не на промпты
9. **Decision-driven Architecture** — в центре системы решения, а не поля
10. **Iterative Design** — проект создаётся итерациями

---

## Быстрый старт

```bash
# Установка (будет реализовано в v0.2)
pip install vcos-cli

# Создать новый проект
vcos init my-project

# Запустить дизайн-сессию
vcos design

# Экспортировать в целевую модель
vcos render --target flux
```

---

## Статус проекта

| Компонент | Статус |
|-----------|--------|
| 000-foundation | ✅ Draft |
| 100-core | 🔄 В разработке |
| 200-model | ⏳ Запланировано |
| 300-algebra | ⏳ Запланировано |
| 400-protocols | ⏳ Запланировано |
| 500-domain | ⏳ Запланировано |
| 600-runtime | ⏳ Запланировано |
| 700-renderers | ⏳ Запланировано |
| Hermes Implementation | ⏳ Запланировано |

---

## Лицензия

Apache 2.0 © 2026 Solex