"""Compliance: Invariant #10 — Incremental Design.
Invariant #11 — Explicit Uncertainty.
Invariant #12 — Questions Optimized.

Spec: Architecture Invariants (doc 163).
"""

from compliance.conftest import has_module


def test_invariant_10_incremental_design():
    """Snapshots MUST exist for incremental design."""
    assert has_module("~/VCOS/hermes/kernel/snapshot.py"), (
        "❌ INVARIANT #10 FAILED: No snapshot mechanism.\n"
        "   Spec: Design is incremental — every state is savable.\n"
        "   Fix: Create kernel/snapshot.py."
    )


def test_invariant_10b_snapshot_chain_supports_rollback():
    """SnapshotChain MUST support rollback."""
    try:
        from hermes.kernel.snapshot import Snapshot, SnapshotChain
        assert hasattr(SnapshotChain, "rollback") or hasattr(SnapshotChain, "revert"), (
            "❌ INVARIANT #10 FAILED: SnapshotChain has no rollback.\n"
            "   Spec: Design is incremental — rollback must be supported.\n"
            "   Fix: Add rollback() method to SnapshotChain."
        )
    except ImportError:
        assert False, "❌ INVARIANT #10 FAILED: SnapshotChain not importable."


def test_invariant_11_explicit_uncertainty():
    """ConfidenceEvaluator MUST provide uncertainty scoring."""
    try:
        from hermes.design.confidence import ConfidenceEvaluator
        has_method = (
            hasattr(ConfidenceEvaluator, "evaluate") or
            hasattr(ConfidenceEvaluator, "score") or
            hasattr(ConfidenceEvaluator, "overall_confidence") or
            hasattr(ConfidenceEvaluator, "overall")
        )
        assert has_method, (
            "❌ INVARIANT #11 FAILED: ConfidenceEvaluator has no scoring method.\n"
            f"   Found methods: evaluate={hasattr(ConfidenceEvaluator,'evaluate')}, "
            f"score={hasattr(ConfidenceEvaluator,'score')}, "
            f"overall_confidence={hasattr(ConfidenceEvaluator,'overall_confidence')}\n"
            "   Spec: Every inference has explicit confidence score.\n"
            "   Fix: Add evaluate() or overall_confidence() to ConfidenceEvaluator."
        )
    except ImportError:
        assert False, "❌ INVARIANT #11 FAILED: ConfidenceEvaluator not importable from hermes.design.confidence."


def test_invariant_12_questions_optimized():
    """SceneDiscoveryEngine MUST exist for uncertainty reduction."""
    assert has_module("~/VCOS/hermes/sde/scene_discovery.py"), (
        "❌ INVARIANT #12 FAILED: SceneDiscoveryEngine not found.\n"
        "   Spec: Questions are optimized to reduce uncertainty, not fill forms.\n"
        "   Fix: Create sde/scene_discovery.py."
    )
