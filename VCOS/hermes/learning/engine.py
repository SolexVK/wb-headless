"""VCOS — Learning Engine v1 (CA-001.4.8, CP-001.10)

Continuous Learning (Invariant #17):
Извлекает паттерны из завершённых проектов для улучшения будущих.

Принципы (doc 168):
  - Learning Engine — Cognitive Transformer (Understanding → Understanding)
  - Non-destructive: не меняет существующие проекты
  - Explicit opt-in: паттерны предлагаются, не навязываются
  - Domain isolation: паттерны хранятся по доменам

Связанные спецификации:
  - CA-001.4.8 — `Learn` операция
  - CP-001.10 — Learning Protocol
  - Architecture Invariants — #17 Continuous Learning
"""

from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID, uuid4
from datetime import datetime, timezone


# ═══════════════════════════════════════════
# Data Models — CP-001.10 Pattern Format
# ═══════════════════════════════════════════

@dataclass
class Pattern:
    """Паттерн проектного решения (CP-001.10.2).

    Извлекается из повторяющихся решений в завершённых проектах.
    """
    id: UUID = field(default_factory=uuid4)
    domain: str = ""             # "photography" | "film" | "advertising"
    field_name: str = ""         # "lighting" | "lens" | "composition"
    recommended_value: str = ""  # "golden_hour" | "85mm_f1.4"
    confidence: float = 0.0      # на основе согласованности решений
    evidence_count: int = 0      # сколько проектов подтверждают
    source_projects: list = field(default_factory=list)
    created_at: str = ""
    status: str = "candidate"    # "candidate" | "approved" | "rejected"


@dataclass
class Suggestion:
    """Подсказка для активного проекта на основе паттернов."""
    pattern_id: UUID
    domain: str
    field: str
    suggested_value: str
    confidence: float
    source_text: str  # объяснение для пользователя


# ═══════════════════════════════════════════
# LearningEngine — CA-001.4.8 Learn
# ═══════════════════════════════════════════

class LearningEngine:
    """Движок непрерывного обучения (Invariant #17).

    Basic (MVP):
      - extract_patterns — частотный анализ решений
      - suggest_next — подсказки для активных проектов
      - approve/reject — управление паттернами

    Future (Phase 5+):
      - LLM-assisted semantic pattern extraction
      - Cross-project pattern aggregation
      - Automated pattern testing
    """

    def __init__(self):
        self._patterns: dict[str, Pattern] = {}
        self._threshold = 2  # минимальное число повторений для паттерна

    # ─── Learn (CA-001.4.8) ──────────────────────────────────

    def extract_patterns(self, project_ids: list[str],
                         decisions: dict[str, list[dict]]) -> list[Pattern]:
        """Извлечь паттерны из решений завершённых проектов.

        Learn(project_ids) → Pattern[]

        Args:
            project_ids: ID завершённых проектов
            decisions: {project_id: [{field, value, domain}, ...]}

        Returns:
            Список найденных паттернов (может быть пустым)
        """
        # Учитываем только решения из перечисленных проектов
        allowed = set(project_ids) if project_ids else set(decisions.keys())

        # Группировка решений по {domain, field, value}
        groups: dict[tuple, dict] = {}
        for pid, project_decisions in decisions.items():
            if pid not in allowed:
                continue
            for dec in project_decisions:
                key = (dec.get("domain", "general"),
                       dec.get("field", "unknown"),
                       dec.get("value", ""))
                if key not in groups:
                    groups[key] = {
                        "projects": [],
                        "domain": key[0],
                        "field": key[1],
                        "value": key[2],
                    }
                if pid not in groups[key]["projects"]:
                    groups[key]["projects"].append(pid)

        # Фильтрация: паттерн подтверждён >= threshold УНИКАЛЬНЫМИ проектами
        new_patterns = []
        for key, g in groups.items():
            count = len(g["projects"])
            if count >= self._threshold:
                pattern = Pattern(
                    domain=g["domain"],
                    field_name=g["field"],
                    recommended_value=g["value"],
                    confidence=min(1.0, count / 5),
                    evidence_count=count,
                    source_projects=g["projects"],
                    status="candidate",
                )
                self._patterns[pattern.id.hex[:8]] = pattern
                new_patterns.append(pattern)

        return new_patterns

    # ─── Suggest (CP-001.10) ──────────────────────────────────

    def suggest_next(self, graph_context: Optional[dict] = None) -> list[Suggestion]:
        """Предложить паттерны для активного проекта.

        Анализирует: какие поля проекта уже заполнены,
        какие паттерны из той же области могут подойти.
        """
        if not graph_context:
            return []

        suggestions = []
        project_domain = graph_context.get("domain", "general")
        project_decisions = graph_context.get("decisions", [])

        # Ищем паттерны по той же области
        for pattern in self._patterns.values():
            if pattern.status != "approved":
                continue
            if pattern.domain == project_domain:
                # Проверяем: это поле уже решено в проекте?
                already_decided = any(
                    d.get("field") == pattern.field_name
                    for d in project_decisions
                )
                if not already_decided:
                    suggestions.append(Suggestion(
                        pattern_id=pattern.id,
                        domain=pattern.domain,
                        field=pattern.field_name,
                        suggested_value=pattern.recommended_value,
                        confidence=pattern.confidence,
                        source_text=(
                            f"На основе {pattern.evidence_count} проектов: "
                            f"рекомендуется '{pattern.recommended_value}'"
                        ),
                    ))

        # Сортируем по уверенности
        suggestions.sort(key=lambda s: s.confidence, reverse=True)
        return suggestions

    # ─── Pattern lifecycle (CP-001.10) ────────────────────────

    def approve_pattern(self, pattern_id: str) -> bool:
        """Утвердить паттерн (candidate → approved)."""
        for pid, p in self._patterns.items():
            if pid.startswith(pattern_id):
                p.status = "approved"
                return True
        return False

    def reject_pattern(self, pattern_id: str) -> bool:
        """Отклонить паттерн (candidate → rejected)."""
        for pid, p in self._patterns.items():
            if pid.startswith(pattern_id):
                p.status = "rejected"
                return True
        return False

    # ─── Queries ──────────────────────────────────────────────

    def list_patterns(self, domain: Optional[str] = None,
                      status: Optional[str] = None) -> list[Pattern]:
        """Список паттернов с фильтрацией."""
        results = []
        for p in self._patterns.values():
            if domain and p.domain != domain:
                continue
            if status and p.status != status:
                continue
            results.append(p)
        return results

    def summary(self) -> dict:
        """Сводка обучения."""
        total = len(self._patterns)
        by_status = {}
        by_domain = {}
        for p in self._patterns.values():
            by_status[p.status] = by_status.get(p.status, 0) + 1
            by_domain[p.domain] = by_domain.get(p.domain, 0) + 1
        return {
            "total_patterns": total,
            "by_status": by_status,
            "by_domain": by_domain,
            "threshold": self._threshold,
        }