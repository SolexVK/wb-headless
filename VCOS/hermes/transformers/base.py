"""VCOS — Transformer Base v2

Базовый класс для всех трансформеров.
Трансформер = stateless pure function: (ProjectModel, context) → TransformResult.

CP-001 §4.1:
  interface Transformer {
    name, version → transform(model, context) → TransformResult
  }

CP-001 §4.4:
  T-001 — Immutable Input (не мутирует входной model)
  T-002 — Pure Function (детерминированный)
  T-003 — Single Responsibility (один тип преобразования)
  T-004 — No Side Effects (все I/O через context)
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    from hermes.kernel.semantic_graph import SemanticGraph


@dataclass
class TransformResult:
    """Результат трансформации (CP-001 §4.3 + Encyclopedia §6.2).

    Каждый Transformer возвращает TransformResult.
    graph — новая версия SemanticGraph (immutable — всегда новый экземпляр).
    Encyclopedia: Transformer(SemanticGraph) → SemanticGraph
    """
    graph: Any                      # SemanticGraph — новая версия, не мутированный вход
    proposals: List[Any] = field(default_factory=list)  # Proposal[] от LLM
    decisions: List[UUID] = field(default_factory=list)  # DecisionID[]
    snapshots: List[UUID] = field(default_factory=list)  # SnapshotID[]
    artifacts: List[Any] = field(default_factory=list)   # Artifact[]
    log: Dict[str, Any] = field(default_factory=dict)    # TransformLog

    if TYPE_CHECKING:
        # type-narrowing: graph is always SemanticGraph at runtime
        _graph_type: 'SemanticGraph'


@dataclass
class TransformerContext:
    """Контекст трансформера (CP-001 §4.2).

    Передаётся в transform() как context.
    Содержит все внешние ресурсы, с которыми может взаимодействовать трансформер.
    """
    registry: Any = None            # Registry — все Nodes и Edges
    knowledge: List[Any] = field(default_factory=list)  # KnowledgeProvider[]
    memory: Any = None              # MemoryAccess
    interview: Any = None           # InterviewSession | None
    reasoning: Any = None           # ReasoningEngine (LLM)
    config: Dict[str, Any] = field(default_factory=dict)  # transformer-specific
    metadata: Dict[str, Any] = field(default_factory=lambda: {
        "session_id": "",
        "timestamp": "",
        "parent_transformer": "",
    })


class Transformer(ABC):
    """Базовый класс трансформера (CP-001 §4.1).

    Computational Theory (doc 168):
      Stateₙ → Transformer.transform() → Stateₙ₊₁

    Каждый трансформер отвечает за один тип преобразования:
      - DialogueTransformer     — диалог с пользователем
      - LLMTransformer          — вызовы LLM (API, ретраи, кэш)
      - KnowledgeTransformer    — поиск знаний (документы, векторная БД)
      - PipelineTransformer     — оркестрация цепочки трансформеров
    """

    @property
    @abstractmethod
    def phase_type(self) -> str:
        """Тип фазы: 'cognitive' (меняет понимание) или 'compilation' (экспорт)."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Уникальное имя трансформера."""

    @property
    @abstractmethod
    def version(self) -> str:
        """Версия трансформера (CP-001 §4.1)."""

    @abstractmethod
    def can_handle(self, phase: str) -> bool:
        """Может ли этот трансформер обработать данную фазу.

        Args:
            phase: имя фазы ('interview', 'design', 'compile', etc.)

        Returns:
            True если трансформер может обработать эту фазу
        """

    @abstractmethod
    def transform(self, graph: Any, context: TransformerContext) -> TransformResult:
        """Преобразовать SemanticGraph (Encyclopedia §6.2).

        Encyclopedia: Transformer(SemanticGraph) → SemanticGraph

        Args:
            graph: SemanticGraph — текущее состояние графа (НЕ мутировать!)
            context: TransformerContext — внешние ресурсы

        Returns:
            TransformResult — с proposals + обновлённый SemanticGraph

        T-001: graph НЕ МУТИРУЕТСЯ. Возвращается новый экземпляр.
        T-003: Один тип преобразования на трансформер.

        Note: Тип graph — SemanticGraph. В runtime используется Any для
        избежания циклических импортов, но SemanticGraph гарантируется.
        """
        ...
