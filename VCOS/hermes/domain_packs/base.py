"""VCOS — Domain Pack Protocol (CP-001.7)

DomainPack — изолированный модуль знаний для конкретного домена.

Принцип (Insight #7):
  Система универсальна. Доменные знания — в Domain Packs.
  Ядро ничего не знает про WB, одежду, фото, кино.

CP-001.7 Domain Pack Protocol:
  - define_domain() — вернуть имя домена
  - get_questions() — вопросы для интервью
  - get_constraints() — ограничения домена
  - get_render_hints() — подсказки для рендера
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class DomainPackManifest:
    """Метаданные Domain Pack."""
    name: str
    version: str = "1.0.0"
    description: str = ""
    domains: list[str] = field(default_factory=list)
    requires_knowledge: list[str] = field(default_factory=list)


@dataclass
class DomainQuestion:
    """Вопрос для интервью по домену."""
    block: str          # VSL-блок
    field: str          # поле внутри блока
    text: str           # текст вопроса
    required: bool = True
    examples: list[str] = field(default_factory=list)


@dataclass
class DomainConstraint:
    """Дефолтное ограничение домена."""
    description: str
    constraint_type: str = "must_have"  # must_have, must_not, general
    confidence: float = 0.9


class DomainPack(ABC):
    """Абстрактный Domain Pack (CP-001.7).

    Использование:
        class PhotographyPack(DomainPack):
            name = "photography"
            domains = ["photography", "product-photography"]

            def get_questions(self, context):
                return [...]
    """

    name: str = ""
    domains: list[str] = []
    # Домены знаний, которые пак запрашивает у KnowledgeRegistry
    requires_knowledge: list[str] = []

    @property
    def manifest(self) -> DomainPackManifest:
        return DomainPackManifest(
            name=self.name,
            domains=self.domains,
            description=self.__doc__ or "",
            requires_knowledge=list(self.requires_knowledge),
        )

    @abstractmethod
    def get_questions(self, context: Optional[dict] = None) -> list[DomainQuestion]:
        """Вернуть вопросы для интервью по домену."""
        ...

    def get_constraints(self, context: Optional[dict] = None) -> list[DomainConstraint]:
        """Вернуть дефолтные ограничения домена."""
        return []

    def get_render_hints(self, model: str) -> dict:
        """Вернуть подсказки для рендера (соотношение сторон, стиль)."""
        return {}

    def supports(self, domain: str) -> bool:
        return domain in self.domains


class DomainPackRegistry:
    """Реестр Domain Pack'ов."""

    def __init__(self):
        self._packs: dict[str, DomainPack] = {}

    def register(self, pack: DomainPack) -> None:
        self._packs[pack.name] = pack

    def get(self, name: str) -> Optional[DomainPack]:
        return self._packs.get(name)

    def get_for_domain(self, domain: str) -> Optional[DomainPack]:
        for pack in self._packs.values():
            if pack.supports(domain):
                return pack
        return None

    def list_packs(self) -> list[str]:
        return list(self._packs.keys())