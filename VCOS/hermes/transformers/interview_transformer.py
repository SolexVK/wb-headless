"""VCOS — Interview Transformer v1

InterviewTransformer: CP-001 §8 — Interview Protocol.
Собирает информацию от пользователя через структурированные вопросы.

Encyclopedia §6.2: Transformer(SemanticGraph) → SemanticGraph
T-003: Single Responsibility — только сбор требований.
I-001: User-Friendly — вопросы на человеческом языке.
I-002: Progressive — фазы 1→2→3→4.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult
from hermes.transformers.dialogue_transformer import DialogueTransformer


class InterviewTransformer(Transformer):
    """Трансформер сбора данных от пользователя (CP-001 §8).

    Interview Protocol:
      - start(ctx) → InterviewState
      - ask(state) → Question[]
      - collect(state, answers) → InterviewResult
      - clarify(state, ambiguities) → Question[]
      - abort(session) → void

    Фазы:
      1 — Product/Category
      2 — Style & Mood
      3 — Technical
      4 — Brand
    """

    name = "interview"
    version = "1.0.0"
    phase_type = "cognitive"

    PHASES = {
        "category": {"phase": 1, "focus": "Категория продукта"},
        "product": {"phase": 1, "focus": "Описание продукта"},
        "model_scene": {"phase": 2, "focus": "Модель и сцена"},
        "reference": {"phase": 2, "focus": "Референсы"},
        "constraints": {"phase": 3, "focus": "Технические ограничения"},
        "direction": {"phase": 4, "focus": "Творческое направление"},
        "profile": {"phase": 4, "focus": "Профиль директора"},
    }

    def __init__(self):
        self._dialogue = DialogueTransformer()
        self._session_active = False
        self._current_phase = 0

    def can_handle(self, phase: str) -> bool:
        return phase in tuple(self.PHASES.keys()) + ("interview", "dialogue")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Провести интервью-фазу: задать вопрос или обработать ответ.

        Args:
            graph: SemanticGraph — текущее состояние графа
            context: TransformerContext — внешние ресурсы

        Returns:
            TransformResult с обновлённым graph и вопросами в log
        """
        phase = context.config.get("phase", "category")
        user_input = context.config.get("user_input", "")

        # Начать сессию, если не активна
        if not self._session_active:
            self._session_active = True
            self._current_phase = 1

        # Если есть ответ — обработать через DialogueTransformer
        if user_input:
            dialogue_config = {
                **context.config,
                "phase": phase,
                "user_input": user_input,
            }
            dialogue_context = TransformerContext(
                registry=context.registry,
                knowledge=context.knowledge,
                memory=context.memory,
                interview=context.interview,
                reasoning=context.reasoning,
                config=dialogue_config,
                metadata=context.metadata,
            )
            result = self._dialogue.transform(graph, dialogue_context)

            # Продвинуть фазу, если ответ успешен
            if "error" not in result.log:
                self._current_phase = min(self._current_phase + 1, 4)

            return result

        # Нет ответа — задать вопрос через DialogueTransformer
        dialogue_config = {**context.config, "phase": phase}
        dialogue_context = TransformerContext(
            registry=context.registry,
            knowledge=context.knowledge,
            memory=context.memory,
            interview=context.interview,
            reasoning=context.reasoning,
            config=dialogue_config,
            metadata=context.metadata,
        )
        result = self._dialogue.transform(graph, dialogue_context)

        # Обогатить log информацией о фазе интервью
        phase_info = self.PHASES.get(phase, {})
        result.log["interview_phase"] = phase_info.get("phase", self._current_phase)
        result.log["interview_focus"] = phase_info.get("focus", "")
        result.log["session_active"] = self._session_active

        return result

    def abort(self):
        """Прервать сессию интервью (I-003: Abortable)."""
        self._session_active = False
        self._current_phase = 0

    def is_active(self) -> bool:
        """Активна ли сессия."""
        return self._session_active

    def ask(self, phase: str = "") -> str:
        """CP-001 §8.1: ask(state) → Question[].

        Возвращает вопрос для пользователя по указанной фазе.

        Args:
            phase: имя фазы (category, product, direction...)

        Returns:
            str — человекочитаемый вопрос
        """
        topic = phase or list(self.PHASES.keys())[self._current_phase - 1]
        if topic not in self.PHASES:
            topic = "category"
        return self._dialogue._build_question(topic)

    def collect(self, user_input: str, phase: str,
                graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """CP-001 §8.1: collect(state, answers) → InterviewResult.

        Обрабатывает ответ пользователя и возвращает TransformResult.

        Args:
            user_input: ответ пользователя
            phase: текущая фаза
            graph: SemanticGraph
            context: TransformerContext

        Returns:
            TransformResult с распарсенными интентами
        """
        return self.transform(graph, TransformerContext(
            registry=context.registry,
            knowledge=context.knowledge,
            memory=context.memory,
            interview=context.interview,
            reasoning=context.reasoning,
            config={**context.config, "phase": phase, "user_input": user_input},
            metadata=context.metadata,
        ))

    def clarify(self, unclear_fields: list) -> str:
        """CP-001 §8.1: clarify(state, ambiguities) → Question[].

        Генерирует уточняющий вопрос по неясным полям.

        Args:
            unclear_fields: список полей, требующих уточнения

        Returns:
            str — уточняющий вопрос
        """
        return "Уточните: " + ", ".join(str(f) for f in unclear_fields) + "?"