"""Compliance: Invariant #15 — Extensibility (Domain Packs).

Spec: Architecture Invariants (doc 163).
VCOS must be extensible via Domain Packs without kernel changes.
Minimum 6 packs. All must be importable as modules.
"""

from compliance.conftest import has_module


def test_invariant_15_minimum_six_packs():
    """At least 6 Domain Packs MUST exist as files."""
    required = [
        "photography_pack",
        "film_pack",
        "advertising_pack",
        "infographic_pack",
        "youtube_pack",
        "fashion_pack",
    ]
    missing = []
    for pack in required:
        path = f"~/VCOS/hermes/domain_packs/{pack}.py"
        if not has_module(path):
            missing.append(pack)
    assert not missing, (
        f"❌ INVARIANT #15: Missing Domain Packs.\n"
        f"   Missing: {missing}\n"
        f"   Required: {required}\n"
        "   Spec: 6 packs minimum.\n"
        "   Fix: Create missing pack files."
    )


def test_invariant_15b_packs_importable():
    """All 6 Domain Packs MUST be importable without errors."""
    import importlib
    errors = []
    for pack_name in ["photography_pack", "film_pack", "advertising_pack",
                       "infographic_pack", "youtube_pack", "fashion_pack"]:
        try:
            importlib.import_module(f"hermes.domain_packs.{pack_name}")
        except Exception as e:
            errors.append(f"{pack_name}: {e}")
    assert not errors, (
        "❌ INVARIANT #15: Domain Packs have import errors.\n"
        + "\n".join(f"   {e}" for e in errors)
    )