"""Compliance: Invariant #4 — Decision-first.

Spec: Architecture Invariants (doc 163), CA-001 (doc 184).
Every project decision is recorded with alternatives, confidence, reasoning.
DecisionMaker + DecisionLogger must exist in kernel.
"""

from compliance.conftest import has_module


def test_invariant_04_decision_maker_exists():
    """DecisionMaker MUST exist in kernel."""
    assert has_module("~/VCOS/hermes/kernel/decision_maker.py"), (
        "❌ INVARIANT #4 FAILED: DecisionMaker not found.\n"
        "   Spec: Every decision goes through Algorithmic Decision Layer.\n"
        "   Fix: Create kernel/decision_maker.py with 3-tier decision logic."
    )


def test_invariant_04b_decision_logger_exists():
    """DecisionLogger MUST exist in kernel."""
    assert has_module("~/VCOS/hermes/kernel/decision_logger.py"), (
        "❌ INVARIANT #4 FAILED: DecisionLogger not found.\n"
        "   Spec: Every decision must be logged for traceability.\n"
        "   Fix: Create kernel/decision_logger.py."
    )


def test_invariant_04c_proposal_exists():
    """Proposal class MUST exist — LLM proposes, Kernel decides."""
    try:
        from hermes.kernel.proposal import Proposal
        assert hasattr(Proposal, "status"), (
            "❌ INVARIANT #4 FAILED: Proposal has no status field.\n"
            "   Spec: Proposals must have status (proposed/accepted/rejected)."
        )
        assert hasattr(Proposal, "justification"), (
            "❌ INVARIANT #4 FAILED: Proposal has no justification.\n"
            "   Spec: Every proposal must explain WHY."
        )
    except ImportError:
        assert False, (
            "❌ INVARIANT #4 FAILED: Proposal class not importable.\n"
            "   Spec: LLM proposes → Kernel decides. Proposal is the contract."
        )


def test_invariant_04d_decision_maker_has_three_tiers():
    """DecisionMaker MUST implement 3-tier decision algorithm."""
    try:
        from hermes.kernel.decision_maker import DecisionMaker, DecisionLevel
        levels = {l.name for l in DecisionLevel}
        for expected in ("ACCEPT", "EXPERT_MATCH", "CLARIFY"):
            assert expected in levels, (
                f"❌ INVARIANT #4 FAILED: Missing DecisionLevel.{expected}\n"
                "   Spec: 3 tiers — Accept, ExpertMatch, Clarify (doc 168)."
            )
    except ImportError:
        assert False, (
            "❌ INVARIANT #4 FAILED: DecisionMaker/DecisionLevel not importable."
        )