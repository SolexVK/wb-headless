"""Compliance: CO-001 §0 — Core Ontology: 6 entity types.
CO-001 requires: Intent, Goal, Fact, Decision, Blueprint, Artifact.

I-010 — Primitive Minimalism:
  Decision, Blueprint, Artifact — НЕ domain-specific.
  Это когнитивные фундаментальные типы: decision-driven state,
  blueprint как результат проектирования, artifact как результат компиляции.

Spec: CO-001 specification.md (6 types), CA-001 §4.3 (Decision as NodeType).
"""

from compliance.conftest import get_core_module, get_node_types


def test_co001_six_core_types_exist():
    """CO-001 §0: NodeType MUST have 6 core types: Intent, Goal, Fact, Decision, Blueprint, Artifact."""
    types = get_node_types()
    required = {"INTENT", "GOAL", "FACT", "DECISION", "BLUEPRINT", "ARTIFACT"}
    missing = required - types

    assert not missing, (
        f"❌ CO-001 FAILED: Missing NodeType(s): {missing}\n"
        "   Spec: 6 core entity types — Intent, Goal, Fact, Decision, Blueprint, Artifact.\n"
        "   Current: {}\n"
        "   Fix: Add missing types to NodeType enum in core.py.".format(types)
    )


def test_co001_no_extra_types_missing():
    """CO-001 §0: SOURCE and CONSTRAINT are also valid (from CM-001)."""
    types = get_node_types()
    assert "SOURCE" in types, "SOURCE must be in NodeType (CM-001 §6.3)"
    assert "CONSTRAINT" in types, "CONSTRAINT must be in NodeType (CO-001)"


def test_co001_decision_is_node_type_not_extra():
    """Decision MUST be NodeType, not in EXTRA_TYPES (CA-001 §4.3)."""
    core = get_core_module()
    has_extra_types = hasattr(core, "EXTRA_TYPES")
    if has_extra_types:
        extras = core.EXTRA_TYPES
        msg = []
        for name in ("DECISION", "BLUEPRINT", "ARTIFACT"):
            if name in extras:
                msg.append(f"  ❌ {name} is in EXTRA_TYPES, should be NodeType")
        assert not msg, (
            "❌ CO-001 FAILED: Core types in EXTRA_TYPES.\n" +
            "\n".join(msg) +
            "\n   Spec: CO-001 defines 6 core types as NodeType.\n"
            "   Fix: Move from EXTRA_TYPES to NodeType enum."
        )


def test_co001_blueprint_has_required_attrs():
    """Blueprint (CO-001 §5) MUST have: content, version, source_decisions, status."""
    core = get_core_module()
    assert hasattr(core, "NodeType")
    assert core.NodeType.BLUEPRINT.value == "blueprint", (
        "❌ CO-001 FAILED: NodeType.BLUEPRINT.value must be 'blueprint'.\n"
        "   Spec: Blueprint is a core entity type with value 'blueprint'."
    )


def test_co001_artifact_has_required_attrs():
    """Artifact (CO-001 §6) MUST have: type, content, renderer, source_blueprint_id."""
    core = get_core_module()
    assert hasattr(core, "NodeType")
    assert core.NodeType.ARTIFACT.value == "artifact", (
        "❌ CO-001 FAILED: NodeType.ARTIFACT.value must be 'artifact'.\n"
        "   Spec: Artifact is a core entity type with value 'artifact'."
    )