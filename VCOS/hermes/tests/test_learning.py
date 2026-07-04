"""VCOS — Tests: Learning Engine (CA-001.4.8, CP-001.10)

Проверяет extract_patterns: группировку по уникальным проектам,
учёт project_ids, шкалу confidence и жизненный цикл паттернов.
"""

import sys, os
sys.path.insert(0, os.path.expanduser("~/VCOS"))

from hermes.learning.engine import LearningEngine, Pattern


def _decisions():
    return {
        "p1": [
            {"domain": "photography", "field": "lighting", "value": "golden_hour"},
            {"domain": "photography", "field": "lens", "value": "85mm"},
        ],
        "p2": [
            {"domain": "photography", "field": "lighting", "value": "golden_hour"},
        ],
        "p3": [
            {"domain": "photography", "field": "lens", "value": "35mm"},
        ],
    }


def test_extract_patterns_basic():
    """Паттерн извлекается при >= 2 подтверждающих проектах."""
    e = LearningEngine()
    patterns = e.extract_patterns(["p1", "p2", "p3"], _decisions())
    assert len(patterns) == 1
    p = patterns[0]
    assert isinstance(p, Pattern)
    assert p.domain == "photography"
    assert p.field_name == "lighting"
    assert p.recommended_value == "golden_hour"
    assert p.evidence_count == 2
    assert sorted(p.source_projects) == ["p1", "p2"]
    assert p.status == "candidate"


def test_extract_patterns_counts_unique_projects():
    """Повторы решения внутри одного проекта не дают паттерна."""
    e = LearningEngine()
    decisions = {
        "p1": [
            {"domain": "film", "field": "mood", "value": "noir"},
            {"domain": "film", "field": "mood", "value": "noir"},
            {"domain": "film", "field": "mood", "value": "noir"},
        ],
    }
    patterns = e.extract_patterns(["p1"], decisions)
    assert patterns == []


def test_extract_patterns_respects_project_ids():
    """Решения проектов вне project_ids игнорируются."""
    e = LearningEngine()
    # golden_hour подтверждают p1 и p2, но p2 не в списке
    patterns = e.extract_patterns(["p1", "p3"], _decisions())
    assert patterns == []


def test_extract_patterns_confidence_scale():
    """Confidence растёт с числом проектов: 2/5=0.4, 5+/5 → 1.0."""
    e = LearningEngine()
    decisions = {
        f"p{i}": [{"domain": "photography", "field": "lighting",
                   "value": "golden_hour"}]
        for i in range(1, 6)
    }
    patterns = e.extract_patterns(list(decisions.keys()), decisions)
    assert len(patterns) == 1
    assert patterns[0].confidence == 1.0

    e2 = LearningEngine()
    two = {k: v for k, v in decisions.items() if k in ("p1", "p2")}
    patterns2 = e2.extract_patterns(["p1", "p2"], two)
    assert len(patterns2) == 1
    assert patterns2[0].confidence == 0.4  # заметно выше вечных 0.2


def test_suggest_next_uses_field_name():
    """suggest_next предлагает утверждённый паттерн для незаполненного поля."""
    e = LearningEngine()
    patterns = e.extract_patterns(["p1", "p2", "p3"], _decisions())
    e.approve_pattern(patterns[0].id.hex[:8])

    suggestions = e.suggest_next({
        "domain": "photography",
        "decisions": [{"field": "lens", "value": "85mm"}],
    })
    assert len(suggestions) == 1
    s = suggestions[0]
    assert s.field == "lighting"
    assert s.suggested_value == "golden_hour"

    # Если поле уже решено — подсказки нет
    none_left = e.suggest_next({
        "domain": "photography",
        "decisions": [{"field": "lighting", "value": "studio"}],
    })
    assert none_left == []
