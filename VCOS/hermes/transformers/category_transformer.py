"""VCOS — Category Transformer v1

CategoryTransformer: определяет категорию товара (бывшая фаза 0).
CP-001 §8 — часть Interview Protocol: сбор первичных данных.

Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph
T-003: Single Responsibility — только определение категории.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from hermes.kernel.semantic_graph import SemanticGraph

from hermes.transformers.base import Transformer, TransformerContext, TransformResult

VALID_CATEGORIES = [
    "одежда", "обувь", "косметика", "еда",
    "декор", "электроника", "уход", "детское", "другое",
]


class CategoryTransformer(Transformer):
    """Трансформер определения категории товара.

    Фаза 0: валидация категории → установка domain → подбор Domain Pack.
    """

    name = "category"
    version = "1.0.0"
    phase_type = "cognitive"

    def can_handle(self, phase: str) -> bool:
        return phase in ("category", "categorize")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Определить категорию товара.

        Args:
            graph: SemanticGraph
            context: TransformerContext с config.phase и config.user_input

        Returns:
            TransformResult с обновлённым graph и категорией в log
        """
        user_input = context.config.get("user_input", "").lower().strip()
        proposals = []

        if not user_input:
            return TransformResult(
                graph=graph,
                log={
                    "phase": "category",
                    "error": "no_input",
                    "question": "Выбери категорию: одежда, обувь, косметика, еда, декор, электроника, уход, детское, другое",
                },
            )

        if user_input not in VALID_CATEGORIES:
            return TransformResult(
                graph=graph,
                log={
                    "phase": "category",
                    "error": f"Invalid category: {user_input}",
                    "question": f"❌ Выбери из списка: {', '.join(VALID_CATEGORIES[:5])}...",
                },
            )

        # Категория валидна — записать в граф
        proposals.append({
            "type": "decision",
            "block": "source",
            "field": "category",
            "value": user_input,
            "source": "user",
            "confidence": 1.0,
        })
        proposals.append({
            "type": "decision",
            "block": "goal",
            "field": "description",
            "value": f"Промпт для {user_input}",
            "source": "system",
            "confidence": 1.0,
        })

        # Обновить graph с категорией
        new_graph = graph
        if hasattr(graph, "with_domain"):
            try:
                new_graph = graph.with_domain([user_input])
            except Exception:
                pass

        # Подобрать Domain Pack
        domain_pack_name = ""
        try:
            from hermes.domain_packs import DomainPackRegistry
            dpr = DomainPackRegistry()
            pack = dpr.get_for_domain(user_input)
            if pack:
                domain_pack_name = pack.name
                proposals.append({
                    "type": "decision",
                    "block": "intent",
                    "field": "domain_pack",
                    "value": pack.name,
                    "source": "system",
                    "confidence": 1.0,
                    "rationale": f"Автоподбор Domain Pack: {user_input}",
                })
        except Exception:
            pass

        return TransformResult(
            graph=new_graph,
            proposals=proposals,
            log={
                "phase": "category",
                "category": user_input,
                "domain_pack": domain_pack_name,
            },
        )