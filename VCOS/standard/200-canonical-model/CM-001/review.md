# CM-001 — Architecture Review

**Author:** Chief Architect  
**Date:** 2026-06-29

---

## 1. Purpose of this Review

To validate that CM-001:
- Correctly represents CO-001 entities as data
- Provides a stable foundation for Hermes implementation
- Does not introduce accidental complexity
- Aligns with the four Standard documents architecture

---

## 2. Key Decisions Validated

| Decision | Status | Comment |
|----------|--------|---------|
| Semantic Graph as Canonical Model | ✅ Accepted | Nodes + Edges + Graph, not tree |
| Registry + ProjectModel separation | ✅ Accepted | Existence vs organization |
| Immutable Model | ✅ Accepted | Every change is a new version |
| LLM Proposes → Kernel Decides | ✅ Accepted | Clear separation of concerns |
| All objects share base contract | ✅ Accepted | id, type, properties, metadata |
| ID-only references | ✅ Accepted | No nesting, no embedding |
| Source as CM entity (not CO) | ✅ Accepted | Infrastructure, not ontology |

---

## 3. Open Questions (pre-implementation)

### Q-001: Goal as Derived Entity

During CO-001 review, it was noted that Goal may be a derived view of Intent + Constraints + Facts, not a separate entity.

**Decision for v1.0:** Keep Goal as a separate Node type. Re-evaluate after first implementation cycle.

### Q-002: Blueprint Scope

Blueprint may be too broad. In CM-001, Blueprint is defined as: "a complete design specification ready for rendering."

**Risk:** May become a "container for everything."

**Mitigation:** Domain Packs will define Blueprint structure per domain. Core Blueprint only holds the minimum: description, specs, model type, format.

### Q-003: Snapshot Storage Performance

Full snapshots (not diffs) are simple but may be expensive for large graphs.

**Mitigation:** Storage optimization (compression, dedup) is delegated to the implementation layer. The model does not mandate how snapshots are stored, only that they exist.

---

## 4. Potential Risks

### R-001 — Graph Complexity
Teams unfamiliar with graph models may struggle with the Node/Edge abstraction.

**Mitigation:** ProjectModel provides a familiar "project view" as a projection. Most developers will work with ProjectModel, not raw graph.

### R-002 — Performance of Full Snapshots
For projects with 1000+ nodes, full snapshots on every change may be expensive.

**Mitigation:** Not a model issue — implementation may use incremental snapshots with a full-snapshot merge strategy.

### R-003 — ID Collision in Distributed Environments
Multiple Hermes instances may generate colliding UUIDs.

**Mitigation:** UUID v7 with 122 bits of randomness makes collision probability negligible (< 10^-18). For multi-instance, encode instance ID into the UUID.

---

## 5. Alignment Check

### With CO-001
✅ All 7 core entities (Intent, Goal, Constraint, Fact, Decision, Blueprint, Artifact) are representable as Node types.
✅ Entity relationships are representable as Edge types.
✅ Lifecycle from CO-001 maps to Node state.

### With CA-001 (planned)
❓ CM-001 defines data structures. CA-001 will define operations (create, merge, validate, compile, fork, rollback). Must be aligned before implementation.

### With CP-001 (planned)
❓ CM-001 defines what is stored. CP-001 will define how Transformers interact with the model. Must be aligned.

---

## 6. Verification

CM-001 passes the **three checks** from the original architecture:

| Check | Result |
|-------|--------|
| Can I re-create Hermes from this document? | ✅ Yes |
| Can I test compliance without running the full system? | ✅ Yes (test fixtures with Registry + Nodes + Edges) |
| Can I add a new entity type without changing the kernel? | ✅ Yes (new Node type = Domain Pack) |

---

*End of Review*