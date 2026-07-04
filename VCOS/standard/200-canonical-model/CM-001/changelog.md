# CM-001 — Changelog

**All notable changes to CM-001.**

---

## [1.0.0] — 2026-06-29

### Added
- **specification.md** — Complete CM-001 specification:
  - Canonical Model defined as Semantic Graph (Nodes + Edges)
  - Registry + ProjectModel architecture
  - Immutable Model principle
  - LLM Proposes → Kernel Decides pattern
  - Source entity definition
  - 9 normative requirements (R-001 to R-009)
  - Compliance criteria

- **node-model.md** — Node Model:
  - Base contract: id, type, state, properties, metadata, tags
  - Lifecycle states: Draft → Validated → Approved → Deprecated/Archived
  - All 8 core Node types from CO-001 (Intent, Goal, Constraint, Fact, Decision, Blueprint, Artifact, Knowledge)
  - Domain Node type extension mechanism
  - 5 Node invariants (N-001 to N-005)
  - Creation rules table

- **edge-model.md** — Edge Model:
  - Base contract: id, type, source, target, properties, metadata
  - 3 categories of core edges: structural, relational, domain
  - 8 core edge types with source/target constraints
  - Edge operations: Create, Remove, Query
  - 5 Edge invariants (E-001 to E-005)

- **graph-invariants.md** — Graph Invariants:
  - 5 structural invariants (G-001 to G-004)
  - 5 semantic invariants (G-005 to G-009)
  - 3 cross-component invariants (G-010 to G-011)
  - Domain isolation invariant (G-012)
  - Soft vs Hard enforcement levels
  - Violation logging specification

- **identity.md** — Identity Model:
  - UUID v7 as universal ID format
  - Reference model (ID-only references)
  - Cross-version identity stability
  - External reference mapping
  - 5 identity invariants (I-001 to I-005)

- **versioning.md** — Versioning:
  - Object-level version counters
  - Snapshot-based graph versioning
  - Snapshot chain (linear within ProjectModel)
  - Branching via ProjectModel fork
  - Merge with provenance record
  - Rollback as append operation
  - 5 versioning invariants (V-001 to V-005)

- **metadata.md** — Metadata Model:
  - Universal metadata (createdAt, updatedAt, author, provenance, version)
  - AgentID specification
  - Provenance chain (tracible to source)
  - Classification tags (informative only)
  - 5 metadata invariants (M-001 to M-005)

- **persistence.md** — Persistence:
  - Logical storage model
  - Serialization format (VCOSBundle)
  - Registry/ProjectModel/Snapshot serialization
  - Implementation patterns (JSON file, DB, in-memory)
  - Import/Export process
  - 5 persistence invariants (P-001 to P-005)

- **examples.md** — Full working examples:
  - Minimal project: "Porsche Pixar"
  - Graph traversal query
  - Snapshot evolution
  - Branching scenario
  - Domain Pack extension

- **review.md** — Architecture review:
  - Key decisions validated
  - 3 open questions for implementation
  - 3 potential risks with mitigations
  - Alignment checks with CO-001, CA-001, CP-001
  - Three checks verification

---

*End of Changelog*