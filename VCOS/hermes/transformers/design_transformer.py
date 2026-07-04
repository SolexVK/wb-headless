"""VCOS — Design Transformer v1

DesignTransformer: CP-001 §4.5 — Design phase.
Преобразует сырые интенты (Intent) в визуальные решения (Decision, Goal, Constraint).

Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph
T-003: Single Responsibility — только проектирование.
L-001: LLM Proposes, Kernel Decides (возвращает proposals, не изменяет graph).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult


class DesignTransformer(Transformer):
    """Трансформер визуального проектирования (CP-001 §4.5 Design).

    Берёт Intents из графа и генерирует:
      - Goals (цели съёмки)
      - Decisions (конкретные решения: lens, lighting, composition)
      - Constraints (ограничения: бюджет, формат, бренд)

    Использует ReasoningEngine (LLM) для креативных решений.
    """

    name = "design"
    version = "1.0.0"
    phase_type = "cognitive"

    def can_handle(self, phase: str) -> bool:
        return phase in ("design", "creative", "planning")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Спроектировать визуальное решение на основе Intents.

        Args:
            graph: SemanticGraph — граф с Intents, Facts
            context: TransformerContext — внешние ресурсы

        Returns:
            TransformResult — с proposals (Goals, Decisions, Constraints)
        """
        # Извлечь интенты из графа
        intents = self._extract_intents(graph)
        proposals = []

        # 1. Запросить знания из Knowledge Providers
        knowledge_facts = []
        if context.knowledge:
            for provider in context.knowledge:
                if hasattr(provider, "query"):
                    try:
                        result = provider.query({
                            "domain": context.config.get("domain", "general"),
                            "context": {
                                "projectType": context.config.get("project_type", ""),
                                "constraints": [],
                                "facts": [],
                                "freeText": str(intents) if intents else "",
                            },
                            "maxResults": 5,
                        })
                        if hasattr(result, "facts"):
                            knowledge_facts.extend(result.facts)
                    except Exception:
                        pass

        # 2. Если есть Reasoning — вызвать LLM для генерации решений
        if context.reasoning and hasattr(context.reasoning, "infer"):
            prompt = self._build_design_prompt(intents, knowledge_facts)
            try:
                inference = context.reasoning.infer(
                    prompt=prompt,
                    context={
                        "intents": intents,
                        "knowledge": knowledge_facts,
                        "domain": context.config.get("domain", "general"),
                    },
                    constraints=["Return structured JSON with decisions"],
                    maxTokens=600,
                    temperature=0.7,
                )
                if hasattr(inference, "proposals"):
                    for p in inference.proposals:
                        p["source"] = "design_transformer"
                        proposals.append(p)
            except Exception:
                pass

        # 3. Если нет LLM — сгенерировать базовые proposals из интентов
        if not proposals:
            for intent in intents:
                proposals.append({
                    "type": "decision",
                    "block": "composition",
                    "field": intent.get("field", "style"),
                    "value": intent.get("value", "standard"),
                    "source": "design_transformer",
                    "confidence": 0.5,
                })

        return TransformResult(
            graph=graph,  # DesignTransformer — read-only, proposals в result
            proposals=proposals,
            log={
                "phase": "design",
                "intents_found": len(intents),
                "knowledge_facts": len(knowledge_facts),
                "proposals_count": len(proposals),
            },
        )

    def _extract_intents(self, graph: 'SemanticGraph') -> List[Dict[str, Any]]:
        """Извлечь Intents из SemanticGraph."""
        intents = []
        if hasattr(graph, "get_intents"):
            try:
                intents = graph.get_intents()
            except Exception:
                pass
        elif hasattr(graph, "nodes"):
            for node in graph.nodes:
                if hasattr(node, "type") and str(node.type) == "Intent":
                    intents.append({
                        "field": getattr(node, "field", ""),
                        "value": getattr(node, "value", ""),
                        "label": getattr(node, "label", ""),
                    })
        return intents

    def _build_design_prompt(self, intents: List[Dict[str, Any]],
                             knowledge: List[Any]) -> str:
        """Построить промпт для LLM."""
        intent_lines = "\n".join(
            f"- {i.get('field', '?')}: {i.get('value', '?')} ({i.get('label', '')})"
            for i in intents
        )
        knowledge_lines = "\n".join(
            f"- {str(f)}" for f in knowledge[:5]
        )
        return (
            f"Design a visual solution based on these intents:\n\n"
            f"Intents:\n{intent_lines}\n\n"
            f"Knowledge:\n{knowledge_lines}\n\n"
            f"Return structured JSON decisions for: lens, lighting, composition, color_palette."
        )