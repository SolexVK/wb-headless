"""VCOS — Knowledge Registry v1

Реестр всех KnowledgeProvider'ов в системе.

Позволяет:
  - Зарегистрировать провайдер
  - Найти провайдера по домену
  - Выполнить запрос ко всем подходящим провайдерам
  - Агрегировать результаты
"""

from typing import Optional
from hermes.knowledge.provider import (
    KnowledgeProvider, KnowledgeRequest, KnowledgeResult, KnowledgeFact
)


class KnowledgeRegistry:
    """Реестр провайдеров знаний.

    Использование:
        registry = KnowledgeRegistry()
        registry.register(PhotographyProvider())
        registry.register(LightingProvider())

        result = registry.query("photography", {"product_type": "одежда"})
        for fact in result.facts:
            print(f"{fact.block}.{fact.field} = {fact.value}")
    """

    def __init__(self):
        self._providers: dict[str, KnowledgeProvider] = {}

    def register(self, provider: KnowledgeProvider) -> None:
        """Зарегистрировать провайдера."""
        self._providers[provider.name] = provider

    def unregister(self, name: str) -> None:
        """Удалить провайдера."""
        self._providers.pop(name, None)

    def get(self, name: str) -> Optional[KnowledgeProvider]:
        """Получить провайдера по имени."""
        return self._providers.get(name)

    def get_for_domain(self, domain: str) -> list[KnowledgeProvider]:
        """Все провайдеры, поддерживающие домен."""
        return [p for p in self._providers.values() if p.supports(domain)]

    def query(self, domain: str = "",
              context: Optional[dict] = None,
              max_results: int = 15) -> KnowledgeResult:
        """Выполнить запрос ко всем подходящим провайдерам.

        Args:
            domain: домен для фильтрации
            context: контекст запроса
            max_results: макс. количество фактов

        Returns:
            Агрегированный результат от всех провайдеров
        """
        if context is None:
            context = {}

        request = KnowledgeRequest(
            domain=domain,
            context=context,
            max_results=max_results,
        )

        all_facts = []
        sources = []

        # Ищем провайдеров строго по домену: если по домену никого нет —
        # возвращаем пустой результат (доменная изоляция, Insight #7)
        if domain:
            providers = self.get_for_domain(domain)
        else:
            providers = list(self._providers.values())

        for provider in providers:
            result = provider.query(request)
            all_facts.extend(result.facts)
            if result.source:
                sources.append(result.source)

        # Дедуплицировать по (block, field)
        seen = set()
        unique_facts = []
        for fact in all_facts:
            key = (fact.block, fact.vsl_field)
            if key not in seen:
                seen.add(key)
                unique_facts.append(fact)

        # Сортировать по уверенности
        unique_facts.sort(key=lambda f: f.confidence, reverse=True)

        return KnowledgeResult(
            facts=unique_facts[:max_results],
            confidence=sum(f.confidence for f in unique_facts[:3]) / min(len(unique_facts[:3]), 3) if unique_facts else 0.0,
            source=", ".join(sources),
        )

    def query_block(self, block: str, domain: str = "",
                    context: Optional[dict] = None) -> KnowledgeResult:
        """Запросить факты для конкретного VSL блока."""
        result = self.query(domain=domain, context=context)
        filtered = [f for f in result.facts if f.block == block]
        return KnowledgeResult(
            facts=filtered,
            confidence=result.confidence,
            source=result.source,
        )

    def list_providers(self) -> list[dict]:
        """Список зарегистрированных провайдеров."""
        return [{
            "name": p.name,
            "domain": p.domain,
            "version": p.version,
        } for p in self._providers.values()]

    @property
    def count(self) -> int:
        return len(self._providers)