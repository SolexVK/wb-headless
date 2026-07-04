"""VCOS — KnowledgeProvider Protocol v1

CP-001.5 — Knowledge Provider Protocol.

Контракт:
  query(request: KnowledgeRequest) -> KnowledgeResult

KnowledgeProvider — источник фактов и правил для конкретного домена.
Не изменяет Canonical Model, только возвращает факты.
"""

from dataclasses import dataclass, field
from typing import Optional
from abc import ABC, abstractmethod


@dataclass
class KnowledgeRequest:
    """Запрос к KnowledgeProvider (CP-001.5.2)."""
    domain: str = ""
    context: dict = field(default_factory=dict)
    max_results: int = 10


@dataclass
class KnowledgeFact:
    """Один факт, возвращаемый KnowledgeProvider."""
    domain: str = ""
    block: str = ""
    vsl_field: str = ""
    value: str = ""
    confidence: float = 0.8
    source: str = "rule-based"
    tags: list = field(default_factory=list)


@dataclass
class KnowledgeResult:
    """Результат запроса к KnowledgeProvider (CP-001.5.3)."""
    facts: list = field(default_factory=list)
    confidence: float = 0.5
    source: str = ""


class KnowledgeProvider(ABC):
    """Абстрактный Knowledge Provider (CP-001.5.1)."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Уникальное имя провайдера."""

    @property
    @abstractmethod
    def domain(self) -> list:
        """Список доменов."""

    @property
    def version(self) -> str:
        return "1.0.0"

    @abstractmethod
    def query(self, request: KnowledgeRequest) -> KnowledgeResult:
        """Выполнить запрос к базе знаний."""

    def supports(self, domain: str) -> bool:
        return domain in self.domain