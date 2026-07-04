"""VCOS — SemanticGraph v1

Единый класс SemanticGraph — логический уровень SSOT (Encyclopedia §5.0).

Два уровня SSOT:
  - Логический: SemanticGraph (ID-ссылки + query методы)
  - Физический: Registry (Nodes + Edges)

SemanticGraph — immutable. Все with_* методы возвращают новый экземпляр.
Transformers получают SemanticGraph, не мутируют его, возвращают TransformResult.

Использование:
    registry = Registry()
    project = ProjectModel()
    graph = SemanticGraph(project=project, registry=registry)

    # Query
    decisions = graph.get_decisions()
    intents = graph.get_intents()

    # Mutation (immutable — возвращает новый граф)
    graph2 = graph.with_domain(["одежда"])
    graph3 = graph2.with_profile("harari")
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional
from uuid import UUID

from hermes.kernel.project_model import ProjectModel
from hermes.kernel.registry import Registry
from hermes.kernel.core import Node, NodeType

# Ленивый импорт TransformResult для избежания цикла
_transform_result_type = None


class SemanticGraph:
    """SemanticGraph — единый класс доступа к графу проекта.

    Encyclopedia §5.0:
      SemanticGraph — центральная ось; два уровня SSOT:
        логический (SemanticGraph) и физический (Registry).

    Принципы:
      - Immutable: с каждым with_* создаётся новый экземпляр
      - Query методы делегируют в Registry
      - ID-ссылки хранятся в ProjectModel
    """

    def __init__(self, project: Optional[ProjectModel] = None,
                 registry: Optional[Registry] = None):
        self._project = project or ProjectModel()
        self._registry = registry
        self._version: int = self._project.identity.version

    # ═══════════════════════════════════════════════════════════
    # Properties
    # ═══════════════════════════════════════════════════════════

    @property
    def project(self) -> ProjectModel:
        """Внутренний ProjectModel."""
        return self._project

    @property
    def registry(self) -> Optional[Registry]:
        """Registry (может быть None для read-only сессий)."""
        return self._registry

    @property
    def version(self) -> int:
        """Версия графа."""
        return self._project.identity.version

    # ═══════════════════════════════════════════════════════════
    # Immutable operations — возвращают новый SemanticGraph
    # ═══════════════════════════════════════════════════════════

    def _updated(self, project: ProjectModel) -> "SemanticGraph":
        """Создать новый SemanticGraph с обновлённым ProjectModel."""
        return SemanticGraph(project=project, registry=self._registry)

    # ─── Domain / Profile / Target ───────────────────────────

    def with_domain(self, domain: List[str]) -> "SemanticGraph":
        """Вернуть новый граф с обновлённым domain."""
        return self._updated(self._project.with_domain(domain))

    def with_profile(self, profile_name: str) -> "SemanticGraph":
        """Вернуть новый граф с обновлённым profile_name."""
        return self._updated(self._project.with_profile(profile_name))

    def with_model_target(self, model_target: str) -> "SemanticGraph":
        """Вернуть новый граф с обновлённым model_target."""
        return self._updated(self._project.with_model_target(model_target))

    def with_project_name(self, name: str) -> "SemanticGraph":
        """Вернуть новый граф с обновлённым project_name."""
        return self._updated(self._project.with_project_name(name))

    # ─── ID operations ───────────────────────────────────────

    def with_intent(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_intent(node_id))

    def with_goal(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_goal(node_id))

    def with_constraint(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_constraint(node_id))

    def with_fact(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_fact(node_id))

    def with_decision(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_decision(node_id))

    def with_blueprint(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_blueprint(node_id))

    def with_artifact(self, node_id: UUID) -> "SemanticGraph":
        return self._updated(self._project.with_artifact(node_id))

    # ─── Source ──────────────────────────────────────────────

    def with_source(self, content: str, raw_type: str = "text",
                    format: str = "text/plain") -> "SemanticGraph":
        return self._updated(self._project.with_source(content, raw_type, format))

    # ═══════════════════════════════════════════════════════════
    # Query methods — делегируют в Registry (+ fallback)
    # ═══════════════════════════════════════════════════════════

    @property
    def nodes(self) -> List[Node]:
        """Все узлы в графе (из Registry)."""
        if self._registry:
            return self._registry.get_nodes()
        return []

    def get_nodes(self, *types) -> List[Node]:
        """Получить узлы указанных типов."""
        if self._registry:
            return self._registry.get_nodes(*types)
        return []

    def get_decisions(self) -> List[Node]:
        """Получить все Decision-узлы."""
        return self.get_nodes(NodeType.DECISION)

    def get_intents(self) -> List[Dict[str, Any]]:
        """Получить все Intents."""
        if not self._registry:
            return []
        nodes = self._registry.get_nodes(NodeType.INTENT)
        return [
            {
                "field": getattr(n, "field", "") or n.properties.get("field", ""),
                "value": getattr(n, "value", "") or n.properties.get("value", ""),
                "label": getattr(n, "label", "") or n.properties.get("description", ""),
            }
            for n in nodes
        ]

    def get_goals(self) -> List[Node]:
        """Получить все Goal-узлы."""
        return self.get_nodes(NodeType.GOAL)

    def get_constraints(self) -> List[Node]:
        """Получить все Constraint-узлы."""
        return self.get_nodes(NodeType.CONSTRAINT)

    def get_blueprints(self) -> List[Node]:
        """Получить все Blueprint-узлы."""
        return self.get_nodes(NodeType.BLUEPRINT)

    def get_artifacts(self) -> List[Node]:
        """Получить все Artifact-узлы."""
        return self.get_nodes(NodeType.ARTIFACT)

    @property
    def domain(self) -> List[str]:
        """Domain из ProjectModel."""
        return self._project.domain

    @property
    def profile_name(self) -> str:
        """Profile name из ProjectModel."""
        return self._project.profile_name

    @property
    def model_target(self) -> str:
        """Model target из ProjectModel."""
        return self._project.model_target

    # ═══════════════════════════════════════════════════════════
    # Structural operations (CA-001 §4.5)
    # ═══════════════════════════════════════════════════════════

    def split_node(self, node_id: UUID,
                   parts: List[Dict[str, Any]],
                   rationale: str = "") -> Any:
        """CA-001 Split: Разделить сущность на две или более.

        Encyclopedia: Split = разделение сущности на две.
        CA-001 review: create two new Nodes, create Edges from each to
        the original, then archive the original.

        Args:
            node_id: ID узла для разделения
            parts: список описаний новых узлов
                   [{type: str, properties: dict, label: str}, ...]
            rationale: причина разделения

        Returns:
            TransformResult с proposals для:
              - создания новых узлов
              - создания рёбер к оригиналу
              - архивации оригинального узла
        """
        # Lazy import to avoid circular dependency
        from hermes.transformers.base import TransformResult

        proposals = []

        # 1. Archive original node
        proposals.append({
            "type": "update_node",
            "node_id": str(node_id),
            "updates": {
                "state": "Archived",
                "properties": {"archived_reason": rationale},
            },
            "source": "semantic_graph.split_node",
            "confidence": 1.0,
        })

        # 2. Create new nodes + edges to original
        for i, part in enumerate(parts):
            node_type_name = part.get("type", "Intent")
            props = part.get("properties", {})
            props["split_from"] = str(node_id)
            props["split_part"] = i

            proposals.append({
                "type": "create_node",
                "node": {
                    "type": node_type_name,
                    "properties": props,
                },
                "source": "semantic_graph.split_node",
                "confidence": 1.0,
            })

            proposals.append({
                "type": "create_edge",
                "edge": {
                    "source": str(node_id),
                    "target": f"__new_node_{i}__",  # resolved by _apply_proposal
                    "type": "SPLIT_FROM",
                    "properties": {"part": i, "rationale": rationale},
                },
                "source": "semantic_graph.split_node",
                "confidence": 1.0,
            })

        return TransformResult(
            graph=self,
            proposals=proposals,
            log={
                "operation": "split",
                "source_node": str(node_id),
                "parts_count": len(parts),
                "parts": [p.get("label", "") for p in parts],
            },
        )

    # ═══════════════════════════════════════════════════════════
    # Serialization
    # ═══════════════════════════════════════════════════════════

    def to_dict(self) -> dict:
        """Плоский словарь для экспорта."""
        return self._project.to_dict()

    def summary(self) -> dict:
        """Сводка для отладки."""
        return self._project.summary()

    def project_data(self) -> dict:
        """Данные проекта для экспорта (через SemanticGraphAdapter)."""
        try:
            from hermes.kernel.graph_adapter import SemanticGraphAdapter
            if self._registry:
                adapter = SemanticGraphAdapter(self._registry, self._project)
                return adapter.project_data()
        except ImportError:
            pass
        return self.to_dict()

    # ═══════════════════════════════════════════════════════════
    # Magic methods
    # ═══════════════════════════════════════════════════════════

    def __repr__(self) -> str:
        return f"<SemanticGraph v{self.version} domain={self.domain}>"