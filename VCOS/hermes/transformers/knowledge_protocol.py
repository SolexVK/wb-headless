"""VCOS — Knowledge Protocol Dataclasses (CP-001 §5).

Formal dataclasses for Knowledge Provider Protocol:
  - KnowledgeRequest
  - KnowledgeResult

K-001: Read Only — KnowledgeProviders return facts, not mutations.
K-002: Domain Scoped — every fact tagged with its domain.
K-003: Cacheable — idempotent requests return same results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from uuid import UUID


@dataclass
class KnowledgeRequest:
    """Запрос к Knowledge Provider (CP-001 §5.2).

    Attributes:
        domain: домен запроса (photography, advertising, film...)
        project_type: тип проекта (product-photo, fashion, infographic...)
        constraints: ID активных ограничений
        facts: ID известных фактов
        free_text: свободный текстовый запрос
        max_results: макс. результатов (default: 10)
    """
    domain: str = "general"
    project_type: str = ""
    constraints: List[UUID] = field(default_factory=list)
    facts: List[UUID] = field(default_factory=list)
    free_text: Optional[str] = None
    max_results: int = 10


@dataclass
class KnowledgeResult:
    """Результат Knowledge Provider (CP-001 §5.3).

    Attributes:
        facts: найденные факты
        relations: отношения между фактами
        confidence: общая уверенность (0-1)
        source: источник знаний
    """
    facts: List[Dict[str, Any]] = field(default_factory=list)
    relations: List[Dict[str, Any]] = field(default_factory=list)
    confidence: float = 0.0
    source: str = "unknown"