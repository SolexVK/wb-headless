"""VCOS — Profile Transformer v1

ProfileTransformer: выбор профиля режиссёра (бывшая фаза -1).
Применяет решения профиля к Semantic Graph через Proposal-Decide.

Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph
T-003: Single Responsibility — только выбор профиля.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult


class ProfileTransformer(Transformer):
    """Трансформер выбора профиля режиссёра.

    Фаза -1: поиск профиля по имени → применение решений профиля к графу.
    """

    name = "profile"
    version = "1.0.0"
    phase_type = "cognitive"

    def can_handle(self, phase: str) -> bool:
        return phase in ("profile", "director", "select_profile")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Выбрать профиль и применить его решения.

        Args:
            graph: SemanticGraph
            context: TransformerContext с config.user_input (имя профиля)

        Returns:
            TransformResult с обновлённым graph и решениями профиля
        """
        user_input = context.config.get("user_input", "").lower().strip()
        proposals = []

        if not user_input:
            return TransformResult(
                graph=graph,
                log={
                    "phase": "profile",
                    "error": "no_input",
                    "question": "Выбери профиль режиссёра (или напиши имя):",
                },
            )

        # Поиск профиля
        profile = None
        try:
            from hermes.design.director_profiles import get_profile, ALL_PROFILES
            profile = get_profile(user_input)
            if not profile:
                for key, p in ALL_PROFILES.items():
                    if user_input in p.name.lower():
                        profile = p
                        break
        except Exception:
            pass

        if not profile:
            return TransformResult(
                graph=graph,
                log={
                    "phase": "profile",
                    "error": f"not_found: {user_input}",
                    "question": f"❌ Не нашёл «{user_input}». Попробуй другое имя или «Авто».",
                },
            )

        # Профиль найден — применить его решения
        proposals.append({
            "type": "decision",
            "block": "profile",
            "field": "name",
            "value": profile.name,
            "source": "user",
            "confidence": 1.0,
        })

        # Применить решения профиля через VisualReasoner
        try:
            from hermes.design.visual_reasoner import VisualReasoner
            from hermes.kernel.registry import Registry
            reg = context.registry if hasattr(context, "registry") else None
            if reg:
                reasoner = VisualReasoner(reg, graph)
                profile_proposal = reasoner.propose_profile(profile.name)
                if profile_proposal:
                    for node in profile_proposal.nodes:
                        block = node.properties.get("block", "")
                        field = node.properties.get("field", "")
                        value = node.properties.get("value", "")
                        if block and field:
                            proposals.append({
                                "type": "decision",
                                "block": block,
                                "field": field,
                                "value": value,
                                "source": "profile",
                                "rationale": node.properties.get("rationale", ""),
                                "confidence": node.properties.get("confidence", 0.7),
                            })
        except Exception:
            pass

        # Обновить profile в graph
        new_graph = graph
        if hasattr(graph, "with_profile"):
            try:
                new_graph = graph.with_profile(profile.name)
            except Exception:
                pass

        return TransformResult(
            graph=new_graph,
            proposals=proposals,
            log={
                "phase": "profile",
                "profile_name": profile.name,
                "profile_role": getattr(profile, "role", ""),
                "proposals_count": len(proposals),
            },
        )