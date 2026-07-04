"""VCOS — ProjectModel v2 (Immutable)

Проекция Semantic Graph для конкретного проекта.
Хранит ТОЛЬКО ID-ссылки на объекты в Registry.

Принцип PM-002 (Immutable):
  Любое изменение создаёт новую версию модели.

CM-001.1 (ProjectModel) + CM-001.5 (Identity).
"""

from dataclasses import dataclass, field, replace
from typing import Optional
from uuid import UUID, uuid4
from datetime import datetime, timezone


@dataclass(frozen=False)
class SourceEntry:
    """Сырой ввод пользователя до интерпретации."""
    id: UUID = field(default_factory=uuid4)
    raw_type: str = "text"          # text, image, voice, url, file
    content: str = ""
    format: str = "text/plain"
    language: str = "ru"
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class ProjectIdentity:
    """Идентификация проекта."""
    id: str = ""                      # human-readable ID
    version: int = 1
    parent_project: Optional[str] = None


@dataclass
class ProjectModel:
    """Проекция графа — только ID-ссылки на Registry.

    Принципы (CM-001):
      - Хранит только ID, не объекты
      - Объекты разрешаются через Registry.resolve(id)
      - Immutable — любая мутация создаёт новую версию (PM-002)
    """

    identity: ProjectIdentity = field(default_factory=ProjectIdentity)

    # ─── Source — сырой ввод ─────────────────────────────────
    sources: list[SourceEntry] = field(default_factory=list)

    # ─── Core entities (ID arrays) ───────────────────────────
    intents: list[UUID] = field(default_factory=list)
    goals: list[UUID] = field(default_factory=list)
    constraints: list[UUID] = field(default_factory=list)
    facts: list[UUID] = field(default_factory=list)
    decisions: list[UUID] = field(default_factory=list)
    blueprints: list[UUID] = field(default_factory=list)
    artifacts: list[UUID] = field(default_factory=list)

    # ─── Metadata ────────────────────────────────────────────
    project_name: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    domain: list[str] = field(default_factory=list)
    model_target: str = ""
    profile_name: str = ""

    # ─── История ─────────────────────────────────────────────
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    # ═══════════════════════════════════════════════════════════
    # Immutable operations — каждая возвращает новый ProjectModel
    # ═══════════════════════════════════════════════════════════

    def _updated(self, **changes) -> "ProjectModel":
        """Создать новый ProjectModel с изменениями + обновлённый timestamp."""
        changes.setdefault("updated_at", datetime.now(timezone.utc).isoformat())
        changes.setdefault("identity", self.identity)
        # Версия увеличивается автоматически
        new_identity = replace(
            self.identity,
            version=self.identity.version + 1,
        )
        changes["identity"] = new_identity
        return replace(self, **changes)

    # ─── Source operations ───────────────────────────────────

    def with_source(self, content: str, raw_type: str = "text",
                    format: str = "text/plain") -> "ProjectModel":
        """Вернуть новый ProjectModel с добавленным Source."""
        entry = SourceEntry(
            raw_type=raw_type,
            content=content,
            format=format,
        )
        return self._updated(sources=self.sources + [entry])

    # ─── ID operations (immutable — возвращают новый PM) ───

    def with_intent(self, node_id: UUID) -> "ProjectModel":
        return self._updated(intents=self.intents + [node_id])

    def with_goal(self, node_id: UUID) -> "ProjectModel":
        return self._updated(goals=self.goals + [node_id])

    def with_constraint(self, node_id: UUID) -> "ProjectModel":
        return self._updated(constraints=self.constraints + [node_id])

    def with_fact(self, node_id: UUID) -> "ProjectModel":
        return self._updated(facts=self.facts + [node_id])

    def with_decision(self, node_id: UUID) -> "ProjectModel":
        return self._updated(decisions=self.decisions + [node_id])

    def with_blueprint(self, node_id: UUID) -> "ProjectModel":
        return self._updated(blueprints=self.blueprints + [node_id])

    def with_artifact(self, node_id: UUID) -> "ProjectModel":
        return self._updated(artifacts=self.artifacts + [node_id])

    # ─── Metadata operations (immutable) ────────────────────

    def with_domain(self, domain: list[str]) -> "ProjectModel":
        return self._updated(domain=list(domain))

    def with_profile(self, profile_name: str) -> "ProjectModel":
        return self._updated(profile_name=profile_name)

    def with_model_target(self, model_target: str) -> "ProjectModel":
        return self._updated(model_target=model_target)

    def with_project_name(self, name: str) -> "ProjectModel":
        return self._updated(project_name=name)

    # ─── Serialization ───────────────────────────────────────

    def to_dict(self) -> dict:
        """Плоский словарь для экспорта."""
        return {
            "intent_ids": [i.hex for i in self.intents],
            "goal_ids": [g.hex for g in self.goals],
            "decision_ids": [d.hex for d in self.decisions],
            "blueprint_ids": [b.hex for b in self.blueprints],
            "artifact_ids": [a.hex for a in self.artifacts],
            "project_name": self.project_name,
            "profile_name": self.profile_name,
            "domain": self.domain,
            "model_target": self.model_target,
        }

    def summary(self) -> dict:
        """Сводка для отладки."""
        return {
            "id": self.identity.id,
            "version": self.identity.version,
            "sources": len(self.sources),
            "intents": len(self.intents),
            "goals": len(self.goals),
            "decisions": len(self.decisions),
            "blueprints": len(self.blueprints),
            "artifacts": len(self.artifacts),
            "domain": self.domain,
            "profile": self.profile_name,
        }