"""VCOS — Design Space v1 (прототип)

Пространство творческих решений (158.txt).
Режиссёр не заполняет поля последовательно — он ИССЛЕДУЕТ пространство решений.

Design Space = все возможные комбинации (Intent × Strategy × Narrative × VisualLang).
Каждое принятое решение сужает пространство.

Принцип:
  Design Space — это не состояние. Это способ мышления.
  Каждый шаг: "А что если сделать вот так?"
"""

from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class DesignHypothesis:
    """Одна гипотеза в Design Space (158.txt:96-100).

    Режиссёр думает гипотезами:
      "А если сделать огромное пространство?"
      "Нет."
      "А если пустой дом?"
      "Лучше."
    """
    block: str              # VSL-блок (composition, lighting, etc.)
    field: str              # поле внутри блока
    proposed_value: str     # что предлагается
    reasoning: str          # почему это может сработать
    confidence: float = 0.5
    status: str = "proposed"  # proposed → accepted → rejected


@dataclass
class DesignSpaceState:
    """Текущее состояние Design Space.

    Содержит: зафиксированные решения, открытые гипотезы,
    отклонённые варианты.
    """
    decisions: dict = field(default_factory=dict)  # {block.field: value}
    hypotheses: list[DesignHypothesis] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)  # что уже отвергли


class DesignSpace:
    """Пространство решений — способ мышления режиссёра.

    Использование:
        ds = DesignSpace()
        ds.add_hypothesis("composition", "shot", "общий план",
                          "показать масштаб")
        ds.accept("composition.shot")
        ds.reject("composition.shot")
        next = ds.suggest_next()  # что ещё не решено
    """

    def __init__(self):
        self._state = DesignSpaceState()

    def add_hypothesis(self, block: str, field: str, value: str,
                       reasoning: str, confidence: float = 0.5) -> DesignHypothesis:
        """Добавить гипотезу в пространство решений."""
        h = DesignHypothesis(
            block=block,
            field=field,
            proposed_value=value,
            reasoning=reasoning,
            confidence=confidence,
        )
        self._state.hypotheses.append(h)
        return h

    def accept(self, key: str) -> bool:
        """Принять решение. key = 'block.field'"""
        for h in self._state.hypotheses:
            if f"{h.block}.{h.field}" == key and h.status == "proposed":
                h.status = "accepted"
                self._state.decisions[key] = h.proposed_value
                return True
        return False

    def reject(self, key: str) -> bool:
        """Отклонить решение."""
        for h in self._state.hypotheses:
            if f"{h.block}.{h.field}" == key and h.status == "proposed":
                h.status = "rejected"
                self._state.rejected.append(key)
                return True
        return False

    def suggest_next(self) -> Optional[DesignHypothesis]:
        """Какая гипотеза требует решения? (наименее уверенная)."""
        pending = [h for h in self._state.hypotheses if h.status == "proposed"]
        if not pending:
            return None
        # Сначала те, в чём меньше всего уверены
        pending.sort(key=lambda h: h.confidence)
        return pending[0]

    def is_resolved(self) -> bool:
        """Все ли гипотезы приняты или отвергнуты?"""
        return all(h.status != "proposed" for h in self._state.hypotheses)

    def to_dict(self) -> dict:
        return {
            "decisions": self._state.decisions,
            "pending": [f"{h.block}.{h.field}" for h in self._state.hypotheses
                        if h.status == "proposed"],
            "rejected": self._state.rejected,
        }