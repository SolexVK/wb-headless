# CM-001.4 — Graph Invariants

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Graph Invariants define the rules that the Semantic Graph MUST satisfy at all times. These are **invariant constraints**: if any invariant is violated, the graph is in an invalid state.

---

## 2. Structural Invariants

### G-001 — No Cycles in Decision Chain
Decisions form a directed acyclic graph (DAG) with respect to `derives_from`. A Decision MUST NOT indirectly derive from itself.

**Why:** Ensures decisions form a well-founded hierarchy.

### G-002 — Every Node Reachable
Every Node in the Registry MUST be reachable from at least one ProjectModel in the current session.

**Why:** Prevents orphan nodes that consume memory without serving any project.

### G-003 — Graph is Connected
The Semantic Graph of a ProjectModel MUST be a weakly connected graph.

**Why:** A disconnected subgraph indicates orphaned data.

### G-004 — Single Root per Project
Each ProjectModel MUST have exactly one Intent that is the root of the graph (no incoming `derives_from` edges).

**Why:** The design process starts from a single interpreted intent.

---

## 3. Semantic Invariants

### G-005 — Decision MUST Support Goal
For every Decision in a ProjectModel, there MUST be at least one `supports` edge to a Goal in the same ProjectModel.

**Why:** A decision that supports no goal is wasted effort.

### G-006 — Blueprint MUST Satisfy Decision
For every Blueprint in a ProjectModel, there MUST be at least one `satisfies` edge to a Decision approved in the same ProjectModel.

**Why:** A blueprint that implements no decision is architecturally orphaned.

### G-007 — Artifact MUST Derive from Blueprint
For every Artifact in a ProjectModel, there MUST be a `produces` or `derives_from` edge from a Blueprint.

**Why:** Every output must trace back to a design specification.

### G-008 — Facts are Immutable
Once a Fact Node is created, its properties MUST NOT change. A new Fact may supersede it via `deprecates` edge.

**Why:** Facts represent truths — changing them corrupts the reasoning history.

---

## 4. Cross-Component Invariants

### G-009 — Source → Intent → Goal Chain
The path `Source → derives_from → Intent → refines → Goal` MUST NOT have gaps. A Goal MUST trace back to a Source through exactly one Intent.

### G-010 — No Duplicate Identity
No two Nodes in the same Registry may have the same `id`. No two Edges may have the same `id`.

### G-011 — Version Monotonicity
For any Node, `version` in metadata MUST increase monotonically. Versions MUST NOT be skipped or reset.

---

## 5. Domain Invariants

### G-012 — Domain Pack Isolation
Nodes and Edges from different Domain Packs MUST NOT create semantic edges that violate the Domain Pack's own invariants.

Example: A Film `CameraMove` Node MUST NOT link to a `ProductCategory` Node unless both Domain Packs explicitly declare compatibility.

---

## 6. Enforcement

Invariants are enforced at two levels:

| Level | Enforcer | When |
|-------|----------|------|
| **Soft** | Kernel.validate() | Before accepting LLM proposals |
| **Hard** | Registry.commit() | Before writing a new version |

If an invariant is violated:
- **Soft:** The proposal is rejected with a reason. The LLM may retry.
- **Hard:** The commit is rolled back. The version is NOT created.

---

## 7. Invariant Violation Log

Every invariant violation MUST be recorded:

```
ViolationLog {
    timestamp:    Timestamp
    invariant:    Reference (e.g., "G-005")
    nodes:        NodeID[]
    edges:        EdgeID[]
    message:      string
    resolution:   "rejected" | "auto-fixed" | "manual-override"
    author:       AgentID
}
```

---

*End of Graph Invariants specification*