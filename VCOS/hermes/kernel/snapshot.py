"""VCOS — Snapshot v1

Снэпшоты состояния Semantic Graph (CM-001.6 — Versioning).

Каждая мутация создаёт новый снэпшот.
Снэпшоты образуют цепочку для отката, сравнения и форка.

Принципы:
  - Immutable Model — каждое изменение = новый снэпшот
  - Snapshot — полная копия Registry (не diff)
  - Rollback = append (новая версия со старым состоянием)
"""

from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID, uuid4
from datetime import datetime, timezone
from copy import deepcopy


@dataclass
class Snapshot:
    """Замороженная копия состояния Registry/ProjectModel в момент времени.

    Содержит:
      - Копию всех Node и Edge из Registry
      - Копию ProjectModel (ID-ссылки)
      - Метаданные (когда, кто, причина)
    """
    id: str = field(default_factory=lambda: uuid4().hex[:12])
    parent_id: Optional[str] = None

    # Полные копии состояния
    nodes: dict = field(default_factory=dict)      # {uuid_hex: Node}
    edges: list = field(default_factory=list)       # [Edge]
    project_state: dict = field(default_factory=dict)

    # Метаданные
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    author: str = "system"
    reason: str = ""
    version: int = 1

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    @property
    def edge_count(self) -> int:
        return len(self.edges)


@dataclass
class SnapshotDiff:
    """Разница между двумя снэпшотами."""
    added_nodes: list[str] = field(default_factory=list)     # uuid_hex
    removed_nodes: list[str] = field(default_factory=list)
    added_edges: list[str] = field(default_factory=list)
    removed_edges: list[str] = field(default_factory=list)
    project_changes: dict = field(default_factory=dict)


class SnapshotChain:
    """Цепочка снэпшотов — история состояний.

    Позволяет:
      - Создать новый снэпшот
      - Откатиться к любому предыдущему
      - Сравнить два снэпшота
      - Форкнуть от любого снэпшота
    """

    def __init__(self):
        self._snapshots: dict[str, Snapshot] = {}  # id → Snapshot
        self._latest_id: Optional[str] = None
        self._version_counter: int = 0

    def create(self, registry, project,
               author: str = "system", reason: str = "") -> Snapshot:
        """Создать снэпшот текущего состояния Registry + ProjectModel.

        Делает deepcopy всех объектов для гарантии иммутабельности.
        """
        self._version_counter += 1

        # Deepcopy Registry
        nodes_copy = {}
        for uid, node in registry._nodes.items():
            nodes_copy[uid.hex] = deepcopy(node)

        edges_copy = [deepcopy(e) for e in registry.get_edges()]

        # Deepcopy ProjectModel
        project_copy = {
            "identity": deepcopy(project.identity),
            "intents": deepcopy(project.intents),
            "goals": deepcopy(project.goals),
            "constraints": deepcopy(project.constraints),
            "facts": deepcopy(project.facts),
            "decisions": deepcopy(project.decisions),
            "blueprints": deepcopy(project.blueprints),
            "artifacts": deepcopy(project.artifacts),
            "sources": deepcopy(project.sources),
            "domain": deepcopy(project.domain),
            "project_name": project.project_name,
            "tags": deepcopy(project.tags),
            "profile_name": project.profile_name,
            "model_target": project.model_target,
        }

        snapshot = Snapshot(
            parent_id=self._latest_id,
            nodes=nodes_copy,
            edges=edges_copy,
            project_state=project_copy,
            author=author,
            reason=reason,
            version=self._version_counter,
        )

        self._snapshots[snapshot.id] = snapshot
        self._latest_id = snapshot.id
        return snapshot

    def get_latest(self) -> Optional[Snapshot]:
        """Последний снэпшот."""
        if self._latest_id:
            return self._snapshots.get(self._latest_id)
        return None

    def get(self, snapshot_id: str) -> Optional[Snapshot]:
        """Получить снэпшот по ID."""
        return self._snapshots.get(snapshot_id)

    def history(self, limit: int = 10) -> list[Snapshot]:
        """Цепочка от последнего к первому."""
        chain = []
        current_id = self._latest_id
        while current_id and len(chain) < limit:
            snap = self._snapshots.get(current_id)
            if not snap:
                break
            chain.append(snap)
            current_id = snap.parent_id
        return chain

    def rollback(self, target_id: str,
                 registry, project) -> Snapshot:
        """Откатиться к указанному снэпшоту.

        Не удаляет историю — создаёт НОВЫЙ снэпшот с состоянием target.
        Rollback = append.
        """
        target = self._snapshots.get(target_id)
        if not target:
            raise ValueError(f"Snapshot {target_id} not found")

        # Восстановить Registry из снэпшота
        registry._nodes.clear()
        registry._edges.clear()

        from hermes.kernel.core import Node, Edge
        # Восстанавливаем Node
        for uid_hex, node in target.nodes.items():
            registry._nodes[node.id] = deepcopy(node)
        # Восстанавливаем Edge
        for edge in target.edges:
            registry._edges.append(deepcopy(edge))

        # Восстановить ProjectModel.
        # ПРИМЕЧАНИЕ: прямое присваивание — осознанный механизм отката
        # (immutable-модель восстанавливается in-place, история не удаляется).
        # Version монотонно растёт (G-011), updated_at обновляется.
        project.intents = deepcopy(target.project_state.get("intents", []))
        project.goals = deepcopy(target.project_state.get("goals", []))
        project.constraints = deepcopy(target.project_state.get("constraints", []))
        project.facts = deepcopy(target.project_state.get("facts", []))
        project.decisions = deepcopy(target.project_state.get("decisions", []))
        project.blueprints = deepcopy(target.project_state.get("blueprints", []))
        project.artifacts = deepcopy(target.project_state.get("artifacts", []))
        project.sources = deepcopy(target.project_state.get("sources", []))
        project.domain = deepcopy(target.project_state.get("domain", []))
        project.project_name = target.project_state.get("project_name", project.project_name)
        project.tags = deepcopy(target.project_state.get("tags", []))
        project.profile_name = target.project_state.get("profile_name", "")
        project.model_target = target.project_state.get("model_target", "")

        # Version растёт монотонно (rollback = новая версия, не откат версии)
        from dataclasses import replace as _replace
        project.identity = _replace(
            project.identity, version=project.identity.version + 1
        )
        project.updated_at = datetime.now(timezone.utc).isoformat()

        # Создать новый снэпшот (этот rollback)
        return self.create(
            registry, project,
            author="system",
            reason=f"rollback to {target_id}",
        )

    def diff(self, snapshot_a_id: str, snapshot_b_id: str) -> SnapshotDiff:
        """Сравнить два снэпшота."""
        a = self._snapshots.get(snapshot_a_id)
        b = self._snapshots.get(snapshot_b_id)

        if not a or not b:
            raise ValueError("Snapshots not found")

        diff = SnapshotDiff()

        # Nodes
        a_keys = set(a.nodes.keys())
        b_keys = set(b.nodes.keys())
        diff.added_nodes = list(b_keys - a_keys)
        diff.removed_nodes = list(a_keys - b_keys)

        # Edges
        a_edge_ids = {e.id.hex for e in a.edges}
        b_edge_ids = {e.id.hex for e in b.edges}
        diff.added_edges = list(b_edge_ids - a_edge_ids)
        diff.removed_edges = list(a_edge_ids - b_edge_ids)

        # Project
        for key in a.project_state:
            if a.project_state.get(key) != b.project_state.get(key):
                diff.project_changes[key] = {
                    "from": a.project_state.get(key),
                    "to": b.project_state.get(key),
                }

        return diff

    def clear(self) -> None:
        """Очистить все снэпшоты."""
        self._snapshots.clear()
        self._latest_id = None
        self._version_counter = 0

    def summary(self) -> dict:
        """Сводка цепочки."""
        return {
            "snapshots": len(self._snapshots),
            "latest": self._latest_id,
            "versions": self._version_counter,
            "history": [s.id[:8] for s in self.history(5)],
        }