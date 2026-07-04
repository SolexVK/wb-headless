"""VCOS — SDK v1 (Phase 4B)

Публичное API для работы с VCOS извне.

Использование:
    from hermes.sdk.vcos_client import VCOSClient

    client = VCOSClient()

    # Создать сессию
    session = client.create_session(category="одежда")

    # Пройти по циклу
    session = client.ask(session.id, "Рубашка оверсайз, голубая")
    session = client.ask(session.id, "Девушка на улице, солнечный день")

    # Выбрать профиль
    session = client.select_profile(session.id, "харари")

    # Экспорт
    prompt = client.export(session.id, "chatgpt")
    print(prompt)

    # Fork проекта
    branch = client.fork(session.id, "эксперимент с холодным светом")

    # Diff
    changes = client.diff(session.id, branch.id)
"""

from typing import Optional
from datetime import datetime, timezone
from uuid import uuid4

from hermes.orchestrator.core import Orchestrator
from hermes.runtime.runtime import RuntimeEngine, ProjectStatus
from hermes.memory.memory import MemoryStore
from hermes.renderers.dsl_compiler import DSLCompiler


class Session:
    """Сессия VCOS — пользовательская обёртка над Orchestrator.

    Предоставляет:
      - Жизненный цикл через RuntimeEngine
      - Сохранение контекста через MemoryStore
      - Fork/Diff через SnapshotManager
    """

    def __init__(self, session_id: str, category: str = "",
                 orchestrator: Optional[Orchestrator] = None):
        self.id = session_id
        self.category = category
        self.orchestrator = orchestrator or Orchestrator()
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.last_prompt = ""

    def __repr__(self) -> str:
        return f"Session(id={self.id[:8]}, cat={self.category}, status={self.orchestrator.state.status})"


class VCOSClient:
    """Публичный клиент VCOS.

    Единая точка входа для внешних потребителей.
    """

    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self.runtime = RuntimeEngine()
        self.memory = MemoryStore()
        self.dsl = DSLCompiler()

    # ═══════════════════════════════════════
    # Session management
    # ═══════════════════════════════════════

    def create_session(self, category: str = "") -> Session:
        """Создать новую сессию.

        Args:
            category: опциональная категория товара (одежда, обувь, кино, wb...)

        Returns:
            Session с готовым Orchestrator
        """
        session_id = f"vcos_{uuid4().hex[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        # Runtime: CREATED
        self.runtime.create_project(session_id)
        self.runtime.transition(session_id, ProjectStatus.INTERVIEW,
                                reason=f"Session created, category={category}")

        orchestrator = Orchestrator()
        if category:
            orchestrator.start_new_session(category)
        else:
            orchestrator.start_new_session()

        # Runtime: ACTIVE
        self.runtime.transition(session_id, ProjectStatus.UNDERSTANDING,
                                reason="Orchestrator ready")

        session = Session(
            session_id=session_id,
            category=category,
            orchestrator=orchestrator,
        )
        self._sessions[session_id] = session

        # Memory: сохраняем факт создания
        self.memory.store(
            f"session_{session_id}",
            {"category": category, "created": session.created_at},
            f"project.{session_id}.facts",
        )

        return session

    def get_session(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    def list_sessions(self, active_only: bool = False) -> list[Session]:
        sessions = list(self._sessions.values())
        if active_only:
            return [s for s in sessions if s.orchestrator.state.status not in ("done", "archived")]
        return sessions

    def close_session(self, session_id: str) -> bool:
        """Завершить сессию."""
        session = self._sessions.get(session_id)
        if not session:
            return False

        # Archive runtime
        try:
            self.runtime.transition(session_id, ProjectStatus.COMPLETED,
                                    reason="Session closed by user")
        except ValueError:
            pass  # уже в финальном состоянии

        # Memory
        self.memory.store(
            f"session_{session_id}_completed",
            {"completed_at": datetime.now(timezone.utc).isoformat()},
            f"project.{session_id}.facts",
        )

        return True

    # ═══════════════════════════════════════
    # Cognitive cycle
    # ═══════════════════════════════════════

    def ask(self, session_id: str, message: str) -> dict:
        """Отправить ответ в когнитивный цикл.

        Args:
            session_id: ID сессии
            message: ответ пользователя

        Returns:
            Результат: вопрос, информация или готовый промпт
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        result = session.orchestrator.submit_answer(message)

        # Track phase
        try:
            phase = session.orchestrator._phase
            self.runtime.set_phase(session_id, phase)
        except AttributeError:
            pass

        # Если экспортирован — сохраняем промпт
        if result.get("type") == "done" and "prompt" in result:
            session.last_prompt = result["prompt"]
            try:
                self.runtime.transition(session_id, ProjectStatus.COMPLETED,
                                        reason="Prompt exported")
            except ValueError:
                pass

            # Memory: сохраняем экспорт
            self.memory.store(
                f"session_{session_id}_export",
                {
                    "model": result.get("model", ""),
                    "prompt_preview": result["prompt"][:200],
                },
                f"project.{session_id}.facts",
            )

        return result

    # ═══════════════════════════════════════
    # Profile selection
    # ═══════════════════════════════════════

    def select_profile(self, session_id: str, profile_name: str) -> dict:
        """Выбрать профиль режиссёра/дизайнера.

        Args:
            session_id: ID сессии
            profile_name: имя профиля (харари, куросава, тарантино...)

        Returns:
            Результат с вопросом о направлении
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Симулируем выбор профиля через ask
        return self.ask(session_id, profile_name)

    # ═══════════════════════════════════════
    # Export
    # ═══════════════════════════════════════

    def export(self, session_id: str, model: str = "chatgpt") -> str:
        """Экспортировать промпт.

        Args:
            session_id: ID сессии
            model: 'chatgpt', 'midjourney', 'nanobanana', 'flux', 'sdxl'

        Returns:
            Готовый промпт
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        try:
            self.runtime.transition(session_id, ProjectStatus.COMPILATION,
                                    reason=f"Exporting to {model}")
        except ValueError:
            pass

        result = self.ask(session_id, model)

        if result.get("type") == "done" and "prompt" in result:
            return result["prompt"]

        # If the session hasn't completed yet, use DSL compiler
        project_data = session.orchestrator.graph.project_data()
        project_data["model_target"] = model
        prompt = self.dsl.full_compile(project_data, model)
        session.last_prompt = prompt

        try:
            self.runtime.transition(session_id, ProjectStatus.COMPLETED,
                                    reason=f"Exported to {model}")
        except ValueError:
            pass

        return prompt

    def switch_model(self, session_id: str, model: str) -> str:
        """Переключить модель после первого экспорта."""
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        result = session.orchestrator.switch_model(model)
        if result.get("type") == "done" and "prompt" in result:
            return result["prompt"]
        return ""

    # ═══════════════════════════════════════
    # Fork & Diff
    # ═══════════════════════════════════════

    def fork(self, session_id: str, branch_name: str = "") -> Session:
        """Создать ветку от текущего состояния сессии.

        Args:
            session_id: ID исходной сессии
            branch_name: имя новой ветки

        Returns:
            Новая Session (ветка)
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Получить последний снэпшот
        latest = session.orchestrator.graph.snapshots.get_latest()
        if not latest:
            raise ValueError("No snapshots to fork from")

        # Fork через SnapshotManager
        branch_project, branch_info = session.orchestrator.graph.snaps.fork(
            latest.id, branch_name
        )

        # Создать новую сессию
        branch_session_id = branch_project.identity.id
        branch_session = Session(
            session_id=branch_session_id,
            category=session.category,
            orchestrator=session.orchestrator,  # shared orchestrator
        )
        branch_session.orchestrator.project = branch_project
        self._sessions[branch_session_id] = branch_session

        # Runtime
        self.runtime.create_project(branch_session_id)
        self.runtime.transition(branch_session_id, ProjectStatus.INTERVIEW,
                                reason=f"Forked from {session_id}")
        self.runtime.transition(branch_session_id, ProjectStatus.UNDERSTANDING,
                                reason=f"Branch: {branch_name}")

        return branch_session

    def diff(self, session_a_id: str, session_b_id: str) -> dict:
        """Сравнить две сессии.

        Args:
            session_a_id: ID первой сессии
            session_b_id: ID второй сессии

        Returns:
            Changeset с различиями
        """
        session_a = self._sessions.get(session_a_id)
        session_b = self._sessions.get(session_b_id)

        if not session_a or not session_b:
            raise ValueError("Session not found")

        # Получить последние снэпшоты
        snap_a = session_a.orchestrator.graph.snapshots.get_latest()
        snap_b = session_b.orchestrator.graph.snapshots.get_latest()

        if not snap_a or not snap_b:
            raise ValueError("No snapshots to diff")

        changeset = session_a.orchestrator.graph.snaps.diff(snap_a.id, snap_b.id)
        return {
            "has_changes": changeset.has_changes,
            "summary": changeset.summary(),
            "added_nodes": len(changeset.added_nodes),
            "removed_nodes": len(changeset.removed_nodes),
            "modified_nodes": len(changeset.modified_nodes),
            "added_edges": len(changeset.added_edges),
        }

    # ═══════════════════════════════════════
    # Memory queries
    # ═══════════════════════════════════════

    def search_memory(self, query: str, namespace: str = "user.preferences",
                      limit: int = 5) -> list:
        """Поиск в памяти.

        Args:
            query: текст запроса
            namespace: namespace для поиска
            limit: максимум результатов

        Returns:
            Список MemoryResult
        """
        return self.memory.search(query, namespace, limit)

    def remember(self, key: str, value: str, namespace: str = "user.preferences") -> None:
        """Сохранить факт в память."""
        self.memory.store(key, value, namespace)

    # ═══════════════════════════════════════
    # Utilities
    # ═══════════════════════════════════════

    def summary(self) -> dict:
        return {
            "sessions": len(self._sessions),
            "runtime": self.runtime.summary(),
            "memory": self.memory.summary(),
        }