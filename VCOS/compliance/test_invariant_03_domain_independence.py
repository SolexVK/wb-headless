"""Compliance: Invariant #3 — Domain Independence (updated for CO-001 v6).

Spec: CO-001 specification.md (doc 180-181).
Core Ontology contains 6 core types + SOURCE + CONSTRAINT = 8 NodeTypes:
  SOURCE, INTENT, GOAL, CONSTRAINT, FACT (5 primitives)
  DECISION, BLUEPRINT, ARTIFACT (3 core types — CA-001 §4.3, CO-001 §5-6)

Domain types (CREATIVE_STRATEGY, NARRATIVE, VISUAL_LANGUAGE) → EXTRA_TYPES.
"""

from compliance.conftest import get_node_types, get_core_module


CORE_NODETYPES = {
    "SOURCE", "INTENT", "GOAL", "CONSTRAINT", "FACT",
    "DECISION", "BLUEPRINT", "ARTIFACT",
}
EXPECTED_COUNT = 8


def test_invariant_03_domain_independence():
    """NodeType MUST contain exactly 8 CO-001 types (5 primitives + 3 core)."""
    actual = get_node_types()

    # Check all core types present
    missing = CORE_NODETYPES - actual
    assert not missing, (
        "❌ INVARIANT #3 FAILED: Missing core NodeTypes.\n"
        f"   Missing: {sorted(missing)}\n"
        f"   Spec: NodeType MUST contain: {sorted(CORE_NODETYPES)}\n"
        "   Fix: Add missing types to NodeType enum in core.py."
    )

    # Check no Domain types in NodeType (they belong in EXTRA_TYPES)
    domain_types = {"CREATIVE_STRATEGY", "NARRATIVE", "VISUAL_LANGUAGE"}
    domain_found = domain_types & actual
    assert not domain_found, (
        "❌ INVARIANT #3 FAILED: Domain NodeTypes found in core.\n"
        f"   Found: {sorted(domain_found)}\n"
        "   Spec: Domain types MUST live in Domain Packs or EXTRA_TYPES.\n"
        "   Fix: Move CREATIVE_STRATEGY, NARRATIVE, VISUAL_LANGUAGE to EXTRA_TYPES."
    )

    # Check EXTRA_TYPES has domain types, not core types
    core = get_core_module()
    extras = core.EXTRA_TYPES if hasattr(core, "EXTRA_TYPES") else {}
    core_in_extras = {n for n in ("DECISION", "BLUEPRINT", "ARTIFACT") if n in extras}
    assert not core_in_extras, (
        "❌ INVARIANT #3 FAILED: Core types found in EXTRA_TYPES.\n"
        f"   Found: {sorted(core_in_extras)}\n"
        "   Spec: DECISION, BLUEPRINT, ARTIFACT are NodeType, not EXTRA.\n"
        "   Fix: Remove from EXTRA_TYPES (core.py maintains both)."
    )


def test_invariant_03b_core_size():
    """NodeType MUST have exactly 8 members."""
    actual = get_node_types()
    assert len(actual) == EXPECTED_COUNT, (
        "❌ INVARIANT #3 FAILED: NodeType count mismatch.\n"
        f"   Expected: {EXPECTED_COUNT} ({sorted(CORE_NODETYPES)})\n"
        f"   Actual:   {len(actual)} ({sorted(actual)})\n"
        "   Fix: Adjust NodeType to exactly 8 CO-001 types."
    )