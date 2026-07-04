"""VCOS — Confidence Evaluator v1

Оценивает уверенность системы после каждого ответа пользователя.
Позволяет решить: двигаться дальше, уточнить или переспросить.

Принцип:
  Каждый ответ вносит ясность. Система спрашивает себя:
  «Насколько я уверен в этом блоке сейчас?»

Уверенность складывается из:
  1. Покрытие — сколько полей блока заполнено
  2. Конкретность — насколько значение специфично (не «свет», а «золотистый контражур»)
  3. Источник — user > combined > profile/inference > system
"""

import re
from dataclasses import dataclass, field

from hermes.kernel.decision_logger import DecisionLogger


@dataclass
class BlockConfidence:
    """Уверенность по одному VSL блоку."""
    block: str = ""
    filled: int = 0        # сколько полей заполнено
    total: int = 0         # сколько полей всего в блоке
    avg_specificity: float = 0.0  # средняя конкретность значений (0.0-1.0)
    source_weight: float = 0.0    # вес источника (user=1.0, combined=0.8, profile=0.6, llm=0.5)
    overall: float = 0.0   # итоговая уверенность (0.0-1.0)


class ConfidenceEvaluator:
    """Оценщик уверенности по VSL блокам.

    Использование:
        eval = ConfidenceEvaluator()
        eval.add_decision('composition', 'rule_of_thirds', 'respect', 'user')
        ...

        for b in eval.blocks():
            print(f'{b.block}: {b.overall:.2f}')
        print(eval.decision())  # → 'advance' / 'clarify' / 'retry'
    """

    # VSL блоки и их ключевые поля
    # Синхронизированы с тем, что отдаёт DialogueAgent.parse()
    BLOCK_FIELDS = {
        "intent": ["type", "color", "material", "fit", "collar", "sleeve", "fastening",
                   "purpose", "audience", "message", "emotion", "theme"],
        "character": ["identity", "pose", "expression", "wardrobe", "accessories",
                      "appearance"],
        "environment": ["location", "background", "props",
                        "architecture", "nature", "weather", "time"],
        "composition": ["composition", "balance", "depth_layers", "negative_space",
                        "rule_of_thirds"],
        "camera": ["angle", "shot", "lens", "pov", "movement", "height"],
        "lighting": ["lighting", "key", "fill", "rim", "contrast", "temperature",
                     "shadow_quality"],
        "color": ["color", "palette", "accent", "temperature", "saturation", "harmony"],
        "style": ["mood", "style", "atmosphere", "medium", "rendering_style",
                  "film_stock", "signature_element", "profile"],
    }

    SOURCE_WEIGHTS = {
        "user": 1.0,
        "combined": 0.85,
        "profile": 0.7,
        "inference": 0.5,
        "system": 0.3,
    }

    def __init__(self):
        self._decisions = []  # (block, field, value, source)

    def add_decision(self, block: str, field: str, value: str, source: str = "user"):
        """Добавить решение для оценки."""
        self._decisions.append((block, field, value, source))

    def add_from_logger(self, logger: DecisionLogger):
        """Загрузить все решения из DecisionLogger."""
        for d in logger.decisions:
            self._decisions.append((d.block, d.field, d.value, d.source))

    def _specificity(self, value: str) -> float:
        """Оценить конкретность значения.

        1.0 — очень конкретное: цифры, цвета, названия, имена
        0.5 — умеренное: описательное, но без цифр
        0.0 — размытое: очень короткое или общее
        """
        val = value.lower().strip()

        # Пусто
        if not val or len(val) < 3:
            return 0.0

        # Есть цифры, мм, градусы — очень конкретно
        if re.search(r'\d+', val):
            return 1.0

        # Конкретные термины (только осмысленные: односимвольные/двухсимвольные
        # вроде 'k', 'wb', 'cf', 'ev' матчились с любым словом — убраны)
        specific_terms = ['mm', 'f/', 'f1.4', 'f2.8', '°', 'iso',
                          'golden hour', 'golden', 'sunset', 'bokeh',
                          'rim light', 'contra',
                          '85mm', '50mm', '35mm', '24mm']
        if any(t in val for t in specific_terms):
            return 0.9

        # Описательное, но не размытое (больше 30 символов)
        if len(val) > 30:
            return 0.6

        # Короткое, но не пустое
        if len(val) > 10:
            return 0.4

        return 0.3

    def block_confidence(self, block: str) -> BlockConfidence:
        """Оценить уверенность по одному блоку."""
        fields = self.BLOCK_FIELDS.get(block, [])
        if not fields:
            return BlockConfidence()

        # Решения по этому блоку
        block_decisions = [d for d in self._decisions if d[0] == block]

        filled = len(set(d[1] for d in block_decisions))
        total = len(fields)

        # Средняя конкретность
        specificities = [self._specificity(d[2]) for d in block_decisions]
        avg_spec = sum(specificities) / len(specificities) if specificities else 0.0

        # Вес источника (берём максимум)
        source_weights = [self.SOURCE_WEIGHTS.get(d[3], 0.3) for d in block_decisions]
        source_w = max(source_weights) if source_weights else 0.0

        # Итоговая уверенность
        coverage = filled / total if total > 0 else 0.0
        overall = (coverage * 0.4 + avg_spec * 0.35 + source_w * 0.25)

        return BlockConfidence(
            block=block,
            filled=filled,
            total=total,
            avg_specificity=avg_spec,
            source_weight=source_w,
            overall=round(overall, 2),
        )

    def overall_confidence(self) -> float:
        """Общая уверенность по всем блокам.

        Средняя по заполненным блокам, умноженная на мягкий штраф
        за пустые блоки: 0.65 + 0.35 * (заполненные / все блоки).
        Проект с одним заполненным блоком не может быть так же уверен,
        как проект со всеми восемью.
        """
        blocks = set(d[0] for d in self._decisions if d[0] in self.BLOCK_FIELDS)
        if not blocks:
            return 0.0
        scores = [self.block_confidence(b).overall for b in blocks]
        avg = sum(scores) / len(scores)
        coverage_penalty = 0.65 + 0.35 * (len(blocks) / len(self.BLOCK_FIELDS))
        return round(avg * coverage_penalty, 2)

    def decision(self, threshold_advance: float = 0.7,
                 threshold_clarify: float = 0.4) -> str:
        """Что делать дальше на основе уверенности.

        Returns:
          'advance' — уверенность высока, идём к следующему блоку
          'clarify' — средняя уверенность, нужно уточнение
          'retry'   — низкая уверенность, переспросить иначе
        """
        score = self.overall_confidence()
        if score >= threshold_advance:
            return "advance"
        elif score >= threshold_clarify:
            return "clarify"
        else:
            return "retry"

    def blocks(self) -> list[BlockConfidence]:
        """Все блоки с их уверенностью."""
        blocks = set(d[0] for d in self._decisions if d[0] in self.BLOCK_FIELDS)
        return [self.block_confidence(b) for b in blocks]

    def missing_fields(self) -> dict[str, list[str]]:
        """Какие поля в каких блоках остались пустыми.

        Returns:
            {"composition": ["depth_layers", "negative_space"], ...}
        """
        # Собрать известные (block, field) пары
        known = set()
        for block, field, _, _ in self._decisions:
            known.add((block, field))

        missing = {}
        for block, fields in self.BLOCK_FIELDS.items():
            empty = [f for f in fields if (block, f) not in known]
            if empty:
                missing[block] = empty

        return missing

    def summary(self) -> dict:
        """Полная сводка."""
        return {
            "overall": self.overall_confidence(),
            "decision": self.decision(),
            "blocks": {b.block: b.overall for b in self.blocks()},
            "total_decisions": len(self._decisions),
        }


# Быстрый тест
if __name__ == "__main__":
    eval = ConfidenceEvaluator()
    eval.add_decision("composition", "balance", "asymmetric", "user")
    eval.add_decision("composition", "depth_layers", "3 layers", "user")
    eval.add_decision("lighting", "key", "warm golden hour", "user")
    eval.add_decision("lighting", "fill", "soft reflector", "profile")

    print(f"Overall: {eval.overall_confidence():.2f}")
    print(f"Decision: {eval.decision()}")
    for b in eval.blocks():
        print(f"  {b.block}: {b.overall:.2f} ({b.filled}/{b.total})")
    print(f"Summary: {eval.summary()}")