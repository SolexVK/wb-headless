"""Compliance: Invariant #2 — Single Source of Truth (CM-001 R-003).

Registry — SSOT. Все Nodes и Edges живут в Registry.
Graph — view-layer + validation над Registry.

CM-001 §5: Registry как единое плоское хранилище.
Обновлён под Phase 8: Registry._nodes/_edges = SSOT.
"""

from compliance.conftest import get_core_module


def test_invariant_02_single_source_of_truth():
    """Registry MUST be the SSOT — hold _nodes/_edges, Graph must read from it."""
    from hermes.kernel.registry import Registry

    # Registry must have _nodes and _edges
    reg = Registry()
    assert hasattr(reg, "_nodes"), (
        "❌ INVARIANT #2 FAILED: Registry has no _nodes.\n"
        "   Spec (CM-001 R-003): Registry is SSOT. Every object lives in Registry.\n"
        "   Fix: Registry must hold _nodes dict."
    )
    assert hasattr(reg, "_edges"), (
        "❌ INVARIANT #2 FAILED: Registry has no _edges.\n"
        "   Fix: Registry must hold _edges list."
    )

    # Graph must reference Registry, not hold its own storage
    core = get_core_module()
    graph = core.Graph

    # Check Graph can read from Registry
    g = graph()
    assert hasattr(g, "get_node"), (
        "❌ INVARIANT #2 FAILED: Graph has no get_node().\n"
        "   Spec: Graph reads from Registry, not own storage.\n"
        "   Fix: Graph delegates to Registry."
    )
    assert hasattr(g, "get_nodes"), (
        "❌ INVARIANT #2 FAILED: Graph has no get_nodes().\n"
        "   Fix: Graph must provide query interface over Registry."
    )
    assert hasattr(g, "get_edges"), (
        "❌ INVARIANT #2 FAILED: Graph has no get_edges().\n"
        "   Fix: Graph must provide edge query over Registry."
    )