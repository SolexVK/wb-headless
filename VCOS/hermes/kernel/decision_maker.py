"""VCOS — DecisionMaker v2

Algorithmic Decision Layer (CA-001.4.3).

Трёхуровневое принятие решений:
  1. Accept      — LLM уверена или ответ есть в профиле
  2. ExpertMatch — LLM не уверена → ищем ответ у профилей экспертов
  3. Clarify     — никто не знает → спросить пользователя с вариантами

Правила:
  - LLM предлагает → DecisionMaker решает
  - Профили экспертов — база знаний для профессиональных вопросов
  - Пользователь — последняя инстанция
"""

from dataclasses import dataclass, field
from typing import Optional
from enum import Enum

from hermes.kernel.registry import Registry
from hermes.kernel.project_model import ProjectModel
from hermes.kernel.proposal import Proposal, ProposalSource, ProposalStatus
from hermes.kernel.validator import Validator, Violation
from hermes.kernel.decision_logger import DecisionLogger, DecisionEntry


class DecisionLevel(str, Enum):
    ACCEPT = "accept"
    EXPERT_MATCH = "expert_match"
    CLARIFY = "clarify"
    REJECT = "reject"


@dataclass
class ExpertSuggestion:
    """Подсказка от профиля эксперта."""
    value: str
    source_profile: str
    confidence: float
    rationale: str


@dataclass
class DecisionResult:
    """Результат решения по предложению."""
    level: DecisionLevel
    accepted: bool
    proposal_id: str
    rationale: str
    violations: list[Violation] = field(default_factory=list)
    decision_entry: Optional[DecisionEntry] = None
    expert_suggestions: list[ExpertSuggestion] = field(default_factory=list)


class DecisionMaker:
    """Algorithmic Decision Layer.

    Принимает Proposal → 3 уровня проверки → Accept / ExpertMatch / Clarify.

    Confidence Scale (Computational Theory §5):
      1.0      — абсолютная уверенность (Intent, Fact от пользователя)
      0.7-0.9  — высокая уверенность (подтверждённое Knowledge)
      0.4-0.6  — средняя уверенность (вывод LLM)
      0.1-0.3  — низкая уверенность (гипотеза, предположение)
      0.0      — отсутствует
    """
    CONFIDENCE_SCALE = {
        "absolute": 1.0,
        "high": (0.7, 0.9),
        "medium": (0.4, 0.6),
        "low": (0.1, 0.3),
        "none": 0.0,
    }

    # Приоритет источников (выше = важнее)
    SOURCE_PRIORITY = {
        ProposalSource.USER: 100,
        ProposalSource.TRANSFORMER: 80,
        ProposalSource.PROFILE: 70,
        ProposalSource.LLM: 60,
        ProposalSource.SYSTEM: 40,
    }

    # Пороги уверенности для Accept (Computational Theory §5)
    ACCEPT_THRESHOLDS = {
        ProposalSource.USER: 0.3,       # Данные от пользователя — принимаем с низкой уверенностью
        ProposalSource.PROFILE: 0.5,    # Профиль эксперта — нужна средняя уверенность
        ProposalSource.LLM: 0.6,        # LLM — нужна средняя уверенность
        ProposalSource.SYSTEM: 0.7,     # Система — нужна высокая уверенность
        ProposalSource.TRANSFORMER: 0.5,  # Трансформер — средняя уверенность
    }

    # Нижний порог — ниже только Clarify (Computational Theory §5)
    CLARIFY_THRESHOLD = 0.4

    # Маппинг VSL полей → поля DirectorProfile
    # (block.field) → (profile_attribute_name)
    PROFILE_FIELD_MAP = {
        ("color", "palette"): "color_signature",
        ("color", "temperature"): "color_temperature",
        ("color", "saturation"): "color_saturation",
        ("color", "harmony"): "color_harmony",
        ("color", "accent"): "accent_color_philosophy",
        ("lighting", "key"): "light_signature",
        ("lighting", "contrast"): "light_contrast",
        ("lighting", "temperature"): "light_temperature",
        ("lighting", "shadow_quality"): "shadow_quality",
        ("camera", "lens"): "lens_preference",
        ("camera", "movement"): "camera_movement",
        ("camera", "shot"): "framing_style",
        ("composition", "balance"): "symmetry_preference",
        ("composition", "depth_layers"): "depth_layers",
        ("composition", "negative_space"): "negative_space_use",
        ("composition", "rule_of_thirds"): "rule_of_thirds",
        ("composition", "composition_signature"): "composition_signature",
        ("atmosphere", "mood"): "mood_signature",
        ("atmosphere", "density"): "atmosphere_density",
        ("style", "film_stock"): "film_stock_signature",
        ("style", "rendering_style"): "scale_preference",
        ("motion", "dynamics"): "dynamics",
    }

    def __init__(self, registry: Registry, project: ProjectModel,
                 logger: DecisionLogger):
        self.registry = registry
        self.project = project
        self.logger = logger
        self.validator = Validator(registry, project)
        self._decisions: list[DecisionResult] = []

    def decide(self, proposal: Proposal) -> DecisionResult:
        """Принять решение. 3 уровня: Accept → ExpertMatch → Clarify/Reject."""

        # ─── Шаг 1: Проверить инварианты (для ВСЕХ источников,
        #     включая USER — пользовательское предложение тоже валидируется) ─
        violations = self._check_invariants(proposal)
        if violations:
            return self._reject(proposal, f"Invariant violations: {len(violations)}", violations)

        # ─── Шаг 2: User — Accept (после валидации инвариантов) ─
        if proposal.source == ProposalSource.USER:
            return self._accept(proposal, "User input — trusted")

        # ─── Шаг 3: Проверить уверенность ───────────────────
        threshold = self.ACCEPT_THRESHOLDS.get(proposal.source, 0.5)
        conf = proposal.confidence

        if conf >= threshold:
            # ✅ Уровень 1: Accept — уверены
            return self._accept(proposal, f"Confidence {conf:.2f} ≥ {threshold:.2f}")

        elif conf >= self.CLARIFY_THRESHOLD:
            # 🟡 Уровень 2: ExpertMatch — ищем в профилях
            expert_result = self._try_expert_match(proposal)
            if expert_result:
                return expert_result
            else:
                # Профили не знают → Clarify
                return self._clarify(proposal, f"Confidence {conf:.2f}, experts have no answer")

        else:
            # 🔴 Уровень 3: Reject — слишком низкая уверенность
            return self._reject(proposal, f"Confidence {conf:.2f} < clarify threshold {self.CLARIFY_THRESHOLD}")

    def _try_expert_match(self, proposal: Proposal) -> Optional[DecisionResult]:
        """Попробовать найти ответ у профилей экспертов.

        Смотрит: какие поля предлагает Proposal.
        Ищет: есть ли в профилях режиссёров/дизайнеров ответ на этот вопрос.
        """
        from hermes.design.director_profiles import ALL_PROFILES

        if not ALL_PROFILES:
            return None

        suggestions = []

        for node in proposal.nodes:
            block = node.properties.get("block", "")
            field = node.properties.get("field", "")
            key = (block, field)

            if key not in self.PROFILE_FIELD_MAP:
                continue

            profile_field = self.PROFILE_FIELD_MAP[key]

            # Ищем в профилях
            for pname, profile in ALL_PROFILES.items():
                value = getattr(profile, profile_field, "")
                if value and len(value) > 3:
                    suggestions.append(ExpertSuggestion(
                        value=value,
                        source_profile=profile.name,
                        confidence=0.7,
                        rationale=f"{profile.name}: {profile_field}",
                    ))

        if not suggestions:
            return None

        # Выбрать best match под контекст проекта
        # Пока — берём первый (можно улучшить LLM-ранжированием)
        best = suggestions[0]

        # Это Accept, но с confidence профиля (0.7).
        # Node — frozen: не мутируем properties in-place, создаём новую версию.
        node = proposal.nodes[0]
        updated_node = node.with_properties({
            **node.properties,
            "value": best.value,
            "source": "profile",
            "rationale": best.rationale,
            "confidence": best.confidence,
        })
        proposal.nodes[0] = updated_node

        # Применяем
        for n in proposal.nodes:
            self.registry.register_node(n)
        for e in proposal.edges:
            self._register_edge_checked(e)

        entry = self.logger.record(
            block="decision_maker",
            field=f"proposal_{proposal.id}",
            value="expert_match",
            source="profile",
            rationale=best.rationale,
            confidence=best.confidence,
        )

        proposal.accept()
        result = DecisionResult(
            level=DecisionLevel.EXPERT_MATCH,
            accepted=True,
            proposal_id=proposal.id,
            rationale=f"Expert match from {best.source_profile}: {best.value}",
            decision_entry=entry,
            expert_suggestions=suggestions,
        )
        self._decisions.append(result)
        return result

    def _register_edge_checked(self, edge) -> bool:
        """Зарегистрировать ребро ТОЛЬКО если source и target существуют.

        Registry.register_edge не проверяет существование узлов —
        проверяем явно (E-004: никаких висячих рёбер).
        """
        if self.registry.get_node(edge.source) is None:
            return False
        if self.registry.get_node(edge.target) is None:
            return False
        self.registry.register_edge(edge)
        return True

    def _accept(self, proposal: Proposal, rationale: str) -> DecisionResult:
        """Принять предложение — применить Nodes/Edges."""
        for node in proposal.nodes:
            self.registry.register_node(node)
        for edge in proposal.edges:
            self._register_edge_checked(edge)

        entry = self.logger.record(
            block="decision_maker",
            field=f"proposal_{proposal.id}",
            value="accepted",
            source=proposal.source.value,
            rationale=rationale,
            confidence=proposal.confidence,
        )

        proposal.accept()
        result = DecisionResult(
            level=DecisionLevel.ACCEPT,
            accepted=True,
            proposal_id=proposal.id,
            rationale=rationale,
            decision_entry=entry,
        )
        self._decisions.append(result)
        return result

    def _clarify(self, proposal: Proposal, rationale: str) -> DecisionResult:
        """Отправить на уточнение — предложение не отвергается, но и не применяется."""
        # Ищем expert suggestions для clarify-сообщения
        expert_options = self._get_expert_options(proposal)

        result = DecisionResult(
            level=DecisionLevel.CLARIFY,
            accepted=False,
            proposal_id=proposal.id,
            rationale=rationale,
            expert_suggestions=expert_options,
        )
        self._decisions.append(result)
        return result

    def _reject(self, proposal: Proposal, rationale: str,
                violations: Optional[list] = None) -> DecisionResult:
        """Отклонить предложение."""
        proposal.reject(rationale)
        result = DecisionResult(
            level=DecisionLevel.REJECT,
            accepted=False,
            proposal_id=proposal.id,
            rationale=rationale,
            violations=violations or [],
        )
        self._decisions.append(result)
        return result

    def _get_expert_options(self, proposal: Proposal) -> list[ExpertSuggestion]:
        """Собрать варианты от экспертов для clarify-сообщения."""
        from hermes.design.director_profiles import ALL_PROFILES
        suggestions = []

        for node in proposal.nodes:
            block = node.properties.get("block", "")
            field = node.properties.get("field", "")
            key = (block, field)

            if key not in self.PROFILE_FIELD_MAP:
                continue

            profile_field = self.PROFILE_FIELD_MAP[key]
            for pname, profile in ALL_PROFILES.items():
                value = getattr(profile, profile_field, "")
                if value and len(value) > 3:
                    suggestions.append(ExpertSuggestion(
                        value=value,
                        source_profile=profile.name,
                        confidence=0.7,
                        rationale=f"{profile.name}: {profile_field}",
                    ))

        return suggestions[:5]  # не больше 5 вариантов

    def _check_invariants(self, proposal: Proposal) -> list[Violation]:
        """Проверить инварианты предложения.

        Каждое ребро должно ссылаться на узел, который либо уже есть
        в Registry, либо входит в это же предложение (будет создан).
        """
        violations = []
        proposal_node_ids = {n.id for n in proposal.nodes}
        for edge in proposal.edges:
            if (edge.source not in proposal_node_ids
                    and self.registry.get_node(edge.source) is None):
                violations.append(Violation(
                    invariant="G-010",
                    message=f"Edge source {edge.source.hex[:8]} not in Registry",
                    severity="error",
                ))
            if (edge.target not in proposal_node_ids
                    and self.registry.get_node(edge.target) is None):
                violations.append(Violation(
                    invariant="G-010",
                    message=f"Edge target {edge.target.hex[:8]} not in Registry",
                    severity="error",
                ))
        return violations

    def summary(self) -> dict:
        stats = {"accept": 0, "expert_match": 0, "clarify": 0, "reject": 0}
        for r in self._decisions:
            stats[r.level.value] = stats.get(r.level.value, 0) + 1
        return {
            "total": len(self._decisions),
            "by_level": stats,
            "accept_rate": round(
                (stats["accept"] + stats["expert_match"]) / max(len(self._decisions), 1), 2
            ),
        }