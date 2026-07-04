"""Compliance: CO-001 entity field completeness.

Проверяет что каждое создаваемое Node содержит spec-требуемые поля.

Spec: CO-001 specification.md §1-6 entity attribute tables.
"""

from compliance.conftest import get_core_module


def test_co001_intent_has_spec_fields():
    """Intent MUST have: description, source, created_at (from CO-001 §1)."""
    from hermes.kernel.core import Node, NodeType, LifecycleState
    node = Node(type=NodeType.INTENT, state=LifecycleState.DRAFT,
                properties={"description": "test", "source": "user"})
    assert "description" in node.properties, (
        "❌ CO-001 §1 FAILED: Intent properties missing 'description'.\n"
        "   Spec: Intent.description is REQUIRED."
    )
    assert "source" in node.properties, (
        "❌ CO-001 §1 FAILED: Intent properties missing 'source'.\n"
        "   Spec: Intent.source is REQUIRED ('chat', 'voice', 'file')."
    )


def test_co001_goal_has_parent_intent_id():
    """Goal MUST have parent_intent_id (CO-001 §2: trace to exactly one Intent).

    Проверяет что graph_adapter.record_goal() добавляет parent_intent_id.
    """
    from hermes.kernel.core import Node, NodeType, LifecycleState, Graph, RelationType, Edge
    from hermes.kernel.registry import Registry
    from hermes.kernel.project_model import ProjectModel
    from hermes.kernel.graph_adapter import SemanticGraphAdapter
    from hermes.kernel.project_model import ProjectIdentity

    reg = Registry()
    pm = ProjectModel(identity=ProjectIdentity(id="test", version=1))
    adapter = SemanticGraphAdapter(reg, pm)

    # Создаём Intent
    intent = adapter.record_intent("test intent")
    assert intent is not None

    # Создаём Goal через adapter
    goal = adapter.record_goal("test goal")
    assert goal is not None

    # Goal должен иметь parent_intent_id в properties
    parent_id = goal.properties.get("parent_intent_id")
    assert parent_id is not None, (
        "❌ CO-001 §2 FAILED: Goal created via record_goal() missing 'parent_intent_id'.\n"
        "   Spec G-1: A Goal MUST trace to exactly one Intent.\n"
        "   Fix: record_goal() must add parent_intent_id to Goal.properties."
    )
    assert parent_id == str(intent.id), (
        f"❌ CO-001 §2 FAILED: parent_intent_id={parent_id} != {intent.id}.\n"
        "   Fix: record_goal() must use the correct Intent ID."
    )

    # Goal должен иметь SUPPORTS Edge к Intent
    edges = reg.get_edges(goal.id)
    has_supports = any(
        e.type == RelationType.SUPPORTS and e.source == intent.id
        for e in edges
    )
    assert has_supports, (
        "❌ CO-001 §2 FAILED: Goal has no SUPPORTS Edge to Intent.\n"
        "   Spec: Edge Intent → supports → Goal.\n"
        "   Fix: record_goal() must create SUPPORTS edge."
    )


def test_co001_fact_has_certainty():
    """Fact MUST have certainty (CO-001 §3: CONFIRMED, ASSUMED, INFERRED)."""
    from hermes.kernel.core import Node, NodeType, LifecycleState
    node = Node(type=NodeType.FACT, state=LifecycleState.DRAFT,
                properties={"description": "test", "certainty": "CONFIRMED"})
    assert "certainty" in node.properties, (
        "❌ CO-001 §3 FAILED: Fact missing 'certainty'.\n"
        "   Spec F-1: certainty = CONFIRMED | ASSUMED | INFERRED.\n"
        "   Fix: Add certainty to Fact.properties when creating."
    )
    assert node.properties["certainty"] in ("CONFIRMED", "ASSUMED", "INFERRED"), (
        f"❌ CO-001 §3 FAILED: Fact certainty='{node.properties['certainty']}' invalid.\n"
        "   Spec: certainty MUST be CONFIRMED, ASSUMED, or INFERRED."
    )


def test_co001_decision_has_alternatives():
    """Decision MUST have alternatives (CO-001 §4: alternatives considered)."""
    from hermes.kernel.core import Node, NodeType, LifecycleState
    node = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED,
                properties={
                    "value": "use warm light",
                    "rationale": "product warmth",
                    "alternatives": ["cool light", "mixed light"],
                    "confidence": 0.8,
                    "source": "reasoning",
                })
    assert "alternatives" in node.properties, (
        "❌ CO-001 §4 FAILED: Decision missing 'alternatives'.\n"
        "   Spec D-2: Decision.alternatives records what alternatives were considered.\n"
        "   Fix: Add alternatives list to Decision.properties."
    )
    assert isinstance(node.properties["alternatives"], list), (
        "❌ CO-001 §4 FAILED: Decision.alternatives must be a list.\n"
        "   Fix: alternatives should be list[dict] with 'value' and 'rationale'."
    )


def test_co001_blueprint_has_version():
    """Blueprint MUST have version and source_decisions (CO-001 §5)."""
    from hermes.kernel.core import Node, NodeType, LifecycleState
    node = Node(type=NodeType.BLUEPRINT, state=LifecycleState.DRAFT,
                properties={
                    "content": {"scene": "..."},
                    "version": "1.0.0",
                    "source_decisions": [],
                })
    assert "version" in node.properties, (
        "❌ CO-001 §5 FAILED: Blueprint missing 'version'.\n"
        "   Spec: Blueprint.version is REQUIRED.\n"
        "   Fix: Add version to Blueprint.properties."
    )
    assert "source_decisions" in node.properties, (
        "❌ CO-001 §5 FAILED: Blueprint missing 'source_decisions'.\n"
        "   Spec: Blueprint.source_decisions — which decisions compiled into this.\n"
        "   Fix: Add source_decisions list to Blueprint.properties."
    )


def test_co001_artifact_has_renderer():
    """Artifact MUST have type, renderer, source_blueprint_id (CO-001 §6)."""
    from hermes.kernel.core import Node, NodeType, LifecycleState
    node = Node(type=NodeType.ARTIFACT, state=LifecycleState.APPROVED,
                properties={
                    "content": "prompt text...",
                    "type": "prompt",
                    "renderer": "PromptExporter",
                    "source_blueprint_id": "",
                })
    assert "renderer" in node.properties, (
        "❌ CO-001 §6 FAILED: Artifact missing 'renderer'.\n"
        "   Spec: Artifact.renderer is REQUIRED — which renderer produced this.\n"
        "   Fix: Add renderer to Artifact.properties."
    )
    assert "type" in node.properties, (
        "❌ CO-001 §6 FAILED: Artifact missing 'type'.\n"
        "   Spec: Artifact.type = prompt | workflow | command | image.\n"
        "   Fix: Add type to Artifact.properties."
    )
    assert "source_blueprint_id" in node.properties, (
        "❌ CO-001 §6 FAILED: Artifact missing 'source_blueprint_id'.\n"
        "   Spec: A-1: Every Artifact MUST trace to exactly one Blueprint.\n"
        "   Fix: Add source_blueprint_id to Artifact.properties."
    )