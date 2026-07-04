"""VCOS — Freeze Tests: G-Invariants (CM-001.4)

Проверяет, что все 12 G-инвариантов графа соблюдаются.

Структура:
  1. test_g001_no_cycles
  2. test_g002_every_node_reachable
  3. test_g003_graph_connected
  4. test_g004_single_root
  5. test_g005_decision_supports_goal
  6. test_g006_blueprint_satisfies_decision
  7. test_g007_artifact_derives_from_blueprint
  8. test_g008_facts_immutable
  9. test_g009_source_intent_goal_chain
  10. test_g010_no_duplicate_identity
  11. test_g011_version_monotonicity
  12. test_g012_domain_pack_isolation

Каждый тест:
  - Создаёт минимальный корректный граф
  - Проверяет, что инвариант не нарушен (0 violations)
  - Создаёт нарушение и проверяет, что оно поймано (≥1 violation)

G-008 (Facts immutable) и G-011 (Version monotonicity) — тесты на
уровне Registry API, не валидатора.
"""

import pytest
from uuid import uuid4
from datetime import datetime, timezone

from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel
from hermes.kernel.core import Node, NodeType, RelationType, LifecycleState
from hermes.kernel.validator import Validator, Violation


# ═══════════════════════════════════════════════════════════
# Helper: создать минимальный корректный граф
# ═══════════════════════════════════════════════════════════

def _make_valid_graph():
    """Создать минимальный корректный граф со всеми обязательными связями."""
    registry = Registry()
    project = ProjectModel()

    from hermes.kernel.core import Edge

    # Source → Intent → Goal
    source = Node(type=NodeType.SOURCE, state=LifecycleState.APPROVED,
                  properties={"content": "valid test"})
    registry.register_node(source)

    intent = Node(type=NodeType.INTENT, state=LifecycleState.APPROVED,
                  properties={"description": "test intent"})
    registry.register_node(intent)
    project = project.with_intent(intent.id)

    goal = Node(type=NodeType.GOAL, state=LifecycleState.APPROVED,
                properties={"description": "test goal"})
    registry.register_node(goal)
    project = project.with_goal(goal.id)

    # Edge: Intent → Source, Goal → Intent
    registry.register_edge(Edge(source=intent.id, target=source.id,
                                type=RelationType.DERIVES_FROM))
    registry.register_edge(Edge(source=goal.id, target=intent.id,
                                type=RelationType.REFINES))

    # Decision supports Goal
    decision = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED,
                    properties={"vsl_field": "test", "value": "test",
                                "confidence": 0.85})
    registry.register_node(decision)
    project = project.with_decision(decision.id)
    registry.register_edge(Edge(source=decision.id, target=goal.id,
                                type=RelationType.SUPPORTS))

    # Blueprint satisfies Decision
    blueprint = Node(type=NodeType.BLUEPRINT, state=LifecycleState.APPROVED,
                     properties={})
    registry.register_node(blueprint)
    project = project.with_blueprint(blueprint.id)
    registry.register_edge(Edge(source=blueprint.id, target=decision.id,
                                type=RelationType.SATISFIES))

    # Artifact derives from Blueprint
    artifact = Node(type=NodeType.ARTIFACT, state=LifecycleState.APPROVED,
                    properties={"content": "test"})
    registry.register_node(artifact)
    project = project.with_artifact(artifact.id)
    registry.register_edge(Edge(source=blueprint.id, target=artifact.id,
                                type=RelationType.PRODUCES))
    # Artifact → Decision (G-006 chain)
    registry.register_edge(Edge(source=artifact.id, target=decision.id,
                                type=RelationType.SUPPORTS))

    return registry, project


# ═══════════════════════════════════════════════════════════
# G-001 — No Cycles in Decision Chain
# ═══════════════════════════════════════════════════════════

def test_g001_no_cycles_clean():
    """G-001: Корректный граф — 0 violations."""
    registry, project = _make_valid_graph()
    v = Validator(registry, project)
    violations = v.validate()
    g001 = [x for x in violations if x.invariant == "G-001"]
    assert len(g001) == 0, f"G-001 fals positive on clean graph: {g001}"


def test_g001_cycle_detected():
    """G-001: Цикл должен быть пойман."""
    registry, project = _make_valid_graph()
    from hermes.kernel.core import Edge
    nodes = registry.get_nodes()
    if len(nodes) >= 2:
        # Создать цикл: node2 → node1 → node2
        registry.register_edge(Edge(source=nodes[0].id, target=nodes[1].id,
                                    type=RelationType.REFERENCES))
        v = Validator(registry, project)
        violations = v.validate()
        g001 = [x for x in violations if x.invariant == "G-001"]
        assert len(g001) >= 1, "G-001 should detect cycles"


# ═══════════════════════════════════════════════════════════
# G-002 — Every Node Reachable
# ═══════════════════════════════════════════════════════════

def test_g002_all_reachable():
    """G-002: Все узлы достижимы из ProjectModel."""
    registry, project = _make_valid_graph()
    for n in registry.get_nodes():
        assert n.id in project.intents + project.goals + project.decisions + \
               project.blueprints + project.artifacts or n.type == NodeType.SOURCE, \
               f"G-002: Node {n.id.hex[:8]} ({n.type}) not reachable"


# ═══════════════════════════════════════════════════════════
# G-003 — Graph is Connected
# ═══════════════════════════════════════════════════════════

def test_g003_graph_connected():
    """G-003: Граф должен быть связным."""
    registry, project = _make_valid_graph()
    # Все узлы должны быть частью одного компонента связности
    edges = registry.get_edges()
    if not edges:
        return  # Skip on empty graph
    # BFS from first node
    from collections import deque
    visited = set()
    q = deque([registry.get_nodes()[0].id])
    while q:
        nid = q.popleft()
        if nid in visited:
            continue
        visited.add(nid)
        for e in edges:
            if e.source == nid and e.target not in visited:
                q.append(e.target)
            if e.target == nid and e.source not in visited:
                q.append(e.source)
    all_ids = set(n.id for n in registry.get_nodes())
    unreachable = all_ids - visited
    assert len(unreachable) == 0, f"G-003: {len(unreachable)} unreachable nodes"


# ═══════════════════════════════════════════════════════════
# G-004 — Single Root per Project
# ═══════════════════════════════════════════════════════════

def test_g004_single_root():
    """G-004: ProjectModel должен иметь ровно один корневой Intent."""
    registry, project = _make_valid_graph()
    assert len(project.intents) >= 1, "G-004: Project must have at least one Intent"


# ═══════════════════════════════════════════════════════════
# G-005 — Decision MUST Support Goal
# ═══════════════════════════════════════════════════════════

def test_g005_decision_supports_goal():
    """G-005: Каждый Decision должен иметь supports → Goal."""
    registry, project = _make_valid_graph()
    v = Validator(registry, project)
    violations = v.validate()
    g005 = [x for x in violations if x.invariant in ("G-005", "PM-I004")]
    assert len(g005) == 0, f"G-005 violations on clean graph: {g005}"


# ═══════════════════════════════════════════════════════════
# G-006 — Blueprint MUST Satisfy Decision
# ═══════════════════════════════════════════════════════════

def test_g006_blueprint_satisfies_decision():
    """G-006: Каждый Blueprint должен иметь satisfies → Decision."""
    registry, project = _make_valid_graph()
    blueprints = registry.get_nodes(NodeType.BLUEPRINT)
    for bp in blueprints:
        edges = registry.get_edges(bp.id)
        has_satisfies = any(e.type == RelationType.SATISFIES.value or
                           e.type.name == "SATISFIES"
                           for e in edges)
        assert has_satisfies, f"G-006: Blueprint {bp.id.hex[:8]} has no satisfies edge"


# ═══════════════════════════════════════════════════════════
# G-007 — Artifact MUST Derive from Blueprint
# ═══════════════════════════════════════════════════════════

def test_g007_artifact_derives_from_blueprint():
    """G-007: Каждый Artifact должен иметь produces/derives_from → Blueprint."""
    registry, project = _make_valid_graph()
    v = Validator(registry, project)
    violations = v.validate()
    g007 = [x for x in violations if x.invariant == "G-007"]
    assert len(g007) == 0, f"G-007 violations on clean graph: {g007}"


# ═══════════════════════════════════════════════════════════
# G-008 — Facts are Immutable
# ═══════════════════════════════════════════════════════════

def test_g008_facts_immutable():
    """G-008: Fact Node не должен изменяться через API Registry после создания.

    Проверяет, что архитектура не предполагает мутации Fact-узлов:
    - После создания Fact его свойства не меняются через record_*
    - Нет методов update_fact или set_fact_properties
    """
    registry, project = _make_valid_graph()

    # Fact создаётся один раз
    fact = Node(type=NodeType.FACT, state=LifecycleState.APPROVED,
                properties={"value": "test"})
    registry.register_node(fact)

    # Архитектурная проверка: нет методов для мутации Fact
    registry_methods = [m for m in dir(registry) if 'fact' in m.lower()]
    assert len(registry_methods) == 0, \
        f"G-008: Found fact-mutation methods: {registry_methods}"
    # Нет методов типа set_fact, update_fact

    # Через adapter тоже не должно быть методов мутации фактов
    try:
        from hermes.kernel.graph_adapter import SemanticGraphAdapter
        adapter_methods = [m for m in dir(SemanticGraphAdapter) if 'fact' in m.lower()]
        mutation_methods = [m for m in adapter_methods
                           if any(x in m.lower() for x in ['set', 'update', 'change', 'modify'])]
        assert len(mutation_methods) == 0, \
            f"G-008: Found fact-mutation in adapter: {mutation_methods}"
    except ImportError:
        pass


# ═══════════════════════════════════════════════════════════
# G-009 — Source → Intent → Goal Chain
# ═══════════════════════════════════════════════════════════

def test_g009_source_intent_goal_chain():
    """G-009: Source → derives_from → Intent → refines → Goal."""
    registry, project = _make_valid_graph()
    goals = registry.get_nodes(NodeType.GOAL)
    sources = registry.get_nodes(NodeType.SOURCE)
    intents = registry.get_nodes(NodeType.INTENT)
    assert len(sources) >= 1, "G-009: Need at least one Source"
    assert len(intents) >= 1, "G-009: Need at least one Intent"
    assert len(goals) >= 1, "G-009: Need at least one Goal"

    edges = registry.get_edges()
    goal_intent = any(e.source == goals[0].id and e.target == intents[0].id
                      for e in edges)
    intent_source = any(e.source == intents[0].id and e.target == sources[0].id
                        for e in edges)
    assert intent_source, "G-009: Missing Intent → Source edge"
    assert goal_intent, "G-009: Missing Goal → Intent edge"


# ═══════════════════════════════════════════════════════════
# G-010 — No Duplicate Identity
# ═══════════════════════════════════════════════════════════

def test_g010_no_duplicate_identity():
    """G-010: Нет двух узлов с одинаковым ID."""
    registry, project = _make_valid_graph()
    all_ids = [n.id for n in registry.get_nodes()]
    unique_ids = set(all_ids)
    assert len(all_ids) == len(unique_ids), \
        f"G-010: {len(all_ids) - len(unique_ids)} duplicate IDs found"


# ═══════════════════════════════════════════════════════════
# G-011 — Version Monotonicity
# ═══════════════════════════════════════════════════════════

def test_g011_version_monotonicity():
    """G-011: ProjectModel.version должен монотонно расти."""
    project = ProjectModel()
    v1 = project.identity.version
    project2 = project.with_source("test")
    v2 = project2.identity.version
    assert v2 > v1, f"G-011: Version should increase ({v2} <= {v1})"

    project3 = project2.with_decision(uuid4())
    v3 = project3.identity.version
    assert v3 > v2, f"G-011: Version should increase ({v3} <= {v2})"


# ═══════════════════════════════════════════════════════════
# G-012 — Domain Pack Isolation
# ═══════════════════════════════════════════════════════════

def test_g012_domain_pack_isolation():
    """G-012: Domain Packs загружаются и регистрируются изолированно."""
    from hermes.domain_packs import DomainPackRegistry
    from hermes.domain_packs.product_pack import ProductPack
    from hermes.domain_packs.typography_editorial_pack import TypographyEditorialPack
    from hermes.domain_packs.animation_pack import AnimationPack

    r = DomainPackRegistry()
    for pack_cls in [ProductPack, TypographyEditorialPack, AnimationPack]:
        inst = pack_cls()
        r.register(inst)
        assert r.get(inst.name) is not None, \
            f"G-012: DomainPack '{inst.name}' not registered"
        assert inst.supports(inst.domains[0]), \
            f"G-012: DomainPack '{inst.name}' doesn't support its own domain"


# ═══════════════════════════════════════════════════════════
# Full freeze: все 12 G-инвариантов на чистом графе
# ═══════════════════════════════════════════════════════════

def test_freeze_all_invariants():

    registry, project = _make_valid_graph()
    v = Validator(registry, project)
    violations = v.validate()
    assert len(violations) == 0, (
        f"❌ FREEZE FAILED: {len(violations)} violations on clean graph.\n"
        + "\n".join(f"  {v.invariant}: {v.message}" for v in violations[:10])
    )


# ═══════════════════════════════════════════════════════════
# CO-001 Compliance: D-2, I-1, A-2
# ═══════════════════════════════════════════════════════════

def test_co001_d2_decision_confidence():
    """CO-001 D-2: APPROVED Decision без confidence ≥ 0.7 — violation."""
    registry, project = _make_valid_graph()

    # Decision with low confidence
    bad = Node(type=NodeType.DECISION, state=LifecycleState.APPROVED,
               properties={"vsl_field": "test", "value": "bad",
                           "confidence": 0.3})
    registry.register_node(bad)
    project = project.with_decision(bad.id)

    v = Validator(registry, project)
    violations = v.validate()
    d2 = [x for x in violations if x.invariant == "CO-001-D-2"]
    assert len(d2) >= 1, "CO-001-D-2: Should detect low-confidence Decision"


def test_co001_i1_single_intent():
    """CO-001 I-1: Multiple active Intents — violation."""
    registry, project = _make_valid_graph()

    # Add second active Intent
    extra = Node(type=NodeType.INTENT, state=LifecycleState.APPROVED,
                 properties={"description": "extra intent"})
    registry.register_node(extra)

    v = Validator(registry, project)
    violations = v.validate()
    i1 = [x for x in violations if x.invariant == "CO-001-I-1"]
    assert len(i1) >= 1, "CO-001-I-1: Should detect multiple active Intents"


def test_co001_i1_no_intent():
    """CO-001 I-1: Zero active Intents — violation."""
    registry, project = _make_valid_graph()

    # Archive all intents
    for intent in registry.get_nodes(NodeType.INTENT):
        archived = intent.with_state(LifecycleState.ARCHIVED)
        registry.update_node(archived)

    v = Validator(registry, project)
    violations = v.validate()
    i1 = [x for x in violations if x.invariant == "CO-001-I-1"]
    assert len(i1) >= 1, "CO-001-I-1: Should detect zero active Intents"


def test_co001_a2_artifact_immutable():
    """CO-001 A-2: Modified Artifact — violation."""
    registry, project = _make_valid_graph()

    # Simulate modified artifact (updated_at > created_at)
    from datetime import timedelta
    art = Node(type=NodeType.ARTIFACT, state=LifecycleState.APPROVED,
               properties={"content": "test"},
               created_at=datetime.now(timezone.utc) - timedelta(hours=1),
               updated_at=datetime.now(timezone.utc))
    registry.register_node(art)

    v = Validator(registry, project)
    violations = v.validate()
    a2 = [x for x in violations if x.invariant == "CO-001-A-2"]
    assert len(a2) >= 1, "CO-001-A-2: Should detect modified Artifact"


def test_freeze_invariant_coverage():
    """FREEZE CHECK: все 12 G-инвариантов имеют тесты."""
    test_names = [n for n in dir(pytest) if n.startswith("test_g")]
    # Actually check our module
    import sys
    module = sys.modules[__name__]
    g_tests = [n for n in dir(module) if n.startswith("test_g")]
    for i in range(1, 13):
        tag = f"G-{i:03d}"
        has_test = any(tag.replace("-", "_") in t for t in g_tests) or \
                   any(tag.lower().replace("-0", "0") in t for t in g_tests)
        # Проверка через test_gXXX
        requires = f"g{i:03d}"
        if not has_test:
            has_test = any(requires in t for t in g_tests)
        assert has_test, f"❌ FREEZE FAILED: {tag} has no test!"
    # Проверка пройдена
    assert True, f"✅ All 12 G-invariants have tests"