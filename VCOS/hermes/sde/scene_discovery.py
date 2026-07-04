"""VCOS — Scene Discovery Engine v1

Определяет следующий вопрос, максимизирующий прирост качества.
Вместо фиксированного VSL-шаблона использует reasoning через LLM.

Принцип (из 150.txt:78-97):
  "Не собрать ответы, а уменьшить неопределённость."
  LLM анализирует, какие пробелы критичны и какой вопрос
  даст максимальный прирост качества результата.

CP-001.6 (Interview Protocol) — часть Interview слоя.
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class QuestionProposal:
    """Предложение вопроса от Scene Discovery Engine."""
    text: str
    block: str
    confidence: float  # насколько этот вопрос уменьшит неопределённость
    rationale: str     # почему именно этот вопрос


class SceneDiscoveryEngine:
    """Scene Discovery Engine — интеллектуальный выбор вопросов.

    Использование:
        sde = SceneDiscoveryEngine()
        question = sde.next_question(known_facts, empty_blocks)
    """

    # VSL Blocks через VSL-онтологию — Insight #2
    @property
    def VSL_BLOCKS(self) -> dict:
        return {b: self._vsl.get_block(b).description
                for b in self._vsl.list_blocks()
                if self._vsl.get_block(b)}

    def __init__(self, use_llm: bool = True):
        self._use_llm = use_llm
        from hermes.vsl.ontology import get_vsl
        self._vsl = get_vsl()

    def next_question(self, known_facts: dict,
                      empty_blocks: Optional[list[str]] = None,
                      context: Optional[dict] = None) -> QuestionProposal:
        """Выбрать следующий вопрос.

        Args:
            known_facts: dict {block: {field: value}} — что уже известно
            empty_blocks: ограничить выбор этими блоками (None = все)
            context: доп. контекст (категория, профиль)

        Returns:
            QuestionProposal с текстом вопроса
        """
        if self._use_llm:
            return self._llm_question(known_facts, empty_blocks, context)
        return self._fallback_question(known_facts, empty_blocks)

    def _llm_question(self, known_facts: dict,
                      empty_blocks: Optional[list[str]] = None,
                      context: Optional[dict] = None) -> QuestionProposal:
        """LLM выбирает вопрос."""
        from hermes.domain_packs.llm_client import call_llm

        # Собрать состояние
        known_summary = self._summarize_known(known_facts)

        if empty_blocks:
            candidates = [b for b in self.VSL_BLOCKS if b in empty_blocks]
        else:
            candidates = list(self.VSL_BLOCKS.keys())

        # Если всё известно — вопросов нет
        filled = set(known_facts.keys())
        available = [b for b in candidates if b not in filled]
        if not available:
            return QuestionProposal(
                text="Вроде всё собрал. Переходим к следующему шагу?",
                block="done",
                confidence=1.0,
                rationale="Все блоки заполнены",
            )

        candidates_desc = "\n".join(
            f"  {b}: {self.VSL_BLOCKS[b]}"
            for b in available
        )

        prompt = (
            f"Ты — Scene Discovery Engine. Твоя задача — задать СЛЕДУЮЩИЙ вопрос,\n"
            f"который МАКСИМАЛЬНО уменьшит неопределённость визуального проекта.\n\n"
            f"УЖЕ ИЗВЕСТНО:\n{known_summary}\n\n"
            f"ДОСТУПНЫЕ БЛОКИ СЦЕНЫ:\n{candidates_desc}\n\n"
            f"ПРАВИЛА:\n"
            f"1. Выбери ОДИН блок, пробел в котором наименее терпим\n"
            f"2. Вопрос должен быть про ВИЗУАЛЬНУЮ СЦЕНУ, а не про товар\n"
            f"3. Формулируй вопрос на русском, конкретно\n"
            f"4. Не задавай вопросы на уже заполненные блоки\n\n"
            f"Формат ответа — строго JSON:\n"
            f'{{"block": "lighting", "question": "Какое освещение лучше передаст настроение?", '
            f'"reasoning": "Свет — ключевой элемент, неизвестен"}}\n'
        )

        response = call_llm(
            "Ты Scene Discovery Engine. Выбери следующий вопрос.",
            prompt,
            model='deepseek/deepseek-v4-flash',
            timeout=30,
            max_tokens=500,
        )

        if response:
            import json
            try:
                data = json.loads(response.strip())
                block = data.get("block", available[0])
                q_text = data.get("question", f"Расскажи про {block}")
                reasoning = data.get("reasoning", "LLM выбрала этот блок")

                return QuestionProposal(
                    text=q_text,
                    block=block,
                    confidence=0.8,
                    rationale=reasoning,
                )
            except (json.JSONDecodeError, KeyError):
                pass

        # Fallback на первый доступный
        return self._fallback_question(known_facts, available)

    def _fallback_question(self, known_facts: dict,
                           available: Optional[list[str]] = None) -> QuestionProposal:
        """Без LLM — последовательный обход блоков."""
        blocks = available or list(self.VSL_BLOCKS.keys())
        filled = set(known_facts.keys())

        for block in blocks:
            if block not in filled:
                desc = self.VSL_BLOCKS.get(block, block)
                return QuestionProposal(
                    text=f"Расскажи про {desc}:",
                    block=block,
                    confidence=0.5,
                    rationale="Fallback: последовательный обход",
                )

        return QuestionProposal(
            text="Вроде всё собрал. Переходим к следующему шагу?",
            block="done",
            confidence=1.0,
            rationale="Все блоки заполнены",
        )

    def _summarize_known(self, known_facts: dict) -> str:
        """Собрать известные факты в строку для LLM."""
        if not known_facts:
            return "Ничего не известно."
        parts = []
        for block, fields in known_facts.items():
            if isinstance(fields, dict):
                field_str = "; ".join(f"{k}: {v}" for k, v in fields.items())
            else:
                field_str = str(fields)
            parts.append(f"[{block}] {field_str}")
        return "\n".join(parts)