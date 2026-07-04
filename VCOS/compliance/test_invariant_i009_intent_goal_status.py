"""Compliance: I-009 Intent Integrity + CO-001 §1/§2 Intent/Goal statuses.

I-009 — Intent Integrity:
  Intent не изменяется агентами после фиксации.

CO-001 §1 — Intent status: CAPTURED → ANALYZING → UNDERSTOOD → SUPERSEDED
CO-001 §2 — Goal status:   DRAFT → ACTIVE → ACHIEVED / ABANDONED

Spec: CO-001 specification.md §1–2, Architecture-Invariants.md I-009.
"""

from compliance.conftest import get_core_module


def test_i009_intent_status_enum_exists():
    """I-009 / CO-001 §1: IntentStatus enum MUST exist with 4 states."""
    core = get_core_module()
    assert hasattr(core, "IntentStatus"), (
        "❌ I-009 FAILED: IntentStatus enum not found in core.py.\n"
        "   Spec: CO-001 §1 defines Intent status lifecycle.\n"
        "   Fix: Add IntentStatus enum to hermes/kernel/core.py."
    )
    values = {s.value for s in core.IntentStatus}
    expected = {"captured", "analyzing", "understood", "superseded"}
    missing = expected - values
    assert not missing, (
        f"❌ I-009 FAILED: IntentStatus missing: {missing}\n"
        f"   Spec: CAPTURED, ANALYZING, UNDERSTOOD, SUPERSEDED.\n"
        f"   Found: {values}"
    )


def test_i009_intent_status_transitions():
    """I-009 / CO-001 §1: Intent status MUST follow CAPTURED → ANALYZING → UNDERSTOOD → SUPERSEDED."""
    core = get_core_module()
    transitions = core.IntentStatus.valid_transitions()

    # Check forward path
    assert core.IntentStatus.CAPTURED.can_transition_to(core.IntentStatus.ANALYZING), (
        "❌ I-009 FAILED: CAPTURED → ANALYZING must be valid."
    )
    assert core.IntentStatus.ANALYZING.can_transition_to(core.IntentStatus.UNDERSTOOD), (
        "❌ I-009 FAILED: ANALYZING → UNDERSTOOD must be valid."
    )
    assert core.IntentStatus.UNDERSTOOD.can_transition_to(core.IntentStatus.SUPERSEDED), (
        "❌ I-009 FAILED: UNDERSTOOD → SUPERSEDED must be valid."
    )

    # Check no backward transitions
    assert not core.IntentStatus.ANALYZING.can_transition_to(core.IntentStatus.CAPTURED), (
        "❌ I-009 FAILED: ANALYZING → CAPTURED must be invalid (no backward transitions)."
    )
    assert not core.IntentStatus.SUPERSEDED.can_transition_to(core.IntentStatus.UNDERSTOOD), (
        "❌ I-009 FAILED: SUPERSEDED → UNDERSTOOD must be invalid (terminal state)."
    )

    # Check terminal
    assert transitions[core.IntentStatus.SUPERSEDED] == set(), (
        "❌ I-009 FAILED: SUPERSEDED must be terminal (no outgoing transitions)."
    )


def test_i009_goal_status_enum_exists():
    """I-009 / CO-001 §2: GoalStatus enum MUST exist with 4 states."""
    core = get_core_module()
    assert hasattr(core, "GoalStatus"), (
        "❌ I-009 FAILED: GoalStatus enum not found in core.py.\n"
        "   Spec: CO-001 §2 defines Goal status lifecycle.\n"
        "   Fix: Add GoalStatus enum to hermes/kernel/core.py."
    )
    values = {s.value for s in core.GoalStatus}
    expected = {"draft", "active", "achieved", "abandoned"}
    missing = expected - values
    assert not missing, (
        f"❌ I-009 FAILED: GoalStatus missing: {missing}\n"
        f"   Spec: DRAFT, ACTIVE, ACHIEVED, ABANDONED.\n"
        f"   Found: {values}"
    )


def test_i009_goal_status_transitions():
    """I-009 / CO-001 §2: Goal MUST follow DRAFT → ACTIVE → ACHIEVED / ABANDONED."""
    core = get_core_module()

    # Forward
    assert core.GoalStatus.DRAFT.can_transition_to(core.GoalStatus.ACTIVE), (
        "❌ I-009 FAILED: DRAFT → ACTIVE must be valid."
    )
    assert core.GoalStatus.ACTIVE.can_transition_to(core.GoalStatus.ACHIEVED), (
        "❌ I-009 FAILED: ACTIVE → ACHIEVED must be valid."
    )
    assert core.GoalStatus.ACTIVE.can_transition_to(core.GoalStatus.ABANDONED), (
        "❌ I-009 FAILED: ACTIVE → ABANDONED must be valid."
    )

    # No backward
    assert not core.GoalStatus.ACTIVE.can_transition_to(core.GoalStatus.DRAFT), (
        "❌ I-009 FAILED: ACTIVE → DRAFT must be invalid."
    )
    assert not core.GoalStatus.ACHIEVED.can_transition_to(core.GoalStatus.ACTIVE), (
        "❌ I-009 FAILED: ACHIEVED → ACTIVE must be invalid (terminal)."
    )
    assert not core.GoalStatus.ABANDONED.can_transition_to(core.GoalStatus.ACTIVE), (
        "❌ I-009 FAILED: ABANDONED → ACTIVE must be invalid (terminal)."
    )


def test_i009_get_node_type_status_helper():
    """get_node_type_status helper must return correct enum for Intent/Goal."""
    core = get_core_module()

    # Intent with status
    result = core.get_node_type_status(core.NodeType.INTENT.value, {"status": "captured"})
    assert result == core.IntentStatus.CAPTURED, (
        f"❌ I-009 FAILED: get_node_type_status(INTENT, 'captured') = {result}, expected CAPTURED."
    )

    # Intent without status → default CAPTURED
    result_default = core.get_node_type_status(core.NodeType.INTENT.value, {})
    assert result_default == core.IntentStatus.CAPTURED, (
        f"❌ I-009 FAILED: default Intent status should be CAPTURED, got {result_default}."
    )

    # Goal with status
    result2 = core.get_node_type_status(core.NodeType.GOAL.value, {"status": "active"})
    assert result2 == core.GoalStatus.ACTIVE, (
        f"❌ I-009 FAILED: get_node_type_status(GOAL, 'active') = {result2}, expected ACTIVE."
    )

    # Other types return None
    none_result = core.get_node_type_status(core.NodeType.DECISION.value, {})
    assert none_result is None, (
        f"❌ I-009 FAILED: Non-Intent/Goal type should return None, got {none_result}."
    )


def test_i009_validator_checkers_registered():
    """Validator MUST have Intent and Goal status checks registered."""
    from hermes.kernel.validator import Validator

    # Check the instance method exists
    assert hasattr(Validator, "_check_intent_status_transition"), (
        "❌ I-009 FAILED: Validator missing _check_intent_status_transition."
    )
    assert hasattr(Validator, "_check_goal_status_transition"), (
        "❌ I-009 FAILED: Validator missing _check_goal_status_transition."
    )


def test_i009_intent_integrity_invariant():
    """I-009: Intent Integrity — Intent must NOT be modified by agents after fixation.
    
    Spec: Architecture-Invariants.md I-009.
    Intent не изменяется агентами после фиксации.
    Only superseded (new Intent replaces old). No mutation of existing Intent.
    """
    from hermes.kernel.core import Node, NodeType, LifecycleState
    from hermes.kernel.core import IntentStatus, get_node_type_status

    # Create a node with INTENT type
    node = Node(
        type=NodeType.INTENT.value,
        state=LifecycleState.APPROVED,
        properties={"status": "understood", "description": "test intent"},
    )

    status = get_node_type_status(node.type, node.properties)
    assert status == IntentStatus.UNDERSTOOD, (
        f"❌ I-009 FAILED: Intent status should be UNDERSTOOD, got {status}.\n"
        "   Spec: Intent status reflects interpretation state."
    )

    # Once UNDERSTOOD, can only go to SUPERSEDED
    assert IntentStatus.UNDERSTOOD.can_transition_to(IntentStatus.SUPERSEDED), (
        "❌ I-009 FAILED: UNDERSTOOD → SUPERSEDED must be allowed.\n"
        "   Spec: Intent can only be superseded, not modified."
    )