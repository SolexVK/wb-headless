"""VCOS — Renderer Protocol Dataclasses (CP-001 §6).

Formal dataclasses for Renderer Protocol:
  - RenderContext
  - RenderResult

R-001: Blueprint In, Artifact Out.
R-002: No Side Effects on Model.
R-003: Deterministic Compilation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class RenderContext:
    """Контекст рендеринга (CP-001 §6.2).

    Attributes:
        target_format: формат артефакта (sdxl-prompt, midjourney-prompt...)
        target_model: целевая модель (sdxl, midjourney-v6...)
        specifications: структурированные спецификации из Blueprint
        constraints: активные ограничения
        options: параметры модели (CFG, steps...)
    """
    target_format: str = "sdxl-prompt"
    target_model: str = "sdxl"
    specifications: List[str] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    options: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RenderResult:
    """Результат рендеринга (CP-001 §6.3).

    Attributes:
        artifact: словарь артефакта (content, format, generator, params)
        format: фактический формат
        duration: время генерации в мс
        log: лог шагов
    """
    artifact: Dict[str, Any] = field(default_factory=dict)
    format: str = ""
    duration: int = 0
    log: Dict[str, Any] = field(default_factory=dict)