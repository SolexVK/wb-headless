"""CRITICAL: Проверка 10 критических проблем (doc audit).

Эти тесты проверяют конкретные gap'ы из аудита.
Большинство ДОЛЖНЫ ПАДАТЬ сейчас — они фиксируют разрыв.
"""

from compliance.conftest import has_module, get_core_module


def test_critical_01_immutability():
    """CRITICAL: Node MUST be frozen — no update() mutation (🟡🔴🔴 #2)."""
    core = get_core_module()
    node = core.Node()

    # Check if update() exists — it SHOULD NOT for immutable design
    assert not hasattr(node, "update"), (
        "❌ CRITICAL #1: Node.update() exists — violates immutability.\n"
        "   Spec: Node is frozen. Every change = new Node (doc 167).\n"
        "   Fix: Remove update(). Use graph.replace_node() instead."
    )

    # Check if node properties are mutable
    try:
        node.properties["test"] = "value"
        # If this works — properties dict is mutable, which may be OK
        # But core Node itself should be frozen
        node.properties["test2"] = "value2"
    except (TypeError, AttributeError):
        pass  # Properties are read-only — good sign


def test_critical_02_project_model_duplicates_data():
    """CRITICAL: ProjectModel MUST NOT duplicate Registry/Graph data (🟡🔴🔴 #1)."""
    try:
        from hermes.kernel.project_model import ProjectModel

        # Check if ProjectModel stores full copies of nodes
        # or just ID references
        import inspect
        fields = {}
        if hasattr(ProjectModel, "__dataclass_fields__"):
            fields = ProjectModel.__dataclass_fields__

        suspicious_fields = [f for f in fields if f in (
            "sources", "intents", "goals", "constraints",
            "facts", "decisions", "blueprints", "artifacts",
        )]
        if suspicious_fields:
            # Check field types — should be list[str] (IDs), not list[Node]
            for fname in suspicious_fields:
                ftype = fields[fname].type
                ftype_str = str(ftype).lower()
                if "node" not in ftype_str and "dict" not in ftype_str:
                    pass  # Likely just ID references — OK
                else:
                    assert False, (
                        "❌ CRITICAL #2: ProjectModel stores full node copies.\n"
                        f"   Field `{fname}` type = {ftype}\n"
                        "   Spec: ProjectModel = View Model = only ID references (doc 189).\n"
                        "   Fix: Replace Node[] with str[] (ID references)."
                    )
    except ImportError:
        assert False, "❌ CRITICAL #2: ProjectModel not found (not necessarily a violation)."


def test_critical_03_compare_operation_missing():
    """CRITICAL: Compare (CA-001) MUST exist (🟡🔴🔴 #8)."""
    has_compare = has_module("~/VCOS/hermes/kernel/compare.py") or \
                  has_module("~/VCOS/hermes/kernel/snapshot_manager.py") or \
                  has_module("~/VCOS/hermes/kernel/snapshot.py")
    # SnapshotManager has diff(), but does it have compare()?
    try:
        from hermes.kernel.snapshot_manager import SnapshotManager
        if hasattr(SnapshotManager, "compare") or \
           hasattr(SnapshotManager, "diff"):
            return  # OK — compare/diff exists
    except ImportError:
        pass

    # Check if compare exists anywhere
    import glob
    compare_files = glob.glob(
        "/Users/openclaw/VCOS/hermes/**/*.py", recursive=True
    )
    has_compare_fn = False
    for f in compare_files:
        try:
            with open(f) as fh:
                if "def compare" in fh.read():
                    has_compare_fn = True
                    break
        except:  # noqa
            pass

    assert has_compare_fn, (
        "❌ CRITICAL #8: Compare operation not implemented.\n"
        "   Spec CA-001: Compare is a structural operation.\n"
        "   Fix: Add compare() to SnapshotManager or core algebra."
    )


def test_critical_04_learn_operation_missing():
    """CRITICAL: Learn (CA-001) MUST exist (🟡🔴🔴 #9)."""
    assert has_module("~/VCOS/hermes/learning/engine.py") or \
           has_module("~/VCOS/hermes/learning/__init__.py"), (
        "❌ CRITICAL #9: Learn operation not implemented.\n"
        "   Spec CA-001: Learn is a core algebra operation.\n"
        "   Fix: Create learning/engine.py with LearningEngine."
    )


def test_critical_05_lifecycle_mismatch():
    """CRITICAL: Runtime lifecycle MUST match cognitive lifecycle (🟡🔴🔴 #6).

    Spec: Created → Interview → Understanding → Design → Validation → Compilation → Completed
    Reality: CREATED → INITIALIZED → ACTIVE → EXPORTING → EXPORTED → ARCHIVED / FAILED
    """
    try:
        from hermes.runtime.runtime import ProjectStatus
        statuses = {s.name for s in ProjectStatus}
        cognitive_statuses = {
            "CREATED", "INITIALIZED", "INTERVIEW", "UNDERSTANDING",
            "DESIGN", "VALIDATION", "COMPILATION", "COMPLETED", "FAILED",
        }
        matches = cognitive_statuses & statuses
        assert len(matches) >= 5, (
            "❌ CRITICAL #6: Lifecycle mismatch.\n"
            f"   Cognitive lifecycle has: {sorted(cognitive_statuses)}\n"
            f"   Runtime has: {sorted(statuses)}\n"
            f"   Matching: {len(matches)}/{len(cognitive_statuses)}\n"
            "   Spec (doc 183): Lifecycle follows cognitive phases.\n"
            "   Fix: Rename lifecycle to cognitive phases."
        )
    except ImportError:
        assert False, "❌ CRITICAL #6: Runtime/ProjectStatus not found (may need creation)."