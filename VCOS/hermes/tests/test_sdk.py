"""VCOS — Tests: SDK / VCOSClient (Phase 4B)

Проверяет публичное API: create_session, ask, export, fork, diff, memory.
Не требует LLM.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.sdk.vcos_client import VCOSClient, Session


def test_create_session():
    """Создание сессии через SDK."""
    client = VCOSClient()
    session = client.create_session("одежда")
    assert session.id is not None
    assert session.category == "одежда"
    assert session.orchestrator is not None
    assert len(session.id) > 0


def test_create_session_no_category():
    """Создание сессии без категории."""
    client = VCOSClient()
    session = client.create_session()
    assert session.id is not None
    assert session.category == ""


def test_get_session():
    """Get session по ID."""
    client = VCOSClient()
    s1 = client.create_session("одежда")
    s2 = client.get_session(s1.id)
    assert s2 is not None
    assert s2.id == s1.id


def test_list_sessions():
    """List sessions возвращает все сессии."""
    client = VCOSClient()
    client.create_session("одежда")
    client.create_session("кино")
    assert len(client.list_sessions()) == 2


def test_close_session():
    """Close session архивирует проект."""
    client = VCOSClient()
    session = client.create_session("одежда")
    assert client.close_session(session.id) is True
    # Можно получить, но статус done/archived


def test_close_unknown_session():
    """Close несуществующей сессии → False."""
    client = VCOSClient()
    assert client.close_session("nonexistent") is False


def test_ask_returns_question():
    """Ask возвращает вопрос (через SDE)."""
    client = VCOSClient()
    session = client.create_session()
    result = client.ask(session.id, "одежда")
    assert result["type"] == "question" or result.get("type") == "question"


def test_select_profile():
    """Select profile через get_profile по ключу."""
    from hermes.design.director_profiles import get_profile
    profile = get_profile("harari")
    assert profile is not None
    assert profile.name == "Юваль Харари (эстетика информации)"


def test_export_no_session():
    """Export с несуществующей сессией → ошибка."""
    client = VCOSClient()
    try:
        client.export("nonexistent")
        assert False
    except ValueError:
        pass


def test_search_memory():
    """Search memory работает через SDK."""
    client = VCOSClient()
    session = client.create_session("одежда")
    client.remember("test_fact", "синяя рубашка", "user.preferences")
    results = client.search_memory("рубашка")
    assert len(results) >= 1


def test_sdk_summary():
    """VCOSClient.summary() — читаемая сводка."""
    client = VCOSClient()
    client.create_session("одежда")
    client.create_session("кино")
    summary = client.summary()
    assert summary["sessions"] == 2
    assert "runtime" in summary
    assert "memory" in summary


def test_fork_session():
    """Fork создаёт новую сессию-ветку (без LLM)."""
    from hermes.orchestrator.core import Orchestrator
    from hermes.kernel.snapshot_manager import SnapshotManager
    from hermes.kernel.registry import Registry
    from hermes.kernel.project_model import ProjectModel, ProjectIdentity

    # Создаём чистый SnapshotManager
    registry = Registry()
    project = ProjectModel(identity=ProjectIdentity(id="test-fork", version=1))
    sm = SnapshotManager(registry, project)

    # Создаём снэпшот
    snap = sm.create()
    assert sm.chain._latest_id == snap.id

    # Fork
    branch_project, branch_info = sm.fork(snap.id, "эксперимент")
    assert branch_project is not None
    assert branch_project.identity.id != project.identity.id
    assert branch_info.name == "эксперимент"
    assert branch_info.parent_project_id == "test-fork"


def test_different_session_ids():
    """Каждая сессия имеет уникальный ID."""
    client = VCOSClient()
    s1 = client.create_session("одежда")
    s2 = client.create_session("кино")
    assert s1.id != s2.id