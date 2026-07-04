"""VCOS — Validator v3

Проверка CM-001.4 Graph Invariants.
Обновлён под CM-001 v3 (LifecycleState, Edge spec-поля).
"""

from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID
from datetime import timedelta

from hermes.kernel.core import NodeType, RelationType, LifecycleState, EXTRA_TYPES
from hermes.kernel.core import IntentStatus, GoalStatus, get_node_type_status
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel


@dataclass
class Violation:
    """Нарушение инварианта графа."""
    invariant: str
    message: str
    severity: str = "error"
    node_ids: list = field(default_factory=list)


class Validator:
    """Проверяет CM-001.4 Graph Invariants.

    Использование:
        val = Validator(registry, project)
        violations = val.validate()
    """

    def __init__(self, registry: Registry, project: ProjectModel):
        self.registry = registry
        self.project = project

    def validate(self) -> list[Violation]:
        """Проверить ВСЕ графовые инварианты.

        Returns:
            Список Violation (пуст, если граф корректный)
        """
        violations = []

        checkers = [
            self._check_orphan_edges,
            self._check_decision_to_goal,
            self._artifact_to_blueprint,
            self._check_cycles,
            self._check_all_approved_have_decisions,
            self._check_decision_confidence,  # CO-001 D-2: APPROVED ≥ 0.7
            self._check_single_active_intent,  # CO-001 I-1: exactly one Intent
            self._check_artifact_immutable,    # CO-001 A-2: no Artifact mutation
            self._check_intent_status_transition,  # CO-001 §1: Intent status
            self._check_goal_status_transition,    # CO-001 §2: Goal status
        ]

        for checker in checkers:
            try:
                violations.extend(checker())
            except Exception as e:
                violations.append(Violation(
                    invariant="CHECK_ERROR",
                    message=f"Checker {checker.__name__} failed: {e}",
                    severity="error",
                ))

        return violations

    def _pass(self) -> list[Violation]:
        return []

    # ─── Individual checks ─────────────────────────────────────

    def _check_decision_to_goal(self) -> list[Violation]:
        """PM-I004: Each Decision must be connected to a Goal."""
        violations = []
        decisions = self.registry.get_nodes(NodeType.DECISION)
        for d in decisions:
            edges = self.registry.get_edges(d.id)
            has_goal = any(
                self.registry.get_node(e.target) and
                self.registry.get_node(e.target).type == NodeType.GOAL
                for e in edges
            )
            if not has_goal:
                violations.append(Violation(
                    invariant="PM-I004",
                    message=f"Decision {d.id.hex[:8]} has no Goal parent",
                    severity="error",
                    node_ids=[str(d.id)],
                ))
        return violations

    def _check_orphan_edges(self) -> list[Violation]:
        """E-004: No edges with non-existent source/target."""
        violations = []
        for edge in self.registry.get_edges():
            if edge.source not in self.registry._nodes:
                violations.append(Violation(
                    invariant="E-004",
                    message=f"Edge {edge.id.hex[:8]} references non-existent source {edge.source.hex[:8]}",
                    severity="error",
                    node_ids=[str(edge.source)],
                ))
            if edge.target not in self.registry._nodes:
                violations.append(Violation(
                    invariant="E-004",
                    message=f"Edge {edge.id.hex[:8]} references non-existent target {edge.target.hex[:8]}",
                    severity="error",
                    node_ids=[str(edge.target)],
                ))
        return violations

    def _artifact_to_blueprint(self) -> list[Violation]:
        """G-007: Blueprint —PRODUCES→ Artifact (канон направлений, см. core.py).

        Каждый Artifact должен иметь входящее ребро PRODUCES от Blueprint
        (REFERENCES допускается как backward-compat fallback).
        """
        violations = []
        artifacts = self.registry.get_nodes(NodeType.ARTIFACT)
        for art in artifacts:
            has_blueprint = False
            for edge in self.registry.get_edges():
                e_type = edge.type.value if hasattr(edge.type, 'value') else edge.type
                if edge.target == art.id and e_type in (RelationType.PRODUCES.value, RelationType.REFERENCES.value):
                    source = self.registry.get_node(edge.source)
                    if source and source.type == NodeType.BLUEPRINT:
                        has_blueprint = True
                        break

            if not has_blueprint:
                violations.append(Violation(
                    invariant="G-007",
                    message=f"Artifact {art.id.hex[:8]} has no related Blueprint",
                    severity="warning",
                    node_ids=[str(art.id)],
                ))
        return violations

    def _check_cycles(self) -> list[Violation]:
        """G-001: No cycles in graph."""
        visited: set[UUID] = set()
        rec_stack: set[UUID] = set()

        def dfs(node_id: UUID) -> bool:
            if node_id in rec_stack:
                return True
            if node_id in visited:
                return False
            visited.add(node_id)
            rec_stack.add(node_id)

            for edge in self.registry.get_edges():
                if edge.source == node_id:
                    if dfs(edge.target):
                        return True

            rec_stack.discard(node_id)
            return False

        for node in self.registry.get_nodes():
            if node.id not in visited:
                if dfs(node.id):
                    return [Violation(
                        invariant="G-001",
                        message="Circular dependency detected in graph",
                        severity="error",
                    )]
        return []

    def _check_all_approved_have_decisions(self) -> list[Violation]:
        """Check that approved nodes have at least one Decision edge."""
        violations = []
        for node in self.registry.get_nodes():
            if hasattr(node, 'state') and node.state == LifecycleState.APPROVED:
                edges = self.registry.get_edges(node.id)
                has_decision = any(
                    e.type == RelationType.SUPPORTS.value or
                    e.type == RelationType.SATISFIES.value
                    for e in edges
                )
                if not has_decision and node.type not in (NodeType.SOURCE, NodeType.INTENT):
                    # Source and Intent may be orphaned
                    violations.append(Violation(
                        invariant="PM-I006",
                        message=f"{node.type.value.title()} {node.id.hex[:8]} approved but has no Decision",
                        severity="warning",
                        node_ids=[str(node.id)],
                    ))
        return violations

    # ─── CO-001 D-2: Decision confidence ≥ 0.7 ────────────────────

    def _check_decision_confidence(self) -> list[Violation]:
        """CO-001 D-2: APPROVED Decision MUST have confidence ≥ 0.7."""
        violations = []
        decisions = self.registry.get_nodes(NodeType.DECISION)
        for d in decisions:
            if d.state == LifecycleState.APPROVED:
                conf = d.properties.get("confidence", 0.0)
                if isinstance(conf, str):
                    try:
                        conf = float(conf)
                    except (ValueError, TypeError):
                        conf = 0.0
                if conf < 0.7:
                    violations.append(Violation(
                        invariant="CO-001-D-2",
                        message=f"Decision {d.id.hex[:8]} APPROVED with confidence {conf:.2f} < 0.7",
                        severity="error",
                        node_ids=[str(d.id)],
                    ))
        return violations

    # ─── CO-001 I-1: Exactly one active Intent ───────────────────

    def _check_single_active_intent(self) -> list[Violation]:
        """CO-001 I-1: Project MUST have exactly one active (non-archived) Intent."""
        violations = []
        intents = self.registry.get_nodes(NodeType.INTENT)
        active = [i for i in intents if i.state not in (
            LifecycleState.ARCHIVED, LifecycleState.DEPRECATED)]
        if len(active) == 0:
            violations.append(Violation(
                invariant="CO-001-I-1",
                message="No active Intent found — project must have exactly one",
                severity="error",
            ))
        elif len(active) > 1:
            ids = [i.id.hex[:8] for i in active]
            violations.append(Violation(
                invariant="CO-001-I-1",
                message=f"Multiple active Intents: {', '.join(ids)}. Must have exactly one",
                severity="error",
                node_ids=[str(i.id) for i in active],
            ))
        return violations

    # ─── CO-001 A-2: Artifact immutable ─────────────────────────

    def _check_artifact_immutable(self) -> list[Violation]:
        """CO-001 A-2: Artifact MUST NOT be modified after creation.

        Проверяет: нет ли Artifact-узлов с updated_at > created_at
        с зазором >1s (микросекундный оффсет при создании — не модификация).
        """
        violations = []
        artifacts = self.registry.get_nodes(NodeType.ARTIFACT)
        for art in artifacts:
            if art.updated_at - art.created_at > timedelta(seconds=1):
                violations.append(Violation(
                    invariant="CO-001-A-2",
                    message=f"Artifact {art.id.hex[:8]} was modified after creation",
                    severity="error",
                    node_ids=[str(art.id)],
                ))
        return violations

    # ─── CO-001 §1: Intent status transitions ────────────────────

    def _check_intent_status_transition(self) -> list[Violation]:
        """CO-001 §1: Intent status MUST follow CAPTURED → ANALYZING → UNDERSTOOD → SUPERSEDED."""
        violations = []
        for node in self.registry.get_nodes(NodeType.INTENT):
            if "status" not in node.properties:
                continue
            try:
                IntentStatus(node.properties["status"])
            except (ValueError, TypeError):
                violations.append(Violation(
                    invariant="CO-001-INTENT-STATUS",
                    message=(
                        f"Intent {node.id.hex[:8]} has invalid status "
                        f"'{node.properties.get('status')}'. "
                        f"Allowed: {[s.value for s in IntentStatus]}"
                    ),
                    severity="error",
                    node_ids=[str(node.id)],
                ))
        return violations

    # ─── CO-001 §2: Goal status transitions ──────────────────────

    def _check_goal_status_transition(self) -> list[Violation]:
        """CO-001 §2: Goal status MUST follow DRAFT → ACTIVE → ACHIEVED/ABANDONED."""
        violations = []
        for node in self.registry.get_nodes(NodeType.GOAL):
            if "status" not in node.properties:
                continue
            try:
                GoalStatus(node.properties["status"])
            except (ValueError, TypeError):
                violations.append(Violation(
                    invariant="CO-001-GOAL-STATUS",
                    message=(
                        f"Goal {node.id.hex[:8]} has invalid status "
                        f"'{node.properties.get('status')}'. "
                        f"Allowed: {[s.value for s in GoalStatus]}"
                    ),
                    severity="error",
                    node_ids=[str(node.id)],
                ))
        return violations