"""Compliance: Invariant #17 — Continuous Learning (CRITICAL: NOT IMPLEMENTED).
Invariant #18 — Reproducibility.
Invariant #19 — Auditability.
Invariant #20 — Open Standard.

Spec: Architecture Invariants (doc 163), doc 192.
"""

from compliance.conftest import has_module, get_core_module


def test_invariant_17_continuous_learning():
    """❗ Learning Engine MUST exist. (CRITICAL GAP — currently absent.)
    
    Spec: Invariant #17 — VCOS learns from past projects.
    Patterns → Knowledge Packs → better decisions.
    """
    has_learning = (
        has_module("~/VCOS/hermes/learning/__init__.py") or
        has_module("~/VCOS/hermes/learning/engine.py") or
        has_module("~/VCOS/hermes/learning/__init__.py")
    )
    assert has_learning, (
        "❌ INVARIANT #17 FAILED: Learning Engine not found.\n"
        "   Spec: Continuous Learning — VCOS improves from project history.\n"
        "   Status: CRITICAL GAP — NOT IMPLEMENTED.\n"
        "   Fix: Create learning/engine.py with LearningEngine.\n"
        "   (This test fails until Phase 5 of refactoring plan.)"
    )


def test_invariant_17b_memory_store_exists():
    """MemoryStore MUST exist (precursor to learning)."""
    assert has_module("~/VCOS/hermes/memory/memory.py"), (
        "❌ INVARIANT #17 FAILED: MemoryStore not found.\n"
        "   Spec: Learning requires memory of past projects.\n"
        "   Fix: Create memory/memory.py."
    )


def test_invariant_18_reproducibility():
    """Projects MUST be reproducible from snapshots."""
    assert has_module("~/VCOS/hermes/kernel/snapshot.py"), (
        "❌ INVARIANT #18 FAILED: No snapshot mechanism for reproducibility.\n"
        "   Spec: Every project state must be reproducible.\n"
        "   Fix: Create kernel/snapshot.py with SnapshotChain."
    )


def test_invariant_18b_versions_exist():
    """Core entities MUST have version tracking."""
    core = get_core_module()
    node = core.Node()
    assert hasattr(node, "created_at"), (
        "❌ INVARIANT #18 FAILED: Node has no created_at.\n"
        "   Spec: Every entity has version for reproducibility.\n"
        "   Fix: Add created_at to Node."
    )
    assert hasattr(node, "updated_at"), (
        "❌ INVARIANT #18 FAILED: Node has no updated_at.\n"
        "   Spec: Every entity has version for reproducibility.\n"
        "   Fix: Add updated_at to Node."
    )


def test_invariant_19_auditability():
    """Decision logs MUST persist for audit."""
    assert has_module("~/VCOS/hermes/kernel/decision_logger.py"), (
        "❌ INVARIANT #19 FAILED: No decision log for audit.\n"
        "   Spec: Every decision is logged for audit.\n"
        "   Fix: Create kernel/decision_logger.py."
    )


def test_invariant_19b_snapshots_provide_history():
    """Snapshots MUST provide project history."""
    try:
        from hermes.kernel.snapshot import SnapshotChain
        assert hasattr(SnapshotChain, "history") or \
               hasattr(SnapshotChain, "get_history"), (
            "❌ INVARIANT #19 FAILED: SnapshotChain has no history().\n"
            "   Spec: History of project states for audit trail.\n"
            "   Fix: Add history() to SnapshotChain."
        )
    except ImportError:
        assert False, "❌ INVARIANT #19 FAILED: SnapshotChain not importable."


def test_invariant_20_open_standard():
    """Standard documentation MUST exist as open specification."""
    assert has_module("~/VCOS/standard/000-foundation/Vision.md"), (
        "❌ INVARIANT #20 FAILED: Vision document missing.\n"
        "   Spec: VCOS is an open standard (doc 191).\n"
        "   Fix: Create standard/000-foundation/Vision.md."
    )
    assert has_module("~/VCOS/standard/000-foundation/Architecture-Invariants.md"), (
        "❌ INVARIANT #20 FAILED: Architecture Invariants document missing.\n"
        "   Spec: Open standard requires documented invariants.\n"
        "   Fix: Create Architecture-Invariants.md."
    )
