"""VCOS — Clarify Transformer v1

ClarifyTransformer: уточнение и выбор модели (бывшая фаза 5).
Обрабатывает уточняющие вопросы пользователя и выбор модели для экспорта.

Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph
T-003: Single Responsibility — только уточнение и выбор модели.
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


class ClarifyTransformer(Transformer):
    """Трансформер уточнения данных и вывода.

    Фаза 5: если пользователь вводит имя модели — перейти к экспорту.
    Если вводит уточнение — записать в граф.
    """

    name = "clarify"
    version = "1.0.0"
    phase_type = "cognitive"

    def can_handle(self, phase: str) -> bool:
        return phase in ("clarify", "clarification", "model_select")

    def is_model_name(self, text: str) -> Optional[str]:
        """Проверить, является ли текст именем модели."""
        text_lower = text.lower().strip()
        for alias, canonical in MODEL_MAP.items():
            if alias in text_lower:
                return canonical
        return None

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Обработать уточнение или выбор модели.

        Args:
            graph: SemanticGraph
            context: TransformerContext с config.user_input

        Returns:
            TransformResult — если модель выбрана, next_phase=export
        """
        user_input = context.config.get("user_input", "")
        proposals = []

        if not user_input:
            return TransformResult(
                graph=graph,
                log={"phase": "clarify", "error": "no_input"},
            )

        # Проверить, не имя ли модели
        model = self.is_model_name(user_input)
        if model:
            proposals.append({
                "type": "decision",
                "block": "artifact",
                "field": "model_target",
                "value": model,
                "source": "user",
                "confidence": 1.0,
            })
            return TransformResult(
                graph=graph,
                proposals=proposals,
                log={
                    "phase": "clarify",
                    "model_selected": model,
                    "next_phase": "export",
                },
            )

        # Не модель — записать как уточнение
        proposals.append({
            "type": "decision",
            "block": "intent",
            "field": "clarification",
            "value": user_input,
            "source": "user",
            "confidence": 0.8,
        })

        return TransformResult(
            graph=graph,
            proposals=proposals,
            log={
                "phase": "clarify",
                "clarification": user_input[:50],
            },
        )