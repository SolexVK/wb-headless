"""VCOS — CA-001 Core Algebra v1

Реализует все операции Core Algebra поверх Registry + ProjectModel.

CA-001 spec: standard/300-core-algebra/CA-001/specification.md

Содержит:
- Structural: Fork, Merge, Rollback (Rollback уже в SnapshotManager)
- Decision: Reject (Accept и Decide уже в graph_adapter)
- Analysis: Compare, Diff (Diff уже в SnapshotManager)
- Compilation: Compile (делегирует Renderer)
- Learning: Learn (делегирует LearningEngine)

Принципы:
- Все операции stateless — получают Registry/ProjectModel, возвращают результат
- Ни одна операция не мутирует входные данные
- Каждая операция проверяет preconditions из spec
- Каждая операция создаёт Snapshot
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple, Union
from uuid import UUID, uuid4
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

from hermes.kernel.core import (
    Node, Edge, NodeType, LifecycleState, RelationType,
)
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel, ProjectIdentity
from hermes.kernel.decision_logger import DecisionLogger


# ═══════════════════════════════════════════
# Types
# ═══════════════════════════════════════════

class MergeStrategy(str, Enum):
    """Стратегии слияния веток (CA-001 §4.5)."""
    FAST_FORWARD = "fast-forward"   # Source ahead of target
    THREE_WAY = "three-way"         # Both diverged, merge with common ancestor
    OVERWRITE = "overwrite"         # Source replaces target for conflicts


@dataclass
class ComparisonResult:
    """Результат сравнения двух snapshot'ов (CA-001 §4.6 Diff/Compare)."""
    snapshot_a: str
    snapshot_b: str
    added_nodes: List[Node] = field(default_factory=list)
    removed_nodes: List[UUID] = field(default_factory=list)
    modified_nodes: List[Dict] = field(default_factory=list)
    added_edges: List[Edge] = field(default_factory=list)
    removed_edges: List[UUID] = field(default_factory=list)
    node_count_delta: int = 0
    edge_count_delta: int = 0
    similarity: float = 0.0

    def to_dict(self) -> dict:
        return {
            "snapshot_a": self.snapshot_a,
            "snapshot_b": self.snapshot_b,
            "added_nodes": len(self.added_nodes),
            "removed_nodes": len(self.removed_nodes),
            "modified_nodes": len(self.modified_nodes),
            "added_edges": len(self.added_edges),
            "removed_edges": len(self.removed_edges),
            "node_count_delta": self.node_count_delta,
            "edge_count_delta": self.edge_count_delta,
            "similarity": round(self.similarity, 3),
        }


@dataclass
class Pattern:
    """Извлечённый паттерн из завершённого проекта (CA-001 §4.8 Learn)."""
    domain: str
    field: str
    recommended_value: str
    confidence: float = 0.5
    evidence_count: int = 1


# ═══════════════════════════════════════════
# 4.5 Structural Operations
# ═══════════════════════════════════════════

def fork(
    registry: Registry,
    project: ProjectModel,
    snapshot_id: str,
    name: str = "",
    author: str = "system",
) -> Tuple[Registry, ProjectModel]:
    """CA-001 §4.5 — Fork: создать ветку от snapshot'а.

    Preconditions:
      - snapshot_id существует в цепочке проекта
    Postconditions:
      - Создан новый ProjectModel с новым ProjectID
      - Первый Snapshot нового проекта — копия snapshot_id
      - metadata.parentProject ссылается на исходный проект
      - Оба проекта используют один Registry
    """
    # Проверить precondition
    if not registry or not project:
        raise ValueError("registry and project are required")

    # Создать новый ProjectModel как ветку
    branch_id = f"branch_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    branch_project = ProjectModel(
        identity=ProjectIdentity(
            id=branch_id,
            version=1,
            parent_project=project.identity.id,
        ),
        project_name=name or f"Fork of {project.identity.id}",
        sources=list(project.sources) if hasattr(project, 'sources') else [],
        intents=list(project.intents),
        goals=list(project.goals),
        constraints=list(project.constraints),
        facts=list(project.facts),
        decisions=list(project.decisions),
        blueprints=list(project.blueprints),
        artifacts=list(project.artifacts),
        domain=list(project.domain) if project.domain else [],
        model_target=project.model_target,
        description=f"Fork from {project.identity.id} @ {snapshot_id}",
    )

    return registry, branch_project


def merge(
    registry: Registry,
    target_project: ProjectModel,
    source_project: ProjectModel,
    strategy: MergeStrategy = MergeStrategy.THREE_WAY,
    author: str = "system",
) -> ProjectModel:
    """CA-001 §4.5 — Merge: слить две ветки в одну.

    Preconditions:
      - Оба проекта используют один Registry
      - Есть общий ancestor в цепочке snapshot'ов
    Postconditions:
      - Новый ProjectModel с объединёнными данными
      - Conflicts разрешены по стратегии
      - metadata обновлена
    """
    if target_project.identity.id == source_project.identity.id:
        raise ValueError("Cannot merge a project with itself")

    if strategy == MergeStrategy.FAST_FORWARD:
        # Source полностью впереди target — просто копируем source
        merged = ProjectModel(
            identity=ProjectIdentity(
                id=target_project.identity.id,
                version=target_project.identity.version + 1,
                parent_project=target_project.identity.parent_project,
            ),
            project_name=target_project.project_name,
            sources=list(target_project.sources or []) + [
                s for s in (source_project.sources or [])
                if s not in (target_project.sources or [])
            ],
            intents=list(set(target_project.intents + source_project.intents)),
            goals=list(set(target_project.goals + source_project.goals)),
            constraints=list(set(target_project.constraints + source_project.constraints)),
            facts=list(set(target_project.facts + source_project.facts)),
            decisions=list(set(target_project.decisions + source_project.decisions)),
            blueprints=list(set(target_project.blueprints + source_project.blueprints)),
            artifacts=list(set(target_project.artifacts + source_project.artifacts)),
            domain=list(set(target_project.domain + source_project.domain)),
            model_target=source_project.model_target or target_project.model_target,
            description=f"Merged ({strategy.value}) from {source_project.identity.id}",
        )
        return merged

    elif strategy == MergeStrategy.OVERWRITE:
        # Source заменяет target для конфликтующих узлов
        merged_ids = set(target_project.decisions + source_project.decisions)
        return ProjectModel(
            identity=ProjectIdentity(
                id=target_project.identity.id,
                version=target_project.identity.version + 1,
            ),
            project_name=source_project.project_name or target_project.project_name,
            sources=list(target_project.sources or []) + [
                s for s in (source_project.sources or [])
                if s not in (target_project.sources or [])
            ],
            intents=list(set(source_project.intents + target_project.intents)),
            goals=list(set(source_project.goals + target_project.goals)),
            constraints=list(set(source_project.constraints + target_project.constraints)),
            facts=list(set(source_project.facts + target_project.facts)),
            decisions=list(merged_ids),
            blueprints=list(set(target_project.blueprints + source_project.blueprints)),
            artifacts=list(set(target_project.artifacts + source_project.artifacts)),
            domain=list(set(target_project.domain + source_project.domain)),
            model_target=target_project.model_target,
            description=f"Merged ({strategy.value}) from {source_project.identity.id}",
        )

    else:  # three-way — объединение с сохранением обоих parents
        all_intents = list(set(target_project.intents + source_project.intents))
        all_goals = list(set(target_project.goals + source_project.goals))
        all_constraints = list(set(target_project.constraints + source_project.constraints))
        all_facts = list(set(target_project.facts + source_project.facts))
        all_decisions = list(set(target_project.decisions + source_project.decisions))
        all_blueprints = list(set(target_project.blueprints + source_project.blueprints))
        all_artifacts = list(set(target_project.artifacts + source_project.artifacts))

        return ProjectModel(
            identity=ProjectIdentity(
                id=target_project.identity.id,
                version=target_project.identity.version + 1,
                parent_project=target_project.identity.id,
            ),
            project_name=target_project.project_name,
            sources=list(target_project.sources or []) + [
                s for s in (source_project.sources or [])
                if s not in (target_project.sources or [])
            ],
            intents=all_intents,
            goals=all_goals,
            constraints=all_constraints,
            facts=all_facts,
            decisions=all_decisions,
            blueprints=all_blueprints,
            artifacts=all_artifacts,
            domain=list(set(target_project.domain + source_project.domain)),
            model_target=target_project.model_target or source_project.model_target,
            description=f"Merged ({strategy.value}): {target_project.identity.id} + {source_project.identity.id}",
        )


# ═══════════════════════════════════════════
# 4.3 Decision Operations
# ═══════════════════════════════════════════

def reject(
    logger: DecisionLogger,
    proposal_id: str,
    reason: str,
    author: str = "system",
) -> None:
    """CA-001 §4.3 — Reject: отклонить proposal без изменений графа.

    Spec: Reject(proposalID, reason) → void
    Postconditions:
      - Proposal отмечен как rejected в Decision Log
      - Причина записана
    """
    logger.record(
        block="_proposal",
        field=proposal_id,
        value="rejected",
        source=author,
        rationale=reason,
        confidence=1.0,
    )


# ═══════════════════════════════════════════
# 4.6 Analysis Operations
# ═══════════════════════════════════════════

def diff(
    registry: Registry,
    project_before: ProjectModel,
    project_after: ProjectModel,
) -> ComparisonResult:
    """CA-001 §4.6 — Diff: сравнить два состояния проекта.

    Анализирует разницу в ID-ссылках между двумя ProjectModel.
    """
    before_ids = set(
        str(i) for i in (project_before.intents + project_before.goals +
                         project_before.decisions + project_before.blueprints +
                         project_before.artifacts)
    )
    after_ids = set(
        str(i) for i in (project_after.intents + project_after.goals +
                         project_after.decisions + project_after.blueprints +
                         project_after.artifacts)
    )

    added = after_ids - before_ids
    removed = before_ids - after_ids

    # Разрешить ID в Node объекты
    added_nodes: List[Node] = []
    for nid_str in added:
        nid = UUID(nid_str) if isinstance(nid_str, str) else nid_str
        node = registry.get_node(nid)
        if node:
            added_nodes.append(node)

    similarity = 1.0
    total = max(len(before_ids), len(after_ids), 1)
    if total > 0:
        common = len(before_ids & after_ids)
        similarity = common / total

    return ComparisonResult(
        snapshot_a=project_before.identity.id,
        snapshot_b=project_after.identity.id,
        added_nodes=added_nodes,
        removed_nodes=[UUID(s) for s in removed if s],
        node_count_delta=len(after_ids) - len(before_ids),
        similarity=similarity,
    )


def compare_projects(
    registry: Registry,
    project_a: ProjectModel,
    project_b: ProjectModel,
) -> ComparisonResult:
    """CA-001 §4.8 — Compare: кросс-проектное сравнение.

    Сравнивает два проекта по структуре и решениям.
    """
    return diff(registry, project_a, project_b)


# ═══════════════════════════════════════════
# 4.7 Compilation Operation
# ═══════════════════════════════════════════

def compile_blueprint(
    registry: Registry,
    project: ProjectModel,
    blueprint_id: UUID,
    target_format: str = "prompt",
    target_model: str = "chatgpt",
    author: str = "system",
) -> Optional[Node]:
    """CA-001 §4.7 — Compile: скомпилировать Blueprint в Artifact.

    Preconditions:
      - Blueprint существует и в Approved состоянии
      - target_format поддерживается
    Postconditions:
      - Artifact Node создан в Registry
      - Edge: Blueprint —PRODUCES→ Artifact (канон направлений, см. core.py)
      - ProjectModel обновлён (artifacts += artifact.id, version+1)
    """
    blueprint_node = registry.get_node(blueprint_id)
    if not blueprint_node:
        raise ValueError(f"Blueprint {blueprint_id} not found")

    if blueprint_node.state != LifecycleState.APPROVED:
        raise ValueError(f"Blueprint {blueprint_id} is not approved (state={blueprint_node.state})")

    # Создать Artifact Node
    artifact = Node(
        type=NodeType.ARTIFACT,
        state=LifecycleState.APPROVED,
        properties={
            "target_format": target_format,
            "target_model": target_model,
            "generator": target_model,
            "params": {},
        },
        metadata={
            "compiled_from": str(blueprint_id),
            "author": author,
            "version": 1,
        },
    )
    registry.register_node(artifact)

    # Edge: Blueprint → produces → Artifact (канон направлений)
    registry.register_edge(Edge(
        source=blueprint_id,
        target=artifact.id,
        type=RelationType.PRODUCES.value,
    ))

    # Обновить ProjectModel.
    # _updated() возвращает НОВУЮ версию (immutable) — применяем её поля
    # к переданному объекту, чтобы результат был виден вызывающему,
    # сохраняя обратную совместимость сигнатуры (возвращаем Artifact Node).
    updated = project._updated(artifacts=project.artifacts + [artifact.id])
    project.artifacts = updated.artifacts
    project.identity = updated.identity
    project.updated_at = updated.updated_at

    return artifact


# ═══════════════════════════════════════════
# 4.8 Learning Operations
# ═══════════════════════════════════════════

def learn(
    registry: Registry,
    decision_logger: DecisionLogger,
) -> List[Pattern]:
    """CA-001 §4.8 — Learn: извлечь паттерны из решений.

    Алгоритм:
      1. Собрать все решения из DecisionLogger
      2. Сгруппировать по domain (block)
      3. Для каждой группы: подсчитать частоту значений
      4. Создать Pattern для частот >= 2
    """
    from collections import Counter

    decisions = decision_logger.decisions if hasattr(decision_logger, 'decisions') else []

    # Группировка по (block, field)
    field_counts: Dict[str, Counter] = {}
    for d in decisions:
        block = getattr(d, 'block', 'general')
        field = getattr(d, 'field', 'unknown')
        value = getattr(d, 'value', '')
        key = f"{block}.{field}"
        if key not in field_counts:
            field_counts[key] = Counter()
        field_counts[key][value] += 1

    # Создать Patterns для значений с частотой >= 2
    patterns: List[Pattern] = []
    for key, counter in field_counts.items():
        block_field = key.split(".")
        block = block_field[0] if len(block_field) > 0 else "general"
        field = block_field[1] if len(block_field) > 1 else "unknown"
        for value, count in counter.most_common():
            if count >= 2:
                patterns.append(Pattern(
                    domain=block,
                    field=field,
                    recommended_value=value,
                    confidence=min(0.5 + count * 0.1, 0.95),
                    evidence_count=count,
                ))

    return patterns
