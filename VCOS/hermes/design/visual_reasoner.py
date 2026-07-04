"""VCOS — Visual Reasoner v2

Агент визуального проектирования.
Возвращает Proposals (не записывает напрямую).

Решение принимает DecisionMaker (Kernel).
Работает через Registry, не использует VisualProject.
"""

from typing import Optional
from dataclasses import dataclass, field

from hermes.kernel.graph_adapter import SemanticGraphAdapter
from hermes.kernel.core import Node, Edge, NodeType, LifecycleState, RelationType
from hermes.kernel.proposal import Proposal, ProposalSource
from hermes.design.inference_engine import InferenceEngine
from hermes.design.director_profiles import get_profile, ALL_PROFILES


@dataclass
class VisualSuggestion:
    """Одно предложение от Visual Reasoner (внутренний формат)."""
    block: str
    field: str
    value: str
    source: str
    rationale: str
    confidence: float = 0.5


class VisualReasoner:
    """Агент визуального проектирования.

    Возвращает Proposals. Не пишет в граф.
    """

    def __init__(self, registry: Optional['Registry'] = None,
                 project: Optional['ProjectModel'] = None,
                 adapter: Optional[SemanticGraphAdapter] = None):
        if adapter:
            self._adapter = adapter
        elif registry and project:
            self._adapter = SemanticGraphAdapter(registry, project)
        else:
            # Fallback: создаём временные (только для изолированного use)
            from hermes.kernel.registry import Registry
            from hermes.kernel.project_model import ProjectModel, ProjectIdentity
            from datetime import datetime
            _reg = Registry()
            _proj = ProjectModel(
                identity=ProjectIdentity(
                    id=f"vcos_vr_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                    version=1,
                )
            )
            self._adapter = SemanticGraphAdapter(_reg, _proj)
        self.inference = InferenceEngine()

    def propose_profile(self, profile_name: str) -> Optional[Proposal]:
        """Создать Proposal на основе профиля.

        Возвращает Proposal (не записывает в граф).
        Решение принимает DecisionMaker.
        """
        profile = get_profile(profile_name.lower().strip())
        if not profile:
            return None

        suggestions = []
        suggestions.append(VisualSuggestion(
            block="composition", field="composition_signature",
            value=profile.composition_signature,
            source="profile", rationale=f"{profile.name}: signature",
            confidence=0.7,
        ))
        suggestions.append(VisualSuggestion(
            block="color", field="palette",
            value=profile.color_signature,
            source="profile", rationale=f"{profile.name}: colour",
            confidence=0.7,
        ))
        suggestions.append(VisualSuggestion(
            block="lighting", field="key",
            value=profile.light_signature,
            source="profile", rationale=f"{profile.name}: lighting",
            confidence=0.7,
        ))
        if profile.lens_preference:
            suggestions.append(VisualSuggestion(
                block="camera", field="lens",
                value=profile.lens_preference,
                source="profile", rationale=f"{profile.name}: lens",
                confidence=0.7,
            ))
        if profile.signature_element:
            suggestions.append(VisualSuggestion(
                block="style", field="signature_element",
                value=profile.signature_element,
                source="profile", rationale=f"{profile.name}: signature move",
                confidence=0.6,
            ))

        # Преобразовать в Proposal
        return self._suggestions_to_proposal(suggestions, ProposalSource.PROFILE, profile.name)

    def apply_profile(self, profile_name: str) -> list[VisualSuggestion]:
        """Применить профиль и вернуть список рекомендаций (алиас для тестов)."""
        profile = get_profile(profile_name.lower().strip())
        if not profile:
            return []
        suggestions = [
            VisualSuggestion(
                block="composition", field="composition_signature",
                value=profile.composition_signature,
                source="profile", rationale=f"{profile.name}: signature",
            ),
            VisualSuggestion(
                block="color", field="palette",
                value=profile.color_signature,
                source="profile", rationale=f"{profile.name}: colour",
            ),
            VisualSuggestion(
                block="lighting", field="key",
                value=profile.light_signature,
                source="profile", rationale=f"{profile.name}: lighting",
            ),
        ]
        if profile.lens_preference:
            suggestions.append(VisualSuggestion(
                block="camera", field="lens",
                value=profile.lens_preference,
                source="profile", rationale=f"{profile.name}: lens",
            ))
        return suggestions

    def propose_combined(self, names: list[str]) -> Optional[Proposal]:
        """Создать Proposal из комбинации профилей."""
        all_suggestions = []
        for name in names:
            profile = get_profile(name.lower().strip())
            if not profile:
                continue
            all_suggestions.extend([
                VisualSuggestion(
                    block="composition", field="composition_signature",
                    value=profile.composition_signature,
                    source="profile", rationale=f"{profile.name}: signature",
                    confidence=0.7,
                ),
                VisualSuggestion(
                    block="color", field="palette",
                    value=profile.color_signature,
                    source="profile", rationale=f"{profile.name}: colour",
                    confidence=0.7,
                ),
            ])

        if not all_suggestions:
            return None

        # Агрегировать
        merged = {}
        for s in reversed(all_suggestions):
            key = f"{s.block}.{s.field}"
            if key not in merged:
                merged[key] = s
        suggestions = list(merged.values())
        suggestions.reverse()

        return self._suggestions_to_proposal(suggestions, ProposalSource.PROFILE, "+".join(names))

    def propose_inference(self) -> Optional[Proposal]:
        """Создать Proposal от Inference Engine (LLM достройка пропусков).

        Читает текущие решения из лога, выявляет пустые блоки,
        вызывает LLM для заполнения.
        """
        self.inference.set_logger(self.adapter.logger)
        results = self.inference.infer()
        if not results:
            return None

        suggestions = [
            VisualSuggestion(
                block=r.block, field=r.field, value=r.value,
                source="inference", rationale=f"LLM: {r.reasoning[:80]}",
                confidence=r.confidence,
            )
            for r in results
        ]

        return self._suggestions_to_proposal(suggestions, ProposalSource.LLM, "inference-engine")

    def _suggestions_to_proposal(self, suggestions: list[VisualSuggestion],
                                  source: ProposalSource, author: str) -> Proposal:
        """Преобразовать список VisualSuggestion в Proposal с Node/Edge."""
        nodes = []
        justifications = []

        for s in suggestions:
            node = Node(
                type=NodeType.DECISION,  # предложение = проектное решение
                state=LifecycleState.DRAFT,
                properties={
                    "block": s.block,
                    "field": s.field,
                    "value": s.value,
                    "source": s.source,
                    "rationale": s.rationale,
                    "confidence": s.confidence,
                },
            )
            nodes.append(node)
            justifications.append(f"{s.block}.{s.field}={s.value}")

        return Proposal(
            nodes=nodes,
            source=source,
            author=author,
            justification="; ".join(justifications),
            confidence=sum(s.confidence for s in suggestions) / max(len(suggestions), 1),
        )

    def summarize(self) -> dict:
        return {
            "registry": self.adapter.registry.summary(),
            "project": self.adapter.project.summary(),
            "decisions": len(self.adapter.logger),
        }

    @property
    def adapter(self):
        return self._adapter

    @adapter.setter
    def adapter(self, value):
        self._adapter = value