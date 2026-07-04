# CM-001.3 — Edge Model

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Edge Model defines the structure, types, and constraints of all Edges in the Semantic Graph.

Edges are the **only** way to express relationships between Nodes. **Nodes must NOT contain references to other Nodes.**

---

## 2. Edge Base Contract

Every Edge in the Canonical Model MUST conform to this base contract:

```
Edge {
    id:          EdgeID            (immutable UUID v7)
    type:        EdgeType          (e.g., "supports", "derives_from")
    source:      NodeID            (the origin node)
    target:      NodeID            (the destination node)
    properties:  Properties        (typed key-value map, type-specific)
    metadata:    EdgeMetadata      (version, author, timestamps)
}
```

### 2.1 EdgeID

- MUST be UUID v7
- MUST be globally unique within a Registry
- Different from any NodeID

### 2.2 EdgeType

Edges are **directed** by default. An undirected relationship is modeled as two directed edges.

Naming: `snake_case`, e.g., `supports`, `derives_from`, `contradicts`.

### 2.3 EdgeProperties

Type-specific properties:

```
properties: {
    [key: string]: PropertyValue
}
```

Same value types as Node properties (string, number, boolean, Reference, arrays).

### 2.4 EdgeMetadata

```
EdgeMetadata {
    createdAt:      Timestamp       (immutable)
    updatedAt:      Timestamp       (updated on each version)
    author:         AgentID         (who/what created this edge)
    weight:         float (0-1)     (optional — strength of relationship)
    justification:  string | null   (optional — why this edge exists)
}
```

---

## 3. Core Edge Types

### 3.1 Structural Edges

| Edge Type | Source | Target | Meaning |
|-----------|--------|--------|---------|
| `derives_from` | Any Node | Any Node | Target was derived from Source |
| `refines` | Goal | Intent | Goal is a refinement of Intent |
| `contains` | Node | Node | Source logically contains Target |
| `references` | Node | Node | Source references Target as context |

### 3.2 Relational Edges

| Edge Type | Source | Target | Meaning |
|-----------|--------|--------|---------|
| `supports` | Decision | Goal | Decision helps achieve Goal |
| `contradicts` | Decision | Goal | Decision conflicts with Goal |
| `enables` | Knowledge | Decision | Knowledge makes Decision possible |
| `constrains` | Constraint | Decision | Constraint limits Decision |
| `satisfies` | Blueprint | Decision | Blueprint implements Decision |
| `produces` | Artifact | Blueprint | Artifact is output of Blueprint |

### 3.3 Domain Edges

Domain Packs may define additional edge types:

| Domain Pack | Edge Type | Meaning |
|-------------|-----------|---------|
| Film | `follows` | Shot follows another shot |
| Film | `establishes` | Shot establishes a location |
| Advertising | `targets` | Design targets an audience |
| Photography | `illuminates` | Light setup illuminates subject |

---

## 4. Edge Constraints

### 4.1 Structural Constraints

| Constraint | Rule |
|------------|------|
| No self-loops | source MUST NOT equal target |
| No parallel duplicates | No two edges with same type, source, target |
| Source exists | source NodeID MUST exist in Registry |
| Target exists | target NodeID MUST exist in Registry |

### 4.2 Type Constraints (Core)

| Edge Type | Source MUST be | Target MUST be |
|-----------|---------------|----------------|
| `supports` | Decision | Goal |
| `contradicts` | Decision | Goal |
| `derives_from` | Any | Any |
| `refines` | Goal | Intent |
| `enables` | Knowledge | Decision |
| `constrains` | Constraint | Decision |
| `satisfies` | Blueprint | Decision |
| `produces` | Artifact | Blueprint |

---

## 5. Edge Operations

### 5.1 Create
```
Graph.addEdge(type, sourceID, targetID, properties?)
```
Validates: source exists, target exists, type constraint, no duplicate.  
Returns: EdgeID.

### 5.2 Remove
```
Graph.removeEdge(edgeID)
```
Validates: edge exists.  
Note: Removing an edge does NOT remove its source/target Nodes.

### 5.3 Query
```
Graph.getEdges(sourceID)        → Edge[]
Graph.getEdges(targetID)        → Edge[]
Graph.getEdges(type)            → Edge[]
Graph.getEdges(sourceID, type)  → Edge[]
```

---

## 6. Edge Invariants

### E-001 — Edges are typed
Every Edge MUST have a type. Unlabeled edges are FORBIDDEN.

### E-002 — Edges are directed
The Semantic Graph is a **directed** graph. Bidirectional relationships MUST be modeled as two edges.

### E-003 — Source and target MUST exist
Before creating an Edge, both source and target NodeIDs MUST exist in the Registry.

### E-004 — No orphan edges
If a Node is removed from the Registry, all Edges referencing it MUST also be removed.

### E-005 — Edge type MUST be registered
Every EdgeType must be declared either in CM-001 (core) or a Domain Pack (domain).

---

*End of Edge Model specification*