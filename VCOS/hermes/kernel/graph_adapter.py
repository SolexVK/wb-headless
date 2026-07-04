"""VCOS — Semantic Graph Adapter v2

Адаптер: пишет в Registry, обновляет ProjectModel.
Единственный источник правды — Registry (не VisualProject, не дубликат).

Принципы:
  CM-001: Registry = плоское хранилище, ProjectModel = ID-ссылки
  CA-001: каждая запись = операция, а не просто создание ноды
"""

from typing import List, Optional
from uuid import UUID

from hermes.kernel.core import (
    Node, Edge, NodeType, LifecycleState, RelationType, EXTRA_TYPES, EXTRA_EDGE_TYPES
)
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel
from hermes.kernel.decision_logger import DecisionLogger, DecisionEntry
from hermes.kernel.snapshot import SnapshotChain
from hermes.kernel.snapshot_manager import SnapshotManager


class SemanticGraphAdapter:
    """Адаптер: пишет данные в Registry, обновляет ProjectModel ID-ссылками.

    Использование:
        registry = Registry()
        project = ProjectModel()
        adapter = SemanticGraphAdapter(registry, project)

        adapter.record_source("Хочу фото рубашки")
        adapter.record_intent("Рубашка для WB, фото на террасе кафе")
        adapter.record_goal("Промпт для одежды")
        adapter.record_decision("composition", "rule_of_thirds", "respect",
                                source="profile", rationale="Harari: respects thirds")
        adapter.record_blueprint()
        adapter.record_artifact("промпт...", "chatgpt")
    """

    def __init__(self, registry: Registry, project: ProjectModel):
        self.registry = registry
        self.project = project
        self.logger = DecisionLogger()
        self.snapshots = SnapshotChain()
        self.snaps = SnapshotManager(registry, project)
        self._auto_snapshot = True

    def _snapshot(self, reason: str = "") -> None:
        """Создать снэпшот, если auto-snapshot включён.

        Insight #9: Авто-валидация инвариантов при каждой мутации.
        """
        if self._auto_snapshot:
            self.snapshots.create(self.registry, self.project,
                                  author="adapter", reason=reason)
            # Валидация после каждой мутации
            from hermes.kernel.validator import Validator
            v = Validator(self.registry, self.project)
            violations = v.validate()
            for vv in violations:
                if vv.severity == "error":
                    self.logger.record("_system", "invariant_error",
                                       f"{vv.invariant}: {vv.message}",
                                       source="validator")

    def record_source(self, content: str, raw_type: str = "text") -> Node:
        """Записать Source — сырой ввод. Создаёт Source-Node + Edge к Intent."""
        node = Node(
            type=NodeType.SOURCE,
            state=LifecycleState.APPROVED,
            properties={"content": content, "raw_type": raw_type},
        )
        self.registry.register_node(node)
        self.project = self.project.with_source(content, raw_type=raw_type)

        # Edge: Source → Intent (если Intent уже есть)
        intents = self.registry.get_nodes(NodeType.INTENT)
        if intents:
            self.registry.register_edge(Edge(
                source=node.id,
                target=intents[0].id,
                type=RelationType.REFERENCES))
        self._snapshot(f"source: {content[:40]}")
        return node

    def record_intent(self, description: str) -> Node:
        """Записать Intent — корень проекта."""
        node = Node(
            type=NodeType.INTENT,
            state=LifecycleState.APPROVED,
            properties={"description": description},
        )
        self.registry.register_node(node)
        self.project = self.project.with_intent(node.id)
        self._snapshot(f"intent: {description[:40]}")
        return node

    def record_creative_strategy(self, core_idea: str, approach: str = "",
                                  target_emotion: str = "",
                                  visual_metaphor: str = "") -> Node:
        """Записать Creative Strategy — творческий замысел (156.txt).

        Отвечает на вопрос: "Каким способом мы достигнем цели?"
        Edge: CreativeStrategy → Intent.
        """
        node = Node(
            type=EXTRA_TYPES["CREATIVE_STRATEGY"],
            state=LifecycleState.APPROVED,
            properties={
                "core_idea": core_idea,
                "approach": approach,
                "target_emotion": target_emotion,
                "visual_metaphor": visual_metaphor,
            },
        )
        self.registry.register_node(node)
        self._snapshot(f"creative_strategy: {core_idea[:40]}")
        return node

    def record_narrative(self, description: str) -> Node:
        """Записать Narrative — сценарий/историю (Insight #8).

        Edge: Narrative → Intent.
        """
        node = Node(
            type=EXTRA_TYPES["NARRATIVE"],
            state=LifecycleState.APPROVED,
            properties={"description": description},
        )
        self.registry.register_node(node)
        self._snapshot(f"narrative: {description[:40]}")
        return node

    def record_visual_language(self, style: str, mood: str = "",
                               influences: Optional[List[str]] = None) -> Node:
        """Записать Visual Language — визуальный язык (Insight #8).

        Edge: VisualLanguage → Intent (EXPRESSES).
        """
        node = Node(
            type=EXTRA_TYPES["VISUAL_LANGUAGE"],
            state=LifecycleState.APPROVED,
            properties={
                "style": style,
                "mood": mood,
                "influences": influences or [],
            },
        )
        self.registry.register_node(node)

        intents = self.registry.get_nodes(NodeType.INTENT)
        if intents:
            self.registry.register_edge(Edge(
                source=intents[0].id,
                target=node.id,
                type=EXTRA_EDGE_TYPES["EXPRESSES"],
            ))
        self._snapshot(f"visual_language: {style}, {mood[:30]}")
        return node

    def record_goal(self, description: str, intent_node: Optional[Node] = None) -> Node:
        """Записать Goal и связать с Intent (CO-001 §2).

        Args:
            description: описание цели
            intent_node: узел Intent (если None — ищется первый в графе)
        """
        parent_intent_id = None
        if intent_node:
            parent_intent_id = intent_node.id
        else:
            intents = self.registry.get_nodes(NodeType.INTENT)
            if intents:
                parent_intent_id = intents[0].id

        props = {"description": description}
        if parent_intent_id:
            props["parent_intent_id"] = str(parent_intent_id)

        goal = Node(
            type=NodeType.GOAL,
            state=LifecycleState.APPROVED,
            properties=props,
        )
        self.registry.register_node(goal)
        self.project = self.project.with_goal(goal.id)

        # Edge: Goal → Intent
        if parent_intent_id:
            self.registry.register_edge(Edge(
                source=parent_intent_id,
                target=goal.id,
                type=RelationType.SUPPORTS,
            ))
        self._snapshot(f"goal: {description[:40]}")
        return goal

    def record_decision(self,
                        block: str,
                        field: str,
                        value: str,
                        source: str = "user",
                        rationale: str = "",
                        confidence: float = 0.7) -> Node:
        """Записать проектное решение.

        CA-001.7 (Decide): создаёт Decision-Node в Semantic Graph
        + Edge к активному Goal. DecisionLogger — индекс для быстрых поисков.

        Дефолт confidence=0.7: Decision создаётся сразу в состоянии APPROVED,
        а валидатор (CO-001 D-2) требует confidence ≥ 0.7 для APPROVED.
        """
        # Создать Decision-Node в Semantic Graph
        node = Node(
            type=NodeType.DECISION,
            state=LifecycleState.APPROVED,
            properties={
                "vsl_block": block,
                "vsl_field": field,
                "value": value,
                "source": source,
                "rationale": rationale,
                "confidence": confidence,
            },
        )
        self.registry.register_node(node)
        self.project = self.project.with_decision(node.id)

        # Edge: Decision → активный Goal
        goals = self.registry.get_nodes(NodeType.GOAL)
        if goals:
            self.registry.register_edge(Edge(
                source=node.id,
                target=goals[0].id,
                type=RelationType.SUPPORTS))

        # Записать в Decision Logger (индекс для быстрых поисков)
        self.logger.record(block, field, value, source, rationale, confidence)
        self._snapshot(f"decision: {block}.{field}={value[:30]}")
        return node

    def record_constraint(self,
                          description: str,
                          constraint_type: str = "must_have",
                          source: str = "user") -> Node:
        """Записать Constraint — ограничение проекта.

        CM-001.4 (Constraints): Constraint-Node + Edge к Goal.
        """
        node = Node(
            type=NodeType.CONSTRAINT,
            state=LifecycleState.APPROVED,
            properties={
                "description": description,
                "constraint_type": constraint_type,
                "source": source,
            },
        )
        self.registry.register_node(node)
        self.project = self.project.with_constraint(node.id)

        # Edge: Constraint → активный Goal
        goals = self.registry.get_nodes(NodeType.GOAL)
        if goals:
            self.registry.register_edge(Edge(
                source=node.id,
                target=goals[0].id,
                type=RelationType.CONSTRAINS))
        self._snapshot(f"constraint: {description[:40]}")
        return node

    def record_blueprint(self) -> Node:
        """Записать Blueprint — финальная проектная модель.

        Blueprint — объединение всех активных Decision (CM-001).
        Канон направлений (см. core.py RelationType):
          Blueprint —SATISFIES→ Decision (G-006).
        """
        bp = Node(
            type=NodeType.BLUEPRINT,
            state=LifecycleState.APPROVED,
            properties={"name": "Product Card Photo"},
        )
        self.registry.register_node(bp)
        self.project = self.project.with_blueprint(bp.id)

        # Edge: Blueprint → SATISFIES → каждый Decision (канон)
        decisions = self.registry.get_nodes(NodeType.DECISION)
        for d in decisions:
            self.registry.register_edge(Edge(
                source=bp.id,
                target=d.id,
                type=RelationType.SATISFIES))

        self._snapshot("blueprint")
        return bp

    def record_artifact(self, prompt: str, model: str) -> Node:
        """Записать Artifact — результат компиляции."""
        art = Node(
            type=NodeType.ARTIFACT,
            state=LifecycleState.APPROVED,
            properties={
                "prompt": prompt,  # полный промпт — без усечения (SSOT)
                "model": model,
                "length": len(prompt),
            },
        )
        self.registry.register_node(art)
        self.project = self.project.with_artifact(art.id)

        # Edge: Blueprint → PRODUCES → Artifact (канон направлений, G-007)
        blueprints = self.registry.get_nodes(NodeType.BLUEPRINT)
        if blueprints:
            self.registry.register_edge(Edge(
                source=blueprints[0].id,
                target=art.id,
                type=RelationType.PRODUCES))
        self._snapshot(f"artifact: {model}")
        return art

    # ─── Query ────────────────────────────────────────────────

    def why(self, field: str) -> str:
        """Ответить: почему это поле такое?"""
        return self.logger.why(field)

    def decisions_by_block(self, block: str) -> list[DecisionEntry]:
        """Все решения по VSL блоку."""
        return self.logger.get_by_block(block)

    def project_data(self) -> dict:
        """Собрать данные проекта для экспорта (PromptExporter).

        Читает из Registry, разрешая ID через ProjectModel.
        Маппинг: каждый field решения → именованный ключ для PromptExporter.
        Возвращает плоский dict, совместимый с build_full_story().
        """
        data = {}

        # Поля из DecisionLogger — field → value (без затирания)
        for entry in self.logger.decisions:
            # Пропускаем системные/внутренние блоки
            if entry.block in ("source", "intent", "goal", "blueprint", "artifact",
                               "cognitive_loop", "_system"):
                continue
            # Если поле уже есть — добавляем через "; "
            if entry.field in data:
                data[entry.field] += "; " + entry.value
            else:
                data[entry.field] = entry.value

        # Intent и Goal — из Registry (SSOT)
        intents = self.registry.get_nodes(NodeType.INTENT)
        if intents:
            data["intent"] = intents[0].properties.get("description", "")

        goals = self.registry.get_nodes(NodeType.GOAL)
        if goals:
            data["goal"] = goals[0].properties.get("description", "")

        # Profile — из ProjectModel
        data["profile"] = self.project.profile_name
        data["category"] = ", ".join(self.project.domain)
        data["model_target"] = self.project.model_target

        return data

    def summary(self) -> dict:
        """Сводка для отладки."""
        return {
            "registry": self.registry.summary(),
            "project": self.project.summary(),
            "decisions": len(self.logger),
            "snapshots": self.snapshots.summary() if self.snapshots else {},
        }

    def rollback_to(self, snapshot_id: str) -> None:
        """Откатиться к снэпшоту (создаёт новый снэпшот с состоянием target)."""
        self._auto_snapshot = False
        try:
            self.snapshots.rollback(snapshot_id, self.registry, self.project)
        finally:
            self._auto_snapshot = True

    def snapshot_history(self, limit: int = 10) -> list[dict]:
        """История снэпшотов."""
        return [{
            "id": s.id[:8],
            "parent": s.parent_id[:8] if s.parent_id else None,
            "version": s.version,
            "reason": s.reason[:60],
            "nodes": s.node_count,
            "edges": s.edge_count,
        } for s in self.snapshots.history(limit)]