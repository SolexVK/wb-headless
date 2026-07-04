"""VCOS — Export Transformer v1

ExportTransformer: экспорт промпта (бывшая фаза 6).
Компилирует Semantic Graph в финальный промпт через PromptExporter.

Encyclopedia §7.3: User Input → Source → Intent → Goals → Decisions → Blueprint → Renderer → Artifact → Generator
R-001: Blueprint In, Artifact Out.
T-003: Single Responsibility — только экспорт.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult

MODEL_MAP = {
    "chatgpt": "chatgpt", "gpt": "chatgpt", "dalle": "chatgpt",
    "midjourney": "midjourney", "mj": "midjourney",
    "nanobanana": "nanobanana", "nano": "nanobanana",
    "flux": "flux", "sdxl": "sdxl",
}


class ExportTransformer(Transformer):
    """Трансформер финального экспорта промпта.

    Берёт данные из Semantic Graph, компилирует через PromptExporter,
    записывает Blueprint + Artifact в граф, возвращает готовый промпт.
    """

    name = "export"
    version = "1.0.0"
    phase_type = "compilation"

    def can_handle(self, phase: str) -> bool:
        return phase in ("export", "compile", "generate", "done")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Экспортировать промпт.

        Args:
            graph: SemanticGraph
            context: TransformerContext с config

        Returns:
            TransformResult с artifacts (промпт)
        """
        target = context.config.get("model", "chatgpt")
        proposals = []
        artifacts = []

        # Получить данные проекта
        project_data = self._extract_project_data(graph)
        if not project_data:
            return TransformResult(
                graph=graph,
                log={"phase": "export", "error": "no_project_data"},
            )

        # Экспортировать промпт
        try:
            from hermes.renderers.prompt_exporter import (
                PromptExporter, extract_prompt_data, SUPPORTED_MODELS,
            )
            from hermes.renderers.prompt_exporter import ReferenceSlot

            exporter = PromptExporter()

            # Reference
            ref = None
            if hasattr(context, "registry") and context.registry:
                try:
                    from hermes.kernel.core import NodeType
                    decisions = context.registry.get_nodes(NodeType.DECISION)
                    for d in decisions:
                        if d.properties.get("vsl_field") == "reference":
                            ref = ReferenceSlot(
                                enabled=True,
                                description=d.properties.get("value", ""),
                            )
                            break
                except Exception:
                    pass

            prompt = exporter.export(project_data, target, ref)
            model_display = SUPPORTED_MODELS.get(target, target.title())

            # Записать Blueprint + Artifact
            proposals.append({
                "type": "decision",
                "block": "blueprint",
                "field": "description",
                "value": f"Prompt for {model_display}",
                "source": "system",
                "confidence": 1.0,
            })
            proposals.append({
                "type": "decision",
                "block": "artifact",
                "field": "prompt",
                "value": prompt,
                "source": "system",
                "confidence": 1.0,
            })

            artifacts.append({
                "content": prompt,
                "format": target,
                "generator": f"export-transformer-v1",
                "params": {
                    "model": model_display,
                    "has_reference": ref is not None,
                },
            })

            return TransformResult(
                graph=graph,
                proposals=proposals,
                artifacts=artifacts,
                log={
                    "phase": "export",
                    "model": model_display,
                    "prompt_length": len(prompt),
                    "status": "done",
                },
            )

        except ImportError as e:
            return TransformResult(
                graph=graph,
                log={"phase": "export", "error": f"PromptExporter import failed: {e}"},
            )

    def _extract_project_data(self, graph: 'SemanticGraph') -> Optional[dict]:
        """Извлечь данные проекта из Semantic Graph."""
        # Попробовать через project_data() если это SemanticGraphAdapter
        if hasattr(graph, "project_data"):
            try:
                return graph.project_data()
            except Exception:
                pass

        # Попробовать через graph_adapter если registry доступен
        if hasattr(graph, "registry") or hasattr(graph, "_registry"):
            try:
                reg = getattr(graph, "registry", None) or getattr(graph, "_registry", None)
                pm = getattr(graph, "project", None) or graph
                from hermes.kernel.graph_adapter import SemanticGraphAdapter
                adapter = SemanticGraphAdapter(reg, pm)
                return adapter.project_data()
            except Exception:
                pass

        # Попробовать через extract_prompt_data
        try:
            from hermes.renderers.prompt_exporter import extract_prompt_data
            return extract_prompt_data(graph)
        except Exception:
            pass

        return None