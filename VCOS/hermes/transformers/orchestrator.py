"""VCOS — TransformerOrchestrator v1

Главный оркестратор: управляет жизненным циклом проекта через цепочку трансформеров.

CP-001 §4.5 — Transformer Chain: Interview → Design → Compile
I-003 — Separation of Concerns: Оркестратор ТОЛЬКО диспетчеризирует
I-004 — Decision-Driven State: Все изменения через Proposal → Decide
I-008 — Graph-First Communication: Все через Semantic Graph

Принцип:
  TransformerOrchestrator — НЕ содержит бизнес-логики.
  Он только:
    1. Собирает контекст
    2. Выбирает трансформеры по фазе
    3. Запускает цепочку
    4. Записывает решения через Registry
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from hermes.transformers.base import TransformerContext, TransformResult
from hermes.transformers.pipeline_transformer import PipelineTransformer
from hermes.kernel.core import Node, Edge, NodeType, LifecycleState
from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel

# SemanticGraph — единый тип графа
try:
    from hermes.kernel.semantic_graph import SemanticGraph
except ImportError:
    SemanticGraph = None  # fallback для тестов без импорта


@dataclass
class CognitiveCycleState:
    """Состояние когнитивного цикла (Computational Theory §2).

    Observe → Evaluate → Decide → Act → Record
    """
    observed_gap: List[str] = field(default_factory=list)
    evaluated_actions: List[Dict[str, Any]] = field(default_factory=list)
    current_decision: Optional[Dict[str, Any]] = None
    recorded_decisions: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class OrchestratorState:
    """Состояние оркестратора."""
    session_id: str = ""
    started_at: str = ""
    status: str = "idle"
    last_result: dict = field(default_factory=dict)
    current_phase: str = ""
    completed_phases: list = field(default_factory=list)


class TransformerOrchestrator:
    """Оркестратор жизненного цикла проекта через трансформеры.

    Использование:
        orch = TransformerOrchestrator()
        orch.register_transformers(...)
        result = orch.run_chain(model, registry, phases=["interview"])
    """

    def __init__(self):
        self.registry: Optional[Registry] = None
        self.project: Any = None
        self.state = OrchestratorState()
        self.cognitive = CognitiveCycleState()  # CompTheory §2
        self.pipeline = PipelineTransformer()
        self._phase_names: List[str] = [
            "interview",      # Сбор данных от пользователя
            "knowledge",      # Поиск знаний
            "design",         # Визуальное проектирование
            "inference",      # LLM reasoning
            "compile",        # Компиляция в артефакт
        ]

    def register(self, transformer):
        """Зарегистрировать трансформер (алиас register_transformers)."""
        self.register_transformers(transformer)

    def register_transformers(self, *transformers):
        """Зарегистрировать трансформеры.

        Args:
            *transformers: экземпляры Transformer
        """
        for tf in transformers:
            self.pipeline.register(tf)

    def set_routes(self, routes: Dict[str, str]):
        """Явная маршрутизация фаза → имя трансформера (см. PipelineTransformer)."""
        self.pipeline.set_routes(routes)

    def set_phases(self, phases: List[str]):
        """Установить последовательность фаз для цепочки.

        Args:
            phases: список имён фаз (interview, design, compile, ...)
        """
        self._phase_names = phases

    def get_phases(self) -> List[Dict[str, Any]]:
        """Вернуть список фаз."""
        return [{"name": p} for p in self._phase_names]

    def setup_pipeline(self, phases: Optional[List[str]] = None,
                       extra_config: Optional[Dict[str, Any]] = None):
        """Настроить конвейер.

        Создаёт шаги PipelineTransformer для каждой фазы.

        Args:
            phases: список фаз (по умолчанию self._phase_names)
            extra_config: дополнительная конфигурация для всех шагов
        """
        self.pipeline.clear_phases()
        target_phases = phases or self._phase_names
        config = extra_config or {}

        for phase in target_phases:
            self.pipeline.add_step(phase, config)

    def run_chain(self, graph: 'SemanticGraph', registry: Registry,
                  phases: Optional[List[str]] = None,
                  context_config: Optional[Dict[str, Any]] = None) -> TransformResult:
        """Запустить цепочку трансформеров.

        Encyclopedia: Transformer(SemanticGraph) → SemanticGraph

        Args:
            graph: SemanticGraph — начальное состояние графа
            registry: Registry — все Nodes и Edges
            phases: список фаз для запуска (опционально, по умолчанию все)
            context_config: дополнительная конфигурация контекста

        Returns:
            TransformResult — финальный SemanticGraph после всех шагов
        """
        self.registry = registry

        # Auto-wrap ProjectModel into SemanticGraph (для совместимости с core.py)
        if isinstance(graph, ProjectModel) and SemanticGraph is not None:
            graph = SemanticGraph(project=graph, registry=registry)
        self.project = graph

        if phases:
            self.setup_pipeline(phases, context_config)
        elif not self.pipeline._phases:
            self.setup_pipeline(context_config=context_config)

        # Построить контекст
        from datetime import datetime, timezone
        context = TransformerContext(
            registry=registry,
            config=context_config or {},
            metadata={
                "session_id": self.state.session_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "parent_transformer": "orchestrator",
            },
        )

        # Запустить цепочку
        result = self.pipeline.run_chain(graph, context)

        # Обновить состояние
        if result.graph is not graph:
            self.project = result.graph

        self.state.completed_phases.extend(phases or self._phase_names)
        self.state.last_result = result.log

        return result

    def run_single(self, graph: 'SemanticGraph', registry: Registry,
                   phase: str, config: Optional[Dict[str, Any]] = None) -> TransformResult:
        """Запустить одну фазу с когнитивным циклом.

        CompTheory §2: Observe → Evaluate → Decide → Act → Record

        Args:
            graph: SemanticGraph
            registry: Registry
            phase: имя фазы
            config: конфигурация

        Returns:
            TransformResult
        """
        # Cognitive Cycle для одной фазы
        gap = self.observe(graph, phase)
        actions = self.evaluate(gap, phase)
        decision = self.decide(actions, phase)

        result = self.run_chain(graph, registry, phases=[phase],
                              context_config=config)

        self.record(graph, decision, result, phase)

        return result

    # ─── Cognitive Loop (CompTheory §2) ────────────────────

    def observe(self, graph: 'SemanticGraph', phase: str) -> List[str]:
        """Observe: прочитать граф и найти gap для фазы.

        CompTheory §2.1: Cognitive Gap — что отсутствует для данной фазы.

        Returns:
            List[str] — список полей, которые нужно заполнить
        """
        blocks_map = {
            "category": ["category", "product_type"],
            "product": ["type", "color", "material", "brand"],
            "model_scene": ["model", "environment", "character"],
            "reference": ["reference"],
            "constraints": ["must_have", "must_not"],
            "profile": ["profile", "director"],
            "direction": ["composition", "camera", "lighting", "color", "style", "mood"],
            "creative_strategy": ["core_idea", "approach", "target_emotion", "visual_metaphor"],
            "inference": ["lens", "lighting_setup", "color_palette", "composition_type"],
            "control": ["consistency", "completeness", "confidence_check"],
        }
        # Найти блоки для фазы
        fields_to_check = []
        for block_key, fields in blocks_map.items():
            if block_key == phase or phase in block_key:
                fields_to_check.extend(fields)

        if not fields_to_check:
            fields_to_check = [phase]

        # Проверить, какие поля уже есть в графе
        gap = []
        for field in fields_to_check:
            has_value = False
            if hasattr(graph, "get_nodes"):
                try:
                    from hermes.kernel.core import NodeType
                    nodes = graph.get_nodes(NodeType.DECISION)
                    for node in nodes:
                        if node.properties.get("vsl_field") == field:
                            has_value = True
                            break
                except Exception:
                    pass
            if not has_value:
                gap.append(field)

        self.cognitive.observed_gap = gap
        return gap

    def evaluate(self, gap: List[str], phase: str) -> List[Dict[str, Any]]:
        """Evaluate: оценить gap и предложить действия.

        CompTheory §2.2: оценка — нужно ли спрашивать пользователя,
        применить знания, или запустить LLM.

        Returns:
            List[Dict] — список действий
        """
        actions = []
        if not gap:
            actions.append({"type": "noop", "reason": "no_gap"})
            self.cognitive.evaluated_actions = actions
            return actions

        # Если gap есть — нужно его заполнить
        if phase in ("category", "product", "reference", "constraints", "profile"):
            actions.append({"type": "ask_user", "fields": gap, "reason": f"Missing: {', '.join(gap)}"})
        elif phase in ("model_scene", "direction", "creative_strategy"):
            actions.append({"type": "ask_user_or_knowledge", "fields": gap, "reason": "Creative decision"})
        elif phase == "inference":
            actions.append({"type": "llm_reasoning", "fields": gap, "reason": "Technical inference"})
        elif phase == "control":
            actions.append({"type": "validate", "fields": gap, "reason": "Consistency check"})
        else:
            actions.append({"type": "run_transformer", "fields": gap, "reason": f"Auto-fill {phase}"})

        self.cognitive.evaluated_actions = actions
        return actions

    def decide(self, actions: List[Dict[str, Any]], phase: str) -> Dict[str, Any]:
        """Decide: выбрать действие из списка.

        CompTheory §2.3: приоритизация — если можно спросить пользователя,
        то спросить, иначе запустить LLM.

        Returns:
            Dict — выбранное действие
        """
        if not actions:
            decision = {"type": "noop", "reason": "no_actions"}
            self.cognitive.current_decision = decision
            return decision

        # Приоритет: ask_user > ask_user_or_knowledge > llm_reasoning > validate > run_transformer > noop
        priority = {"ask_user": 0, "ask_user_or_knowledge": 1, "llm_reasoning": 2,
                    "validate": 3, "run_transformer": 4, "noop": 5}
        best = min(actions, key=lambda a: priority.get(a.get("type", "noop"), 99))

        decision = {
            "phase": phase,
            "action_type": best["type"],
            "fields": best.get("fields", []),
            "reason": best.get("reason", ""),
        }
        self.cognitive.current_decision = decision
        return decision

    def record(self, graph: 'SemanticGraph', decision: Dict[str, Any],
               result: TransformResult, phase: str) -> None:
        """Record: записать результат когнитивного цикла в граф.

        CompTheory §2.4: фиксация — что было решено, какой трансформер сработал.
        """
        record = {
            "phase": phase,
            "decision": decision,
            "transform_result": {
                "graph_changed": result.graph is not graph,
                "proposals_count": len(result.proposals),
                "artifacts_count": len(result.artifacts),
                "log": result.log,
            },
        }
        self.cognitive.recorded_decisions.append(record)

    def _apply_proposal(self, proposal: dict):
        """Применить proposal к Registry (I-004: Decision-Driven State).

        Каждая proposal создаёт Decision + запись в граф.
        Единственный путь мутации графа в Orchestrator.

        Поддерживаемые типы:
          - decision: запись решения через SemanticGraphAdapter
          - create_node: создание нового узла
          - create_edge: создание ребра
          - update_node: обновление свойств узла
        """
        if not self.registry:
            return

        proposal_type = proposal.get("type", "")

        try:
            from hermes.kernel.graph_adapter import SemanticGraphAdapter
            adapter = SemanticGraphAdapter(self.registry, self.project)

            if proposal_type == "decision":
                block = proposal.get("block", "general")
                field = proposal.get("field", "")
                value = proposal.get("value", "")
                source = proposal.get("source", "system")
                confidence = proposal.get("confidence", 0.7)
                rationale = proposal.get("rationale", "")

                adapter.record_decision(block, field, value,
                                        source=source,
                                        rationale=rationale,
                                        confidence=confidence)

            elif proposal_type == "create_node":
                from hermes.kernel.core import Node
                node_data = proposal.get("node", {})
                node_type_name = node_data.get("type", "")
                try:
                    from hermes.kernel.core import NodeType
                    node_type = NodeType[node_type_name] if node_type_name else None
                except (KeyError, AttributeError):
                    node_type = node_type_name
                if node_type:
                    node = Node(
                        type=node_type,
                        properties=node_data.get("properties", {}),
                    )
                    self.registry.register_node(node)

            elif proposal_type == "create_edge":
                from hermes.kernel.core import Edge
                edge_data = proposal.get("edge", {})
                source_id = edge_data.get("source", "")
                target_id = edge_data.get("target", "")
                edge_type_str = edge_data.get("type", "")
                if source_id and target_id and edge_type_str:
                    try:
                        from hermes.kernel.core import RelationType
                        try:
                            edge_type = RelationType[edge_type_str]
                        except KeyError:
                            edge_type = edge_type_str
                    except (KeyError, AttributeError):
                        edge_type = edge_type_str
                    edge = Edge(
                        source=source_id,
                        target=target_id,
                        type=edge_type,
                        properties=edge_data.get("properties", {}),
                    )
                    self.registry.register_edge(edge)

            elif proposal_type == "update_node":
                node_id = proposal.get("node_id", "")
                updates = proposal.get("updates", {})
                node = self.registry.get_node(node_id)
                if node:
                    for key, value in updates.items():
                        if key == "properties":
                            node.properties.update(value)
                        else:
                            setattr(node, key, value)

        except ImportError:
            pass

    def start_session(self, category: Optional[str] = None) -> dict:
        """Начать новую сессию.

        Returns:
            dict с вопросом пользователю
        """
        from datetime import datetime, timezone
        session_id = f"vcos_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        self.state = OrchestratorState(
            session_id=session_id,
            started_at=datetime.now(timezone.utc).isoformat(),
            status="active",
            current_phase="interview",
        )

        # Вызвать DialogueTransformer для первого вопроса
        result = self.run_single(
            self.project, self.registry,
            phase="interview",
            config={"phase": "category"},
        )

        return result.log

    def summary(self) -> dict:
        """Сводка сессии."""
        return {
            "session_id": self.state.session_id,
            "status": self.state.status,
            "current_phase": self.state.current_phase,
            "completed_phases": self.state.completed_phases,
            "project": self.project.summary() if hasattr(self.project, "summary") else {},
        }