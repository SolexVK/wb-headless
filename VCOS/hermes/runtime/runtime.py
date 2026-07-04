"""VCOS — Runtime v1 (Phase 4B)

Жизненный цикл проекта (CP-001.9):
  CREATED → INITIALIZED → ACTIVE → EXPORTING → EXPORTED → ARCHIVED / FAILED

Каждый переход — событие, на которое можно подписаться.
"""

from dataclasses import dataclass, field
from typing import Optional, Callable
from enum import Enum
from datetime import datetime, timezone
from uuid import UUID, uuid4


class ProjectStatus(str, Enum):
    """Состояния когнитивного жизненного цикла проекта.

    Spec (doc 183): когнитивные фазы проектирования, а не технические статусы.

    CREATED → INTERVIEW → UNDERSTANDING → DESIGN → VALIDATION → COMPILATION → COMPLETED
    Каждый статус = реальная фаза когнитивного цикла.
    """
    CREATED      = "created"       # Проект создан
    INTERVIEW    = "interview"     # Сбор информации, уточнение задачи
    UNDERSTANDING = "understanding"  # Осмысление, построение онтологии
    DESIGN       = "design"        # Принятие проектных решений
    VALIDATION   = "validation"   # Проверка решений
    COMPILATION  = "compilation"   # Компиляция Blueprint → Artifact
    COMPLETED    = "completed"     # Проект завершён
    FAILED       = "failed"        # Ошибка


# ═══════════════════════════════════════════
# События жизненного цикла
# ═══════════════════════════════════════════

@dataclass
class LifecycleEvent:
    """Событие жизненного цикла."""
    project_id: str
    from_status: Optional[ProjectStatus]
    to_status: ProjectStatus
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    reason: str = ""
    metadata: dict = field(default_factory=dict)


# Тип для подписчика на события
LifecycleHandler = Callable[[LifecycleEvent], None]


# ═══════════════════════════════════════════
# RunInfo — метаданные рантайма
# ═══════════════════════════════════════════

@dataclass
class ProjectRunInfo:
    """Информация о запуске проекта."""
    project_id: str
    status: ProjectStatus = ProjectStatus.CREATED
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    started_at: str = ""
    completed_at: str = ""
    phase: int = 0
    total_phases: int = 7  # 0-6 в Orchestrator
    error: str = ""
    history: list[LifecycleEvent] = field(default_factory=list)


# ═══════════════════════════════════════════
# RuntimeEngine
# ═══════════════════════════════════════════

VALID_TRANSITIONS = {
    ProjectStatus.CREATED:        [ProjectStatus.INTERVIEW, ProjectStatus.FAILED],
    ProjectStatus.INTERVIEW:      [ProjectStatus.UNDERSTANDING, ProjectStatus.FAILED],
    ProjectStatus.UNDERSTANDING:  [ProjectStatus.DESIGN, ProjectStatus.COMPILATION, ProjectStatus.FAILED],
    ProjectStatus.DESIGN:         [ProjectStatus.VALIDATION, ProjectStatus.FAILED],
    ProjectStatus.VALIDATION:     [ProjectStatus.COMPILATION, ProjectStatus.FAILED],
    ProjectStatus.COMPILATION:    [ProjectStatus.COMPLETED, ProjectStatus.FAILED],
    ProjectStatus.COMPLETED:      [],
    ProjectStatus.FAILED:         [],
}


class RuntimeEngine:
    """Движок жизненного цикла проекта (Phase 4B).

    Управляет:
      - Переходами состояний (CP-001.9)
      - Событиями и подписками
      - Таймаутами сессий
      - Проектами в памяти
    """

    def __init__(self):
        self._projects: dict[str, ProjectRunInfo] = {}
        self._handlers: dict[ProjectStatus, list[LifecycleHandler]] = {
            s: [] for s in ProjectStatus
        }
        self._global_handlers: list[LifecycleHandler] = []

    # ─── Project management ─────────────────────────────────

    def create_project(self, project_id: str) -> ProjectRunInfo:
        """Создать новый проект."""
        info = ProjectRunInfo(project_id=project_id)
        self._projects[project_id] = info

        event = LifecycleEvent(
            project_id=project_id,
            from_status=None,
            to_status=ProjectStatus.CREATED,
            reason="Project created",
        )
        info.history.append(event)
        self._emit(event)

        return info

    def get_project(self, project_id: str) -> Optional[ProjectRunInfo]:
        return self._projects.get(project_id)

    def list_projects(self, status: Optional[ProjectStatus] = None) -> list[ProjectRunInfo]:
        projects = list(self._projects.values())
        if status:
            projects = [p for p in projects if p.status == status]
        return projects

    def delete_project(self, project_id: str) -> bool:
        if project_id in self._projects:
            del self._projects[project_id]
            return True
        return False

    # ─── Status transitions ──────────────────────────────────

    def transition(self, project_id: str, to_status: ProjectStatus,
                   reason: str = "") -> ProjectRunInfo:
        """Перевести проект в новое состояние (CP-001.9).

        Args:
            project_id: ID проекта
            to_status: целевое состояние
            reason: причина перехода

        Returns:
            ProjectRunInfo (с новым статусом)

        Raises:
            ValueError: если переход недопустим или проект не найден
        """
        info = self._projects.get(project_id)
        if not info:
            raise ValueError(f"Project {project_id} not found")

        from_status = info.status
        allowed = VALID_TRANSITIONS.get(from_status, [])

        if to_status not in allowed:
            raise ValueError(
                f"Invalid transition: {from_status.value} → {to_status.value}. "
                f"Allowed: {[s.value for s in allowed]}"
            )

        # Обновить статус
        old_status = info.status
        info.status = to_status

        # Временные метки
        now = datetime.now(timezone.utc).isoformat()
        if to_status == ProjectStatus.UNDERSTANDING and not info.started_at:
            info.started_at = now
        if to_status in (ProjectStatus.COMPLETED, ProjectStatus.FAILED):
            info.completed_at = now
        if to_status == ProjectStatus.FAILED and reason:
            info.error = reason

        # Событие
        event = LifecycleEvent(
            project_id=project_id,
            from_status=old_status,
            to_status=to_status,
            reason=reason,
        )
        info.history.append(event)
        self._emit(event)

        return info

    # ─── Phase tracking ─────────────────────────────────────

    def set_phase(self, project_id: str, phase: int) -> None:
        """Установить текущую фазу проекта."""
        info = self._projects.get(project_id)
        if info:
            info.phase = phase

    # ─── Event system ────────────────────────────────────────

    def on(self, status: ProjectStatus, handler: LifecycleHandler) -> None:
        """Подписаться на события перехода в указанный статус."""
        self._handlers[status].append(handler)

    def on_any(self, handler: LifecycleHandler) -> None:
        """Подписаться на все события."""
        self._global_handlers.append(handler)

    def _emit(self, event: LifecycleEvent) -> None:
        """Отправить событие всем подписчикам."""
        # Специфичные для статуса
        for handler in self._handlers.get(event.to_status, []):
            handler(event)
        # Глобальные
        for handler in self._global_handlers:
            handler(event)

    # ─── Summary ─────────────────────────────────────────────

    def summary(self) -> dict:
        return {
            "total_projects": len(self._projects),
            "by_status": {
                s.value: len([p for p in self._projects.values() if p.status == s])
                for s in ProjectStatus
            },
            "active_projects": len([p for p in self._projects.values()
                                    if p.status in (ProjectStatus.UNDERSTANDING, ProjectStatus.INTERVIEW)]),
        }