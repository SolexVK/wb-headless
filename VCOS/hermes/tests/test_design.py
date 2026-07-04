"""VCOS — Tests: design/ (ConfidenceEvaluator specificity, VisualReasoner proposals)

Покрывает скрытые поломки:
- мусорные термины specificity ('k', 'wb', 'cf') давали 0.9 любому слову
- overall_confidence игнорировал пустые блоки
- VisualReasoner создавал все предложения как NodeType.INTENT (placeholder)
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.design.confidence import ConfidenceEvaluator
from hermes.kernel.core import NodeType


# ═══════════════════════════════════════════
# ConfidenceEvaluator._specificity
# ═══════════════════════════════════════════

def test_specificity_no_junk_single_letter_terms():
    """Слова со случайной 'k'/'wb'/'cf' не получают specificity 0.9."""
    e = ConfidenceEvaluator()
    # 'k' входит в 'kitchen', 'wb' — просто буквы, раньше матчились
    assert e._specificity("kitchen table") < 0.9
    assert e._specificity("dark oak wood") < 0.9
    assert e._specificity("black") < 0.9


def test_specificity_meaningful_terms_still_high():
    """Осмысленные фототермины по-прежнему дают высокую конкретность."""
    e = ConfidenceEvaluator()
    assert e._specificity("golden hour backlight") >= 0.9
    assert e._specificity("soft bokeh background") >= 0.9
    assert e._specificity("85mm portrait") >= 0.9  # цифры → 1.0


def test_specificity_digits_max():
    """Числа дают максимальную конкретность."""
    e = ConfidenceEvaluator()
    assert e._specificity("объектив 85 мм, диафрагма 1.4") == 1.0


# ═══════════════════════════════════════════
# ConfidenceEvaluator.overall_confidence — штраф за пустые блоки
# ═══════════════════════════════════════════

def test_overall_penalizes_empty_blocks():
    """Один заполненный блок < те же решения + больше блоков."""
    one_block = ConfidenceEvaluator()
    one_block.add_decision("lighting", "key", "golden hour 45°", "user")
    one_block.add_decision("lighting", "fill", "soft reflector 30%", "user")
    score_one = one_block.overall_confidence()

    many_blocks = ConfidenceEvaluator()
    for block in ("lighting", "color", "camera", "composition",
                  "character", "environment", "intent", "style"):
        fields = ConfidenceEvaluator.BLOCK_FIELDS[block][:2]
        for f in fields:
            many_blocks.add_decision(block, f, "golden hour 45° detail", "user")
    score_many = many_blocks.overall_confidence()

    assert score_many > score_one, (
        f"Проект со всеми блоками ({score_many}) должен быть увереннее "
        f"проекта с одним блоком ({score_one})"
    )


def test_overall_empty_is_zero():
    """Без решений уверенность нулевая."""
    assert ConfidenceEvaluator().overall_confidence() == 0.0


# ═══════════════════════════════════════════
# VisualReasoner — Proposal содержит DECISION-узлы
# ═══════════════════════════════════════════

def test_visual_reasoner_proposal_nodes_are_decisions():
    """Предложения VisualReasoner — NodeType.DECISION, не INTENT-заглушки."""
    from hermes.design.visual_reasoner import VisualReasoner
    from hermes.design.director_profiles import ALL_PROFILES

    assert ALL_PROFILES, "Нет профилей режиссёров"
    profile_name = next(iter(ALL_PROFILES.keys()))

    vr = VisualReasoner()
    proposal = vr.propose_profile(profile_name)
    assert proposal is not None
    assert len(proposal.nodes) > 0
    for node in proposal.nodes:
        assert node.type == NodeType.DECISION, (
            f"Узел предложения должен быть DECISION, получен {node.type}"
        )
        assert node.properties.get("block")
        assert node.properties.get("field")
