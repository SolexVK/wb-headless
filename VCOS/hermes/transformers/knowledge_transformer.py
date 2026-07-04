"""VCOS — Knowledge Transformer v2

Трансформер для поиска знаний: документы, векторная БД, профили.
Единственный модуль, который взаимодействует с pgvector и документацией.

CP-001 §5 — Knowledge Provider Protocol.
T-003: Single Responsibility — только поиск знаний.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Dict, List, Optional

from hermes.transformers.base import Transformer, TransformerContext, TransformResult
from hermes.transformers.knowledge_protocol import KnowledgeRequest, KnowledgeResult

logger = logging.getLogger(__name__)


class KnowledgeTransformer(Transformer):
    """Трансформер для поиска знаний (CP-001 §5).

    Использование через TransformResult:
        result = kn.transform(model, context)
        result.log["documents"] — найденные документы
        result.log["memory"] — найденные воспоминания
    """

    name = "knowledge"
    version = "1.0.0"
    phase_type = "cognitive"

    def __init__(self):
        self._pg_provider = None

    def can_handle(self, phase: str) -> bool:
        return phase in ("knowledge", "search", "profile")

    def query(self, request: KnowledgeRequest) -> KnowledgeResult:
        """CP-001 §5.1: query(request) → KnowledgeResult.

        Args:
            request: KnowledgeRequest — формальный запрос с доменом и контекстом

        Returns:
            KnowledgeResult — факты, отношения, уверенность, источник
        """
        source = request.free_text[:30] if request.free_text else request.domain
        facts = []

        # Поиск в документации (правила)
        if request.domain == "photography":
            facts.append({"field": "lighting", "value": "soft_diffuse",
                          "domain": "photography", "confidence": 0.8})
            facts.append({"field": "lens", "value": "85mm_f1.4",
                          "domain": "photography", "confidence": 0.7})

        # Поиск в памяти через pgvector
        if request.free_text:
            memory_facts = self._search_memory(request.free_text, request.max_results)
            for mf in memory_facts:
                if isinstance(mf, dict):
                    facts.append(mf)

        return KnowledgeResult(
            facts=facts,
            confidence=0.7 if facts else 0.0,
            source=f"knowledge:{source}",
        )

    def transform(self, graph: 'SemanticGraph', context: TransformerContext) -> TransformResult:
        """Найти знания для текущей фазы проекта (CP-001 §5 Knowledge Provider).

        Encyclopedia: Transformer(SemanticGraph) → SemanticGraph

        Args:
            graph: SemanticGraph — текущее состояние графа
            context: TransformerContext — конфиг с query, source

        Returns:
            TransformResult — graph не меняется (read-only), знания в log
        """
        query = context.config.get("query", "")
        source = context.config.get("source", "memory")
        limit = context.config.get("limit", 10)

        log = {}

        if source == "docs":
            log["documents"] = self._search_docs(query)
        elif source == "profile":
            log["profile"] = self._get_profile()
        else:
            log["memory"] = self._search_memory(query, limit)

        return TransformResult(
            graph=graph,  # KnowledgeTransformer — read-only
            log=log,
        )

    def _search_docs(self, query: str) -> List[dict]:
        docs_dir = os.path.expanduser("~/VCOS/docs")
        results = []
        query_lower = query.lower()
        for root, dirs, files in os.walk(docs_dir):
            for f in files:
                if f.endswith(".md"):
                    path = os.path.join(root, f)
                    try:
                        with open(path, "r", encoding="utf-8", errors="replace") as fh:
                            content = fh.read()
                        if query_lower in content.lower():
                            results.append({
                                "file": os.path.relpath(path, docs_dir),
                                "preview": content[:300],
                            })
                    except Exception:
                        continue
        return results

    def _search_memory(self, query: str, limit: int = 10) -> List[dict]:
        provider = self._get_pg_provider()
        if not provider:
            return self._search_docs(query)
        return provider._search(query, limit=limit)

    def _get_profile(self) -> dict:
        provider = self._get_pg_provider()
        if provider:
            return provider._get_profile()
        return {"facts_count": 0, "recent_facts": [], "recent_sessions": []}

    def _get_pg_provider(self):
        if self._pg_provider is not None:
            return self._pg_provider
        try:
            sys.path.insert(0, os.path.expanduser("~/.hermes/plugins"))
            from pgvectormem import PGVectorProvider
            self._pg_provider = PGVectorProvider()
            if self._pg_provider.is_available():
                self._pg_provider.initialize("knowledge-transformer")
                return self._pg_provider
        except Exception as e:
            logger.warning("pgvector недоступен: %s", e)
        self._pg_provider = False
        return None