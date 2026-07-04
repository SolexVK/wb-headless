"""VCOS Reasoning — Inference Engine v3

LLM-рассуждение на основе Registry + DecisionLogger (не VisualProject).

Архитектура:
  1. Собрать известные факты из лога решений
  2. Определить, какие блоки VSL пусты
  3. LLM рассуждает и предлагает комбинации с обоснованием
  4. Kernel оценивает: применить или оставить (gap)

Принцип (CA-001):
  "LLM предлагает, Kernel решает."
"""

import json
from dataclasses import dataclass, field
from typing import Optional

from hermes.kernel.decision_logger import DecisionLogger


@dataclass
class InferenceResult:
    """Результат логического вывода LLM."""
    block: str
    field: str
    value: str
    confidence: float
    reasoning: str
    applied: bool = False


class InferenceEngine:
    """Движок логического вывода через LLM-рассуждение.

    Работает с плоскими данными из DecisionLogger (не VisualProject).
    """

    # Поля для каждого VSL блока — что нужно додумать
    BLOCK_FIELDS = {
        "camera": [
            ("lens", "Какой объектив лучше всего подойдёт?"),
            ("pov", "Точка съёмки: от первого лица или сторонний наблюдатель?"),
            ("angle", "Какой ракурс?"),
            ("height", "Высота камеры?"),
            ("dof", "Глубина резкости?"),
        ],
        "lighting": [
            ("fill", "Какой заполняющий свет?"),
            ("rim", "Нужен ли контровой свет для отделения от фона?"),
            ("volumetric", "Нужны ли объёмные лучи света (volumetric)?"),
            ("contrast", "Какой контраст?"),
            ("shadow_quality", "Качество теней?"),
        ],
        "color": [
            ("accent", "Какой цветовой акцент?"),
            ("harmony", "Какая цветовая гармония?"),
            ("saturation", "Насыщенность?"),
        ],
        "composition": [
            ("depth_layers", "Построение кадра по слоям?"),
            ("balance", "Симметричная или асимметричная композиция?"),
            ("negative_space", "Нужно ли негативное пространство?"),
            ("leading_lines", "Направляющие линии в кадре?"),
        ],
        "atmosphere": [
            ("density", "Плотность атмосферы?"),
            ("particles", "Частицы в воздухе (дым, пыль)?"),
        ],
        "motion": [
            ("blur", "Нужно ли размытие движения?"),
        ],
        "style": [
            ("film_stock", "Какая плёнка/стилизация?"),
            ("rendering_style", "Стиль рендеринга?"),
            ("art_direction", "Направление арт-дирекции?"),
        ],
    }

    def __init__(self):
        self._logger: Optional[DecisionLogger] = None

    def set_logger(self, logger: DecisionLogger):
        """Подключить логгер решений для чтения фактов."""
        self._logger = logger

    def infer(self, logger: Optional[DecisionLogger] = None) -> list[InferenceResult]:
        """Запустить LLM-рассуждение для незаполненных блоков.

        Args:
            logger: DecisionLogger с накопленными решениями.
                    Если не передан, использует self._logger.

        Returns:
            Список InferenceResult — выведенные значения
        """
        from hermes.domain_packs.llm_client import call_llm

        log = logger or self._logger
        if not log:
            return []

        # 1. Собрать известные факты из лога
        known = self._collect_known_facts(log)
        if not known:
            return []

        # 2. Определить пустые блоки
        empty_blocks = self._collect_empty_blocks(log)
        if not empty_blocks:
            return []
        empty_blocks = empty_blocks[:7]

        # 3. LLM
        prompt = self._build_prompt(known, empty_blocks)
        system = self._build_system_prompt(empty_blocks)

        response = call_llm(system, prompt,
                            model='deepseek/deepseek-v4-flash',
                            timeout=60, max_tokens=1200)
        if not response:
            return []

        return self._parse_llm_response(response)

    def _collect_known_facts(self, log: DecisionLogger) -> str:
        """Собрать известные факты из лога решений в читаемый текст."""
        facts = []

        # Группируем по блокам
        by_block = {}
        for d in log.decisions:
            if d.block not in by_block:
                by_block[d.block] = []
            by_block[d.block].append(f"{d.field}: {d.value}")

        for block, entries in by_block.items():
            facts.append(f"[{block}] {'; '.join(entries)}")

        return "\n".join(facts) if facts else "Нет известных фактов"

    def _collect_empty_blocks(self, log: DecisionLogger) -> list[dict]:
        """Собрать список пустых блоков на основе лога.

        Проверяет: если поле не встречается в логе — оно пустое.
        """
        # Собрать все известные (block, field) пары из лога
        known = set()
        for d in log.decisions:
            known.add((d.block, d.field))

        empty = []
        for block, fields in self.BLOCK_FIELDS.items():
            for field, question in fields:
                if (block, field) not in known:
                    empty.append({
                        "block": block,
                        "field": field,
                        "question": question,
                    })

        return empty

    def _build_system_prompt(self, empty_blocks: list[dict]) -> str:
        blocks_desc = "\n".join(
            f"  {i+1}. {b['block']}.{b['field']} — {b['question']}"
            for i, b in enumerate(empty_blocks)
        )

        return f"""Ты — режиссёр-постановщик и художник-постановщик.
Твоя задача — на основе известных фактов о проекте ДОДУМАТЬ недостающие визуальные решения.

ПРАВИЛА:
1. Каждое решение должно быть ОБОСНОВАНО — почему именно так, а не иначе
2. Решения должны быть согласованы между собой (не противоречить)
3. Если известен контекст — используй его для всех решений
4. Если контекста мало — ставь уверенность ниже
5. Все значения на РУССКОМ языке, конкретные, не общие

Пустые блоки для заполнения:
{blocks_desc}

Формат ответа — строго JSON-массив:
[
  {{
    "block": "camera",
    "field": "lens",
    "value": "85mm, портретный объектив",
    "confidence": 0.85,
    "reasoning": "Крупный план = нужна малая ГРИП, 85mm даёт естественную перспективу"
  }},
  ...
]

ВАЖНО: Не придумывай то, что противоречит известным фактам.
Если фактов мало — уверенность должна быть низкой (0.4-0.6)."""

    def _build_prompt(self, known_facts: str, empty_blocks: list[dict]) -> str:
        blocks_list = "\n".join(
            f"  {i+1}. {b['block']}.{b['field']}" for i, b in enumerate(empty_blocks)
        )
        return f"""ИЗВЕСТНЫЕ ФАКТЫ О ПРОЕКТЕ:
{known_facts}

ЧТО НУЖНО ДОДУМАТЬ:
{blocks_list}

На основе контекста предложи наилучшие значения для каждого пустого поля."""

    def _parse_llm_response(self, response: str) -> list[InferenceResult]:
        """Распарсить ответ LLM (с поддержкой ```json блоков)."""
        try:
            text = response.strip()
            if text.startswith("```"):
                first_newline = text.find("\n")
                if first_newline >= 0:
                    text = text[first_newline:]
                if text.endswith("```"):
                    text = text[:-3].strip()
                elif "```" in text:
                    text = text.rsplit("```", 1)[0].strip()

            start = text.find("[")
            end = text.rfind("]")
            if start >= 0 and end > start:
                json_str = text[start:end+1]
                data = json.loads(json_str)
            else:
                data = json.loads(text)

            results = []
            for item in data:
                if not isinstance(item, dict):
                    continue
                block = item.get("block", "")
                field = item.get("field", "")
                value = item.get("value", "")
                confidence = float(item.get("confidence", 0.5))
                reasoning = item.get("reasoning", "")

                if block and field and value:
                    results.append(InferenceResult(
                        block=block, field=field, value=value,
                        confidence=confidence, reasoning=reasoning,
                        applied=confidence >= 0.6,
                    ))

            return results

        except (json.JSONDecodeError, ValueError, TypeError) as e:
            return []


def demo():
    """Демонстрация Inference Engine v3."""
    import sys, os
    sys.path.insert(0, os.path.expanduser("~/VCOS"))

    engine = InferenceEngine()
    log = DecisionLogger()

    # Заполняем немного данных
    log.record("intent", "purpose", "Реклама премиального кофе", "user")
    log.record("intent", "emotion", "уют, тепло, забота", "user")
    log.record("intent", "message", "Начни утро с идеального кофе", "user")
    log.record("camera", "shot", "Крупный план", "user")
    log.record("style", "medium", "Фотография", "user")

    print("=" * 70)
    print("  ТЕСТ: LLM-рассуждение через DecisionLogger")
    print("=" * 70)

    print(f"\n  Известно: {len(log.decisions)} решений\n")
    print(f"  🤔 Запускаю LLM-рассуждение...\n")

    results = engine.infer(log)

    if results:
        print(f"  Выведено: {len(results)}")
        print(f"  Авто-применено: {sum(1 for r in results if r.applied)}")
        for r in results:
            icon = "✅" if r.applied else "❓"
            print(f"  {icon} {r.block}.{r.field}")
            print(f"     → {r.value} ({r.confidence:.0%})")
            print(f"     ↳ {r.reasoning}")
            print()
    else:
        print("  ❌ LLM не ответила (проверьте API-ключ OpenRouter)")
        print("  ⚠️  Fallback: блоки останутся как gaps для диалога")


if __name__ == "__main__":
    demo()