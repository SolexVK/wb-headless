"""VCOS — Decision Logger v1

Лёгкий слой, записывающий каждое проектное решение.
Позволяет ответить на вопрос: «Почему это поле такое?»

Принципы:
  I-004 Decision-Driven State — каждое изменение состояния = Decision
  PM-I004 — каждый Decision обоснован

Источники решений:
  user      — ответ пользователя
  llm       — Inference Engine
  profile   — Director Profile
  system    — система (авто-заполнение)
"""

from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, timezone
from uuid import uuid4


@dataclass
class DecisionEntry:
    """Одно проектное решение."""
    id: str = ""
    block: str = ""          # VSL блок (composition, lighting, camera...)
    field: str = ""           # конкретное поле (key_light, lens, palette...)
    value: str = ""           # что выбрано
    source: str = ""          # user / llm / profile / system
    rationale: str = ""       # почему это решение
    confidence: float = 0.5   # 0.0-1.0
    timestamp: str = ""

    def __post_init__(self):
        if not self.id:
            self.id = uuid4().hex[:8]
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")


class DecisionLogger:
    """Логгер проектных решений.

    Использование:
        log = DecisionLogger()
        log.record("lighting", "key_light", "warm",
                    source="profile", rationale="Harari profile: warm signature")
        log.record("composition", "balance", "asymmetric",
                    source="user", rationale="Пользователь сказал: 'лёгкая асимметрия'")
        print(log.why("key_light"))  # → "warm (from profile: Harari signature)"
    """

    def __init__(self):
        self._decisions: list[DecisionEntry] = []

    @property
    def decisions(self) -> list[DecisionEntry]:
        """Все записанные решения (read-only)."""
        return list(self._decisions)

    def record(self,
               block: str,
               field: str,
               value: str,
               source: str = "user",
               rationale: str = "",
               confidence: float = 0.5) -> DecisionEntry:
        """Записать решение."""
        entry = DecisionEntry(
            block=block,
            field=field,
            value=value,
            source=source,
            rationale=rationale,
            confidence=confidence,
        )
        self._decisions.append(entry)
        return entry

    def record_batch(self, entries: list[tuple]) -> list[DecisionEntry]:
        """Записать список решений.
        Каждый кортеж: (block, field, value, source, rationale, confidence)
        """
        results = []
        for e in entries:
            results.append(self.record(*e))
        return results

    def why(self, field: str) -> str:
        """Ответить: почему это поле такое?"""
        for d in reversed(self._decisions):
            if d.field == field:
                return f"{d.value} (from {d.source}: {d.rationale})"
        return "— не зафиксировано"

    def get_by_block(self, block: str) -> list[DecisionEntry]:
        """Все решения по VSL блоку."""
        return [d for d in self._decisions if d.block == block]

    def get_by_source(self, source: str) -> list[DecisionEntry]:
        """Все решения от источника."""
        return [d for d in self._decisions if d.source == source]

    def summary(self) -> dict:
        """Сводка: сколько решений, откуда, по каким блокам."""
        sources = {}
        blocks = {}
        for d in self._decisions:
            sources[d.source] = sources.get(d.source, 0) + 1
            blocks[d.block] = blocks.get(d.block, 0) + 1
        return {
            "total": len(self._decisions),
            "by_source": sources,
            "by_block": blocks,
            "last": self._decisions[-1].field if self._decisions else "",
        }

    def __len__(self) -> int:
        return len(self._decisions)