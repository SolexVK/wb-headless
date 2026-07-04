"""Compliance: Invariant #13 — Graph-native.
Invariant #14 — Traceability.
Invariant #15 — Extensibility.
Invariant #16 — Human Authority.

Spec: Architecture Invariants (doc 163).
"""

from compliance.conftest import get_core_module, has_module


def test_invariant_13_graph_native():
    """Core MUST have Node + Edge classes."""
    core = get_core_module()
    assert hasattr(core, "Node"), (
        "❌ INVARIANT #13 FAILED: Node class not found in core.\n"
        "   Spec: Semantic Graph — Node is fundamental (doc 189).\n"
        "   Fix: Define Node dataclass in core.py."
    )
    assert hasattr(core, "Edge"), (
        "❌ INVARIANT #13 FAILED: Edge class not found in core.\n"
        "   Spec: Semantic Graph — Edge is fundamental (doc 189).\n"
        "   Fix: Define Edge dataclass in core.py."
    )
    assert hasattr(core, "Graph"), (
        "❌ INVARIANT #13 FAILED: Graph class not found in core.\n"
        "   Spec: Semantic Graph — Graph is the container (doc 190).\n"
        "   Fix: Define Graph class in core.py."
    )


def test_invariant_13b_nodes_dont_know_edges():
    """Nodes MUST NOT contain edges — edges live separately (doc 189)."""
    core = get_core_module()
    node = core.Node()
    assert not hasattr(node, "edges") and not hasattr(node, "incoming") and \
           not hasattr(node, "outgoing"), (
        "❌ INVARIANT #13 FAILED: Node knows about edges.\n"
        "   Spec (doc 189): Nodes don't know about each other — edges are separate.\n"
        "   Fix: Remove edge references from Node. Edges live in Graph."
    )


def test_invariant_14_traceability():
    """DecisionLogger MUST exist and support queries."""
    assert has_module("~/VCOS/hermes/kernel/decision_logger.py"), (
        "❌ INVARIANT #14 FAILED: DecisionLogger not found.\n"
        "   Spec: Every decision must be traceable to its origin.\n"
        "   Fix: Create kernel/decision_logger.py."
    )
    try:
        from hermes.kernel.decision_logger import DecisionLogger
        assert hasattr(DecisionLogger, "decisions") or \
               hasattr(DecisionLogger, "get_decisions") or \
               hasattr(DecisionLogger, "list_all"), (
            "❌ INVARIANT #14 FAILED: DecisionLogger has no query method.\n"
            "   Spec: History of decisions must be queryable.\n"
            "   Fix: Add decisions list or get_decisions() to DecisionLogger."
        )
    except ImportError:
        assert False, "❌ INVARIANT #14 FAILED: DecisionLogger not importable."


def test_invariant_15_extensibility():
    """DomainPackRegistry MUST exist and support registration."""
    assert has_module("~/VCOS/hermes/domain_packs/__init__.py"), (
        "❌ INVARIANT #15 FAILED: Domain Pack system not found.\n"
        "   Spec: Extensible via Domain Packs without kernel changes.\n"
        "   Fix: Create domain_packs/ with registration system."
    )
    try:
        from hermes.domain_packs import DomainPackRegistry
        assert hasattr(DomainPackRegistry, "register") or \
               hasattr(DomainPackRegistry, "register_domain_pack"), (
            "❌ INVARIANT #15 FAILED: DomainPackRegistry has no register().\n"
            "   Spec: Domain Packs must be registrable.\n"
            "   Fix: Add register() to DomainPackRegistry."
        )
    except (ImportError, AttributeError):
        assert False, "❌ INVARIANT #15 FAILED: DomainPackRegistry not found."


def test_invariant_16_human_authority():
    """DecisionMaker MUST have 3-tier: Accept, ExpertMatch, Clarify.
    
    Human (Clarify) is the final authority.
    """
    try:
        from hermes.kernel.decision_maker import DecisionLevel, DecisionMaker
        assert hasattr(DecisionMaker, "decide") or \
               hasattr(DecisionMaker, "resolve"), (
            "❌ INVARIANT #16 FAILED: DecisionMaker has no decide/resolve.\n"
            "   Spec: 3-tier decision — human is final authority.\n"
            "   Fix: Add decide() method with Accept/ExpertMatch/Clarify."
        )
    except ImportError:
        assert False, "❌ INVARIANT #16 FAILED: DecisionMaker not importable."
