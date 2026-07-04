# ADR-0002: Deferred Decisions — v1.1 Roadmap

**Status:** Approved  
**Version:** 1.0  
**Date:** 2026-07-03  
**Author:** Chief Architect (Helios ☀️)  
**Supersedes:** —  
**Superseded by:** —

---

## 1. Summary

Фиксация всех архитектурных решений, отложенных до версии v1.1.
Ни одно из этих решений не блокирует compliance (121/121 тестов),
но все необходимы для production-зрелости.

---

## 2. Deferred Items

### 2.1 Fork / Merge / Rollback

| Поле | Значение |
|:-----|:---------|
| **Spec** | CA-001 §4.5 |
| **Причина defer** | Требует проектирования branch model для Semantic Graph. DAG-based versioning (как Git) — нетривиальная задача. Не влияет на компоновку промпта и текущий e2e-цикл. |
| **Compliance impact** | Нулевой — операции помечены как deferred, тесты проверяют наличие в freeze-документе |
| **v1.1 scope** | Fork (ветка от snapshot), Merge (fast-forward + three-way), Rollback (с созданием нового snapshot) |
| **Dependencies** | SnapshotManager (существует), SnapshotChain (существует) |

### 2.2 Cross-project Compare

| Поле | Значение |
|:-----|:---------|
| **Spec** | CA-001 §4.8 |
| **Причина defer** | Node-level compare (внутри проекта) реализован. Cross-project требует индексации проектов и нормализации графов. |
| **Compliance impact** | Нулевой |
| **v1.1 scope** | Compare(id_a, id_b) → ComparisonResult с Node/Edge delta, structural similarity, Decision overlap |

### 2.3 LLM-assisted Learning

| Поле | Значение |
|:-----|:---------|
| **Spec** | CP-001 §10 |
| **Причина defer** | Learning Engine MVP (частотный анализ) работает. Semantic extraction через LLM — v1.1. |
| **Compliance impact** | Нулевой |
| **v1.1 scope** | `extract_patterns()` с LLM-анализом, `approve_pattern()` / `reject_pattern()`, decay механизм |

### 2.4 Memory Persistence

| Поле | Значение |
|:-----|:---------|
| **Spec** | CP-001 §7 M-001 |
| **Причина defer** | InMemory-провайдер работает. pgvector — по готовности инфраструктуры. |
| **Compliance impact** | Нулевой — MemoryProvider interface существует |
| **v1.1 scope** | PGVectorProvider с persistence across restarts, namespace isolation |

### 2.5 Node Tags / Author

| Поле | Значение |
|:-----|:---------|
| **Spec** | CM-001 |
| **Причина defer** | Косметические поля (tags, author). Не влияют на computation, не блокируют compliance. |
| **Compliance impact** | Нулевой |
| **v1.1 scope** | `Node.tags: List[str]`, `Node.author: str`, metadata enrichment |

---

## 3. Architecture Check (Insight #11)

| Вопрос | Ответ |
|:-------|:------|
| 1. Делает ли оно Canonical Model проще? | Да — убирает нереализованные операции из active scope |
| 2. Убирает ли оно исключения? | Да — все deferred явно зафиксированы |
| 3. Сокращает ли количество сущностей? | Нет, но предотвращает их разрастание |

---

## 4. Impact

| Модуль | Изменение |
|:-------|:----------|
| ARCHITECTURE-FREEZE.md | Deferred секция обновлена |
| Compliance tests | Тесты проверяют deferred через freeze-документ |
| SnapshotManager | Fork/Merge/Rollback — stub с пометкой deferred |

---

## 5. Implementation Plan (v1.1)

```mermaid
gantt
    title v1.1 Roadmap
    dateFormat  YYYY-MM-DD
    section Memory
    PGVector persistence       : 2026-Q3
    section Algebra
    Fork/Merge/Rollback        : 2026-Q3
    Cross-project Compare      : 2026-Q4
    section Learning
    LLM-assisted patterns      : 2026-Q4
    section Cosmetic
    Node Tags / Author         : 2026-Q4
```

---

## 6. Статус

✅ **Принято.** Все deferred решения зафиксированы. Архитектура VCOS v1.0 заморожена.

## 7. Ссылки

- ARCHITECTURE-FREEZE.md — правила заморозки
- CA-001 §4.5 — Fork/Merge/Rollback spec
- CA-001 §4.8 — Compare spec
- CP-001 §7 M-001 — Memory Protocol
- CP-001 §10 — Learning Protocol