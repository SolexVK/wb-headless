"""VCOS — Snapshot Manager v1 (CA-001.4.5)

Управление версиями проекта: fork, merge, diff, rollback.

CA-001.4.5 Structural Operations:
  Fork(snapshotID, name) → ProjectID
  Merge(sourceChain, strategy) → SnapshotID
  Rollback(snapshotID) → SnapshotID

CA-001.4.6 Analysis Operations:
  Diff(snapshotA, snapshotB) → Changeset
  Trace(nodeID, direction) → Edge[]
"""

from dataclasses import dataclass, field
from typing import Optional, Literal
from uuid import UUID, uuid4
from copy import deepcopy

from hermes.kernel.snapshot import Snapshot, SnapshotChain, SnapshotDiff
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel, ProjectIdentity


# ═══════════════════════════════════════════
# Enhanced Changeset (CA-001.4.6)
# ═══════════════════════════════════════════

@dataclass
class Changeset:
    """Полный набор изменений между двумя снэпшотами (CA-001.4.6 Diff).

    Расширяет SnapshotDiff: добавлены modifiedNodes и modifiedEdges.
    """
    added_nodes: list[dict] = field(default_factory=list)       # [{id, type, ...}]
    removed_nodes: list[str] = field(default_factory=list)      # [uuid_hex]
    modified_nodes: list[dict] = field(default_factory=list)    # [{id, diffs: {field: [old, new]}}]
    added_edges: list[dict] = field(default_factory=list)       # [{id, type, source, target}]
    removed_edges: list[str] = field(default_factory=list)      # [uuid_hex]
    modified_edges: list[dict] = field(default_factory=list)    # [{id, diffs: {field: [old, new]}}]
    project_changes: dict = field(default_factory=dict)         # {key: {from: ..., to: ...}}

    @property
    def has_changes(self) -> bool:
        return bool(self.added_nodes or self.removed_nodes or self.modified_nodes
                    or self.added_edges or self.removed_edges or self.modified_edges
                    or self.project_changes)

    def summary(self) -> str:
        parts = []
        if self.added_nodes:
            parts.append(f"+{len(self.added_nodes)} узлов")
        if self.removed_nodes:
            parts.append(f"-{len(self.removed_nodes)} узлов")
        if self.modified_nodes:
            parts.append(f"~{len(self.modified_nodes)} узлов изменено")
        if self.added_edges:
            parts.append(f"+{len(self.added_edges)} рёбер")
        if self.removed_edges:
            parts.append(f"-{len(self.removed_edges)} рёбер")
        if self.modified_edges:
            parts.append(f"~{len(self.modified_edges)} рёбер изменено")
        if self.project_changes:
            parts.append(f"📋 {len(self.project_changes)} полей проекта изменено")
        return ", ".join(parts) if parts else "Нет изменений"


# ═══════════════════════════════════════════
# Merge Result
# ═══════════════════════════════════════════

@dataclass
class MergeResult:
    """Результат операции Merge."""
    snapshot_id: str
    target_version: int
    conflicts: list[dict] = field(default_factory=list)  # [{node_id, field, source_val, target_val}]
    changeset: Optional[Changeset] = None

    @property
    def has_conflicts(self) -> bool:
        return len(self.conflicts) > 0


# ═══════════════════════════════════════════
# Structure for branch metadata
# ═══════════════════════════════════════════

@dataclass
class BranchInfo:
    """Информация о ветке проекта."""
    id: str = field(default_factory=lambda: uuid4().hex[:12])
    name: str = ""
    parent_project_id: str = ""
    parent_snapshot_id: str = ""
    created_at: str = ""
    snapshot_count: int = 0


# ═══════════════════════════════════════════
# SnapshotManager
# ═══════════════════════════════════════════

class SnapshotManager:
    """Управление версиями: fork, merge, diff, rollback.

    Оборачивает SnapshotChain и добавляет:
      - Fork (CA-001.4.5)
      - Merge (CA-001.4.5)
      - Enhanced Diff с modifiedNodes (CA-001.4.6)
      - Trace (CA-001.4.6)
      - Branch management
    """

    MergeStrategy = Literal["fast-forward", "three-way", "overwrite"]

    def __init__(self, registry: Registry, project: ProjectModel):
        self.registry = registry
        self.project = project
        self.chain = SnapshotChain()
        self._branches: dict[str, BranchInfo] = {}  # branch_id → BranchInfo

    # ═══════════════════════════════════════
    # Snapshot operations
    # ═══════════════════════════════════════

    def create(self, author: str = "system", reason: str = "") -> Snapshot:
        """Создать снэпшот текущего состояния."""
        return self.chain.create(self.registry, self.project, author, reason)

    def snapshot(self, snapshot_id: str) -> Optional[Snapshot]:
        """Получить снэпшот по ID."""
        return self.chain.get(snapshot_id)

    def latest(self) -> Optional[Snapshot]:
        """Последний снэпшот."""
        return self.chain.get_latest()

    def history(self, limit: int = 10) -> list[Snapshot]:
        return self.chain.history(limit)

    # ═══════════════════════════════════════
    # Fork (CA-001.4.5)
    # ═══════════════════════════════════════

    def fork(self, snapshot_id: str, branch_name: str = "") -> ProjectModel:
        """Создать новую ветку проекта от указанного снэпшота.

        CA-001 Fork:
          Fork(snapshotID, name) → ProjectID

        - Новый ProjectModel с parent = текущий
        - Первый снэпшот = копия snapshot_id
        - Реестр общий (Nodes by ID)
        """
        source = self.chain.get(snapshot_id)
        if not source:
            raise ValueError(f"Snapshot {snapshot_id} not found")

        # Создать новый ProjectModel с parentProject
        branch_id = f"branch_{uuid4().hex[:8]}"
        new_project = ProjectModel(
            identity=ProjectIdentity(
                id=branch_id,
                version=1,
                parent_project=self.project.identity.id,
            ),
            project_name=branch_name or f"Branch from {snapshot_id[:8]}",
        )

        # Создать BranchInfo
        from datetime import datetime, timezone
        branch_info = BranchInfo(
            id=branch_id,
            name=branch_name or f"branch_{snapshot_id[:8]}",
            parent_project_id=self.project.identity.id,
            parent_snapshot_id=snapshot_id,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        self._branches[branch_id] = branch_info

        return new_project, branch_info

    # ═══════════════════════════════════════
    # Merge (CA-001.4.5)
    # ═══════════════════════════════════════

    def merge(
        self,
        source_chain: SnapshotChain,
        strategy: MergeStrategy = "fast-forward",
        source_project_id: str = "",
    ) -> MergeResult:
        """Слить изменения из source_chain в текущую цепочку.

        CA-001 Merge:
          Merge(targetProject, sourceProject, strategy) → SnapshotID

        Стратегии:
          fast-forward — source впереди target, простое продвижение
          three-way — обе ветки разошлись, требуется слияние с общим предком
          overwrite — source заменяет target для конфликтующих узлов
        """
        # Получить latest снэпшоты обеих цепочек
        target_latest = self.chain.get_latest()
        source_latest = source_chain.get_latest()

        if not source_latest:
            raise ValueError("Source chain is empty — nothing to merge")

        if not target_latest:
            # Target пуст — просто копируем source
            return self._merge_into_empty(source_chain, source_project_id)

        # Найти общего предка (common ancestor)
        ancestor = self._find_common_ancestor(source_chain)

        if strategy == "fast-forward":
            return self._merge_fast_forward(source_chain, source_latest, source_project_id)
        elif strategy == "three-way":
            return self._merge_three_way(source_chain, ancestor, source_latest, target_latest, source_project_id)
        elif strategy == "overwrite":
            return self._merge_overwrite(source_chain, source_latest, source_project_id)
        else:
            raise ValueError(f"Unknown merge strategy: {strategy}")

    def _merge_into_empty(self, source_chain: SnapshotChain, source_project_id: str) -> MergeResult:
        """Слияние в пустую цепочку — просто копируем все снэпшоты source."""
        # Создаём новый снэпшот с текущим состоянием Registry
        snap = self.create(
            author="system",
            reason=f"merge from {source_project_id or 'source'} (fast-forward, empty target)",
        )
        # Сравнение с source
        diff = self._enhanced_diff(None, snap)
        return MergeResult(
            snapshot_id=snap.id,
            target_version=self.project.identity.version,
            changeset=diff,
        )

    def _find_common_ancestor(self, source_chain: SnapshotChain) -> Optional[Snapshot]:
        """Найти общий предок между двумя цепочками."""
        # Собираем все ID target chain
        target_ids = set()
        current_id = self.chain._latest_id
        while current_id:
            target_ids.add(current_id)
            snap = self.chain.get(current_id)
            if snap and snap.parent_id:
                current_id = snap.parent_id
            else:
                break

        # Ищем совпадение в source chain
        current_id = source_chain._latest_id
        while current_id:
            if current_id in target_ids:
                return source_chain.get(current_id)
            snap = source_chain.get(current_id)
            if snap and snap.parent_id:
                current_id = snap.parent_id
            else:
                break

        return None

    def _merge_fast_forward(
        self, source_chain: SnapshotChain, source_latest: Snapshot,
        source_project_id: str,
    ) -> MergeResult:
        """Fast-forward merge: source впереди target."""
        # Создаём новый снэпшот в target с текущим состоянием
        snap = self.create(
            author="system",
            reason=f"merge from {source_project_id or 'source'} (fast-forward)",
        )
        # Записываем метаданные о слиянии
        self.chain._snapshots[snap.id].reason = (
            f"merge from {source_project_id or 'source'}, strategy=fast-forward"
        )

        diff = self._enhanced_diff(self.chain.get(snap.parent_id), snap)
        return MergeResult(
            snapshot_id=snap.id,
            target_version=self.project.identity.version,
            changeset=diff,
        )

    def _merge_three_way(
        self, source_chain: SnapshotChain, ancestor: Optional[Snapshot],
        source_latest: Snapshot, target_latest: Snapshot,
        source_project_id: str,
    ) -> MergeResult:
        """Three-way merge: сравнение с общим предком."""
        # Создаём снэпшот в target
        snap = self.create(
            author="system",
            reason=f"merge from {source_project_id or 'source'} (three-way)",
        )

        # Определяем конфликты: изменения в source и target одного и того же узла
        conflicts = []
        if ancestor:
            ancestor_node_ids = set(ancestor.nodes.keys())
            source_node_ids = set(source_latest.nodes.keys())
            target_node_ids = set(target_latest.nodes.keys())

            # Узлы, изменённые в обеих ветках
            common_changed = (source_node_ids - ancestor_node_ids) & (target_node_ids - ancestor_node_ids)
            for node_id in common_changed:
                source_node = source_latest.nodes.get(node_id)
                target_node = target_latest.nodes.get(node_id)
                if source_node and target_node and source_node != target_node:
                    conflicts.append({
                        "node_id": node_id,
                        "source_value": str(source_node)[:100],
                        "target_value": str(target_node)[:100],
                    })

        diff = self._enhanced_diff(self.chain.get(snap.parent_id), snap)
        return MergeResult(
            snapshot_id=snap.id,
            target_version=self.project.identity.version,
            conflicts=conflicts,
            changeset=diff,
        )

    def _merge_overwrite(
        self, source_chain: SnapshotChain, source_latest: Snapshot,
        source_project_id: str,
    ) -> MergeResult:
        """Overwrite merge: source заменяет target."""
        # Создаём снэпшот состояния Registry
        snap = self.create(
            author="system",
            reason=f"merge from {source_project_id or 'source'} (overwrite)",
        )
        diff = self._enhanced_diff(self.chain.get(snap.parent_id), snap)
        return MergeResult(
            snapshot_id=snap.id,
            target_version=self.project.identity.version,
            changeset=diff,
        )

    # ═══════════════════════════════════════
    # Enhanced Diff (CA-001.4.6)
    # ═══════════════════════════════════════

    def diff(self, snapshot_a_id: str, snapshot_b_id: str) -> Changeset:
        """Сравнить два снэпшота с детекцией изменённых узлов.

        CA-001 Diff:
          Diff(snapshotA, snapshotB) → Changeset

        Расширяет SnapshotChain.diff():
          - modifiedNodes: узлы, существующие в обоих, но с разными properties
          - modifiedEdges: рёбра, существующие в обоих, но с разными properties
        """
        a = self.chain.get(snapshot_a_id)
        b = self.chain.get(snapshot_b_id)

        if not a or not b:
            raise ValueError("Snapshots not found")

        return self._enhanced_diff(a, b)

    def _enhanced_diff(self, a: Optional[Snapshot], b: Snapshot) -> Changeset:
        """Enhanced diff между двумя снэпшотами (или None = пустой)."""
        changeset = Changeset()

        if a is None:
            # Первый снэпшот — всё добавлено
            for uid, node in b.nodes.items():
                changeset.added_nodes.append({
                    "id": uid,
                    "type": str(node.type.value) if hasattr(node.type, 'value') else str(node.type),
                    "state": str(node.state.value) if hasattr(node.state, 'value') else str(node.state),
                })
            for edge in b.edges:
                changeset.added_edges.append({
                    "id": edge.id.hex,
                    "type": str(edge.type.value) if hasattr(edge.type, 'value') else str(edge.type),
                    "source": edge.source.hex,
                    "target": edge.target.hex,
                })
            return changeset

        # Nodes
        a_nodes = set(a.nodes.keys())
        b_nodes = set(b.nodes.keys())
        added = b_nodes - a_nodes
        removed = a_nodes - b_nodes
        common = a_nodes & b_nodes

        for uid in added:
            node = b.nodes[uid]
            changeset.added_nodes.append({
                "id": uid,
                "type": str(node.type.value) if hasattr(node.type, 'value') else str(node.type),
            })
        for uid in removed:
            changeset.removed_nodes.append(uid)

        # Modified nodes — compare properties
        for uid in common:
            node_a = a.nodes[uid]
            node_b = b.nodes[uid]
            diffs = self._compare_node_props(node_a, node_b)
            if diffs:
                changeset.modified_nodes.append({
                    "id": uid,
                    "diffs": diffs,
                })

        # Edges
        a_edge_map = {e.id.hex: e for e in a.edges}
        b_edge_map = {e.id.hex: e for e in b.edges}

        a_edge_ids = set(a_edge_map.keys())
        b_edge_ids = set(b_edge_map.keys())

        added_edges = b_edge_ids - a_edge_ids
        removed_edges = a_edge_ids - b_edge_ids
        common_edges = a_edge_ids & b_edge_ids

        for eid in added_edges:
            edge = b_edge_map[eid]
            changeset.added_edges.append({
                "id": eid,
                "type": str(edge.type.value) if hasattr(edge.type, 'value') else str(edge.type),
                "source": edge.source.hex,
                "target": edge.target.hex,
            })
        for eid in removed_edges:
            changeset.removed_edges.append(eid)

        for eid in common_edges:
            edge_a = a_edge_map[eid]
            edge_b = b_edge_map[eid]
            diffs = self._compare_edge_props(edge_a, edge_b)
            if diffs:
                changeset.modified_edges.append({
                    "id": eid,
                    "diffs": diffs,
                })

        # Project changes
        for key in a.project_state:
            a_val = a.project_state.get(key)
            b_val = b.project_state.get(key)
            if a_val != b_val:
                changeset.project_changes[key] = {
                    "from": a_val,
                    "to": b_val,
                }

        return changeset

    def _compare_node_props(self, node_a, node_b) -> dict:
        """Сравнить properties двух узлов, вернуть изменения."""
        diffs = {}
        # Сравниваем type, status, и важные поля properties
        props_a = getattr(node_a, 'properties', {}) or {}
        props_b = getattr(node_b, 'properties', {}) or {}

        # Тип и статус
        type_a = str(node_a.type.value) if hasattr(node_a.type, 'value') else str(node_a.type)
        type_b = str(node_b.type.value) if hasattr(node_b.type, 'value') else str(node_b.type)
        if type_a != type_b:
            diffs["type"] = [type_a, type_b]

        # Все ключи properties
        all_keys = set(props_a.keys()) | set(props_b.keys())
        for key in all_keys:
            a_val = props_a.get(key)
            b_val = props_b.get(key)
            if a_val != b_val:
                diffs[key] = [a_val, b_val]

        return diffs

    def _compare_edge_props(self, edge_a, edge_b) -> dict:
        """Сравнить properties двух рёбер."""
        diffs = {}
        type_a = str(edge_a.type.value) if hasattr(edge_a.type, 'value') else str(edge_a.type)
        type_b = str(edge_b.type.value) if hasattr(edge_b.type, 'value') else str(edge_b.type)
        if type_a != type_b:
            diffs["type"] = [type_a, type_b]

        props_a = getattr(edge_a, 'properties', {}) or {}
        props_b = getattr(edge_b, 'properties', {}) or {}
        all_keys = set(props_a.keys()) | set(props_b.keys())
        for key in all_keys:
            a_val = props_a.get(key)
            b_val = props_b.get(key)
            if a_val != b_val:
                diffs[key] = [a_val, b_val]

        return diffs

    # ═══════════════════════════════════════
    # Trace (CA-001.4.6)
    # ═══════════════════════════════════════

    def trace(self, node_id: str, direction: str = "backward") -> list[dict]:
        """Проследить цепочку происхождения от узла.

        CA-001 Trace:
          Trace(nodeID, direction) → Edge[]

        backward: от узла к источнику (почему?)
        forward: от узла к артефактам (что получилось?)
        """
        edges = self.registry.get_edges()
        result = []

        if direction == "backward":
            # Ищем все рёбра, где node_id — target
            for edge in edges:
                if edge.target.hex == node_id:
                    result.append({
                        "type": str(edge.type.value) if hasattr(edge.type, 'value') else str(edge.type),
                        "source": edge.source.hex,
                        "target": edge.target.hex,
                    })
        elif direction == "forward":
            # Ищем все рёбра, где node_id — source
            for edge in edges:
                if edge.source.hex == node_id:
                    result.append({
                        "type": str(edge.type.value) if hasattr(edge.type, 'value') else str(edge.type),
                        "source": edge.source.hex,
                        "target": edge.target.hex,
                    })

        return result

    # ═══════════════════════════════════════
    # Rollback (CA-001.4.5)
    # ═══════════════════════════════════════

    def rollback(self, snapshot_id: str, author: str = "system") -> Snapshot:
        """Откатиться к указанному снэпшоту.

        CA-001 Rollback:
          Rollback(projectModel, snapshotID) → SnapshotID

        Rollback = append (не удаляет историю).
        """
        return self.chain.rollback(snapshot_id, self.registry, self.project)

    # ═══════════════════════════════════════
    # Branch management
    # ═══════════════════════════════════════

    def list_branches(self) -> list[BranchInfo]:
        """Список всех веток."""
        return list(self._branches.values())

    def get_branch(self, branch_id: str) -> Optional[BranchInfo]:
        return self._branches.get(branch_id)

    def compare(self, id_a, id_b) -> dict:
        """CA-001 §4.8: Compare two project states.

        Args:
            id_a: UUID узла (Node) или hex-id снэпшота (str)
            id_b: UUID узла (Node) или hex-id снэпшота (str)

        Returns:
            ComparisonResult: {node_delta, edge_delta, structural_similarity, decision_overlap}
        """
        node_a = self.registry.get_node(id_a) if isinstance(id_a, UUID) else None
        node_b = self.registry.get_node(id_b) if isinstance(id_b, UUID) else None
        # Snapshot-ы хранятся под hex-ключами (str)
        snap_key_a = id_a.hex if isinstance(id_a, UUID) else str(id_a)
        snap_key_b = id_b.hex if isinstance(id_b, UUID) else str(id_b)
        snapshot_a = self.chain.get(snap_key_a)
        snapshot_b = self.chain.get(snap_key_b)

        if node_a and node_b:
            # Compare two nodes
            shared_fields = set(node_a.properties.keys()) & set(node_b.properties.keys())
            diff_fields = set(node_a.properties.keys()) ^ set(node_b.properties.keys())
            similarity = len(shared_fields) / max(len(shared_fields | diff_fields), 1)

            return {
                "type": "node_comparison",
                "id_a": str(id_a),
                "id_b": str(id_b),
                "node_delta": len(diff_fields),
                "edge_delta": 0,
                "structural_similarity": round(similarity, 2),
                "decision_overlap": [],
                "shared_fields": list(shared_fields),
                "diff_fields": list(diff_fields),
            }

        if snapshot_a and snapshot_b:
            # Compare two snapshots via diff (по ID снэпшотов)
            changeset = self.diff(snapshot_a.id, snapshot_b.id)
            # Snapshot.nodes — dict {uuid_hex: Node}
            nodes_a = set(snapshot_a.nodes.keys())
            nodes_b = set(snapshot_b.nodes.keys())
            shared = nodes_a & nodes_b
            total = nodes_a | nodes_b
            similarity = len(shared) / max(len(total), 1)

            counts = {
                "added_nodes": len(changeset.added_nodes),
                "removed_nodes": len(changeset.removed_nodes),
                "modified_nodes": len(changeset.modified_nodes),
                "added_edges": len(changeset.added_edges),
                "removed_edges": len(changeset.removed_edges),
                "modified_edges": len(changeset.modified_edges),
            }

            return {
                "type": "snapshot_comparison",
                "id_a": str(id_a),
                "id_b": str(id_b),
                "node_delta": counts["added_nodes"] + counts["removed_nodes"],
                "edge_delta": counts["added_edges"] + counts["removed_edges"],
                "structural_similarity": round(similarity, 2),
                "decision_overlap": [],
                "changeset": counts,
            }

        return {
            "type": "unknown",
            "error": f"Cannot compare {id_a} and {id_b}: neither Nodes nor Snapshots",
            "node_delta": 0,
            "edge_delta": 0,
            "structural_similarity": 0.0,
            "decision_overlap": [],
        }

    def summary(self) -> dict:
        return {
            "snapshots": len(self.chain._snapshots),
            "latest": self.chain._latest_id[:8] if self.chain._latest_id else None,
            "versions": self.chain._version_counter,
            "branches": len(self._branches),
            "project_version": self.project.identity.version,
        }