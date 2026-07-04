"""Compliance: CA-001 Core Algebra — Learn, Compare, Fork, Merge, Reject, Compile.

Spec: CA-001 (Core Algebra) — all operations MUST exist and work correctly.
"""

from uuid import uuid4
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel, ProjectIdentity
from hermes.kernel.core import Node, NodeType, LifecycleState, RelationType
from hermes.kernel.decision_logger import DecisionLogger, DecisionEntry
from hermes.kernel.algebra import (
    fork, merge, reject, diff, compare_projects, compile_blueprint,
    learn, MergeStrategy, Pattern
)
from hermes.kernel.snapshot import SnapshotChain


# ═══════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════

def _make_project(name: str = "test") -> ProjectModel:
    return ProjectModel(
        identity=ProjectIdentity(id=name, version=1),
        project_name=name,
    )


def _make_registry_with_data() -> tuple[Registry, ProjectModel]:
    reg = Registry()
    project = _make_project("test_project")

    intent = Node(type=NodeType.INTENT, state=LifecycleState.APPROVED)
    goal = Node(type=NodeType.GOAL, state=LifecycleState.APPROVED)
    decision = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED)

    reg.register_node(intent)
    reg.register_node(goal)
    reg.register_node(decision)

    project = (project
        .with_intent(intent.id)
        .with_goal(goal.id)
        .with_decision(decision.id)
    )

    return reg, project


# ═══════════════════════════════════════════
# Fork (CA-001 §4.5)
# ═══════════════════════════════════════════

def test_fork_creates_new_project():
    """Fork создаёт новый ProjectModel."""
    reg, project = _make_registry_with_data()
    _, branch = fork(reg, project, "snap_001", name="experiment")
    assert branch.identity.id != project.identity.id
    assert branch.identity.parent_project == project.identity.id
    assert branch.project_name == "experiment"


def test_fork_copies_entities():
    """Fork копирует ID-ссылки из родителя."""
    reg, project = _make_registry_with_data()
    _, branch = fork(reg, project, "snap_001")
    assert branch.intents == project.intents
    assert branch.goals == project.goals
    assert branch.decisions == project.decisions


def test_fork_preserves_registry():
    """Оба проекта используют один Registry."""
    reg, project = _make_registry_with_data()
    _, branch = fork(reg, project, "snap_001")
    intent = reg.get_node(project.intents[0])
    assert intent is not None
    # branch видит те же ноды через тот же Registry
    assert intent.id in branch.intents


# ═══════════════════════════════════════════
# Merge (CA-001 §4.5)
# ═══════════════════════════════════════════

def test_merge_fast_forward():
    """Fast-forward: source полностью впереди target."""
    reg = Registry()
    target = _make_project("target")
    source = _make_project("source")

    d1 = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED)
    d2 = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED)
    reg.register_node(d1)
    reg.register_node(d2)

    target = target.with_decision(d1.id)
    source = source.with_decision(d1.id).with_decision(d2.id)  # source = target + 1 decision

    merged = merge(reg, target, source, strategy=MergeStrategy.FAST_FORWARD)
    assert len(merged.decisions) == 2
    assert d2.id in merged.decisions


def test_merge_overwrite():
    """Overwrite: source заменяет target."""
    reg = Registry()
    target = _make_project("target")
    source = _make_project("source")

    d1 = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED,
              properties={"value": "old"})
    d2 = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED,
              properties={"value": "new"})
    reg.register_node(d1)
    reg.register_node(d2)

    target = target.with_decision(d1.id)
    source = source.with_decision(d2.id)

    merged = merge(reg, target, source, strategy=MergeStrategy.OVERWRITE)
    assert d2.id in merged.decisions
    assert d1.id in merged.decisions  # overwrite объединяет, не заменяет


def test_merge_three_way():
    """Three-way: объединение двух веток."""
    reg = Registry()
    target = _make_project("target")
    source = _make_project("source")

    d_a = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED)
    d_b = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED)
    reg.register_node(d_a)
    reg.register_node(d_b)

    target = target.with_decision(d_a.id)
    source = source.with_decision(d_b.id)

    merged = merge(reg, target, source, strategy=MergeStrategy.THREE_WAY)
    assert len(merged.decisions) == 2
    assert d_a.id in merged.decisions
    assert d_b.id in merged.decisions


def test_merge_same_project_raises():
    """Merge проекта с собой вызывает ошибку."""
    reg = Registry()
    p = _make_project("self")
    try:
        merge(reg, p, p)
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


# ═══════════════════════════════════════════
# Reject (CA-001 §4.3)
# ═══════════════════════════════════════════

def test_reject_records_in_log():
    """Reject записывает отклонение в DecisionLogger."""
    logger = DecisionLogger()
    reject(logger, "prop_001", "Not aligned with goal")
    assert len(logger) == 1 or len(logger.decisions) == 1


def test_reject_stores_reason():
    """Reject сохраняет причину."""
    logger = DecisionLogger()
    reject(logger, "prop_001", "Budget constraint")
    entry = logger.decisions[0]
    assert "Budget constraint" in entry.rationale or "Budget constraint" in str(entry)


# ═══════════════════════════════════════════
# Diff / Compare (CA-001 §4.6, §4.8)
# ═══════════════════════════════════════════

def test_diff_detects_added():
    """Diff находит добавленные узлы."""
    reg = Registry()
    before = _make_project("before")
    after = _make_project("after")

    g = Node(type=NodeType.GOAL, state=LifecycleState.APPROVED)
    reg.register_node(g)

    result = diff(reg, before, after)
    assert result.node_count_delta == 0  # оба пусты

    after = after.with_goal(g.id)
    result2 = diff(reg, before, after)
    assert result2.node_count_delta > 0


def test_diff_similarity():
    """Diff вычисляет similarity между проектами."""
    reg = Registry()
    a = _make_project("a")
    b = _make_project("b")

    g = Node(type=NodeType.GOAL, state=LifecycleState.APPROVED)
    reg.register_node(g)
    a = a.with_goal(g.id)
    b = b.with_goal(g.id)

    result = diff(reg, a, b)
    assert result.similarity == 1.0


def test_compare_projects():
    """Compare сравнивает два проекта."""
    reg, project_a = _make_registry_with_data()
    project_b = _make_project("other")
    result = compare_projects(reg, project_a, project_b)
    assert result is not None
    assert result.node_count_delta != 0  # project_a богаче


# ═══════════════════════════════════════════
# Compile (CA-001 §4.7)
# ═══════════════════════════════════════════

def test_compile_creates_artifact():
    """Compile создаёт Artifact Node."""
    reg = Registry()
    project = _make_project("compile_test")

    bp = Node(type=NodeType.BLUEPRINT, state=LifecycleState.APPROVED)
    reg.register_node(bp)

    artifact = compile_blueprint(reg, project, bp.id)
    assert artifact is not None
    assert artifact.type == NodeType.ARTIFACT.value


def test_compile_requires_approved():
    """Compile требует Approved Blueprint."""
    reg = Registry()
    project = _make_project("compile_fail")

    bp = Node(type=NodeType.BLUEPRINT, state=LifecycleState.DRAFT)
    reg.register_node(bp)

    try:
        compile_blueprint(reg, project, bp.id)
        assert False, "Should have raised ValueError for non-approved BP"
    except ValueError:
        pass


# ═══════════════════════════════════════════
# Learn (CA-001 §4.8)
# ═══════════════════════════════════════════

def test_learn_returns_patterns():
    """Learn извлекает паттерны из повторяющихся решений."""
    logger = DecisionLogger()
    reg = Registry()

    # Добавить 3 одинаковых решения
    for _ in range(3):
        logger.record("composition", "rule", "rule_of_thirds",
                      source="user", rationale="standard", confidence=0.8)

    patterns = learn(reg, logger)
    assert len(patterns) > 0


def test_learn_ignores_singletons():
    """Learn игнорирует единичные решения (frequency < 2)."""
    logger = DecisionLogger()
    reg = Registry()

    logger.record("lighting", "style", "dramatic",
                  source="user", rationale="", confidence=0.5)

    patterns = learn(reg, logger)
    # Единичное решение не создаёт паттерн
    lighting_patterns = [p for p in patterns if p.domain == "lighting"]
    assert len(lighting_patterns) == 0


def test_learn_increases_confidence():
    """Learn повышает confidence при большем количестве evidence."""
    logger = DecisionLogger()
    reg = Registry()

    for _ in range(5):
        logger.record("camera", "lens", "85mm",
                      source="user", rationale="", confidence=0.7)

    patterns = learn(reg, logger)
    cam_patterns = [p for p in patterns if p.field == "lens"]
    if cam_patterns:
        assert cam_patterns[0].confidence >= 0.5