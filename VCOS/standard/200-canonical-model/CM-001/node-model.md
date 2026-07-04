# CM-001.2 — Node Model

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Node Model defines the structure, lifecycle, and constraints of all Nodes in the Semantic Graph.

---

## 2. Node Base Contract

Every Node in the Canonical Model MUST conform to this base contract:

```
Node {
    id:          NodeID            (immutable UUID v7)
    type:        NodeType          (from CO-001 or Domain Pack)
    state:       LifecycleState    (draft | validated | approved | deprecated | archived)
    properties:  Properties        (typed key-value map, type-specific)
    metadata:    NodeMetadata      (version, author, timestamps, provenance)
    tags:        Tag[]             (optional categorization)
}
```

### 2.1 NodeID

- MUST be UUID v7 (time-ordered)
- MUST be immutable (never changes for the same logical node)
- MUST be globally unique within a Registry
- Format: `uuid.v7` string, e.g., `018f-1234-5678-9abc-def0`

### 2.2 NodeType

- Defined in CO-001 for core types
- Extended by Domain Packs for domain-specific types
- Naming: PascalCase, e.g., `Intent`, `Goal`, `FilmShot`
- Registration: Must be declared in a Domain Pack or CO-001

### 2.3 LifecycleState

```
                    ┌──────────┐
                    │  Draft   │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ Validated │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ Approved │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         ┌────▼───┐ ┌────▼────┐ ┌──▼──────┐
         │Deprecated│ │Archived│ │Rejected │
         └─────────┘ └─────────┘ └─────────┘
```

States:
- **Draft** — proposed (by LLM or user), not yet reviewed
- **Validated** — passed invariant checks
- **Approved** — accepted by Kernel (decision recorded)
- **Deprecated** — superseded by another node
- **Archived** — frozen, read-only
- **Rejected** — proposed but denied (with reason)

### 2.4 Properties

Properties are **type-specific** and defined by:
- The NodeType specification in CO-001 for core types
- Domain Pack specifications for domain types

Structure:
```
properties: {
    [key: string]: PropertyValue
}
```

PropertyValue is one of:
- `string`, `number`, `boolean`
- `string[]`, `number[]`
- `Reference` (an ID pointing to another Node)
- `Reference[]`
- Structured object (if defined in Domain Pack)

**Rule:** Properties MUST NOT contain business logic. They contain only data.

### 2.5 NodeMetadata

```
NodeMetadata {
    createdAt:      Timestamp       (immutable — set on creation)
    updatedAt:      Timestamp       (updated on each version)
    author:         AgentID         (who/what created this node)
    provenance:     Provenance      (how this node was created)
    sourceNodeID:   NodeID | null   (if derived from another node)
    version:        int             (monotonic version counter)
}
```

### 2.6 Tags

Optional categorization. Tags are:
- Free-form strings
- Used for filtering and organization
- NOT used for identity or semantics

---

## 3. Core Node Types (from CO-001)

Each CO-001 entity is represented as a Node with a specific type:

### 3.1 Intent

```
Node {
    type: "Intent"
    properties: {
        description:    string        (interpreted goal description)
        confidence:     float (0-1)   (LLM confidence in interpretation)
        sourceID:       SourceID      (link to Source in ProjectModel)
        language:       string        (original language code)
    }
}
```

Role: The first interpreted representation of user input.  
Created by: LLM from Source.  
Consumed by: Transformer → generates Goal nodes.

### 3.2 Goal

```
Node {
    type: "Goal"
    properties: {
        description:    string        (what to achieve)
        priority:       "primary" | "secondary" | "nice-to-have"
        criteria:       string[]      (success criteria)
    }
}
```

Role: What the system must achieve.  
Created by: LLM from Intent + Constraints.  
May be: Derived from Intent, not always separate.

### 3.3 Constraint

```
Node {
    type: "Constraint"
    properties: {
        description:    string        (the constraint)
        category:       "technical" | "stylistic" | "budget" | "time" | "brand"
        strength:       "hard" | "soft" | "preference"
    }
}
```

Role: Boundaries the system must respect.  
Created by: LLM from Source + Intent.

### 3.4 Fact

```
Node {
    type: "Fact"
    properties: {
        description:    string        (the fact)
        source:         string        (where this fact came from)
        certainty:      float (0-1)   (confidence in truth)
    }
}
```

Role: Known truths about the domain or context.  
IMPORTANT: Facts MUST NOT be modified by Renderer (R-007 in CO-001).

### 3.5 Decision

```
Node {
    type: "Decision"
    properties: {
        description:    string        (what was decided)
        rationale:      string        (why this decision)
        alternatives:   string[]      (what was considered)
        status:         "proposed" | "accepted" | "rejected" | "superseded"
    }
}
```

Role: A choice made during the design process.  
Each Decision MUST support at least one Goal.

### 3.6 Blueprint

```
Node {
    type: "Blueprint"
    properties: {
        description:    string        (what this blueprint specifies)
        specifications: Spec[]        (structured design specs)
        modelType:      string        (e.g., "sdxl", "midjourney", "flux")
        format:         string        (e.g., "prompt", "comfyui", "html")
    }
}
```

Role: A complete design specification ready for rendering.  
Contains one or more Decisions.

### 3.7 Artifact

```
Node {
    type: "Artifact"
    properties: {
        description:    string        (what was created)
        format:         string        (e.g., "png", "html", "video")
        url:            string | null (location of the generated artifact)
        hash:           string | null (content hash for verification)
        generator:      string        (which generator produced it)
        params:         Params        (generation parameters used)
    }
}
```

Role: The final output of the design process.

### 3.8 Knowledge

```
Node {
    type: "Knowledge"
    properties: {
        content:        string        (the knowledge)
        domain:         string        (which domain this belongs to)
        source:         string        (origin of this knowledge)
        confidence:     float (0-1)   (reliability)
    }
}
```

Role: What the system knows about a domain.  
May support Decisions.

---

## 4. Domain Node Types

Domain Packs may extend the Node types:

| Domain Pack | Example Node Types |
|-------------|-------------------|
| Film | FilmShot, Scene, CameraMove, LightingSetup |
| Advertising | BrandGuideline, TargetAudience, FunnelStage |
| Photography | LensSetup, Composition, ColorPalette |
| Infographic | Section, DataPoint, ChartType |
| Product | ProductCategory, Material, ColorVariant |

These are defined in their respective Domain Pack specifications.

---

## 5. Node Invariants

### N-001 — Every Node MUST have an ID
No anonymous nodes. Even temporary/proposed nodes get a draft ID.

### N-002 — Node type MUST be registered
Every NodeType must be declared either in CO-001 or a loaded Domain Pack.

### N-003 — Properties MUST NOT contain sub-nodes
If a property is a complex object, it must be a separate Node referenced by ID.

### N-004 — State transitions MUST follow lifecycle
No skipping states: Draft → Validated → Approved → Deprecated/Archived.
Rejected is an exception (Draft → Rejected directly).

### N-005 — Metadata is immutable
`createdAt`, `author`, and `version` (initial) are set once and never changed.

---

## 6. Creation Rules

| Node Type | Must Be Created After | Created By |
|-----------|----------------------|------------|
| Intent | Source exists | LLMTransformer |
| Goal | Intent exists | LLMTransformer |
| Constraint | Source exists | LLMTransformer |
| Fact | Source exists | KnowledgeTransformer |
| Decision | Goal exists | LLMTransformer |
| Blueprint | Decision exists | DesignTransformer |
| Artifact | Blueprint exists | Renderer |
| Knowledge | (any time) | KnowledgeTransformer |

---

*End of Node Model specification*