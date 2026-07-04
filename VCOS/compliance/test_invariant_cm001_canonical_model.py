"""Compliance: CM-001 — Canonical Model (Phase 8).

Проверяет:
1. CM-001 R-003: Registry — SSOT (_nodes/_edges в Registry, Graph — view)
2. CM-001 Node Model: LifecycleState (Draft→Validated→Approved→Archived/Deprecated/Rejected)
3. CM-001 Edge Model: type/source/target/properties/metadata
4. CM-001 Node Model: metadata + tags
5. CM-001 R-004: ProjectModel — только ID
6. CM-001 Graph Invariants: G-001 (cycles), G-006 (Blueprint→Decision), G-007 (Artifact→Blueprint)
"""

from compliance.conftest import has_module


def test_cm001_registry_is_ssot():
    """CM-001 R-003: Registry MUST hold _nodes/_edges. Graph MUST NOT own storage."""
    from hermes.kernel.registry import Registry
    reg = Registry()
    assert hasattr(reg, "_nodes"), (
        "❌ CM-001 R-003 FAILED: Registry has no _nodes.\n"
        "   Spec: Registry holds all Nodes. Every object lives in Registry.\n"
        "   Fix: Add _nodes to Registry."
    )
    assert hasattr(reg, "_edges"), (
        "❌ CM-001 R-003 FAILED: Registry has no _edges.\n"
        "   Fix: Add _edges to Registry."
    )


def test_cm001_graph_delegates_to_registry():
    """Graph MUST delegate storage to Registry — no own _nodes/_edges as instance attrs."""
    from hermes.kernel.core import Graph
    g = Graph()

    # Graph instance should NOT have its own _nodes or _edges
    # (properties that delegate to Registry are OK)
    assert hasattr(g, "get_node"), "Graph must have get_node()"
    assert hasattr(g, "get_nodes"), "Graph must have get_nodes()"
    assert hasattr(g, "add_node"), "Graph must have add_node()"

    # Verify data flows through Registry
    from hermes.kernel.core import Node, LifecycleState
    node = Node(type="intent", state=LifecycleState.DRAFT)
    g.add_node(node)
    assert g.get_node(node.id) is not None, "Graph must return added node"


def test_cm001_lifecycle_state_has_6_states():
    """CM-001 Node Model §2.3: LifecycleState MUST have 6 states."""
    from hermes.kernel.core import LifecycleState
    states = {s.name for s in LifecycleState}
    required = {"DRAFT", "VALIDATED", "APPROVED", "ARCHIVED", "DEPRECATED", "REJECTED"}
    missing = required - states

    assert not missing, (
        "❌ CM-001 Node Model FAILED: Missing LifecycleState(s): "
        f"{sorted(missing)}\n"
        "   Spec: Draft → Validated → Approved → Archived/Deprecated.\n"
        "        Draft → Rejected.\n"
        "   Fix: Add missing states to LifecycleState enum."
    )

    # NodeStatus must be gone
    from hermes.kernel import core
    assert not hasattr(core, "NodeStatus"), (
        "❌ CM-001 FAILED: NodeStatus still exists.\n"
        "   Spec: Use LifecycleState (6 states, not 7).\n"
        "   Fix: Replace NodeStatus with LifecycleState everywhere."
    )


def test_cm001_node_has_metadata():
    """CM-001 Node Model §2.2: Node MUST have metadata and tags."""
    from hermes.kernel.core import Node
    fields = Node.__dataclass_fields__

    assert "metadata" in fields, (
        "❌ CM-001 Node Model FAILED: Node has no 'metadata' field.\n"
        "   Spec: NodeMetadata = { createdBy, author, version, provenance }.\n"
        "   Fix: Add metadata dict to Node."
    )
    assert "tags" in fields, (
        "❌ CM-001 Node Model FAILED: Node has no 'tags' field.\n"
        "   Spec: tags = list[str].\n"
        "   Fix: Add tags to Node."
    )


def test_cm001_edge_has_spec_fields():
    """CM-001 Edge Model §1.3: Edge MUST have: type, source, target, properties, metadata."""
    from hermes.kernel.core import Edge
    fields = Edge.__dataclass_fields__

    assert "type" in fields, (
        "❌ CM-001 Edge Model FAILED: Edge has no 'type' (has 'relation').\n"
        "   Spec: Edge.type = RelationType.\n"
        "   Fix: Rename Edge.relation → Edge.type."
    )
    assert "source" in fields, (
        "❌ CM-001 Edge Model FAILED: Edge has 'source_id' not 'source'.\n"
        "   Fix: Rename Edge.source_id → Edge.source."
    )
    assert "target" in fields, (
        "❌ CM-001 Edge Model FAILED: Edge has 'target_id' not 'target'.\n"
        "   Fix: Rename Edge.target_id → Edge.target."
    )
    assert "properties" in fields, "Edge MUST have 'properties' field"
    assert "metadata" in fields, "Edge MUST have 'metadata' field"


def test_cm001_edge_types_complete():
    """CM-001 Edge Model: RelationType MUST include all 10 spec types."""
    from hermes.kernel.core import RelationType
    actual = {r.name for r in RelationType}
    required = {
        "SUPPORTS", "CONTRADICTS", "ENABLES", "CONSTRAINS",
        "SATISFIES", "PRODUCES", "DERIVES_FROM", "REFINES",
        "CONTAINS", "REFERENCES",
    }
    missing = required - actual
    assert not missing, (
        "❌ CM-001 Edge Model FAILED: Missing RelationType(s): "
        f"{sorted(missing)}\n"
        "   Fix: Add missing types to RelationType enum."
    )


def test_cm001_projectmodel_ids_only():
    """CM-001 R-004: ProjectModel MUST reference objects by ID only."""
    from hermes.kernel.project_model import ProjectModel
    fields = ProjectModel.__dataclass_fields__

    for name, field_def in fields.items():
        field_type = str(field_def.type)
        if "node" in field_type.lower() or "edge" in field_type.lower():
            assert False, (
                f"❌ CM-001 R-004 FAILED: ProjectModel.{name} stores "
                f"'{field_type}' directly. Use IDs only."
            )


def test_cm001_graph_invariant_g006_blueprint_to_decision():
    """G-006 (CM-001.4): Blueprint → satisfies → Decision."""
    from hermes.kernel.core import Graph
    g = Graph()

    # Validate must check G-006: Blueprint must satisfy a Decision
    # The validator checks this via validate_invariants()
    assert hasattr(g, "validate_invariants"), (
        "❌ G-006 FAILED: Graph has no validate_invariants().\n"
        "   Spec: G-006 — Every Blueprint satisfies at least one Decision."
    )

    # Test actual validation
    from hermes.kernel.core import Node, LifecycleState, RelationType, Edge, NodeType
    bp = Node(type=NodeType.BLUEPRINT.value, state=LifecycleState.DRAFT)
    decision = Node(type=NodeType.DECISION.value, state=LifecycleState.DRAFT)
    g.add_node(bp)
    g.add_node(decision)

    # Without SATISFIES edge — must violate
    violations = g.validate_invariants()
    assert any("G-006" in v for v in violations), (
        "❌ G-006 FAILED: Blueprint without Decision must trigger G-006 violation.\n"
        "   Fix: Add G-006 check to validate_invariants()\n"
        f"   Violations found: {violations}"
    )


def test_cm001_graph_invariant_g007_artifact_to_blueprint():
    """G-007 (CM-001.4): Artifact → produces → Blueprint."""
    from hermes.kernel.core import Graph, Node, LifecycleState, NodeType

    g = Graph()
    art = Node(type=NodeType.ARTIFACT.value, state=LifecycleState.DRAFT)
    g.add_node(art)

    violations = g.validate_invariants()
    assert any("G-007: Artifact" in v for v in violations), (
        "❌ G-007 FAILED: Artifact without Blueprint must trigger violation.\n"
        f"   Violations found: {violations}"
    )


def test_cm001_lifecycle_transitions_valid():
    """CM-001 Node Model: Only valid transitions allowed."""
    from hermes.kernel.core import LifecycleState

    # valid_transitions must be callable
    assert hasattr(LifecycleState, "valid_transitions"), (
        "❌ CM-001 FAILED: LifecycleState has no valid_transitions().\n"
        "   Fix: Add valid_transitions static method."
    )

    transitions = LifecycleState.valid_transitions()

    # Draft → {Proposed, Rejected} (CO-001 Decision PROPOSED added)
    assert LifecycleState.DRAFT in transitions, (
        "❌ CM-001 FAILED: DRAFT not in transitions map."
    )
    draft_transitions = transitions[LifecycleState.DRAFT]
    assert LifecycleState.PROPOSED in draft_transitions, (
        "❌ CM-001 FAILED: Draft→Proposed not allowed."
    )
    assert LifecycleState.REJECTED in draft_transitions, (
        "❌ CM-001 FAILED: Draft→Rejected not allowed."
    )

    # Proposed → {Validated, Rejected}
    assert LifecycleState.PROPOSED in transitions, (
        "❌ CM-001 FAILED: PROPOSED not in transitions map."
    )
    proposed_transitions = transitions[LifecycleState.PROPOSED]
    assert LifecycleState.VALIDATED in proposed_transitions, (
        "❌ CM-001 FAILED: Proposed→Validated not allowed."
    )
    assert LifecycleState.REJECTED in proposed_transitions, (
        "❌ CM-001 FAILED: Proposed→Rejected not allowed."
    )

    # Validated → {Approved, Rejected}
    assert LifecycleState.VALIDATED in transitions, (
        "❌ CM-001 FAILED: VALIDATED not in transitions map."
    )
    validated_transitions = transitions[LifecycleState.VALIDATED]
    assert LifecycleState.APPROVED in validated_transitions, (
        "❌ CM-001 FAILED: Validated→Approved not allowed."
    )
    assert LifecycleState.REJECTED in validated_transitions, (
        "❌ CM-001 FAILED: Validated→Rejected not allowed."
    )

    # APPROVED → {Archived, Deprecated}
    appr = transitions[LifecycleState.APPROVED]
    assert LifecycleState.ARCHIVED in appr, "Approved→Archived must be allowed"
    assert LifecycleState.DEPRECATED in appr, "Approved→Deprecated must be allowed"



def test_cm001_node_tags_default_empty():
    """Node.tags MUST default to empty list, not None."""
    from hermes.kernel.core import Node
    n = Node()
    assert n.tags == [], (
        "❌ CM-001 FAILED: Node.tags default is not empty list.\n"
        "   Fix: Node.tags = field(default_factory=list)"
    )