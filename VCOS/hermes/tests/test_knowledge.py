"""VCOS — Tests: Knowledge Providers & Registry (CP-001.5)

Проверяет доменную изоляцию registry, точный матч домена в правилах
и guard на пустой mood в LightingKnowledgeProvider.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.knowledge.provider import KnowledgeRequest
from hermes.knowledge.registry import KnowledgeRegistry
from hermes.knowledge.providers.photography import (
    PhotographyProvider, LightingKnowledgeProvider
)


def test_photography_provider_exact_domain_match():
    """Домен правила сравнивается точно, а не как подстрока."""
    p = PhotographyProvider()
    # Точный домен — правила находятся
    res = p.query(KnowledgeRequest(
        domain="product-photography",
        context={"product_type": "одежда"},
    ))
    assert len(res.facts) > 0

    # Подстрока домена правила ("photo" входит в "product-photography")
    # не должна матчиться
    res_sub = p.query(KnowledgeRequest(
        domain="photo",
        context={"product_type": "одежда"},
    ))
    assert res_sub.facts == []


def test_lighting_provider_empty_mood_no_match():
    """Пустой mood не должен матчиться ни с одним настроением."""
    p = LightingKnowledgeProvider()
    res = p.query(KnowledgeRequest(domain="lighting", context={"mood": ""}))
    mood_facts = [f for f in res.facts if "mood" in f.tags]
    assert mood_facts == []

    # Контекст вовсе без mood — тоже без mood-фактов
    res2 = p.query(KnowledgeRequest(domain="lighting", context={}))
    assert [f for f in res2.facts if "mood" in f.tags] == []


def test_lighting_provider_mood_match():
    """Непустой mood по-прежнему подбирает схему света."""
    p = LightingKnowledgeProvider()
    res = p.query(KnowledgeRequest(
        domain="lighting", context={"mood": "уют и тепло"},
    ))
    mood_facts = [f for f in res.facts if "mood" in f.tags]
    assert len(mood_facts) == 1
    assert "уют" in mood_facts[0].tags


def test_registry_domain_isolation():
    """Запрос по чужому домену не уходит всем провайдерам."""
    r = KnowledgeRegistry()
    r.register(PhotographyProvider())
    r.register(LightingKnowledgeProvider())

    res = r.query(domain="cooking", context={"product_type": "одежда"})
    assert res.facts == []
    assert res.confidence == 0.0


def test_registry_query_known_domain():
    """Запрос по известному домену возвращает факты."""
    r = KnowledgeRegistry()
    r.register(PhotographyProvider())

    res = r.query(domain="product-photography",
                  context={"product_type": "одежда"})
    assert len(res.facts) > 0
    assert all(f.domain == "product-photography" for f in res.facts)


def test_registry_query_without_domain_uses_all():
    """Запрос без домена по-прежнему опрашивает всех провайдеров."""
    r = KnowledgeRegistry()
    r.register(PhotographyProvider())
    r.register(LightingKnowledgeProvider())

    res = r.query(context={"product_type": "еда", "mood": "уют"})
    sources = {f.source.split("/")[0] for f in res.facts}
    assert "photography-rules" in sources
    assert "lighting-rules" in sources
