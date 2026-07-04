# CM-001.6 — Versioning

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Versioning defines how the Canonical Model evolves over time. The fundamental rule:

> **The Canonical Model is immutable. Every change creates a new version.**

---

## 2. Versioning Model

### 2.1 Object Versioning

Each Node and Edge carries a version counter:

```
Node {
    id: NodeID
    version: 1              ← starts at 1
    
    metadata: {
        createdAt:  T1
        updatedAt:  T1      ← same as createdAt for v1
        version:    1
    }
}
```

On each change:

```
Node v1: version = 1, updatedAt = T1
Node v2: version = 2, updatedAt = T2  ← ObjectVersionID
```

**The previous version is NOT destroyed** — it is retained as a snapshot.

### 2.2 Graph Versioning

The full Semantic Graph state at a point in time is a **Snapshot**:

```
Snapshot {
    id:         SnapshotID (UUID v7)
    parentID:   SnapshotID | null    (previous snapshot — forms a chain)
    nodes:      Map<NodeID, Node>    (all nodes at this point)
    edges:      Map<EdgeID, Edge>    (all edges at this point)
    metadata:   SnapshotMetadata
}
```

### 2.3 ProjectModel Versioning

Each ProjectModel has its own version sequence:

```
ProjectModel {
    identity: {
        id:        ProjectID
        version:   3                ← project version
    }
    history: [SnapshotID, ...]       ← ordered list of snapshots
}
```

---

## 3. Snapshot Chain

```
ProjectModel v1 (Snapshot A)
    │
    ▼
ProjectModel v2 (Snapshot B) ← parent = A
    │
    ▼
ProjectModel v3 (Snapshot C) ← parent = B
```

### 3.1 Snapshot Rules

1. Snapshots form a **linear chain** (no branches within a single ProjectModel).
2. Branching is done by **forking** into a new ProjectModel.
3. Each Snapshot captures the **complete state** — not a diff.
4. Snapshots are immutable once created.

### 3.2 Why Full Snapshots (Not Diffs)

| Aspect | Full Snapshot | Diff |
|--------|--------------|------|
| Read performance | ✅ O(1) | ❌ O(n) |
| Write performance | ❌ O(all objects) | ✅ O(changes) |
| Branching | ✅ Trivial | ❌ Complex |
| Distribution | ✅ Self-contained | ❌ Needs chain |
| Debugging | ✅ Easy | ❌ Hard |

Full snapshots + storage optimization (compression, dedup) is preferred.

---

## 4. Branching

Branching creates a new ProjectModel from an existing Snapshot:

```
Main ProjectModel (Snapshots A → B → C)
                              │
                              ▼
Forked ProjectModel (Snapshot B' → C' → D')
```

### 4.1 Fork Rules

1. The fork starts from **any Snapshot** in the parent ProjectModel.
2. The new ProjectModel gets a new `ProjectID`.
3. The first Snapshot of the fork is a **copy** of the parent Snapshot (same NodeIDs, new SnapshotID).
4. Both ProjectModels share the **same Registry** — Nodes are shared by ID.
5. Changes in one branch do NOT affect the other (until merge).

### 4.2 Merge

Merge combines two branches:

```
Main: A → B → C → D
                    ↑
Fork: A → B' → C' ─┘
```

Merge creates a new Snapshot (D) that includes:
- All Nodes from both branches (by ID — duplicates merge by rules)
- All Edges from both branches
- A `merge` record in metadata: `{ source: ForkID, snapshot: SnapshotID }`

---

## 5. Rollback

Rollback to a previous Snapshot:

```
Current: A → B → C → D (rollback to B)
                    ↓
Result:  A → B → B (new Snapshot with state of B, version of D+1)
```

Rollback does NOT delete history. It creates a new Snapshot with the state of an older version.

---

## 6. Versioning Invariants

### V-001 — Monotonic Version
Node, Edge, and ProjectModel versions MUST increase monotonically. No skipping, no resetting.

### V-002 — Snapshot Chain is Linear
A single ProjectModel's Snapshot chain MUST be linear — no branches, no cycles.

### V-003 — Snapshots are Immutable
Once created, a Snapshot MUST NOT be modified. Any change creates a new Snapshot.

### V-004 — Identity Across Versions
A Node's `id` is the same across all its versions. Version is distinct from identity.

### V-005 — Rollback is Append
Rollback creates a new Snapshot; it does NOT delete existing ones.

---

## 7. Storage Considerations (Informative)

- Snapshots may be **compressed** (gzip, zstd) for storage.
- Snapshots may be **lazy-loaded** (only the latest Snapshot kept in memory).
- Old snapshots may be **archived** to slower storage.
- Snapshot deduplication may be applied at the storage layer (not at the model layer).

---

*End of Versioning specification*