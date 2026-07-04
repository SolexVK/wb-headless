"""VCOS — Dialogue Agent v2

Агент диалога: говорит с пользователем, парсит ответы, уточняет.

Теперь использует отдельный InterviewLayer (CP-001.8) для вопросов,
и LLMTransformer (CP-001.9) для парсинга.

Принципы:
  I-003 — Agent не принимает визуальных решений, только спрашивает
  CA-001 — LLM предлагает, Kernel решает
"""

import re
from typing import Optional
from dataclasses import dataclass, field

from hermes.transformers.llm_transformer import LLMTransformer
from hermes.interview.interview_layer import (
    InterviewLayer, InterviewState, Question,
    CATEGORIES, CATEGORY_ALIASES,
)


@dataclass
class ParsedAnswer:
    """Структурированный ответ после парсинга LLM."""
    raw: str = ""
    fields: dict = field(default_factory=dict)
    confidence: float = 0.5
    unclear: list = field(default_factory=list)
    source: str = "user"
    error: str = ""


class DialogueAgent:
    """Агент диалога. Координирует InterviewLayer + LLMTransformer.

    Не хранит состояние проекта. Только вопросы и парсинг.

    Использование:
        agent = DialogueAgent()
        q = agent.question("category")
        answer = agent.parse("product", "Рубашка голубая...")
        if answer.unclear:
            q = agent.clarify_question(answer.unclear)
    """

    def __init__(self):
        self._history = []
        self._llm = LLMTransformer()
        self.interview = InterviewLayer()

    def question(self, topic: str) -> str:
        """Получить вопрос по теме (через InterviewLayer)."""
        q = self.interview.ask(topic=topic)
        self._history.append({"type": "question", "topic": topic, "text": q.text})
        return q.text

    def parse(self, topic: str, answer: str, max_retries: int = 3) -> ParsedAnswer:
        """Распарсить ответ с помощью LLM.

        Возвращает структурированный ответ с полями, уверенностью и неясными полями.
        При ошибке LLM — повтор до max_retries раз, затем стоп с сообщением.
        """
        fields = self.interview.get_fields(topic)
        labels = self.interview.get_field_labels(topic)

        if not fields:
            return ParsedAnswer(raw=answer, fields={"text": answer})

        field_descs = "\n".join(
            f'  "{f}": "значение"  — {labels.get(f, f)}' for f in fields
        )

        from hermes.transformers.base import TransformerContext
        result = self._llm.transform(None, TransformerContext(config={
            "prompt": f"Извлеки информацию из ответа пользователя.\n\n"
                      f"Поля для заполнения:\n{field_descs}\n\n"
                      f"Верни ТОЛЬКО JSON без пояснений. "
                      f"Если информации по полю нет — пропусти его.\n\n"
                      f"Ответ: {answer}",
            "fields": fields,
            "labels": labels,
        }))

        parsed = {
            p["field"]: p["value"]
            for p in result.proposals
            if p.get("field") and p.get("value")
        }
        last_error = result.log.get("error", "")
        if not parsed and last_error:
            return ParsedAnswer(
                raw=answer, fields={}, confidence=0.0,
                unclear=["Ошибка парсинга"],
                error=f"LLM не смогла распарсить после {self._llm.MAX_RETRIES} попыток. Причина: {last_error}",
            )

        # Уверенность — сколько полей заполнено
        filled = len([k for k in parsed if parsed.get(k)])
        total = len(fields)
        confidence = round(filled / total, 2) if total > 0 else 0.0

        # Неясные поля
        unclear = []
        for f in fields:
            if f not in parsed or not parsed.get(f):
                unclear.append(labels.get(f, f))

        self._history.append({"topic": topic, "answer": answer, "parsed": parsed})

        return ParsedAnswer(
            raw=answer, fields=parsed,
            confidence=confidence, unclear=unclear,
        )

    def clarify_question(self, unclear_fields: list) -> str:
        """Сформулировать уточняющий вопрос (через InterviewLayer)."""
        q = self.interview.clarify(unclear_fields=unclear_fields)
        return q.text

    def _parse_json_safe(self, text: str) -> dict:
        """Безопасный парсинг JSON из LLM."""
        import json
        text = text.strip()
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            m = re.search(r'\{.*\}', text, re.DOTALL)
            if m:
                try:
                    return json.loads(m.group())
                except json.JSONDecodeError:
                    pass
            return {}

    def history_summary(self) -> list[dict]:
        """История диалога."""
        return list(self._history)