# CM-001.5 — Identity Model

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Identity Model defines how objects in the Canonical Model are identified, referenced, and resolved.

---

## 2. Identity Principle

**Identity is immutable and stable.**

Once assigned, an object's identity MUST NOT change for its entire lifetime — including across versions, branches, and exports.

---

## 3. ID Format

Every Node and Edge in the Canonical Model uses **UUID v7** (time-ordered UUID):

```
018f1234-5678-9abc-def0-123456789abc
```

### 3.1 Why UUID v7

| Requirement | UUID v4 | UUID v7 | Auto-increment |
|-------------|---------|---------|----------------|
| Globally unique | ✅ | ✅ | ❌ |
| Time-ordered | ❌ | ✅ | ✅ |
| No central coordinator | ✅ | ✅ | ❌ |
| Predictable sort order | ❌ | ✅ | ✅ |
| No sequential guessing | ✅ | ✅ | ❌ |

### 3.2 ID Prefix Convention (Informative)

For readability in debugging, IDs may include a type prefix:

```
Intent_018f1234-5678-9abc-def0-123456789abc
Decision_018f2345-6789-abcd-ef01-23456789abcd
```

The prefix is **informative only** — the canonical identity is the UUID alone.

---

## 4. Reference Model

All references between objects use **object IDs only**:

```
ProjectModel {
    goals: [GoalID, GoalID, ...]        // array of UUIDs
    decisions: [DecisionID, ...]
}
```

### 4.1 Reference Types

| Type | Format | Example |
|------|--------|---------|
| Single | UUID | `018f1234-5678-9abc-def0-123456789abc` |
| Collection | UUID[] | `[id1, id2, id3]` |
| Weak | UUID + type hint | `{ "id": "...", "type": "Goal" }` |

### 4.2 Reference Resolution

```
Registry.resolve(id: NodeID) → Node | null
Registry.resolve(id: EdgeID) → Edge | null
Registry.resolve(ids: NodeID[]) → Node[]
```

Resolution MUST be O(1) — the Registry is a hash map.

---

## 5. Identity Through Versions

When a Node is updated (immutable model → new version):

```
Node v1: id = 018f...abc
Node v2: id = 018f...abc        ← SAME ID
         version = 2             ← Different version number
```

**Identity survives versioning.** The `id` stays the same; `metadata.version` changes.

### 5.1 Branching

When a project is forked:

```
Node v1 (main):     id = 018f...abc, version = 1
Node v2 (branch):   id = 018f...abc, version = 2   ← same ID, different parent ProjectModel
```

Identity is **cross-branch stable**. The same logical node exists in both branches with the same ID.

---

## 6. External References

When exporting or referencing objects outside VCOS:

```
ExternalReference {
    vcosID:     NodeID          (the internal UUID)
    externalID: string          (the external identifier)
    system:     string          (e.g., "comfyui", "midjourney", "github")
    url:        string | null   (link to external resource)
}
```

### 6.1 External ID Mapping

```
ExternalRegistry {
    [vcosID]: [ExternalReference, ...]   (one node may exist in multiple systems)
    [externalID]: [vcosID, ...]          (reverse lookup)
}
```

---

## 7. Identity Invariants

### I-001 — ID Immutability
An object's ID MUST NOT change. Ever.

### I-002 — Global Uniqueness
No two objects in the same Registry may share an ID. This includes both Nodes and Edges (they share the same ID space).

### I-003 — Reference Integrity
Any stored ID MUST resolve to an existing object. Orphan references are FORBIDDEN.

### I-004 — Cross-Version Identity
When a Node is updated, the new version MUST retain the original `id`. Changing the `id` is equivalent to creating a new Node.

### I-005 — External ID Mapping
External IDs MUST be stored separately. The vcosID is the canonical identity; external IDs are metadata.

---

*End of Identity Model specification*