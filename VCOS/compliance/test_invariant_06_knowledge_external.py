"""Compliance: Invariant #6 — Knowledge is External.

Spec: Architecture Invariants (doc 163), CP-001 (doc 184).
Knowledge is provided by external Knowledge Packs, not hardcoded in kernel.
KnowledgeProvider + KnowledgeRegistry must exist.
"""

from compliance.conftest import has_module


def test_invariant_06_knowledge_provider_exists():
    """KnowledgeProvider protocol MUST exist."""
    assert has_module("~/VCOS/hermes/knowledge/provider.py") or \
           has_module("~/VCOS/hermes/knowledge/__init__.py"), (
        "❌ INVARIANT #6 FAILED: KnowledgeProvider not found.\n"
        "   Spec: Knowledge is external — provided by Knowledge Providers.\n"
        "   Fix: Create knowledge/provider.py with KnowledgeProvider protocol."
    )


def test_invariant_06b_knowledge_registry_exists():
    """KnowledgeRegistry MUST exist."""
    assert has_module("~/VCOS/hermes/knowledge/registry.py"), (
        "❌ INVARIANT #6 FAILED: KnowledgeRegistry not found.\n"
        "   Spec: Knowledge Providers are registered in a central registry.\n"
        "   Fix: Create knowledge/registry.py."
    )


def test_invariant_06c_at_least_one_knowledge_provider():
    """At least one concrete KnowledgeProvider MUST exist."""
    assert has_module("~/VCOS/hermes/knowledge/providers/photography.py"), (
        "❌ INVARIANT #6 FAILED: No concrete KnowledgeProvider found.\n"
        "   Spec: Knowledge is external — at least one provider must exist.\n"
        "   Fix: Create knowledge/providers/ with a KnowledgeProvider."
    )


def test_invariant_06d_kernel_does_not_hardcode_knowledge():
    """Kernel MUST NOT contain hardcoded domain knowledge."""
    from compliance.conftest import get_core_module
    source = open(get_core_module().__file__).read().lower()
    domain_terms = ["focal length", "aperture", "shutter speed", "iso",
                    "rule of thirds", "color temperature"]
    violations = [t for t in domain_terms if t in source]
    assert not violations, (
        f"❌ INVARIANT #6 FAILED: Domain knowledge in kernel.\n"
        f"   Found: {violations}\n"
        "   Spec: Knowledge is external. Kernel must not hardcode domain terms.\n"
        "   Fix: Move domain knowledge to knowledge/providers/."
    )
