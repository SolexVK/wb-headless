"""VCOS — Compile Transformer v1

CompileTransformer: CP-001 §6 — Renderer Protocol.
Компилирует Blueprint из SemanticGraph в Artifact (промпт, workflow, JSON).

Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph
R-001: Blueprint In, Artifact Out.
R-002: No Side Effects on Model.
T-003: Single Responsibility — только компиляция.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult
from hermes.transformers.renderer_protocol import RenderContext, RenderResult


class CompileTransformer(Transformer):
    """Трансформер компиляции Blueprint → Artifact (CP-001 §6 Renderer).

    Renderer Protocol:
      render(blueprint, context) → RenderResult

    Поддерживаемые форматы:
      - sdxl-prompt
      - midjourney-prompt
      - comfyui-workflow
      - structured-json
    """

    name = "compile"
    version = "1.0.0"
    phase_type = "compilation"

    SUPPORTED_FORMATS = ["sdxl-prompt", "midjourney-prompt",
                         "comfyui-workflow", "structured-json"]

    def can_handle(self, phase: str) -> bool:
        return phase in ("compile", "export", "render", "generate")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Скомпилировать Blueprint в Artifact.

        Args:
            graph: SemanticGraph — граф с Blueprint, Decisions, Specifications
            context: TransformerContext — config с targetFormat, targetModel

        Returns:
            TransformResult — с artifacts в result
        """
        target_format = context.config.get("target_format", "sdxl-prompt")
        target_model = context.config.get("target_model", "sdxl")

        # Извлечь спецификации из графа
        specs = self._extract_specifications(graph)
        constraints = self._extract_constraints(graph)

        # Собрать RenderContext
        render_context = {
            "targetFormat": target_format,
            "targetModel": target_model,
            "specifications": specs,
            "constraints": constraints,
            "options": context.config.get("options", {}),
        }

        # Скомпилировать
        artifact = self._compile(target_format, target_model, specs, constraints)

        return TransformResult(
            graph=graph,  # CompileTransformer — read-only для графа
            artifacts=[artifact],
            log={
                "phase": "compile",
                "target_format": target_format,
                "target_model": target_model,
                "specifications_count": len(specs),
                "artifact_format": artifact.get("format", ""),
            },
        )

    def render(self, specs: List[str], context: RenderContext) -> RenderResult:
        """CP-001 §6.1: render(blueprint, context) → RenderResult.

        Args:
            specs: спецификации из Blueprint
            context: RenderContext — формат, модель, опции

        Returns:
            RenderResult — артефакт + метаданные
        """
        from time import time
        start = time()

        artifact = self._compile(
            target_format=context.target_format,
            target_model=context.target_model,
            specs=specs,
            constraints=context.constraints,
        )

        duration_ms = int((time() - start) * 1000)

        return RenderResult(
            artifact=artifact,
            format=artifact.get("format", context.target_format),
            duration=duration_ms,
            log={
                "specs_used": len(specs),
                "constraints_used": len(context.constraints),
                "options_used": list(context.options.keys()),
            },
        )

    def _extract_specifications(self, graph: 'SemanticGraph') -> List[str]:
        """Извлечь спецификации из SemanticGraph."""
        specs = []

        # Из Decisions
        if hasattr(graph, "get_decisions"):
            try:
                for d in graph.get_decisions():
                    if hasattr(d, "field") and hasattr(d, "value"):
                        specs.append(f"{d.field}: {d.value}")
            except Exception:
                pass

        # Из Goals
        if hasattr(graph, "get_goals"):
            try:
                for g in graph.get_goals():
                    if hasattr(g, "description"):
                        specs.append(g.description)
            except Exception:
                pass

        # Из узлов графа напрямую
        if hasattr(graph, "nodes"):
            for node in graph.nodes:
                node_type = str(getattr(node, "type", ""))
                if "Decision" in node_type or "Spec" in node_type:
                    label = getattr(node, "label", "")
                    value = getattr(node, "value", "")
                    if label and value:
                        specs.append(f"{label}: {value}")
                    elif label:
                        specs.append(label)

        return specs

    def _extract_constraints(self, graph: 'SemanticGraph') -> List[str]:
        """Извлечь ограничения из SemanticGraph."""
        constraints = []
        if hasattr(graph, "get_constraints"):
            try:
                for c in graph.get_constraints():
                    text = getattr(c, "description", str(c))
                    constraints.append(text)
            except Exception:
                pass
        return constraints

    def _compile(self, target_format: str, target_model: str,
                 specs: List[str], constraints: List[str]) -> Dict[str, Any]:
        """Скомпилировать спецификации в артефакт требуемого формата.

        Returns:
            dict с ключами: content, format, generator, params
        """
        if target_format == "midjourney-prompt":
            return self._compile_midjourney(specs)
        elif target_format == "comfyui-workflow":
            return self._compile_comfyui(specs)
        elif target_format == "structured-json":
            return self._compile_json(specs, constraints)
        else:
            # SDXL-prompt — по умолчанию
            return self._compile_sdxl(specs, constraints)

    def _compile_sdxl(self, specs: List[str],
                      constraints: List[str]) -> Dict[str, Any]:
        """Скомпилировать SDXL-промпт."""
        prompt_parts = specs[:10]
        if constraints:
            prompt_parts.append("---")
            prompt_parts.extend(constraints[:5])

        return {
            "content": ", ".join(prompt_parts),
            "format": "sdxl-prompt",
            "generator": f"compile-transformer-v1",
            "params": {
                "target_model": "sdxl",
                "style": "natural",
                "weighting": True,
            },
        }

    def _compile_midjourney(self, specs: List[str]) -> Dict[str, Any]:
        """Скомпилировать Midjourney-промпт."""
        prompt_parts = specs[:8]
        return {
            "content": " -- ".join(prompt_parts) if prompt_parts else "",
            "format": "midjourney-prompt",
            "generator": "compile-transformer-v1",
            "params": {
                "target_model": "midjourney-v6",
                "stylize": 250,
                "chaos": 0,
            },
        }

    def _compile_comfyui(self, specs: List[str]) -> Dict[str, Any]:
        """Скомпилировать ComfyUI workflow."""
        workflow = {
            "3": {"class_type": "KSampler", "inputs": {"seed": 42}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": ", ".join(specs[:5])}},
        }
        return {
            "content": json.dumps(workflow, indent=2),
            "format": "comfyui-workflow",
            "generator": "compile-transformer-v1",
            "params": {"target_model": "sdxl"},
        }

    def _compile_json(self, specs: List[str],
                      constraints: List[str]) -> Dict[str, Any]:
        """Скомпилировать структурированный JSON."""
        return {
            "content": json.dumps({
                "specifications": specs,
                "constraints": constraints,
                "generated_at": "compile-time",
            }, indent=2, ensure_ascii=False),
            "format": "structured-json",
            "generator": "compile-transformer-v1",
            "params": {},
        }