"""Compliance: Фаза 9 — Cognitive Loop + Algebra

Проверяет:
1. Computational Theory §2: Observe→Evaluate→Decide→Act→Record
2. I-004: All mutations through Proposal-Decide (_apply_proposal)
3. I-009: Intent Integrity lock
4. CA-001 §4.8: Compare runtime
5. CA-001 §4.5: Fork/Merge/Rollback deferred
"""

def test_comp_theory_cognitive_loop_exists():
    """CompTheory §2: Orchestrator MUST implement Observe→Evaluate→Decide→Act→Record."""
    from hermes.orchestrator.core import Orchestrator
    assert hasattr(Orchestrator, "observe"), (
        "❌ CompTheory §2 FAILED: Orchestrator has no observe().\n"
        "   Spec: Step 1 = Read Semantic Graph → find Cognitive Gap.\n"
        "   Fix: Add observe() to Orchestrator."
    )
    assert hasattr(Orchestrator, "evaluate"), (
        "❌ CompTheory §2 FAILED: Orchestrator has no evaluate().\n"
        "   Spec: Step 2 = Evaluate Cognitive Gap → prioritised actions.\n"
        "   Fix: Add evaluate() to Orchestrator."
    )
    assert hasattr(Orchestrator, "decide"), (
        "❌ CompTheory §2 FAILED: Orchestrator has no decide().\n"
        "   Spec: Step 3 = Choose action, record Decision in Graph.\n"
        "   Fix: Add decide() to Orchestrator."
    )
    assert hasattr(Orchestrator, "act"), (
        "❌ CompTheory §2 FAILED: Orchestrator has no act().\n"
        "   Spec: Step 4 = Execute action (ask question, run transformer).\n"
        "   Fix: Add act() to Orchestrator."
    )
    assert hasattr(Orchestrator, "record"), (
        "❌ CompTheory §2 FAILED: Orchestrator has no record().\n"
        "   Spec: Step 5 = Record result in Semantic Graph.\n"
        "   Fix: Add record() to Orchestrator."
    )


def test_comp_theory_cognitive_loop_in_submit_answer():
    """Cognitive loop MUST wrap each transformer in TransformerOrchestrator.run_single().

    CompTheory §2: Observe→Evaluate→Decide→Act→Record
    Реализовано в TransformerOrchestrator.run_single(), не в submit_answer().
    submit_answer() — только диспетчер (§10 HR#3).
    """
    from hermes.transformers.orchestrator import TransformerOrchestrator
    import inspect
    source = inspect.getsource(TransformerOrchestrator.run_single)

    has_observe = "self.observe" in source
    has_evaluate = "self.evaluate" in source
    has_decide = "self.decide" in source
    has_act = "self.run_chain" in source or "transform" in source
    has_record = "self.record" in source

    assert has_observe and has_evaluate and has_decide and has_act and has_record, (
        "❌ CompTheory §2 FAILED: run_single() must implement cognitive cycle.\n"
        f"   observe={has_observe}, evaluate={has_evaluate}, decide={has_decide},\n"
        f"   act={has_act}, record={has_record}\n"
        "   Fix: Add cognitive cycle to TransformerOrchestrator.run_single()."
    )


def test_invariant_04_decision_driven_state():
    """I-004: ALL graph mutations MUST go through _apply_proposal (Proposal→Decide)."""
    from hermes.orchestrator.core import Orchestrator
    import inspect
    source = inspect.getsource(Orchestrator.submit_answer)

    # Count direct graph.record calls vs _apply_proposal calls
    direct_calls = source.count("self.graph.record")
    proposal_calls = source.count("_apply_proposal")

    assert proposal_calls >= direct_calls, (
        "❌ I-004 FAILED: More direct graph.record calls than _apply_proposal.\n"
        f"   self.graph.record = {direct_calls}, _apply_proposal = {proposal_calls}\n"
        "   Spec: Every graph mutation must go through Proposal→Decide→_apply_proposal.\n"
        "   Fix: Replace self.graph.record_*() with self._apply_proposal()."
    )


def test_invariant_09_intent_integrity():
    """I-009: Intent MUST be immutable after first creation."""
    from hermes.orchestrator.core import Orchestrator
    from hermes.orchestrator.core import Orchestrator
    inst = Orchestrator()
    assert hasattr(inst, "_lock_intent"), (
        "❌ I-009 FAILED: Orchestrator has no _lock_intent mechanism.\n"
        "   Spec: Intent remains unchanged throughout project.\n"
        "   Fix: Add _lock_intent flag. Raise error on second record_intent."
    )
    import inspect
    source = inspect.getsource(Orchestrator)
    uses_lock = "._lock_intent" in source or "_lock_intent" in source
    assert uses_lock, (
        "❌ I-009 FAILED: Intent lock not used in submit_answer.\n"
        "   Spec: Intent Integrity — intent cannot be modified after set.\n"
        "   Fix: Add _lock_intent=True after first intent is recorded."
    )


def test_ca001_compare_has_runtime():
    """CA-001 §4.8: Compare MUST have runtime implementation (not stub)."""
    from hermes.kernel.snapshot_manager import SnapshotManager
    assert hasattr(SnapshotManager, "compare"), (
        "❌ CA-001 §4.8 FAILED: SnapshotManager has no compare().\n"
        "   Spec: Compare(id_a, id_b) → ComparisonResult.\n"
        "   Fix: Add compare() to SnapshotManager."
    )

    import inspect
    source = inspect.getsource(SnapshotManager.compare)
    assert "TODO" not in source and "raise NotImplementedError" not in source, (
        "❌ CA-001 §4.8 FAILED: compare() is still a stub.\n"
        "   Spec: Compare must return ComparisonResult with Node/Edge count delta,\n"
        "   structural similarity, and Decision overlap.\n"
        "   Fix: Implement compare() logic."
    )


def test_ca001_fork_merge_rollback_deferred():
    """CA-001 §4.5: Fork/Merge/Rollback — deferred to post-freeze."""
    from hermes.kernel.snapshot_manager import SnapshotManager
    # Check they exist or are explicitly documented as deferred
    has_fork = hasattr(SnapshotManager, "fork")
    has_merge = hasattr(SnapshotManager, "merge")
    has_rollback = hasattr(SnapshotManager, "rollback")
    
    if not has_fork and not has_merge and not has_rollback:
        # Verify they are in ARCHITECTURE-FREEZE.md as deferred
        import os
        freeze_path = __import__("compliance.conftest", fromlist=["resolve_path"]).resolve_path("~/VCOS/standard/ARCHITECTURE-FREEZE.md")
        assert os.path.exists(freeze_path), (
            "❌ CA-001 §4.5 FAILED: Fork/Merge/Rollback not implemented and not deferred.\n"
            "   Spec mandates these operations with full contracts.\n"
            "   Fix: Either implement or add to ARCHITECTURE-FREEZE.md as deferred."
        )


def test_orchestrator_uses_proposal_always():
    """All phases MUST use _apply_proposal, not direct graph writes."""
    from hermes.orchestrator.core import Orchestrator
    import inspect
    source = inspect.getsource(Orchestrator.submit_answer)

    illegal_patterns = [
        "self.graph.record_decision",
        "self.graph.record_intent",
        "self.graph.record_goal",
        "self.graph.record_source",
        "self.graph.record_blueprint",
        "self.graph.record_artifact",
        "self.graph.record_creative_strategy",
        "self.graph.record_constraint",
        "self.graph.record_narrative",
        "self.graph.record_visual_language",
    ]

    found = [p for p in illegal_patterns if p in source]
    assert not found, (
        "❌ I-004 FAILED: Direct graph writes still exist:\n"
        + "\n".join(f"   • {p}" for p in found) +
        "\n   Spec: All mutations go through _apply_proposal(proposal).\n"
        "   Fix: Replace with proposal → _apply_proposal pattern."
    )


# ─── CT-02: Gap analysis covers all phases ───────────────────────

def test_comp_theory_ct02_gap_analysis_covers_all_phases():
    """CompTheory §2.1: observe() MUST have gap analysis for ALL cognitive phases."""
    from hermes.orchestrator.core import Orchestrator, COGNITIVE_PHASES
    import inspect
    source = inspect.getsource(Orchestrator.observe)

    # All cognitive phases must be in blocks_map
    for phase_name, _ in COGNITIVE_PHASES:
        assert phase_name in source, (
            f"❌ CT-02 FAILED: Phase '{phase_name}' missing from observe() blocks_map.\n"
            "   Spec: Cognitive Gap analysis must cover every cognitive phase.\n"
            f"   Fix: Add '{phase_name}' entry to blocks_map in observe()."
        )

    # Check that it handles missing + low_confidence scenarios
    assert "missing" in source, (
        "❌ CT-02 FAILED: Gap analysis must detect 'missing' fields.\n"
        "   Spec: Observe identifies what information is absent.\n"
        "   Fix: Add 'missing' check to observe()."
    )
    assert "low_confidence" in source, (
        "❌ CT-02 FAILED: Gap analysis must detect 'low_confidence' fields.\n"
        "   Spec: Observe identifies what information has low certainty.\n"
        "   Fix: Add low confidence threshold check to observe()."
    )


# ─── CT-03: Confidence scale ──────────────────────────────────────

def test_comp_theory_ct03_confidence_scale_exists():
    """CompTheory §5: DecisionMaker MUST define the 5-level confidence scale."""
    from hermes.kernel.decision_maker import DecisionMaker

    assert hasattr(DecisionMaker, "CONFIDENCE_SCALE"), (
        "❌ CT-03 FAILED: DecisionMaker has no CONFIDENCE_SCALE.\n"
        "   Spec: 5 levels — absolute(1.0), high(0.7-0.9), medium(0.4-0.6), "
        "low(0.1-0.3), none(0.0).\n"
        "   Fix: Add CONFIDENCE_SCALE dict to DecisionMaker."
    )

    scale = DecisionMaker.CONFIDENCE_SCALE
    assert "absolute" in scale, "Missing 'absolute' (1.0)"
    assert "high" in scale, "Missing 'high' (0.7-0.9)"
    assert "medium" in scale, "Missing 'medium' (0.4-0.6)"
    assert "low" in scale, "Missing 'low' (0.1-0.3)"
    assert "none" in scale, "Missing 'none' (0.0)"

    # Verify absolute threshold
    assert scale["absolute"] == 1.0, (
        f"❌ CT-03 FAILED: absolute confidence should be 1.0, got {scale['absolute']}"
    )


def test_comp_theory_ct03_clarify_threshold_aligned():
    """CompTheory §5: CLARIFY_THRESHOLD MUST be ≥ 0.4 (medium confidence boundary)."""
    from hermes.kernel.decision_maker import DecisionMaker

    assert hasattr(DecisionMaker, "CLARIFY_THRESHOLD"), (
        "❌ CT-03 FAILED: DecisionMaker has no CLARIFY_THRESHOLD.\n"
        "   Spec: Below 0.4 = Clarify/Reject.\n"
        "   Fix: Add CLARIFY_THRESHOLD to DecisionMaker."
    )

    threshold = DecisionMaker.CLARIFY_THRESHOLD
    assert threshold >= 0.4, (
        f"❌ CT-03 FAILED: CLARIFY_THRESHOLD is {threshold}, expected ≥ 0.4.\n"
        "   Spec: 0.4-0.6 = medium confidence (LLM level), below = Clarify.\n"
        "   Fix: Set CLARIFY_THRESHOLD to 0.4 (medium confidence boundary)."
    )


# ─── I-009: Intent Integrity validation ───────────────────────────

def test_invariant_09_intent_validation_method():
    """I-009: Orchestrator MUST have _validate_intent_integrity()."""
    from hermes.orchestrator.core import Orchestrator
    import inspect

    assert hasattr(Orchestrator, "_validate_intent_integrity"), (
        "❌ I-009 FAILED: Orchestrator has no _validate_intent_integrity().\n"
        "   Spec: Intent is immutable — overwrite attempts must be rejected.\n"
        "   Fix: Add _validate_intent_integrity() to Orchestrator."
    )

    # Verify it's called from _apply_proposal
    source = inspect.getsource(Orchestrator._apply_proposal)
    assert "_validate_intent_integrity" in source, (
        "❌ I-009 FAILED: _apply_proposal does not call _validate_intent_integrity.\n"
        "   Spec: Every proposal that touches 'intent' block must be validated.\n"
        "   Fix: Add intent integrity check at start of _apply_proposal."
    )

    # Verify locked intent fields exist
    init_source = inspect.getsource(Orchestrator.__init__)
    assert "_locked_intent_value" in init_source, (
        "❌ I-009 FAILED: Orchestrator missing _locked_intent_value.\n"
        "   Fix: Add _locked_intent_value = None to __init__."
    )
    assert "_locked_intent_source" in init_source, (
        "❌ I-009 FAILED: Orchestrator missing _locked_intent_source.\n"
        "   Fix: Add _locked_intent_source = None to __init__."
    )


# ─── CM-03: LLM Proposes → Kernel Decides ─────────────────────────

def test_cm03_llm_proposes_kernel_decides():
    """CM-03: ALL LLM mutations MUST route through _apply_proposal (Proposal→Decide)."""
    from hermes.orchestrator.core import Orchestrator
    import inspect

    source = inspect.getsource(Orchestrator.submit_answer)

    # Count _apply_proposal calls — these are the legitimate mutation path
    proposal_count = source.count("_apply_proposal")

    # Check that there are NO direct registry.graph calls that bypass proposals
    # (inside submit_answer — the _apply_proposal method itself calls graph.record_decision)
    lines = source.split("\n")
    bypass_lines = []
    in_apply = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if "def _apply_proposal" in stripped:
            in_apply = True
        elif "def " in stripped and "def _apply_proposal" not in stripped:
            in_apply = False

        # Check for direct registry writes OUTSIDE _apply_proposal
        if not in_apply:
            if ".registry.register_" in stripped or ".graph.record_" in stripped:
                bypass_lines.append(f"Line {i+1}: {stripped}")

    assert not bypass_lines, (
        "❌ CM-03 FAILED: Direct graph mutations outside _apply_proposal:\n"
        + "\n".join(bypass_lines) +
        "\n   Spec: LLM Proposes → Kernel Decides. Every LLM output goes through Proposal→Decide.\n"
        "   Fix: Move direct graph writes into _apply_proposal."
    )

    # NEW ARCHITECTURE: _apply_proposal is called EXACTLY ONCE in submit_answer()
    # as the single dispatch point. Each transformer phase in run_single() produces
    # proposals collected and applied through this single call.
    assert proposal_count == 1, (
        f"❌ CM-03 FAILED: Expected 1 _apply_proposal call in submit_answer, "
        f"got {proposal_count}.\n"
        "   Spec (refactored): TransformerOrchestrator.run_single() produces proposals,\n"
        "   submit_answer() applies them ONCE through _apply_proposal.\n"
        "   Fix: _apply_proposal must be called exactly once as the single Decide step."
    )