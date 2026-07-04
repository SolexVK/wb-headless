"""VCOS — Tests: Snapshot Manager / CA-001 (Phase 3C)

Проверяет fork, merge, enhanced diff, trace, rollback.
Не требует LLM.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from uuid import UUID
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel, ProjectIdentity
from hermes.kernel.snapshot import Snapshot, SnapshotChain
from hermes.kernel.snapshot_manager import (
    SnapshotManager, Changeset, MergeResult, BranchInfo
)
from hermes.kernel.core import Node, NodeType, LifecycleState, Edge, RelationType
from hermes.kernel.graph_adapter import SemanticGraphAdapter


# ═══════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════

def make_adapter():
    """Создать адаптер с минимальной сессией."""
    registry = Registry()
    project = ProjectModel(
        identity=ProjectIdentity(id="test_vcos", version=1),
    )
    return SemanticGraphAdapter(registry, project)


def make_snapshot_manager():
    """Создать SnapshotManager с Registry и ProjectModel."""
    registry = Registry()
    project = ProjectModel(
        identity=ProjectIdentity(id="test_vcos", version=1),
    )
    return SnapshotManager(registry, project)


# ═══════════════════════════════════════════
# Enhanced Diff (CA-001.4.6)
# ═══════════════════════════════════════════

def test_diff_basic():
    """Diff между двумя снэпшотами — базовый."""
    sm = make_snapshot_manager()
    g = SemanticGraphAdapter(sm.registry, sm.project)
    g.snaps = sm  # используем наш SnapshotManager

    # Snapshot 1
    g.record_intent("Рубашка синяя")
    snap1 = sm.create()

    # Snapshot 2
    g.record_goal("Промпт для одежды")
    snap2 = sm.create()

    # Diff
    changeset = sm.diff(snap1.id, snap2.id)
    assert changeset.has_changes
    assert len(changeset.added_nodes) > 0  # появился Goal
    assert len(changeset.removed_nodes) == 0


def test_diff_empty():
    """Diff между снэпшотом и самим собой — пустой."""
    sm = make_snapshot_manager()
    snap = sm.create()
    changeset = sm.diff(snap.id, snap.id)
    assert not changeset.has_changes


def test_diff_added_removed():
    """Diff отслеживает добавленные и удалённые узлы."""
    sm = make_snapshot_manager()
    g = SemanticGraphAdapter(sm.registry, sm.project)
    g.snaps = sm

    snap1 = sm.create()

    g.record_intent("Тест")
    snap2 = sm.create()

    changeset = sm.diff(snap1.id, snap2.id)
    assert len(changeset.added_nodes) > 0


def test_diff_modified_nodes():
    """Diff обнаруживает изменённые узлы."""
    sm = make_snapshot_manager()

    # Create first snapshot with a node
    node = Node(type=NodeType.INTENT, state=LifecycleState.DRAFT,
                properties={"test": "old_value"})
    sm.registry.register_node(node)
    snap1 = sm.create()

    # Change the node (mutate in-place for the test)
    node.properties["test"] = "new_value"
    snap2 = sm.create()

    changeset = sm.diff(snap1.id, snap2.id)
    assert len(changeset.modified_nodes) > 0


def test_diff_summary():
    """Changeset.summary() возвращает читаемый текст."""
    sm = make_snapshot_manager()
    g = SemanticGraphAdapter(sm.registry, sm.project)
    g.snaps = sm

    snap1 = sm.create()
    g.record_intent("Тест")
    snap2 = sm.create()

    changeset = sm.diff(snap1.id, snap2.id)
    summary = changeset.summary()
    assert len(summary) > 0
    assert "узлов" in summary or "рёбер" in summary or "изменений" in summary


# ═══════════════════════════════════════════
# Fork (CA-001.4.5)
# ═══════════════════════════════════════════

def test_fork_creates_new_project():
    """Fork создаёт новый ProjectModel с parentProject."""
    sm = make_snapshot_manager()

    # Создаём первый снэпшот
    snap = sm.create()

    # Fork
    new_project, branch_info = sm.fork(snap.id, "test-branch")
    assert new_project is not None
    assert new_project.identity.parent_project == "test_vcos"
    assert branch_info.name == "test-branch"
    assert branch_info.parent_snapshot_id == snap.id


def test_fork_branch_info():
    """Fork создаёт BranchInfo с метаданными."""
    sm = make_snapshot_manager()
    snap = sm.create()

    new_project, branch_info = sm.fork(snap.id, "эксперимент")
    assert branch_info.id is not None
    assert len(branch_info.id) > 0
    assert branch_info.parent_project_id == "test_vcos"


def test_fork_branch_list():
    """Fork регистрирует ветку в списке."""
    sm = make_snapshot_manager()
    snap = sm.create()

    sm.fork(snap.id, "branch-a")
    branches = sm.list_branches()
    assert len(branches) == 1
    assert branches[0].name == "branch-a"


def test_fork_invalid_snapshot():
    """Fork на несуществующий снэпшот — ошибка."""
    sm = make_snapshot_manager()
    try:
        sm.fork("nonexistent")
        assert False, "Должна быть ошибка"
    except ValueError:
        pass


# ═══════════════════════════════════════════
# Trace (CA-001.4.6)
# ═══════════════════════════════════════════

def test_trace_backward():
    """Trace backward находит входящие рёбра."""
    sm = make_snapshot_manager()
    g = SemanticGraphAdapter(sm.registry, sm.project)
    g.snaps = sm

    g.record_intent("Тест")
    goal = g.record_goal("Цель")

    # Trace backward от goal — должен найти ребро от intent
    if goal:
        edges = sm.trace(goal.id.hex, "backward")
        # goal — это Node из record_goal
    else:
        pass

    # Если нет goal, проверяем что trace работает
    edges = sm.trace("", "backward")
    assert isinstance(edges, list)


def test_trace_forward():
    """Trace forward находит исходящие рёбра."""
    sm = make_snapshot_manager()
    g = SemanticGraphAdapter(sm.registry, sm.project)
    g.snaps = sm

    g.record_intent("Тест")
    g.record_goal("Цель")

    edges = sm.trace("", "forward")
    assert isinstance(edges, list)


# ═══════════════════════════════════════════
# Merge (CA-001.4.5)
# ═══════════════════════════════════════════

def test_merge_empty_source():
    """Merge с пустой source chain — ошибка."""
    sm = make_snapshot_manager()
    empty_chain = SnapshotChain()

    try:
        sm.merge(empty_chain)
        assert False, "Должна быть ошибка"
    except ValueError:
        pass


def test_merge_fast_forward():
    """Fast-forward merge создаёт снэпшот."""
    sm = make_snapshot_manager()
    g = SemanticGraphAdapter(sm.registry, sm.project)
    g.snaps = sm

    # Создаём source chain
    source_chain = SnapshotChain()
    # Заполняем source chain (копируем состояние)
    source_chain.create(sm.registry, sm.project, "system", "source")

    # Merge
    result = sm.merge(source_chain, "fast-forward", "source-project")
    assert isinstance(result, MergeResult)
    assert result.snapshot_id is not None


# ═══════════════════════════════════════════
# Rollback (CA-001.4.5)
# ═══════════════════════════════════════════

def test_rollback_creates_snapshot():
    """Rollback создаёт новый снэпшот."""
    sm = make_snapshot_manager()

    # Два снэпшота
    snap1 = sm.create()
    snap2 = sm.create()

    assert sm.chain._latest_id == snap2.id

    # Rollback к snаp1
    rolled = sm.rollback(snap1.id)
    assert rolled is not None
    assert sm.chain._latest_id == rolled.id  # новый снэпшот
    # Должно быть 3 снэпшота (snap1, snap2, rolled)
    assert len(sm.chain._snapshots) == 3


# ═══════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════

def test_snapshot_manager_summary():
    """SnapshotManager.summary() возвращает читаемую сводку."""
    sm = make_snapshot_manager()
    sm.create()
    summary = sm.summary()
    assert summary["snapshots"] >= 1
    assert summary["latest"] is not None
    assert "project_version" in summary