"""VCOS — Tests: ConfidenceEvaluator (unit, no LLM)

Проверяет расчёт уверенности по VSL блокам.
Не требует LLM — работает на синтетических данных.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.design.confidence import ConfidenceEvaluator


def test_empty_evaluator_returns_retry():
    """Пустой Evaluator → retry."""
    e = ConfidenceEvaluator()
    assert e.overall_confidence() == 0.0
    assert e.decision() == "retry"


def test_single_field_low_confidence():
    """Одно поле с коротким значением → clarify."""
    e = ConfidenceEvaluator()
    e.add_decision("intent", "color", "синий", "user")
    conf = e.overall_confidence()
    assert e.decision() in ("clarify", "retry"), f"Ожидается clarify/retry, получено {e.decision()}"
    # Уверенность должна быть низкой из-за плохого покрытия (1/12)


def test_all_intent_fields_filled():
    """Все поля intent заполнены → advance."""
    e = ConfidenceEvaluator()
    for f in ["type", "color", "material", "fit", "collar", "sleeve", "fastening"]:
        e.add_decision("intent", f, f"значение {f}", "user")
    # Добавим source_weight — user = 1.0
    conf = e.block_confidence("intent")
    assert conf.filled == 7
    assert conf.total == 12
    assert conf.source_weight == 1.0
    assert conf.overall > 0.5  # должно быть выше 0.5


def test_high_specificity_boosts_confidence():
    """Цифры и конкретные термины → выше уверенность."""
    e = ConfidenceEvaluator()
    # Короткое общее значение
    e.add_decision("lighting", "lighting", "свет", "user")
    conf_vague = e.block_confidence("lighting").overall

    e2 = ConfidenceEvaluator()
    # Конкретное (число + термин)
    e2.add_decision("lighting", "lighting", "золотистый контражур 45°", "user")
    conf_specific = e2.block_confidence("lighting").overall

    assert conf_specific > conf_vague, \
        f"Конкретное ({conf_specific}) должно быть выше размытого ({conf_vague})"


def test_source_weight_influence():
    """User > profile > inference > system."""
    e = ConfidenceEvaluator()
    e.add_decision("style", "mood", "тёплое", "user")
    e.add_decision("style", "style", "natural", "inference")
    block = e.block_confidence("style")
    assert block.source_weight == 1.0  # max source weight


def test_partial_coverage():
    """Частично заполненный блок → clarify."""
    e = ConfidenceEvaluator()
    e.add_decision("character", "identity", "девушка 25 лет", "user")
    e.add_decision("character", "wardrobe", "рубашка джинсы", "user")
    # total=6, filled=2 → coverage ~0.33
    assert e.decision() == "clarify"
    assert e.overall_confidence() >= 0.3


def test_multiple_blocks_aggregate():
    """Несколько блоков → средняя уверенность."""
    e = ConfidenceEvaluator()
    for f in ["type", "color", "material", "fit"]:
        e.add_decision("intent", f, f"значение", "user")
    e.add_decision("character", "identity", "девушка", "user")
    e.add_decision("character", "wardrobe", "рубашка", "user")
    # 2 блока, у каждого своя уверенность
    blocks = e.blocks()
    assert len(blocks) == 2
    overall = e.overall_confidence()
    assert 0.3 <= overall <= 0.7


def test_prompt_exporter_structure():
    """PromptExporter выдаёт структурированный промпт."""
    from hermes.renderers.prompt_exporter import build_full_story

    data = {
        "intent": "type: рубашка; color: голубая",
        "character": "identity: девушка 25 лет",
        "mood": "тёплое",
        "category": "одежда",
        "profile": "Харари",
    }
    story = build_full_story(data)
    assert "🎬 Concept" in story
    assert "👤 Character" in story
    assert "💭 Mood" in story
    assert story.count("\n\n") >= 2  # минимум 3 абзаца


def test_prompt_exporter_no_empty_paragraphs():
    """PromptExporter не выводит пустые блоки."""
    from hermes.renderers.prompt_exporter import build_full_story

    data = {"intent": "рубашка голубая"}
    story = build_full_story(data)
    assert "🎬 Concept: рубашка голубая" in story
    assert "👤 Character" not in story  # нет данных — нет блока
    assert "💡 Lighting" not in story


def test_prompt_exporter_with_reference():
    """PromptExporter добавляет референс."""
    from hermes.renderers.prompt_exporter import build_full_story, ReferenceSlot

    data = {"intent": "рубашка", "character": "девушка"}
    ref = ReferenceSlot(enabled=True, description="как в каталоге COS")
    story = build_full_story(data, ref)
    assert "🖼 Reference" in story


def test_decision_logger_basic():
    """DecisionLogger записывает и читает решения."""
    from hermes.kernel.decision_logger import DecisionLogger

    log = DecisionLogger()
    log.record("intent", "color", "синий", "user", "пользователь указал")
    assert len(log) == 1
    d = log.decisions[0]
    assert d.block == "intent"
    assert d.field == "color"
    assert d.value == "синий"
    assert d.source == "user"


def test_decision_logger_multiple():
    """DecisionLogger хранит несколько решений."""
    from hermes.kernel.decision_logger import DecisionLogger

    log = DecisionLogger()
    log.record("intent", "color", "синий", "user", "")
    log.record("character", "identity", "девушка", "user", "")
    log.record("lighting", "key", "золотистый", "profile", "профиль Харари")
    assert len(log) == 3
    assert log.decisions[2].source == "profile"


def test_semantic_graph_nodes():
    """SemanticGraphAdapter создаёт узлы и рёбра."""
    from hermes.kernel.graph_adapter import SemanticGraphAdapter
    from hermes.kernel.registry import Registry
    from hermes.kernel.project_model import ProjectModel, ProjectIdentity
    from datetime import datetime

    registry = Registry()
    project = ProjectModel(
        identity=ProjectIdentity(
            id=f"test_graph_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            version=1,
        )
    )
    g = SemanticGraphAdapter(registry, project)
    g.record_intent("Создание промпта")
    g.record_goal("Промпт для одежды")
    g.record_decision("intent", "color", "синий", "user", "выбор")
    g.record_blueprint()
    g.record_artifact("готовый промпт", "ChatGPT")

    assert g.registry.node_count >= 4  # intent, goal, blueprint, artifact
    assert g.registry.edge_count >= 2  # goal→intent, blueprint→artifact


def test_orchestrator_start_new_session():
    """Orchestrator создаёт новую сессию с вопросом (через SDE)."""
    from hermes.orchestrator.core import Orchestrator

    o = Orchestrator()
    res = o.start_new_session()
    assert res["type"] == "question"
    assert len(res["text"]) > 10  # SDE задаёт осмысленный вопрос


def test_orchestrator_category_selection():
    """Orchestrator принимает валидную категорию (через SDE)."""
    from hermes.orchestrator.core import Orchestrator

    o = Orchestrator()
    o.start_new_session()
    res = o.submit_answer("одежда")
    assert res["type"] == "question"
    assert len(res["text"]) > 10
    assert o._current_category == "одежда"


def test_orchestrator_invalid_category():
    """Orchestrator отклоняет невалидную категорию."""
    from hermes.orchestrator.core import Orchestrator

    o = Orchestrator()
    o.start_new_session()
    res = o.submit_answer("космос")
    assert res["type"] == "question"
    assert "Выбери" in res["text"] or "списка" in res["text"]
    assert o._current_category == ""  # не сохранилась