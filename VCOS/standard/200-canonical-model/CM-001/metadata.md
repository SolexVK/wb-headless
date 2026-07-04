# CM-001.7 — Metadata Model

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Metadata Model defines how authorship, provenance, timing, and classification information is attached to every object in the Canonical Model.

---

## 2. Universal Metadata

Every Node and Edge carries metadata:

```
Metadata {
    createdAt:      Timestamp       (ISO 8601 UTC, set once)
    updatedAt:      Timestamp       (ISO 8601 UTC, updated on each version)
    author:         AgentID         (who/what created this version)
    provenance:     Provenance      (how this object came to be)
    version:        int             (monotonic, starts at 1)
}
```

### 2.1 Timestamps

- Format: ISO 8601 UTC, e.g., `2026-06-29T14:30:00Z`
- Precision: milliseconds
- `createdAt` — set when the object is first created, NEVER changes
- `updatedAt` — set to the current time on each version update

### 2.2 AgentID

Identifies the entity that created or modified the object:

```
AgentID {
    id:     string          (unique within the system)
    type:   "llm" | "kernel" | "human" | "transformer" | "plugin"
    name:   string          (human-readable, e.g., "deepseek-v4", "user-vitaliy")
}
```

---

## 3. Provenance

Provenance tracks **how** an object came to exist:

```
Provenance {
    method:     string          (e.g., "llm-generation", "user-input", "transformer-derivation", "import")
    sourceIDs:  ObjectID[]      (IDs of objects that were used to create this one)
    trace:      string[]        (free-form trace log, e.g., ["LLM call #42", "template filled"])
    confidence: float (0-1)     (how reliable this object is, populated by the creator)
}
```

### 3.1 Provenance Examples

| Creation Method | provenance.method | sourceIDs |
|----------------|-------------------|-----------|
| LLM from Source | `llm-inference` | [SourceID] |
| User types text | `user-input` | [] |
| Transformer derived | `transformer-merge` | [NodeID1, NodeID2] |
| Imported from external | `external-import` | [] (externalID in properties) |
| Plugin created | `plugin-creation` | [TriggeringNodeID] |

---

## 4. ProjectModel Metadata

```
ProjectModelMetadata {
    projectName:    string
    description:    string | null
    tags:           string[]            (free-form categorization)
    domain:         string[]            (loaded Domain Packs)
    modelTarget:    string | null       (e.g., "sdxl", "midjourney")
    creator:        AgentID
    createdAt:      Timestamp
    updatedAt:      Timestamp
    version:        int
    parentProject:  ProjectID | null    (if forked)
}
```

---

## 5. Provenance Chain

Each object's provenance forms a chain through `sourceIDs`:

```
Source "user typed X" (provenance.method = "user-input")
    ↓ sourceIDs references
Intent (provenance.method = "llm-inference", sourceIDs = [SourceID])
    ↓ sourceIDs references
Goal (provenance.method = "llm-inference", sourceIDs = [IntentID])
    ↓ sourceIDs references
Decision (provenance.method = "llm-inference", sourceIDs = [GoalID, ConstraintID])
```

This chain is **tracible** — given any object, you can walk back to its origin.

---

## 6. Classification Tags

Tags are optional, free-form, and carry no semantics:

```
tags: ["urgent", "experimental", "client-a", "v2-migration"]
```

Rules:
- Tags MUST NOT be used for identity or references.
- Tags MUST NOT be used for logic (no "if tag == X").
- Tags MAY be used for filtering, search, and UI organization.

---

## 7. Metadata Invariants

### M-001 — Every Object Has Metadata
All Nodes and Edges MUST carry complete metadata. No metadata = invalid state.

### M-002 — createdAt is Immutable
Once set, `createdAt` MUST NOT change.

### M-003 — author Records the Version Author
`metadata.author` reflects who created this **version**, not the original object (if different).

### M-004 — Provenance is Complete
`provenance.sourceIDs` MUST include all objects that directly influenced this object's creation.

### M-005 — No Semantic Logic in Tags
Tags MUST NOT be used for decision-making logic.

---

*End of Metadata Model specification*