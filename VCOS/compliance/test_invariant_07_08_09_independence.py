"""Compliance: Invariant #7 — Renderer Independence.
Invariant #8 — Model Independence.
Invariant #9 — Generator Independence.

Spec: Architecture Invariants (doc 163).
VCOS must not depend on any specific Renderer, LLM model, or generator.
All are pluggable and swappable.
"""

from compliance.conftest import has_module


def test_invariant_07_renderer_independence():
    """Multiple renderers MUST exist (≥2)."""
    assert has_module("~/VCOS/hermes/renderers/prompt_exporter.py"), (
        "❌ INVARIANT #7 FAILED: No renderers found.\n"
        "   Spec: At least 2 renderers for independence.\n"
        "   Fix: Create renderers/ with multiple output formats."
    )
    from hermes.renderers.prompt_exporter import SUPPORTED_MODELS
    assert len(SUPPORTED_MODELS) >= 2, (
        f"❌ INVARIANT #7 FAILED: Only {len(SUPPORTED_MODELS)} model(s) supported.\n"
        "   Spec: At least 2 renderers for independence.\n"
        f"   Found: {list(SUPPORTED_MODELS.keys()) if hasattr(SUPPORTED_MODELS, 'keys') else SUPPORTED_MODELS}"
    )


def test_invariant_08_model_independence():
    """LLM client MUST be abstracted."""
    assert has_module("~/VCOS/hermes/domain_packs/llm_client.py"), (
        "❌ INVARIANT #8 FAILED: No LLM client abstraction.\n"
        "   Spec: LLM is a pluggable dependency, not hardcoded.\n"
        "   Fix: Create abstract LLMClient with call_llm() method."
    )


def test_invariant_08b_llm_can_be_called_by_name():
    """LLMClient MUST support calling different LLMs by name."""
    try:
        from hermes.domain_packs.llm_client import call_llm
        import inspect
        sig = inspect.signature(call_llm)
        assert "model" in sig.parameters or any(
            "model" in str(p) for p in sig.parameters.values()
        ), (
            "❌ INVARIANT #8 FAILED: call_llm has no 'model' parameter.\n"
            "   Spec: Different LLMs must be callable by name.\n"
            "   Fix: Add 'model: str' parameter to call_llm."
        )
    except ImportError:
        assert False, "❌ INVARIANT #8 FAILED: call_llm not importable."


def test_invariant_09_generator_independence():
    """Multiple export formats MUST exist (≥2)."""
    try:
        from hermes.renderers.prompt_exporter import SUPPORTED_MODELS
        assert len(SUPPORTED_MODELS) >= 2, (
            "❌ INVARIANT #9 FAILED: Fewer than 2 export formats.\n"
            "   Spec: VCOS must support multiple generators.\n"
            f"   Found: {len(SUPPORTED_MODELS)} format(s)."
        )
    except (ImportError, AttributeError):
        assert False, "❌ INVARIANT #9 FAILED: SUPPORTED_MODELS not found."
