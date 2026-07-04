# CM-001.8 — Persistence

**Part of:** [CM-001 — Canonical Model](specification.md)

---

## 1. Purpose

Persistence defines how the Canonical Model is stored, loaded, and transferred between systems.

This is a **logical** persistence model. It describes what needs to be stored, not how.

---

## 2. Storage Model

### 2.1 What Must Be Stored

| Component | Required | Notes |
|-----------|----------|-------|
| Registry (Nodes + Edges) | ✅ | All objects |
| ProjectModel (IDs + metadata) | ✅ | At least one per session |
| Snapshot chain | ✅ | Version history |
| Decision Log | ✅ | Every decision recorded |
| External References | ❌ | Optional, for export integration |

### 2.2 What May Be Derived

- Graph projections (views, filters) — computed from Registry
- Diff between snapshots — computed from snapshot chain
- Statistics (counts, sizes) — computed from Registry
- Search indexes — built from Registry

---

## 3. Serialization Format

### 3.1 Logical Structure

```
VCOSBundle {
    format:         "vcos-bundle-v1"
    registry:       Registry
    projectModel:   ProjectModel
    snapshots:      Snapshot[]
    decisionLog:    DecisionLog
    metadata:       BundleMetadata
}
```

### 3.2 Registry Serialization

```
Registry {
    nodes: {
        [nodeID]: Node          (complete node objects, keyed by ID)
    }
    edges: {
        [edgeID]: Edge          (complete edge objects, keyed by ID)
    }
}
```

### 3.3 ProjectModel Serialization

```
ProjectModel {
    identity: { id: ProjectID, version: int }
    source: SourceID[]
    intents: IntentID[]         (ordered — first is primary)
    goals: GoalID[]             (ordered by priority)
    constraints: ConstraintID[]
    facts: FactID[]
    decisions: DecisionID[]
    blueprints: BlueprintID[]
    artifacts: ArtifactID[]
    knowledge: KnowledgeID[]
    metadata: ProjectModelMetadata
    history: SnapshotID[]
}
```

### 3.4 Snapshot Serialization

```
Snapshot {
    id: SnapshotID
    parentID: SnapshotID | null
    registry: {
        nodes: [Node, Node, ...]      (complete node objects)
        edges: [Edge, Edge, ...]      (complete edge objects)
    }
    metadata: SnapshotMetadata
}
```

---

## 4. Storage Implementation (Informative)

The following are NOT part of CM-001 but are common implementation patterns:

### 4.1 JSON File Storage
- One file per snapshot: `vcos-{project-id}/snapshots/{snapshot-id}.json`
- Latest state: `vcos-{project-id}/state.json`
- Decision log: `vcos-{project-id}/decisions.ndjson`

### 4.2 Database Storage
- `nodes` table: id, type, state, properties (JSONB), metadata (JSONB)
- `edges` table: id, type, source, target, properties (JSONB), metadata (JSONB)
- `snapshots` table: id, parent_id, timestamp, registry_snapshot (JSONB)
- `project_models` table: id, version, references (JSONB), metadata (JSONB)

### 4.3 In-Memory Storage
- Registry: `dict[ObjectID, Node | Edge]`
- ProjectModel: lightweight struct with ID arrays
- Snapshots: kept in memory for current session, synced to disk on save

---

## 5. Import / Export

### 5.1 Export (Canonical → External)

```
ExportProcess:
  1. Resolve all IDs in ProjectModel
  2. Build flat object tree from graph (if target requires tree)
  3. Transform Node properties to target format (JSON Schema)
  4. Strip metadata (optional)
  5. Write to target (file, API, stream)
```

### 5.2 Import (External → Canonical)

```
ImportProcess:
  1. Parse external input
  2. Create Source object(s)
  3. Create Intent from Source (via LLM or rules)
  4. Register all objects in Registry
  5. Create ProjectModel with references
  6. Take initial Snapshot
```

---

## 6. Persistence Invariants

### P-001 — Save is Atomic
A save operation MUST either write the complete state or write nothing. Partial writes are FORBIDDEN.

### P-002 — Snapshots are WORM
Write Once, Read Many. Once a Snapshot is written to persistent storage, it MUST NOT be modified.

### P-003 — Load Returns Consistent State
Loading a ProjectModel MUST return a consistent state — all referenced IDs in the ProjectModel MUST resolve to existing objects in the loaded Registry.

### P-004 — Export is Lossy
Export to external formats MAY lose information (metadata, provenance, relationships). This is acceptable. The canonical state remains in the VCOS bundle.

### P-005 — Import is Lossy
Import from external sources MAY not capture all semantics. Post-import enrichment (via LLM or human) is expected.

---

*End of Persistence specification*