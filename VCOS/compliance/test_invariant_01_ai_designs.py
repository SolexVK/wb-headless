"""Compliance: Invariant #1 — AI designs, not generates.

Spec: Architecture Invariants (doc 163).
VCOS is a DESIGN system, not a GENERATION system.
Kernel code MUST NOT call image/video generation APIs directly.
Generation is delegated to Renderers, which are pluggable and independent.
"""

from compliance.conftest import get_node_types, get_core_module


def test_invariant_01_ai_designs_not_generates():
    """Kernel/core.py MUST NOT import or call any generation API."""
    core = get_core_module()

    # Check forbidden imports in the file
    forbidden = [
        "comfy", "replicate", "stability", "openai.Image",
        "diffusers", "torch", "tensorflow", "onnx",
        "boto3", "google.cloud", "azure.cognitiveservices",
    ]
    import_source = open(core.__file__).read().lower()

    violations = [lib for lib in forbidden if lib in import_source]
    assert not violations, (
        f"❌ INVARIANT #1 FAILED: Kernel imports generation libraries:\n"
        f"   Found: {violations}\n"
        f"   Spec: VCOS is a DESIGN system. Generation is handled by Renderers.\n"
        f"   Fix: Move generation logic to renderers/, not kernel/."
    )


def test_invariant_01b_renderers_exist():
    """Renderers MUST exist and be separate from kernel."""
    from compliance.conftest import has_module
    assert has_module("~/VCOS/hermes/renderers/prompt_exporter.py"), (
        "❌ INVARIANT #1 FAILED: No renderers found.\n"
        "   Spec: VCOS renders through pluggable Renderers, not kernel.\n"
        "   Fix: Ensure renderers/ exists with at least one Renderer."
    )