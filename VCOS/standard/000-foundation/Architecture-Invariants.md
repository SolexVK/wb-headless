# Architecture Invariants

**Document ID:** ARCH-INV-001  
**Version:** 1.0.0-draft  
**Status:** Draft  
**Parent:** Vision.md  
**Next:** Design-Principles.md  

---

Invariants — это правила, которые **никогда** нельзя нарушать в архитектуре VCOS.  
Нарушение инварианта означает несовместимость со стандартом.

---

## Invariant I-001: Model Agnosticism

**Core Ontology и Semantic Graph не зависят от генеративной модели.**

LLM, Midjourney, Flux, Sora, Kling, Veo, ComfyUI — любая генеративная система является внешним компонентом. Она не влияет на внутреннюю модель VCOS.

*Нарушение:* добавление полей типа `--stylize 500`, `CFG Scale`, `v7` в Core Ontology.

## Invariant I-002: Prompt Is Compilation

**Промпт — это результат компиляции, а не проектирования.**

Проектирование происходит в Semantic Graph. Промпт — один из возможных форматов экспорта. Ни один агент, кроме Renderer, не работает с промптами.

*Нарушение:* агент Scene Discovery пишет промпт напрямую.

## Invariant I-003: Separation of Concerns

**Каждый агент отвечает только за одну область знаний.**

- Orchestrator управляет процессом, но не принимает визуальных решений
- Visual Reasoner проектирует визуальный язык, но не пишет промпт
- Renderer компилирует граф, но не принимает творческих решений

*Нарушение:* Renderer изменяет Composition или Lighting в процессе компиляции.

## Invariant I-004: Decision-Driven State

**Всякое изменение состояния Semantic Graph является следствием принятого решения.**

Каждый новый узел или ребро в графе должно быть обосновано Decision.  
Decision, в свою очередь, должно быть обосновано Goal или Fact.

*Нарушение:* добавление узла в граф без соответствующего Decision.

## Invariant I-005: Knowledge Immutability from Artifacts

**Artifact не может изменять Knowledge.**

Артефакт — результат компиляции. Он не является источником знаний.  
Изменение знаний происходит только через Decision.

*Нарушение:* запись информации из сгенерированного промпта обратно в Knowledge без создания Decision.

## Invariant I-006: Domain Boundary

**Domain Packs не изменяют Core Ontology.**

Domain Pack добавляет сущности (Camera, Lighting, Composition), но не может:
- удалять базовые сущности (Intent, Goal, Decision)
- изменять Core Relationships
- нарушать Core Constraints

*Нарушение:* Domain Pack объявляет Goal устаревшим.

## Invariant I-007: Renderer Purity

**Renderer не создаёт новые Decisions.**

Renderer — чистая функция от Semantic Graph к артефакту.  
Он не принимает проектных решений. Все творческие решения должны быть приняты до вызова Renderer.

*Нарушение:* Renderer выбирает между тёплым и холодным светом в процессе компиляции.

## Invariant I-008: Graph-First Communication

**Все агенты общаются через Semantic Graph.**

Нет прямых вызовов между агентами.  
Оркестратор читает граф → решает, какой агент нужен → агент читает граф → агент модифицирует граф → оркестратор оценивает результат.

*Нарушение:* агент Camera передаёт данные напрямую агенту Lighting.

## Invariant I-009: Intent Integrity

**Intent остаётся неизменным на протяжении всего проекта.**

Пользовательское намерение фиксируется в начале и не может быть изменено агентами.  
Агенты могут уточнять, дополнять, интерпретировать — но не изменять исходный Intent.

*Нарушение:* Visual Reasoner изменяет `Intent.DesiredImpact` в процессе проектирования.

## Invariant I-010: Cognitive Primitive Minimalism

**Core Ontology содержит только когнитивные примитивы.**

Camera, Scene, Character, Lighting, Typography, Composition — не являются когнитивными примитивами. Они принадлежат Domain Packs.

*Нарушение:* добавление Scene как фундаментальной сущности CO-001.

---

## Таблица инвариантов

| ID | Инвариант | Санкция |
|----|-----------|---------|
| I-001 | Model Agnosticism | Несовместимость со стандартом |
| I-002 | Prompt Is Compilation | Несовместимость со стандартом |
| I-003 | Separation of Concerns | Архитектурная ошибка |
| I-004 | Decision-Driven State | Потеря целостности графа |
| I-005 | Knowledge Immutability | Циклическая зависимость |
| I-006 | Domain Boundary | Нарушение уровней абстракции |
| I-007 | Renderer Purity | Непредсказуемый результат |
| I-008 | Graph-First Communication | Нарушение модульности |
| I-009 | Intent Integrity | Потеря пользовательского контекста |
| I-010 | Primitive Minimalism | Размывание Core Ontology |

---

## Связь с другими документами

| Документ | Связь |
|----------|-------|
| Vision.md | Определяет цели, которым служат инварианты |
| Design-Principles.md | Принципы, дополняющие инварианты |
| CO-001 | Core Ontology — предмет инварианта I-010 |
| ADR-0001 | Обоснование выбора Semantic Graph |