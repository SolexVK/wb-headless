"""VCOS — LLM Transformer v2

Единственный трансформер, который взаимодействует с LLM API.
Все остальные модули вызывают LLM только через этот трансформер.

CP-001 §9 — Reasoning Protocol.
T-003: Single Responsibility — только LLM вызовы.
L-001: LLM Proposes, Kernel Decides (возвращает proposals, не изменяет model)
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

from hermes.domain_packs.llm_client import call_llm
from hermes.transformers.base import Transformer, TransformerContext, TransformResult

logger = logging.getLogger(__name__)


class LLMTransformer(Transformer):
    """Трансформер для всех LLM-вызовов (CP-001 §9).

    L-001: Возвращает Proposal[], не изменяет model.
    """

    name = "llm"
    version = "1.0.0"
    phase_type = "cognitive"

    DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
    DEFAULT_TIMEOUT = 15
    DEFAULT_MAX_TOKENS = 600
    MAX_RETRIES = 3
    RETRY_DELAY = 1

    def __init__(self):
        self._stats = {"calls": 0, "failures": 0, "retries": 0}

    def can_handle(self, phase: str) -> bool:
        return phase in ("inference", "llm", "reasoning")

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Вызвать LLM и вернуть proposals (CP-001 §9 Reasoning Protocol).

        Encyclopedia: Transformer(SemanticGraph) → SemanticGraph

        Args:
            graph: SemanticGraph — контекст для LLM (не мутируется)
            context: TransformerContext — промпт, поля, модель

        Returns:
            TransformResult — graph не меняется, proposals в result
        """
        prompt = context.config.get("prompt", "")
        system = context.config.get("system", "")
        fields = context.config.get("fields")
        labels = context.config.get("labels", {})
        model_name = context.config.get("model", self.DEFAULT_MODEL)

        if not prompt:
            return TransformResult(
                graph=graph,
                log={"error": "No prompt provided"},
            )

        raw = self._call(prompt=prompt, system=system, model=model_name)

        if not raw:
            return TransformResult(
                graph=graph,
                log={"error": "LLM returned empty after retries"},
            )

        if fields:
            parsed = self._parse_json_safe(raw) if raw else {}
            proposals = []
            for field, value in parsed.items():
                proposals.append({
                    "type": "decision",
                    "field": field,
                    "value": value,
                    "label": labels.get(field, field),
                    "source": "llm",
                    "confidence": 0.7,
                })

            # L-001: LLM Proposes, Kernel Decides — proposals уходят вызывающему
            return TransformResult(
                graph=graph,
                proposals=proposals,
                log={
                    "phase": "inference",
                    "raw": raw,
                    "parsed_fields": list(parsed.keys()),
                    "proposals_count": len(proposals),
                },
            )

        return TransformResult(
            graph=graph,
            log={"raw": raw, "text": raw},
        )

    def _call(self, prompt: str, system: str = "",
              model: str = DEFAULT_MODEL) -> Optional[str]:
        last_error = ""
        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                self._stats["calls"] += 1
                resp = call_llm(
                    system or "Ты — ассистент.",
                    prompt,
                    model=model,
                    timeout=self.DEFAULT_TIMEOUT,
                    max_tokens=self.DEFAULT_MAX_TOKENS,
                )
                if resp:
                    return resp
                last_error = "LLM вернула пустой ответ"
            except Exception as e:
                last_error = str(e)
                self._stats["failures"] += 1

            if attempt < self.MAX_RETRIES:
                self._stats["retries"] += 1
                logger.warning("LLM attempt %d/%d failed: %s. Retrying...",
                               attempt, self.MAX_RETRIES, last_error)
                time.sleep(self.RETRY_DELAY * attempt)

        logger.error("LLM failed after %d attempts: %s",
                     self.MAX_RETRIES, last_error)
        return None

    def _parse_json_safe(self, text: str) -> dict:
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

    def stats(self) -> dict:
        return dict(self._stats)