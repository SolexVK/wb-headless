"""VCOS — Registry v3 (CM-001 SSOT)

Registry — Single Source of Truth.
Все Nodes и Edges живут здесь. Graph — только view + validation.

CM-001 §5: Object Registry.
CM-001 R-003: Registry — SSOT.
"""

from typing import Optional, Union
from uuid import UUID

from hermes.kernel.core import Node, Edge, NodeType


class Registry:
    """Единственное хранилище всех Nodes и Edges (CM-001.5).

    Registry — SSOT. Graph читает из Registry.
    Никакой другой компонент не хранит Nodes или Edges.
    """

    def __init__(self):
        self._nodes: dict[UUID, Node] = {}
        self._edges: list[Edge] = []

    # ═══════════════════════════════════════════
    # Node operations
    # ═══════════════════════════════════════════

    def register_node(self, node: Node) -> Node:
        """Добавить узел (CM-001.5.2)."""
        self._nodes[node.id] = node
        return node

    def get_node(self, node_id: UUID) -> Optional[Node]:
        """Получить узел по ID."""
        return self._nodes.get(node_id)

    def get_nodes(self, *types: Union[str, NodeType]) -> list[Node]:
        """Получить все узлы указанных типов. Без фильтра — все."""
        if not types:
            return list(self._nodes.values())
        return [n for n in self._nodes.values() if n.type in types]

    def remove_node(self, node_id: UUID) -> bool:
        """Удалить узел и все связанные рёбра."""
        if node_id not in self._nodes:
            return False
        del self._nodes[node_id]
        self._edges = [
            e for e in self._edges
            if e.source != node_id and e.target != node_id
        ]
        return True

    def update_node(self, node: Node) -> Node:
        """Заменить узел новой версией (immutable — новая копия)."""
        old = self._nodes.get(node.id)
        if old is None:
            raise ValueError(f"Node {node.id} not found in Registry")
        self._nodes[node.id] = node
        return node

    # ═══════════════════════════════════════════
    # Edge operations
    # ═══════════════════════════════════════════

    def register_edge(self, edge: Edge) -> Edge:
        """Добавить ребро (CM-001.5.2)."""
        self._edges.append(edge)
        return edge

    def get_edge(self, edge_id: UUID) -> Optional[Edge]:
        """Получить ребро по ID."""
        for e in self._edges:
            if e.id == edge_id:
                return e
        return None

    def get_edges(self, node_id: Optional[UUID] = None) -> list[Edge]:
        """Получить рёбра. С фильтром по узлу — только связанные с ним."""
        if node_id is None:
            return list(self._edges)
        return [
            e for e in self._edges
            if e.source == node_id or e.target == node_id
        ]

    def remove_edge(self, edge_id: UUID) -> bool:
        """Удалить ребро."""
        for i, e in enumerate(self._edges):
            if e.id == edge_id:
                self._edges.pop(i)
                return True
        return False

    # ═══════════════════════════════════════════
    # Query
    # ═══════════════════════════════════════════

    def resolve(self, node_id: UUID) -> Optional[Node]:
        """Разрешить ID в объект (алиас для get_node)."""
        return self._nodes.get(node_id)

    def resolve_many(self, ids: list[UUID]) -> list[Node]:
        """Разрешить список ID."""
        return [self._nodes.get(i) for i in ids if self._nodes.get(i)]

    def find_edges(self, type_str: str = "", source: Optional[UUID] = None,
                   target: Optional[UUID] = None) -> list[Edge]:
        """Поиск рёбер по типу, источнику, цели.

        Args:
            type_str: RelationType value (e.g. "supports")
            source: UUID источника
            target: UUID цели
        """
        results = []
        for e in self._edges:
            # e.type может быть RelationType или строкой (доменные типы)
            e_type = e.type.value if hasattr(e.type, 'value') else e.type
            if type_str and e_type != type_str:
                continue
            if source and e.source != source:
                continue
            if target and e.target != target:
                continue
            results.append(e)
        return results

    # ═══════════════════════════════════════════
    # Statistics
    # ═══════════════════════════════════════════

    @property
    def node_count(self) -> int:
        return len(self._nodes)

    @property
    def edge_count(self) -> int:
        return len(self._edges)

    def summary(self) -> dict:
        """Сводка Registry для отладки и логов.

        Возвращает количество узлов по типам и рёбер.
        """
        counts = {}
        for n in self._nodes.values():
            type_name = n.type.value if hasattr(n.type, 'value') else n.type
            counts[type_name] = counts.get(type_name, 0) + 1
        return {
            "nodes": self.node_count,
            "edges": self.edge_count,
            "by_type": counts,
        }