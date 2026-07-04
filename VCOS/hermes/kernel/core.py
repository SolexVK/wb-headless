"""
VCOS Kernel — Core Primitives v3

CO-001 Core Ontology + CM-001 Canonical Model.
Defines Node types, Relation types, Lifecycle state, and Graph invariants.

CM-001.1 — Identity Model
CM-001.2 — Node Model
CM-001.3 — Edge Model
CM-001.4 — Graph Invariants
"""

from enum import Enum
from typing import Any, Optional, Union
from uuid import UUID, uuid4
from dataclasses import dataclass, field
from datetime import datetime, timezone


# ═══════════════════════════════════════════
# CO-001: Core Ontology — Node Types
# ═══════════════════════════════════════════

class NodeType(str, Enum):
    """CO-001 Core Types — 8 фундаментальных типов.

    6 CO-001 types: Intent, Goal, Fact, Decision, Blueprint, Artifact.
    + SOURCE (CM-001 §6.3) — сырой ввод пользователя.
    + CONSTRAINT — отделён от Goal (I-006 Domain Boundary).

    CREATIVE_STRATEGY, NARRATIVE, VISUAL_LANGUAGE — Domain Packs → EXTRA_TYPES.
    """
    SOURCE          = "source"           # Исходные данные
    INTENT          = "intent"           # Намерение пользователя
    GOAL            = "goal"             # Формализованная цель
    CONSTRAINT      = "constraint"       # Ограничение
    FACT            = "fact"             # Установленное знание
    DECISION        = "decision"         # Принятое решение
    BLUEPRINT       = "blueprint"        # Проектная модель
    ARTIFACT        = "artifact"         # Результат компиляции


EXTRA_TYPES = {
    "CREATIVE_STRATEGY": "creative_strategy",
    "NARRATIVE": "narrative",
    "VISUAL_LANGUAGE": "visual_language",
}

EXTRA_EDGE_TYPES = {
    "EXPRESSES": "expresses",        # VisualLanguage → Intent (Film Domain)
}


# ═══════════════════════════════════════════
# CM-001.3: Edge Model — Edge Types
# ═══════════════════════════════════════════

class RelationType(str, Enum):
    """CM-001.3 — 10 типов отношений между узлами.

    Spec: edge-model.md §1.1 — Edge Type Catalog.

    ═══ КАНОН НАПРАВЛЕНИЙ РЁБЕР (единая таблица) ═══
    Все компоненты (graph_adapter, algebra, валидаторы) обязаны следовать:

      Intent     —SUPPORTS→   Goal       (Intent поддерживает Goal)
      Decision   —SUPPORTS→   Goal       (Decision поддерживает Goal, PM-I004)
      Constraint —CONSTRAINS→ Goal       (Constraint ограничивает Goal)
      Blueprint  —SATISFIES→  Decision   (Blueprint удовлетворяет Decision, G-006)
      Blueprint  —PRODUCES→   Artifact   (Blueprint производит Artifact, G-007)
    """
    SUPPORTS     = "supports"       # A поддерживает B (Decision → Goal, Intent → Goal)
    CONTRADICTS  = "contradicts"    # A противоречит B
    ENABLES      = "enables"        # A делает возможным B
    CONSTRAINS   = "constrains"     # A ограничивает B (Constraint → Goal)
    SATISFIES    = "satisfies"      # A удовлетворяет B (Blueprint → Decision)
    PRODUCES     = "produces"       # A производит B (Blueprint → Artifact)
    DERIVES_FROM = "derives_from"   # A выведено из B
    REFINES      = "refines"        # A уточняет B
    CONTAINS     = "contains"       # A содержит B
    REFERENCES   = "references"     # A ссылается на B


# ═══════════════════════════════════════════
# CM-001.2: Node Model — Lifecycle
# ═══════════════════════════════════════════

class LifecycleState(str, Enum):
    """CM-001 Node Model §2.3 — 7 состояний жизненного цикла узла.

    Transition rules (valid_transitions):
      DRAFT → PROPOSED → VALIDATED → APPROVED → ARCHIVED
                                                 → DEPRECATED
      DRAFT → REJECTED
      PROPOSED → REJECTED
    """
    DRAFT      = "draft"       # Черновик — предложен, но не оформлен
    PROPOSED   = "proposed"    # Предложен — ожидает решения (CO-001 Decision)
    VALIDATED  = "validated"   # Проверен — соответствует CO-001 инвариантам
    APPROVED   = "approved"    # Одобрен — включён в проект
    REJECTED   = "rejected"    # Отклонён — не будет включён
    DEPRECATED = "deprecated"  # Устарел — заменён другим решением
    ARCHIVED   = "archived"    # Архивирован — проект завершён

    @staticmethod
    def valid_transitions() -> dict:
        """Вернуть словарь {from_state: {to_state1, to_state2, ...}}."""
        return {
            LifecycleState.DRAFT:      {LifecycleState.PROPOSED, LifecycleState.REJECTED},
            LifecycleState.PROPOSED:   {LifecycleState.VALIDATED, LifecycleState.REJECTED},
            LifecycleState.VALIDATED:  {LifecycleState.APPROVED, LifecycleState.REJECTED},
            LifecycleState.APPROVED:   {LifecycleState.ARCHIVED, LifecycleState.DEPRECATED},
            LifecycleState.REJECTED:   set(),
            LifecycleState.DEPRECATED: set(),
            LifecycleState.ARCHIVED:   set(),
        }

    def can_transition_to(self, target: "LifecycleState") -> bool:
        """Проверить, допустим ли переход из текущего состояния в target."""
        transitions = self.valid_transitions()
        allowed = transitions.get(self, set())
        return target in allowed


# ═══════════════════════════════════════════
# CO-001: Type-specific statuses
# ═══════════════════════════════════════════

class IntentStatus(str, Enum):
    """CO-001 §1 — Intent status lifecycle.

    Transitions:
      CAPTURED → ANALYZING → UNDERSTOOD → SUPERSEDED

    Invariants:
      - I-1: Exactly one active Intent per project
      - I-2: Intent MUST NOT be modified after Goal is created (only superseded)
      - I-3: confidence starts at 0.2
    """
    CAPTURED    = "captured"     # Сырое намерение, только что получено
    ANALYZING   = "analyzing"    # Система анализирует и уточняет
    UNDERSTOOD  = "understood"   # Intent интерпретирован, Goals начаты
    SUPERSEDED  = "superseded"   # Заменён новым Intent (I-2)

    @staticmethod
    def valid_transitions() -> dict:
        """Intent status transitions (CO-001 §1)."""
        return {
            IntentStatus.CAPTURED:    {IntentStatus.ANALYZING},
            IntentStatus.ANALYZING:   {IntentStatus.UNDERSTOOD},
            IntentStatus.UNDERSTOOD:  {IntentStatus.SUPERSEDED},
            IntentStatus.SUPERSEDED:  set(),
        }

    def can_transition_to(self, target: "IntentStatus") -> bool:
        return target in self.valid_transitions().get(self, set())


class GoalStatus(str, Enum):
    """CO-001 §2 — Goal status lifecycle.

    Transitions:
      DRAFT → ACTIVE → ACHIEVED
                      → ABANDONED

    Invariants:
      - G-1: Goal MUST trace to exactly one Intent
      - G-2: Goal must be achieved or abandoned before project complete
    """
    DRAFT     = "draft"       # Предложена, ещё не активна
    ACTIVE    = "active"      # В работе, Decisions направлены на её достижение
    ACHIEVED  = "achieved"    # Достигнута — все критерии выполнены
    ABANDONED = "abandoned"   # Отменена — больше не актуальна

    @staticmethod
    def valid_transitions() -> dict:
        """Goal status transitions (CO-001 §2)."""
        return {
            GoalStatus.DRAFT:     {GoalStatus.ACTIVE},
            GoalStatus.ACTIVE:    {GoalStatus.ACHIEVED, GoalStatus.ABANDONED},
            GoalStatus.ACHIEVED:  set(),
            GoalStatus.ABANDONED: set(),
        }

    def can_transition_to(self, target: "GoalStatus") -> bool:
        return target in self.valid_transitions().get(self, set())


# ═══════════════════════════════════════════
# Helper: extract type-specific status from Node properties
# ═══════════════════════════════════════════

def get_node_type_status(node_type: str, properties: dict):
    """Извлечь тип-специфичный статус из свойств узла.

    Returns:
      IntentStatus, GoalStatus, или None (для других типов).
    """
    status_val = properties.get("status")
    if node_type == NodeType.INTENT.value:
        return IntentStatus(status_val) if status_val else IntentStatus.CAPTURED
    if node_type == NodeType.GOAL.value:
        return GoalStatus(status_val) if status_val else GoalStatus.DRAFT
    return None


# ═══════════════════════════════════════════
# CM-001.2: Node Model — Data Structure
# ═══════════════════════════════════════════

@dataclass(frozen=True)
class Node:
    """Узел семантического графа (CO-001 + CM-001.2).

    IMMUTABLE (frozen=True). Никаких мутаций на месте.
    Любое изменение → Graph.replace_node() → новый Node.

    Поля:
      id         — UUID v7 (уникальный идентификатор)
      type       — NodeType (тип узла из CO-001)
      state      — LifecycleState (Draft/Validated/Approved...)
      properties — Dict[str, Any] (бизнес-данные узла)
      metadata   — Dict с createdAt, author, version, provenance
      tags       — list[str] (теги для фильтрации/поиска)
      created_at — datetime (когда создан)
      updated_at — datetime (когда обновлён)
    """
    id: UUID = field(default_factory=uuid4)
    type: str = NodeType.FACT.value
    state: LifecycleState = LifecycleState.DRAFT
    properties: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)
    tags: list = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __repr__(self) -> str:
        type_name = self.type.value if hasattr(self.type, 'value') else self.type
        state_name = self.state.value if hasattr(self.state, 'value') else self.state
        return f"Node({type_name}, {state_name}, id={self.id.hex[:8]})"

    def with_state(self, new_state: "LifecycleState") -> "Node":
        """Создать новый Node с обновлённым состоянием (immutable)."""
        if not self.state.can_transition_to(new_state):
            raise ValueError(f"Cannot transition from {self.state} to {new_state}")
        return Node(
            id=self.id,
            type=self.type,
            state=new_state,
            properties=self.properties,
            metadata=self.metadata,
            tags=self.tags,
            created_at=self.created_at,
            updated_at=datetime.now(timezone.utc),
        )

    def with_properties(self, new_properties: dict) -> "Node":
        """Создать новый Node с обновлёнными properties (immutable)."""
        return Node(
            id=self.id,
            type=self.type,
            state=self.state,
            properties=new_properties,
            metadata=self.metadata,
            tags=self.tags,
            created_at=self.created_at,
            updated_at=datetime.now(timezone.utc),
        )


# ═══════════════════════════════════════════
# CM-001.3: Edge Model — Data Structure
# ═══════════════════════════════════════════

@dataclass
class Edge:
    """Ребро семантического графа (CM-001.3).

    Поля:
      id         — UUID v7
      type       — RelationType или EXTRA_EDGE_TYPES[str] (доменные типы)
      source     — UUID источника
      target     — UUID цели
      properties — Dict[str, Any] (метаданные отношения)
      metadata   — Dict с createdAt, author
      created_at — datetime
    """
    id: UUID = field(default_factory=uuid4)
    type: str = RelationType.REFERENCES.value
    source: UUID = field(default_factory=uuid4)
    target: UUID = field(default_factory=uuid4)
    properties: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __repr__(self) -> str:
        type_name = self.type.value if hasattr(self.type, 'value') else self.type
        return (
            f"Edge({type_name}, "
            f"{self.source.hex[:8]} → {self.target.hex[:8]})"
        )


# ═══════════════════════════════════════════
# CM-001.4: Graph Invariants — Validated
# ═══════════════════════════════════════════

class Graph:
    """Ядро VCOS — семантический граф (CM-001).

    Graph — view-layer над Registry.
    Registry — SSOT (все Nodes и Edges живут в Registry).
    Graph проверяет инварианты перед мутациями.

    CM-001 R-003: Registry — SSOT. Graph — query + validation.
    """

    def __init__(self, registry=None) -> None:
        """Graph может быть создан с Registry или без.

        Args:
            registry: Registry (SSOT). Если не передан — создаётся пустой.
        """
        if registry is None:
            from hermes.kernel.registry import Registry
            registry = Registry()
        self._registry = registry

    # ─── Registry access (read-only, через Registry API) ────────

    @property
    def _nodes(self) -> dict:
        """Доступ к узлам Registry (read-only view)."""
        return self._registry._nodes

    @property
    def _edges(self) -> list:
        """Доступ к рёбрам Registry (read-only view)."""
        return self._registry._edges

    # ─── Node operations ───────────────────────────────────────

    def add_node(self, node: Node) -> Node:
        """Добавить узел в Registry."""
        return self._registry.register_node(node)

    def get_node(self, node_id: UUID) -> Optional[Node]:
        """Получить узел из Registry."""
        return self._registry.get_node(node_id)

    def get_nodes(self, *types: Union[str, NodeType]) -> list[Node]:
        """Получить все узлы указанных типов."""
        return self._registry.get_nodes(*types)

    def remove_node(self, node_id: UUID) -> bool:
        """Удалить узел и все связанные рёбра."""
        return self._registry.remove_node(node_id)

    def replace_node(self, node_id: UUID, new_properties: Optional[dict] = None,
                     new_state: Optional[LifecycleState] = None,
                     new_metadata: Optional[dict] = None) -> Optional[Node]:
        """Заменить узел новой immutable-версией.

        Не мутирует — создаёт новый Node с обновлёнными полями.
        Старый Node остаётся в истории (через SnapshotManager).
        """
        old = self.get_node(node_id)
        if not old:
            return None
        # Валидация перехода состояния (та же, что в Node.with_state)
        if new_state is not None and new_state != old.state:
            if not old.state.can_transition_to(new_state):
                raise ValueError(
                    f"Cannot transition from {old.state} to {new_state}"
                )
        props = new_properties if new_properties is not None else old.properties
        meta = new_metadata if new_metadata is not None else {**old.metadata}
        version = meta.get("version", 0) + 1
        meta["version"] = version
        state = new_state if new_state is not None else old.state
        new_node = Node(
            id=old.id,
            type=old.type,
            state=state,
            properties=props,
            metadata=meta,
            tags=old.tags,
            created_at=old.created_at,
            updated_at=datetime.now(timezone.utc),
        )
        return self._registry.update_node(new_node)

    def update_node_state(self, node_id: UUID, state: LifecycleState) -> bool:
        """Изменить состояние узла (через with_state — immutable + validation)."""
        old = self.get_node(node_id)
        if not old:
            return False
        try:
            new_node = old.with_state(state)
        except ValueError:
            return False
        self._registry.update_node(new_node)
        return True

    # ─── Edge operations ───────────────────────────────────────

    def add_edge(self, edge: Edge) -> Edge:
        """Добавить ребро между узлами (с проверкой существования узлов)."""
        if self._registry.get_node(edge.source) is None:
            raise ValueError(f"Source node {edge.source} not found")
        if self._registry.get_node(edge.target) is None:
            raise ValueError(f"Target node {edge.target} not found")
        return self._registry.register_edge(edge)

    def get_edges(self, node_id: Optional[UUID] = None) -> list[Edge]:
        """Получить все рёбра, опционально фильтруя по узлу."""
        return self._registry.get_edges(node_id)

    # ─── Edge lookup ────────────────────────────────────────────

    def get_edge(self, edge_id: UUID) -> Optional[Edge]:
        """Получить ребро по ID."""
        return self._registry.get_edge(edge_id)

    def find_edges(self, type_str: str = "", source: Optional[UUID] = None,
                   target: Optional[UUID] = None) -> list[Edge]:
        """Поиск рёбер по типу, источнику, цели."""
        return self._registry.find_edges(type_str, source, target)

    # ─── Graph traversal ───────────────────────────────────────

    def get_children(self, node_id: UUID, relation: Optional[RelationType] = None) -> list[Node]:
        """Получить узлы, на которые ссылается данный узел."""
        result = []
        edges = self._registry.find_edges(source=node_id)
        for e in edges:
            if relation is None or e.type == relation:
                child = self.get_node(e.target)
                if child:
                    result.append(child)
        return result

    def get_parents(self, node_id: UUID, relation: Optional[RelationType] = None) -> list[Node]:
        """Получить узлы, которые ссылаются на данный узел."""
        result = []
        edges = self._registry.find_edges(target=node_id)
        for e in edges:
            if relation is None or e.type == relation:
                parent = self.get_node(e.source)
                if parent:
                    result.append(parent)
        return result

    def traverse_forward(self, start_id: UUID) -> list[Node]:
        """Обход графа вперёд (от корня к листьям)."""
        visited: set[UUID] = set()
        result: list[Node] = []

        def dfs(node_id: UUID) -> None:
            if node_id in visited:
                return
            visited.add(node_id)
            node = self.get_node(node_id)
            if node:
                result.append(node)
                for child in self.get_children(node_id):
                    dfs(child.id)

        dfs(start_id)
        return result

    # ─── Invariant checks ──────────────────────────────────────

    def validate_invariants(self) -> list[str]:
        """CM-001.4 Graph Invariants — проверка обязательных правил.

        Канон направлений — см. docstring RelationType.

        G-001: No cycles in graph
        G-005: Goal ← supports ← Intent (Intent — родитель Goal)
        G-006: Blueprint → satisfies → Decision
        G-007: Blueprint → produces → Artifact (Blueprint — родитель Artifact)
        PM-I004: Decision → supports → Goal (Goal — ребёнок Decision)
        """
        violations: list[str] = []

        # G-005: Каждый Goal должен иметь родителя-Intent (Intent —SUPPORTS→ Goal)
        goals = self.get_nodes(NodeType.GOAL)
        for goal in goals:
            parents = self.get_parents(goal.id)
            has_intent_parent = any(
                self.get_node(p.id) and self.get_node(p.id).type == NodeType.INTENT
                for p in parents
            )
            if not has_intent_parent:
                violations.append(
                    f"G-005: Goal {goal.id.hex[:8]} has no Intent parent"
                )

        # PM-I004: Каждый Decision —SUPPORTS→ Goal (Goal среди детей Decision)
        decisions = self.get_nodes(NodeType.DECISION)
        for d in decisions:
            children = self.get_children(d.id, RelationType.SUPPORTS)
            has_goal_child = any(
                self.get_node(c.id) and self.get_node(c.id).type == NodeType.GOAL
                for c in children
            )
            if not has_goal_child:
                violations.append(
                    f"PM-I004: Decision {d.id.hex[:8]} supports no Goal"
                )

        # G-006: Каждый Blueprint —SATISFIES→ Decision
        blueprints = self.get_nodes(NodeType.BLUEPRINT)
        for bp in blueprints:
            children = self.get_children(bp.id, RelationType.SATISFIES)
            has_decision = any(
                self.get_node(c.id) and self.get_node(c.id).type == NodeType.DECISION
                for c in children
            )
            if not has_decision:
                violations.append(
                    f"G-006: Blueprint {bp.id.hex[:8]} satisfies no Decision"
                )

        # G-007: Каждый Artifact должен иметь родителя-Blueprint
        # (Blueprint —PRODUCES→ Artifact)
        artifacts = self.get_nodes(NodeType.ARTIFACT)
        for art in artifacts:
            parents = self.get_parents(art.id, RelationType.PRODUCES)
            has_bp = any(
                self.get_node(p.id) and self.get_node(p.id).type == NodeType.BLUEPRINT
                for p in parents
            )
            if not has_bp:
                # Fallback: check REFERENCES edge too (backward compat)
                ref_parents = self.get_parents(art.id, RelationType.REFERENCES)
                has_bp_ref = any(
                    self.get_node(p.id) and self.get_node(p.id).type == NodeType.BLUEPRINT
                    for p in ref_parents
                )
                if not has_bp_ref:
                    violations.append(
                        f"G-007: Artifact {art.id.hex[:8]} is produced by no Blueprint"
                    )

        # G-001: Циклы
        if self._detect_cycle():
            violations.append("G-001: Circular dependency detected in graph")

        return violations

    def _detect_cycle(self) -> bool:
        """DFS-based цикл-детекция."""
        visited: set[UUID] = set()
        rec_stack: set[UUID] = set()

        def dfs(node_id: UUID) -> bool:
            if node_id in rec_stack:
                return True
            if node_id in visited:
                return False
            visited.add(node_id)
            rec_stack.add(node_id)
            for child in self.get_children(node_id):
                if dfs(child.id):
                    return True
            rec_stack.discard(node_id)
            return False

        return any(dfs(n.id) for n in self.get_nodes() if n.id not in visited)

    # ─── Utility ───────────────────────────────────────────────

    @property
    def node_count(self) -> int:
        return self._registry.node_count

    @property
    def edge_count(self) -> int:
        return self._registry.edge_count

    def summarize(self) -> dict:
        """Сводка графа для отладки и логов."""
        summary = self._registry.summary()
        summary["invariants"] = self.validate_invariants()
        return summary

    def summary(self) -> dict:
        """Алиас для summarize (совместимость с Registry.summary)."""
        return self.summarize()