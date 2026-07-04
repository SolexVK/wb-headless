"""Compliance: Invariant #5 — Explainability.

Spec: Architecture Invariants (doc 163).
Every decision, proposal, and inference must be explainable.
Proposals carry justification. Inferences carry confidence.
"""

from compliance.conftest import has_module


def test_invariant_05_proposal_has_justification():
    """Proposal.justification MUST exist."""
    try:
        from hermes.kernel.proposal import Proposal
        assert hasattr(Proposal, "justification") or "justification" in Proposal.__dataclass_fields__, (
            "❌ INVARIANT #5 FAILED: Proposal has no justification field.\n"
            "   Spec: Every proposal must explain WHY this choice.\n"
            "   Fix: Add 'justification: str' to Proposal dataclass."
        )
    except ImportError:
        assert False, "❌ INVARIANT #5 FAILED: Proposal class not importable."


def test_invariant_05b_confidence_evaluator_exists():
    """ConfidenceEvaluator MUST exist."""
    assert has_module("~/VCOS/hermes/design/confidence.py") or \
           has_module("~/VCOS/hermes/reasoning/confidence.py"), (
        "❌ INVARIANT #5 FAILED: ConfidenceEvaluator not found.\n"
        "   Spec: Every inference has explicit confidence.\n"
        "   Fix: Create design/confidence.py."
    )


def test_invariant_05c_decision_entry_has_rationale():
    """DecisionLogger entries MUST carry rationale."""
    try:
        from hermes.kernel.decision_logger import DecisionEntry
        assert hasattr(DecisionEntry, "rationale") or "rationale" in DecisionEntry.__dataclass_fields__, (
            "❌ INVARIANT #5 FAILED: DecisionEntry has no rationale.\n"
            "   Spec: Every decision log entry must explain WHY.\n"
            "   Fix: Add 'rationale: str' to DecisionEntry."
        )
    except ImportError:
        assert False, "❌ INVARIANT #5 FAILED: DecisionLogger not importable."
