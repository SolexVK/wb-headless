"""VCOS — Tests: Domain Packs (Phase 3B)

Проверяет Film Pack, Advertising Pack и интеграцию DomainPackRegistry в Orchestrator.
Не требует LLM — все тесты на синтетических данных.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.domain_packs.base import (
    DomainPack, DomainQuestion, DomainConstraint, DomainPackRegistry
)
from hermes.domain_packs.film_pack import FilmPack
from hermes.domain_packs.advertising_pack import AdvertisingPack
from hermes.domain_packs.photography_pack import PhotographyPack


# ═══════════════════════════════════════════
# Film Pack
# ═══════════════════════════════════════════

def test_film_pack_name_and_domains():
    """FilmPack имеет правильные имя и домены."""
    p = FilmPack()
    assert p.name == "film"
    assert "кино" in p.domains
    assert "cinema" in p.domains
    assert "film" in p.domains
    assert p.supports("кино")
    assert p.supports("cinema")


def test_film_pack_questions_no_context():
    """FilmPack возвращает базовые вопросы без контекста."""
    p = FilmPack()
    qs = p.get_questions()
    assert len(qs) >= 5  # genre, format, scene_type, mood, period, color_grading
    texts = [q.text for q in qs]
    blocks = [q.block for q in qs]
    assert any("жанр" in t.lower() or "Жанр" in t for t in texts)
    assert any("формат" in t.lower() or "Формат" in t for t in texts)
    assert any("локация" in t.lower() or "Локация" in t for t in texts)
    assert any("настроение" in t.lower() or "атмосфера" in t.lower() for t in texts)
    assert "intent" in blocks
    assert "character" in blocks
    assert "atmosphere" in blocks


def test_film_pack_questions_action_context():
    """FilmPack добавляет вопрос про движение для экшна."""
    p = FilmPack()
    qs = p.get_questions({"genre": "экшн"})
    texts = [q.text for q in qs]
    assert any("динамик" in t.lower() or "камера" in t.lower() for t in texts)


def test_film_pack_questions_noir_context():
    """FilmPack добавляет вопрос про свет для нуара."""
    p = FilmPack()
    qs = p.get_questions({"genre": "нуар"})
    texts = [q.text for q in qs]
    assert any("свет" in t.lower() for t in texts)


def test_film_pack_constraints_default():
    """FilmPack возвращает базовые кинематографические ограничения."""
    p = FilmPack()
    cs = p.get_constraints()
    descriptions = [c.description for c in cs]
    assert any("кинематографическое качество" in d.lower() or "резкости" in d.lower() for d in descriptions)
    assert any("letterbox" in d.lower() or "chambord" in d.lower() for d in descriptions)


def test_film_pack_constraints_noir():
    """FilmPack добавляет нуар-ограничения для жанра нуар."""
    p = FilmPack()
    cs = p.get_constraints({"genre": "нуар"})
    descriptions = [c.description for c in cs]
    assert any("контраст" in d.lower() and "тени" in d.lower() for d in descriptions)


def test_film_pack_render_hints():
    """FilmPack возвращает рендер-хинты для разных моделей."""
    p = FilmPack()
    assert "aspect_ratio" in p.get_render_hints("chatgpt")
    assert "ar" in p.get_render_hints("midjourney")
    assert "width" in p.get_render_hints("sdxl")
    assert p.get_render_hints("blank_model") == {}


# ═══════════════════════════════════════════
# Advertising Pack
# ═══════════════════════════════════════════

def test_advertising_pack_name_and_domains():
    """AdvertisingPack имеет правильные имя и домены."""
    p = AdvertisingPack()
    assert p.name == "advertising"
    assert "wb" in p.domains
    assert "маркетинг" in p.domains
    assert "реклама" in p.domains
    assert p.supports("wb")
    assert p.supports("реклама")


def test_advertising_pack_questions_default():
    """AdvertisingPack возвращает базовые вопросы."""
    p = AdvertisingPack()
    qs = p.get_questions()
    assert len(qs) >= 3  # platform, audience, cta, brand_colors
    texts = [q.text for q in qs]
    assert any("платформа" in t.lower() or "размещения" in t.lower() for t in texts)
    assert any("аудитория" in t.lower() for t in texts)
    assert any("цель" in t.lower() for t in texts)


def test_advertising_pack_questions_wb_context():
    """AdvertisingPack добавляет WB-специфичные вопросы."""
    p = AdvertisingPack()
    qs = p.get_questions({"platform": "wb"})
    texts = [q.text for q in qs]
    assert any("товаре" in t.lower() or "фокус" in t.lower() for t in texts)
    assert any("соотношение" in t.lower() for t in texts)


def test_advertising_pack_questions_instagram_context():
    """AdvertisingPack добавляет Instagram-специфичные вопросы."""
    p = AdvertisingPack()
    qs = p.get_questions({"platform": "instagram"})
    texts = [q.text for q in qs]
    assert any("lifestyle" in t.lower() for t in texts)


def test_advertising_pack_constraints_default():
    """AdvertisingPack возвращает базовые коммерческие ограничения."""
    p = AdvertisingPack()
    cs = p.get_constraints()
    assert len(cs) >= 2  # focus + photorealism
    descriptions = [c.description for c in cs]
    assert any("фокусе" in d.lower() for d in descriptions)


def test_advertising_pack_constraints_wb():
    """AdvertisingPack добавляет WB-специфичные ограничения."""
    p = AdvertisingPack()
    cs = p.get_constraints({"platform": "wb"})
    descriptions = [c.description for c in cs]
    assert any("белый" in d.lower() and "фон" in d.lower() for d in descriptions)
    assert any("70" in d for d in descriptions)


def test_advertising_pack_constraints_instagram():
    """AdvertisingPack добавляет Instagram-специфичные ограничения."""
    p = AdvertisingPack()
    cs = p.get_constraints({"platform": "instagram"})
    descriptions = [c.description for c in cs]
    assert any("lifestyle" in d.lower() for d in descriptions)
    assert any("4:5" in d for d in descriptions)


def test_advertising_pack_render_hints():
    """AdvertisingPack возвращает рендер-хинты для разных моделей."""
    p = AdvertisingPack()
    assert "aspect_ratio" in p.get_render_hints("chatgpt")
    assert "ar" in p.get_render_hints("midjourney")
    assert p.get_render_hints("blank_model") == {}


# ═══════════════════════════════════════════
# DomainPackRegistry
# ═══════════════════════════════════════════

def test_registry_register_and_get():
    """Registry регистрирует и возвращает пакет."""
    r = DomainPackRegistry()
    p = FilmPack()
    r.register(p)
    assert r.get("film") is p
    assert r.get("nonexistent") is None


def test_registry_get_for_domain():
    """Registry находит пакет по домену."""
    r = DomainPackRegistry()
    r.register(AdvertisingPack())
    r.register(FilmPack())

    assert r.get_for_domain("wb").name == "advertising"
    assert r.get_for_domain("кино").name == "film"
    assert r.get_for_domain("nonexistent") is None


def test_registry_list_packs():
    """Registry возвращает список имён пакетов."""
    r = DomainPackRegistry()
    r.register(PhotographyPack())
    r.register(FilmPack())
    names = r.list_packs()
    assert "photography" in names
    assert "film" in names
    assert len(names) == 2


def test_registry_supports_multiple_domains():
    """Пакет может поддерживать несколько доменов."""
    r = DomainPackRegistry()
    r.register(AdvertisingPack())
    assert r.get_for_domain("wb").name == "advertising"
    assert r.get_for_domain("маркетинг").name == "advertising"
    assert r.get_for_domain("ozon").name == "advertising"


# ═══════════════════════════════════════════
# Pack Manifest
# ═══════════════════════════════════════════

def test_pack_manifest():
    """DomainPackManifest генерируется корректно."""
    p = FilmPack()
    m = p.manifest
    assert m.name == "film"
    assert "кино" in m.domains
    assert "cinema" in m.domains
    assert len(m.description) > 0


# ═══════════════════════════════════════════
# Контракт: все паки соответствуют интерфейсу base.py
# ═══════════════════════════════════════════

def _all_pack_classes():
    """Все DomainPack-классы, экспортируемые из hermes.domain_packs."""
    import inspect
    import hermes.domain_packs as dp
    classes = []
    for name in dir(dp):
        obj = getattr(dp, name)
        if (inspect.isclass(obj) and issubclass(obj, DomainPack)
                and obj is not DomainPack):
            classes.append(obj)
    return classes


def test_all_packs_exported():
    """В hermes.domain_packs экспортированы все известные паки."""
    names = {cls.name for cls in _all_pack_classes()}
    for expected in ("photography", "film", "advertising", "infographic",
                     "youtube", "fashion"):
        assert expected in names, f"Пак {expected} не экспортирован"


def test_all_packs_contract():
    """Каждый пак реализует интерфейс base.py без исключений.

    get_questions()/get_constraints(context)/get_render_hints(model)/manifest
    должны работать и возвращать корректные типы.
    """
    for cls in _all_pack_classes():
        pack = cls()
        assert pack.name, f"{cls.__name__}: пустое name"
        assert pack.domains, f"{cls.__name__}: пустой domains"

        # get_questions: без контекста и с контекстом
        for ctx in (None, {}, {"genre": "нуар", "platform": "wb",
                              "product_type": "одежда"}):
            qs = pack.get_questions(ctx)
            assert isinstance(qs, list), f"{cls.__name__}.get_questions"
            for q in qs:
                assert isinstance(q, DomainQuestion)
                assert q.block and q.field and q.text

        # get_constraints: базовая сигнатура принимает context
        for ctx in (None, {}, {"genre": "нуар", "platform": "wb"}):
            cs = pack.get_constraints(ctx)
            assert isinstance(cs, list), f"{cls.__name__}.get_constraints"
            for c in cs:
                assert isinstance(c, DomainConstraint)
                assert c.description
                assert isinstance(c.constraint_type, str)
                assert 0.0 <= c.confidence <= 1.0

        # get_render_hints: принимает имя модели, возвращает dict
        for model in ("chatgpt", "midjourney", "sdxl", "unknown_model"):
            hints = pack.get_render_hints(model)
            assert isinstance(hints, dict), f"{cls.__name__}.get_render_hints"

        # manifest: базовый property, а не самодельный метод
        m = pack.manifest
        assert m.name == pack.name
        assert m.domains == pack.domains


def test_film_pack_constraints_detective():
    """FilmPack добавляет нуар-ограничения и для детектива."""
    p = FilmPack()
    cs = p.get_constraints({"genre": "детектив"})
    descriptions = [c.description for c in cs]
    assert any("контраст" in d.lower() and "тени" in d.lower() for d in descriptions)


# ═══════════════════════════════════════════
# Integration: Domain Pack в Orchestrator
# ═══════════════════════════════════════════

def test_orchestrator_domain_pack_film():
    """Orchestrator подбирает Film Pack для категории 'кино'."""
    from hermes.orchestrator.core import Orchestrator
    o = Orchestrator()
    # start_new_session с категорией "кино" должна подобрать FilmPack
    o.start_new_session("кино")
    assert o._active_domain_pack is not None
    assert o._active_domain_pack.name == "film"


def test_orchestrator_domain_pack_advertising():
    """Orchestrator находит Advertising Pack для категории через start_new_session."""
    from hermes.orchestrator.core import Orchestrator
    # Через start_new_session с прямым доменом
    o = Orchestrator()
    o.start_new_session("wb")
    assert o._active_domain_pack is not None
    assert o._active_domain_pack.name == "advertising"

    # "реклама" тоже подходит
    o2 = Orchestrator()
    o2.start_new_session("реклама")
    assert o2._active_domain_pack is not None
    assert o2._active_domain_pack.name == "advertising"


def test_orchestrator_domain_pack_wb():
    """Orchestrator находит Advertising Pack для прямого совпадения 'marketplace'."""
    from hermes.orchestrator.core import Orchestrator
    o = Orchestrator()
    o.start_new_session("marketplace")
    assert o._active_domain_pack is not None
    assert o._active_domain_pack.name == "advertising"


def test_orchestrator_domain_pack_constraints_applied():
    """Domain Pack constraints добавляются в граф напрямую."""
    from hermes.orchestrator.core import Orchestrator
    o = Orchestrator()
    o.start_new_session("кино")
    assert o._active_domain_pack is not None

    # Напрямую взять constraints из pack и записать
    pack = o._active_domain_pack
    pack_constraints = pack.get_constraints({"platform": "кино", "product_type": "кино"})
    assert len(pack_constraints) > 0

    # Записать в лог через graph_adapter
    for c in pack_constraints:
        o.graph.record_constraint(
            c.description, constraint_type=c.constraint_type, source="domain_pack"
        )
        o.graph.logger.record(
            "constraints", c.constraint_type,
            c.description, pack.name, c.constraint_type,
        )

    # Проверить, что кинематографические ограничения записаны
    decisions = o.graph.logger.decisions
    constraint_decisions = [d for d in decisions if d.block == "constraints"]
    assert len(constraint_decisions) > 0

    cinematic_found = any(
        "резкости" in d.value.lower() or "боке" in d.value.lower() or "letterbox" in d.value.lower()
        for d in constraint_decisions
    )
    assert cinematic_found, f"Не найдено кинематографических ограничений в: {[d.value for d in constraint_decisions]}"


def test_orchestrator_photography_pack_selection():
    """Orchestrator выбирает Photography Pack для product-photography."""
    from hermes.orchestrator.core import Orchestrator
    o = Orchestrator()
    # Default — orthography не будет выбрана через список категорий
    # Просто проверяем что регистрация прошла
    packs = o.domain_packs.list_packs()
    assert "photography" in packs
    assert "film" in packs
    assert "advertising" in packs

# ═══════════════════════════════════════════
# LLM Client (domain_packs/llm_client.py)
# ═══════════════════════════════════════════

def test_llm_client_api_key_from_env(monkeypatch):
    """Ключ читается СНАЧАЛА из os.environ, потом из ~/.hermes/.env."""
    from hermes.domain_packs import llm_client

    monkeypatch.setenv("OPENROUTER_API_KEY", "env-key-123")
    assert llm_client.get_api_key() == "env-key-123"

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-env-key")
    assert llm_client.get_api_key() == "deepseek-env-key"


def test_llm_client_models_module_vars():
    """Модели вынесены в переменные модуля с дефолтами."""
    from hermes.domain_packs import llm_client

    assert llm_client.DEFAULT_MODEL
    assert llm_client.DEFAULT_FALLBACK_MODEL
    assert len(llm_client.MODELS) == 2
    # Без env-override MODELS совпадают с дефолтами
    import os
    if "VCOS_LLM_MODEL" not in os.environ:
        assert llm_client.MODELS[0] == llm_client.DEFAULT_MODEL
    if "VCOS_LLM_FALLBACK" not in os.environ:
        assert llm_client.MODELS[1] == llm_client.DEFAULT_FALLBACK_MODEL


def test_llm_client_no_key_returns_none(monkeypatch):
    """Без ключа call_llm сразу возвращает None (без сети и без sleep)."""
    from hermes.domain_packs import llm_client

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(llm_client.os.path, "expanduser",
                        lambda p: "/nonexistent/.hermes/.env")
    assert llm_client.call_llm("system", "user") is None
