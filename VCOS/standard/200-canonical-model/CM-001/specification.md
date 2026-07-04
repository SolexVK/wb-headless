# CM-001 — Canonical Model v1.0

**Status:** Draft  
**Version:** 1.0.0  
**Author:** Chief Architect  
**Created:** 2026-06-29  
**Depends on:** [CO-001 — Core Ontology](../../100-core-ontology/CO-001/specification.md)

---

## 1. Purpose

CM-001 defines **how the entities of CO-001 are represented** inside the VCOS system.

It does **not** answer:
- *What exists?* — That is CO-001.
- *What operations are valid?* — That is CA-001.
- *How do components interact?* — That is CP-001.

CM-001 answers only one question:

> **How is the state of a cognitive design process represented as data?**

---

## 2. Scope

CM-001 covers:

- The definition of the **Canonical Model** — the universal data structure of VCOS
- The **Semantic Graph** as the only representation model
- The **Registry** — the single source of truth for all objects
- The **ProjectModel** — a projection of the graph for a specific design task
- The **Node** and **Edge** base contracts
- Identity, versioning, metadata, persistence, and validation rules

Out of scope:

- LLM interaction (defined in CP-001)
- Runtime execution (defined in Hermes implementation)
- Domain-specific fields (defined in Domain Packs)

---

## 3. Definitions

| Term | Definition |
|------|-----------|
| **Canonical Model** | The logical data model of VCOS — a named Semantic Graph |
| **Semantic Graph** | A property graph of typed Nodes and typed Edges |
| **Node** | A typed element representing a CO-001 entity |
| **Edge** | A typed directed relationship between two Nodes |
| **Graph** | A named collection of Nodes and Edges with invariants |
| **Registry** | The single storage that holds all Nodes and Edges |
| **ProjectModel** | A projection of the Semantic Graph for a specific design task |
| **Source** | The original raw input (text, image, voice, URL) before interpretation |
| **Object ID** | A stable, immutable UUID v7 that identifies a Node or Edge |

---

## 4. Fundamental Decision: Semantic Graph as Canonical Model

The Canonical Model of VCOS is **not a tree**, **not a JSON schema**, **not a set of classes**.

It is a **Named Semantic Graph** defined as:

> A labeled property graph composed of **typed Nodes** and **typed Edges**, representing the state of a cognitive design process independently of implementation, storage, or compute model.

### 4.1 Why a Graph

| Requirement | Tree | JSON | Graph |
|-------------|------|------|-------|
| Multiple agents | ❌ | ❌ | ✅ |
| Multiple branches | ❌ | ❌ | ✅ |
| Multiple Blueprints | ❌ | ❌ | ✅ |
| Arbitrary Domain Packs | ❌ | ❌ | ✅ |
| Fork/merge | ❌ | ❌ | ✅ |
| Undo/rollback | ❌ | ❌ | ✅ |
| Diff between states | ❌ | ❌ | ✅ |
| New entity types without kernel change | ❌ | ❌ | ✅ |

### 4.2 Graph Composition

```
Canonical Model
│
├── Registry        ← All Nodes and Edges live here
│
└── ProjectModel    ← References (IDs) to Nodes and Edges
```

- **Registry** is responsible for **existence** of objects.
- **ProjectModel** is responsible for **organization** of a specific project.
- **Hermes** is responsible for **changes** to the model.
- **LLM** is responsible for **reasoning** (proposing new Nodes/Edges).

### 4.3 Immutable Model Principle

**The Canonical Model is immutable.**

A Transformer does not modify the current state. It creates a new version:

```
ProjectModel v1
    │
    ▼
Transformer
    │
    ▼
ProjectModel v2
```

This gives:
- Full history of changes
- Comparison between versions
- Branching and forking
- Reproducibility
- Safe sharing between agents

---

## 5. Object Registry

The Registry is a **single, flat storage** of all objects in the Canonical Model.

### 5.1 Structure

```
Registry
│
├── Node[]
│   ├── Node{ id, type, properties, metadata }
│   ├── Node{ id, type, properties, metadata }
│   └── ...
│
└── Edge[]
    ├── Edge{ id, type, source, target, properties, metadata }
    ├── Edge{ id, type, source, target, properties, metadata }
    └── ...
```

### 5.2 Rules

1. Every object in VCOS lives in the Registry.
2. **No nested objects.** No "object within object" — all objects are flat in the Registry.
3. Objects are referenced by ID only.
4. The Registry does NOT impose an order — objects are independent.
5. Multiple ProjectModels can share the same Registry.

### 5.3 Why Flat Registry

```
BAD:                              GOOD:
Project                           Registry
│                                 │
├── Goal                          ├── Goal #18
│   └── Decision                  ├── Decision #52
│       └── Blueprint             ├── Blueprint #7
└── Facts                         └── Fact #3
```

The flat Registry gives:
- Graph traversal
- No duplication
- Cheap branching
- Cheap comparison
- Immutability by design

---

## 6. ProjectModel

ProjectModel is a **projection** of the Semantic Graph for a specific design task.

### 6.1 Structure

```
ProjectModel
│
├── identity:   ProjectID
├── source:     Source[]            (raw user input)
├── intents:    IntentID[]          (interpreted goals)
├── goals:      GoalID[]            (what to achieve)
├── constraints: ConstraintID[]     (boundaries)
├── facts:      FactID[]            (known truths)
├── decisions:  DecisionID[]        (choices made)
├── blueprints: BlueprintID[]       (design specifications)
├── artifacts:  ArtifactID[]        (outputs created)
├── knowledge:  KnowledgeID[]       (learned information)
├── metadata:   Metadata            (version, author, timestamps)
└── history:    History[]           (sequence of changes)
```

### 6.2 Rules

1. ProjectModel stores **only IDs**, not the objects themselves.
2. Objects are resolved from the Registry by ID.
3. A ProjectModel is always associated with exactly one Registry.
4. A Registry may serve multiple ProjectModels (branches, scenarios).

### 6.3 Source Entity

Source is a CM-only entity (not in CO-001). It represents the **raw original input**:

```
Source {
    id:         SourceID
    type:       "text" | "image" | "voice" | "video" | "url" | "file"
    content:    raw content
    format:     mime-type
    timestamp:  created-at
    metadata:   { language, size, ... }
}
```

Flow:
```
Source → Intent → Goal → ... → Artifact
```

---

## 7. LLM Role

The LLM does **not** modify the Canonical Model directly.

The LLM is responsible for **one thing only**:

> Proposing new Nodes and Edges.

```
User: "Design an ad for Porsche in Pixar style."

LLM:
  → Proposes Intent Node
  → Proposes Goal Nodes
  → Proposes Constraint Nodes
  → Proposes Decision Nodes with Edges

Kernel (Hermes):
  → Evaluates proposals
  → Accepts or rejects
  → Records decisions in Decision Log
```

**Hermes** is not an LLM wrapper.  
**Hermes** is an operating system that manages the evolution of the Semantic Graph.

---

## 8. Normative Requirements

### R-001 — Graph Purity
The Canonical Model MUST be a Semantic Graph (Nodes + Edges), not a tree, not a JSON hierarchy.

### R-002 — Immutable State
Every mutation of the Canonical Model MUST produce a new version. In-place modification is FORBIDDEN.

### R-003 — Registry as Single Source of Truth
All objects MUST live in the Registry. No object may be embedded inside another object.

### R-004 — Reference by ID
ProjectModel MUST reference objects by ID only. Direct nesting of objects inside ProjectModel is FORBIDDEN.

### R-005 — Node Independence
Nodes MUST NOT contain references to other Nodes. All relationships MUST be expressed through Edges in the Edge Registry.

### R-006 — Common Base Contract
All Node types (Intent, Goal, Fact, Decision, Blueprint, Artifact, Knowledge) MUST share a common base contract: id, type, properties, metadata, lifecycle.

### R-007 — LLM Proposes, Kernel Decides
The LLM MUST only propose Nodes and Edges. The decision to accept or reject belongs to the Kernel (Hermes).

### R-008 — Source Preservation
The original user input MUST be preserved as a Source object and linked to the resulting Intent.

### R-009 — No Business Logic in Model
The Canonical Model (Registry + ProjectModel) MUST NOT contain any business logic. It contains only state.

---

## 9. Compliance

An implementation is CM-001 compliant if:

1. It uses a Semantic Graph (Node + Edge + Graph) as the data model.
2. It maintains a flat Registry of all objects.
3. It uses immutable versioning (no in-place mutation).
4. It separates Registry (existence) from ProjectModel (organization).
5. It preserves Source objects.
6. It follows the LLM Proposes → Kernel Decides pattern.
7. All Node types from CO-001 are representable as Node in the graph.

---

## 10. Change Policy

### Minor Version
Permitted:
- Clarification of definitions
- Addition of examples
- Editorial changes

### Major Version
Permitted:
- Changes to graph structure invariants
- Changes to the identity model
- Changes to normative requirements

Major version requires CO-001 review and CA-001 alignment.

---

*End of CM-001 Specification*