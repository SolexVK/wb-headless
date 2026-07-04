"""VCOS — Proposal v1

Формальный объект предложения (CA-001: Propose/Accept/Reject).

LLM (или другой источник) предлагает изменения в графе.
Kernel принимает или отклоняет их через DecisionMaker.
"""

from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID, uuid4
from datetime import datetime, timezone
from enum import Enum

from hermes.kernel.core import Node, Edge


class ProposalStatus(str, Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class ProposalSource(str, Enum):
    LLM = "llm"
    USER = "user"
    PROFILE = "profile"
    TRANSFORMER = "transformer"
    SYSTEM = "system"


@dataclass
class Proposal:
    """Предложение изменений в Semantic Graph.

    Содержит:
      - Какие Nodes и Edges предлагается создать
      - Кто автор (LLM, профиль, пользователь)
      - Обоснование — почему это предложение
      - Статус — что с ним сделал Kernel
    """
    id: str = field(default_factory=lambda: uuid4().hex[:12])
    status: ProposalStatus = ProposalStatus.PENDING

    # Что предлагается
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)

    # Кто предложил
    source: ProposalSource = ProposalSource.LLM
    author: str = "llm"               # human-readable name
    justification: str = ""           # почему это предложение

    # Мета
    confidence: float = 0.5
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    decided_at: Optional[str] = None
    reject_reason: Optional[str] = None

    def accept(self, rationale: str = "Accepted by Kernel"):
        """Принять предложение."""
        self.status = ProposalStatus.ACCEPTED
        self.decided_at = datetime.now(timezone.utc).isoformat()

    def reject(self, reason: str):
        """Отклонить предложение."""
        self.status = ProposalStatus.REJECTED
        self.decided_at = datetime.now(timezone.utc).isoformat()
        self.reject_reason = reason

    @property
    def is_resolved(self) -> bool:
        return self.status in (ProposalStatus.ACCEPTED, ProposalStatus.REJECTED)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "status": self.status.value,
            "source": self.source.value,
            "author": self.author,
            "nodes": len(self.nodes),
            "edges": len(self.edges),
            "justification": self.justification[:80] if self.justification else "",
            "confidence": self.confidence,
        }