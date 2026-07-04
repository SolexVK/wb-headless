# CO-001: Core Ontology

**Status:** Draft v0.1  
**Version:** 0.1.0  
**Authors:** Solex VCOS Team  
**Depends:** 000-foundation (Vision, Architecture-Invariants, Design-Principles)  
**Last Updated:** 2026-06-29

---

## Abstract

CO-001 defines the fundamental entity types of the VCOS platform. Every piece of information in a visual design project — from the user's raw intent to the final compiled artifact — is represented as an instance of one of six core entity types.

These six types form the **vocabulary of visual thinking**. They are the only primitives that exist at the kernel level. Everything else (Camera, Lighting, Composition, Style) lives in Domain Packs.

---

## Purpose

To provide a single, unambiguous definition of each core entity so that:
- All components (Orchestrator, Transformers, Renderers) speak the same language
- Domain Packs extend without modifying the kernel
- The Semantic Graph has a fixed set of valid node types
- Documentation and code remain consistent over time

---

## Scope

This document defines:
- The six core entity types and their properties
- The invariants that apply to each type
- The valid state transitions for each type
- Examples of each type in use

This document does NOT define:
- How entities are stored (see CM-001 Canonical Model)
- How entities are manipulated (see CA-001 Core Algebra)
- Domain-specific extensions (see Domain Pack specifications)

---

## Definitions

### 1. Intent

The user's raw, unprocessed desire. Intent is the **origin** of every project. It is captured before any analysis, before any decomposition. It may be vague, contradictory, or incomplete — that is the starting point.

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | UUID | yes | Unique identifier |
| description | string | yes | Free-form user statement |
| source | string | yes | How intent was captured (chat, voice, file) |
| created_at | datetime | yes | When intent was first expressed |
| confidence | float [0,1] | no | How well the system understands this intent |
| tags | list[string] | no | Extracted keywords |

**Invariants:**
- I-1: A project MUST have exactly one active Intent.
- I-2: Intent MUST NOT be modified after a Goal is created. Only superseded (new Intent replaces old).
- I-3: Intent confidence starts at 0.2 and increases as the system gathers context.

**State transitions:**
```
CAPTURED → ANALYZING → UNDERSTOOD → SUPERSEDED (if user changes mind)
```

### 2. Goal

A formalised, measurable objective derived from Intent. Goals are concrete and actionable. They answer the question: "What must this project achieve?"

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | UUID | yes | Unique identifier |
| description | string | yes | Clear, measurable objective |
| parent_intent_id | UUID | yes | Which Intent this Goal serves |
| priority | int [1-5] | no | Relative importance (1=critical) |
| status | enum | yes | DRAFT, ACTIVE, ACHIEVED, ABANDONED |
| rationale | string | no | Why this goal exists |

**Invariants:**
- G-1: A Goal MUST trace to exactly one Intent.
- G-2: A Goal MUST be either achieved or abandoned before the project is complete.
- G-3: Two Goals MAY contradict each other (this is allowed; decisions resolve the conflict).

**State transitions:**
```
DRAFT → ACTIVE → ACHIEVED
                → ABANDONED
```

### 3. Fact

An established piece of knowledge that constrains or informs decisions. Facts can come from the user, from Knowledge Expansion, or from external sources. A Fact is either **confirmed** (user validated) or **assumed** (system's best guess).

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | UUID | yes | Unique identifier |
| description | string | yes | The fact itself |
| source | string | yes | Where this fact came from (user, knowledge, system) |
| certainty | enum | yes | CONFIRMED, ASSUMED, INFERRED |
| confidence | float [0,1] | no | How certain we are this fact is correct |
| tags | list[string] | no | Domain-specific tags |

**Invariants:**
- F-1: A Fact MUST NOT contradict another confirmed Fact (assumed may contradict).
- F-2: Decision SHOULD NOT be made based solely on assumed facts.

### 4. Decision

The core unit of design thinking. A Decision is a choice made by the system (or user) that transforms the project state. Every decision has a rationale, a confidence, and traceability to the facts and goals it serves.

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | UUID | yes | Unique identifier |
| value | string | yes | The decision content (e.g. "Use warm colour palette") |
| rationale | string | no | Why this decision was made |
| confidence | float [0,1] | yes | System's confidence in this decision |
| status | enum | yes | DRAFT, PROPOSED, APPROVED, REJECTED, SUPERSEDED |
| alternatives | list[dict] | no | What alternatives were considered |
| source | string | yes | How decision was reached (reasoning, user, llm) |
| parent_goal_id | UUID | no | Which goal this decision serves |
| parent_decision_id | UUID | no | If this decision is a refinement of another |

**Invariants:**
- D-1: Every Decision MUST trace to at least one Goal OR another Decision.
- D-2: A Decision in APPROVED state MUST have confidence ≥ 0.7.
- D-3: A Decision in DRAFT state MUST NOT be used for Blueprint compilation.
- D-4: Rejected decisions are NOT deleted — they remain in the graph (traceability).

**State transitions:**
```
DRAFT → PROPOSED → APPROVED → SUPERSEDED
                → REJECTED
```

### 5. Blueprint

A compiled, consistent, and complete description of the visual scene. The Blueprint is the output of the reasoning pipeline and the input to renderers. It is NOT a prompt — it is a structured model.

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | UUID | yes | Unique identifier |
| content | dict | yes | Structured scene description |
| version | string | yes | Blueprint format version |
| source_decisions | list[UUID] | yes | Which decisions compiled into this |
| created_at | datetime | yes | When blueprint was compiled |
| status | enum | yes | DRAFT, CONSISTENT, COMPILED |

**Invariants:**
- B-1: Blueprint MUST include only APPROVED or VALIDATED decisions.
- B-2: Blueprint MUST have at least one Decision.
- B-3: Blueprint MUST be validated by Consistency Validator before compilation.

### 6. Artifact

The output of a Renderer. An Artifact is a concrete file or text — a prompt string, a ComfyUI workflow JSON, a Midjourney command. The same Blueprint can produce multiple Artifacts through different Renderers.

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | UUID | yes | Unique identifier |
| type | enum | yes | prompt, workflow, command, image |
| content | string/dict | yes | The actual artifact content |
| renderer | string | yes | Which renderer produced this |
| source_blueprint_id | UUID | yes | Which blueprint this was compiled from |
| created_at | datetime | yes | When artifact was generated |

**Invariants:**
- A-1: Every Artifact MUST trace to exactly one Blueprint.
- A-2: An Artifact MUST NOT be modified after creation (immutable).
- A-3: Multiple Artifacts MAY exist for the same Blueprint (different renderers).

---

## Entity Relationships

```
Intent
  │
  ├── produces ──► Goal (1-to-many)
  │
  ▼
Goal
  │
  ├── serves ──► Decision (1-to-many)
  │                │
  │                ├── refines ──► Decision (parent-child)
  │                │
  │                └── references ──► Fact (many-to-many)
  │
  ▼
Decision
  │
  ├── compiles ──► Blueprint (many-to-one)
  │
  ▼
Blueprint
  │
  ├── renders ──► Artifact (1-to-many)
  │
  ▼
Artifact
```

---

## Completeness Requirements

A project is considered **complete** when:

1. Intent exists and is UNDERSTOOD
2. At least one Goal exists and is ACHIEVED
3. Every active Goal has at least one APPROVED Decision
4. Blueprint exists and is COMPILED
5. At least one Artifact exists

A project is **ready for review** when:

1. Intent exists (any state)
2. At least one Goal exists
3. At least one Decision exists (any state)
4. Blueprint exists (any state)

---

## Examples

### Example 1: Coffee Advertisement

```
Intent("Реклама премиального кофе, уютное утро")
  → Goal("Продать ощущение уюта")
    → Fact("Утро = мягкий солнечный свет")
    → Fact("Премиум = тёплая цветовая палитра")
    → Decision("Показать крупный план чашки с паром")
      → Decision("Использовать малую глубину резкости")
  → Goal("Вызвать желание выпить кофе")
    → Fact("Текстура пара = свежесть")
    → Decision("Подсветить пар контровым светом")
  → Blueprint({...}) → Artifact("Cinematic shot of coffee cup...")
```

### Example 2: No Intent

```
Graph: [empty]
Result: "Нет Intent. Спросить пользователя: 'Что нужно сделать?'"
```

### Example 3: Intent without Goals

```
Intent("Сделать баннер для Telegram")
  → [no Goals]
Result: "Intent определён. Спросить: 'Какие 2-3 цели?'"
```

---

## Compliance

A VCOS implementation MUST:
- Support all six entity types with the required attributes
- Enforce all invariants listed above
- Implement the specified state transitions
- Provide traceability from Artifact to Intent

A VCOS implementation SHOULD:
- Support confidence scoring for each entity type
- Provide query tools for entity relationships
- Export entities in machine-readable format (JSON/YAML)

---

## References

- 000-foundation/Vision.md
- 000-foundation/Architecture-Invariants.md
- 000-foundation/Design-Principles.md
- CM-001: Canonical Model (how entities are stored)
- CA-001: Core Algebra (how entities are manipulated)