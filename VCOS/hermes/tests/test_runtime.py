"""VCOS — Tests: Runtime / Lifecycle (Phase 4B)

Проверяет жизненный цикл проекта, переходы состояний, события.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.runtime.runtime import (
    RuntimeEngine, ProjectStatus, ProjectRunInfo, LifecycleEvent
)


def test_create_project():
    """Создание проекта — статус CREATED."""
    engine = RuntimeEngine()
    info = engine.create_project("test-1")
    assert info.status == ProjectStatus.CREATED
    assert info.project_id == "test-1"


def test_transition_created_to_initialized():
    """CREATED → INITIALIZED — допустимый переход."""
    engine = RuntimeEngine()
    engine.create_project("test-1")
    info = engine.transition("test-1", ProjectStatus.INTERVIEW)
    assert info.status == ProjectStatus.INTERVIEW


def test_transition_full_lifecycle():
    """Полный когнитивный жизненный цикл: CREATED → INTERVIEW → UNDERSTANDING → DESIGN → VALIDATION → COMPILATION → COMPLETED."""
    engine = RuntimeEngine()
    engine.create_project("test-1")
    engine.transition("test-1", ProjectStatus.INTERVIEW)
    engine.transition("test-1", ProjectStatus.UNDERSTANDING)
    engine.transition("test-1", ProjectStatus.DESIGN)
    engine.transition("test-1", ProjectStatus.VALIDATION)
    engine.transition("test-1", ProjectStatus.COMPILATION)
    engine.transition("test-1", ProjectStatus.COMPLETED)

    info = engine.get_project("test-1")
    assert info.status == ProjectStatus.COMPLETED


def test_transition_invalid():
    """CREATED → EXPORTED — недопустимый переход."""
    engine = RuntimeEngine()
    engine.create_project("test-1")
    try:
        engine.transition("test-1", ProjectStatus.COMPLETED)
        assert False, "Должна быть ошибка"
    except ValueError as e:
        assert "Invalid transition" in str(e)


def test_transition_failed():
    """Любой → FAILED — допустимо."""
    engine = RuntimeEngine()
    engine.create_project("test-1")
    engine.transition("test-1", ProjectStatus.INTERVIEW)
    info = engine.transition("test-1", ProjectStatus.FAILED, "Ошибка интеграции")
    assert info.status == ProjectStatus.FAILED
    assert "Ошибка" in info.error


def test_transition_unknown_project():
    """Переход несуществующего проекта — ошибка."""
    engine = RuntimeEngine()
    try:
        engine.transition("nonexistent", ProjectStatus.UNDERSTANDING)
        assert False
    except ValueError:
        pass


def test_list_projects():
    """Список проектов с фильтром по статусу."""
    engine = RuntimeEngine()
    engine.create_project("p1")
    engine.create_project("p2")
    engine.create_project("p3")

    all_projects = engine.list_projects()
    assert len(all_projects) == 3

    engine.transition("p1", ProjectStatus.INTERVIEW)
    engine.transition("p2", ProjectStatus.INTERVIEW)
    engine.transition("p1", ProjectStatus.UNDERSTANDING)

    active = engine.list_projects(ProjectStatus.UNDERSTANDING)
    assert len(active) == 1
    assert active[0].project_id == "p1"


def test_set_phase():
    """Установка фазы проекта."""
    engine = RuntimeEngine()
    engine.create_project("p1")
    engine.set_phase("p1", 3)
    info = engine.get_project("p1")
    assert info.phase == 3


def test_delete_project():
    """Удаление проекта."""
    engine = RuntimeEngine()
    engine.create_project("p1")
    assert engine.get_project("p1") is not None
    assert engine.delete_project("p1") is True
    assert engine.get_project("p1") is None
    assert engine.delete_project("p1") is False


def test_lifecycle_events():
    """События жизненного цикла записываются."""
    engine = RuntimeEngine()
    engine.create_project("p1")
    engine.transition("p1", ProjectStatus.INTERVIEW)
    engine.transition("p1", ProjectStatus.UNDERSTANDING)

    info = engine.get_project("p1")
    assert len(info.history) == 3  # created, initialized, active
    assert info.history[0].to_status == ProjectStatus.CREATED
    assert info.history[1].to_status == ProjectStatus.INTERVIEW
    assert info.history[2].to_status == ProjectStatus.UNDERSTANDING


def test_events_handler():
    """Подписка на события жизненного цикла."""
    engine = RuntimeEngine()
    events = []

    engine.on(ProjectStatus.UNDERSTANDING, lambda e: events.append(("active", e.project_id)))
    engine.on_any(lambda e: events.append(("any", e.project_id)))

    engine.create_project("p1")
    engine.transition("p1", ProjectStatus.INTERVIEW)
    engine.transition("p1", ProjectStatus.UNDERSTANDING)

    assert ("active", "p1") in events
    # Проверить что global handlers тоже сработали
    any_events = [e for e in events if e[0] == "any"]
    assert len(any_events) == 3  # created, initialized, active


def test_runtime_summary():
    """RuntimeEngine.summary() — читаемая сводка."""
    engine = RuntimeEngine()
    engine.create_project("p1")
    engine.create_project("p2")
    engine.transition("p1", ProjectStatus.INTERVIEW)
    engine.transition("p1", ProjectStatus.UNDERSTANDING)

    summary = engine.summary()
    assert summary["total_projects"] == 2
    assert summary["active_projects"] == 1
    assert "by_status" in summary