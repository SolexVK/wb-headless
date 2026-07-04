"""VCOS — Pipeline Transformer v2

Оркестратор цепочки трансформеров (PM → PM).

CP-001 §4.5:
  ProjectModel → Transformer → ProjectModel → Transformer → ...

Использование:
    pipe = PipelineTransformer()
    pipe.register(DialogueTransformer())
    pipe.register(LLMTransformer())
    pipe.register(KnowledgeTransformer())

    result = pipe.transform(model, context)
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult


class PipelineTransformer(Transformer):
    """Трансформер-оркестратор: цепочка PM → PM (CP-001 §4.5).

    Каждый шаг — (phase_name, config).
    Трансформер выбирается по can_handle(phase).
    """

    name = "pipeline"
    version = "1.0.0"
    phase_type = "cognitive"

    def __init__(self):
        self._registry: Dict[str, Transformer] = {}
        self._phases: List[Dict[str, Any]] = []  # [{name, config}, ...]
        self._routes: Dict[str, str] = {}  # phase_name → transformer.name

    def register(self, transformer: Transformer):
        """Зарегистрировать трансформер по имени."""
        self._registry[transformer.name] = transformer

    def set_route(self, phase_name: str, transformer_name: str):
        """Явно назначить трансформер для фазы.

        Маршрут имеет приоритет над can_handle-сканированием:
        несколько трансформеров могут заявлять одну фазу, и порядок
        регистрации не должен решать, кто получит работу.
        """
        self._routes[phase_name] = transformer_name

    def set_routes(self, routes: Dict[str, str]):
        """Назначить несколько маршрутов сразу."""
        self._routes.update(routes)

    def add_step(self, phase_name: str, config: Dict[str, Any] = None):
        """Добавить шаг в конвейер.

        Args:
            phase_name: имя фазы (interview, design, compile, ...)
            config: параметры шага
        """
        self._phases.append({"name": phase_name, "config": config or {}})

    def can_handle(self, phase: str) -> bool:
        return phase in ("pipeline", "chain", "sequence")

    def get_phases(self) -> List[Dict[str, Any]]:
        """Вернуть список всех фаз."""
        return list(self._phases)

    def clear_phases(self):
        """Очистить конвейер."""
        self._phases = []

    def run_chain(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Применить все шаги конвейера.

        Encyclopedia: Transformer(SemanticGraph) → SemanticGraph

        Args:
            graph: SemanticGraph — начальное состояние графа
            context: TransformerContext — внешние ресурсы

        Returns:
            TransformResult — финальный SemanticGraph после всех шагов
        """
        current_graph = graph
        all_proposals = []
        all_decisions = []
        all_artifacts = []
        logs = []

        for step in self._phases:
            phase_name = step["name"]
            step_config = step.get("config", {})

            # Найти подходящий трансформер
            transformer = self._find_transformer(phase_name)
            if not transformer:
                logs.append({"phase": phase_name, "error": f"No transformer for phase '{phase_name}'"})
                continue

            # Построить контекст для шага
            step_context = TransformerContext(
                registry=context.registry,
                knowledge=context.knowledge,
                memory=context.memory,
                interview=context.interview,
                reasoning=context.reasoning,
                config={**context.config, **step_config, "phase": phase_name},
                metadata=context.metadata,
            )

            # Запустить трансформер
            result = transformer.transform(current_graph, step_context)

            # P-007: Defend Against LLM Instability — валидация после каждой фазы
            if context.registry:
                from hermes.kernel.validator import Validator
                pm = result.graph if hasattr(result, 'graph') and result.graph else current_graph
                if hasattr(pm, '_registry') or hasattr(pm, 'get_intents'):
                    val = Validator(context.registry, pm)
                    violations = val.validate()
                    if violations:
                        errors = [v for v in violations if v.severity == "error"]
                        if errors:
                            logs.append({
                                "phase": phase_name,
                                "validation_errors": [f"{v.invariant}: {v.message}" for v in errors],
                            })
                        warnings = [v for v in violations if v.severity == "warning"]
                        if warnings:
                            logs.append({
                                "phase": phase_name,
                                "validation_warnings": [f"{v.invariant}: {v.message}" for v in warnings],
                            })

            # Накопить результаты
            if result.graph is not current_graph:  # graph изменился
                current_graph = result.graph
            all_proposals.extend(result.proposals)
            all_decisions.extend(result.decisions)
            all_artifacts.extend(result.artifacts)
            logs.append(result.log)

            # Обновить metadata для следующего шага
            step_context.metadata["parent_transformer"] = transformer.name

        # Контракт log: ключи последнего шага доступны на верхнем уровне
        # (category, error, question, next_phase, ...), полная история — в "chain".
        merged_log: Dict[str, Any] = {}
        for entry in logs:
            if isinstance(entry, dict):
                merged_log.update(entry)
        merged_log["chain"] = logs

        return TransformResult(
            graph=current_graph,
            proposals=all_proposals,
            decisions=all_decisions,
            artifacts=all_artifacts,
            log=merged_log,
        )

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """API совместимости — делегирует run_chain."""
        return self.run_chain(graph, context)

    def _find_transformer(self, phase_name: str) -> Transformer | None:
        """Найти трансформер для фазы: сначала явный маршрут, потом can_handle."""
        routed = self._routes.get(phase_name)
        if routed and routed in self._registry:
            return self._registry[routed]
        for tf in self._registry.values():
            if tf.can_handle(phase_name):
                return tf
        return None