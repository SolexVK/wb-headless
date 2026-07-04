# CA-001 — Core Algebra v1.0

**Status:** Draft  
**Version:** 1.0.0  
**Author:** Chief Architect  
**Created:** 2026-07-01  
**Depends on:** [CO-001 — Core Ontology](../../100-core-ontology/CO-001/specification.md), [CM-001 — Canonical Model](../CM-001/specification.md)

---

## 1. Purpose

CA-001 defines the **valid operations** on the Canonical Model.

It answers only one question:

> **What operations can be performed on the Semantic Graph?**

It does **not** answer:
- *What exists?* — That is CO-001.
- *How is it stored?* — That is CM-001.
- *How do components interact?* — That is CP-001.

**CA-001 contains no entities. Only operations.**

---

## 2. Scope

CA-001 covers:

- Graph mutation operations (create, update, remove nodes and edges)
- Proposal operations (LLM proposes, Kernel decides)
- The fundamental `Decide` operation
- Structural operations (fork, merge, rollback)
- Analysis operations (validate, diff, trace)
- Compilation operations (compile blueprint to artifact)
- Algebraic laws (commutativity, associativity, idempotence)
- Invariants that operations must preserve

Out of scope:

- Specific Transformer implementations (defined in Hermes)
- Domain-specific operations (defined in Domain Packs)
- UI or API binding (defined in CP-001)

---

## 3. Definitions

| Term | Definition |
|------|-----------|
| **Algebra** | A set of operations closed over the Canonical Model |
| **Operation** | A function `f(Graph, params) → Graph` that transforms the Semantic Graph |
| **Proposal** | A suggested change to the graph proposed by LLM (or other source) |
| **Decision** | The result of a `Decide` operation — a recorded choice |
| **Snapshot** | A frozen, immutable copy of the graph state |
| **Changeset** | A set of deltas between two graph states |
| **Invariant** | A property that MUST hold after every operation |

---

## 4. Operation Categories

### 4.1 Overview

```
                      ┌──────────────────┐
                      │  Proposal Ops    │ ← LLM's interface to the system
                      │  (Propose)       │
                      └────────┬─────────┘
                               │
                      ┌────────▼─────────┐
                      │  Decision Ops    │ ← Kernel's authority
                      │  (Accept, Reject,│
                      │   Decide)        │
                      └────────┬─────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
   ┌──────▼──────┐   ┌────────▼───────┐   ┌───────▼───────┐
   │Mutation Ops │   │ Structural Ops │   │ Analysis Ops  │
   │(CreateNode, │   │(Fork, Merge,   │   │(Validate,     │
   │ UpdateNode, │   │ Rollback)      │   │ Diff, Trace)  │
   │ RemoveEdge) │   └────────────────┘   └───────┬───────┘
   └──────┬──────┘                                 │
          │                                 ┌──────▼───────┐
          │                                 │ Compilation  │
          └─────────────────────────────────┤ (Compile)    │
                                            └──────────────┘
```

### 4.2 Proposal Operations

These are operations that **suggest** changes to the graph. The primary producer is the LLM.

#### `Propose`

```
Propose(proposal: ProposalDescription, author: AgentID) → ProposalID
```

Proposes a set of new Nodes and Edges to be added to the graph. The proposal is **not applied** — it is queued for the Kernel to accept or reject.

A proposal contains:
- New Nodes (with type, properties)
- New Edges (with type, source, target, properties)
- Justification (textual explanation why this proposal should be accepted)

**Preconditions:**
- Proposal references only existing Node/Edge IDs for sources/targets
- Proposal does not suggest changes to existing Nodes (only new ones)

**Postconditions:**
- Proposal ID is created
- Proposal is recorded in the Decision Log (as candidate)
- Graph is NOT modified

#### `Revise`

```
Revise(proposalID: ProposalID, amendments: ProposalDescription) → ProposalID
```

Replaces a pending proposal with a revised version. The original proposal is marked as superseded.

---

### 4.3 Decision Operations

These operations represent the **Kernel's authority** to decide.

#### `Accept`

```
Accept(proposalID: ProposalID, rationale: string) → Changeset
```

The Kernel accepts a proposal. The proposed Nodes and Edges are created in the Registry, and the ProjectModel references are updated.

**Preconditions:**
- ProposalID is valid and pending
- All referenced Node/Edge IDs in the proposal exist in the Registry (if they're existing ones)
- After application, all graph invariants hold

**Postconditions:**
- New Nodes are created in the Registry
- New Edges are created in the Registry
- A new Snapshot is created
- The proposal is marked as accepted in the Decision Log
- A `Decision` record is created documenting the acceptance
- A `supports` Edge is created linking the Decision to the relevant Goal(s)

#### `Reject`

```
Reject(proposalID: ProposalID, reason: string) → void
```

The Kernel rejects a proposal. No changes to the graph.

**Postconditions:**
- The proposal is marked as rejected in the Decision Log
- The reason is recorded

#### `Decide`

```
Decide(
    context: { goals: GoalID[], facts: FactID[], constraints: ConstraintID[] },
    alternatives: Alternative[]
) → DecisionID
```

**This is the core cognitive operation.**

`Decide` records that a choice was made among alternatives. It is the operation that transforms multiple inputs (goals, facts, constraints) into a single, recorded decision.

**Key insight from Architecture Review:** Decision is NOT a data entity. Decision is an **operation** that produces a record.

A Decision record produced by `Decide` contains:
- What was decided (description)
- Which alternatives were considered
- Which Facts and Constraints influenced the decision
- Which Goal(s) this decision supports
- The rationale

**Preconditions:**
- At least one Goal ID is provided
- All referenced IDs exist in the Registry

**Postconditions:**
- A Decision record is created in the Registry as a Node of type `Decision`
- A `supports` Edge is created from the Decision to each Goal
- For each Fact/Constraint used: a `references` Edge is created
- A new Snapshot is created

---

### 4.4 Graph Mutation Operations

These operate **directly** on the Semantic Graph. They are the low-level building blocks.

#### `CreateNode`

```
CreateNode(type: NodeType, properties: Properties) → NodeID
```

Creates a new Node in the Registry.

**Preconditions:**
- `type` is registered in CO-001 or a loaded Domain Pack
- All required properties for the type are present (per Node Model)

**Postconditions:**
- A new Node exists in the Registry with state = Draft
- A new Snapshot is created
- The Node's `metadata.createdAt` and `metadata.version` are set

#### `CreateEdge`

```
CreateEdge(type: EdgeType, source: NodeID, target: NodeID, properties: Properties) → EdgeID
```

Creates a new Edge in the Registry.

**Preconditions:**
- `type` is registered (core or domain)
- `source` and `target` exist in the Registry
- source ≠ target (no self-loops)
- No duplicate edge with same type, source, target exists

**Postconditions:**
- A new Edge exists in the Registry
- A new Snapshot is created

#### `UpdateNode`

```
UpdateNode(id: NodeID, properties: Properties) → NodeID
```

Creates a new version of a Node (immutable model — does NOT modify in place).

**Preconditions:**
- Node exists in the Registry
- Node must not be in `Archived` state
- For Fact Nodes: Update is FORBIDDEN (Facts are immutable)

**Postconditions:**
- A new version of the Node exists (`version += 1`, `updatedAt = now`)
- The previous version is retained as part of the Snapshot chain
- A new Snapshot is created

#### `UpdateEdge`

Same contract as `UpdateNode` but for Edges.

#### `RemoveNode`

```
RemoveNode(id: NodeID) → void
```

Marks a Node as `Archived` and removes all associated Edges.

**Preconditions:**
- Node exists in the Registry
- No other Node has a hard reference (via Edge) that would become orphaned

**Postconditions:**
- Node state → Archived
- All Edges where this Node is source or target are removed
- A new Snapshot is created
- The removal is recorded in the Decision Log

#### `RemoveEdge`

```
RemoveEdge(id: EdgeID) → void
```

Removes an Edge.

**Preconditions:**
- Edge exists in the Registry

**Postconditions:**
- Edge is removed
- A new Snapshot is created

---

### 4.5 Structural Operations

#### `Fork`

```
Fork(projectModel: ProjectID, snapshotID: SnapshotID, name: string) → ProjectID
```

Creates a new ProjectModel as a branch from an existing Snapshot.

**Preconditions:**
- `snapshotID` exists in the source ProjectModel's Snapshot chain

**Postconditions:**
- A new ProjectModel is created with a new ProjectID
- The first Snapshot of the new ProjectModel is a copy of `snapshotID`
- Both ProjectModels share the same Registry (Nodes by ID)
- `metadata.parentProject` of the new ProjectModel references the source

#### `Merge`

```
Merge(
    targetProject: ProjectID,
    sourceProject: ProjectID,
    strategy: MergeStrategy
) → SnapshotID
```

Combines two branches into one. The source project's changes are merged into the target.

Merge strategies:
- `fast-forward` — source is ahead of target, simple advance
- `three-way` — both branches diverged, merge with common ancestor
- `overwrite` — source replaces target for conflicting nodes

**Preconditions:**
- Both ProjectModels exist and share the same Registry
- There is a common ancestor Snapshot in both chains

**Postconditions:**
- A new Snapshot is created on the target ProjectModel
- Conflicts are resolved per the chosen strategy
- A `merge` record is added to Snapshot metadata: `{ source: sourceProjectID, strategy }`

#### `Rollback`

```
Rollback(projectModel: ProjectID, snapshotID: SnapshotID) → SnapshotID
```

Reverts the project to a previous Snapshot.

**Important:** Rollback is an APPEND operation — it creates a new Snapshot with the state of the older one. History is NEVER deleted.

**Preconditions:**
- `snapshotID` exists in the ProjectModel's Snapshot chain

**Postconditions:**
- A new Snapshot is created containing the old state
- `ProjectModel.version` is incremented
- The Rollback is recorded in the Decision Log with a reference to `snapshotID`

---

### 4.6 Analysis Operations

#### `Validate`

```
Validate(graph: Graph) → Violation[]
```

Checks all graph invariants (G-001 to G-012 from CM-001.4) and returns a list of violations.

**Returns:**
```json
[
  {
    "invariant": "G-005",
    "message": "Decision #52 has no 'supports' edge to any Goal",
    "nodes": ["#52"],
    "severity": "error"
  }
]
```

**Properties:**
- Idempotent: `Validate(Validate(graph)) = Validate(graph)`
- Returns empty array for a valid graph

#### `Diff`

```
Diff(snapshotA: SnapshotID, snapshotB: SnapshotID) → Changeset
```

Computes the difference between two graph snapshots.

**Returns:**
```
Changeset {
    addedNodes:   Node[]
    removedNodes: NodeID[]
    modifiedNodes: NodeDiff[]
    addedEdges:   Edge[]
    removedEdges: EdgeID[]
    modifiedEdges: EdgeDiff[]
}
```

**Algebraic property:** `Diff(A, B) + Diff(B, C) = Diff(A, C)` (transitive over chain).

#### `Trace`

```
Trace(nodeID: NodeID, direction: "forward" | "backward") → Edge[]
```

Walks the provenance chain from a Node. Useful for:
- Explaining why a decision was made (backward)
- Finding all artifacts derived from a decision (forward)

---

### 4.7 Compilation Operation

#### `Compile`

```
Compile(blueprintID: BlueprintID, targetFormat: string, targetModel: string) → ArtifactID
```

Transforms a Blueprint into a rendered Artifact (prompt, image, JSON, etc.).

**Preconditions:**
- Blueprint exists and is in `Approved` state
- `targetFormat` is supported by at least one available Renderer

**Postconditions:**
- An Artifact Node is created in the Registry
- A `produces` Edge is created from the Artifact to the Blueprint
- The Artifact's `properties.generator` and `properties.params` are populated

---

### 4.8 Learning Operations

#### `Learn`

**Purpose:** Extract patterns from completed projects and store as Knowledge.

**Signature:** `Learn(project_id: UUID) -> Pattern[]`

**Algebraic properties:**
- **Not deterministic** — depends on project content
- **Not invertible** — cannot undo learning
- **Side-effect:** Creates new Knowledge in KnowledgeRegistry

**Algorithm:**
1. Collect all Decisions from completed project
2. Group by domain (category, generator, style)
3. For each group: count each Decision value, create Pattern if frequency >= 2
4. Store Patterns in KnowledgeRegistry
5. Return generated patterns

**Preconditions:**
- Project MUST be in COMPLETED status
- Project MUST have at least 3 Decisions

**Postconditions:**
- Each accepted Pattern is stored in KnowledgeRegistry
- Pattern includes: domain, field, recommended_value, confidence, evidence_count
- No changes to the original project graph

#### `Compare`

**Purpose:** Compare two snapshots or two projects structurally.

**Signature:** `Compare(id_a: UUID, id_b: UUID) -> ComparisonResult`

**Comparison dimensions:** Node/Edge count delta, Structural similarity, Decision overlap

**Implementation status:**
- ✅ Diff between snapshots (SnapshotManager.diff)
- ⏳ Cross-project comparison

---

## 5. Algebraic Laws

### 5.1 Commutativity

| Operations | Commute? | Note |
|-----------|----------|------|
| `CreateNode` + `CreateNode` | ✅ | Independent creates |
| `CreateNode` + `CreateEdge` | ❌ | Edge depends on source Node |
| `Accept(A)` + `Accept(B)` | ✅ | Independent proposals |
| `Validate` + any mutation | ❌ | Validate before mutation gives different result |

### 5.2 Associativity

| Operations | Associative? |
|-----------|-------------|
| `Merge(A, Merge(B, C))` = `Merge(Merge(A, B), C)` | ✅ |
| `CreateNode` + `CreateEdge` | ❌ (not a binary op) |

### 5.3 Idempotence

| Operation | Idempotent? |
|-----------|------------|
| `Validate(G)` | ✅ Yes |
| `Rollback(G, S)` | ❌ No — each call creates a new Snapshot |
| `Diff(A, B)` | ✅ Yes |

### 5.4 Identity Element

The **empty graph** (Registry with zero Nodes, zero Edges) is the identity element for:
- `Merge(empty, G) = G`
- `Merge(G, empty) = G`

---

## 6. Operation Invariants

### A-001 — Immutability
Every mutation operation MUST produce a new version. In-place modification is FORBIDDEN.

### A-002 — Invariant Preservation
Every operation MUST leave the graph in a valid state (all invariants from CM-001.4 satisfied).

### A-003 — Proposal Authority
Only the Kernel may call `Accept` or `Reject`. The LLM may only call `Propose`.

### A-004 — Decision Recording
Every `Decide` operation MUST be recorded in the Decision Log with: timestamp, author, inputs, alternatives, outcome.

### A-005 — Snapshot on Every Change
Every mutation, accept, decide, fork, merge, or rollback MUST create a new Snapshot.

### A-006 — No Cascading Removes
`RemoveNode` MUST NOT cascade-delete related Nodes. Only the direct Edges are removed.

### A-007 — Fact Immutability
Once created, a Fact Node MUST NOT be updated. `UpdateNode` on a Fact is FORBIDDEN.

---

## 7. Compliance

An implementation is CA-001 compliant if:

1. It implements all 15 operations defined in this specification
2. All mutation operations create new versions (immutable model)
3. The `Decide` operation records every decision in a Decision Log
4. The `Propose`/`Accept`/`Reject` cycle is strictly followed
5. Graph invariants are validated after every mutation
6. A Snapshot is created on every state change
7. Facts are protected from mutation

---

## 8. Change Policy

### Minor Version
Permitted:
- Clarification of operation semantics
- Addition of algebraic laws
- New analysis operations

### Major Version
Permitted:
- Changes to operation signatures
- Changes to invariants
- Addition or removal of core operations

Major version requires re-validation with CM-001 and CP-001.

---

*End of CA-001 Specification*