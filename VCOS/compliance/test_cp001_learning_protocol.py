"""Compliance: CP-001.10 — Learning Protocol.

Spec: CP-001 defines Learning Protocol with:
  - LearningEngine.extract_patterns(project_ids)
  - LearningEngine.suggest_next(graph)
  - LearningEngine.approve_pattern / reject_pattern
"""

from compliance.conftest import has_module


def test_cp001_learning_protocol_exists():
    """Learning Engine MUST implement the Learning Protocol (CP-001.10)."""
    assert has_module("~/VCOS/hermes/learning/engine.py") or \
           has_module("~/VCOS/hermes/learning/__init__.py"), (
        "❌ CP-001 Learning Protocol: learning/ not found.\n"
        "   Spec: LearningEngine with extract_patterns, suggest_next, approve/reject.\n"
        "   Fix: Create learning/engine.py."
    )


def test_cp001_learning_protocol_has_extract():
    """LearningEngine MUST have extract_patterns()."""
    try:
        from hermes.learning.engine import LearningEngine
        assert hasattr(LearningEngine, "extract_patterns"), (
            "❌ CP-001 Learning Protocol: extract_patterns() not found.\n"
            "   Spec: extract_patterns(project_ids) -> Pattern[]\n"
            "   Fix: Add extract_patterns() to LearningEngine."
        )
    except (ImportError, AttributeError):
        assert False, (
            "❌ CP-001 Learning Protocol: LearningEngine not importable."
        )