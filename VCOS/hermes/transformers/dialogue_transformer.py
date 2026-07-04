"""VCOS — Dialogue Transformer v2

Трансформер для диалога с пользователем.
Использует InterviewLayer для структуры вопросов.
Не содержит LLM-логики — только структуру диалога.

CP-001 §8 — Interview Protocol.
T-003 — Single Responsibility: только диалог.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult
from hermes.interview.interview_layer import (
    InterviewLayer, CATEGORIES, CATEGORY_ALIASES
)


class DialogueTransformer(Transformer):
    """Трансформер диалога (CP-001 §8).

    Чистый, без LLM. Использует InterviewLayer для вопросов.
    Для парсинга ответов использует LLMTransformer.
    """

    name = "dialogue"
    version = "1.0.0"
    phase_type = "cognitive"

    def __init__(self):
        self.interview = InterviewLayer()

    def can_handle(self, phase: str) -> bool:
        return phase in ("interview", "dialogue", "category", "product", "model_scene",
                         "reference", "constraints", "direction", "profile")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Сгенерировать вопрос для пользователя на основе текущей фазы.

        Args:
            graph: SemanticGraph — текущее состояние графа
            context: TransformerContext — внешние ресурсы

        Returns:
            TransformResult с новым graph (если был парсинг) или вопросами
        """
        phase = context.config.get("phase", "")
        user_input = context.config.get("user_input", "")

        if phase == "category":
            # Проверка и установка категории
            return self._handle_category(graph, user_input, context)
        elif phase in ("product", "model_scene", "direction", "interview"):
            # Парсинг ответа пользователя (включая interview — блок из PHASE_BLOCK)
            return self._parse_answer(graph, user_input, phase, context)
        else:
            # Генерация вопроса
            question = self._build_question(phase)
            return TransformResult(
                graph=graph,
                log={"phase": phase, "question": question},
            )

    def _handle_category(self, graph: 'SemanticGraph', user_input: str,
                         context: TransformerContext) -> TransformResult:
        """Обработать выбор категории."""
        # Из graph берём registry и проверяем категорию
        cat = user_input.lower().strip()
        valid = ["одежда", "обувь", "косметика", "еда",
                 "декор", "электроника", "уход", "детское", "другое"]

        if cat not in valid:
            return TransformResult(
                graph=graph,
                log={"phase": "category", "error": f"Invalid category: {cat}",
                     "question": f"❌ Выбери из списка: {', '.join(valid[:5])}..."},
            )

        # Создаём новый graph с категорией
        new_graph = graph.with_domain([cat]) if hasattr(graph, "with_domain") else graph
        return TransformResult(
            graph=new_graph,
            log={"phase": "category", "category": cat},
        )

    def _parse_answer(self, graph: 'SemanticGraph', user_input: str,
                      phase: str, context: TransformerContext) -> TransformResult:
        """Распарсить ответ пользователя через DialogueAgent.

        Возвращает TransformResult с proposals = список предложений
        для _apply_proposal (каждое поле → отдельный Proposal).
        """
        if context.reasoning:
            # Используем LLM через reasoning для парсинга
            from hermes.agents.dialogue_agent import DialogueAgent
            agent = DialogueAgent()
            parsed = agent.parse(phase, user_input)
            if len(parsed.fields) == 0:
                error_msg = parsed.error or "не смог распознать"
                return TransformResult(
                    graph=graph,
                    log={"phase": phase, "error": error_msg,
                         "question": f"❌ **Не понял.** {error_msg}."},
                )

            # Конвертируем распарсенные поля в Proposals
            # block — из config (PHASE_BLOCK) или phase (PHASE_MAP)
            block_name = context.config.get("block", phase)
            proposals = []
            for field, value in parsed.fields.items():
                if value and field != "text":
                    proposals.append({
                        "block": block_name,
                        "field": field,
                        "value": str(value),
                        "source": "user",
                        "confidence": parsed.confidence,
                        "rationale": f"Из ответа: {parsed.raw[:50]}",
                    })

            return TransformResult(
                graph=graph,
                proposals=proposals,
                log={
                    "phase": phase,
                    "parsed": parsed.fields,
                    "raw": parsed.raw,
                    "question": f"✅ Понял. Записал: {list(parsed.fields.keys())}",
                },
            )

        # No LLM — fallback: regex-парсинг + сырой текст
        block_name = context.config.get("block", phase)
        proposals = self._fallback_parse(phase, block_name, user_input)
        if not proposals:
            proposals = [{
                "block": block_name,
                "field": "description",
                "value": user_input,
                "source": "user",
                "confidence": 0.5,
            }]

        return TransformResult(
            graph=graph,
            proposals=proposals,
            log={"phase": phase, "message": "No reasoning engine — regex parse",
                 "proposals": len(proposals)},
        )

    def _fallback_parse(self, phase: str, block: str, text: str) -> list:
        """Regex-парсинг ответа без LLM.

        Пробует извлечь поля вида: "поле: значение" или "ключ=значение".
        Fallback: одно поле "description" со всем текстом.
        """
        proposals = []

        # Проверяем формат: "поле: значение, другое поле: значение"
        import re
        kv_pairs = re.findall(r'([а-яa-z_]+)\s*[=:]\s*([^,;.]+)', text.lower())
        if kv_pairs:
            for key, val in kv_pairs:
                proposals.append({
                    "block": block,
                    "field": key.strip(),
                    "value": val.strip(),
                    "source": "user",
                    "confidence": 0.6,
                    "rationale": f"Извлечено из ответа: {key}={val}",
                })
            return proposals

        # Если нет явных key=value — сопоставляем фрагменты по ключевым словам,
        # и только потом позиционно (позиционное угадывание ненадёжно).
        parts = [p.strip() for p in text.split(',') if p.strip()]
        field_names = {
            "product": ["type", "color", "material", "brand"],
            "model_scene": ["model", "environment", "character"],
            "reference": ["reference", "style_reference"],
            "direction": ["composition", "lighting", "color", "style", "mood"],
        }
        keyword_map = {
            "mood": ["настроен", "атмосфер", "эмоци"],
            "lighting": ["свет", "освещ", "контражур", "тен"],
            "style": ["стиль", "стилист"],
            "composition": ["композиц", "ракурс", "план ", "кадр"],
            "color": ["цвет", "палитр", "оттен"],
            "environment": ["улиц", "студи", "фон", "террас", "кафе", "локац",
                            "интерьер", "природ", "пляж", "парк", "дом"],
            "model": ["девушк", "мужчин", "женщин", "модель", "парень",
                      "ребён", "человек", "лет"],
        }
        expected_fields = field_names.get(block, field_names.get(phase, []))

        if parts and expected_fields:
            assigned: dict = {}
            leftover = []
            for part in parts:
                low = part.lower()
                matched = None
                for fname, kws in keyword_map.items():
                    if fname in expected_fields and any(k in low for k in kws):
                        matched = fname
                        break
                if matched:
                    assigned[matched] = (assigned[matched] + ", " + part
                                         if matched in assigned else part)
                else:
                    leftover.append(part)

            # Остатки — позиционно в незанятые поля
            free_fields = [f for f in expected_fields if f not in assigned]
            for i, part in enumerate(leftover):
                if i < len(free_fields):
                    assigned[free_fields[i]] = part

            for fname, value in assigned.items():
                proposals.append({
                    "block": block,
                    "field": fname,
                    "value": value,
                    "source": "user",
                    "confidence": 0.5,
                })

        return proposals

    def _build_question(self, topic: str) -> str:
        """Получить вопрос по теме (через InterviewLayer)."""
        q = self.interview.ask(topic=topic)
        return q.text

    def _build_clarify(self, unclear_fields: list) -> str:
        """Уточняющий вопрос."""
        q = self.interview.clarify(unclear_fields=unclear_fields)
        return q.text

    def get_categories(self) -> dict:
        return dict(CATEGORIES)

    def get_fields_for(self, topic: str) -> List[str]:
        resolved = CATEGORY_ALIASES.get(topic, topic)
        info = CATEGORIES.get(resolved)
        return info["fields"] if info else []

    def get_labels_for(self, topic: str) -> dict:
        resolved = CATEGORY_ALIASES.get(topic, topic)
        info = CATEGORIES.get(resolved)
        return info["field_labels"] if info else {}